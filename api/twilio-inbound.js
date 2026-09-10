/* POST /api/twilio-inbound — inbound SMS from Twilio.
 *
 * The only job of this endpoint is to record that someone told us to stop.
 * It sends nothing, replies with nothing, and grants nothing.
 *
 * SMS ONLY. There is no voice ingress: the classifier and the ledger both
 * handle `ai_voice` and `voice_dnc`, and a spoken "do not call me again"
 * can be recorded — but nothing receives a Retell webhook, so no spoken
 * opt-out can reach any of it. Gate 7 is closed for SMS and open for voice.
 *
 * Gate 7 design: docs/updates/2026-09-10-stop-dnc-suppression-decision.md
 *
 * ---------------------------------------------------------------------
 * THE ORDER IS THE DESIGN
 * ---------------------------------------------------------------------
 *   1. verify the signature      — before ANY interpretation of the body
 *   2. classify                  — Twilio's OptOutType if present, else ours
 *   3. append to the ledger      — the durable record, and the enforcement
 *                                  source of truth
 *   4. project into HubSpot      — best-effort, for the operator's eyes
 *
 * Step 3 before step 4 is load-bearing. Enforcement resolves suppression by
 * PHONE NUMBER against the ledger, so once step 3 succeeds the suppression
 * is already effective and a step 4 failure costs visibility, not
 * compliance. That is the only reason this endpoint may answer 200 when
 * HubSpot fails — and it is why it must NEVER answer 200 when the ledger
 * fails.
 *
 * ---------------------------------------------------------------------
 * RESPONSE POLICY
 * ---------------------------------------------------------------------
 *   signature invalid                     403, nothing written
 *   nothing classified, operator emailed  200, no ledger event
 *   nothing classified, email failed      503 (fail closed — NEVER a
 *                                         silent 200; an opt-out nobody
 *                                         saw is the failure this path
 *                                         exists to prevent)
 *   ledger append failed                  5xx (fail closed; see retry note)
 *   ledger appended, HubSpot failed       200, logged loudly
 *   everything succeeded                  200
 *
 * A redelivery, IF ONE ARRIVES, is safe by construction: the dedupe key is
 * derived from Twilio's own MessageSid, and the replay no-op was measured
 * against the live database on 10 September 2026 rather than assumed.
 *
 * It is not assumed that one WILL arrive. Twilio does not redeliver a
 * failed incoming-message webhook by default; retry must be configured
 * explicitly, and that configuration is a live-activation prerequisite
 * rather than something this code can rely on.
 *
 * ---------------------------------------------------------------------
 * WHAT NEVER REACHES A LOG
 * ---------------------------------------------------------------------
 * The message body, the signature, the auth token, the consumer's phone
 * number. Logs carry the classification, the rule id, the channel and
 * Twilio's MessageSid — enough to trace a decision, never enough to read
 * someone's message.
 */

import {
  verifyTwilioSignature, readFormBody, optOutType, OPT_OUT_TYPE,
  twilioConfigured, TWILIO_NOT_CONFIGURED,
} from "./_lib/twilio.mjs";
import { classifyInbound, classificationLogShape } from "./_lib/optout.mjs";
import {
  buildSuppressionEvent, appendSuppressionEvents, ledgerLogShape, capEvidence,
  consentLedgerConfigured, CHANNEL, EVENT_TYPE, SOURCE_TWILIO,
} from "./_lib/consent-ledger.mjs";
import {
  buildInboundNotification, sendInboundNotification, classifyMailError,
  isMailConfigured,
} from "./_lib/mail.mjs";
import {
  sealOperatorToken, operatorActionUrl, operatorActionConfigured, tokenLogShape,
  OperatorTokenError,
} from "./_lib/operator-token.mjs";
import { SUPPRESSION_REASON } from "./_lib/consent.mjs";
import { SUPPRESSION_SCOPE } from "./_lib/permission.mjs";
import {
  consentStateEnabled, toHubSpotSuppressionProperties, toHubSpotReoptinProperties,
  suppressionWriteLogShape, SUPPRESSION_TRIGGER,
} from "./_lib/hubspot-consent-state.mjs";
import { findContactsByPhone, writeSuppressionProperties, isConfigured } from "./_lib/hubspot.mjs";
import { log } from "./_lib/log.mjs";

