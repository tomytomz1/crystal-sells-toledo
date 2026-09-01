/* HubSpot delivery: the Contacts API write, then the form submission.
 *
 * Every test runs against a stubbed global fetch. No network, no portal, no
 * token. That is the point and also the limit: these prove the client behaves
 * correctly against HubSpot's documented contract, NOT that a real portal
 * accepts the payload. Only a live submission proves that.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler from "../api/lead.js";
import {
  createLead, isConfigured, toContactProperties, toFormSubmission, classify,
  parseConflictId, findContactByEmail, DETAIL_PROPERTY, DETAIL_MAX_BYTES,
  FORM_FIELDS,
} from "../api/_lib/hubspot.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { buildDescription, buildSummary, DESCRIPTION_LABELS, SUMMARY_LABELS }
  from "../api/_lib/description.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { mockReq, mockRes, validContact, validHomeValue } from "./helpers.mjs";

const TOKEN = "pat-na1-TESTTOKEN-must-never-appear-anywhere";
const PORTAL = "247240486";
const GUID = "536a356d-d854-49ec-b204-b76e591cecaa";
const FORM_PATH = `/submissions/v3/integration/secure/submit/${PORTAL}/${GUID}`;

const SEARCH = "POST /crm/v3/objects/contacts/search";
const CREATE = "POST /crm/v3/objects/contacts";
const FORM = "POST " + FORM_PATH;
const patchKey = (id) => "PATCH /crm/v3/objects/contacts/" + id;

const realFetch = globalThis.fetch;

function res({ status = 200, json = null, text = null }) {
  const body = text !== null ? text : json === null ? "" : JSON.stringify(json);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

const formOk = { json: { inlineMessage: "Thanks for submitting the form." } };

function stubFetch(routes) {
  const calls = [];
  /* The form succeeds unless a test overrides it, so contact-path tests stay
     about the contact path. */
  const all = Object.assign({ [FORM]: formOk }, routes);
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || "GET";
    const key = method + " " + u.pathname;
    const call = {
      key, method, host: u.host, path: u.pathname, search: u.search,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const route = all[key] || all["*"];
    if (!route) throw new Error("unstubbed call: " + key);
    const out = typeof route === "function" ? route(call, calls) : route;
    if (out instanceof Error) throw out;
    return res(out);
  };
  return calls;
}

const countOf = (calls, key) => calls.filter((c) => c.key === key).length;
const noHits = { json: { total: 0, results: [] } };
const hit = (id) => ({ json: { total: 1, results: [{ id, properties: { email: "x@y.co" } }] } });
const formCall = (calls) => calls.find((c) => c.key === FORM);
const fieldMap = (call) =>
  Object.fromEntries(call.body.fields.map((f) => [f.name, f.value]));

function payloadOf(raw, sid = "csv_test000000000000000000") {
  const p = validateLead(raw);
  p.meta.submission_id = sid;
  return p;
}

beforeEach(() => {
  process.env.HUBSPOT_ACCESS_TOKEN = TOKEN;
  process.env.HUBSPOT_PORTAL_ID = PORTAL;
  process.env.HUBSPOT_FORM_GUID = GUID;
  _resetRateLimit();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.HUBSPOT_PORTAL_ID;
  delete process.env.HUBSPOT_FORM_GUID;
});

async function call(body) {
  const req = mockReq({ body });
  const r = mockRes();
  const p = handler(req, r);
  req.emit("data", Buffer.from(req.body));
  req.emit("end");
  await p;
  return r;
}


