/* Zoho CRM client. Server-side only.
   Credentials live in Vercel environment variables and are never sent to
   the browser, never echoed in a response, and never logged. */

import { buildDescription } from "./description.mjs";
import { log, logError } from "./log.mjs";

const ACCOUNTS = () => process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com";
const API = () => process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const TIMEOUT_MS = 8000;

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

function toLeadRecord(payload) {
  const { lead } = payload;
  const record = {
    First_Name: lead.first_name,
    Last_Name: lead.last_name,
    Email: lead.email,
    Lead_Source: "Website",
    Lead_Status: "New Lead",
    Description: buildDescription(payload),
  };
  if (lead.phone) record.Phone = lead.phone;
  if (lead.property_address) record.Street = lead.property_address;
  return record;
}

/**
 * Upsert the Lead, then always attach a Note.
 *
 * Upsert on Email avoids piling up obvious duplicates. The Note is what
 * makes that safe: a repeat enquiry updates the Lead *and* leaves a
 * permanent, timestamped record of what was actually said this time, so
 * no submission is ever silently overwritten.
 */
export async function createLead(payload) {
  const record = toLeadRecord(payload);

  const res = await zohoFetch("/crm/v5/Leads/upsert", {
    method: "POST",
    body: JSON.stringify({
      data: [record],
      duplicate_check_fields: ["Email"],
    }),
  });

  if (!res.ok) throw new Error("ZOHO_UPSERT_HTTP_" + res.status);
  const json = await res.json();
  const row = json?.data?.[0];
  if (!row || (row.code !== "SUCCESS" && row.status !== "success"))
    throw new Error("ZOHO_UPSERT_REJECTED_" + (row?.code || "UNKNOWN"));

  const leadId = row.details?.id;
  const action = row.action || "insert";
  log("zoho.lead.upsert", { submission_id: payload.meta.submission_id, action, has_id: Boolean(leadId) });

  /* Note attachment is best-effort. The lead itself is already safely in
     the CRM; losing the note is a degradation, not a lost lead, so it must
     not turn a successful submission into a failure for the visitor. */
  if (leadId) {
    try {
      await attachNote(leadId, payload);
    } catch (err) {
      logError("zoho.note.failed", err, { submission_id: payload.meta.submission_id });
    }
  }

  return { leadId, action };
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
