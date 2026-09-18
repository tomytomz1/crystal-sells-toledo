/* The outbound SMS sender — DARK BY DEFAULT.
   =====================================================================
   This is the only component in the repository that may cause an outbound
   SMS side effect. Gate 9 gives it one narrow internal caller,
   api/_lib/lead-sms-ack.mjs; no public endpoint calls it directly and
   tools/check-sms-sender.mjs enforces that reachability boundary.

   WHAT THIS MODULE IS. A transport. It is handed a message that has
   already been decided elsewhere and it either sends that exact message
   to that exact number or refuses. It composes nothing, templates
   nothing, and decides no marketing content.

   THE ORDER IS THE WHOLE POINT:

     0. normalise the arguments      - local, no I/O, and a bad call is
                                       a REFUSAL, never an exception
     1. outbound feature gate        - local, no I/O
     2. configuration                - local, no I/O
     3. input and target validation  - local, no I/O
     4. construct the Twilio client  - local, synchronous, no I/O
     5. await authorizeSms()         - gate 8; the LAST provider read
                                       inside it is durable suppression
     6. if denied, return            - nothing has been sent
     7. messages.create()            - IMMEDIATELY. No await between 6
                                       and 7, no queue, no timer, no log
                                       round trip, no cache write.

   Step 4 is before step 5 on purpose. Building the client is local and
   synchronous, so doing it first keeps the authorization result and the
   side effect adjacent in the same stack frame. If client construction
   sat between them it would be an opportunity for someone to make it
   asynchronous later and reopen the window gate 8 exists to narrow.

   THERE IS NO RUNTIME SWITCH FOR GATE 8. The exported `sendSms` is built
   once, at module load, over the real `authorizeSms` and the real Twilio
   client factory, and it closes over them. There is no module-level
   mutable binding the send path reads, and no exported setter. A test
   builds its OWN sender with `_senderForTest()`; doing so cannot alter
   the exported one, because the exported one never looks anything up.

   An earlier version of this module exported `_setAuthorizer()`, which
   an independent review correctly called an authorization-bypass
   mechanism shipped inside the production path: any importer could
   replace gate 8 with `async () => ({ allowed: true })`. A static guard
   proving the DEFAULT pointed at gate 8 did not help, because the
   default was never the problem.

   THE ALLOWED VALUE NEVER LEAVES THE FRAME. It is not returned, not
   stored, not cached, not written to a queue payload, not persisted.
   Every call performs its own authorization. There is no path that
   reuses an earlier decision - `tests/sms-sender.test.mjs` proves two
   sends make two authorization calls.

   WHAT THIS MODULE DOES NOT PROVIDE. Idempotency, deduplication, an
   outbox, durable retry, or exactly-once delivery. **One invocation
   makes at most one `messages.create()` attempt and never retries it.**
   That is a deliberate refusal, not an omission: once the provider call
   has been attempted, a timeout or a socket error is AMBIGUOUS - Twilio
   may have accepted and queued the message while our answer was lost.
   Retrying that blind is how a consumer receives the same text twice.
   Gate 9 adds only a narrow acknowledgement orchestrator above this
   transport; it does not turn this transport into a durable outbox.

   Accordingly the result distinguishes three states and never collapses
   them: definitely not sent, confirmed accepted, and unconfirmed. See
   THE FAILURE CLASSIFICATION below for what is allowed to move a
   provider failure out of "unconfirmed".

   AND IT NEVER REJECTS. Every path returns a result, including a
   malformed call and the ones where a dependency threw. A throw before
   the provider call is always a refusal; only the provider call itself
   can produce "unconfirmed".
   ===================================================================== */

import twilio from "twilio";
/* The SDK's own exception classes. Imported so a provider REJECTION can
   be told apart from a transport failure by identity rather than by
   duck-typing fields on whatever was thrown - see providerRejection().
   These are CommonJS modules, so the ESM default is the module object
   and the class is on `.default`; unwrapped defensively below. */
import RestExceptionModule from "twilio/lib/base/RestException.js";
import TwilioServiceExceptionModule from "twilio/lib/base/TwilioServiceException.js";

import { toE164 } from "./consent-ledger.mjs";
import { authorizeSms } from "./send-permission.mjs";

