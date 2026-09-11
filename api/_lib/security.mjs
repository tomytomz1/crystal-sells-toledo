/* Transport-level guards. Everything here runs before validation and
   before any outbound call, so a hostile request costs as little as
   possible. */

export const MAX_BODY_BYTES = 16 * 1024;

/* Sliding-window limiter held in module scope. Vercel may run several
   warm instances, so this is a floor rather than a ceiling — it stops
   naive floods from one instance cheaply and with no dependencies. For a
   hard global limit, move the store to Vercel KV / Upstash; see README. */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

/* Drop every key whose last hit has aged out.

   This is LAZY cleanup: it runs from a request, never from a timer. There is
   deliberately no setInterval here - on a serverless instance a live timer
   keeps the process referenced and fires on instances that are handling no
   traffic. The consequence is the honest one, and the privacy notice says it:
   an expired address is cleared by a later request or when the instance ends,
   NOT at a guaranteed moment. Do not restore any wording promising deletion on
   a fixed schedule. */
function sweep(now) {
  for (const [k, times] of hits) {
    const live = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(k, live);
    else hits.delete(k);
  }
}

export function rateLimit(key, now = Date.now()) {
  /* Every call, not on an interval. The earlier version only swept when a
     window had elapsed since the last sweep, which left expired keys behind
     for any staggered arrival pattern: A at t, B at t+599,999, C at t+600,000,
     D at t+1,199,999 retained three keys when only two were live. The map is
     capped at 5000 entries, so an unconditional pass is cheap. */
  sweep(now);

  const win = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (win.length >= RATE_MAX) {
    hits.set(key, win);
    return { allowed: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - win[0])) / 1000) };
  }
  win.push(now);
  hits.set(key, win);
  if (hits.size > 5000) hits.clear(); // every entry here is already live
  return { allowed: true };
}

export function _resetRateLimit() { hits.clear(); }

/* Test seam: how many addresses the limiter is currently holding. */
export function _rateLimitSize() { return hits.size; }

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Hosts permitted to submit.
 *
 * `*.vercel.app` used to be accepted as a suffix so preview deploys worked.
 * That let ANY vercel.app hostname - including someone else's project, which
 * anyone can create in seconds - past this check.
 *
 * Vercel names this deployment for us instead, so preview deploys keep
 * working without opening the whole shared domain:
 *
 *   VERCEL_URL         the immutable deployment hostname
 *   VERCEL_BRANCH_URL  the generated branch hostname pointing at the latest
 *                      successful deployment from this branch
 *
 * Both are admitted, and only whichever values Vercel actually set for THIS
 * deployment - a sibling branch or another project gets different strings and
 * is still refused. Anything else goes in ALLOWED_ORIGINS by name.
 */
export function allowedHosts() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([
    "crystalsellstoledo.com",
    "www.crystalsellstoledo.com",
    "localhost",
    "127.0.0.1",
    ...["VERCEL_URL", "VERCEL_BRANCH_URL"].map((v) => envHost(v)).filter(Boolean),
    ...extra,
  ]);
}

/**
 * Read a Vercel-supplied hostname from the environment.
 *
 * These arrive as bare hostnames, not URLs, so the value is lowercased and
 * used as given; one that somehow carries a scheme or a path is normalised
 * through the same parser as the request header rather than trusted as-is.
 */
function envHost(name) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return null;
  return raw.includes("://") ? hostOf(raw) : raw.split("/")[0] || null;
}

