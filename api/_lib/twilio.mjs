/* Twilio inbound webhook: request authentication only.
 *
 * This module decides ONE thing — did Twilio send this request? It parses
 * no meaning out of the body, classifies nothing, and writes nowhere. That
 * separation is the point: everything downstream may assume the request is
 * authentic, and nothing downstream has to remember to check.
 *
 * Gate 7 design: docs/updates/2026-09-10-stop-dnc-suppression-decision.md §2.8.
 *
 * NOTHING HERE MAY LOG. Not the signature, not the token, not the body,
 * not a parameter. The body is a consumer's message and the token is a
 * credential; the caller logs a classification and never a value.
 */

/* The cryptography is Twilio's own. `validateRequest` is the function the
   Twilio Node SDK ships for exactly this, and using it means the signature
   algorithm cannot drift from whatever Twilio actually does — including if
   Twilio ever changes it. What stays ours is the URL, below, because only
   this deployment knows what public URL Twilio addressed. */
import twilio from "twilio";

export const TWILIO_TOKEN_VAR = "TWILIO_AUTH_TOKEN";

/** Stable, PII-free refusal reasons. Safe to log; safe to return as a code. */
export const TWILIO_NOT_CONFIGURED = "TWILIO_NOT_CONFIGURED";
export const TWILIO_SIGNATURE_MISSING = "TWILIO_SIGNATURE_MISSING";
export const TWILIO_SIGNATURE_INVALID = "TWILIO_SIGNATURE_INVALID";
export const TWILIO_URL_UNRESOLVABLE = "TWILIO_URL_UNRESOLVABLE";

/** True when an auth token is present to verify against. */
export function twilioConfigured(env = process.env) {
  return Boolean(String(env[TWILIO_TOKEN_VAR] || "").trim());
}

/* ---------------------------------------------------------------------
   THE URL
   ---------------------------------------------------------------------
   Twilio signs the URL IT REQUESTED. Inside a Vercel function the request
   object does not carry that URL: `req.url` is a path, and the host the
   process sees is not necessarily the host Twilio addressed. So it is
   rebuilt from the forwarded headers.

   The design document names this the single most likely thing to get
   subtly wrong, and it is: a scheme or host that differs by one character
   produces a different HMAC and every legitimate webhook is refused. That
   failure is loud and closed, which is the direction to fail in — but it
   is worth recognising on sight, hence TWILIO_URL_UNRESOLVABLE.

   A forwarded header is attacker-controlled in general. Here that does not
   help an attacker: they would have to make the signature verify, and the
   signature is over the URL they would be choosing. Getting it wrong
   yields a mismatch; getting it "right" requires the auth token, which is
   the thing being proved.
   --------------------------------------------------------------------- */
export function requestUrl(req) {
  const h = req?.headers || {};
  const first = (value) => String(Array.isArray(value) ? value[0] : value || "")
    .split(",")[0].trim();

  const proto = first(h["x-forwarded-proto"]) || "https";
  const host = first(h["x-forwarded-host"]) || first(h.host);
  if (!host) return "";

  const path = String(req?.url || "/");
  /* Twilio signs the URL including its query string, so `req.url` is used
     whole rather than being split. */
  return proto + "://" + host + (path.startsWith("/") ? path : "/" + path);
}

/* ---------------------------------------------------------------------
   THE SIGNATURE
   ---------------------------------------------------------------------
   Delegated to `twilio.validateRequest(token, signature, url, params)`,
   which is the SDK's implementation of the scheme Twilio signs with:
   the full URL, then every POST parameter in ASCII order by key with the
   key immediately followed by its value and no separator, HMAC-SHA1 with
   the account auth token, base64.

   This was hand-rolled once and matched. It is delegated anyway: a
   signature check that is subtly wrong fails closed and is therefore
   invisible until every real webhook is refused, and there is no upside
   to owning that arithmetic. The SDK also does the constant-time compare.

   ALL RECEIVED PARAMETERS PARTICIPATE. `params` is whatever the form body
   decoded to, entire — nothing is filtered, whitelisted or dropped before
   validation, so an injected extra field invalidates the signature rather
   than sailing past a filter.
   --------------------------------------------------------------------- */

