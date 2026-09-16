/* The permission resolver — the ONLY place that answers "may we contact
   this person on this channel, at this number, right now".
   =====================================================================
   Nothing else may decide. A future Twilio module does not get a lead and
   work it out; a future Retell module does not read a consent flag and
   dial. They ask here, get { allowed, reason }, and obey it. One place to
   read, one place to audit, one place to get right.

   The resolver is PURE. It performs no I/O, reads no environment beyond
   what it is handed, and sends nothing. Gate 8 performs the required I/O
   first and hands the resolver two additional facts: whether the durable
   suppression lookup succeeded, and whether the current consent state was
   actually read. Provider failure is therefore data for THIS resolver,
   never a second permission decision beside it.

   PRECEDENCE, in this order, and the order is the compliance argument:

     1. FEATURE_DISABLED        nothing may go out while the feature is off
     2. durable lookup failure  no answer from the system of record = no send
     3. durable active block    ledger suppression/revocation outranks consent
     4. consent-read failure    no current permission state = no send
     5. GLOBAL_DNC              CRM projection still fails closed
     6. channel suppression     CRM projection still fails closed
     7. consent status          granted, or it is a no
     8. phone validity          a number we cannot dial is not a permission
     9. phone match             consent binds to the number it was given for

   The durable ledger is authoritative for suppression by phone. HubSpot's
   suppression properties remain a conservative operator-facing projection:
   if either source blocks, sending is refused. This union deliberately
   prefers a false negative (do not send) to communicating after an opt-out.
   ===================================================================== */

import { PERMISSION_STATE, consentFeatureEnabled } from "./consent.mjs";
import { normalizePhone } from "./validate.mjs";

const { GRANTED, REVOKED, SUPPRESSED, NEVER_GRANTED } = PERMISSION_STATE;

/** Stable machine tokens. Logged; never shown to a consumer. */
export const REASON = Object.freeze({
  ALLOWED: "ALLOWED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  SUPPRESSION_LOOKUP_UNAVAILABLE: "SUPPRESSION_LOOKUP_UNAVAILABLE",
  CONSENT_STATE_UNAVAILABLE: "CONSENT_STATE_UNAVAILABLE",
  DURABLE_SMS_BLOCK: "DURABLE_SMS_BLOCK",
  DURABLE_VOICE_BLOCK: "DURABLE_VOICE_BLOCK",
  DURABLE_GLOBAL_BLOCK: "DURABLE_GLOBAL_BLOCK",
  NO_CONSENT: "NO_CONSENT",
  CONSENT_REVOKED: "CONSENT_REVOKED",
  SMS_SUPPRESSED_STOP: "SMS_SUPPRESSED_STOP",
  VOICE_DNC: "VOICE_DNC",
  GLOBAL_DNC: "GLOBAL_DNC",
  CONSENT_PHONE_MISMATCH: "CONSENT_PHONE_MISMATCH",
  INVALID_PHONE: "INVALID_PHONE",
});

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: REASON.ALLOWED });

/** Digits only, so "(419) 555-1234" and "4195551234" compare equal. */
const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");

/** The same ten-digit floor api/_lib/validate.mjs enforces on input. */
const dialable = (v) => digits(normalizePhone(v)).length >= 10;

/** Two numbers are the same number if their digits match after the same
 *  normalisation the lead pipeline applies. */
const samePhone = (a, b) => {
  const x = digits(normalizePhone(a));
  const y = digits(normalizePhone(b));
  return x.length >= 10 && x === y;
};

/**
 * Interpret Gate 8's durable suppression result without trusting its shape.
 *
 * Absence means a pure caller is exercising the consent model without the
 * send-time I/O layer; existing transition tests intentionally do this. Once
 * Gate 8 supplies the field, however, malformed or unavailable state fails
 * closed. A successful lookup may contain only the three lanes db/003 can
 * return. Unknown data is not silently treated as "no blocks".
 */
function durableDecision(channel, durableSuppression) {
  if (durableSuppression == null) return null;
  if (durableSuppression.status !== "ok")
    return deny(REASON.SUPPRESSION_LOOKUP_UNAVAILABLE);
  if (!Array.isArray(durableSuppression.channels))
    return deny(REASON.SUPPRESSION_LOOKUP_UNAVAILABLE);

  const allowed = new Set(["sms", "ai_voice", "all"]);
  if (durableSuppression.channels.some((v) => !allowed.has(v)))
    return deny(REASON.SUPPRESSION_LOOKUP_UNAVAILABLE);

  const channels = new Set(durableSuppression.channels);
  if (channels.has("all")) return deny(REASON.DURABLE_GLOBAL_BLOCK);
  if (channel === "sms" && channels.has("sms"))
    return deny(REASON.DURABLE_SMS_BLOCK);
  if (channel === "ai_voice" && channels.has("ai_voice"))
    return deny(REASON.DURABLE_VOICE_BLOCK);
  return null;
}

