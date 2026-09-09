/* HubSpot ⇄ consent current-state adapter.
   =====================================================================
   The ONLY place that knows the 23 `cst_*` HubSpot internal names, how to
   read them into the application's consent state, and how to turn an
   approved state transition back into properties.

   Nothing else may hard-code a `cst_` name. api/_lib/hubspot.mjs does the
   HTTP; api/_lib/consent.mjs owns the transition rules; this file is the
   translation layer between them, and it is pure — no fetch, no env
   reading beyond the feature gate, no side effects.

   TWO DIFFERENT THINGS, KEPT APART
   --------------------------------
   * CURRENT STATE — these mutable contact properties. What is true now.
     Overwritten as it changes. Not history.
   * EVIDENCE — the ten consent rows inside each HubSpot form-submission
     timeline activity. One dated snapshot per submission. That is the
     historical record, and it is written by the existing form submission,
     not by anything here.

   WHAT THIS PHASE DELIBERATELY DOES NOT WRITE
   -------------------------------------------
   The nine suppression properties. An ordinary website form submission has
   no business setting a STOP, a DNC or a global do-not-contact - those come
   from an inbound webhook or a human, and neither exists yet. They are READ
   so they can be respected, and never written. `SUPPRESSION_PROPERTIES`
   below exists so a test can assert exactly that.
   ===================================================================== */

import { PERMISSION_STATE, consentFeatureEnabled } from "./consent.mjs";

const { NEVER_GRANTED, GRANTED, REVOKED, SUPPRESSED } = PERMISSION_STATE;

/* ---------------------------------------------------------------------
   THE SCHEMA
   ---------------------------------------------------------------------
   Created in the production portal on 9 September 2026 and independently
   verified. These names are an EXTERNAL contract: renaming one here does
   not rename it in HubSpot, it just stops the integration finding it.
   --------------------------------------------------------------------- */
export const SMS_STATE_PROPERTIES = Object.freeze({
  status: "cst_sms_permission_status",
  at: "cst_sms_consent_at",
  phone: "cst_sms_consent_phone",
  source: "cst_sms_consent_source",
  page: "cst_sms_consent_page",
  version: "cst_sms_consent_copy_version",
});

export const AI_VOICE_STATE_PROPERTIES = Object.freeze({
  status: "cst_ai_voice_permission_status",
  at: "cst_ai_voice_consent_at",
  phone: "cst_ai_voice_consent_phone",
  source: "cst_ai_voice_consent_source",
  page: "cst_ai_voice_consent_page",
  version: "cst_ai_voice_consent_copy_version",
});

/** Read-only in this phase. Nothing here may appear in a write. */
export const SUPPRESSION_PROPERTIES = Object.freeze({
  smsSuppressed: "cst_sms_suppressed",
  smsSuppressedAt: "cst_sms_suppressed_at",
  smsSuppressionReason: "cst_sms_suppression_reason",
  doNotCall: "cst_do_not_call",
  doNotCallAt: "cst_do_not_call_at",
  doNotCallReason: "cst_do_not_call_reason",
  doNotContact: "cst_do_not_contact",
  doNotContactAt: "cst_do_not_contact_at",
  doNotContactReason: "cst_do_not_contact_reason",
});

export const REOPTIN_PROPERTIES = Object.freeze({
  at: "cst_reoptin_requested_at",
  channel: "cst_reoptin_requested_channel",
});

/** All 23, for the read request and for the schema-contract test. */
export const CONSENT_PROPERTIES = Object.freeze([
  ...Object.values(SMS_STATE_PROPERTIES),
  ...Object.values(AI_VOICE_STATE_PROPERTIES),
  ...Object.values(SUPPRESSION_PROPERTIES),
  ...Object.values(REOPTIN_PROPERTIES),
]);

/* The dropdown vocabularies HubSpot will actually accept. A value outside
   these sets is rejected by HubSpot with a 400, which fails the lead - so
   it is caught here instead, loudly, before the request is built. */
