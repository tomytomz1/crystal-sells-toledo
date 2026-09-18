/* =====================================================================
   CLOUDFLARE TURNSTILE — the human/bot verification boundary
   =====================================================================
   WHY THIS EXISTS. Production received seller submissions whose fields
   were syntactically perfect and semantically junk — a two-letter first
   name, a two-letter surname, a deliverable-looking email, a valid
   phone, a post-office-box "property address" 500 miles outside the
   service area. Every existing guard passed them, and correctly so:

     origin check       the post came from the site's own page
     rate limiter       one submission, well under the window
     body bounds        a few hundred bytes
     `_gotcha` honeypot left empty, as any headless browser leaves it
     field validation   every required field present and well formed
     consent parser     both boxes unticked, so NO permission was granted

   The consent model did its job: no SMS and no AI-voice permission was
   created. What still happened is the damage this module exists to stop
   — a CRM contact, a HubSpot form-submission timeline activity, a
   notification to Crystal, an acknowledgement email to a stranger's
   address, and a consent-evidence row recording a decision no human
   made.

   NONE OF THE EXISTING GUARDS CAN CATCH THAT CLASS, and adding another
   one of the same kind would not either. A honeypot, a field-shape rule
   and a per-IP window all ask "is this request well formed?". They
   cannot ask "was there a person at the other end?". That question is
   answerable only by something that observes the browser itself, which
   is what Turnstile does and what this module verifies.

   THE WIDGET IS NOT THE CONTROL. THIS FILE IS. A token in the request
   body proves nothing: anything that is not a browser can put a string
   there. The control is the server-side redemption below, against
   Cloudflare, before any downstream effect — and it is the only part of
   this feature that carries a security claim.

   WHAT THIS MODULE DELIBERATELY DOES NOT DO:
     * it never returns the token to a caller, so no caller can store it;
     * it never puts the token in a log line, an error message or a
       thrown Error;
     * it performs no retry, so it consumes at most one siteverify call
       and at most TIMEOUT_MS of the endpoint's 30 s budget.

   Contract source: Cloudflare Turnstile "Validate the token"
   (developers.cloudflare.com/turnstile/get-started/server-side-validation/),
   read on 18 September 2026. The properties relied on below are the
   documented ones: a token is at most 2048 characters, is valid for 300
   seconds, is single-use, and the response carries `success`,
   `error-codes`, `hostname`, `action`, `challenge_ts` and `cdata`.
   ===================================================================== */

import { allowedHosts } from "./security.mjs";

/** The documented redemption endpoint. Never proxy or cache it. */
export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/* Cloudflare documents a maximum token length of 2048 characters. A
   longer value is not a token, so it is refused HERE rather than
   spent on a network round trip - and, per rule 11, refused rather
   than truncated to fit. */
export const MAX_TOKEN_CHARS = 2048;

/* =====================================================================
   THE TIME BOUND, AND WHERE THE NUMBER COMES FROM
   =====================================================================
   api/lead.js has a 30 s maxDuration (vercel.json) and this call is
   ADDITIVE to everything after it: the consent ledger append (<= 3 s),
   createLead() (8 s per HubSpot request) and the acknowledgement mail.
   The gate runs before all of them, so whatever it takes is taken away
   from them.

   5000 ms is chosen for the same two reasons BODY_READ_TIMEOUT_MS is:

     * WHAT A LEGITIMATE VERIFICATION COSTS. A siteverify redemption is
       one small POST to Cloudflare's edge and normally answers in well
       under a second. 5 s is many multiples of that, so an ordinary
       visitor on a slow path is never refused by the clock.
     * WHAT A STALLED VERIFICATION MAY COST. 5 s is a sixth of the
       budget and less than one HubSpot request's ceiling, so a
       Cloudflare edge that accepts the connection and then stops
       talking can never become the dominant consumer of the
       invocation.

   THE ABORT COVERS THE BODY, NOT ONLY THE HEADERS. `fetch()` resolves
   as soon as the response headers arrive; reading the JSON afterwards
   with the controller already disarmed would leave the real deadline
   unbounded. The controller therefore stays live until the bytes are in
   hand - the same correction api/_lib/hubspot.mjs already carries, for
   the same reason.
   ===================================================================== */
export const TURNSTILE_TIMEOUT_MS = 5000;

/**
 * Is server-side verification configured for this deployment?
 *
 * THE SECRET IS THE SWITCH, and only the secret. The site key decides
 * whether a widget renders; it decides nothing about enforcement, and a
 * page that renders a widget while this returns false is protected by
 * nothing at all.
 *
 * A WHITESPACE-ONLY VALUE IS NOT CONFIGURATION. An environment variable
 * created but never filled in is the ordinary way a gate is believed to
 * be on while being off, so it is trimmed before it is believed.
 *
 * CLAUDE.md rule 19. While this returns false the endpoint behaves
 * exactly as it did before this feature existed. That is *absence of
 * enforcement*, not a lenient enforcement mode, and no document may
 * describe an unconfigured deployment as protected.
 */
