/* The outbound SMS sender — DARK. Nothing calls this.
   =====================================================================
   The first component in this repository that can cause an external
   messaging side effect. It is deliberately unreachable: no endpoint
   imports it, no orchestrator exists, and `tools/check.mjs` fails the
   build if anything under `api/` other than this file calls the Twilio
   message-create API.

   WHAT THIS MODULE IS. A transport. It is handed a message that has
   already been decided elsewhere and it either sends that exact message
   to that exact number or refuses. It composes nothing, templates
   nothing, and decides no marketing content.

   THE ORDER IS THE WHOLE POINT:

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

   THE ALLOWED VALUE NEVER LEAVES THIS FRAME. It is not returned, not
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
   Durable orchestration belongs to the layer above, which does not
   exist yet.

   Accordingly the result distinguishes three states and never collapses
   them: definitely not sent, confirmed accepted, and unconfirmed.

   AND IT NEVER REJECTS. Every path returns a result, including the ones
   where a dependency threw. A throw before the provider call is always a
   refusal; only the provider call itself can produce "unconfirmed".
   ===================================================================== */

import twilio from "twilio";

import { toE164 } from "./consent-ledger.mjs";
import { authorizeSms } from "./send-permission.mjs";

/* ---------------------------------------------------------------------
   CONFIGURATION
   ---------------------------------------------------------------------
   Deliberately NOT TWILIO_AUTH_TOKEN. That variable is the INBOUND
   signature-verification credential used by api/_lib/twilio.mjs, and it
   is the account's master secret. Outbound uses a scoped API Key, so a
   leak of one does not hand over the other and either can be rotated
   alone. The installed SDK (twilio 6.1.0) takes the key pair
   positionally with the account named in opts:

       twilio(apiKeySid, apiKeySecret, { accountSid })

   verified against node_modules/twilio/lib/index.d.ts, not from memory.
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

/* Twilio resource SIDs are a two-letter prefix and 32 hex characters.
   Checked because a structurally impossible SID is a configuration
   mistake we can catch locally, before spending a provider round trip
   and before any chance of sending on the wrong account. */
const sidShape = (prefix) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);
const ACCOUNT_SID = sidShape("AC");
const API_KEY_SID = sidShape("SK");
const MESSAGING_SERVICE_SID = sidShape("MG");

/** Stable, PII-free tokens. Safe to log and safe to return. */
export const SMS_STATUS = Object.freeze({
  NOT_SENT: "not_sent",
  ACCEPTED: "accepted",
  UNKNOWN: "unknown",
});

export const SMS_REASON = Object.freeze({
  DISABLED: "OUTBOUND_SMS_DISABLED",
  NOT_CONFIGURED: "TWILIO_OUTBOUND_NOT_CONFIGURED",
  CONFIG_MALFORMED: "TWILIO_OUTBOUND_CONFIG_MALFORMED",
  INVALID_TARGET: "INVALID_TARGET",
  EMPTY_BODY: "EMPTY_BODY",
  BODY_TOO_LONG: "BODY_TOO_LONG",
  CLIENT_UNAVAILABLE: "TWILIO_CLIENT_UNAVAILABLE",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  SEND_UNCONFIRMED: "TWILIO_SEND_UNCONFIRMED",
  MALFORMED_PROVIDER_RESPONSE: "TWILIO_MALFORMED_RESPONSE",
});

/** Exactly the string "true", the same discipline as the consent flag.
 *  A switch that turns outbound messaging on through a typo is worse
 *  than one that needs the word spelled out. */
export function outboundSmsEnabled(env = process.env) {
  return env[OUTBOUND_SMS_FLAG] === "true";
}

/** Present AND structurally plausible. Returns null when unusable, so a
 *  caller cannot mistake a partially-configured account for a working
 *  one. Never returns or logs a secret. */
export function outboundConfig(env = process.env) {
  const accountSid = String(env[TWILIO_ACCOUNT_SID_VAR] || "").trim();
  const apiKeySid = String(env[TWILIO_API_KEY_SID_VAR] || "").trim();
  const apiKeySecret = String(env[TWILIO_API_KEY_SECRET_VAR] || "").trim();
  const messagingServiceSid = String(env[TWILIO_MESSAGING_SERVICE_SID_VAR] || "").trim();

  if (!accountSid || !apiKeySid || !apiKeySecret || !messagingServiceSid)
    return { ok: false, reason: SMS_REASON.NOT_CONFIGURED };

  if (!ACCOUNT_SID.test(accountSid) ||
      !API_KEY_SID.test(apiKeySid) ||
      !MESSAGING_SERVICE_SID.test(messagingServiceSid))
    return { ok: false, reason: SMS_REASON.CONFIG_MALFORMED };

  return { ok: true, accountSid, apiKeySid, apiKeySecret, messagingServiceSid };
}

