/* Builds the deterministic Description block written to the Zoho Lead.
   Zoho Free has no custom fields, so everything that is not a standard
   field lives here. The order and labels are fixed so the block stays
   greppable and diffable across leads. */

const ROWS = [
  ["FORM", (l) => l.lead.form_type],
  ["SELLING TIMELINE", (l) => l.lead.timeline],
  ["CONDITION", (l) => l.lead.condition],
  ["TOPIC", (l) => l.lead.topic],
  ["MESSAGE", (l) => l.lead.message],
  ["NOTES", (l) => l.lead.notes],
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
 */
export function buildDescription(payload) {
  return ROWS.map(([label, get]) => label + ": " + (get(payload) || "-")).join("\n");
}

/** Field labels in order, for tests and documentation. */
export const DESCRIPTION_LABELS = ROWS.map(([label]) => label);