export function turnstileEnabled() {
  return secretKey() !== "";
}

function secretKey() {
  return String(process.env.TURNSTILE_SECRET_KEY || "").trim();
}

/* =====================================================================
   THE CLOSED VOCABULARY OF OUTCOMES
   =====================================================================
   Every reason this module can report is one of these fixed strings.
   Nothing derived from the request, from the token, or from Cloudflare's
   response text can widen the set, so a log line can never carry a
   fragment of a visitor's submission or a piece of the token.
   ===================================================================== */
export const REASONS = Object.freeze({
  /* The token is the caller's problem: absent, unusable, or refused by
     Cloudflare on grounds that describe THE TOKEN. */
  MISSING: "missing_token",
  MALFORMED: "malformed_token",
  REJECTED: "rejected",
  HOSTNAME: "hostname_mismatch",
  ACTION: "action_mismatch",
  /* We could not obtain an answer, or the answer said the fault was
     OURS. Not the visitor's doing, and never reported to them as though
     it were. */
  UNVERIFIED: "unverified",
});

/* Cloudflare's documented error codes, split by WHOSE FAULT THEY NAME.
   This distinction is the whole reason the two failure families exist,
   and it is the same reasoning api/lead.js already applies when it
   answers 408 rather than 400 for a body that never finished arriving:
   a machine-readable code is held to the same honesty standard as
   visitor-facing prose, so the endpoint must not tell a genuine
   homeowner they failed a bot check when the server's own key is wrong.

   ABOUT THE TOKEN -> the submission is refused as unverified-human. */
const TOKEN_FAULT_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
]);

/* ABOUT US, OR ABOUT NOTHING WE CAN CLASSIFY -> the submission is
   refused as not-verifiable. `missing-input-secret` and
   `invalid-input-secret` are a misconfigured deployment;
   `bad-request` is a malformed request this module built;
   `internal-error` is Cloudflare's own, and is the one Cloudflare
   documents as retryable. An UNRECOGNISED code lands here too: an
   unknown code is not evidence about the visitor, and guessing that it
   is would be exactly the promotion of an unknown failure into a
   specific claim that bodyErrorReason() was corrected to stop doing. */
const OUR_FAULT_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

/** Every code this module is willing to repeat into a log line. */
const KNOWN_CODES = new Set([...TOKEN_FAULT_CODES, ...OUR_FAULT_CODES]);

/**
 * Reduce Cloudflare's `error-codes` array to a short, fixed-vocabulary
 * list that is safe to log.
 *
 * Cloudflare's codes are a closed documented set, but this response is
 * still EXTERNAL TEXT: nothing guarantees a future value is short, is
 * a code at all, or is free of something that should not be pasted into
 * a structured log. So anything outside the known set becomes the
 * literal string "unknown" and the original is discarded rather than
 * echoed, and the list is capped so a pathological response cannot
 * inflate a log line.
 */
function safeCodes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const code of raw.slice(0, 8)) {
    const s = typeof code === "string" ? code : "";
    out.push(KNOWN_CODES.has(s) ? s : "unknown");
  }
  return out;
}

/* The longest echoed diagnostic value. A hostname is bounded by DNS at
   253 characters and Cloudflare caps `action` at 32, so 128 is generous
   for anything legitimate - and a value longer than that is not a
   diagnosis, it is a response trying to be bigger than the log line it
   lands in. Truncation is correct HERE and is not the rule-11 case:
   rule 11 protects a VISITOR'S OWN DATA, which must be rejected rather
   than silently shortened. This is a third party's diagnostic string
   being quoted back for an operator to read, it is never stored, and it
   is marked with an ellipsis so a reader can see it was cut. */
const MAX_ECHO_CHARS = 128;

/**
 * Quote an external string back into a log line, safely.
 *
 * `safeCodes()` above sanitises Cloudflare's `error-codes` against a
 * closed vocabulary. `hostname` and `action` have no closed vocabulary
 * to check against - the whole point of echoing them is that they are
 * the UNEXPECTED value - so they get the other treatment: control
 * characters removed and a hard length cap.
 *
 * The control-character strip is belt to log()'s braces. log() emits
 * JSON.stringify(), which already escapes a newline rather than letting
 * it break the line, so forging a second log entry is not possible
 * either way; this removes the characters at the source so no future
 * caller that formats differently inherits the problem.
 */
function safeEcho(value) {
  const s = String(value).replace(/[ -]/g, "");
  return s.length > MAX_ECHO_CHARS ? s.slice(0, MAX_ECHO_CHARS) + "…" : s;
}