export const PERMISSION_STATUS_VALUES = Object.freeze(
  [NEVER_GRANTED, GRANTED, REVOKED, SUPPRESSED]);
export const REOPTIN_CHANNEL_VALUES = Object.freeze(["sms", "ai_voice", "both"]);

/* NOT USED FOR WRITING, and that is the point of writing them down.
   api/_lib/consent.mjs has its own internal SUPPRESSION_REASON constants
   (`voice_dnc`, `global_dnc`, `stop_keyword`, ...) which classify EVENTS.
   They are not this schema's vocabulary and several of them are not valid
   values for these dropdowns at all. When a future phase starts writing
   suppression, it must map internal classifications onto these lists
   explicitly - never pass an internal constant straight through. */
export const HUBSPOT_SUPPRESSION_VOCABULARY = Object.freeze({
  [SUPPRESSION_PROPERTIES.smsSuppressionReason]:
    ["stop_keyword", "natural_language", "manual", "carrier"],
  [SUPPRESSION_PROPERTIES.doNotCallReason]:
    ["voice_request", "natural_language", "manual"],
  [SUPPRESSION_PROPERTIES.doNotContactReason]:
    ["consumer_request", "manual"],
});

/* ---------------------------------------------------------------------
   FAILING CLOSED
   ---------------------------------------------------------------------
   Everything below refuses to guess. When HubSpot hands back consent state
   this code cannot truthfully interpret, the answer is not a default - it
   is an error that fails the HubSpot operation, because a manufactured
   conclusion about consent is indistinguishable from a real one once it is
   written to a contact.

   The errors are stable tokens and carry the PROPERTY name, never the
   value. A malformed value could be anything, up to and including someone
   else's phone number pasted into the wrong field, so it never reaches a
   log or an error message.
   --------------------------------------------------------------------- */

export class ConsentStateError extends Error {
  constructor(token, property) {
    super(property ? `${token}: ${property}` : token);
    this.name = "ConsentStateError";
    this.token = token;
    this.property = property || "";
    /* Never retried, never degraded to a warning: the caller has to fail. */
    this.consentStateInvalid = true;
  }
}

export const MALFORMED_RESPONSE = "HUBSPOT_CONSENT_STATE_MALFORMED_RESPONSE";
export const MALFORMED_VALUE = "HUBSPOT_CONSENT_STATE_MALFORMED_VALUE";
export const DATETIME_INVALID = "HUBSPOT_CONSENT_DATETIME_INVALID";
export const ENUM_REJECTED = "HUBSPOT_CONSENT_ENUM_REJECTED";

/**
 * A HubSpot response is only usable as consent state if it actually carried
 * a properties object.
 *
 * The failure this exists to stop: a 200 whose body has no `properties`, or
 * a null or array one, falling through `json?.properties || {}` into an
 * INVENTED empty consent state for a contact that may well be suppressed.
 * "HubSpot said nothing" and "HubSpot said this contact has never granted
 * anything" are different facts and must not share a representation.
 *
 * `stage` distinguishes the search hit from the 409 refetch, so a failure
 * says which read went wrong without carrying any of its content.
 */
export function requireConsentProperties(properties, stage) {
  if (properties === null || typeof properties !== "object" || Array.isArray(properties))
    throw new ConsentStateError(MALFORMED_RESPONSE, stage);
  return properties;
}

/* ---------------------------------------------------------------------
   SERIALISATION
   --------------------------------------------------------------------- */

