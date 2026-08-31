/* Zoho CRM client. Server-side only.
   Credentials live in Vercel environment variables and are never sent to
   the browser, never echoed in a response, and never logged. */

import { buildDescription } from "./description.mjs";
import { log, logError } from "./log.mjs";

const ACCOUNTS = () => process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com";
const API = () => process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const TIMEOUT_MS = 8000;

/* Company is MANDATORY on a Zoho Lead - an upsert without it fails with
   MANDATORY_NOT_FOUND. These are business classifications, not claims about
   the person, so they are safe constants rather than anything user-supplied. */
export const COMPANY_BY_FORM = {
  home_value: "Residential Seller",
  contact: "Residential Real Estate Lead",
  buyer_inquiry: "Residential Real Estate Lead",
};
const COMPANY_FALLBACK = "Residential Real Estate Lead";

/* Lead_Source and Lead_Status are PICKLISTS. A value Zoho does not hold is
   rejected with INVALID_DATA, which would fail the whole lead.
     - Lead_Source defaults to "Website" but is overridable.
     - Lead_Status has NO default and is omitted unless explicitly configured,
       because Zoho's stock statuses are "Not Contacted", "Contacted", ...
       and "New Lead" is not among them in a default account.
   Run `npm run zoho:verify` to list the values this account actually has.
   Nothing here invents a picklist entry. */
const leadSource = () => process.env.ZOHO_LEAD_SOURCE || "Website";
const leadStatus = () => process.env.ZOHO_LEAD_STATUS || "";

const PICKLIST_FIELDS = ["Lead_Source", "Lead_Status"];

/** True when every credential needed to reach Zoho is present. */
export function isConfigured() {
  return Boolean(
    process.env.ZOHO_CLIENT_ID &&
    process.env.ZOHO_CLIENT_SECRET &&
    process.env.ZOHO_REFRESH_TOKEN
  );
}

/* Access tokens last an hour. Cached in module scope so a warm instance
   reuses one rather than burning a refresh call per lead. */
let cached = { token: null, expiresAt: 0 };
export function _resetTokenCache() { cached = { token: null, expiresAt: 0 }; }

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (cached.token && now < cached.expiresAt - 60_000) return cached.token;

  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetchWithTimeout(ACCOUNTS() + "/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  /* Deliberately does not include the response body in the error: a failed
     token exchange can echo client_id and other credential material. */
  if (!res.ok) throw new Error("ZOHO_TOKEN_HTTP_" + res.status);
  const json = await res.json();
  if (!json.access_token) throw new Error("ZOHO_TOKEN_MISSING");

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000),
  };
  return cached.token;
}