/* ===================================================================== */
describe("Configuration", () => {
  test("all three variables are required", () => {
    assert.equal(isConfigured(), true);
    for (const v of ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID"]) {
      const kept = process.env[v];
      delete process.env[v];
      assert.equal(isConfigured(), false, v + " is not required");
      process.env[v] = kept;
    }
  });

  test("no Zoho variable can satisfy the check", () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    process.env.ZOHO_CLIENT_ID = "x";
    process.env.ZOHO_REFRESH_TOKEN = "z";
    assert.equal(isConfigured(), false);
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_REFRESH_TOKEN;
  });

  test("missing config: 503, no CRM call, and no claim of success", async () => {
    delete process.env.HUBSPOT_FORM_GUID;
    const calls = stubFetch({ "*": noHits });
    const r = await call(validContact);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().code, "NOT_CONFIGURED");
    assert.ok(!("submission_id" in r.json()));
    assert.equal(calls.length, 0, "must not reach HubSpot unconfigured");
  });
});


/* ===================================================================== */
describe("Standard contact field mapping", () => {
  test("the property address maps to HubSpot's standard `address`", () => {
    assert.equal(toContactProperties(payloadOf(validHomeValue)).address,
      "123 Louisiana Ave, Perrysburg, OH 43551");
  });

  test("identity fields map to HubSpot's internal names", () => {
    const props = toContactProperties(payloadOf(validHomeValue));
    assert.equal(props.email, "sam@example.com");
    assert.equal(props.firstname, "Sam");
    assert.equal(props.lastname, "Rivera");
    assert.equal(props.phone, "(419) 555-0000");
  });

  test("only the agreed standard properties are sent", () => {
    assert.deepEqual(Object.keys(toContactProperties(payloadOf(validHomeValue))).sort(),
      ["address", "email", "firstname", "lastname", DETAIL_PROPERTY, "phone"].sort());
  });

  test("a form with no address does not send `address` at all", () => {
    assert.ok(!("address" in toContactProperties(payloadOf(validContact))));
  });

  test("blank phone is omitted, never sent empty", () => {
    assert.ok(!("phone" in toContactProperties(payloadOf({ ...validContact, phone: "" }))));
  });

  test("a later address-less submission cannot erase a stored address", async () => {
    const calls = stubFetch({ [SEARCH]: hit("77"), [patchKey("77")]: { json: { id: "77" } } });
    await createLead(payloadOf(validContact));
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(!("address" in patch.body.properties),
      "the update carried an address key and would have erased the stored value");
  });

  test("a later phone-less submission cannot erase a stored phone", async () => {
    const calls = stubFetch({ [SEARCH]: hit("78"), [patchKey("78")]: { json: { id: "78" } } });
    await createLead(payloadOf({ ...validContact, phone: "" }));
    assert.ok(!("phone" in calls.find((c) => c.method === "PATCH").body.properties));
  });

  test("no custom or unscoped property is ever sent", () => {
    for (const k of Object.keys(toContactProperties(payloadOf(validHomeValue))))
      assert.ok(!k.startsWith("hs_") && !k.includes("__"), "unexpected property " + k);
  });
});