/**
 * Shape a verification outcome for the log.
 *
 * NO TOKEN, NO FRAGMENT OF ONE, AND NO LENGTH OF ONE. The token is a
 * bearer credential for a single redemption; it has no business in a
 * log that project members and Vercel retain. Only the outcome, the
 * classified reason, Cloudflare's own closed-vocabulary codes, and - on
 * a mismatch only - the sanitised value that caused it.
 */
export function turnstileLogShape(result) {
  const out = { ok: result?.ok === true };
  if (!out.ok && result?.reason) out.reason = result.reason;
  if (result?.codes?.length) out.codes = result.codes;
  /* `hostname` and `action` are echoed ONLY on a mismatch, because on a
     mismatch they are the whole diagnosis - "the token was minted
     somewhere else" is not actionable without knowing where. They are
     not personal data: the hostname is a site, and the action is one of
     this repository's own form_type strings. They ARE external text,
     so they go through safeEcho() rather than straight into the line. */
  if (result?.reason === REASONS.HOSTNAME && result.hostname)
    out.hostname = safeEcho(result.hostname);
  if (result?.reason === REASONS.ACTION)
    out.action = result.action == null ? "absent" : safeEcho(result.action);
  return out;
}

/**
 * True when the failure describes the TOKEN rather than this service.
 *
 * api/lead.js uses this to choose between telling the visitor we could
 * not verify them (their submission is refused) and telling them the
 * check is unavailable (they should try again) - two different claims,
 * and only one of them is ever true at a time.
 */
export function isTokenFault(reason) {
  return reason === REASONS.MISSING
    || reason === REASONS.MALFORMED
    || reason === REASONS.REJECTED
    || reason === REASONS.HOSTNAME
    || reason === REASONS.ACTION;
}

/**
 * Is this value shaped like a Turnstile token at all?
 *
 * Refused HERE, before the network, because a value that cannot be a
 * token cannot become one by being posted to Cloudflare, and the
 * cheap local rejection is the point of the gate's position in the
 * pipeline.
 *
 * NOT A FORMAT GUESS. Cloudflare documents a maximum length and nothing
 * about the token's internal structure, so this checks exactly what is
 * documented plus the one thing a header-safe, JSON-safe string cannot
 * contain: control characters. Inventing a stricter pattern from the
 * shape of today's tokens would refuse tomorrow's.
 */
function tokenUsable(token) {
  if (typeof token !== "string") return false;
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return false;
  return !/[ -]/.test(token);
}

/* =====================================================================
   THE REDEMPTION
   =====================================================================
   ONE CALL. NO RETRY. Cloudflare documents `idempotency_key` for
   callers that retry a failed redemption; this one does not, so sending
   a key would buy nothing and would state an intent the code does not
   act on. A retry would also double this gate's claim on a 30 s budget
   that api/lead.js already spends on HubSpot, and the thing being
   retried - `internal-error` - is reported to the visitor as a
   try-again, which is a retry by the only party who can mint a fresh
   token anyway.

   `remoteip` IS DELIBERATELY NOT SENT. It is optional, and the value
   this function could send is clientIp()'s, which reads
   `x-forwarded-for` - a header Vercel sets in production but which is
   client-supplied anywhere else. Feeding a forgeable address to a risk
   engine as though it were observed is worse than sending nothing, and
   Cloudflare already observes the visitor's real address when the
   challenge is served in their browser. So this sends less data to a
   third party AND avoids passing off an unverified value as a signal.
   ===================================================================== */

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * Returns a plain result object and NEVER THROWS: a gate that can throw
 * is a gate whose caller has to remember to catch, and a missed catch
 * on this path would turn a verification outage into a 500 rather than
 * into a refusal.
 *
 *   { ok: true,  hostname, action }
 *   { ok: false, reason, codes?, hostname?, action? }
 *
 * @param {object}   opts
 * @param {*}        opts.token           the value the client submitted
 * @param {string}   opts.expectedAction  the form_type this token must belong to
 * @param {Set<string>} [opts.allowed]    permitted hostnames; defaults to the
 *                                        site's own origin allow-list
 * @param {number}   [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]     test seam; defaults to global fetch
 */
