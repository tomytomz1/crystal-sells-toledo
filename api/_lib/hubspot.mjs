/* HubSpot CRM client. Server-side only.
 *
 * The access token lives in a Vercel environment variable. It is never sent
 * to the browser, never echoed in a response, and never logged - not even in
 * an error message, which is why no HubSpot response body is ever attached to
 * a thrown Error here (HubSpot echoes submitted values back in validation
 * errors, so a body can carry both PII and the offending payload).
 *
 * Scope budget: this integration is deliberately least-privilege and has only
 *   crm.objects.contacts.read
 *   crm.objects.contacts.write
 * There is no notes scope, so the Zoho design - a Lead plus one Note per
 * submission - is not available. See DETAIL_PROPERTY below for what replaces it.
 */

import { buildDescription } from "./description.mjs";
import { log, logError } from "./log.mjs";

const API = () => process.env.HUBSPOT_API_BASE || "https://api.hubapi.com";
const TIMEOUT_MS = 8000;

/* Where the full enquiry goes.
 *
 * `message` is a HubSpot DEFAULT contact property - present in every portal,
 * multi-line text, writable through the CRM API - documented by HubSpot as
 * being "for any message or comments the contact may want to leave on a
 * form". That is exactly this payload. It is NOT invented, and it is NOT a
 * custom property, so it needs no schema scope to write.
 *
 * Everything the CRM cannot hold in a standard field - form type, property
 * address, timeline, condition, every UTM and click ID, first-touch time and
 * the submission ID - is written here as the same deterministic block the
 * Zoho integration used. Nothing is dropped. */
export const DETAIL_PROPERTY = "message";

/* HubSpot caps a property value at 65,536 characters / 64 KB. The cap here is
   on BYTES with headroom, because a character count does not bound UTF-8. */
export const DETAIL_MAX_BYTES = 60000;

const SEPARATOR = "----- earlier submission -----";
const TRIM_NOTICE = "----- older submissions trimmed to fit the HubSpot property limit -----";

/** True when everything needed to reach HubSpot is present. Only the token. */
export function isConfigured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
}

const bytes = (s) => Buffer.byteLength(s, "utf8");

/**
 * Merge this submission's block with whatever the contact already carries.
 *
 * Without a notes scope an update would otherwise OVERWRITE the previous
 * enquiry - so a returning seller's first message would vanish the moment
 * they submitted a second. The Zoho build prevented that with one Note per
 * submission; this is the equivalent, kept inside the single writable
 * property available to us. Newest first, oldest trimmed only when the value
 * would exceed what HubSpot accepts, and never trimmed silently.
 */
export function composeDetail(newBlock, existing = "") {
  const prior = typeof existing === "string" ? existing.trim() : "";
  const blocks = prior
    ? [newBlock, ...prior.split(SEPARATOR).map((b) => b.trim()).filter(Boolean)]
    : [newBlock];

  const join = (list, trimmed) =>
    list.join("\n\n" + SEPARATOR + "\n\n") + (trimmed ? "\n\n" + TRIM_NOTICE : "");

  const kept = blocks.slice();
  let trimmed = false;
  while (kept.length > 1 && bytes(join(kept, trimmed)) > DETAIL_MAX_BYTES) {
    kept.pop();          // drop the OLDEST, never the submission in hand
    trimmed = true;
  }

  let out = join(kept, trimmed);
  if (bytes(out) > DETAIL_MAX_BYTES) {
    /* Defensive only: validate.mjs caps every field, so one block cannot
       reach 60 KB. Cutting on a byte boundary can split a multi-byte
       character, hence the replacement-char trim. */
    const room = DETAIL_MAX_BYTES - bytes("\n" + TRIM_NOTICE);
    out = Buffer.from(out, "utf8").subarray(0, room).toString("utf8")
      .replace(/�+$/, "") + "\n" + TRIM_NOTICE;
  }
  return out;
}

/**
 * The exact property map sent to HubSpot. Only standard, safely writable
 * contact properties.
 *
 * `phone` is omitted when blank rather than sent empty: on an update an empty
 * string would blank a number HubSpot already holds, so a visitor who gave a
 * phone once and not the second time would lose it.
 */