/**
 * HubSpot datetime properties.
 *
 * The six `*_at` properties are genuine `datetime` properties (verified in
 * the portal), NOT date-only. HubSpot's CRM Properties documentation states
 * that a `datetime` property stores date AND time, that API values are UTC,
 * and that a value may be supplied either as an ISO-8601 string of the form
 * `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` or as UNIX epoch milliseconds. The
 * midnight-UTC constraint people run into applies to `date` properties,
 * which these are not.
 *
 * ISO-8601 is chosen deliberately over epoch ms: `meta.submitted_at` is
 * already exactly that string, so the property and the `SMS CONSENT AT` row
 * in the timeline evidence are byte-identical and can be compared without
 * converting anything. It is also readable in a log.
 *
 * THROWS on anything that is not a valid instant, blank included. These
 * timestamps are server-owned invariants, not decoration: a contact must
 * never end up carrying
 *
 *     cst_sms_permission_status = granted
 *     cst_sms_consent_at        = ""
 *
 * which is a grant with no record of when it was given - worse than no
 * grant at all, because it looks complete. Returning "" here made exactly
 * that write reachable.
 */
export function toHubSpotDateTime(value, property = "") {
  if (value !== 0 && !value) throw new ConsentStateError(DATETIME_INVALID, property);
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new ConsentStateError(DATETIME_INVALID, property);
  return d.toISOString();
}

/**
 * HubSpot booleans come back as the STRINGS "true"/"false", and sometimes as
 * real booleans. `Boolean("false")` is true, which would read a cleared
 * suppression as an active one - or worse, the reverse - so string
 * truthiness is never used.
 *
 * BLANK is false: an unset HubSpot boolean is genuinely "not suppressed",
 * and that is the overwhelmingly common case for a contact nobody has ever
 * sent a STOP for.
 *
 * ANYTHING ELSE NONBLANK THROWS. "banana", "yes", "1", `{}`, `[]` are not
 * ways of saying "not suppressed" - they are signs that this field does not
 * hold what this code believes it holds, and quietly reading them as false
 * would silently un-suppress a contact. The safe answer to "is this person
 * suppressed?" when the stored value is not comprehensible is to fail the
 * operation, not to answer no.
 */
export function parseHubSpotBoolean(value, property = "") {
  if (value === true) return true;
  if (value === false || value == null) return false;
  /* Before String(): `String([])` is "", which would have made an empty
     array read as an unset flag - i.e. as "not suppressed". Nothing that
     is not already a boolean or a string is a boolean. */
  if (typeof value !== "string") throw new ConsentStateError(MALFORMED_VALUE, property);
  const v = value.trim().toLowerCase();
  if (v === "") return false;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ConsentStateError(MALFORMED_VALUE, property);
}

/**
 * A recognised permission status. Blank is never_granted - a contact HubSpot
 * has simply never recorded a permission for.
 *
 * A NONBLANK value outside the vocabulary throws rather than normalising to
 * never_granted. The dangerous direction is real: a future status this code
 * does not know about, or a typo written by a workflow, would otherwise be
 * read as "never granted" and then overwritten by a fresh grant - erasing
 * whatever it actually meant. Malformed CRM state is a fault, not a default.
 */
function parseStatus(value, property) {
  if (value == null) return NEVER_GRANTED;
  /* Same trap as the booleans: `String([])` is "", and an empty array must
     not read as "no permission recorded". */
  if (typeof value !== "string") throw new ConsentStateError(MALFORMED_VALUE, property);
  const v = value.trim();
  if (v === "") return NEVER_GRANTED;
  if (PERMISSION_STATUS_VALUES.includes(v)) return v;
  throw new ConsentStateError(MALFORMED_VALUE, property);
}

const str = (v) => (v == null ? "" : String(v));

/* ---------------------------------------------------------------------
   READ
   --------------------------------------------------------------------- */

/**
 * Turn a HubSpot contact's properties into the state shape that
 * applySubmissionConsent(), canSendSms() and canPlaceAutomatedVoiceCall()
 * expect.
 *
 * SUPPRESSION ALWAYS WINS, and is read from BOTH directions:
 *
 *   * an explicit suppression flag (`cst_sms_suppressed`, `cst_do_not_call`,
 *     `cst_do_not_contact`), and
 *   * a status of `suppressed` on the channel.
 *
 * If a flag says suppressed while the status still says `granted` - a real
 * possibility, because a webhook could set the flag and a stale process
 * could leave the status behind - the CONSERVATIVE reading wins and the
 * channel is suppressed. The disagreement is interpreted, never repaired:
 * nothing here writes a correction back, because "self-healing" a
 * suppression conflict during an ordinary form submission is exactly how a
 * STOP would get quietly cleared.
 *
 * A global do-not-contact suppresses both channels.
 */