/* ---------------------------------------------------------------------
   CONFIGURATION
   ---------------------------------------------------------------------
   Deliberately NOT TWILIO_AUTH_TOKEN. That variable is the INBOUND
   signature-verification credential used by api/_lib/twilio.mjs, and it
   is the account's master secret. Outbound uses a SEPARATE API Key pair,
   so a leak of one does not hand over the other and either can be
   rotated alone. The installed SDK (twilio 6.1.0) takes the key pair
   positionally with the account named in opts:

       twilio(apiKeySid, apiKeySecret, { accountSid })

   verified against node_modules/twilio/lib/index.d.ts, not from memory.

   SEPARATE IS NOT THE SAME AS LEAST PRIVILEGE, and this module does not
   claim it is. All the code below verifies is that the SID has the `SK`
   shape. An `SK` SID says the credential is an API Key; it says nothing
   about whether that key is a Main, Standard or Restricted key, and
   nothing about which permissions it holds. Whether the key is
   restricted to the minimum needed to send through the registered
   Messaging Service is an OPERATOR verification in the Twilio Console
   that no code here can perform. See .env.example and
   docs/updates/2026-09-17-outbound-sms-sender.md.
   --------------------------------------------------------------------- */
export const OUTBOUND_SMS_FLAG = "OUTBOUND_SMS_ENABLED";
export const TWILIO_ACCOUNT_SID_VAR = "TWILIO_ACCOUNT_SID";
export const TWILIO_API_KEY_SID_VAR = "TWILIO_API_KEY_SID";
export const TWILIO_API_KEY_SECRET_VAR = "TWILIO_API_KEY_SECRET";
export const TWILIO_MESSAGING_SERVICE_SID_VAR = "TWILIO_MESSAGING_SERVICE_SID";

/** Twilio's documented maximum for a single message body, taken from the
 *  installed SDK's own parameter documentation: "Can be up to 1,600
 *  characters in length." Longer input is REFUSED, never truncated -
 *  CLAUDE.md rule 11. A silently shortened message is a message the
 *  operator did not approve. */
export const MAX_SMS_BODY_CHARS = 1600;

/**
 * Bound the provider request itself. In twilio-node 6.1.0 the RequestClient
 * constructor option is used both as the HTTPS socket timeout and the default
 * Axios request timeout. A courtesy SMS must not be allowed to consume the
 * entire lead function's execution budget after HubSpot already stored the lead.
 */
export const TWILIO_REQUEST_TIMEOUT_MS = 5000;

/* Twilio resource SIDs are a two-letter prefix and 32 hex characters.
   Checked because a structurally impossible SID is a configuration
   mistake we can catch locally, before spending a provider round trip
   and before any chance of sending on the wrong account. */
const sidShape = (prefix) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);
const ACCOUNT_SID = sidShape("AC");
const API_KEY_SID = sidShape("SK");
const MESSAGING_SERVICE_SID = sidShape("MG");
const MESSAGE_SID = /^(?:SM|MM)[0-9a-fA-F]{32}$/;

/** Unwrap a CommonJS class through ESM interop. Returns undefined rather
 *  than throwing if the shape is not what is expected - a failed unwrap
 *  degrades the classification below to "unconfirmed", which is the safe
 *  direction. `tests/sms-sender.test.mjs` asserts the unwrap succeeded
 *  and that the SDK's own thrower produces these exact classes, so the
 *  degraded path cannot go unnoticed. */
const classOf = (mod) => (typeof mod === "function" ? mod : mod && mod.default);
export const RestException = classOf(RestExceptionModule);
export const TwilioServiceException = classOf(TwilioServiceExceptionModule);

/** Stable, PII-free tokens. Safe to log and safe to return. */
export const SMS_STATUS = Object.freeze({
  NOT_SENT: "not_sent",
  ACCEPTED: "accepted",
  UNKNOWN: "unknown",
});

export const SMS_REASON = Object.freeze({
  MALFORMED_CALL: "MALFORMED_CALL",
  DISABLED: "OUTBOUND_SMS_DISABLED",
  NOT_CONFIGURED: "TWILIO_OUTBOUND_NOT_CONFIGURED",
  CONFIG_MALFORMED: "TWILIO_OUTBOUND_CONFIG_MALFORMED",
  INVALID_TARGET: "INVALID_TARGET",
  EMPTY_BODY: "EMPTY_BODY",
  BODY_TOO_LONG: "BODY_TOO_LONG",
  CLIENT_UNAVAILABLE: "TWILIO_CLIENT_UNAVAILABLE",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  /* Definitely not sent - the provider answered and refused. */
  REJECTED: "TWILIO_REJECTED",
  REJECTED_UNAUTHORIZED: "TWILIO_REJECTED_UNAUTHORIZED",
  REJECTED_RATE_LIMITED: "TWILIO_REJECTED_RATE_LIMITED",
  /* Unconfirmed - we do not know what happened to the attempt. */
  SEND_UNCONFIRMED: "TWILIO_SEND_UNCONFIRMED",
  PROVIDER_ERROR_UNCONFIRMED: "TWILIO_PROVIDER_ERROR_UNCONFIRMED",
  MALFORMED_PROVIDER_RESPONSE: "TWILIO_MALFORMED_RESPONSE",
});