/**
 * Verify an inbound Twilio request.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }` — it never throws, so
 * a caller cannot accidentally treat an exception path as success.
 *
 * `params` must be the parsed form parameters, complete. Twilio signs the
 * parameters, not the raw byte stream, which is why the caller may parse
 * the form encoding first: form-decoding is not interpretation, and the
 * classification that IS interpretation happens only after this returns.
 */
export function verifyTwilioSignature(req, params, { env = process.env } = {}) {
  const token = String(env[TWILIO_TOKEN_VAR] || "").trim();
  if (!token) return { ok: false, reason: TWILIO_NOT_CONFIGURED };

  const header = req?.headers?.["x-twilio-signature"];
  const provided = String(Array.isArray(header) ? header[0] : header || "").trim();
  if (!provided) return { ok: false, reason: TWILIO_SIGNATURE_MISSING };

  const url = requestUrl(req);
  if (!url) return { ok: false, reason: TWILIO_URL_UNRESOLVABLE };

  /* Wrapped: the SDK throwing must not become an exception path a caller
     could mistake for success. Anything other than an explicit `true` is
     a refusal. */
  let valid = false;
  try {
    valid = twilio.validateRequest(token, provided, url, params || {}) === true;
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: TWILIO_SIGNATURE_INVALID };

  return { ok: true };
}

/* ---------------------------------------------------------------------
   THE BODY
   ---------------------------------------------------------------------
   Twilio posts `application/x-www-form-urlencoded`. Vercel may hand the
   handler a pre-parsed object, a string, or neither, so all three are
   handled — and the byte cap is applied in every case, before anything is
   decoded.
   --------------------------------------------------------------------- */
export const MAX_WEBHOOK_BYTES = 16 * 1024;

/* ---------------------------------------------------------------------
   AND BOUNDED IN TIME, NOT ONLY IN SIZE
   ---------------------------------------------------------------------
   The byte cap above stops a large body. It does nothing about a SLOW
   one. Until 11 September 2026 the streaming path resolved only on the
   stream's own `end`, so a client that opened the connection and then
   dribbled — or simply stopped — held this promise pending until the
   hosting platform killed the function. Carried forward from
   PR #26 and PR #27 as a prerequisite for Twilio activation.

   A 16 KB form from a datacentre is a matter of milliseconds. Any
   multi-second read here means something is already wrong, so these
   numbers are a SAFETY NET rather than a budget anyone should expect to
   spend. They are nonetheless derived from the callers' documented
   budgets rather than picked for convenience:

   api/twilio-inbound.js — maxDuration 15 s (vercel.json), and Twilio's
   own ~15 s webhook timeout whose clock starts BEFORE ours. Two paths
   have to fit, and the SECOND is the binding one:

     classified    body 3 s + ledger 3 s (LEDGER_TIMEOUT_MS) = 6 s, which
                   leaves 4 s inside the projection's ABSOLUTE 10 s
                   deadline (PROJECTION_DEADLINE_MS, measured from handler
                   entry) — comfortably above MIN_SEARCH_MS, so a body
                   read at its limit still leaves a usable projection.
                   Plus render < 1 s: about 8 s of 15.
     unclassified  body 3 s + notification 8 s (NOTIFICATION_DEADLINE_MS)
                   + render < 1 s = about 12 s of 15, leaving ~3 s for the
                   cold start and the network legs that sit inside
                   Twilio's clock and outside our maxDuration.

   The unclassified path is why this caller takes 3 s and not the default:
   at 5 s it would reach ~14 s of a 15 s budget before Twilio's own clock
   is even considered.

   api/operator-action.js — maxDuration 30 s, no third-party timeout
   beside it, and a HUMAN on the other end, quite possibly on poor mobile
   signal. Its documented worst case is ledger 3 s + projection 12 s +
   under 1 s of non-I/O ≈ 16 s. Adding 5 s of body read gives ~21 s of 30
   and RETAINS about 9 s of the headroom that section calls "the point".

   ONE CONSTANT WOULD HAVE BEEN WRONG FOR BOTH. 3 s is right for a
   datacentre POST racing another timeout; it is mean to a realtor
   submitting a form on bad cellular, where a false timeout costs her the
   note she typed. So the default is 5 s and the webhook overrides it
   explicitly, with the arithmetic stated at the call site.
   --------------------------------------------------------------------- */