/* ===================================================================== */
describe("The contact summary replaces, and does not accumulate", () => {
  test("it carries the enquiry substance, not the tracking rows", () => {
    const summary = buildSummary(payloadOf({
      ...validHomeValue,
      attribution: {
        utm_source: "google", utm_medium: "cpc", utm_campaign: "brand",
        utm_term: "kw", utm_content: "ad-a", gclid: "GCLIDVALUE",
        gbraid: "GB1", wbraid: "WB1", fbclid: "FB1", msclkid: "MS1",
        landing_page: "/?utm_source=google", referrer: "https://www.google.com/",
        first_touch_at: "2026-08-30T10:00:00.000Z",
      },
    }, "csv_summary_test"));
    assert.ok(summary.includes("PROPERTY ADDRESS: 123 Louisiana Ave, Perrysburg, OH 43551"));
    assert.ok(summary.includes("SELLING TIMELINE: Within 3 months"));
    for (const noisy of ["UTM SOURCE", "UTM MEDIUM", "GCLID", "GBRAID", "MSCLKID",
                         "SUBMISSION ID", "REFERRER", "LANDING PAGE", "FIRST TOUCH",
                         "CURRENT PAGE", "SUBMITTED"])
      assert.ok(!summary.includes(noisy), "summary should not carry " + noisy);
    for (const v of ["GCLIDVALUE", "csv_summary_test", "https://www.google.com/"])
      assert.ok(!summary.includes(v), "summary leaked tracking value " + v);
  });

  test("the summary labels are a subset of the full block, in order", () => {
    assert.ok(SUMMARY_LABELS.length < DESCRIPTION_LABELS.length);
    const order = SUMMARY_LABELS.map((l) => DESCRIPTION_LABELS.indexOf(l));
    assert.ok(order.every((n) => n >= 0));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("a repeat submission REPLACES the summary rather than appending", async () => {
    let stored = null;
    stubFetch({
      [SEARCH]: hit("90"),
      [patchKey("90")]: (c) => { stored = c.body.properties[DETAIL_PROPERTY]; return { json: { id: "90" } }; },
    });
    await createLead(payloadOf({ ...validContact, message: "First enquiry." }, "csv_one"));
    const first = stored;
    await createLead(payloadOf({ ...validContact, message: "Second enquiry." }, "csv_two"));
    assert.ok(first.includes("First enquiry."));
    assert.ok(stored.includes("Second enquiry."));
    assert.ok(!stored.includes("First enquiry."),
      "the summary accumulated — history belongs on the timeline");
    assert.ok(!/earlier submission/i.test(stored));
  });

  test("the summary stays inside HubSpot's property limit", () => {
    const props = toContactProperties(payloadOf({
      ...validHomeValue, message: "m".repeat(4000), notes: "n".repeat(4000),
    }));
    assert.ok(Buffer.byteLength(props[DETAIL_PROPERTY]) <= DETAIL_MAX_BYTES);
  });
});


/* ===================================================================== */
describe("The form submission is the timeline activity", () => {
  test("it posts to the AUTHENTICATED secure endpoint on HubSpot's forms host", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    const f = formCall(calls);
    assert.ok(f, "no form submission was made");
    assert.equal(f.host, "api.hsforms.com");
    assert.equal(f.path, FORM_PATH);
    assert.match(f.path, /\/integration\/secure\/submit\//);
    assert.equal(f.method, "POST");
  });

  test("it authenticates with HUBSPOT_ACCESS_TOKEN as a bearer token", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    assert.equal(formCall(calls).headers.Authorization, "Bearer " + TOKEN);
  });

  test("the portal id and form guid come from the environment", async () => {
    process.env.HUBSPOT_PORTAL_ID = "999";
    process.env.HUBSPOT_FORM_GUID = "abc-def";
    const calls = stubFetch({
      [SEARCH]: noHits, [CREATE]: { json: { id: "1" } },
      "POST /submissions/v3/integration/secure/submit/999/abc-def": formOk,
    });
    await createLead(payloadOf(validContact));
    assert.equal(calls[calls.length - 1].path,
      "/submissions/v3/integration/secure/submit/999/abc-def");
  });

  test("exactly the six field names the HubSpot form defines", async () => {
    /* HubSpot validates a submission against the form definition and rejects
       anything carrying a field the form does not define. */
    assert.deepEqual(FORM_FIELDS, ["email", "firstname", "lastname", "phone", "address", "message"]);
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validHomeValue));
    const names = formCall(calls).body.fields.map((f) => f.name);
    assert.deepEqual([...names].sort(), [...FORM_FIELDS].sort());
    for (const n of names) assert.ok(FORM_FIELDS.includes(n), "undefined form field: " + n);
  });

  test("email is always submitted", async () => {
    for (const raw of [validContact, validHomeValue]) {
      _resetRateLimit();
      const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
      await createLead(payloadOf(raw));
      assert.ok(fieldMap(formCall(calls)).email, "email missing from the submission");
    }
  });

  test("blank phone and address are omitted from the submission", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf({ ...validContact, phone: "" }));   // contact form: no address
    const names = formCall(calls).body.fields.map((f) => f.name);
    assert.ok(!names.includes("phone"), "a blank phone was submitted and would erase the stored one");
    assert.ok(!names.includes("address"), "a blank address was submitted");
    assert.ok(names.includes("email") && names.includes("message"));
  });

  test("the submission carries the complete 23-row block in `message`", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf({
      ...validHomeValue,
      topic: "Listing consultation",
      message: "Please call after six.",
      attribution: {
        utm_source: "google", utm_medium: "cpc", utm_campaign: "brand",
        utm_term: "perrysburg realtor", utm_content: "ad-a",
        gclid: "GC1", gbraid: "GB1", wbraid: "WB1", fbclid: "FB1", msclkid: "MS1",
        landing_page: "/?utm_source=google", referrer: "https://www.google.com/",
        first_touch_at: "2026-08-30T10:00:00.000Z",
      },
    }, "csv_abc123"));

    const body = fieldMap(formCall(calls)).message;
    for (const label of DESCRIPTION_LABELS)
      assert.ok(body.includes(label + ":"), "submission missing row " + label);
    for (const value of [
      "home_value", "123 Louisiana Ave, Perrysburg, OH 43551", "Within 3 months",
      "Well maintained, some updates", "Listing consultation", "Please call after six.",
      "New roof in 2022.", "google", "cpc", "brand", "perrysburg realtor", "ad-a",
      "GC1", "GB1", "WB1", "FB1", "MS1", "/?utm_source=google",
      "https://www.google.com/", "2026-08-30T10:00:00.000Z", "csv_abc123",
    ]) assert.ok(body.includes(value), "submission lost " + value);
  });

  test("submittedAt is the server-side submission time in epoch ms", () => {
    const p = payloadOf(validHomeValue);
    const body = toFormSubmission(p);
    assert.equal(body.submittedAt, String(Date.parse(p.meta.submitted_at)));
    assert.match(body.submittedAt, /^\d{13}$/);
  });

  test("page context is sent as context, never as form fields", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validHomeValue));
    const body = formCall(calls).body;
    assert.ok(body.context, "no page context");
    assert.match(body.context.pageUri, /^https:\/\/www\.crystalsellstoledo\.com\//);
    assert.ok(body.context.pageName);
    const names = body.fields.map((f) => f.name);
    for (const k of ["pageUri", "pageName", "hutk"])
      assert.ok(!names.includes(k), k + " leaked into the form fields");
  });

  test("every field is typed as a contact field", () => {
    for (const f of toFormSubmission(payloadOf(validHomeValue)).fields)
      assert.equal(f.objectTypeId, "0-1");
  });

  test("the submission id reaches the activity", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    const r = await call(validContact);
    const sid = r.json().submission_id;
    assert.match(sid, /^csv_[0-9a-f]{24}$/);
    assert.ok(fieldMap(formCall(calls)).message.includes("SUBMISSION ID: " + sid));
  });

  test("attribution survives end to end onto the activity", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    assert.equal((await call(validContact)).statusCode, 200);
    const body = fieldMap(formCall(calls)).message;
    assert.ok(body.includes("UTM SOURCE: google"));
    assert.ok(body.includes("GCLID: abc123"));
    assert.ok(body.includes("FIRST TOUCH: 2026-08-30T10:00:00.000Z"));
  });

  test("a full-size lead stays inside HubSpot's field limit", () => {
    const big = payloadOf({
      ...validHomeValue,
      message: "m".repeat(4000), notes: "n".repeat(4000),
      property_address: "a".repeat(200), topic: "t".repeat(120),
      timeline: "l".repeat(120), condition: "c".repeat(120), page: "p".repeat(300),
      attribution: {
        landing_page: "L".repeat(500), referrer: "R".repeat(500),
        utm_source: "1".repeat(200), utm_medium: "2".repeat(200),
        utm_campaign: "3".repeat(200), utm_term: "4".repeat(200), utm_content: "5".repeat(200),
        gclid: "6".repeat(300), gbraid: "7".repeat(300), wbraid: "8".repeat(300),
        fbclid: "9".repeat(300), msclkid: "0".repeat(300), first_touch_at: "x".repeat(40),
      },
    });
    assert.ok(Buffer.byteLength(buildDescription(big)) < DETAIL_MAX_BYTES);
  });

  test("the contact is written BEFORE the form is submitted", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    const keys = calls.map((c) => c.key);
    assert.ok(keys.indexOf(CREATE) < keys.indexOf(FORM), "the form went first");
  });
});


