/* HubSpot CRM client. Server-side only.
 *
 * The access token lives in a Vercel environment variable. It is never sent
 * to the browser, never echoed in a response, and never logged - not even in
 * an error message, which is why no HubSpot response body is ever attached to
 * a thrown Error here (HubSpot echoes submitted values back in validation
 * errors, so a body can carry both PII and the offending payload).
 *
 * Scope budget - a 2026 HubSpot SERVICE KEY with exactly:
 *   crm.objects.contacts.read
 *   crm.objects.contacts.write
 *   crm.objects.notes.write     <- REQUIRED for the timeline activity
 *
 * Every submission becomes its own timestamped Note on the contact's
 * timeline. That is the record. The contact's `message` property carries a
 * short summary of the LATEST enquiry only, for the sidebar.
 */

import { buildDescription, buildSummary } from "./description.mjs";
import { log, logError } from "./log.mjs";

const API = () => process.env.HUBSPOT_API_BASE || "https://api.hubapi.com";
const TIMEOUT_MS = 8000;

/* The contact's at-a-glance summary field.
 *
 * `message` is a HubSpot DEFAULT contact property - present in every portal,
 * multi-line text, writable through the CRM API - documented by HubSpot as
 * being "for any message or comments the contact may want to leave on a
 * form". It is NOT invented and NOT custom, so it needs no schema scope.
 *
 * It now holds a SHORT summary of the latest enquiry and is REPLACED on each
 * submission. The durable, complete, per-submission record is the timeline
 * note; see createNote below. */
export const DETAIL_PROPERTY = "message";

/* HubSpot caps a property value at 65,536 characters / 64 KB, and caps
   hs_note_body at 65,536 characters. Bytes, with headroom, because a
   character count does not bound UTF-8. */
export const DETAIL_MAX_BYTES = 60000;

/* note -> contact. HUBSPOT_DEFINED association type for a note on a contact. */
export const NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID = 202;

/** True when everything needed to reach HubSpot is present. Only the token. */
export function isConfigured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
}

const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Defensive byte cap. Validation already bounds every field far below this. */
function capBytes(text) {
  if (bytes(text) <= DETAIL_MAX_BYTES) return text;
  return Buffer.from(text, "utf8").subarray(0, DETAIL_MAX_BYTES).toString("utf8")
    .replace(/\uFFFD+$/, "");
}

/**
 * The exact property map sent to HubSpot. Only standard, safely writable
 * contact properties.
 *
 * `phone` is omitted when blank rather than sent empty: on an update an empty
 * string would blank a number HubSpot already holds, so a visitor who gave a
 * phone once and not the second time would lose it.
 */
export function toContactProperties(payload) {
  const { lead } = payload;
  const props = {
    email: lead.email,
    firstname: lead.first_name,
    lastname: lead.last_name,
  };
  /* Blank values are OMITTED, never sent as "". An empty string on a PATCH
     blanks what HubSpot already holds, so a visitor who gave a phone or an
     address once and not the second time would lose it. */
  if (lead.phone) props.phone = lead.phone;
  if (lead.property_address) props.address = lead.property_address;
  props[DETAIL_PROPERTY] = capBytes(buildSummary(payload));
  return props;
}

