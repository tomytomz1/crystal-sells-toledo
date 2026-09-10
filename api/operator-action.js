/* GET / POST /api/operator-action — the operator records an opt-out.
 *
 * Crystal reads "quit hassling me" in the notification email
 * (api/_lib/mail.mjs) and follows the link here. This endpoint is the only
 * way a human can enter a suppression, and it exists so that entering one
 * NEVER requires a privileged database credential: it writes through the
 * same INSERT-only CONSENT_LEDGER_URL the webhook uses, and holds nothing
 * more.
 *
 * Design: docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md §6
 *
 * ---------------------------------------------------------------------
 * GET CONFIRMS. POST WRITES. THAT SPLIT IS THE WHOLE SAFETY MODEL.
 * ---------------------------------------------------------------------
 * Outlook Safe Links, mail-gateway antivirus, Gmail's prefetch and iOS
 * link previews all issue UNATTENDED GETs against links in email, often
 * within seconds of delivery. A design where the link IS the action would
 * suppress numbers by itself, from a scanner, with no human involved —
 * and a suppression cannot be undone.
 *
 * So the GET reads NO DATABASE STATE and writes nothing. It decrypts its
 * own input — the sealed token — and renders a page. No request state
 * changes on a GET, ever.
 *
 * The POST requires three things a scanner cannot supply:
 *   1. the token, in the BODY, never the query string
 *   2. an explicitly chosen scope, with NO DEFAULT — "stop texting me"
 *      and "stop contacting me" are different suppressions, and only the
 *      human reading the message can choose between them
 *   3. an exact confirmation literal the page emits
 *
 * ---------------------------------------------------------------------
 * THE ORDER IS THE DESIGN, exactly as in api/twilio-inbound.js
 * ---------------------------------------------------------------------
 *   1. unseal and validate the token   — nothing is trusted before this
 *   2. append to the ledger            — the durable record, and the
 *                                        enforcement source of truth
 *   3. project into HubSpot            — best-effort, for the operator's
 *                                        eyes only
 *
 * Enforcement resolves suppression BY PHONE NUMBER against the ledger, so
 * once step 2 succeeds the suppression is already effective and a step 3
 * failure costs visibility, not compliance.
 *
 * ---------------------------------------------------------------------
 * WHAT THIS ENDPOINT CANNOT DO
 * ---------------------------------------------------------------------
 * It cannot clear a suppression — `revoked` is the only event type
 * reachable from it, and the credential holds INSERT and nothing else, so
 * a fully compromised endpoint still cannot UPDATE, DELETE, SELECT or
 * un-suppress. It cannot send a message, read a lead, or enumerate the
 * ledger. It is not an admin surface and must not grow into one: it is
 * scoped to ONE MessageSid, carried in one sealed token, that expires.
 *
 * ---------------------------------------------------------------------
 * WHAT NEVER REACHES A LOG
 * ---------------------------------------------------------------------
 * The consumer's number, the consumer's words, the token, the operator's
 * note. Logs carry the MessageSid, the channel, the outcome and a refusal
 * class — enough to trace a decision, never enough to read someone's
 * message or learn their number.
 */

import {
  buildSuppressionEvent, appendSuppressionEvents, ledgerLogShape, capEvidence,
  consentLedgerConfigured, CHANNEL, EVENT_TYPE, SOURCE_OPERATOR,
} from "./_lib/consent-ledger.mjs";
import {
  unsealOperatorToken, operatorActionConfigured, matchesLiteral, tokenLogShape,
  OperatorTokenError, TOKEN_EXPIRED, ACTION_PATH,
} from "./_lib/operator-token.mjs";
import { SUPPRESSION_REASON } from "./_lib/consent.mjs";
import { SUPPRESSION_SCOPE } from "./_lib/permission.mjs";
import {
  consentStateEnabled, toHubSpotSuppressionProperties,
  suppressionWriteLogShape, SUPPRESSION_TRIGGER,
} from "./_lib/hubspot-consent-state.mjs";
import { findContactsByPhone, writeSuppressionProperties, isConfigured } from "./_lib/hubspot.mjs";
import { readFormBody, parseFormParams } from "./_lib/twilio.mjs";
import { escapeHtml } from "./_lib/mail.mjs";
import { log } from "./_lib/log.mjs";

