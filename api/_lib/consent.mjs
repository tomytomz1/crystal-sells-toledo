/* Communications consent — the canonical, server-owned source of truth.
   =====================================================================
   Two SEPARATE permissions, never one:

     * SMS            — text messages about the enquiry
     * AI voice       — calls placed with automated/AI-generated voice

   Granting one never grants the other. Revoking one never revokes the
   other. They have their own copy, their own version, their own state and
   their own suppression.

   THE TRUST BOUNDARY
   ------------------
   The browser may say only what the visitor ticked:

       { "sms_consent": true, "ai_voice_consent": false }

   Everything that gives that meaning is attached HERE, on the server: the
   timestamp, the version, the exact disclosure the visitor was shown, the
   phone number it binds to, the form type, the page and the submission id.
   A client cannot forge a stronger consent than the one it displayed,
   because it does not get to say what it displayed.

   WHAT THIS MODULE IS NOT
   -----------------------
   It does not send anything. It does not decide whether a message may go
   out - that is api/_lib/permission.mjs, which is the only place that
   question is answered. Capturing consent and being allowed to use it are
   different questions, and a later STOP makes them different answers.
   ===================================================================== */

/* ---------------------------------------------------------------------
   FEATURE GATE
   ---------------------------------------------------------------------
   One environment variable, read in two places: tools/build.mjs at build
   time (does the checkbox render? does /communications-terms exist?) and
   this module at runtime (is a consent payload accepted?). Vercel exposes
   the same variable to both, so they cannot disagree within a deployment.

   It is NOT a secret and carries no credential - it is a boolean that says
   whether a feature is on.

   Default OFF, and the default is what production runs until a human turns
   it on. Showing a visitor a consent checkbox the backend is not yet
   configured to preserve would be a promise the site cannot keep.
   --------------------------------------------------------------------- */
export const FEATURE_FLAG = "COMMUNICATIONS_CONSENT_ENABLED";

/** Exactly the string "true" enables it. Anything else - absent, "1",
 *  "yes", "TRUE " - leaves it off. A feature that turns itself on through
 *  a typo is worse than one that needs the word spelled out. */
export function consentFeatureEnabled(env = process.env) {
  return env[FEATURE_FLAG] === "true";
}

/* ---------------------------------------------------------------------
   THE DISCLOSURES
   ---------------------------------------------------------------------
   `text` is canonical: it is what gets recorded as the exact wording the
   visitor agreed to, and it must equal what the page actually displayed.

   `html` is the same sentence with two link phrases wrapped in anchors.
   Stripping the tags from `html` must reproduce `text` character for
   character - assertConsentCopyIntact() below checks it, tools/check.mjs
   calls that at build time, and tools/build.mjs renders the page from
   `html`. That is the whole anti-drift mechanism: one string, one
   derivation, one assertion.

   Changing a word means minting a NEW version constant. Never edit the
   text of an existing version - contacts already carry it as the thing
   they agreed to, and rewriting it retroactively falsifies their record.
   --------------------------------------------------------------------- */
/* target="_blank" so reading the policy never discards a part-filled form;
   rel="noopener" because a new tab with a window.opener handle is a
   needless hazard. Neither attribute survives stripTags(), so the drift
   assertion still compares like with like. */
const PRIVACY_LINK =
  '<a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>';
const TERMS_LINK =
  '<a href="/communications-terms" target="_blank" rel="noopener">Communications Terms</a>';

export const SMS_CONSENT = Object.freeze({
  channel: "sms",
  version: "CST_SMS_CONSENT_2026_09_V1",
  text:
    "I agree to receive text messages from Crystal Sells Toledo about my real estate " +
    "inquiry, appointments, requested information, and related services. Message " +
    "frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP " +
    "for help. Consent is not a condition of service. See the Privacy Policy and " +
    "Communications Terms.",
  html:
    "I agree to receive text messages from Crystal Sells Toledo about my real estate " +
    "inquiry, appointments, requested information, and related services. Message " +
    "frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP " +
    "for help. Consent is not a condition of service. See the " + PRIVACY_LINK +
    " and " + TERMS_LINK + ".",
});