async function zohoFetch(path, options = {}) {
  const token = await getAccessToken();
  return fetchWithTimeout(API() + path, {
    ...options,
    headers: {
      Authorization: "Zoho-oauthtoken " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

/** Build the Lead record. Exported so tests can assert the exact payload. */
export function toLeadRecord(payload) {
  const { lead } = payload;
  const record = {
    First_Name: lead.first_name,
    Last_Name: lead.last_name,
    Company: COMPANY_BY_FORM[lead.form_type] || COMPANY_FALLBACK,
    Email: lead.email,
    Description: buildDescription(payload),
  };
  const source = leadSource();
  if (source) record.Lead_Source = source;
  const status = leadStatus();
  if (status) record.Lead_Status = status;
  if (lead.phone) record.Phone = lead.phone;
  if (lead.property_address) record.Street = lead.property_address;
  return record;
}

/** Copy without the picklist fields, for the fallback retry. */
export function withoutPicklists(record) {
  const copy = { ...record };
  for (const f of PICKLIST_FIELDS) delete copy[f];
  return copy;
}

async function upsertOnce(record) {
  const res = await zohoFetch("/crm/v5/Leads/upsert", {
    method: "POST",
    body: JSON.stringify({ data: [record], duplicate_check_fields: ["Email"] }),
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  const row = json?.data?.[0];

  if (!res.ok || !row) {
    const err = new Error("ZOHO_UPSERT_HTTP_" + res.status);
    err.zohoCode = row?.code || null;
    throw err;
  }
  if (row.code !== "SUCCESS" && row.status !== "success") {
    const err = new Error("ZOHO_UPSERT_REJECTED_" + (row.code || "UNKNOWN"));
    err.zohoCode = row.code || null;
    err.zohoField = row.details?.api_name || null;
    throw err;
  }
  return { leadId: row.details?.id, action: row.action || "insert" };
}

/**
 * Upsert the Lead, then always attach a Note.
 *
 * Upsert on Email avoids piling up obvious duplicates. The Note is what
 * makes that safe: a repeat enquiry updates the Lead *and* leaves a
 * permanent, timestamped record of what was actually said this time, so
 * no submission is ever silently overwritten.
 *
 * If Zoho rejects a picklist value we have not confirmed for this account,
 * the lead is retried once WITHOUT the picklist fields. A lead that arrives
 * missing its Lead_Status is a small annoyance; a lead lost because someone
 * assumed a dropdown entry existed is the failure this system exists to
 * prevent. The retry is logged loudly so the misconfiguration gets fixed.
 */
export async function createLead(payload) {
  const record = toLeadRecord(payload);
  const sid = payload.meta.submission_id;
  let result;

  try {
    result = await upsertOnce(record);
  } catch (err) {
    const picklistProblem =
      err.zohoCode === "INVALID_DATA" &&
      (!err.zohoField || PICKLIST_FIELDS.includes(err.zohoField));

    if (!picklistProblem) throw err;

    logError("zoho.picklist_rejected", err, {
      submission_id: sid,
      field: err.zohoField || "unknown",
      retrying_without: PICKLIST_FIELDS.join(","),
      action_required: "run npm run zoho:verify and set ZOHO_LEAD_SOURCE / ZOHO_LEAD_STATUS",
    });
    result = await upsertOnce(withoutPicklists(record));
    log("zoho.lead.saved_without_picklists", { submission_id: sid });
  }

  log("zoho.lead.upsert", {
    submission_id: sid,
    action: result.action,
    has_id: Boolean(result.leadId),
  });

  /* Note attachment is best-effort. The lead itself is already safely in
     the CRM; losing the note is a degradation, not a lost lead, so it must
     not turn a successful submission into a failure for the visitor. */
  if (result.leadId) {
    try {
      await attachNote(result.leadId, payload);
    } catch (err) {
      logError("zoho.note.failed", err, { submission_id: sid });
    }
  }

  return result;
}

async function attachNote(leadId, payload) {
  const title =
    "Website enquiry - " + payload.lead.form_type + " - " + payload.meta.submitted_at;
  const res = await zohoFetch("/crm/v5/Notes", {
    method: "POST",
    body: JSON.stringify({
      data: [{
        Note_Title: title.slice(0, 120),
        Note_Content: buildDescription(payload).slice(0, 32000),
        Parent_Id: leadId,
        se_module: "Leads",
      }],
    }),
  });
  if (!res.ok) throw new Error("ZOHO_NOTE_HTTP_" + res.status);
}

/**
 * Read the account's real picklist values. Used by `npm run zoho:verify`
 * so the configured values are confirmed against the CRM before go-live
 * rather than guessed.
 */
export async function describeLeadPicklists() {
  const res = await zohoFetch("/crm/v5/settings/fields?module=Leads");
  if (!res.ok) throw new Error("ZOHO_FIELDS_HTTP_" + res.status);
  const json = await res.json();
  const out = {};
  for (const field of json.fields || []) {
    if (PICKLIST_FIELDS.includes(field.api_name)) {
      out[field.api_name] = (field.pick_list_values || []).map((v) => v.display_value);
    }
    if (field.api_name === "Company") {
      out._company = { required: field.system_mandatory === true, length: field.length };
    }
  }
  return out;
}