/* ===================================================================== */
describe("A missing activity is never a success", () => {
  const withForm = (formRoute) => ({
    [SEARCH]: noHits, [CREATE]: { json: { id: "600" } }, [FORM]: formRoute,
  });

  test("Contacts API succeeds but the form fails: the lead fails", async () => {
    const calls = stubFetch(withForm({ status: 500, json: { message: "boom" } }));
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_FORM_SERVER_500/);
    assert.equal(countOf(calls, CREATE), 1, "the contact was still written");
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().ok, false);
    assert.ok(!("submission_id" in r.json()), "a contact with no activity is not a delivered lead");
  });

  const statuses = [
    [400, /HUBSPOT_FORM_REJECTED/],
    [401, /HUBSPOT_FORMS_SCOPE_OR_AUTH_401/],
    [403, /HUBSPOT_FORMS_SCOPE_OR_AUTH_403/],
    [429, /HUBSPOT_FORM_RATE_LIMITED/],
    [500, /HUBSPOT_FORM_SERVER_500/],
    [502, /HUBSPOT_FORM_SERVER_502/],
    [503, /HUBSPOT_FORM_SERVER_503/],
  ];
  for (const [status, pattern] of statuses) {
    test(`form ${status} fails the lead`, async () => {
      stubFetch(withForm({ status, json: { message: "nope" } }));
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    });
    test(`form ${status} becomes a 502 for the visitor`, async () => {
      stubFetch(withForm({ status, json: { message: "nope" } }));
      const r = await call(validContact);
      assert.equal(r.statusCode, 502);
      assert.equal(r.json().code, "DELIVERY_FAILED");
    });
  }

  for (const [name, bad] of [
    ["not JSON", { text: "<html>oops</html>" }],
    ["empty body", { text: "" }],
    ["a JSON array", { json: [] }],
  ]) {
    test("malformed form response - " + name, async () => {
      stubFetch(withForm(bad));
      await assert.rejects(() => createLead(payloadOf(validContact)),
        /HUBSPOT_FORM_MALFORMED_RESPONSE/);
    });
  }

  test("a network failure on the form fails the lead", async () => {
    stubFetch(withForm(new Error("ECONNRESET")));
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
  });

  test("the form is never retried by dropping the enquiry", async () => {
    const calls = stubFetch(withForm({ status: 500, json: { message: "boom" } }));
    await createLead(payloadOf(validContact)).catch(() => {});
    assert.equal(countOf(calls, FORM), 1, "silent retry");
    assert.ok(fieldMap(formCall(calls)).message.length > 0, "an empty enquiry was submitted");
  });

  test("a scope or auth problem is named, not left generic", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      stubFetch(withForm({ status: 403, json: { message: "forbidden" } }));
      await createLead(payloadOf(validContact)).catch(() => {});
    } finally { console.log = realLog; }
    const joined = lines.join("\n");
    assert.match(joined, /forms_scope_or_auth/);
    assert.match(joined, /action_required/);
  });

  test("a form-definition rejection names the expected fields", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      stubFetch(withForm({ status: 400, json: { message: "field not defined" } }));
      await createLead(payloadOf(validContact)).catch(() => {});
    } finally { console.log = realLog; }
    const joined = lines.join("\n");
    assert.match(joined, /form_rejected/);
    assert.match(joined, /email,firstname,lastname,phone,address,message/);
  });

  test("a retry after a form failure does not duplicate the contact", async () => {
    let formFails = true;
    const calls = stubFetch({
      [SEARCH]: (c, all) => (countOf(all, CREATE) === 0 ? noHits : hit("607")),
      [CREATE]: { json: { id: "607" } },
      [patchKey("607")]: { json: { id: "607" } },
      [FORM]: () => (formFails ? { status: 500, json: { message: "boom" } } : formOk),
    });
    await createLead(payloadOf(validContact, "csv_first")).catch(() => {});
    formFails = false;
    const out = await createLead(payloadOf(validContact, "csv_retry"));
    assert.equal(out.action, "update");
    assert.equal(countOf(calls, CREATE), 1, "the retry created a duplicate contact");
    assert.equal(countOf(calls, FORM), 2);
  });
});