/* Twilio expects TwiML or an empty 200. An empty <Response/> tells it we
   handled the message and want no auto-reply of our own — Twilio's own
   opt-out confirmation is separate and is sent by Twilio. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function reply(res, status, body = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", body ? "text/xml; charset=utf-8" : "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

/** Twilio's classification when it gave one, otherwise our own. */
function classify(params) {
  const twilioType = optOutType(params);

  if (twilioType === OPT_OUT_TYPE.HELP)
    return { source: "twilio", kind: "help", rule: "opt_out_type_help" };

  if (twilioType === OPT_OUT_TYPE.STOP) {
    return {
      source: "twilio",
      kind: "suppress",
      scope: SUPPRESSION_SCOPE.SMS,
      channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.SUPPRESSED,
      reasonCode: SUPPRESSION_REASON.STOP_KEYWORD,
      trigger: SUPPRESSION_TRIGGER.KEYWORD,
      rule: "opt_out_type_stop",
    };
  }

  if (twilioType === OPT_OUT_TYPE.START) {
    /* Twilio has lifted its own block. Ours is not cleared: a START says
       the handset wants messages, not who is holding it, and it carries no
       disclosure for anyone to have agreed to. Recorded, never granted. */
    return {
      source: "twilio",
      kind: "reoptin",
      scope: SUPPRESSION_SCOPE.SMS,
      channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.REOPTIN_REQUESTED,
      reasonCode: null,
      rule: "opt_out_type_start",
    };
  }

  /* No OptOutType: Advanced Opt-Out is not enabled on the Messaging
     Service, which is the expected state while Twilio configuration is
     frozen. Our own deterministic layer answers instead. */
  const own = classifyInbound(params.Body);
  if (!own) return null;
  return {
    source: "local",
    ...own,
    trigger: own.rule?.startsWith("keyword_")
      ? SUPPRESSION_TRIGGER.KEYWORD
      : SUPPRESSION_TRIGGER.NATURAL_LANGUAGE,
  };
}