export function fromHubSpotConsentProperties(properties) {
  const p = properties || {};
  const S = SUPPRESSION_PROPERTIES;

  const globalDnc = parseHubSpotBoolean(p[S.doNotContact], S.doNotContact);
  const smsFlag = parseHubSpotBoolean(p[S.smsSuppressed], S.smsSuppressed);
  const voiceFlag = parseHubSpotBoolean(p[S.doNotCall], S.doNotCall);

  const suppression = {};
  if (globalDnc) {
    suppression.global = {
      reason: str(p[S.doNotContactReason]) || "consumer_request",
      at: str(p[S.doNotContactAt]),
    };
  }
  if (smsFlag || globalDnc) {
    suppression.sms = smsFlag
      ? { reason: str(p[S.smsSuppressionReason]) || "manual", at: str(p[S.smsSuppressedAt]) }
      : suppression.global;
  }
  if (voiceFlag || globalDnc) {
    suppression.voice = voiceFlag
      ? { reason: str(p[S.doNotCallReason]) || "manual", at: str(p[S.doNotCallAt]) }
      : suppression.global;
  }

  const channel = (props, suppressed) => {
    const status = parseStatus(p[props.status], props.status);
    return {
      /* The conservative reading. A flag beats a status, in one direction
         only: it can make a channel suppressed, never un-suppress one. */
      status: suppressed ? SUPPRESSED : status,
      consent_at: str(p[props.at]),
      consent_phone: str(p[props.phone]),
      consent_source: str(p[props.source]),
      consent_page: str(p[props.page]),
      consent_version: str(p[props.version]),
    };
  };

  return {
    sms: channel(SMS_STATE_PROPERTIES, smsFlag || globalDnc),
    ai_voice: channel(AI_VOICE_STATE_PROPERTIES, voiceFlag || globalDnc),
    suppression,
    reoptin: {
      at: str(p[REOPTIN_PROPERTIES.at]),
      channel: str(p[REOPTIN_PROPERTIES.channel]),
    },
  };
}

/** The state of a contact HubSpot has never seen. Everything never_granted,
 *  nothing suppressed - and reached ONLY when there is genuinely no contact,
 *  never as a stand-in for "we did not look". */
export function emptyConsentState() {
  return fromHubSpotConsentProperties({});
}

/* ---------------------------------------------------------------------
   WRITE
   --------------------------------------------------------------------- */

/**
 * The narrow, pure enum validator.
 *
 * Exported so the guard can be exercised directly. It deliberately replaces
 * an earlier `opts.forceStatus` seam on toHubSpotConsentProperties(): that
 * seam existed only so a test could push an invalid status through, and a
 * production caller could have used it to override the transition result.
 * A parameter that lets a caller name the permission status is not something
 * consent-writing code should own, whatever the comment above it says.
 *
 * The value is NOT included in the message - a malformed enum arriving from
 * a CRM field could be arbitrary text.
 */
export function assertConsentEnum(property, value, allowed) {
  if (!allowed.includes(value)) throw new ConsentStateError(ENUM_REJECTED, property);
  return value;
}