/* ===================================================================== */
describe("Deduplication by email", () => {
  test("no existing contact: one create, one submission", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "900" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "create");
    assert.equal(countOf(calls, CREATE), 1);
    assert.equal(countOf(calls, FORM), 1);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  test("existing contact: one update, no create", async () => {
    const calls = stubFetch({ [SEARCH]: hit("321"), [patchKey("321")]: { json: { id: "321" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(countOf(calls, CREATE), 0);
    assert.equal(countOf(calls, FORM), 1);
  });

  test("the search filters on email with EQ", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    const f = calls[0].body.filterGroups[0].filters[0];
    assert.equal(f.propertyName, "email");
    assert.equal(f.operator, "EQ");
    assert.equal(f.value, "jane@example.com");
  });

  test("repeat email: ONE contact, TWO distinct submissions", async () => {
    const calls = stubFetch({
      [SEARCH]: (c, all) => (countOf(all, CREATE) === 0 ? noHits : hit("501")),
      [CREATE]: { json: { id: "501" } },
      [patchKey("501")]: { json: { id: "501" } },
    });
    const a = await createLead(payloadOf({ ...validContact, message: "First." }, "csv_a"));
    const b = await createLead(payloadOf({ ...validContact, message: "Second." }, "csv_b"));

    assert.equal(a.action, "create");
    assert.equal(b.action, "update");
    assert.equal(countOf(calls, CREATE), 1, "a repeat must not create a second contact");

    const subs = calls.filter((c) => c.key === FORM);
    assert.equal(subs.length, 2, "each submission needs its own activity");
    const bodies = subs.map((s) => fieldMap(s).message);
    assert.notEqual(bodies[0], bodies[1]);
    assert.ok(bodies[0].includes("First.") && bodies[0].includes("csv_a"));
    assert.ok(bodies[1].includes("Second.") && bodies[1].includes("csv_b"));
    for (const s of subs) assert.equal(fieldMap(s).email, "jane@example.com");
  });

  test("409 from create is folded into an update, and still submits", async () => {
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { message: "Contact already exists. Existing ID: 654321" } },
      [patchKey("654321")]: { json: { id: "654321" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(out.id, "654321");
    assert.equal(countOf(calls, CREATE), 1, "create must not be retried");
    assert.equal(countOf(calls, FORM), 1, "the conflict path still needs its activity");
  });

  test("409 with no parseable id falls back to the email-as-id path", async () => {
    const email = encodeURIComponent("jane@example.com");
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { message: "Contact already exists." } },
      [patchKey(email)]: { json: { id: "42" } },
    });
    assert.equal((await createLead(payloadOf(validContact))).action, "update");
    assert.match(calls.find((c) => c.method === "PATCH").search, /idProperty=email/);
    assert.equal(countOf(calls, FORM), 1);
  });

  test("parseConflictId reads the id HubSpot embeds in the message", () => {
    assert.equal(parseConflictId({ message: "Contact already exists. Existing ID: 2926551" }), "2926551");
    assert.equal(parseConflictId({ message: "Contact already exists." }), null);
    assert.equal(parseConflictId(null), null);
  });
});


/* ===================================================================== */
describe("Contacts API failures never become a silent success", () => {
  const cases = [
    ["401", 401, /HUBSPOT_SEARCH_AUTH_401/],
    ["403", 403, /HUBSPOT_SEARCH_AUTH_403/],
    ["429", 429, /HUBSPOT_SEARCH_RATE_LIMITED/],
    ["500", 500, /HUBSPOT_SEARCH_SERVER_500/],
  ];
  for (const [name, status, pattern] of cases) {
    test("lookup " + name + " throws and never submits the form", async () => {
      const calls = stubFetch({ [SEARCH]: { status, json: { message: "nope" } } });
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
      assert.equal(countOf(calls, FORM), 0, "the form was submitted despite no contact");
    });
    test("lookup " + name + " becomes a 502", async () => {
      stubFetch({ [SEARCH]: { status, json: { message: "nope" } } });
      const r = await call(validContact);
      assert.equal(r.statusCode, 502);
      assert.ok(!("submission_id" in r.json()));
    });
  }

  test("classify maps status codes to stable tokens", () => {
    assert.equal(classify(401), "AUTH_401");
    assert.equal(classify(429), "RATE_LIMITED");
    assert.equal(classify(500), "SERVER_500");
    assert.equal(classify(400), "HTTP_400");
  });

  test("create failure throws and reports failure", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: { status: 500, json: { message: "boom" } } });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_CREATE_SERVER_500/);
    assert.equal((await call(validContact)).statusCode, 502);
  });

  test("update failure throws and reports failure", async () => {
    stubFetch({ [SEARCH]: hit("55"), [patchKey("55")]: { status: 500, json: { message: "boom" } } });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_UPDATE_SERVER_500/);
  });

  const malformed = [
    ["search: no results array", { [SEARCH]: { json: { total: 0 } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: not JSON", { [SEARCH]: { text: "<html>502</html>" } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: hit with no id", { [SEARCH]: { json: { results: [{ properties: {} }] } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["create: no id returned", { [SEARCH]: noHits, [CREATE]: { json: { properties: {} } } }, /HUBSPOT_CREATE_MALFORMED_RESPONSE/],
    ["update: no id returned", { [SEARCH]: hit("9"), [patchKey("9")]: { json: {} } }, /HUBSPOT_UPDATE_MALFORMED_RESPONSE/],
  ];
  for (const [name, routes, pattern] of malformed) {
    test("malformed contact response - " + name, async () => {
      stubFetch(routes);
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    });
  }

  test("a rejected `message` property fails rather than dropping the enquiry", async () => {
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 400, json: { category: "VALIDATION_ERROR", message: 'Property "message" does not exist' } },
    });
    await assert.rejects(() => createLead(payloadOf(validContact)),
      /HUBSPOT_DETAIL_PROPERTY_UNAVAILABLE/);
    assert.equal(countOf(calls, CREATE), 1, "must NOT retry without the enquiry detail");
  });

  test("an unrelated 400 is not mistaken for a detail-property problem", async () => {
    stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 400, json: { message: "Invalid email address", category: "VALIDATION_ERROR" } },
    });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_CREATE_HTTP_400/);
  });
});