/* The provider boundary, isolated so a test can replace it without
   replacing the sender's control flow. Production builds a real client;
   the tests inject a double and the ordering, validation and result
   handling under test are the real ones. */
function realClient({ accountSid, apiKeySid, apiKeySecret }) {
  /* autoRetry is false by default in twilio 6.1.0 and, when enabled,
     retries only 429 responses - verified in
     node_modules/twilio/lib/base/RequestClient.js. It is set explicitly
     anyway: this module's one-attempt promise should not rest on a
     library default that a future upgrade could change. */
  return twilio(apiKeySid, apiKeySecret, { accountSid, autoRetry: false });
}

let clientFactory = realClient;
let authorize = authorizeSms;

/** Test seams. Never called by production code. */
export function _setClientFactory(fn) { clientFactory = fn; }
export function _resetClientFactory() { clientFactory = realClient; }
export function _setAuthorizer(fn) { authorize = fn; }
export function _resetAuthorizer() { authorize = authorizeSms; }

const notSent = (reason) => ({ status: SMS_STATUS.NOT_SENT, reason });

/**
 * Send one SMS, or refuse.
 *
 * @param {object}  message
 * @param {string}  message.email  selects the HubSpot contact carrying consent
 * @param {string}  message.phone  the ACTUAL target; gate 8 authorizes this number
 * @param {string}  message.body   the already-approved text to send
 * @returns {Promise<{status: string, reason?: string, message_sid?: string}>}
 *
 * NEVER REJECTS. Every path returns a result object, including the ones
 * where a dependency threw: a caller that has to remember a try/catch to
 * avoid a 500 is a caller that will one day forget. A throw before the
 * provider call is always a refusal, never an allowance.
 *
 * The result carries no phone, email, body, credential or provider
 * exception text. `message_sid` is a Twilio resource identifier, not
 * consumer data, and is the only way a later reconciliation can find the
 * message this call created.
 */
export async function sendSms({ email, phone, body } = {}, { env = process.env } = {}) {
  /* 1. The gate. Checked first because a disabled system should cost
        nothing: no client, no configuration read of consequence, and
        above all no gate 8 call, which would otherwise reach HubSpot and
        Neon for a message that can never be sent. */
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

  /* 4. The client, before authorization. Local and synchronous - see the
        header. Nothing here touches the network. The SDK constructor can
        still throw on an input the shape checks above did not anticipate,
        and this function's contract is to RETURN a refusal rather than
        reject - nothing has been sent, so nothing is ambiguous. */
  let client;
  try {
    client = clientFactory(config);
  } catch {
    return notSent(SMS_REASON.CLIENT_UNAVAILABLE);
  }

  /* 5. GATE 8. Fresh on every call. The decision is never cached. */
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
        Messaging Service owns sender selection and A2P routing, and this
        module deliberately offers no way to name an arbitrary sender. */
  let result;
  try {
    result = await client.messages.create({ to, body: text, messagingServiceSid: config.messagingServiceSid });
  } catch {
    /* ONE ATTEMPT. The provider call was made and we do not know what
       happened to it - Twilio may have accepted and queued the message
       before the failure. Reporting "not sent" here would be a claim we
       cannot support, and retrying would risk a duplicate. The exception
       is swallowed rather than surfaced because a Twilio error can carry
       request metadata, including the destination number. */
    return { status: SMS_STATUS.UNKNOWN, reason: SMS_REASON.SEND_UNCONFIRMED };
  }

  /* A response that is not a message resource is not an acceptance. */
  const sid = result && typeof result === "object" ? result.sid : null;
  if (typeof sid !== "string" || !/^(?:SM|MM)[0-9a-fA-F]{32}$/.test(sid))
    return { status: SMS_STATUS.UNKNOWN, reason: SMS_REASON.MALFORMED_PROVIDER_RESPONSE };

  return { status: SMS_STATUS.ACCEPTED, message_sid: sid };
}

/** PII-free diagnostics for a future sender's log line. Structure only:
 *  no number, no address, no body, no credential, no provider text. */
export function smsSendLogShape(result) {
  return {
    sms_status: result?.status ?? SMS_STATUS.NOT_SENT,
    ...(result?.reason ? { sms_reason: result.reason } : {}),
    ...(result?.message_sid ? { sms_message_sid: result.message_sid } : {}),
  };
}
