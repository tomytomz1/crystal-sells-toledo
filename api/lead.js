/* POST /api/lead - the only server-side entry point for website leads.
 *
 * Contract
 *   request   JSON body, <= 16 KB, same-origin
 *   success   200 { ok: true,  submission_id }
 *   failure   4xx/5xx { ok: false, code, message }
 *
 * The response never carries internal exception text, stack traces or any
 * credential material. `code` is a stable machine-readable token; `message`
 * is safe to show a visitor.
 */

import { randomBytes } from "node:crypto";
import { validateLead, FieldError } from "./_lib/validate.mjs";
import { createLead, isConfigured } from "./_lib/hubspot.mjs";
import { sendAcknowledgement, classifyMailError } from "./_lib/mail.mjs";
import { buildConsentEvidence, consentFeatureEnabled, consentLogShape } from "./_lib/consent.mjs";
import { appendConsentEvents, ledgerLogShape } from "./_lib/consent-ledger.mjs";
import { readBody, bodyErrorReason, rateLimit, clientIp, originAllowed, MAX_BODY_BYTES } from "./_lib/security.mjs";
import { log, logError, safeShape } from "./_lib/log.mjs";

/** 96 bits of CSPRNG entropy, prefixed so it is recognisable in a CRM record. */
function submissionId() {
  return "csv_" + randomBytes(12).toString("hex");
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

const fail = (res, status, code, message) => send(res, status, { ok: false, code, message });

const GENERIC_FAILURE =
  "We could not confirm your submission. Your details are still in the form. " +
  "You can try again, call, or email.";

/* Transport failures are not something a visitor can act on by reading about
   JSON. They get one instruction they can actually follow. */
const TRANSPORT_FAILURE =
  "We could not process this request. Please refresh the page and try again, " +
  "or contact Crystal directly.";

export default async function handler(req, res) {
  const started = Date.now();

  /* --- method ---------------------------------------------------------- */
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  }

  /* --- origin ---------------------------------------------------------- */
  if (!originAllowed(req))
    return fail(res, 403, "FORBIDDEN_ORIGIN", "Request origin not allowed.");

  /* --- rate limit ------------------------------------------------------ */
  const ip = clientIp(req);
  const limit = rateLimit(ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    log("lead.rate_limited", { retry_after: limit.retryAfter });
    return fail(res, 429, "RATE_LIMITED",
      "Please wait a few minutes before trying again, or contact Crystal directly.");
  }

  /* --- body ------------------------------------------------------------ */
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    /* EVERY BODY-READ FAILURE ENDS THE REQUEST HERE. Nothing below this
       block runs: no JSON parse, no validation, no consent evidence, no
       ledger append, no HubSpot write, no acknowledgement mail. There is
       no body, so there is no lead, and none of those steps has anything
       truthful to do with a submission that never arrived.

       The reason is derived from the helper's stable token, never from
       err.message — a message can carry parser text, and parser text can
       carry a fragment of what the visitor typed. */
    const reason = bodyErrorReason(err);
    log("lead.body_failed", { reason });

    if (reason === "too_large")
      return fail(res, 413, "PAYLOAD_TOO_LARGE",
        "That submission is too long to send. Please shorten your message and try again, " +
        "or contact Crystal directly.");

    /* 408, NOT 400, AND THE DISTINCTION IS THE POINT. The request was
       not malformed; it never finished arriving. Labelling an incomplete
       upload BAD_REQUEST tells the visitor — and anyone later reading
       the logs — that they sent something wrong, which is a claim this
       endpoint cannot support. `code` is machine-readable and is held to
       the same standard as prose.

       Safe to return here: no body was read, so no lead was created, and
       a repeated submission duplicates nothing. assets/js/main.js treats
       every non-2xx alike - it reads `code` for analytics and shows
       `message` - so the visitor-facing behaviour is unchanged and the
       form keeps the visitor's input either way.

       What this comment does NOT claim: how any particular intermediary
       or browser reacts to a 408 on a POST. That has not been measured
       here. The safety argument above does not depend on it - a repeat
       of a submission that was never read is harmless whoever initiates
       it. */
    if (reason === "timed_out")
      return fail(res, 408, "BODY_READ_TIMED_OUT", TRANSPORT_FAILURE);

    return fail(res, 400, "BAD_REQUEST", TRANSPORT_FAILURE);
  }

  const ct = String(req.headers["content-type"] || "");
  if (raw && ct && !ct.includes("application/json"))
    return fail(res, 415, "UNSUPPORTED_MEDIA_TYPE", TRANSPORT_FAILURE);

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return fail(res, 400, "INVALID_JSON", TRANSPORT_FAILURE);
  }

  /* --- validate -------------------------------------------------------- */
  let payload;
  try {
    payload = validateLead(body);
  } catch (err) {
    if (err instanceof FieldError) {
      /* A honeypot hit gets the same shape as any other rejection and is
         never forwarded to the CRM. It is logged distinctly so genuine
         validation failures stay visible in the metrics. */
      if (err.code === "REJECTED") {
        log("lead.honeypot", {});
        return fail(res, 400, "REJECTED", "Submission rejected.");
      }
      log("lead.invalid", { code: err.code });
      return fail(res, 422, err.code, err.message);
    }
    logError("lead.validate_error", err);
    return fail(res, 400, "BAD_REQUEST", "Could not process that submission.");
  }

  payload.meta.submission_id = submissionId();
  const sid = payload.meta.submission_id;

  /* --- consent evidence ------------------------------------------------
     Built server-side from the validated payload, AFTER the submission id
     exists so the evidence can name the event it belongs to. The browser
     supplied two booleans and nothing else; the timestamp, the version and
     the exact disclosure wording are attached here, which is what stops a
     forged request claiming a stronger consent than the page displayed.

     Attached to the payload, so it rides into the enquiry block and lands
     on HubSpot's native form-submission timeline activity as part of the
     SAME write that stores the lead. That is deliberate: consent evidence
     is CRITICAL, not a courtesy, and it cannot half-succeed. If HubSpot
     rejects the write, the lead fails loudly exactly as it does today -
     there is no path where the contact is stored and the consent is lost.

     Absent entirely while the feature is off, so the block written to
     production is unchanged. */
  if (consentFeatureEnabled()) {
    payload.consent = buildConsentEvidence(payload);
    log("lead.consent.captured", {
      submission_id: sid,
      form_type: payload.lead.form_type,
      ...consentLogShape(payload.consent),
    });

    /* --- the durable consent ledger --------------------------------
       BEFORE the CRM write, and the position is load-bearing twice
       over. It is what lets createLead() be told whether a grant may
       happen at all, and it is what makes the CONSENT LEDGER row in the
       enquiry block accurate - the block is built inside createLead(),
       so an append moved after it would print NOT CONFIRMED on every
       successful submission.

       The evidence goes to the ledger first and the permission second,
       never the other way round. If HubSpot then fails, the ledger holds
       events for a lead that is not in the CRM: correct, and the safe
       residue. It records what the person agreed to, which is true
       whether or not HubSpot accepted the lead, and no permission exists
       because no `cst_*` property was written. Evidence without
       permission is survivable; permission without evidence is the thing
       this whole gate exists to prevent. */
    try {
      await appendConsentEvents(payload.consent);
      payload.consent.durable = true;
      log("lead.consent.ledger_appended", { submission_id: sid });
    } catch (ledgerErr) {
      /* The lead still goes to HubSpot, with its timeline evidence rows
         intact - dropping those would destroy the record that the visitor
         ticked the box at all, which is the opposite of what an evidence
         system should do when its evidence sink is unavailable. What does
         NOT happen is a `cst_*` grant: a permission with no durable
         evidence behind it is the one outcome the ledger exists to
         prevent. The enquiry block says CONSENT LEDGER: NOT CONFIRMED, so
         the discrepancy explains itself to an operator.

         NOT CONFIRMED, deliberately, and not NOT RECORDED. Reaching this
         branch means no acknowledgement arrived - which is NOT the same as
         nothing being written. A timed-out or dropped request may have
         committed in PostgreSQL before its acknowledgement was lost, so
         this process cannot honestly say the ledger holds no event for
         this submission. It can only say it did not get told that it does.
         Claiming otherwise in a record an auditor reads would be a
         positive statement about a database this code did not hear back
         from. The safety semantics are unchanged: `durable` stays false,
         no `cst_*` grant is written, and the failure is closed either way.

         log(), not logError(): logError emits err.message, and a database
         driver error can carry the connection string. Only the
         classification is safe - the same treatment the Nodemailer
         failure below gets, and for the same reason. */
      log("lead.consent.ledger_failed", {
        submission_id: sid,
        ...ledgerLogShape(ledgerErr),
      });
    }
  }

  log("lead.accepted", {
    submission_id: sid,
    form_type: payload.lead.form_type,
    shape: safeShape(payload.lead),
    utm_source: payload.attribution.utm_source || "direct",
  });

  /* --- deliver --------------------------------------------------------- */
  if (!isConfigured()) {
    /* Refusing here is deliberate. Returning ok:true would tell the visitor
       their enquiry had been received when nothing had stored it - the one
       outcome this system exists to prevent. The client keeps their input
       and offers phone, email and mailto recovery. */
    logError("lead.not_configured", new Error("HUBSPOT_ACCESS_TOKEN absent"), { submission_id: sid });
    return fail(res, 503, "NOT_CONFIGURED", GENERIC_FAILURE);
  }

  try {
    const result = await createLead(payload);
    log("lead.delivered", {
      submission_id: sid,
      form_type: payload.lead.form_type,
      action: result.action,
      ms: Date.now() - started,
    });

    /* --- acknowledgement ----------------------------------------------
       Strictly after HubSpot has confirmed BOTH the contact and the
       timeline activity - createLead throws otherwise, so reaching this
       line IS the confirmation. The lead is already safe; everything
       below is a courtesy to the visitor.

       Awaited, never fire-and-forget: Vercel may freeze the container the
       moment the response is written, which would kill an in-flight SMTP
       conversation somewhere in the middle. Awaiting costs a second or
       two of function time and is the only way the send actually happens.

       Every failure is swallowed. A refused connection, a bad password, a
       rejected recipient - none of them may turn a lead that IS in the
       CRM into a submission the visitor is told to retry, because
       retrying would produce a duplicate enquiry against a contact that
       already has this one. The response contract below is unchanged and
       carries no email status: whether Crystal's mail server answered is
       not the browser's business. */
    try {
      const ack = await sendAcknowledgement(payload.lead, { submission_id: sid });
      if (ack.sent) log("lead.ack.sent", { submission_id: sid, form_type: payload.lead.form_type });
      else log("lead.ack.skipped", { submission_id: sid, reason: ack.reason });
    } catch (mailErr) {
      /* log(), not logError(): logError emits err.message, and a
         Nodemailer error's message carries the recipient address and the
         raw server response. Only the classification is safe. */
      log("lead.ack.failed", { submission_id: sid, reason: classifyMailError(mailErr) });
    }

    return send(res, 200, { ok: true, submission_id: sid });
  } catch (err) {
    logError("lead.delivery_failed", err, { submission_id: sid, ms: Date.now() - started });
    return fail(res, 502, "DELIVERY_FAILED", GENERIC_FAILURE);
  }
}