/* ===================================================================== */
describe("Existing guarantees still hold", () => {
  test("the honeypot never reaches HubSpot", async () => {
    const calls = stubFetch({ "*": noHits });
    const r = await call({ ...validContact, _gotcha: "bot" });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "REJECTED");
    assert.equal(calls.length, 0);
  });

  test("overlength fields are rejected before any CRM call", async () => {
    for (const [field, max] of [["first_name", 40], ["last_name", 80], ["phone", 30]]) {
      _resetRateLimit();
      const calls = stubFetch({ "*": noHits });
      const r = await call({ ...validContact, [field]: "A".repeat(max + 1) });
      assert.equal(r.statusCode, 422, field);
      assert.equal(calls.length, 0);
    }
  });

  test("an overlength address is rejected, not truncated", async () => {
    const calls = stubFetch({ "*": noHits });
    assert.equal((await call({ ...validHomeValue, property_address: "A".repeat(201) })).statusCode, 422);
    assert.equal(calls.length, 0);
  });

  test("a bad origin never reaches HubSpot", async () => {
    const calls = stubFetch({ "*": noHits });
    const req = mockReq({ body: validContact, headers: { origin: "https://evil.example" } });
    const r = mockRes();
    const p = handler(req, r);
    req.emit("data", Buffer.from(req.body));
    req.emit("end");
    await p;
    assert.equal(r.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  test("success keeps the documented response contract", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    const r = await call(validContact);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(Object.keys(r.json()).sort(), ["ok", "submission_id"]);
    assert.equal(r.headers["cache-control"], "no-store");
  });
});


/* ===================================================================== */
describe("The token never escapes the server", () => {
  test("it is a bearer header on every call and nowhere else", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    assert.ok(calls.length >= 3);
    for (const c of calls) {
      assert.equal(c.headers.Authorization, "Bearer " + TOKEN);
      assert.ok(!JSON.stringify(c.body || {}).includes(TOKEN), "token in a body");
      assert.ok(!c.path.includes(TOKEN) && !c.search.includes(TOKEN), "token in a URL");
    }
  });

  test("no response body carries the token", async () => {
    const bodies = [];
    for (const routes of [
      { [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } },
      { [SEARCH]: { status: 401, json: { message: "bad token " + TOKEN } } },
      { [SEARCH]: noHits, [CREATE]: { json: { id: "1" } }, [FORM]: { status: 500, json: { message: TOKEN } } },
    ]) {
      _resetRateLimit();
      stubFetch(routes);
      bodies.push((await call(validContact)).body);
    }
    for (const b of bodies)
      for (const s of [TOKEN, "HUBSPOT_ACCESS_TOKEN", "Bearer ", "pat-na1"])
        assert.ok(!b.includes(s), "response leaked " + s);
  });

  test("a thrown error never carries the token", async () => {
    stubFetch({ [SEARCH]: { status: 401, json: { message: "invalid: " + TOKEN } } });
    await createLead(payloadOf(validContact)).then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.ok(!err.message.includes(TOKEN));
        assert.ok(!String(err.stack).includes(TOKEN));
      },
    );
  });

  test("logs carry no token and no lead PII", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
      await call(validContact);
    } finally { console.log = realLog; }
    const joined = lines.join("\n");
    assert.ok(lines.length > 0);
    for (const s of [TOKEN, "pat-na1", "jane@example.com", "Jane", "4195551234",
                     "I would like to talk about selling."])
      assert.ok(!joined.includes(s), "log leaked " + s);
    assert.match(joined, /lead\.delivered/);
    assert.match(joined, /hubspot\.form\.submitted/);
  });

  test("a HubSpot body echoing lead values never reaches an error message", async () => {
    stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 400, json: { message: "Invalid input: jane@example.com / Jane Doe" } },
    });
    await createLead(payloadOf(validContact)).then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.ok(!err.message.includes("jane@example.com"));
        assert.equal(err.message, "HUBSPOT_CREATE_HTTP_400");
      },
    );
  });

  test("the browser bundle references no HubSpot secret or identifier", async () => {
    const { readFileSync } = await import("node:fs");
    const js = readFileSync(new URL("../assets/js/main.js", import.meta.url), "utf8");
    for (const s of ["HUBSPOT_ACCESS_TOKEN", "hubapi.com", "hsforms.com", "pat-na1", PORTAL, GUID])
      assert.ok(!js.includes(s), "main.js leaks " + s);
  });
});


/* ===================================================================== */
describe("findContactByEmail in isolation", () => {
  test("returns null when nothing matches", async () => {
    stubFetch({ [SEARCH]: noHits });
    assert.equal(await findContactByEmail("nobody@example.com"), null);
  });

  test("returns the id when it matches", async () => {
    stubFetch({ [SEARCH]: hit("13") });
    assert.deepEqual(await findContactByEmail("jane@example.com"), { id: "13" });
  });
});
