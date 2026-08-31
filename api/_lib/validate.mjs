/* Schema, normalisation and length caps for the lead payload.
   Server-side and authoritative: the client's own validation is a
   convenience, never a guarantee. */

export const FORM_TYPES = new Set(["home_value", "contact", "buyer_inquiry"]);

export const ATTRIBUTION_KEYS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "gbraid", "wbraid", "fbclid", "msclkid",
  "landing_page", "referrer", "first_touch_at",
];

const LIMITS = {
  form_type: 32, first_name: 80, last_name: 80, email: 254, phone: 40,
  property_address: 200, topic: 120, message: 4000, timeline: 120,
  condition: 120, notes: 4000, page: 300,
  landing_page: 500, referrer: 500, first_touch_at: 40,
  utm_source: 200, utm_medium: 200, utm_campaign: 200, utm_term: 200,
  utm_content: 200, gclid: 300, gbraid: 300, wbraid: 300, fbclid: 300, msclkid: 300,
};

/* Deliberately conservative. Not RFC 5322 - that accepts addresses no mail
   system in practice delivers to. Rejects spaces, leading/trailing dots and
   a missing TLD. */
const EMAIL = /^[^\s@.][^\s@]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/* Control characters, stripped from every field before storage. */
const CTRL = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

export class FieldError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Single-line fields: strip control chars, collapse all whitespace. */
const squash = (v) =>
  typeof v === "string" ? v.replace(CTRL, "").replace(/\s+/g, " ").trim() : "";

/** Multi-line fields: keep paragraph breaks, collapse the rest. */
const squashMultiline = (v) =>
  typeof v === "string"
    ? v.replace(/\r\n?/g, "\n")
       .replace(new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g"), "")
       .replace(/[^\S\n]+/g, " ")
       .replace(/\n{3,}/g, "\n\n")
       .trim()
    : "";

export function normalizePhone(raw) {
  const s = squash(raw);
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  if (d.length === 11 && d[0] === "1") return "(" + d.slice(1, 4) + ") " + d.slice(4, 7) + "-" + d.slice(7);
  return s; // international or partial - preserve what was typed
}

function cap(field, value) {
  const max = LIMITS[field];
  if (max && value.length > max)
    throw new FieldError("FIELD_TOO_LONG", field + " exceeds " + max + " characters");
  return value;
}

/**
 * Validate and normalise. Throws FieldError on rejection.
 * Returns { lead, attribution, meta } with every value a trimmed string.
 */
export function validateLead(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new FieldError("INVALID_PAYLOAD", "Body must be a JSON object");

  /* Honeypot - verified server-side, not merely on the client. */
  if (squash(raw._gotcha)) throw new FieldError("REJECTED", "Rejected");

  const form_type = squash(raw.form_type);
  if (!form_type) throw new FieldError("MISSING_FORM_TYPE", "form_type is required");
  cap("form_type", form_type);
  if (!FORM_TYPES.has(form_type)) throw new FieldError("UNKNOWN_FORM_TYPE", "Unrecognised form_type");

  const first_name = cap("first_name", squash(raw.first_name));
  const last_name = cap("last_name", squash(raw.last_name));
  if (!first_name) throw new FieldError("MISSING_FIRST_NAME", "First name is required");
  if (!last_name) throw new FieldError("MISSING_LAST_NAME", "Last name is required");

  const email = cap("email", squash(raw.email).toLowerCase());
  if (!email) throw new FieldError("MISSING_EMAIL", "Email is required");
  if (!EMAIL.test(email)) throw new FieldError("INVALID_EMAIL", "Email address is not valid");

  const phone = cap("phone", normalizePhone(raw.phone));
  const property_address = cap("property_address", squash(raw.property_address));
  const topic = cap("topic", squash(raw.topic));
  const timeline = cap("timeline", squash(raw.timeline));
  const condition = cap("condition", squash(raw.condition));
  const message = cap("message", squashMultiline(raw.message));
  const notes = cap("notes", squashMultiline(raw.notes));

  if (form_type === "home_value" && !property_address)
    throw new FieldError("MISSING_ADDRESS", "Property address is required");
  if (form_type === "contact" && !message)
    throw new FieldError("MISSING_MESSAGE", "Message is required");

  const src = raw.attribution && typeof raw.attribution === "object" ? raw.attribution : raw;
  const attribution = {};
  for (const k of ATTRIBUTION_KEYS) attribution[k] = cap(k, squash(src[k]));

  const meta = {
    page: cap("page", squash(raw.page)),
    submitted_at: new Date().toISOString(),
  };

  return {
    lead: { form_type, first_name, last_name, email, phone, property_address,
            topic, timeline, condition, message, notes },
    attribution,
    meta,
  };
}
