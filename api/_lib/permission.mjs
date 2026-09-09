/* The permission resolver — the ONLY place that answers "may we contact
   this person on this channel, at this number, right now".
   =====================================================================
   Nothing else may decide. A future Twilio module does not get a lead and
   work it out; a future Retell module does not read a consent flag and
   dial. They ask here, get { allowed, reason }, and obey it. One place to
   read, one place to audit, one place to get right.

   The resolver is PURE. It performs no I/O, reads no environment beyond
   what it is handed, and sends nothing. It is given a contact's permission
   state - the thing a future integration will have read from HubSpot - and
   returns a decision.

   PRECEDENCE, in this order, and the order is the compliance argument:

     1. FEATURE_DISABLED   nothing may go out while the feature is off
     2. GLOBAL_DNC         "do not contact me" outranks everything
     3. channel suppression a STOP or a DNC outranks any consent record
     4. consent status     granted, or it is a no
     5. phone validity     a number we cannot dial is not a permission
     6. phone match        consent binds to the number it was given for

   Suppression is checked BEFORE consent deliberately. A contact whose
   status still reads `granted` because a form was submitted after a STOP
   must still be refused; putting consent first would make the resolver
   agree with the most recent form rather than with the consumer.
   ===================================================================== */

import { PERMISSION_STATE, consentFeatureEnabled } from "./consent.mjs";
import { normalizePhone } from "./validate.mjs";

const { GRANTED, REVOKED, SUPPRESSED, NEVER_GRANTED } = PERMISSION_STATE;

/** Stable machine tokens. Logged; never shown to a consumer. */
export const REASON = Object.freeze({
  ALLOWED: "ALLOWED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
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
 * Resolve one channel.
 *
 * @param state    the contact's permission state
 * @param channel  "sms" | "ai_voice"
 * @param target   the number we would actually dial or text
 * @param opts     { env } - environment for the feature gate
 */
function resolve(state, channel, target, { env = process.env } = {}) {
  if (!consentFeatureEnabled(env)) return deny(REASON.FEATURE_DISABLED);

  const s = state || {};
  const suppression = s.suppression || {};

  /* 2. Global first. "Do not contact me again" is not a channel
        preference, and no per-channel consent survives it. */
  if (suppression.global) return deny(REASON.GLOBAL_DNC);

  /* 3. Channel suppression. Separate records, separate effects: an SMS
        STOP does not imply a voice DNC, and a voice DNC does not imply an
        SMS STOP. Only an explicit global record stops both. */
  if (channel === "sms" && suppression.sms) return deny(REASON.SMS_SUPPRESSED_STOP);
  if (channel === "ai_voice" && suppression.voice) return deny(REASON.VOICE_DNC);

  /* 4. Consent status. Note the two different denials: never asked and
        declined are NO_CONSENT; withdrawn in words is CONSENT_REVOKED.
        They read the same to a sender and completely differently to
        whoever has to explain the record later. */
  const ch = s[channel] || { status: NEVER_GRANTED };
  if (ch.status === REVOKED) return deny(REASON.CONSENT_REVOKED);
  if (ch.status === SUPPRESSED) {
    return deny(channel === "sms" ? REASON.SMS_SUPPRESSED_STOP : REASON.VOICE_DNC);
  }
  if (ch.status !== GRANTED) return deny(REASON.NO_CONSENT);

  /* 5/6. The number. Consent was given for a specific line, with that
          number on the screen beside the disclosure. If the contact's
          number has since changed, the old permission does not travel to
          the new one - that would be contacting someone who never agreed,
          possibly a stranger who inherited the number. */
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
   Recorded by a future inbound webhook (a STOP reply, a spoken "do not
   call me again", a manual entry). Pure and additive: it writes the
   suppression record and marks the channel status, and it never removes
   anything.

   Clearing a suppression is deliberately NOT implemented here. A
   re-opt-in is a separate, explicit, auditable transition - and where
   Twilio holds its own carrier-level opt-out for a number, clearing our
   record alone would not make the message deliverable anyway. See
   docs/updates/2026-09-09-communications-consent-foundation.md.
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
