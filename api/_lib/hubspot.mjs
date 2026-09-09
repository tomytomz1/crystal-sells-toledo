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
 *   forms
 *
 * Delivery is two writes, both mandatory:
 *   1. the Contact, through the CRM API  (authoritative properties)
 *   2. a submission to a HubSpot FORM    (the dated timeline activity)
 *
 * The form is what makes each enquiry visible as its own "Form submitted"
 * entry on the contact's timeline. Engagement objects (notes, tasks, calls)
 * are NOT available to a Service Key - the scope picker exposes none of them -
 * so the Notes API is not an option here. See
 * docs/updates/2026-09-01-timeline-architecture-decision.md.
 */

import { buildDescription, buildSummary } from "./description.mjs";
import { applySubmissionConsent } from "./consent.mjs";
import {
  consentStateEnabled, consentPropertiesToRead, fromHubSpotConsentProperties,
  toHubSpotConsentProperties, emptyConsentState, requireConsentProperties,
} from "./hubspot-consent-state.mjs";
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

const FORMS_API = () => process.env.HUBSPOT_FORMS_BASE || "https://api.hsforms.com";
const portalId = () => (process.env.HUBSPOT_PORTAL_ID || "").trim();
const formGuid = () => (process.env.HUBSPOT_FORM_GUID || "").trim();

/* The six fields defined on the HubSpot form. HubSpot validates a submission
   against the form definition and REJECTS anything carrying a field the form
   does not define, so this list is a contract with the portal, not a
   preference. Adding a seventh here without adding it to the form in HubSpot
   would fail every submission. */
export const FORM_FIELDS = ["email", "firstname", "lastname", "phone", "address", "message"];

/* HubSpot's object type id for a contact. */
const CONTACT_OBJECT_TYPE_ID = "0-1";

/* Only used to build the form submission's page context. */
const SITE_ORIGIN = "https://www.crystalsellstoledo.com";
const FORM_NAME = "Crystal Sells Toledo - Website Seller Inquiry";

/**
 * True when everything needed to reach HubSpot is present.
 *
 * All three are required, not just the token: the form submission is a
 * MANDATORY half of delivery, so a missing portal id or form guid means the
 * enquiry cannot be recorded on the timeline. Refusing up front with a 503 is
 * honest; accepting the lead and silently skipping the activity is not.
 */
export function isConfigured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN && portalId() && formGuid());
}

const bytes = (s) => Buffer.byteLength(s, "utf8");

/* Defensive byte cap. Validation already bounds every field far below this,
   so this exists so a value can never be the thing HubSpot rejects. Cutting
   on a byte boundary can split a multi-byte character, hence the trim. */
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
  if (lead.phone) props.phone = lead.phone;
  /* The seller's property address belongs in HubSpot's standard, visible
     Street Address field, not only inside the enquiry text. Omitted when
     blank for the same reason as phone: an empty string on a PATCH blanks
     what HubSpot already holds, so a seller who gave an address on the
     home-value form and later used the contact form would lose it. */
  if (lead.property_address) props.address = lead.property_address;
  /* The concise LATEST enquiry, replacing whatever was there. It no longer
     accumulates: the timeline now holds every submission in full and dated,
     so an append-only blob in a sidebar property would be a second, worse
     copy of the same history - unbounded and unreadable in the field HubSpot
     renders it in. */
  props[DETAIL_PROPERTY] = capBytes(buildSummary(payload));
  return props;
}

/**
 * The exact form submission sent to HubSpot.
 *
 * Blank optional fields are OMITTED entirely rather than sent empty. A form
 * submission SETS the properties it carries, so an empty string would blank a
 * phone or address HubSpot already holds - the same rule the CRM write follows.
 */