export const AI_VOICE_CONSENT = Object.freeze({
  channel: "ai_voice",
  version: "CST_AI_VOICE_CONSENT_2026_09_V1",
  text:
    "I agree to receive calls from Crystal Sells Toledo at the number I provided, " +
    "including calls using automated technology and an artificial, prerecorded, or " +
    "AI-generated voice, about my real estate inquiry, appointments, and requested " +
    "services. Consent is not a condition of service. See the Privacy Policy and " +
    "Communications Terms.",
  html:
    "I agree to receive calls from Crystal Sells Toledo at the number I provided, " +
    "including calls using automated technology and an artificial, prerecorded, or " +
    "AI-generated voice, about my real estate inquiry, appointments, and requested " +
    "services. Consent is not a condition of service. See the " + PRIVACY_LINK +
    " and " + TERMS_LINK + ".",
});

export const DISCLOSURES = Object.freeze([SMS_CONSENT, AI_VOICE_CONSENT]);

/** The client field name for each channel. Also the checkbox `name`. */
export const CONSENT_FIELDS = Object.freeze({ sms: "sms_consent", ai_voice: "ai_voice_consent" });

/** Strip tags for the drift assertion. Deliberately naive - the only
 *  markup allowed in a disclosure is the two anchors. */
const stripTags = (html) => html.replace(/<[^>]+>/g, "");

/**
 * The copy invariant. Throws rather than returning false: a build that
 * displays different words from the ones it records is not a build worth
 * shipping, and a silent boolean would be easy to ignore.
 */
export function assertConsentCopyIntact() {
  for (const d of DISCLOSURES) {
    if (stripTags(d.html) !== d.text)
      throw new Error(
        `consent copy drift in ${d.version}: the HTML shown to the visitor does not ` +
        "reduce to the canonical text recorded as their consent");
    for (const required of ["/privacy", "/communications-terms"])
      if (!d.html.includes(`href="${required}"`))
        throw new Error(`${d.version} disclosure is missing its ${required} link`);
    if (!/Consent is not a condition of service\./.test(d.text))
      throw new Error(`${d.version} no longer says consent is not a condition of service`);
  }
  if (!/Reply STOP to opt out or HELP for help\./.test(SMS_CONSENT.text))
    throw new Error("the SMS disclosure no longer carries the STOP/HELP instruction");
  if (!/artificial, prerecorded, or AI-generated voice/.test(AI_VOICE_CONSENT.text))
    throw new Error("the voice disclosure no longer discloses an artificial or AI voice");
  return true;
}

/* ---------------------------------------------------------------------
   READING WHAT THE BROWSER SENT
   ---------------------------------------------------------------------
   Deliberately the narrowest possible reader: a JSON boolean `true`, and
   nothing else. The client contract (assets/js/main.js) reads
   `input.checked`, which is already a real boolean, so there is no honest
   reason for "yes", "on", "1", [true] or { granted: true } to arrive - and
   every one of those is what a forged request looks like.

   Absent means false. Declining and never being asked both mean "no
   consent was granted on this submission"; neither is a revocation, and
   applySubmissionConsent() below is where that distinction is kept.
   --------------------------------------------------------------------- */
export function parseConsentFlag(raw) {
  return raw === true;
}

/* ---------------------------------------------------------------------
   PERMISSION STATE
   ---------------------------------------------------------------------
   Four states, because `false` was being asked to mean four different
   things - never asked, declined, revoked by the consumer, and suppressed
   by a STOP - and only one of those may ever be cleared by a visitor
   ticking a box again.
   --------------------------------------------------------------------- */
export const PERMISSION_STATE = Object.freeze({
  NEVER_GRANTED: "never_granted",
  GRANTED: "granted",
  REVOKED: "revoked",     // the consumer withdrew it in words
  SUPPRESSED: "suppressed", // a STOP / DNC keyword or carrier-level opt-out
});

/** Why a channel was suppressed. Recorded, never inferred. */
export const SUPPRESSION_REASON = Object.freeze({
  STOP_KEYWORD: "stop_keyword",
  VOICE_DNC: "voice_dnc",
  GLOBAL_DNC: "global_dnc",
  MANUAL: "manual",
  CARRIER: "carrier",
});

/* ---------------------------------------------------------------------
   EVIDENCE
   ---------------------------------------------------------------------
   One snapshot per submission. It is the answer to "what exactly did this
   person agree to, when, on which page, for which number" and it is built
   only from validated server-side values.

   Note what is NOT here: the submitter's IP address. The privacy notice
   says IPs are held in memory for rate limiting and are not added to
   contact records, and adding consent is not a reason to start collecting
   more PII than the notice describes. The submission id, server timestamp,
   page and normalised phone identify the event without it.
   --------------------------------------------------------------------- */