export const BODY_READ_TIMEOUT_MS = 5000;

/** Stable, PII-free. Never carries a byte of the body. */
export const BODY_READ_TIMED_OUT = "BODY_READ_TIMED_OUT";
export const PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";

/**
 * One mapping from a body-read failure to a loggable reason, shared by
 * both callers so their vocabularies cannot drift.
 *
 * IT READS ONLY THE TOKEN, never the message, and returns one of three
 * fixed strings — so no caller can accidentally log a parser's error text
 * with a fragment of a consumer's message in it.
 */
export function bodyErrorReason(err) {
  const token = err?.token || err?.message;
  if (token === PAYLOAD_TOO_LARGE) return "too_large";
  if (token === BODY_READ_TIMED_OUT) return "timed_out";
  return "unreadable";
}

function bodyError(token) {
  const err = new Error(token);
  err.token = token;
  return err;
}

export function parseFormParams(raw) {
  const params = {};
  for (const [key, value] of new URLSearchParams(String(raw || "")))
    /* Last value wins for a repeated key, matching URLSearchParams->object
       conventions. Twilio does not repeat keys. */
    params[key] = value;
  return params;
}

/**
 * Read and form-decode the request body, refusing anything oversize AND
 * anything too slow.
 *
 * `timeoutMs` bounds the STREAMING path only, and the two fast paths below
 * are deliberately left alone: a body Vercel has already parsed is in hand
 * this tick, so delaying it — or even arming a timer for it — would be
 * cost with no risk to cover.
 *
 * A timed-out read REJECTS. It never resolves what arrived: a half-read
 * form is not a form, and the signature Twilio computed covers parameters
 * this process never saw. CLAUDE.md rule 11 — reject, never truncate.
 */
