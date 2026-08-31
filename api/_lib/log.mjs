/* Structured logging that never emits lead PII.
   Vercel function logs are readable by anyone with project access and are
   retained; names, emails, phone numbers and property addresses must not
   go into them. Only identifiers, outcomes and shapes. */

const PII = new Set([
  "first_name", "last_name", "email", "phone", "property_address",
  "message", "notes", "topic",
]);

/** Redact a payload down to something safe to log. */
export function safeShape(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII.has(k)) out[k] = v == null || v === "" ? "absent" : `present:${String(v).length}`;
    else if (v && typeof v === "object") out[k] = safeShape(v);
    else out[k] = v;
  }
  return out;
}

export function log(event, fields = {}) {
  const line = { at: new Date().toISOString(), event, ...fields };
  console.log(JSON.stringify(line));
}

export function logError(event, err, fields = {}) {
  /* Message only — never the stack, which can carry request bodies, and
     never the error object, which can carry response payloads. */
  log(event, { ...fields, error: err instanceof Error ? err.message : String(err) });
}