function channelEvidence(disclosure, granted, phone, capturedAt) {
  return {
    channel: disclosure.channel,
    granted,
    version: disclosure.version,
    /* The exact words, stored whether or not the box was ticked: "declined
       THIS disclosure" is only meaningful if you know which one it was. */
    exact_text: disclosure.text,
    /* Consent binds to the number that was on screen with it. If the
       contact's number changes later, this one no longer matches and
       permission.mjs refuses - see CONSENT_PHONE_MISMATCH. */
    phone: granted ? phone : "",
    captured_at: granted ? capturedAt : "",
  };
}

/**
 * Build the consent evidence for one validated submission.
 *
 * Takes the already-validated payload, so the phone is normalised, the
 * form type is known-good and the timestamp is the server's.
 */
export function buildConsentEvidence(payload) {
  const { lead, meta } = payload;
  const capturedAt = meta.submitted_at;
  const phone = lead.phone || "";
  return {
    sms: channelEvidence(SMS_CONSENT, lead.sms_consent === true, phone, capturedAt),
    ai_voice: channelEvidence(AI_VOICE_CONSENT, lead.ai_voice_consent === true, phone, capturedAt),
    form_type: lead.form_type,
    source_page: meta.page || "",
    submission_id: meta.submission_id || "",
    captured_at: capturedAt,
    /* The number the consent DECISION was made about, present whether or
       not a box was ticked - unlike the per-channel `phone`, which is
       blank when nothing was granted because it records what a grant binds
       to. The ledger needs the number on a "not selected" event too: an
       event that does not say which line it concerns proves nothing about
       that line. Nothing else reads this; the timeline rows and the `cst_*`
       properties still take the per-channel value. */
    phone,
    /* DENY BY DEFAULT.
       Set true by api/lead.js, and only after the append-only consent
       ledger has confirmed this submission's events. api/_lib/hubspot.mjs
       writes a `cst_*` grant only when it is true, so a future refactor
       that forgets to set it withholds a permission rather than granting
       one with no durable evidence behind it - which is the single outcome
       the ledger exists to prevent.
       See docs/updates/2026-09-09-consent-evidence-ledger.md. */
    durable: false,
  };
}

/**
 * The rows appended to the enquiry block written to HubSpot.
 *
 * This is the best evidence the integration can produce TODAY, with the
 * scopes it already has. Each website submission produces its own native
 * HubSpot form-submission timeline activity carrying this block, so
 * records accumulate: building a later submission's payload never reads or
 * rewrites an earlier one.
 *
 * Both the version AND the exact wording are stored. A version identifier
 * alone only answers "what did they agree to" for someone holding the
 * revision of this file that was deployed on the day; the text answers it
 * from the CRM, on its own, years later.
 *
 * It is NOT the contact's `message` property, which the short summary
 * overwrites on every submission. And it is NOT proven immutable: a
 * timeline activity cannot be edited through the public API, which is a
 * narrower claim than "cannot be altered or deleted". Whether the portal
 * retains these for as long as an audit needs is a live question nobody
 * has answered yet - see docs/updates/2026-09-09-hubspot-consent-setup.md
 * section 6a. Do not describe this as an immutable audit trail.
 */