/* ---------------------------------------------------------------------
   THE FAILURE CLASSIFICATION
   ---------------------------------------------------------------------
   Not every thrown error means the same thing, and collapsing them all
   into "unconfirmed" is as much a misreport as collapsing them all into
   "failed". What the installed SDK actually guarantees, read from
   node_modules/twilio/lib/base/Version.js and RequestClient.js rather
   than from memory:

     * `Version.createWithResponseInfo()` calls `throwException(response)`
       only AFTER a complete HTTP response has been received and only
       when its status is outside 2xx. `throwException` constructs either
       a TwilioServiceException (RFC-9457 body) or a RestException
       (legacy body), both carrying the numeric `status`.
     * A transport failure - DNS, TLS, timeout, socket reset, abort -
       rejects out of `RequestClient.request()` with the underlying
       transport error. It is NEVER one of those two classes.

   So membership of those two classes is PROOF that the provider answered
   the request. A 4xx answer is proof it was refused before any message
   resource existed, which is "definitely not sent".

   Everything else stays "unconfirmed", deliberately:
     * 5xx - the provider answered with a server error, which does not
       establish whether the message was accepted first;
     * any other thrown value - a transport failure, a programming error,
       or an object of unknown provenance.

   IDENTITY, NOT DUCK TYPING. The check is `instanceof` against the SDK's
   own classes. An arbitrary thrown object carrying `{ status: 400 }`
   must not be able to talk this module into reporting "definitely not
   sent", because the one thing worse than an ambiguous answer is a
   confident wrong one.

   THE RESIDUAL, STATED. A 4xx is treated as proof of refusal. A
   middlebox that forwarded the request and then answered 4xx itself
   would defeat that. This is not defended against, and no evidence
   available here could distinguish it.
   --------------------------------------------------------------------- */

/**
 * @param {unknown} err whatever the provider call threw
 * @returns {string|null} a NOT_SENT reason when the error PROVES the
 *   request was refused, otherwise null (the caller reports unknown).
 */
export function providerRejection(err) {
  const answered =
    (typeof RestException === "function" && err instanceof RestException) ||
    (typeof TwilioServiceException === "function" && err instanceof TwilioServiceException);
  if (!answered) return null;

  /* Read one field, and only after identity is established. */
  let status;
  try {
    status = err.status;
  } catch {
    return null;
  }
  if (!Number.isInteger(status)) return null;
  if (status < 400 || status > 499) return null;

  if (status === 401 || status === 403) return SMS_REASON.REJECTED_UNAUTHORIZED;
  if (status === 429) return SMS_REASON.REJECTED_RATE_LIMITED;
  return SMS_REASON.REJECTED;
}

/** The unconfirmed reason for an error that is not a proven rejection:
 *  a provider answer we cannot read as a refusal, or no answer at all. */
function unconfirmedReason(err) {
  const answered =
    (typeof RestException === "function" && err instanceof RestException) ||
    (typeof TwilioServiceException === "function" && err instanceof TwilioServiceException);
  return answered ? SMS_REASON.PROVIDER_ERROR_UNCONFIRMED : SMS_REASON.SEND_UNCONFIRMED;
}

/** Exactly the string "true", the same discipline as the consent flag.
 *  A switch that turns outbound messaging on through a typo is worse
 *  than one that needs the word spelled out. */
export function outboundSmsEnabled(env = process.env) {
  return readEnv(env, OUTBOUND_SMS_FLAG) === "true";
}

/** Read one variable without trusting the container. A throwing getter
 *  or an exotic proxy is a missing value, not an exception. */