export function toContactProperties(payload, detail) {
  const { lead } = payload;
  const props = {
    email: lead.email,
    firstname: lead.first_name,
    lastname: lead.last_name,
  };
  if (lead.phone) props.phone = lead.phone;
  /* The seller's property address belongs in HubSpot's standard, visible
     Street Address field, not only inside the enquiry text. Omitted when
     blank for the same reason as phone: an empty string on a PATCH blanks
     what HubSpot already holds, so a seller who gave an address on the
     home-value form and later used the contact form would lose it. */
  if (lead.property_address) props.address = lead.property_address;
  props[DETAIL_PROPERTY] = detail;
  return props;
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function hubspotFetch(path, options = {}) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("HUBSPOT_NOT_CONFIGURED");
  return fetchWithTimeout(API() + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function readJson(res) {
  let text;
  try { text = await res.text(); } catch { return null; }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Stable, body-free classification of a HubSpot HTTP failure. */
export function classify(status) {
  if (status === 401 || status === 403) return "AUTH_" + status;
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_" + status;
  return "HTTP_" + status;
}

/* A portal could have archived the default `message` property, or made it
   read-only. That must never degrade into "contact saved, enquiry silently
   discarded" - the whole substance of the lead lives in that value. */
function isDetailPropertyRejection(status, json) {
  if (status !== 400) return false;
  let blob = String(json?.message || "");
  try { blob += " " + JSON.stringify(json?.errors || []); } catch { /* ignore */ }
  return blob.includes(DETAIL_PROPERTY) &&
    /does not exist|doesn't exist|read[- ]?only|invalid property|PROPERTY_DOESNT_EXIST/i.test(blob);
}

function hubspotError(stage, status, json) {
  if (isDetailPropertyRejection(status, json)) {
    const err = new Error("HUBSPOT_DETAIL_PROPERTY_UNAVAILABLE");
    err.detailPropertyRejected = true;
    return err;
  }
  const err = new Error("HUBSPOT_" + stage + "_" + classify(status));
  err.status = status;
  return err;
}

/** HubSpot reports a duplicate email as `Contact already exists. Existing ID: 123`. */
export function parseConflictId(json) {
  const m = /Existing ID:\s*(\d+)/i.exec(String(json?.message || ""));
  return m ? m[1] : null;
}

function contactUrl(ref, { byEmail = false, properties = [] } = {}) {
  const qs = new URLSearchParams();
  if (byEmail) qs.set("idProperty", "email");
  if (properties.length) qs.set("properties", properties.join(","));
  const q = qs.toString();
  return "/crm/v3/objects/contacts/" + encodeURIComponent(ref) + (q ? "?" + q : "");
}

/** Search by email. Returns { id, detail } or null. */
export async function findContactByEmail(email) {
  const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", DETAIL_PROPERTY],
      limit: 1,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw hubspotError("SEARCH", res.status, json);
  if (!json || !Array.isArray(json.results)) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  const hit = json.results[0];
  if (!hit) return null;
  if (!hit.id) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  return { id: String(hit.id), detail: hit.properties?.[DETAIL_PROPERTY] || "" };
}

/** Read one contact's stored enquiry block, so an update can append to it. */
async function readDetail(ref, byEmail) {
  try {
    const res = await hubspotFetch(contactUrl(ref, { byEmail, properties: [DETAIL_PROPERTY] }));
    if (!res.ok) return "";
    const json = await readJson(res);
    return json?.properties?.[DETAIL_PROPERTY] || "";
  } catch {
    /* Best effort. Failing to read history must not lose the enquiry in hand. */
    return "";
  }
}

async function createContact(props) {
  const res = await hubspotFetch("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties: props }),
  });
  const json = await readJson(res);

  if (res.status === 409) {
    const err = new Error("HUBSPOT_CREATE_CONFLICT");
    err.conflict = true;
    err.conflictId = parseConflictId(json);
    throw err;
  }
  if (!res.ok) throw hubspotError("CREATE", res.status, json);
  if (!json?.id) throw new Error("HUBSPOT_CREATE_MALFORMED_RESPONSE");
  return { id: String(json.id), action: "create" };
}

async function updateContact(ref, props, byEmail = false) {
  const res = await hubspotFetch(contactUrl(ref, { byEmail }), {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
  const json = await readJson(res);
  if (!res.ok) throw hubspotError("UPDATE", res.status, json);
  if (!json?.id) throw new Error("HUBSPOT_UPDATE_MALFORMED_RESPONSE");
  return { id: String(json.id), action: "update" };
}

/**
 * Deliver one lead as a HubSpot contact.
 *
 * Search by email, then update or create. HubSpot itself enforces email
 * uniqueness on contacts, so the create path can still come back 409 when the
 * search index has not caught up with a very recent write - that conflict is
 * resolved into an update rather than surfaced, which is what keeps a repeat
 * submission from ever becoming a second contact.
 *
 * Throws on any failure. The caller turns that into a 502 and the visitor
 * sees the recovery panel; nothing here ever reports success it did not get.
 */
export async function createLead(payload) {
  const sid = payload.meta.submission_id;
  const email = payload.lead.email;
  const block = buildDescription(payload);

  try {
    const found = await findContactByEmail(email);
    let result;

    if (found) {
      result = await updateContact(found.id, toContactProperties(payload, composeDetail(block, found.detail)));
    } else {
      try {
        result = await createContact(toContactProperties(payload, composeDetail(block, "")));
      } catch (err) {
        if (!err.conflict) throw err;

        /* The contact existed after all - search lag, or two submissions in
           flight at once. Fold into an update so no duplicate is created. */
        const ref = err.conflictId || email;
        const byEmail = !err.conflictId;
        log("hubspot.create_conflict_resolved", { submission_id: sid, by_email: byEmail });
        const prior = await readDetail(ref, byEmail);
        result = await updateContact(ref, toContactProperties(payload, composeDetail(block, prior)), byEmail);
      }
    }

    log("hubspot.contact.saved", {
      submission_id: sid,
      action: result.action,
      has_id: Boolean(result.id),
    });
    return result;
  } catch (err) {
    if (err.detailPropertyRejected) {
      /* Deliberately fatal. Saving the name and dropping the address, the
         timeline and the message would hand Crystal a contact with no
         enquiry attached and no sign anything was missing. */
      logError("hubspot.detail_property_unavailable", err, {
        submission_id: sid,
        property: DETAIL_PROPERTY,
        action_required:
          "restore the default contact property `message` in HubSpot, or provision an " +
          "equivalent writable text property and map DETAIL_PROPERTY to it",
      });
    }
    throw err;
  }
}