export function consentRows(evidence) {
  const state = (c) => (c.granted ? "GRANTED" : "NOT GRANTED");
  return [
    /* FIRST, not last, and deliberately so.
       This row qualifies every claim below it. An operator who reads
       "SMS CONSENT: GRANTED" before reaching the caveat has already formed
       the belief the caveat exists to prevent, so the caveat goes above
       the claim.

       Why the row exists at all: when the ledger append fails, this block
       is still written (losing the record that someone ticked a box is the
       opposite of what an evidence system should do when its evidence sink
       is down) but NO `cst_*` grant is - so the activity can say
       "SMS CONSENT: GRANTED" while the contact correctly reads
       `never_granted`. Read cold that looks like the integration dropped a
       consent. This row explains it without anyone reading a log.

       Binary on purpose. A missing CONSENT_LEDGER_URL, a timeout, a
       refused E.164 conversion and a rejected INSERT all read NOT
       RECORDED; WHICH one is in the `lead.consent.ledger_failed` log line,
       where someone diagnosing an outage is already looking. An operator
       reading a contact needs to know whether the evidence is durable, not
       why it is not.

       `=== true`, not a truthy test: a missing marker, an undefined, or an
       evidence object built by some future path that never heard of the
       ledger all render NOT RECORDED. Both values are non-empty strings,
       so buildDescription()'s blank substitution can never turn this row
       into "CONSENT LEDGER: -", which would be worse than either. */
    ["CONSENT LEDGER", evidence.durable === true ? "RECORDED" : "NOT RECORDED"],
    ["SMS CONSENT", state(evidence.sms)],
    ["SMS CONSENT VERSION", evidence.sms.version],
    /* The disclosure itself, not just its identifier.
       A version string only answers "what did they agree to" if someone
       still has the source tree that defines it, and can find the revision
       that was deployed on the day. Two years and several rewordings from
       now, the row below answers the question on its own - which is the
       entire point of keeping evidence rather than a pointer to evidence.
       Both are stored: the version to compare records against each other,
       the text to read.
       Server-owned. api/_lib/validate.mjs never copies a disclosure out of
       the request, so a client cannot substitute its own wording here. */
    ["SMS CONSENT TEXT", evidence.sms.exact_text],
    ["SMS CONSENT AT", evidence.sms.captured_at],
    ["SMS CONSENT PHONE", evidence.sms.phone],
    ["AI VOICE CONSENT", state(evidence.ai_voice)],
    ["AI VOICE CONSENT VERSION", evidence.ai_voice.version],
    ["AI VOICE CONSENT TEXT", evidence.ai_voice.exact_text],
    ["AI VOICE CONSENT AT", evidence.ai_voice.captured_at],
    ["AI VOICE CONSENT PHONE", evidence.ai_voice.phone],
  ];
}

/* ---------------------------------------------------------------------
   APPLYING A SUBMISSION TO EXISTING STATE
   ---------------------------------------------------------------------
   The single most dangerous operation in this module, and the reason it is
   a pure function with its own tests: a form submission must never be able
   to undo a STOP.

   Three rules:

     1. An UNTICKED box changes nothing. It means "no new consent was
        granted here", not "revoke what you had". A visitor who opted in
        last month and simply did not re-tick this month has not withdrawn
        anything.

     2. A TICKED box grants permission only from a state that was never
        granted, or granted. It records the new phone, time and version.

     3. A TICKED box against a REVOKED or SUPPRESSED state does NOT clear
        it. The suppression stands, and the request is recorded as a
        pending re-opt-in for a human or a deliberate re-opt-in workflow to
        act on. Anything else would let a mass-mailed "update your details"
        link quietly resurrect every number that ever sent STOP.
   --------------------------------------------------------------------- */
const { NEVER_GRANTED, GRANTED, REVOKED, SUPPRESSED } = PERMISSION_STATE;

function applyChannel(current, channelEvidenceObj, evidence) {
  const prior = current || { status: NEVER_GRANTED };
  if (!channelEvidenceObj.granted) return { ...prior, changed: false, outcome: "no_new_consent" };

  if (prior.status === REVOKED || prior.status === SUPPRESSED) {
    return {
      ...prior,
      changed: false,
      outcome: "pending_reoptin",
      /* Evidence that they asked again, kept beside the suppression rather
         than on top of it. A re-opt-in workflow reads this; nothing sends
         because of it. */
      pending_reoptin: {
        requested_at: channelEvidenceObj.captured_at,
        phone: channelEvidenceObj.phone,
        version: channelEvidenceObj.version,
        submission_id: evidence.submission_id,
      },
    };
  }

  return {
    status: GRANTED,
    consent_at: channelEvidenceObj.captured_at,
    consent_phone: channelEvidenceObj.phone,
    consent_version: channelEvidenceObj.version,
    consent_source: evidence.form_type,
    consent_page: evidence.source_page,
    changed: true,
    outcome: "granted",
  };
}

/**
 * Fold one submission's evidence into a contact's existing permission
 * state. Pure: returns the next state, mutates nothing, and never touches
 * the suppression record.
 */
export function applySubmissionConsent(currentState, evidence) {
  const state = currentState || {};
  return {
    ...state,
    sms: applyChannel(state.sms, evidence.sms, evidence),
    ai_voice: applyChannel(state.ai_voice, evidence.ai_voice, evidence),
    /* Untouched, always. Suppression is cleared by a re-opt-in workflow,
       never by a form. */
    suppression: state.suppression || {},
  };
}

/** A PII-free classification for logs: which channels were granted. */
export function consentLogShape(evidence) {
  return {
    sms_consent: evidence.sms.granted,
    ai_voice_consent: evidence.ai_voice.granted,
    sms_version: evidence.sms.version,
    ai_voice_version: evidence.ai_voice.version,
  };
}