/* The literal the confirmation page emits and the POST demands. It is not
   a secret and is not pretending to be one — it is the third thing an
   unattended scanner does not send. */
export const CONFIRM_LITERAL = "RECORD_OPT_OUT";

/* The three scopes, with NO DEFAULT anywhere in this file. A default here
   would be the endpoint making the judgement the human is here to make. */
const SCOPES = Object.freeze({
  sms: {
    channel: CHANNEL.SMS,
    hubspot: SUPPRESSION_SCOPE.SMS,
    label: "Text messages only",
    detail: "Stop sending SMS. Automated calls are unaffected.",
  },
  ai_voice: {
    channel: CHANNEL.AI_VOICE,
    hubspot: SUPPRESSION_SCOPE.VOICE,
    label: "Automated calls only",
    detail: "Stop placing automated voice calls. Texts are unaffected.",
  },
  all: {
    channel: CHANNEL.ALL,
    hubspot: SUPPRESSION_SCOPE.GLOBAL,
    label: "Everything",
    detail: "Stop all automated contact — texts and automated calls alike.",
  },
});

/* The operator's own note is bounded. It is not evidence and never
   becomes evidence; it goes in `metadata` and nowhere else.

   OVERLENGTH IS REFUSED, NOT TRUNCATED. CLAUDE.md rule 11: "Reject
   overlength input; never silently truncate user data." A slice() here
   would have written a note that stops mid-sentence into an append-only
   table this application cannot correct — and told the operator it had
   recorded what she typed. Counted in UTF-16 code units, which is what
   the textarea's `maxlength` counts, so the browser hint and the server
   rule agree rather than disagreeing on an emoji. */
const MAX_NOTE_CHARS = 280;

/* ---------------------------------------------------------------------
   THE RESPONSE
   ---------------------------------------------------------------------
   Every header here is load-bearing:
   * `no-store`      — the page carries the consumer's words and a live
                       capability; a shared cache must not hold either.
   * `no-referrer`   — the token is IN THE URL on a GET, so any outbound
                       request that carried a referrer would hand it out.
                       The site-wide policy in vercel.json is
                       strict-origin-when-cross-origin; this page needs
                       the stricter one and sets it itself.
   * `noindex`       — a link in an email is not a page for a crawler.
   * CSP             — no third-party resource loads here, at all. The
                       page's whole style sheet is inline and there is no
                       script.
   --------------------------------------------------------------------- */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
            "base-uri 'none'; frame-ancestors 'none'";

function page(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
  res.end(html);
}