/**
 * Resolve one channel.
 *
 * @param state    the contact's permission state
 * @param channel  "sms" | "ai_voice"
 * @param target   the number we would actually dial or text
 * @param opts     { env, durableSuppression, consentStateAvailable }
 */
function resolve(state, channel, target, {
  env = process.env,
  durableSuppression = null,
  consentStateAvailable = true,
} = {}) {
  if (!consentFeatureEnabled(env)) return deny(REASON.FEATURE_DISABLED);

  /* The durable phone-keyed ledger is the suppression authority. An outage
     cannot be interpreted as "not suppressed". If it did answer, an active
     block wins before any mutable CRM state is considered. */
  const durable = durableDecision(channel, durableSuppression);
  if (durable) return durable;

  /* Gate 8 distinguishes "HubSpot says no grant" from "we could not read
     HubSpot". Both refuse a send; only the latter says the dependency failed. */
  if (consentStateAvailable !== true)
    return deny(REASON.CONSENT_STATE_UNAVAILABLE);

  const s = state || {};
  const suppression = s.suppression || {};

  /* HubSpot suppression is a projection, never the source of truth, but it
     remains conservative: a stale true can only block, never authorize. */
  if (suppression.global) return deny(REASON.GLOBAL_DNC);
  if (channel === "sms" && suppression.sms) return deny(REASON.SMS_SUPPRESSED_STOP);
  if (channel === "ai_voice" && suppression.voice) return deny(REASON.VOICE_DNC);

  /* Consent status. Note the two different denials: never asked and declined
     are NO_CONSENT; withdrawn in words is CONSENT_REVOKED. */
  const ch = s[channel] || { status: NEVER_GRANTED };
  if (ch.status === REVOKED) return deny(REASON.CONSENT_REVOKED);
  if (ch.status === SUPPRESSED) {
    return deny(channel === "sms" ? REASON.SMS_SUPPRESSED_STOP : REASON.VOICE_DNC);
  }
  if (ch.status !== GRANTED) return deny(REASON.NO_CONSENT);

  /* The number. Consent was given for a specific line, with that number on
     the screen beside the disclosure. Permission never travels to a new line. */
  const dial = target != null && target !== "" ? target : ch.consent_phone;
  if (!dialable(dial)) return deny(REASON.INVALID_PHONE);
  if (!samePhone(dial, ch.consent_phone)) return deny(REASON.CONSENT_PHONE_MISMATCH);

  return allow();
}

/** May we text this contact at this number? */
export function canSendSms(state, target, opts) {
  return resolve(state, "sms", target, opts);
}

/** May we place an automated / AI-voice call to this contact at this number? */
export function canPlaceAutomatedVoiceCall(state, target, opts) {
  return resolve(state, "ai_voice", target, opts);
}

/* ---------------------------------------------------------------------
   SUPPRESSION
   ---------------------------------------------------------------------
   Recorded by an inbound webhook (a STOP reply, a spoken "do not call me
   again", or a manual operator entry). Pure and additive: it writes the
   suppression record and marks the channel status, and it never removes
   anything.

   Clearing a suppression is a separate, explicit, auditable transition.
   Where Twilio holds its own carrier-level opt-out, clearing our record alone
   would not make the message deliverable. See the unsuppression decision doc.
   --------------------------------------------------------------------- */
export const SUPPRESSION_SCOPE = Object.freeze({
  SMS: "sms",
  VOICE: "voice",
  GLOBAL: "global",
});

export function applySuppression(currentState, { scope, reason, at, source }) {
  const state = currentState || {};
  const record = { reason, at, source: source || "" };
  const next = { ...state, suppression: { ...(state.suppression || {}) } };

  if (scope === SUPPRESSION_SCOPE.GLOBAL) {
    next.suppression.global = record;
    next.suppression.sms = next.suppression.sms || record;
    next.suppression.voice = next.suppression.voice || record;
    next.sms = { ...(state.sms || {}), status: SUPPRESSED };
    next.ai_voice = { ...(state.ai_voice || {}), status: SUPPRESSED };
    return next;
  }
  if (scope === SUPPRESSION_SCOPE.SMS) {
    next.suppression.sms = record;
    next.sms = { ...(state.sms || {}), status: SUPPRESSED };
    return next;
  }
  if (scope === SUPPRESSION_SCOPE.VOICE) {
    next.suppression.voice = record;
    next.ai_voice = { ...(state.ai_voice || {}), status: SUPPRESSED };
    return next;
  }
  throw new Error("unknown suppression scope: " + scope);
}

/** A PII-free line for logs: the decision, never the number. */
export function decisionLogShape(channel, decision) {
  return { channel, allowed: decision.allowed, reason: decision.reason };
}