function hostOf(value) {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Same-origin check. A missing Origin is tolerated (some privacy tools
 * strip it) but a *present and foreign* Origin is refused.
 *
 * This is CSRF hygiene, not authentication: a header is trivially forged by
 * anything that is not a browser, so nothing downstream may treat a passing
 * Origin as proof of anything. It exists to stop a page on another site from
 * driving a visitor's browser into posting here.
 */
export function originAllowed(req) {
  const allow = allowedHosts();
  const origin = hostOf(req.headers.origin);
  if (origin) return allow.has(origin);
  const ref = hostOf(req.headers.referer);
  if (ref) return allow.has(ref);
  return true;
}

/* =====================================================================
   THE BODY READ, AND THE TWO BOUNDS ON IT
   =====================================================================
   WHERE THE TIMEOUT COMES FROM. Not a round number picked for looking
   reasonable — it is derived from this endpoint's actual budget, and the
   arithmetic is written down so the next change to that budget can be
   checked against it.

   api/lead.js — maxDuration 30 s (vercel.json), and NO third-party clock
   on either side: the browser posts with a plain fetch() and no
   AbortController (assets/js/main.js), and a human is waiting.

   WHAT THE 30 s MUST STILL COVER once the body is in hand, at the
   ceiling each module declares for itself:

     consent ledger append   <= 3 s  LEDGER_TIMEOUT_MS, feature-gated
     createLead()               8 s  HUBSPOT_TIMEOUT_MS, PER REQUEST —
                                     three requests on the ordinary path
                                     (search, write, form submission),
                                     five on the create-conflict race
     acknowledgement mail            nodemailer connection 5 s /
                                     greeting 5 s / socket 8 s, per
                                     phase, with no single overall
                                     deadline

   THOSE CEILINGS ARE NOT ADDITIVE-REALISTIC, AND THIS COMMENT DOES NOT
   PRETEND THEY ARE. Three HubSpot requests at 8 s each is already 24 s
   of a 30 s budget. The endpoint has always depended on them not all
   being hit at once. That is a PRE-EXISTING property of this function,
   recorded here rather than restated as arithmetic that works; it is
   not caused by this bound and is not fixed by it.

   SO THE BOUND IS NOT A SUBTRACTION FROM 30 s. Two things set it:

     * WHAT A LEGITIMATE BODY COSTS. MAX_BODY_BYTES is 16 KB. A visitor
       on a poor mobile uplink — call it 50 kbit/s sustained — delivers
       16 KB in about 2.6 s. 5 s is roughly double that, so the slowest
       plausible genuine submission is still accepted.
       THIS IS THE SIDE THAT MATTERS. Refusing a slow-but-real upload on
       the LEAD path loses the lead, which is the outcome this project
       treats as worst. Too tight is not the safe direction here.
     * WHAT A STALLED BODY MAY COST. 5 s is a sixth of the budget and
       less than one HubSpot request's ceiling, so a client that never
       finishes can never become the dominant consumer of the
       invocation.

   5 s is also what api/operator-action.js already takes — the other 30 s
   function with no third-party clock — so the two endpoints with the
   same budget and the same absence of an external deadline agree. The
   webhook's 3 s is deliberately NOT copied: that one is bound by a 15 s
   maxDuration AND Twilio's own ~15 s clock, and neither applies here.
   ===================================================================== */
export const BODY_READ_TIMEOUT_MS = 5000;

/** Stable and PII-free. Neither token ever carries a byte of the body. */
export const PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";
export const BODY_READ_TIMED_OUT = "BODY_READ_TIMED_OUT";

/* `message` is set as well as `token`, deliberately. api/lead.js has
   matched on err.message since this function was written; setting both
   keeps every existing caller and test working while giving new code a
   field that cannot collide with a runtime error's own text. */
function bodyError(token) {
  const err = new Error(token);
  err.token = token;
  return err;
}

/**
 * One mapping from a body-read failure to a loggable reason.
 *
 * IT READS ONLY `err.token`, AND THAT IS NOW TRUE. An earlier revision
 * of this function said exactly this sentence while reading
 * `err?.token || err?.message` — the prose and the code disagreed, and
 * the prose was the one being believed.
 *
 * Reading the message was not merely untidy. Every failure this function
 * raises deliberately goes through bodyError(), which sets `.token`. The
 * ONLY error that arrives without one is a genuine stream error, whose
 * `.message` is arbitrary text from Node or from the platform. With the
 * fallback in place, such an error whose message happened to read
 * `PAYLOAD_TOO_LARGE` would have been classified — and answered — as an
 * oversize body, promoting an unknown transport failure into a specific
 * claim about the visitor's submission. Token-only, it is `unreadable`,
 * which is what it is.
 *
 * Returns one of three fixed strings, so no caller can log a parser's
 * error text with a fragment of a visitor's message in it.
 *
 * `bodyError()` still sets `.message` as well as `.token`, because an
 * Error needs a message and because callers that matched on `.message`
 * before this change keep working. The CLASSIFIER simply does not read
 * it.
 */
export function bodyErrorReason(err) {
  const token = err?.token;
  if (token === PAYLOAD_TOO_LARGE) return "too_large";
  if (token === BODY_READ_TIMED_OUT) return "timed_out";
  return "unreadable";
}

/**
 * Read the body with a hard byte cap AND a hard time bound, rejecting
 * oversize before parsing and never returning a partial body.
 *
 * `timeoutMs` bounds THE STREAMING PATH ONLY. The two fast paths below
 * arm no timer at all: a body the platform has already parsed is in hand
 * this tick, so delaying it — or even creating a timer for it — would be
 * cost against no risk.
 *
 * A timed-out or oversize read REJECTS. It never resolves what arrived:
 * half a JSON document is not a document, and CLAUDE.md rule 11 is
 * reject, never truncate.
 */
export function readBody(req, { timeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    /* ---- FAST PATH 1: the declared length is already over the cap ----
       Refused before a byte is read, and before any socket teardown
       could be involved. Unchanged by this revision. */
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) return reject(bodyError(PAYLOAD_TOO_LARGE));

    /* ---- FAST PATH 2: the platform already parsed the body ----------
       Also unchanged: measured in bytes, refused if over the cap, and
       otherwise returned as the string api/lead.js goes on to JSON.parse.
       An object is stringified exactly as before. */
    if (req.body !== undefined && req.body !== null) {
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reject(bodyError(PAYLOAD_TOO_LARGE));
      return resolve(raw);
    }

    /* ---- THE STREAMING PATH, AND THE ONLY PATH WITH A CLOCK -------- */
    let size = 0;
    let chunks = [];
    let settled = false;

    /* The deadline starts HERE, in the same tick readBody() was called
       in — everything above is synchronous and does no I/O. It covers
       THE WHOLE WAIT for the body, not the gap between chunks: a client
       that dribbles one byte per second forever is exactly as bounded as
       one that sends nothing at all. An inactivity timer would not bound
       the first of those. */
    const timer = setTimeout(() => finish(bodyError(BODY_READ_TIMED_OUT)), Math.max(1, timeoutMs));
    /* DELIBERATELY NOT unref()'d. An unref'd timer does not hold the
       event loop open, so if the stalled request were the only thing
       pending the loop could empty before the bound ever fired — the
       exact case this bound exists for, disarmed by the one line that
       looks tidy. It is cleared on every exit path below and its longest
       life is `timeoutMs`. */

    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) return finish(bodyError(PAYLOAD_TOO_LARGE));
      chunks.push(c);
    };
    const onEnd = () => {
      /* Decoding happens only on a COMPLETE body, and the value is built
         BEFORE finish() releases `chunks`. */
      finish(null, Buffer.concat(chunks).toString("utf8"));
    };
    /* Guarded by `settled` like every other path, so a stream error
       arriving after we have already answered changes nothing. */
    const onError = (err) => finish(err);

    /**
     * The single exit. The timer, both size checks, `end` and `error`
     * all settle through here, exactly once.
     */
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      /* STOP LISTENING FOR THE BODY. Without this a stream that keeps
         flowing after a timeout keeps calling onData and keeps growing
         `chunks` — late async work on a request the caller has already
         given up on, and unbounded memory behind a bound meant to end
         it. */
      const drop = req.off || req.removeListener;
      if (typeof drop === "function") {
        drop.call(req, "data", onData);
        drop.call(req, "end", onEnd);
      }
      /* Released rather than left referenced by this closure until the
         request object is collected. A refused body is not kept. */
      chunks = [];

      /* THE ERROR LISTENER IS DELIBERATELY LEFT ATTACHED. A stream can
         emit `error` after we have stopped caring — an aborted request,
         a reset connection — and an `error` event with NO listener does
         not go quietly: EventEmitter THROWS it, which on a serverless
         runtime takes the whole invocation down AFTER we have answered.
         onError is a no-op once `settled`, so leaving it attached
         absorbs that harmlessly. */

      /* ---------------------------------------------------------------
         PAUSE. NEVER DESTROY. THE CALLER STILL HAS TO ANSWER.
         ---------------------------------------------------------------
         Until this revision the oversize branch called req.destroy().
         `req` and `res` share ONE socket, so destroying the request
         destroys the response with it — and the handler is told nothing,
         because res.end() succeeds and reports the response as ended.
         Measured against a real node:http server and client in #28:

           req.destroy()  ->  req.destroyed = true AND socket.destroyed = true
                              res.end() does not throw
                              res.writableEnded becomes true
                              THE CLIENT GETS ECONNRESET, never the status

           req.pause()    ->  socket intact, CLIENT GETS THE RESPONSE

         On the live lead path that meant a visitor whose submission was
         too long received a connection reset while the log recorded a
         413 that never left the building. pause() is chosen over doing
         nothing because it stops the flow EXPLICITLY rather than relying
         on the listener removal above having been the last `data`
         listener; the byte cap is unaffected either way.

         WHAT THIS DOES NOT DO, and WHY THAT IS THE CALLER'S PROBLEM
         RATHER THAN A NON-PROBLEM. pause() does not close the
         connection: the response goes out and the socket survives. An
         earlier revision of this comment called that "a resource
         question, not a correctness failure". THAT CLASSIFICATION WAS
         WRONG, and independent review caught it.

         Answering while part of the request body is still unread, on a
         connection left persistent, means the response advertises reuse
         the server may not honour — measured: the connection becomes
         usable again only once the client sends the rest of the body it
         declared, which on the timeout path is precisely what it did
         not do. The framing metadata is false, and a pooling client can
         reuse a connection that will not be served.

         IT IS STILL NOT THIS FUNCTION'S TO FIX. Closing correctly means
         deciding the response's `Connection` header, and that needs
         `res` — which this function does not have and MUST NOT BE
         GIVEN, because handing a body reader the caller's response is
         the exact resource-ownership error #28 paid for. The decision
         belongs at the response boundary; api/lead.js makes it there,
         from `req.complete` and the declared body length. */
      if (err && typeof req.pause === "function") {
        try { req.pause(); } catch { /* already torn down by the peer */ }
      }

      if (err) reject(err);
      else resolve(value);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