/**
 * The MINIMAL set of properties this submission needs to change.
 *
 * `nextState` is the output of applySubmissionConsent(), which already
 * decided what may change; this only translates. It never re-derives a
 * transition rule, and it never emits a property whose value did not move.
 *
 * Rules, in the order they matter:
 *
 *   1. Only a channel that actually became `granted` on THIS submission is
 *      written. `applySubmissionConsent` marks that with `changed: true`.
 *      An unticked box produces no change, so nothing is written and a
 *      previous consent cannot be blanked by a later silent submission.
 *   2. The two channels are independent. SMS becoming granted never emits an
 *      AI-voice property, and vice versa.
 *   3. A pending re-opt-in writes ONLY the two re-opt-in properties. It does
 *      not grant, and it does not touch a suppression.
 *   4. No suppression property is ever emitted. Not one, in any path.
 */
export function toHubSpotConsentProperties(nextState, evidence) {
  const props = {};
  if (!nextState) return props;

  const write = (channelState, channelEvidence, map) => {
    if (!channelState || channelState.changed !== true) return;
    /* GRANTED is the only status this function can write, and it is a
       literal - there is no parameter, and no branch, that can make it
       anything else. The guard stays because the constant and the HubSpot
       dropdown are two separate things that must not drift apart. */
    props[map.status] = assertConsentEnum(map.status, GRANTED, PERMISSION_STATUS_VALUES);
    /* Throws rather than writing a grant with a blank timestamp. Ordering
       matters only in that nothing is sent at all if it throws: the props
       object is discarded with the request that was being built. */
    props[map.at] = toHubSpotDateTime(
      channelState.consent_at || channelEvidence?.captured_at, map.at);
    props[map.phone] = str(channelState.consent_phone || channelEvidence?.phone);
    props[map.source] = str(channelState.consent_source || evidence?.form_type);
    props[map.page] = str(channelState.consent_page || evidence?.source_page);
    props[map.version] = str(channelState.consent_version || channelEvidence?.version);
  };

  write(nextState.sms, evidence?.sms, SMS_STATE_PROPERTIES);
  write(nextState.ai_voice, evidence?.ai_voice, AI_VOICE_STATE_PROPERTIES);

  /* The re-opt-in request. Recorded so a human or a future workflow can act
     on it; it grants nothing and clears nothing on its own. These two are
     mutable current state - the LATEST pending request - not history. The
     history is the timeline activity. */
  const pending = [];
  if (nextState.sms?.outcome === "pending_reoptin") pending.push("sms");
  if (nextState.ai_voice?.outcome === "pending_reoptin") pending.push("ai_voice");
  if (pending.length) {
    const channel = pending.length === 2 ? "both" : pending[0];
    props[REOPTIN_PROPERTIES.channel] =
      assertConsentEnum(REOPTIN_PROPERTIES.channel, channel, REOPTIN_CHANNEL_VALUES);
    props[REOPTIN_PROPERTIES.at] = toHubSpotDateTime(
      nextState.sms?.pending_reoptin?.requested_at ||
      nextState.ai_voice?.pending_reoptin?.requested_at ||
      evidence?.captured_at, REOPTIN_PROPERTIES.at);
  }

  return props;
}

/* ---------------------------------------------------------------------
   THE GATE
   ---------------------------------------------------------------------
   With the feature off, api/_lib/hubspot.mjs must not ask HubSpot for these
   properties and must not write one. Both halves consult this, so "off"
   cannot mean "off for reads but on for writes".
   --------------------------------------------------------------------- */
export function consentStateEnabled(env = process.env) {
  return consentFeatureEnabled(env);
}

/** The properties to request on a contact read, or [] while the feature is
 *  off - in which case the HubSpot request is byte-identical to today's. */
export function consentPropertiesToRead(env = process.env) {
  return consentStateEnabled(env) ? [...CONSENT_PROPERTIES] : [];
}

/** A PII-free log shape: what changed, never a number or a name. */
export function consentWriteLogShape(props) {
  const names = Object.keys(props || {});
  return {
    consent_properties_written: names.length,
    sms_state_written: names.includes(SMS_STATE_PROPERTIES.status),
    ai_voice_state_written: names.includes(AI_VOICE_STATE_PROPERTIES.status),
    reoptin_requested: names.includes(REOPTIN_PROPERTIES.channel),
  };
}
