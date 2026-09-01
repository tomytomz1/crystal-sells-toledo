/* Builds the deterministic enquiry block written to the CRM.

   CRM-agnostic on purpose. It is written to HubSpot's default `message`
   contact property (the live path), and to the Zoho Lead Description and
   Note (the retained fallback). Neither CRM has a custom field for this
   under the plan/scopes in use, so everything that is not a standard
   contact field lives here. The order and labels are fixed so the block
   stays greppable and diffable across leads. */

const ROWS = [
  ["FORM", (l) => l.lead.form_type],
  /* The address is in this block, not only in a CRM address field. Zoho put
     it in the standard `Street` field, so the block never carried it; the
     HubSpot mapping is deliberately limited to email/name/phone, so without
     this row a seller's property address would be lost on delivery. The
     block has to stand alone whatever CRM is on the other end. */
  ["PROPERTY ADDRESS", (l) => l.lead.property_address],
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
