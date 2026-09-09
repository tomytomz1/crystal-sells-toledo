import { consentRows } from "./consent.mjs";

/* Builds the deterministic enquiry block written to the CRM.

   CRM-agnostic on purpose. It is written to HubSpot's default `message`
   contact property (the live path), and to the Zoho Lead Description and
   Note (the retained fallback). Neither CRM has a custom field for this
   under the plan/scopes in use, so everything that is not a standard
   contact field lives here. The order and labels are fixed so the block
   stays greppable and diffable across leads. */

/* Third element marks a row as part of the SHORT summary written to the
   contact's `message` property. The full block goes on the timeline note;
   `message` carries only what Crystal wants at a glance in the sidebar -
   what they own, when they might sell, and their own words. Tracking rows
   are analytics, not something to read beside a phone number.

   Both views come from this one list, so they cannot drift apart. */
const ROWS = [
  ["FORM", (l) => l.lead.form_type, true],
  /* The address is in this block, not only in a CRM address field. Zoho put
     it in the standard `Street` field, so the block never carried it; the
     HubSpot mapping is deliberately limited to email/name/phone, so without
     this row a seller's property address would be lost on delivery. The
     block has to stand alone whatever CRM is on the other end. */
  ["PROPERTY ADDRESS", (l) => l.lead.property_address, true],
  ["SELLING TIMELINE", (l) => l.lead.timeline, true],
  ["CONDITION", (l) => l.lead.condition, true],
  ["TOPIC", (l) => l.lead.topic, true],
  ["MESSAGE", (l) => l.lead.message, true],
  ["NOTES", (l) => l.lead.notes, true],
  ["LANDING PAGE", (l) => l.attribution.landing_page],
  ["CURRENT PAGE", (l) => l.meta.page],
  ["REFERRER", (l) => l.attribution.referrer],
  ["UTM SOURCE", (l) => l.attribution.utm_source],
  ["UTM MEDIUM", (l) => l.attribution.utm_medium],
  ["UTM CAMPAIGN", (l) => l.attribution.utm_campaign],
  ["UTM TERM", (l) => l.attribution.utm_term],
  ["UTM CONTENT", (l) => l.attribution.utm_content],
  ["GCLID", (l) => l.attribution.gclid],
  ["GBRAID", (l) => l.attribution.gbraid],
  ["WBRAID", (l) => l.attribution.wbraid],
  ["FBCLID", (l) => l.attribution.fbclid],
  ["MSCLKID", (l) => l.attribution.msclkid],
  ["FIRST TOUCH", (l) => l.attribution.first_touch_at],
  ["SUBMITTED", (l) => l.meta.submitted_at],
  ["SUBMISSION ID", (l) => l.meta.submission_id],
];

/**
 * Every row is always emitted, empty ones included. A missing label would
 * be ambiguous - "no UTM source" and "we stopped recording UTM source"
 * must not look the same when Crystal reads a lead six months from now.
 *
 * When the communications-consent feature is enabled, `payload.consent`
 * carries the submission's consent evidence and eleven further rows are
 * appended - including the exact disclosure text, so a stored submission
 * answers "what words did this person agree to" without anyone having to
 * find the revision of the source that was deployed that day. This block is what HubSpot's native form-submission timeline
 * activity carries, and those activities are per-submission, dated, and
 * not editable through the API - so the consent snapshot lands somewhere a
 * later submission adds to rather than overwrites. That is the audit trail
 * the integration can honestly provide with the scopes it already has.
 *
 * The first of the eleven is CONSENT LEDGER, which says whether this
 * submission's consent evidence reached the durable append-only ledger.
 * It is what explains a block reading GRANTED beside a contact whose
 * permission property correctly reads never_granted: no durable evidence,
 * so no grant.
 *
 * With the feature off there is no `payload.consent`, no rows are added,
 * and the block is byte-for-byte what production writes today.
 */
export function buildDescription(payload) {
  const rows = ROWS.map(([label, get]) => [label, get(payload)]);
  if (payload.consent) rows.push(...consentRows(payload.consent));
  return rows.map(([label, value]) => label + ": " + (value || "-")).join("\n");
}

/**
 * The short view written to the contact's `message` property: the latest
 * enquiry only, replacing whatever was there.
 *
 * It does NOT accumulate. Every submission already exists in full and
 * timestamped on the timeline, so an append-only blob in a sidebar property
 * would be a second, worse copy of the same history - growing without bound
 * and unreadable in the field HubSpot renders it in.
 *
 * Blank rows are dropped here (unlike the note, where every label is always
 * emitted): this is a human-readable summary, not the durable record.
 */
export function buildSummary(payload) {
  return ROWS
    .filter(([, , inSummary]) => inSummary)
    .map(([label, get]) => [label, get(payload)])
    .filter(([, value]) => value)
    .map(([label, value]) => label + ": " + value)
    .join("\n");
}

/** Field labels in order, for tests and documentation. The consent rows
 *  are separate because they are appended only when the feature is on. */
export const DESCRIPTION_LABELS = ROWS.map(([label]) => label);

/** The consent rows' labels, in order. Pinned to consentRows() by an
 *  assertion in tests/consent.test.mjs, so the two cannot drift apart. */
export const CONSENT_LABELS = [
  /* First, because it qualifies every row after it - see consentRows()
     in api/_lib/consent.mjs. */
  "CONSENT LEDGER",
  "SMS CONSENT", "SMS CONSENT VERSION", "SMS CONSENT TEXT", "SMS CONSENT AT",
  "SMS CONSENT PHONE",
  "AI VOICE CONSENT", "AI VOICE CONSENT VERSION", "AI VOICE CONSENT TEXT",
  "AI VOICE CONSENT AT", "AI VOICE CONSENT PHONE",
];

/** The subset that appears in the summary, in order. */
export const SUMMARY_LABELS = ROWS.filter(([, , s]) => s).map(([label]) => label);
