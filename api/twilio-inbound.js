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
 *   4. project into HubSpot      — best-effort, for the operator's eyes,
 *                                  and HARD-BOUNDED in both the number of
 *                                  requests and the wall clock
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
import {
  findContactsByPhone, writeSuppressionProperties, isConfigured, HUBSPOT_TIMEOUT_MS,
} from "./_lib/hubspot.mjs";
import { log } from "./_lib/log.mjs";

/* Twilio expects TwiML or an empty 200. An empty <Response/> tells it we
   handled the message and want no auto-reply of our own — Twilio's own
   opt-out confirmation is separate and is sent by Twilio. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/* ---------------------------------------------------------------------
   THE PROJECTION IS BOUNDED, AND ITS DEADLINE RUNS FROM HANDLER ENTRY
   ---------------------------------------------------------------------
   findContactsByPhone() returns up to 100 contacts and each write is a
   separate HubSpot request. Run unbounded — which is what this endpoint
   did until now — that is far more work than the 15 s maxDuration allows,
   and it happens AFTER the ledger append has already committed. So what
   an overrun costs is not compliance: the suppression is durable and
   enforcement resolves by number. It costs THE ANSWER TO TWILIO.

   WHY THIS IS NOT api/operator-action.js's 12 SECONDS. That endpoint has
   a 30 s maxDuration and one human waiting for a page. This one has:

     * a 15 s maxDuration (vercel.json), and
     * Twilio's own ~15 s webhook timeout, whose clock starts BEFORE ours
       — it includes DNS, TLS and a cold start, none of which appear in
       our maxDuration.

   Copying 12 s here would put the worst case at 3 + 12 + 1 = 16 s, past
   the platform limit on its own, before Twilio's clock is even
   considered. The number had to be derived from this endpoint's budget,
   not inherited from the other one.

   AND THE DEADLINE IS ABSOLUTE, NOT PER-PHASE. operator-action starts its
   budget when the projection starts, which is correct there because
   nothing before it is a hard cost. Here a per-phase budget would STACK:
   a 3 s ledger append plus a 6 s projection window is 9 s of I/O however
   each half is measured, and a slow body read would add to it again. So
   the deadline is computed from HANDLER ENTRY. Whatever the earlier
   phases spent, the projection stops at the same wall-clock instant, and
   a slow ledger simply leaves less room for writes — which is reported,
   not hidden.

   WHAT THIS BOUNDS, worst case, against a 15 s maxDuration:

     handler entry -> projection deadline   <= 10 s   (absolute)
       of which: verify and classify        — pure CPU, no I/O
                 ledger append              <=  3 s   (LEDGER_TIMEOUT_MS)
                 search + every write       — whatever is left
     render the empty TwiML                 <   1 s   (no I/O, estimated
                                                       and not measured)
     ------------------------------------------------------------
     total                                  <= 11 s   leaving ~4 s

   That ~4 s is the margin for the cold start and the network legs that
   sit inside Twilio's 15 s and outside our own clock. It is not spare
   capacity to spend.

   AND WHAT IT DOES NOT BOUND, said out loud because the arithmetic above
   would otherwise read as a guarantee about the whole function:
   readFormBody() is bounded in SIZE (MAX_WEBHOOK_BYTES) and NOT IN TIME.
   A request that stalls mid-body leaves it pending until the platform
   kills the function, and no deadline here can shorten that. What this
   bound does guarantee is that such a request costs only itself: the
   projection is measured from handler entry, so a body read that has
   already spent the budget leaves nothing for HubSpot and the projection
   says so, instead of starting a fresh 10 s on top of it. That is not a
   hypothetical branch — it is the only way `budget_exhausted` below is
   reached, and tests/suppression.test.mjs reaches it.

   THE BOUND IS HARD, which means the remaining budget is passed INTO each
   HubSpot request and the socket is ABORTED when it runs out — covering
   the response BODY and not only its headers (api/_lib/hubspot.mjs).
   Checking the clock only between requests bounds when a write may START
   and says nothing about when it ends: a write beginning at 9.9 s would
   run on under HubSpot's own 8 s timeout and finish near 17.9 s. That
   defect was found in this same shape in `4397f00` and must not be
   reintroduced here. Racing a promise would leave the socket open and the
   work running; only the AbortController actually stops it.

   THE SEARCH IS INSIDE THE BUDGET TOO. Outside it, an 8 s search plus a
   write phase is the same stacking arithmetic in a different place. */
export const MAX_PROJECTION_CONTACTS = 25;
export const PROJECTION_DEADLINE_MS = 10000;

/* Below this, a write cannot plausibly complete and starting one only
   guarantees an abort. The contact is reported unreached instead. */
export const MIN_WRITE_MS = 500;

/* And below this there is no point searching at all: the search would be
   aborted mid-flight and reported as a projection failure, which is not
   what happened. An exhausted budget is said out loud instead.

   HOW THIS BRANCH IS ACTUALLY REACHED, since guessing wrong about that is
   how a "defensive" branch rots. NOT through the ledger: that append is
   capped at LEDGER_TIMEOUT_MS (3 s) and a hang is cut there and answers
   503 before this function runs — LEDGER_TIMEOUT_MS + MIN_SEARCH_MS <
   PROJECTION_DEADLINE_MS, which tests/suppression.test.mjs asserts rather
   than trusting this sentence to stay true. It is reached through the
   UNBOUNDED-IN-TIME body read described above: a request that dribbles
   its body for longer than the deadline arrives here with nothing left to
   spend. */