export function readFormBody(req, { timeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req?.headers?.["content-length"] || 0);
    if (declared > MAX_WEBHOOK_BYTES) return reject(bodyError(PAYLOAD_TOO_LARGE));

    if (req?.body !== undefined && req?.body !== null) {
      if (typeof req.body === "string") {
        if (Buffer.byteLength(req.body) > MAX_WEBHOOK_BYTES)
          return reject(bodyError(PAYLOAD_TOO_LARGE));
        return resolve(parseFormParams(req.body));
      }
      /* Already an object: use it as-is. Re-encoding it to a string and
         re-parsing would risk changing the very bytes the signature
         covers. */
      const flat = {};
      for (const [k, v] of Object.entries(req.body)) flat[k] = String(v == null ? "" : v);
      return resolve(flat);
    }

    /* ---- THE STREAMING PATH, AND THE ONLY PATH WITH A CLOCK --------- */
    let size = 0;
    let chunks = [];
    let settled = false;

    /* The deadline starts HERE, which is the same tick readFormBody() was
       called in — everything above is synchronous and does no I/O. It
       covers the WHOLE wait for the body, not the gap between chunks: a
       sender that dribbles one byte per second forever is exactly as
       bounded as one that sends nothing at all. */
    const timer = setTimeout(() => finish(bodyError(BODY_READ_TIMED_OUT)), Math.max(1, timeoutMs));
    /* DELIBERATELY NOT unref()'d, and an earlier draft of this change had
       it the other way round. An unref'd timer does not hold the event
       loop open — so if the stalled request were the only thing pending,
       the loop could empty and the process exit BEFORE the bound fired.
       That is precisely the case this bound exists for, disarmed by the
       one line meant to be tidy. It is cleared on every exit path below,
       and its longest life is `timeoutMs`, so holding the loop for at
       most that long is the behaviour wanted rather than a leak. */

    const onData = (c) => {
      size += c.length;
      if (size > MAX_WEBHOOK_BYTES) return finish(bodyError(PAYLOAD_TOO_LARGE));
      chunks.push(c);
    };
    const onEnd = () => {
      /* Decoding happens only on a COMPLETE body. */
      let params;
      try { params = parseFormParams(Buffer.concat(chunks).toString("utf8")); }
      catch (err) { return finish(err); }
      finish(null, params);
    };
    /* Guarded by `settled` like every other path, so a stream error
       arriving after we have already answered changes nothing. */
    const onError = (err) => finish(err);

    /**
     * The single exit. Everything settles through here exactly once:
     * the timer, both size checks, `end`, `error` and a decode failure.
     */
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      /* STOP LISTENING FOR THE BODY. Without this, a stream that keeps
         flowing after a timeout keeps calling onData and keeps growing
         `chunks` — late async work on a request the caller has already
         given up on, and unbounded memory behind a bound that was
         supposed to end it. */
      const drop = req.off || req.removeListener;
      if (typeof drop === "function") {
        drop.call(req, "data", onData);
        drop.call(req, "end", onEnd);
      }
      /* `chunks` is released rather than left referenced by this closure
         until the request object is collected. */
      chunks = [];

      /* THE ERROR LISTENER IS DELIBERATELY LEFT ATTACHED. A stream can
         emit `error` after we have stopped caring — an aborted request,
         a reset connection — and an `error` event with NO listener does
         not go quietly: EventEmitter THROWS it, which on a serverless
         runtime takes the whole invocation down AFTER we have answered.
         onError is a no-op once `settled`, so leaving it attached absorbs
         that harmlessly. It is one closure on an object that is about to
         be discarded with the request. */

      /* ---------------------------------------------------------------
         PAUSE. NEVER DESTROY. THE CALLER STILL HAS TO ANSWER.
         ---------------------------------------------------------------
         An earlier draft of this function called req.destroy() here, and
         the oversize branch has called it since the gate 7 SMS work
         merged in #20. MEASURED against a real node:http server and
         client on 11 September 2026, that is a response-losing bug:

           req.destroy()  ->  req.destroyed=true, AND socket.destroyed=true
                              res.end() does not throw
                              res.writableEnded becomes true
                              THE CLIENT GETS ECONNRESET, never the 400

         `req` and `res` share one socket. Destroying the request destroys
         the response with it — and the handler is told nothing, because
         res.end() succeeds and reports the response as ended. So the
         endpoint logs a refusal it never actually delivered.

           req.pause()    ->  socket intact, CLIENT GETS 400
           (doing nothing) ->  socket intact, CLIENT GETS 400

         pause() is chosen over doing nothing because it stops the flow
         EXPLICITLY rather than relying on the removal above having been
         the last `data` listener. The size bound is unaffected: nothing
         further is accumulated either way, and TCP back-pressure does
         the rest.

         WHAT THIS DOES NOT DO, measured rather than assumed. An earlier
         draft of this comment claimed Node closes the connection after
         the response because the body was never fully consumed. IT DOES
         NOT. Measured on the same day: the response goes out carrying
         `Connection: keep-alive`, `shouldKeepAlive` is true, and the
         socket is still alive afterwards. So a client that stalls or
         overruns gets its refusal and MAY HOLD THE CONNECTION OPEN.

         That is a resource question, not a correctness one, and it is
         bounded outside this function: the platform ends the invocation
         at maxDuration whatever the socket does. Closing it deliberately
         means setting `Connection: close` and tearing down after the
         response has flushed — which requires `res`, which this function
         does not have and must not be given.

         THE RULE, stated so it is not re-derived wrongly: this function
         reads a body. IT DOES NOT OWN THE SOCKET — the caller does,
         because the caller is the one that still has to answer. Killing
         the socket from here is precisely the bug above. */
      if (err && typeof req.pause === "function") {
        try { req.pause(); } catch { /* already ended; nothing to pause */ }
      }

      if (err) reject(err);
      else resolve(value);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/* ---------------------------------------------------------------------
   OptOutType
   ---------------------------------------------------------------------
   Present only when Advanced Opt-Out is enabled on the Messaging Service.
   Where it is present it is AUTHORITATIVE: it is a statement about what
   Twilio actually did to the number, and re-deriving that from the message
   body risks our record disagreeing with the system doing the blocking.

   Enabling Advanced Opt-Out is itself a Messaging Service configuration
   change, and Twilio configuration is frozen while the TCR hold on error
   30753 is open — so the parameter will usually be ABSENT and everything
   here must behave correctly when it is.
   --------------------------------------------------------------------- */
export const OPT_OUT_TYPE = Object.freeze({
  STOP: "STOP",
  START: "START",
  HELP: "HELP",
});

export function optOutType(params) {
  const raw = String(params?.OptOutType || "").trim().toUpperCase();
  return OPT_OUT_TYPE[raw] || null;
}