/** scope -> the channel recorded on a re-opt-in request. */
const REOPTIN_CHANNEL = { [SUPPRESSION_SCOPE.SMS]: "sms", [SUPPRESSION_SCOPE.VOICE]: "ai_voice" };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405);
  }

  if (!twilioConfigured()) {
    /* No token means nothing can be verified, and an unverifiable request
       is never processed. 503 rather than 403: the fault is ours. */
    log("twilio.inbound.not_configured", { error: TWILIO_NOT_CONFIGURED });
    return reply(res, 503);
  }

  let params;
  try {
    params = await readFormBody(req);
  } catch (err) {
    log("twilio.inbound.body_rejected", { reason: err?.message === "PAYLOAD_TOO_LARGE" ? "too_large" : "unreadable" });
    return reply(res, 400);
  }

  /* ---- 1. AUTHENTICATE, BEFORE INTERPRETING ANYTHING ---------------- */
  const verdict = verifyTwilioSignature(req, params);
  if (!verdict.ok) {
    /* The reason is a stable token and carries no value from the request. */
    log("twilio.inbound.rejected", { reason: verdict.reason });
    return reply(res, 403);
  }

  const messageSid = String(params.MessageSid || params.SmsMessageSid || "").trim();
  const from = String(params.From || "").trim();
  /* SERVER RECEIPT TIME, and it is worth being exact about that. The
     ordinary incoming-SMS webhook carries no message timestamp — there is
     no `DateCreated` on this payload — so `occurred_at` is when THIS
     function received the request, not when Twilio created the message.
     The two are normally milliseconds apart and can diverge under retry or
     queueing. `MessageSid` in `source_event_id` remains the correlation
     key to Twilio's own record, which holds the authoritative timestamp. */
  const occurredAt = new Date().toISOString();

  if (!messageSid || !from) {
    /* Without a MessageSid there is no idempotency key, and without a From
       there is no number to suppress. Neither is recoverable by retrying. */
    log("twilio.inbound.incomplete", { has_sid: Boolean(messageSid), has_from: Boolean(from) });
    return reply(res, 400);
  }

  /* ---- 2. CLASSIFY -------------------------------------------------- */
  const decision = classify(params);
  const shape = { message_sid: messageSid, ...classificationLogShape(decision) };

  if (!decision) {
    /* Not an opt-out — OR an opt-out worded in a way ten deterministic
       patterns do not match and Twilio does not block either, since
       Twilio enforces only its own keyword list. AT ARRIVAL THE SYSTEM
       CANNOT TELL WHICH, so a human is the classifier of last resort and
       the message is emailed to her.

       STILL NO LEDGER EVENT AND NO evidence_text. This table is a
       compliance record, not a message archive, and it cannot delete what
       it is given. Only the operator, having read the message and
       classified it herself through api/operator-action.js, writes a row.
       An ordinary message she reads and closes writes nothing, ever.

       See docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md §4. */
    return surfaceToOperator({ params, from, messageSid, occurredAt, shape, res });
  }

  if (decision.kind === "help") {
    /* Informational. Not a consent decision, so nothing is recorded. */
    log("twilio.inbound.help", shape);
    return reply(res, 200, EMPTY_TWIML);
  }

  /* ---- 3. THE DURABLE RECORD, FIRST --------------------------------- */
  if (!consentLedgerConfigured()) {
    log("twilio.inbound.ledger_absent", shape);
    return reply(res, 503);
  }

  const isSuppression = decision.kind === "suppress";
  let event;
  try {
    event = buildSuppressionEvent({
      occurredAt,
      channel: decision.channel,
      eventType: decision.eventType,
      phone: from,
      source: SOURCE_TWILIO,
      sourceEventId: messageSid,
      reasonCode: decision.reasonCode,
      /* THE CONSUMER'S EXACT WORDS, and only here. The message IS the
         evidence of the opt-out, which is why it is stored — an argument
         that does not extend to a re-opt-in request or to an ordinary
         question. */
      evidenceText: isSuppression ? params.Body : null,
      metadata: {
        MessageSid: messageSid,
        AccountSid: String(params.AccountSid || ""),
        MessagingServiceSid: String(params.MessagingServiceSid || ""),
        OptOutType: optOutType(params) || null,
        classified_by: decision.source,
        rule: decision.rule,
      },
    });
  } catch (buildErr) {
    /* A number that will not normalise cannot be recorded against, and no
       retry changes that. Fail loudly rather than writing a row that does
       not say which line it concerns. */
    log("twilio.inbound.unrecordable", { ...shape, ...ledgerLogShape(buildErr) });
    return reply(res, 400);
  }

  try {
    await appendSuppressionEvents([event]);
    log("twilio.inbound.ledger_appended", shape);
  } catch (ledgerErr) {
    /* THE EVIDENCE IS NOT DURABLE, so this must not answer 200.
       5xx is the fail-closed answer, NOT a retry mechanism: a 5xx on an
       incoming-message webhook does not by itself make Twilio redeliver
       under default behaviour. Retry has to be configured explicitly, and
       doing so is a Messaging Service change — frozen while the TCR hold
       on error 30753 is open, and listed as a live-activation prerequisite
       in docs/updates/2026-09-10-stop-dnc-suppression.md.
       IF a redelivery does arrive it is safe, because the dedupe key is
       Twilio's own MessageSid. That is idempotency, not a guarantee that a
       retry happens. */
    log("twilio.inbound.ledger_failed", { ...shape, ...ledgerLogShape(ledgerErr) });
    return reply(res, 503);
  }

  /* ---- 4. THE PROJECTION, BEST-EFFORT ------------------------------- */
  await projectToHubSpot({ decision, from, occurredAt, shape });

  return reply(res, 200, EMPTY_TWIML);
}

/* ---------------------------------------------------------------------
   SURFACING AN UNCLASSIFIED MESSAGE — AND NEVER A SILENT 200
   ---------------------------------------------------------------------
   Until this existed the branch above answered 200 and wrote one log
   line, and the event was named `unclassified_not_surfaced` to say out
   loud that a log line is not an operator workflow. Nobody reads function
   logs hunting for a missed opt-out.

   Now the message is emailed to the operator with a sealed link that lets
   her record an opt-out (api/operator-action.js), and a failure to send
   it answers 503. THAT IS THE POINT: a failure to surface must be loud.
   A 503 does not by itself make Twilio redeliver — retry is configured on
   the Messaging Service and is a live-activation prerequisite — but a
   loud failure reaches Twilio's Debugger, and a silent 200 reaches
   nobody.

   NOTHING DURABLE OF OURS IS WRITTEN HERE: no ledger row, no HubSpot
   call, no store. Its failure domain is disjoint from Neon's and
   HubSpot's, which is why a ledger outage cannot suppress operator
   visibility.
   --------------------------------------------------------------------- */