export const MIN_SEARCH_MS = 1000;

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
  /* THE FIRST STATEMENT, deliberately. The projection's deadline is
     measured from here rather than from its own entry, so every earlier
     phase — the body read, the ledger append — spends the SAME budget
     instead of adding to it. See the projection bound above. */
  const startedAt = Date.now();

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

  /* ---- 4. THE PROJECTION, BEST-EFFORT AND BOUNDED ------------------- */
  await projectToHubSpot({ decision, from, occurredAt, shape, startedAt });

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
 *
 * Bounded by MAX_PROJECTION_CONTACTS requests and by an absolute deadline
 * PROJECTION_DEADLINE_MS after handler entry — see the bound above.
 */
async function projectToHubSpot({ decision, from, occurredAt, shape, startedAt }) {
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

  /* ABSOLUTE, from handler entry. A missing or non-finite `startedAt`
     would make every subtraction below NaN, and every `remaining() <`
     comparison false — turning the hard bound silently back into no bound
     at all. It falls back to "now", which is the CONSERVATIVE direction:
     a shorter projection, never an unbounded one. */
  const entry = Number.isFinite(startedAt) ? startedAt : Date.now();
  const deadline = entry + PROJECTION_DEADLINE_MS;
  /* Never longer than the budget has left, never longer than HubSpot's
     own default. `remaining()` is the only source of that number. */
  const remaining = () => deadline - Date.now();
  const requestMs = () => Math.min(HUBSPOT_TIMEOUT_MS, remaining());

  if (remaining() < MIN_SEARCH_MS) {
    /* The earlier phases spent the budget. Saying so is the truth; a
       search started here would be aborted in flight and logged as a
       HubSpot failure, which is a different and wrong story. */
    log("twilio.inbound.projection_skipped", { ...shape, reason: "budget_exhausted" });
    return;
  }

  try {
    const contacts = await findContactsByPhone(from, { timeoutMs: requestMs() });
    if (!contacts.length) {
      /* Nobody in the CRM holds this number. The suppression is recorded
         and effective regardless — enforcement resolves by number, not by
         contact. */
      log("twilio.inbound.projection_no_contacts", shape);
      return;
    }

    let written = 0;
    /* ALREADY-MARKED CONTACTS NEED THEIR OWN BUCKET. An already-suppressed
       contact produces an empty patch, writeSuppressionProperties() answers
       `{ written: false }` without making a request, and the previous
       version of this loop counted it nowhere — so `written + failed` did
       NOT sum to the contacts found and a contact simply vanished from the
       log line. It is not written (nothing changed), not failed (nothing
       went wrong) and not skipped (it WAS reached). It is unchanged. */
    let unchanged = 0;
    let failed = 0;
    let skipped = 0;

    /* THE BUDGET GATES REQUESTS, NOT THE SCAN. Deciding what a contact
       needs is pure and free — neither property builder makes a call — so
       an already-marked contact can always be accounted for correctly,
       however little budget is left. Breaking out of the loop on an
       exhausted budget would report "not reached" for contacts that needed
       nothing and would have cost nothing, which is a worse answer than
       the truth and no cheaper. */
    let attempted = 0;
    for (const contact of contacts) {
      let props;
      try {
        props = decision.kind === "reoptin"
          ? toHubSpotReoptinProperties({
            channel: REOPTIN_CHANNEL[decision.scope] || "sms", at: occurredAt,
          })
          : toHubSpotSuppressionProperties({
            scope: decision.scope,
            trigger: decision.trigger || SUPPRESSION_TRIGGER.KEYWORD,
            at: occurredAt,
            current: contact.consent,
          });
      } catch {
        /* The patch could not even be built for this contact. */
        failed += 1;
        continue;
      }

      /* An empty patch is not a request. This contact is already marked:
         nothing to do, nothing to wait for, and it is `unchanged` whether
         or not any budget remains. */
      if (!props || !Object.keys(props).length) {
        unchanged += 1;
        continue;
      }

      if (attempted >= MAX_PROJECTION_CONTACTS || remaining() < MIN_WRITE_MS) {
        /* Counted, never silently dropped. Nobody is watching this log
           line live, which is exactly why it has to be true later. */
        skipped += 1;
        continue;
      }

      attempted += 1;
      try {
        /* The remaining budget goes INTO the request, so an overrun aborts
           the socket instead of outliving the check that let it start —
           and it covers the response body, not only the headers. */
        const result = await writeSuppressionProperties(contact.id, props,
          { timeoutMs: requestMs() });
        if (result.written) {
          written += 1;
          log("twilio.inbound.projection_written", {
            ...shape, contact_id: contact.id, ...suppressionWriteLogShape(props),
          });
        } else {
          /* A non-empty patch that wrote nothing. Not expected, and not
             worth guessing about: nothing changed, so it is unchanged. */
          unchanged += 1;
        }
      } catch {
        /* THE RULE, and it is about cause rather than symptom: if the
           budget is gone the write was stopped BY US, so it is reported as
           unreached — true in the way that matters, which is that trying
           again may work. Anything else is HubSpot declining, which is
           `failed`. One contact failing never stops the rest. */
        if (remaining() < MIN_WRITE_MS) skipped += 1;
        else failed += 1;
      }
    }

    /* THE INVARIANT:
         written + unchanged + failed + skipped === contacts.length
       Every contact found lands in exactly one bucket, and no bucket is a
       synonym for another — an already-marked contact must never be
       described as newly written, as failed, or as unreached. */
    log("twilio.inbound.projection_done", {
      ...shape, contacts: contacts.length, written, unchanged, failed, skipped,
    });
  } catch (err) {
    /* Deliberately swallowed, deliberately loud. `log()` not `logError()`:
       a HubSpot error message can carry a contact's own details. */
    log("twilio.inbound.projection_failed", {
      ...shape, error: String(err?.message || "").slice(0, 60).replace(/[^A-Za-z0-9_ ]/g, ""),
    });
  }
}