const STYLE = `<style>
  body { font: 16px/1.55 -apple-system, "Segoe UI", Verdana, Arial, sans-serif;
         color: #111; background: #fff; margin: 0; padding: 24px; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 1rem; }
  .meta { color: #444; font-size: 0.9rem; }
  blockquote { margin: 1rem 0; padding: 0.75rem 1rem; border-left: 3px solid #ccc;
               background: #f6f6f6; white-space: pre-wrap; word-break: break-word; }
  fieldset { border: 1px solid #ccc; border-radius: 6px; margin: 1.5rem 0; padding: 1rem; }
  legend { font-weight: 700; padding: 0 0.4rem; }
  label { display: block; margin: 0.6rem 0; }
  .detail { color: #444; font-size: 0.9rem; margin: 0 0 0 1.6rem; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.5rem; }
  button { font: inherit; font-weight: 700; padding: 0.7rem 1.2rem; border: 0;
           border-radius: 6px; background: #b00020; color: #fff; cursor: pointer; }
  .warn { border: 1px solid #b00020; border-radius: 6px; padding: 0.75rem 1rem; }
  .ok { border: 1px solid #1b7a3d; border-radius: 6px; padding: 0.75rem 1rem; }
</style>`;

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(title)}</title>${STYLE}</head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body></html>`;
}

function notice(res, status, title, body) {
  return page(res, status, shell(title, `<div class="warn"><p>${body}</p></div>`));
}

/* ---------------------------------------------------------------------
   THE CONFIRMATION PAGE
   ---------------------------------------------------------------------
   It shows the consumer's words because the operator cannot judge a
   message she cannot see — which is the same disclosure as the email the
   token arrived in, and no wider.
   --------------------------------------------------------------------- */
function confirmationPage(payload, token) {
  const choices = Object.entries(SCOPES).map(([value, s]) => `
        <label><input type="radio" name="scope" value="${escapeHtml(value)}" required> ${escapeHtml(s.label)}</label>
        <p class="detail">${escapeHtml(s.detail)}</p>`).join("");

  return shell("Record an opt-out", `
    <p>This message was not recognised as an opt-out automatically. If the person
       is asking not to be contacted, record it below.</p>

    <p class="meta">From ${escapeHtml(payload.phone)} &middot;
       MessageSid ${escapeHtml(payload.sid)}</p>

    <blockquote>${escapeHtml(payload.body)}</blockquote>

    <div class="warn">
      <p><strong>Nothing has been recorded yet.</strong> Nothing is recorded until you
         choose a scope and press the button. <strong>A recorded opt-out cannot be
         undone here</strong> — there is deliberately no way to reverse one from this page.</p>
      <p>If this is an ordinary message, close this tab. Nothing is recorded, and
         nothing about this page is stored.</p>
    </div>

    <form method="POST" action="${escapeHtml(ACTION_PATH)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <input type="hidden" name="confirm" value="${escapeHtml(CONFIRM_LITERAL)}">

      <fieldset>
        <legend>What should stop?</legend>
        <p class="meta">Choose one. There is no default.</p>
        ${choices}
      </fieldset>

      <fieldset>
        <legend>Note (optional)</legend>
        <p class="meta">For your own record. It is stored alongside the entry and is
           never mixed into the consumer's own words.</p>
        <textarea name="note" rows="3" maxlength="${MAX_NOTE_CHARS}"></textarea>
      </fieldset>

      <button type="submit">Record this opt-out</button>
    </form>`);
}

/* ---------------------------------------------------------------------
   HANDLER
   --------------------------------------------------------------------- */
export default async function handler(req, res) {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return notice(res, 405, "Not allowed", "This link accepts GET and POST only.");
  }

  if (!operatorActionConfigured()) {
    /* No key means no token can be opened, and an unopenable token is
       never guessed at. 503 rather than 403: the fault is ours, and with
       the secret absent the endpoint is inert by design. */
    log("operator.action.not_configured", { method });
    return notice(res, 503, "Not available",
      "This action is not configured on the server, so nothing can be recorded here. " +
      "Nothing has been changed.");
  }

  return method === "GET" ? handleGet(req, res) : handlePost(req, res);
}

/* ---------------------------------------------------------------------
   GET — reads no database state, writes nothing, records nothing
   ---------------------------------------------------------------------
   There is no ledger call, no HubSpot call and no store of any kind below
   this line. A scanner reaching it changes nothing, which is the entire
   reason the split exists.
   --------------------------------------------------------------------- */
async function handleGet(req, res) {
  const token = queryParam(req, "t");

  let payload;
  try {
    payload = unsealOperatorToken(token);
  } catch (err) {
    return refuseToken(res, err, "get");
  }

  /* A scanner's GET and a human's GET are indistinguishable and are
     treated identically: both get a page and neither changes anything. */
  log("operator.action.confirmation_rendered", { message_sid: payload.sid });
  return page(res, 200, confirmationPage(payload, token));
}

/* ---------------------------------------------------------------------
   POST — the only writer
   --------------------------------------------------------------------- */
async function handlePost(req, res) {
  /* THE TOKEN MUST NOT BE IN THE QUERY STRING on a write. A POST whose
     URL carries the token would put a live capability into Vercel's
     request log and into any proxy along the way — the exact leak the
     seal exists to prevent. Refused rather than ignored: silently reading
     the body instead would let the leak keep happening unnoticed. */
  if (queryParam(req, "t")) {
    log("operator.action.refused", { reason: "token_in_query" });
    return notice(res, 400, "Not recorded",
      "This request carried its token in the address bar. Nothing was recorded. " +
      "Open the link from the email again and use the button on the page.");
  }

  let params;
  try {
    params = await readFormBody(req);
  } catch (err) {
    log("operator.action.refused", {
      reason: err?.message === "PAYLOAD_TOO_LARGE" ? "too_large" : "unreadable",
    });
    return notice(res, 400, "Not recorded",
      "That submission could not be read. Nothing was recorded.");
  }

  /* Every refusal below writes nothing, and each is checked BEFORE the
     ledger is touched at all. */
  if (!matchesLiteral(params.confirm, CONFIRM_LITERAL)) {
    log("operator.action.refused", { reason: "no_confirmation" });
    return notice(res, 400, "Not recorded",
      "That submission did not carry the page's confirmation. Nothing was recorded.");
  }

  const scopeKey = String(params.scope || "").trim();
  const scope = Object.prototype.hasOwnProperty.call(SCOPES, scopeKey) ? SCOPES[scopeKey] : null;
  if (!scope) {
    /* NO DEFAULT, deliberately. Guessing "sms" here would suppress less
       than the consumer asked for; guessing "all" would suppress more. */
    log("operator.action.refused", { reason: scopeKey ? "scope_unknown" : "scope_missing" });
    return notice(res, 400, "Not recorded",
      "No choice was made about what should stop, so nothing was recorded. " +
      "Go back and choose one.");
  }

  let payload;
  try {
    payload = unsealOperatorToken(params.t);
  } catch (err) {
    return refuseToken(res, err, "post");
  }

  const shape = { message_sid: payload.sid, channel: scope.channel };

  if (!consentLedgerConfigured()) {
    /* Without the durable record there is nothing to record INTO, and a
       page saying "recorded" would be a lie about a compliance decision. */
    log("operator.action.ledger_absent", shape);
    return notice(res, 503, "Not recorded",
      "The durable record is not reachable from this deployment, so nothing was " +
      "recorded. Nothing has been changed.");
  }

  const note = String(params.note || "").trim();
  if (note.length > MAX_NOTE_CHARS) {
    /* Refused BEFORE the ledger is touched, like every other refusal on
       this path: nothing is written, nothing is projected, and the log
       carries the length limit rather than one character of what she
       typed. */
    log("operator.action.refused", {
      message_sid: payload.sid, reason: "note_too_long", limit: MAX_NOTE_CHARS,
    });
    return notice(res, 400, "Not recorded",
      `That note is longer than ${MAX_NOTE_CHARS} characters, so <strong>nothing was ` +
      "recorded</strong> — it was not shortened for you. Go back, shorten the note, and " +
      "submit again. The link still works.");
  }

  const occurredAt = new Date().toISOString();

  let event;
  try {
    event = buildSuppressionEvent({
      occurredAt,
      channel: scope.channel,
      /* THE ONLY EVENT TYPE THIS ENDPOINT CAN EMIT. `revoked` and not
         `suppressed` because that is the act that happened: a keyword or
         carrier action produces `suppressed`, a consumer withdrawing IN
         WORDS produces `revoked`, and this message reached a human
         BECAUSE it was not a keyword. `unsuppressed` is unreachable from
         here, by construction. */
      eventType: EVENT_TYPE.REVOKED,
      phone: payload.phone,
      source: SOURCE_OPERATOR,
      sourceEventId: payload.sid,
      /* Who recognised it — in a separate column from what happened, so
         neither has to be distorted to carry the other. */
      reasonCode: SUPPRESSION_REASON.MANUAL,
      /* THE CONSUMER'S EXACT WORDS, from the sealed token, capped by the
         same rule that capped them before sealing — so what is written is
         byte-identical to what the operator read. The operator's own note
         is NOT here and must never be: this column means what the
         CONSUMER said, and mixing operator prose into it would corrupt
         the one field whose value depends on being verbatim. */
      evidenceText: capEvidence(payload.body),
      metadata: {
        MessageSid: payload.sid,
        classified_by: "operator",
        entered_via: "email_action",
        token_v: payload.v,
        ...(note ? { operator_note: note } : {}),
      },
    });
  } catch (buildErr) {
    log("operator.action.unrecordable", { ...shape, ...ledgerLogShape(buildErr) });
    return notice(res, 400, "Not recorded",
      "That message's number could not be recorded against. Nothing was recorded.");
  }

  try {
    await appendSuppressionEvents([event]);
    log("operator.action.ledger_appended", shape);
  } catch (ledgerErr) {
    /* THE SUPPRESSION IS NOT DURABLE, so this must not report success.
       There is no retry and no queue: the operator still has the email
       and the link, and the link is idempotent. */
    log("operator.action.ledger_failed", { ...shape, ...ledgerLogShape(ledgerErr) });
    return notice(res, 503, "Not recorded",
      "The durable record could not be written, so nothing was recorded. " +
      "The link in the email still works — try it again in a few minutes.");
  }

  /* ---- BEST-EFFORT, AFTER THE RECORD IS ALREADY DURABLE ------------- */
  const projection = await projectToHubSpot({ scope, phone: payload.phone, occurredAt, shape });

  return page(res, 200, shell("Recorded", `
    <div class="ok">
      <p><strong>Recorded.</strong> ${escapeHtml(scope.detail)}</p>
      <p class="meta">A second click on the same link records nothing further —
         it is the same entry, not a second one.</p>
    </div>
    <p>${escapeHtml(projectionSentence(projection))}</p>
    <p class="meta">MessageSid ${escapeHtml(payload.sid)}</p>`));
}

/** What the result page says about the CRM half.
 *
 * A PARTIAL OUTCOME IS SHOWN, NOT HIDDEN. This function previously read
 * only `written` and ignored `failed`, so "one of two contacts could not
 * be updated" and "both were updated" produced the same sentence — and a
 * page that says two contacts were marked when one was not is simply
 * false. None of these outcomes is a failure of the request: the durable
 * suppression was written before any of this ran.
 */
function projectionSentence(projection) {
  const written = projection.written || 0;
  const failed = projection.failed || 0;
  const contacts = projection.contacts || 0;
  const stands = "That is a display problem only — the record above is the one that " +
    "counts, and it was written.";
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  if (projection.reason === "consent_state_disabled")
    return "The CRM copy was not updated, because CRM consent tracking is switched " +
      "off in this environment. That does not affect the record above.";
  if (projection.reason === "hubspot_not_configured")
    return "The CRM copy was not updated, because the CRM is not connected in this " +
      "environment. That does not affect the record above.";
  if (projection.reason === "no_contacts")
    return "Nobody in the CRM holds this number, so there was nothing to mark there. " +
      "The record above stands on its own.";
  if (projection.reason === "failed")
    return "The CRM could not be searched, so no contact was marked there. " + stands;

  /* Contacts were found and each was attempted individually. */
  if (written > 0 && failed > 0)
    return `${written} of ${plural(contacts, "CRM contact")} holding this number ` +
      `${written === 1 ? "was" : "were"} marked; ${failed} could not be updated. ` + stands;
  if (written === 0 && failed > 0)
    return "The CRM copy could not be updated for any of the " +
      `${plural(failed, "contact")} holding this number. ` + stands;
  if (written === 0 && contacts > 0)
    return `${plural(contacts, "CRM contact")} holding this number ` +
      `${contacts === 1 ? "was" : "were"} already marked, so nothing needed changing there.`;
  return `${plural(written, "CRM contact")} holding this number ` +
    `${written === 1 ? "was" : "were"} marked as well.`;
}

/**
 * Flag every contact holding this number. NEVER THROWS: by the time this
 * runs the suppression is already durable and already enforced, so a
 * HubSpot outage must not turn a recorded opt-out into an error page that
 * invites the operator to record it twice.
 */
async function projectToHubSpot({ scope, phone, occurredAt, shape }) {
  if (!consentStateEnabled()) {
    log("operator.action.projection_skipped", { ...shape, reason: "consent_state_disabled" });
    return { reason: "consent_state_disabled" };
  }
  if (!isConfigured()) {
    log("operator.action.projection_skipped", { ...shape, reason: "hubspot_not_configured" });
    return { reason: "hubspot_not_configured" };
  }

  try {
    const contacts = await findContactsByPhone(phone);
    if (!contacts.length) {
      log("operator.action.projection_no_contacts", shape);
      return { reason: "no_contacts" };
    }

    let written = 0;
    let failed = 0;
    for (const contact of contacts) {
      try {
        const props = toHubSpotSuppressionProperties({
          scope: scope.hubspot,
          trigger: SUPPRESSION_TRIGGER.MANUAL,
          at: occurredAt,
          current: contact.consent,
        });
        const result = await writeSuppressionProperties(contact.id, props);
        if (result.written) {
          written += 1;
          log("operator.action.projection_written", {
            ...shape, contact_id: contact.id, ...suppressionWriteLogShape(props),
          });
        }
      } catch {
        /* One contact failing does not stop the rest. */
        failed += 1;
      }
    }
    log("operator.action.projection_done", {
      ...shape, contacts: contacts.length, written, failed,
    });
    /* `contacts` travels with the counts because "found two, wrote none,
       failed none" (both already marked) and "found none" are different
       facts and must read differently. */
    return { reason: "written", written, failed, contacts: contacts.length };
  } catch (err) {
    /* Deliberately swallowed, deliberately loud. `log()` not `logError()`:
       a HubSpot error message can carry a contact's own details. */
    log("operator.action.projection_failed", {
      ...shape, error: String(err?.message || "").slice(0, 60).replace(/[^A-Za-z0-9_ ]/g, ""),
    });
    return { reason: "failed" };
  }
}

/* ---------------------------------------------------------------------
   HELPERS
   --------------------------------------------------------------------- */

/** Read one query parameter without assuming a parsed `req.query`. */
function queryParam(req, name) {
  const direct = req?.query && req.query[name];
  if (direct != null && direct !== "") return String(Array.isArray(direct) ? direct[0] : direct);
  const raw = String(req?.url || "");
  const q = raw.indexOf("?");
  if (q === -1) return "";
  return String(parseFormParams(raw.slice(q + 1))[name] || "");
}

/** One refusal shape for every bad token, on either method. */
function refuseToken(res, err, method) {
  const shape = err instanceof OperatorTokenError
    ? tokenLogShape(err) : { token_error: "unknown" };
  log("operator.action.token_refused", { method, ...shape });

  if (err instanceof OperatorTokenError && err.token === TOKEN_EXPIRED)
    return notice(res, 410, "This link has expired",
      "Links in these notifications stop working after 30 days. Nothing was recorded. " +
      "The message is still in the Twilio log if you need it.");

  return notice(res, 400, "This link is not valid",
    "This link could not be read. Nothing was recorded. Open it directly from the " +
    "notification email rather than from a copy that may have been altered in transit.");
}