export function toFormSubmission(payload, { pageUri, pageName } = {}) {
  const { lead } = payload;
  const field = (name, value) =>
    ({ objectTypeId: CONTACT_OBJECT_TYPE_ID, name, value: String(value) });

  const fields = [field("email", lead.email)];
  if (lead.first_name) fields.push(field("firstname", lead.first_name));
  if (lead.last_name) fields.push(field("lastname", lead.last_name));
  if (lead.phone) fields.push(field("phone", lead.phone));
  if (lead.property_address) fields.push(field("address", lead.property_address));
  /* The complete enquiry block - whatever buildDescription() produces for
     THIS submission. That is the base 23 rows, plus 10 consent rows when
     the communications-consent feature is enabled and the payload carries
     consent evidence, so 33 rows in that case and 23 otherwise. The count
     is deliberately not asserted here: api/_lib/description.mjs owns the
     row list, and hard-coding a number in this file is how the comment got
     stale the first time.

     This is what makes the timeline activity carry the whole enquiry
     rather than just a name. */
  fields.push(field("message", capBytes(buildDescription(payload))));

  const body = {
    /* Epoch milliseconds, from the server-side submission time, so the
       activity is dated when the visitor submitted rather than when HubSpot
       happened to ingest it. */
    submittedAt: String(Date.parse(payload.meta.submitted_at)),
    fields,
  };

  /* Context is metadata, not form fields - it adds nothing to the form
     definition and cannot trip HubSpot's field validation. `hutk` is
     deliberately absent: it is a browser cookie set by HubSpot's tracking
     script, which this site does not load, and inventing one would corrupt
     attribution rather than improve it. */
  const context = {};
  if (pageUri) context.pageUri = pageUri;
  if (pageName) context.pageName = pageName;
  if (Object.keys(context).length) body.context = context;

  return body;
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

/**
 * Search by email. Returns { id, consent } or null.
 *
 * `properties` carries the 23 consent properties ONLY while the feature is
 * enabled. With it off the request body is byte-identical to the one this
 * endpoint has always sent, which is what keeps "feature off" genuinely
 * equivalent to today's production rather than merely similar.
 *
 * The consent read is not an optimisation - it is the thing that stops a new
 * submission being folded into an ASSUMED empty state. An existing contact
 * may already carry a STOP, a DNC, a revocation, or consent bound to a number
 * they no longer use, and a form submission must fold into that, not over it.
 */
export async function findContactByEmail(email) {
  const consentProps = consentPropertiesToRead();
  const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", ...consentProps],
      limit: 1,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw hubspotError("SEARCH", res.status, json);
  if (!json || !Array.isArray(json.results)) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  const hit = json.results[0];
  if (!hit) return null;
  if (!hit.id) throw new Error("HUBSPOT_SEARCH_MALFORMED_RESPONSE");
  return {
    id: String(hit.id),
    /* `hit.properties || {}` would be a lie here. A contact WAS found, so an
       empty consent state is a claim about that contact - that it has never
       granted and is not suppressed - and a malformed response is no basis
       for making it. requireConsentProperties throws instead, and the lead
       fails loudly rather than folding a grant into an invented blank. */
    consent: consentProps.length
      ? fromHubSpotConsentProperties(requireConsentProperties(hit.properties, "SEARCH"))
      : null,
  };
}

/**
 * Read one contact's consent state by id or email. Used only on the 409
 * path, where a contact appeared between the search and the create and its
 * state has therefore never been read.
 */
async function readConsentState(ref, { byEmail = false } = {}) {
  const properties = consentPropertiesToRead();
  if (!properties.length) return null;
  const res = await hubspotFetch(contactUrl(ref, { byEmail, properties }));
  const json = await readJson(res);
  if (!res.ok) throw hubspotError("READ", res.status, json);
  /* Same rule as the search, and it matters more here: this contact exists
     precisely because it collided with our create, and it is the one most
     likely to be carrying a suppression written seconds ago. */
  return fromHubSpotConsentProperties(requireConsentProperties(json?.properties, "READ"));
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

/* A missing `forms` scope is the one failure whose remedy is a person clicking
   something in HubSpot, so it is detected and named rather than left generic. */
function isFormsScopeFailure(status) {
  return status === 401 || status === 403;
}

/**
 * Submit the enquiry to the HubSpot form. This is what produces the dated
 * "Form submitted" activity on the contact's timeline.
 *
 * Uses the AUTHENTICATED endpoint with the Service Key as a bearer token.
 * The unauthenticated variant would also work, but authenticating means the
 * portal id and form guid are not the only thing standing between a stranger
 * and Crystal's CRM, and it carries higher rate limits.
 */
async function submitForm(payload) {
  const path = "/submissions/v3/integration/secure/submit/" +
    encodeURIComponent(portalId()) + "/" + encodeURIComponent(formGuid());

  const page = payload.meta.page || "/";
  const body = toFormSubmission(payload, {
    pageUri: SITE_ORIGIN + page,
    pageName: FORM_NAME,
  });

  const res = await fetchWithTimeout(FORMS_API() + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.HUBSPOT_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);

  if (!res.ok) {
    if (isFormsScopeFailure(res.status)) {
      const err = new Error("HUBSPOT_FORMS_SCOPE_OR_AUTH_" + res.status);
      err.formsScopeProblem = true;
      throw err;
    }
    /* A 400 here is almost always the form definition disagreeing with what
       was submitted - a field the form does not define, or a renamed one. */
    if (res.status === 400) {
      const err = new Error("HUBSPOT_FORM_REJECTED");
      err.formDefinitionProblem = true;
      throw err;
    }
    throw hubspotError("FORM", res.status, json);
  }

  /* HubSpot answers a good submission with a JSON body carrying inlineMessage
     or redirectUri. Anything else is not a confirmed submission, and this
     system does not report success it did not get. */
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new Error("HUBSPOT_FORM_MALFORMED_RESPONSE");

  return { ok: true };
}

/**
 * Deliver one lead: the Contact, then the form submission.
 *
 * Contact first, exactly as the proven path already does - search by email,
 * then update or create, folding a 409 into an update so a repeat submission
 * can never become a second contact. Then the form submission, which is what
 * makes the enquiry visible as its own dated activity on that contact's
 * timeline. HubSpot matches the submission to the contact by email.
 *
 * BOTH must succeed. A contact with no activity behind it is a name with no
 * enquiry attached and looks perfectly fine, which is exactly the failure this
 * system exists to prevent.
 *
 * PARTIAL WRITES ARE POSSIBLE AND ARE NOT HIDDEN. There is no transaction
 * across the CRM API and the Forms API. If the contact write succeeds and the
 * form submission fails, HubSpot is left holding the contact - name, email,
 * phone, address and the `message` summary - with no timeline activity, and
 * this throws, so the visitor sees the recovery panel rather than a false
 * success. A resubmit finds the same contact and updates it (never a
 * duplicate) and submits the form again. Every submission carries its own
 * submission id, so a resubmit is a genuinely distinct submission and two
 * activities is the honest record of two attempts. HubSpot offers no
 * idempotency key on form submission, so at-least-once is the real guarantee.
 */
export async function createLead(payload) {
  const sid = payload.meta.submission_id;
  const email = payload.lead.email;

  /* Consent current state. Absent entirely while the feature is off, in
     which case every expression below collapses to the properties this
     endpoint has always sent.

     `payload.consent` is the server-owned evidence built in api/lead.js.
     The transition itself belongs to applySubmissionConsent() in
     api/_lib/consent.mjs and is NOT re-derived here - this function decides
     WHEN to fold, never HOW. */
  const consentOn = consentStateEnabled() && Boolean(payload.consent);
  const foldConsent = (existingState) =>
    consentOn
      ? toHubSpotConsentProperties(
          applySubmissionConsent(existingState, payload.consent), payload.consent)
      : {};

  try {
    const found = await findContactByEmail(email);
    let result;

    if (found) {
      /* One PATCH, carrying the ordinary lead properties and the minimal
         consent changes together. A second write would be a second chance
         to half-succeed for no benefit. */
      result = await updateContact(found.id, {
        ...toContactProperties(payload),
        ...foldConsent(found.consent),
      });
    } else {
      try {
        /* A genuinely new contact: nothing to fold into, so the empty state
           is correct here and ONLY here. */
        result = await createContact({
          ...toContactProperties(payload),
          ...foldConsent(consentOn ? emptyConsentState() : null),
        });
      } catch (err) {
        if (!err.conflict) throw err;
        const ref = err.conflictId || email;
        const byEmail = !err.conflictId;

        /* THE RACE, AND WHY IT IS COMPLIANCE-SENSITIVE.
           A contact appeared between the search and the create. Its consent
           state has never been read, and it may already carry a STOP, a DNC
           or a global do-not-contact - set by a webhook, an import or a
           human seconds ago.

           So the transition is recomputed against the ACTUAL state of the
           contact that now exists, not against the empty state assumed a
           moment ago. Reusing that empty state would let a ticked box grant
           straight through a suppression this process had simply not seen
           yet, which is the one outcome the whole suppression model exists
           to prevent. */
        const raced = consentOn ? await readConsentState(ref, { byEmail }) : null;
        log("hubspot.create_conflict_resolved", {
          submission_id: sid,
          by_email: byEmail,
          consent_state_refetched: consentOn,
        });
        result = await updateContact(ref, {
          ...toContactProperties(payload),
          ...foldConsent(raced),
        }, byEmail);
      }
    }

    log("hubspot.contact.saved", {
      submission_id: sid,
      action: result.action,
      has_id: Boolean(result.id),
    });

    /* The timeline activity. Deliberately NOT best-effort. */
    await submitForm(payload);
    log("hubspot.form.submitted", { submission_id: sid, contact_action: result.action });

    return { id: result.id, action: result.action, formSubmitted: true };
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
    if (err.formsScopeProblem) {
      logError("hubspot.forms_scope_or_auth", err, {
        submission_id: sid,
        action_required:
          "confirm the `forms` scope is on the HubSpot service key and that " +
          "HUBSPOT_ACCESS_TOKEN in Vercel is that key, then redeploy",
      });
    }
    if (err.consentStateInvalid) {
      /* Not a transient fault. HubSpot answered, and what it said about this
         contact's consent could not be understood - so the submission was
         failed rather than folded into a guess. Someone has to look at the
         named property. The bad VALUE is deliberately absent: a mis-mapped
         CRM field can hold anything, up to and including another person's
         details. */
      logError("hubspot.consent_state_invalid", err, {
        submission_id: sid,
        consent_error: err.token,
        property: err.property,
        action_required:
          "inspect the named HubSpot contact property - a permission status outside " +
          "never_granted/granted/revoked/suppressed, or a suppression flag that is " +
          "neither true nor false nor empty, must be corrected in the portal; the lead " +
          "was NOT saved and the visitor was told so",
      });
    }
    if (err.formDefinitionProblem) {
      logError("hubspot.form_rejected", err, {
        submission_id: sid,
        expected_fields: FORM_FIELDS.join(","),
        action_required:
          "HubSpot validates a submission against the form definition - confirm the " +
          "form defines exactly these fields and that HUBSPOT_FORM_GUID is correct",
      });
    }
    throw err;
  }
}