function readEnv(env, name) {
  try {
    const v = env[name];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Present AND structurally plausible. Returns `{ ok: false, reason }`
 *  when unusable, so a caller cannot mistake a partially-configured
 *  account for a working one. Never returns or logs a secret. */
export function outboundConfig(env = process.env) {
  const read = (name) => String(readEnv(env, name) || "").trim();
  const accountSid = read(TWILIO_ACCOUNT_SID_VAR);
  const apiKeySid = read(TWILIO_API_KEY_SID_VAR);
  const apiKeySecret = read(TWILIO_API_KEY_SECRET_VAR);
  const messagingServiceSid = read(TWILIO_MESSAGING_SERVICE_SID_VAR);

  if (!accountSid || !apiKeySid || !apiKeySecret || !messagingServiceSid)
    return { ok: false, reason: SMS_REASON.NOT_CONFIGURED };

  if (!ACCOUNT_SID.test(accountSid) ||
      !API_KEY_SID.test(apiKeySid) ||
      !MESSAGING_SERVICE_SID.test(messagingServiceSid))
    return { ok: false, reason: SMS_REASON.CONFIG_MALFORMED };

  return { ok: true, accountSid, apiKeySid, apiKeySecret, messagingServiceSid };
}

/* The provider boundary. Production builds a real client; a test builds
   its own sender over a double, and the ordering, validation and result
   handling under test are the real ones. */
function realClient({ accountSid, apiKeySid, apiKeySecret }) {
  /* autoRetry is false by default in twilio 6.1.0 and, when enabled,
     retries only 429 responses - verified in
     node_modules/twilio/lib/base/RequestClient.js. Both timeout and
     autoRetry are explicit so the one-attempt bounded-request promise
     does not rest on library defaults that a future upgrade could change. */
  return twilio(apiKeySid, apiKeySecret, {
    accountSid,
    autoRetry: false,
    timeout: TWILIO_REQUEST_TIMEOUT_MS,
  });
}

const notSent = (reason) => ({ status: SMS_STATUS.NOT_SENT, reason });

/**
 * Build a sender over a pair of boundaries.
 *
 * Called exactly twice in this repository: once below, to build the
 * exported production sender over the real gate 8 and the real Twilio
 * client, and once from `_senderForTest()`. The boundaries are closed
 * over, so nothing can substitute them afterwards.
 *
 * @param {{authorize: Function, clientFactory: Function}} boundaries
 */
function makeSender({ authorize, clientFactory }) {
  /**
   * Send one SMS, or refuse.
   *
   * @param {object}  message
   * @param {string}  message.email  selects the HubSpot contact carrying consent
   * @param {string}  message.phone  the ACTUAL target; gate 8 authorizes this number
   * @param {string}  message.body   the already-approved text to send
   * @param {object}  [options]
   * @param {object}  [options.env]  defaults to process.env when absent
   * @returns {Promise<{status: string, reason?: string, message_sid?: string}>}
   *
   * NEVER REJECTS, for any argument. A malformed call is a refusal with
   * a stable token, not an exception and never permission. The result
   * carries no phone, email, body, credential or provider exception
   * text. `message_sid` is a Twilio resource identifier, not consumer
   * data, and is the only way a later reconciliation can find the
   * message this call created.
   */
  return async function sendSms(message, options) {
    /* 0. THE CALL ITSELF. Parameter destructuring defaults only cover
          `undefined`, so `sendSms(null)` used to throw before a single
          line of this body ran - the exact gap an independent review
          found in the "never rejects" claim. Everything below reads the
          arguments inside a try: a throwing getter or an exotic proxy
          is a malformed call, not an escaping exception.

          A bad invocation is a REFUSAL. Nothing here reinterprets a
          dangerous value into a usable one. */
    let email, phone, body, env;
    try {
      if (message === null || typeof message !== "object" || Array.isArray(message))
        return notSent(SMS_REASON.MALFORMED_CALL);
      ({ email, phone, body } = message);

      if (options === undefined) {
        env = process.env;
      } else if (options === null || typeof options !== "object" || Array.isArray(options)) {
        return notSent(SMS_REASON.MALFORMED_CALL);
      } else if (options.env === undefined) {
        env = process.env;
      } else if (options.env === null || typeof options.env !== "object") {
        return notSent(SMS_REASON.MALFORMED_CALL);
      } else {
        env = options.env;
      }
    } catch {
      return notSent(SMS_REASON.MALFORMED_CALL);
    }

    /* 1. The gate. Checked first because a disabled system should cost
          nothing: no client, no configuration read of consequence, and
          above all no gate 8 call, which would otherwise reach HubSpot
          and Neon for a message that can never be sent. */
    if (!outboundSmsEnabled(env)) return notSent(SMS_REASON.DISABLED);

    /* 2. Configuration. */
    const config = outboundConfig(env);
    if (!config.ok) return notSent(config.reason);

    /* 3. Input. The target is normalised with the project's canonical
          rules, and the SAME normalised value is used for authorization
          and for the provider call - authorizing one number and texting
          another is the defect this ordering exists to make impossible. */
    let to;
    try {
      to = toE164(phone);
    } catch {
      return notSent(SMS_REASON.INVALID_TARGET);
    }

    const text = typeof body === "string" ? body : "";
    if (!text.trim()) return notSent(SMS_REASON.EMPTY_BODY);
    if (text.length > MAX_SMS_BODY_CHARS) return notSent(SMS_REASON.BODY_TOO_LONG);

    /* 4. The client, before authorization. Local and synchronous - see
          the header. Nothing here touches the network. The SDK
          constructor can still throw on an input the shape checks above
          did not anticipate, and this function's contract is to RETURN a
          refusal rather than reject: nothing has been sent, so nothing
          is ambiguous. */
    let client;
    try {
      client = clientFactory(config);
    } catch {
      return notSent(SMS_REASON.CLIENT_UNAVAILABLE);
    }

    /* 5. GATE 8. Fresh on every call. The decision is never cached, and
          `authorize` is the binding this sender was built with - there
          is no way to swap it afterwards. */
    let decision;
    try {
      decision = await authorize({ email, phone: to }, { env });
    } catch {
      /* Gate 8 is built to answer rather than throw, and to fail closed
         when a provider is unavailable. If it throws anyway that is a
         defect IN THE BOUNDARY, and a defect in the boundary is not
         permission. Discarded, not inspected: a thrown error can carry
         request metadata, including the destination number. */
      decision = null;
    }

    /* 6. */
    if (!decision || decision.allowed !== true) return notSent(SMS_REASON.NOT_AUTHORIZED);

    /* 7. THE SIDE EFFECT, IMMEDIATELY.
          Nothing may be inserted between step 6 and this call - no await,
          no logging round trip, no metric, no database write. The
          authorization above is only as good as its adjacency to this
          line.

          `messagingServiceSid` and never a `from` number: the registered
          Messaging Service owns sender selection and A2P routing, and
          this module deliberately offers no way to name an arbitrary
          sender. */
    let result;
    try {
      result = await client.messages.create({ to, body: text, messagingServiceSid: config.messagingServiceSid });
    } catch (err) {
      /* ONE ATTEMPT, and an honest report of what it proved. See THE
         FAILURE CLASSIFICATION above. The error itself is never
         surfaced - a Twilio error can carry request metadata, including
         the destination number - so only the classification escapes. */
      const rejected = providerRejection(err);
      if (rejected) return notSent(rejected);
      return { status: SMS_STATUS.UNKNOWN, reason: unconfirmedReason(err) };
    }

    /* A response that is not a message resource is not an acceptance. */
    let sid;
    try {
      sid = result && typeof result === "object" ? result.sid : null;
    } catch {
      sid = null;
    }
    if (typeof sid !== "string" || !MESSAGE_SID.test(sid))
      return { status: SMS_STATUS.UNKNOWN, reason: SMS_REASON.MALFORMED_PROVIDER_RESPONSE };

    return { status: SMS_STATUS.ACCEPTED, message_sid: sid };
  };
}

/**
 * THE production sender. Built once, at module load, over the real gate
 * 8 and the real Twilio client factory, both of which it closes over.
 * There is no setter, no module-level mutable binding it consults, and
 * therefore no way for any importer to replace gate 8 on this function.
 */
export const sendSms = makeSender({ authorize: authorizeSms, clientFactory: realClient });

/**
 * TEST ONLY. Builds an INDEPENDENT sender over injected boundaries.
 *
 * It cannot affect the exported `sendSms` above, which never looks its
 * boundaries up. `tools/check-sms-sender.mjs` fails the build if any
 * production module other than the designated acknowledgement orchestrator
 * imports this module, and if any module besides this one reaches Twilio's
 * message-create side effect directly.
 */
export function _senderForTest({ authorize, clientFactory } = {}) {
  return makeSender({ authorize, clientFactory });
}

/** PII-free diagnostics for the internal acknowledgement log line. Structure only:
 *  no number, no address, no body, no credential, no provider text. */
export function smsSendLogShape(result) {
  return {
    sms_status: result?.status ?? SMS_STATUS.NOT_SENT,
    ...(result?.reason ? { sms_reason: result.reason } : {}),
    ...(result?.message_sid ? { sms_message_sid: result.message_sid } : {}),
  };
}