async function surfaceToOperator({ params, from, messageSid, occurredAt, shape, res }) {
  if (!isMailConfigured() || !operatorActionConfigured()) {
    /* The existing event name, now meaning SURFACING WAS IMPOSSIBLE
       rather than surfacing was not attempted. 503, never 200. */
    log("twilio.inbound.unclassified_not_surfaced", {
      ...shape,
      mail_configured: isMailConfigured(),
      action_configured: operatorActionConfigured(),
    });
    return reply(res, 503);
  }

  /* The consumer's words are capped BEFORE they are sealed, by the
     ledger's own rule, so the words the operator reads in the email are
     byte-identical to the words that would be written as evidence. */
  const cappedBody = capEvidence(params.Body);

  let actionUrl;
  try {
    actionUrl = operatorActionUrl(sealOperatorToken({
      sid: messageSid, phone: from, body: cappedBody,
    }));
  } catch (sealErr) {
    /* An email without a working action link is half a workflow, so this
       is a surfacing failure and not a degraded success. */
    log("twilio.inbound.unclassified_notify_failed", {
      ...shape, stage: "seal",
      ...(sealErr instanceof OperatorTokenError ? tokenLogShape(sealErr) : { token_error: "unknown" }),
    });
    return reply(res, 503);
  }

  const started = Date.now();
  let result;
  try {
    result = await sendInboundNotification(buildInboundNotification({
      from, body: cappedBody, messageSid, receivedAt: occurredAt, actionUrl,
    }));
  } catch (mailErr) {
    /* classifyMailError(), never logError(): a nodemailer error carries
       the recipient, the envelope and the raw server response. */
    log("twilio.inbound.unclassified_notify_failed", {
      ...shape, stage: "send", mail_error: classifyMailError(mailErr),
      ms: Date.now() - started,
    });
    return reply(res, 503);
  }

  /* NOT SENT IS NOT SENT, even when it did not throw. sendInboundNotification()
     resolves `{ sent: false, reason }` for anything it declines to attempt —
     today only "not_configured", which the guard above already caught, so this
     branch is unreachable RIGHT NOW. It exists because 200-on-a-falsy-result is
     precisely the silent-200 this whole path was built to delete, and the day
     someone adds a second decline reason to that function (the acknowledgement
     sender already has "no_recipient") the endpoint would start answering 200
     for a notification nobody received. Read the answer rather than assuming it. */
  if (!result || result.sent !== true) {
    log("twilio.inbound.unclassified_not_surfaced", {
      ...shape, reason: String(result?.reason || "not_sent"),
    });
    return reply(res, 503);
  }

  log("twilio.inbound.unclassified_notified", { ...shape, ms: Date.now() - started });
  return reply(res, 200, EMPTY_TWIML);
}

/**
 * Flag every contact holding this number. Never throws: by the time this
 * runs the suppression is already durable and already enforced, so a
 * HubSpot outage must not turn into a Twilio retry loop.
 */
async function projectToHubSpot({ decision, from, occurredAt, shape }) {
  if (!consentStateEnabled()) {
    /* With the consent feature off, no `cst_*` property is read or written
       anywhere — that is what makes "off" mean production-equivalent. The
       ledger record above still stands. */
    log("twilio.inbound.projection_skipped", { ...shape, reason: "consent_state_disabled" });
    return;
  }
  if (!isConfigured()) {
    log("twilio.inbound.projection_skipped", { ...shape, reason: "hubspot_not_configured" });
    return;
  }

  try {
    const contacts = await findContactsByPhone(from);
    if (!contacts.length) {
      /* Nobody in the CRM holds this number. The suppression is recorded
         and effective regardless — enforcement resolves by number, not by
         contact. */
      log("twilio.inbound.projection_no_contacts", shape);
      return;
    }

    let written = 0;
    let failed = 0;
    for (const contact of contacts) {
      try {
        const props = decision.kind === "reoptin"
          ? toHubSpotReoptinProperties({
            channel: REOPTIN_CHANNEL[decision.scope] || "sms", at: occurredAt,
          })
          : toHubSpotSuppressionProperties({
            scope: decision.scope,
            trigger: decision.trigger || SUPPRESSION_TRIGGER.KEYWORD,
            at: occurredAt,
            current: contact.consent,
          });
        const result = await writeSuppressionProperties(contact.id, props);
        if (result.written) {
          written += 1;
          log("twilio.inbound.projection_written", {
            ...shape, contact_id: contact.id, ...suppressionWriteLogShape(props),
          });
        }
      } catch {
        /* One contact failing does not stop the rest: partial visibility
           beats none, and none of it affects whether a send is refused. */
        failed += 1;
      }
    }
    log("twilio.inbound.projection_done", {
      ...shape, contacts: contacts.length, written, failed,
    });
  } catch (err) {
    /* Deliberately swallowed, deliberately loud. `log()` not `logError()`:
       a HubSpot error message can carry a contact's own details. */
    log("twilio.inbound.projection_failed", {
      ...shape, error: String(err?.message || "").slice(0, 60).replace(/[^A-Za-z0-9_ ]/g, ""),
    });
  }
}