export async function verifyTurnstile({
  token,
  expectedAction,
  allowed = allowedHosts(),
  timeoutMs = TURNSTILE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const secret = secretKey();
  /* Callers gate on turnstileEnabled(); reaching here without a secret
     is a programming error, and it must not fail OPEN. */
  if (!secret) return { ok: false, reason: REASONS.UNVERIFIED };

  if (token === undefined || token === null || token === "")
    return { ok: false, reason: REASONS.MISSING };
  if (!tokenUsable(token))
    return { ok: false, reason: REASONS.MALFORMED };

  let data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ secret, response: token }),
      signal: ctrl.signal,
    });
    /* READ INSIDE THE BOUND. See the timeout comment above: the headers
       arriving is not the exchange finishing. */
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      /* Cloudflare documents that siteverify always answers JSON. A
         non-JSON body is therefore something else answering - a proxy,
         a captive portal, an error page - and says nothing about the
         visitor. */
      return { ok: false, reason: REASONS.UNVERIFIED };
    }
  } catch {
    /* Aborted by the deadline, DNS failure, TLS failure, connection
       reset. NOTHING about the token is known, so nothing about the
       token is claimed. The error itself is deliberately not inspected
       or reported: its message can carry a URL and is not needed to
       choose the outcome. */
    return { ok: false, reason: REASONS.UNVERIFIED };
  } finally {
    clearTimeout(timer);
  }

  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, reason: REASONS.UNVERIFIED };

  const codes = safeCodes(data["error-codes"]);

  /* `success` MUST BE THE BOOLEAN `true`. Not truthy: a JSON `"true"`,
     a `1`, or a missing field must not be able to open this gate. This
     is the same narrowest-possible-parser rule parseConsentFlag()
     applies to a consent decision, and for the same reason - the value
     decides whether an unattested request reaches the CRM. */
  if (data.success !== true) {
    /* WHOSE FAULT DOES CLOUDFLARE NAME? Only a code that describes the
       TOKEN may be reported to the visitor as a failed verification.
       Everything else - our secret, our request, Cloudflare's own
       internals, and any code this module does not recognise - is
       reported as "could not verify", which is what actually happened.

       The test is deliberately "every code is a token fault", not "any
       code is": a response that mixes `invalid-input-response` with
       `internal-error` has not established that the token was bad. */
    const tokenFault = codes.length > 0 && codes.every((c) => TOKEN_FAULT_CODES.has(c));
    return {
      ok: false,
      reason: tokenFault ? REASONS.REJECTED : REASONS.UNVERIFIED,
      codes,
    };
  }

  /* -------------------------------------------------------------------
     A SUCCESSFUL TOKEN IS NOT AUTOMATICALLY *OUR* TOKEN.
     -------------------------------------------------------------------
     A sitekey is public - it is printed in the page - so anyone can put
     this site's sitekey on a page of their own, solve a real challenge
     there, and post the resulting token here. `success: true` is true
     of that token. The two fields below are what make it detectable,
     and Cloudflare's own guidance is to check them.

     HOSTNAME - where the challenge was actually served. Checked against
     allowedHosts(), the SAME set the origin check uses, so the two
     cannot drift apart and preview deployments keep working through
     VERCEL_URL / VERCEL_BRANCH_URL with no second list to maintain.

     Unlike the Origin header, this value is NOT client-supplied: it is
     Cloudflare's own record of where it served the challenge. That is
     precisely why it is worth checking - originAllowed() is CSRF
     hygiene against a forgeable header, and this is not. ------------- */
  const hostname = typeof data.hostname === "string" ? data.hostname.toLowerCase() : "";
  if (!hostname || !allowed.has(hostname))
    return { ok: false, reason: REASONS.HOSTNAME, hostname: hostname || "absent", codes };

  /* -------------------------------------------------------------------
     ACTION - which form the challenge was minted for.
     -------------------------------------------------------------------
     Every widget this site renders sets `action` to its form's
     `form_type` (assets/js/main.js), and Cloudflare returns it on
     validation. Requiring the returned action to equal the submitted
     form_type binds a token to one form: a token solved on the contact
     page cannot be replayed into a home_value submission, and a token
     minted by a widget that set no action at all did not come from this
     site's forms.

     ABSENT IS TREATED AS A MISMATCH, DELIBERATELY. Every widget here
     sets an action, so "no action" is not a token of ours. The cost of
     that strictness is stated honestly in the pull request rather than
     hidden: if Cloudflare ever stopped returning `action`, this check
     would refuse every lead, which is why the failure is logged with
     its own distinguishable reason and value ("absent" vs the wrong
     string) instead of being folded into a generic rejection. ------- */
  const action = typeof data.action === "string" ? data.action : "";
  if (!expectedAction || action !== expectedAction)
    return { ok: false, reason: REASONS.ACTION, action: action || "absent", codes };

  /* DELIBERATELY NOT CHECKED: `challenge_ts`. Cloudflare enforces the
     300-second validity itself and answers `timeout-or-duplicate` for
     an expired token. A second deadline computed against this
     function's own clock would add no security and would refuse valid
     tokens whenever the two clocks disagreed.

     DELIBERATELY NOT RETURNED: the token, and `cdata`. The token is
     never handed back so that no caller can persist it; `cdata` is not
     set by this site's widgets, so a value in it would not be ours. */
  return { ok: true, hostname, action };
}