/** The exact Note body and association sent to HubSpot. */
export function toNoteRecord(payload, contactId) {
  return {
    properties: {
      /* Required by HubSpot; it decides where the note sits on the timeline. */
      hs_timestamp: payload.meta.submitted_at,
      hs_note_body: capBytes(buildDescription(payload)),
    },
    associations: [{
      to: { id: String(contactId) },
      types: [{
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
      }],
    }],
  };
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
      properties: ["email"],
      limit: 1,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw hubspotError("SEARCH", res.status, json);
  if (!json || !Array.isArray(json.results)) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  const hit = json.results[0];
  if (!hit) return null;
  if (!hit.id) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  return { id: String(hit.id) };
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

/* A missing notes scope is the one failure whose remedy is a person clicking
   something in HubSpot, so it is detected and named rather than left as a
   generic 403. */
function isNotesScopeFailure(status, json) {
  if (status !== 403) return false;
  let blob = String(json?.message || "") + " " + String(json?.category || "");
  return /scope|permission|forbidden/i.test(blob) || status === 403;
}

/**
 * Create the timeline activity for one submission and associate it to the
 * contact in the same call.
 *
 * This is the durable record of what the visitor actually said. If it fails,
 * the lead fails - see createLead.
 */
async function createNote(payload, contactId) {
  const res = await hubspotFetch("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify(toNoteRecord(payload, contactId)),
  });
  const json = await readJson(res);

  if (!res.ok) {
    if (isNotesScopeFailure(res.status, json)) {
      const err = new Error("HUBSPOT_NOTES_SCOPE_MISSING");
      err.notesScopeMissing = true;
      throw err;
    }
    throw hubspotError("NOTE", res.status, json);
  }
  if (!json?.id) throw new Error("HUBSPOT_NOTE_MALFORMED_RESPONSE");

  /* HubSpot echoes the associations it actually made. An unassociated note is
     invisible on the contact's timeline, which is the whole point of writing
     it, so a note that came back unassociated is a failure, not a success. */
  const associated = Array.isArray(json.associations?.contacts?.results)
    ? json.associations.contacts.results.some((r) => String(r.id) === String(contactId))
    : null;
  if (associated === false) {
    const err = new Error("HUBSPOT_NOTE_NOT_ASSOCIATED");
    err.noteUnassociated = true;
    throw err;
  }

  return { id: String(json.id), associated };
}

/**
 * Deliver one lead: a contact, then a timeline note.
 *
 * Contact first, because the note has to be associated to its id. Search by
 * email, then update or create. HubSpot itself enforces email uniqueness on
 * contacts, so the create path can still come back 409 when the search index
 * has not caught up with a very recent write - that conflict is resolved into
 * an update, which is what keeps a repeat submission from ever becoming a
 * second contact.
 *
 * PARTIAL WRITES ARE POSSIBLE AND ARE NOT HIDDEN. There is no transaction
 * across two HubSpot objects. If the contact write succeeds and the note
 * fails, HubSpot is left holding the contact - name, email, phone, address
 * and the `message` summary - with no timeline activity, and this throws, so
 * the visitor sees the recovery panel rather than a false success. A resubmit
 * finds the same contact and updates it (never a duplicate) and writes a
 * fresh note. Because every submission carries its own submission id, a
 * resubmit is a genuinely distinct submission and two notes is the honest
 * record of two attempts.
 *
 * Throws on any failure. Nothing here reports success it did not get.
 */
export async function createLead(payload) {
  const sid = payload.meta.submission_id;
  const email = payload.lead.email;

  try {
    const found = await findContactByEmail(email);
    let result;

    if (found) {
      result = await updateContact(found.id, toContactProperties(payload));
    } else {
      try {
        result = await createContact(toContactProperties(payload));
      } catch (err) {
        if (!err.conflict) throw err;
        const ref = err.conflictId || email;
        const byEmail = !err.conflictId;
        log("hubspot.create_conflict_resolved", { submission_id: sid, by_email: byEmail });
        result = await updateContact(ref, toContactProperties(payload), byEmail);
      }
    }

    log("hubspot.contact.saved", {
      submission_id: sid,
      action: result.action,
      has_id: Boolean(result.id),
    });

    /* The enquiry itself. Deliberately NOT best-effort: a contact with no
       activity behind it is a name with no enquiry attached, and looks fine. */
    const note = await createNote(payload, result.id);
    log("hubspot.note.created", {
      submission_id: sid,
      contact_action: result.action,
      associated: note.associated,
    });

    return { id: result.id, action: result.action, noteId: note.id };
  } catch (err) {
    if (err.detailPropertyRejected) {
      logError("hubspot.detail_property_unavailable", err, {
        submission_id: sid,
        property: DETAIL_PROPERTY,
        action_required:
          "restore the default contact property `message` in HubSpot, or provision an " +
          "equivalent writable text property and map DETAIL_PROPERTY to it",
      });
    }
    if (err.notesScopeMissing) {
      logError("hubspot.notes_scope_missing", err, {
        submission_id: sid,
        action_required:
          "add the scope crm.objects.notes.write to the HubSpot service key " +
          "(Settings > Integrations > Service keys), then redeploy",
      });
    }
    if (err.noteUnassociated) {
      logError("hubspot.note_not_associated", err, {
        submission_id: sid,
        action_required:
          "the note was created but not linked to the contact - check the " +
          "note-to-contact association type id",
      });
    }
    throw err;
  }
}
