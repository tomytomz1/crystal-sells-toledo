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
import { createLead, isConfigured } from "./_lib/zoho.mjs";
import { readBody, rateLimit, clientIp, originAllowed, MAX_BODY_BYTES } from "./_lib/security.mjs";
import { log, logError, safeShape } from "./_lib/log.mjs";

/** 96 bits of CSPRNG entropy, prefixed so it is recognisable in a CRM note. */
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
  "We could not submit that just now. Please call or email and it will be handled right away.";

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
      "That is a lot of submissions in a short time. Please wait a few minutes, or call instead.");
  }

  /* --- body ------------------------------------------------------------ */
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.message === "PAYLOAD_TOO_LARGE")
      return fail(res, 413, "PAYLOAD_TOO_LARGE",
        "That submission is too large (limit " + Math.round(MAX_BODY_BYTES / 1024) + " KB).");
    return fail(res, 400, "BAD_REQUEST", "Could not read the request.");
  }

  const ct = String(req.headers["content-type"] || "");
  if (raw && ct && !ct.includes("application/json"))
    return fail(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON.");

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return fail(res, 400, "INVALID_JSON", "Body is not valid JSON.");
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
    logError("lead.not_configured", new Error("Zoho credentials absent"), { submission_id: sid });
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
    return send(res, 200, { ok: true, submission_id: sid });
  } catch (err) {
    logError("lead.delivery_failed", err, { submission_id: sid, ms: Date.now() - started });
    return fail(res, 502, "DELIVERY_FAILED", GENERIC_FAILURE);
  }
}
