/* HubSpot delivery path.
 *
 * Every test here runs against a stubbed global fetch. No network, no HubSpot
 * portal, no token. That is the point and also the limit: these tests prove
 * how the client behaves against HubSpot's documented contract, NOT that a
 * real portal accepts the payload. Only a live submission proves that.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler from "../api/lead.js";
import {
  createLead, isConfigured, toContactProperties, composeDetail, classify,
  parseConflictId, findContactByEmail, DETAIL_PROPERTY, DETAIL_MAX_BYTES,
} from "../api/_lib/hubspot.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { buildDescription, DESCRIPTION_LABELS } from "../api/_lib/description.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { mockReq, mockRes, validContact, validHomeValue } from "./helpers.mjs";

const TOKEN = "pat-na1-TESTTOKEN-must-never-appear-anywhere";
const realFetch = globalThis.fetch;

/* --- fetch stub -------------------------------------------------------- */

function res({ status = 200, json = null, text = null }) {
  const body = text !== null ? text : json === null ? "" : JSON.stringify(json);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

/** routes: { "POST /crm/v3/objects/contacts/search": response|fn } */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || "GET";
    const key = method + " " + u.pathname;
    const call = {
      key, method, path: u.pathname, search: u.search,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const route = routes[key] || routes["*"];
    if (!route) throw new Error("unstubbed call: " + key);
    const out = typeof route === "function" ? route(call, calls) : route;
    if (out instanceof Error) throw out;
    return res(out);
  };
  return calls;
}

const countOf = (calls, key) => calls.filter((c) => c.key === key).length;

const SEARCH = "POST /crm/v3/objects/contacts/search";
const CREATE = "POST /crm/v3/objects/contacts";
const patchKey = (id) => "PATCH /crm/v3/objects/contacts/" + id;

const noHits = { json: { total: 0, results: [] } };
const hit = (id, detail = "") => ({
  json: { total: 1, results: [{ id, properties: { email: "x@y.co", [DETAIL_PROPERTY]: detail } }] },
});

function payloadOf(raw, sid = "csv_test000000000000000000") {
  const p = validateLead(raw);
  p.meta.submission_id = sid;
  return p;
}

beforeEach(() => {
  process.env.HUBSPOT_ACCESS_TOKEN = TOKEN;
  _resetRateLimit();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
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
  test("isConfigured needs only HUBSPOT_ACCESS_TOKEN", () => {
    assert.equal(isConfigured(), true);
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    assert.equal(isConfigured(), false);
  });

  test("no Zoho variable can satisfy the HubSpot check", () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    process.env.ZOHO_CLIENT_ID = "x";
    process.env.ZOHO_CLIENT_SECRET = "y";
    process.env.ZOHO_REFRESH_TOKEN = "z";
    assert.equal(isConfigured(), false, "Zoho credentials must not enable the HubSpot path");
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
    delete process.env.ZOHO_REFRESH_TOKEN;
  });

  test("missing token: 503, no CRM call, and no claim of success", async () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const calls = stubFetch({ "*": noHits });
    const r = await call(validContact);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().ok, false);
    assert.equal(r.json().code, "NOT_CONFIGURED");
    assert.ok(!("submission_id" in r.json()));
    assert.equal(calls.length, 0, "must not reach HubSpot with no token");
  });
});


/* ===================================================================== */
describe("Contact property mapping", () => {
  test("only the agreed standard properties are sent", () => {
    const props = toContactProperties(payloadOf(validHomeValue), "BLOCK");
    assert.deepEqual(Object.keys(props).sort(),
      ["email", "firstname", "lastname", DETAIL_PROPERTY, "phone"].sort());
  });

  test("identity fields map to HubSpot's internal names", () => {
    const props = toContactProperties(payloadOf(validHomeValue), "BLOCK");
    assert.equal(props.email, "sam@example.com");
    assert.equal(props.firstname, "Sam");
    assert.equal(props.lastname, "Rivera");
    assert.equal(props.phone, "(419) 555-0000");
  });

  test("blank phone is omitted, never sent empty", () => {
    /* An empty string on a PATCH blanks a number HubSpot already holds. */
    const props = toContactProperties(payloadOf({ ...validContact, phone: "" }), "BLOCK");
    assert.ok(!("phone" in props), "empty phone must not be sent");
  });

  test("no custom or unscoped property is ever sent", () => {
    const props = toContactProperties(payloadOf(validHomeValue), "BLOCK");
    for (const k of Object.keys(props))
      assert.ok(!k.startsWith("hs_") && !k.includes("__"), "unexpected property " + k);
  });
});


/* ===================================================================== */
describe("The enquiry detail survives the migration", () => {
  const detailOf = (calls, key) => calls.find((c) => c.key === key).body.properties[DETAIL_PROPERTY];

  test("every documented lead field reaches the detail property", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "501" } } });
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

    const detail = detailOf(calls, CREATE);
    for (const label of DESCRIPTION_LABELS)
      assert.ok(detail.includes(label + ":"), "missing row " + label);
    for (const v of [
      "home_value", "123 Louisiana Ave, Perrysburg, OH 43551", "Within 3 months",
      "Well maintained, some updates", "Listing consultation", "Please call after six.",
      "New roof in 2022.", "google", "cpc", "brand", "perrysburg realtor", "ad-a",
      "GC1", "GB1", "WB1", "FB1", "MS1", "/?utm_source=google",
      "https://www.google.com/", "2026-08-30T10:00:00.000Z", "csv_abc123",
    ]) assert.ok(detail.includes(v), "detail lost value: " + v);
  });

  test("attribution is preserved end to end through the handler", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "502" } } });
    const r = await call(validContact);
    assert.equal(r.statusCode, 200);
    const detail = detailOf(calls, CREATE);
    assert.ok(detail.includes("UTM SOURCE: google"));
    assert.ok(detail.includes("UTM MEDIUM: cpc"));
    assert.ok(detail.includes("UTM CAMPAIGN: brand"));
    assert.ok(detail.includes("GCLID: abc123"));
    assert.ok(detail.includes("REFERRER: https://www.google.com/"));
    assert.ok(detail.includes("FIRST TOUCH: 2026-08-30T10:00:00.000Z"));
    assert.ok(detail.includes("LANDING PAGE: /?utm_source=google"));
  });

  test("the submission id in the response is the one written to HubSpot", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "503" } } });
    const r = await call(validContact);
    const sid = r.json().submission_id;
    assert.match(sid, /^csv_[0-9a-f]{24}$/);
    assert.ok(detailOf(calls, CREATE).includes("SUBMISSION ID: " + sid));
  });

  test("a full-size lead stays inside HubSpot's property limit", () => {
    /* Worst case the validator permits, so the cap can never be the thing
       that loses a legitimate enquiry. */
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
    const block = buildDescription(big);
    assert.ok(Buffer.byteLength(block) < DETAIL_MAX_BYTES,
      "one maximal lead is " + Buffer.byteLength(block) + " bytes");
  });
});


/* ===================================================================== */
describe("Detail history is appended, not overwritten", () => {
  test("an update keeps the previous enquiry and puts the newest first", () => {
    const out = composeDetail("NEW BLOCK", "OLD BLOCK");
    assert.ok(out.includes("NEW BLOCK"));
    assert.ok(out.includes("OLD BLOCK"));
    assert.ok(out.indexOf("NEW BLOCK") < out.indexOf("OLD BLOCK"), "newest must be first");
  });

  test("a first submission carries no separator noise", () => {
    assert.equal(composeDetail("ONLY", ""), "ONLY");
  });

  test("repeated submissions accumulate rather than replace", () => {
    let stored = "";
    for (const n of ["ONE", "TWO", "THREE"]) stored = composeDetail(n, stored);
    for (const n of ["ONE", "TWO", "THREE"]) assert.ok(stored.includes(n), "lost " + n);
    assert.ok(stored.indexOf("THREE") < stored.indexOf("TWO"));
    assert.ok(stored.indexOf("TWO") < stored.indexOf("ONE"));
  });

  test("over the byte cap the OLDEST is dropped and the trim is announced", () => {
    const chunk = "X".repeat(20000);
    let stored = "";
    for (let i = 0; i < 6; i++) stored = composeDetail("ENTRY" + i + " " + chunk, stored);
    assert.ok(Buffer.byteLength(stored) <= DETAIL_MAX_BYTES, "cap exceeded");
    assert.ok(stored.includes("ENTRY5"), "the newest submission must always survive");
    assert.ok(!stored.includes("ENTRY0"), "the oldest should have been dropped");
    assert.match(stored, /trimmed to fit the HubSpot property limit/,
      "trimming must never be silent");
  });

  test("the submission in hand is never the one discarded", () => {
    const huge = "Z".repeat(DETAIL_MAX_BYTES * 2);
    const out = composeDetail("KEEPME", huge);
    assert.ok(out.startsWith("KEEPME"));
    assert.ok(Buffer.byteLength(out) <= DETAIL_MAX_BYTES);
  });
});


/* ===================================================================== */
describe("Deduplication by email", () => {
  test("no existing contact: one create, no update", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "900" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "create");
    assert.equal(out.id, "900");
    assert.equal(countOf(calls, CREATE), 1);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  test("existing contact: one update, no create", async () => {
    const calls = stubFetch({
      [SEARCH]: hit("321", "PRIOR ENQUIRY"),
      [patchKey("321")]: { json: { id: "321" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(out.id, "321");
    assert.equal(countOf(calls, CREATE), 0, "must not create over an existing contact");
    const body = calls.find((c) => c.method === "PATCH").body;
    assert.ok(body.properties[DETAIL_PROPERTY].includes("PRIOR ENQUIRY"),
      "the earlier enquiry must survive the update");
  });

  test("the search filters on email with EQ", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    const f = calls[0].body.filterGroups[0].filters[0];
    assert.equal(f.propertyName, "email");
    assert.equal(f.operator, "EQ");
    assert.equal(f.value, "jane@example.com");
    assert.ok(calls[0].body.properties.includes(DETAIL_PROPERTY),
      "the search must fetch prior detail so an update can append to it");
  });

  test("two submissions from one email leave exactly one contact", async () => {
    let stored = "";
    let created = 0;
    const calls = stubFetch({
      [SEARCH]: () => (created === 0 ? noHits : hit("777", stored)),
      [CREATE]: (c) => { created++; stored = c.body.properties[DETAIL_PROPERTY]; return { json: { id: "777" } }; },
      [patchKey("777")]: (c) => { stored = c.body.properties[DETAIL_PROPERTY]; return { json: { id: "777" } }; },
    });

    const a = await createLead(payloadOf({ ...validContact, message: "First enquiry." }, "csv_one"));
    const b = await createLead(payloadOf({ ...validContact, message: "Second enquiry." }, "csv_two"));

    assert.equal(a.action, "create");
    assert.equal(b.action, "update");
    assert.equal(a.id, b.id, "the same contact");
    assert.equal(countOf(calls, CREATE), 1, "a repeat submission must not create a second contact");
    assert.ok(stored.includes("First enquiry."), "the first enquiry was overwritten");
    assert.ok(stored.includes("Second enquiry."));
    assert.ok(stored.includes("csv_one") && stored.includes("csv_two"));
  });

  test("409 from create is folded into an update, not a duplicate", async () => {
    /* HubSpot enforces email uniqueness. The search index can lag a very
       recent write, so create can still conflict - that must not surface as
       a failure, and must never become a second contact. */
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { status: "error", message: "Contact already exists. Existing ID: 654321", category: "CONFLICT" } },
      "GET /crm/v3/objects/contacts/654321": { json: { id: "654321", properties: { [DETAIL_PROPERTY]: "EARLIER" } } },
      [patchKey("654321")]: { json: { id: "654321" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(out.id, "654321");
    assert.equal(countOf(calls, CREATE), 1, "create must not be retried");
    const body = calls.find((c) => c.method === "PATCH").body;
    assert.ok(body.properties[DETAIL_PROPERTY].includes("EARLIER"));
  });

  test("409 with no parseable id falls back to the documented email-as-id path", async () => {
    const email = encodeURIComponent("jane@example.com");
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { status: "error", message: "Contact already exists.", category: "CONFLICT" } },
      ["GET /crm/v3/objects/contacts/" + email]: { json: { id: "42", properties: {} } },
      [patchKey(email)]: { json: { id: "42" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    const patch = calls.find((c) => c.method === "PATCH");
    assert.match(patch.search, /idProperty=email/, "must identify the contact by email");
  });

  test("parseConflictId reads the id HubSpot embeds in the message", () => {
    assert.equal(parseConflictId({ message: "Contact already exists. Existing ID: 2926551" }), "2926551");
    assert.equal(parseConflictId({ message: "Contact already exists." }), null);
    assert.equal(parseConflictId(null), null);
  });
});


/* ===================================================================== */
describe("HubSpot failures never become a silent success", () => {
  const cases = [
    ["401 unauthorized", 401, /HUBSPOT_SEARCH_AUTH_401/],
    ["403 forbidden", 403, /HUBSPOT_SEARCH_AUTH_403/],
    ["429 rate limited", 429, /HUBSPOT_SEARCH_RATE_LIMITED/],
    ["500 server error", 500, /HUBSPOT_SEARCH_SERVER_500/],
    ["502 bad gateway", 502, /HUBSPOT_SEARCH_SERVER_502/],
    ["503 unavailable", 503, /HUBSPOT_SEARCH_SERVER_503/],
  ];

  for (const [name, status, pattern] of cases) {
    test("lookup " + name + " throws", async () => {
      stubFetch({ [SEARCH]: { status, json: { status: "error", message: "nope" } } });
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    });

    test("lookup " + name + " becomes a 502 for the visitor", async () => {
      stubFetch({ [SEARCH]: { status, json: { status: "error", message: "nope" } } });
      const r = await call(validContact);
      assert.equal(r.statusCode, 502);
      assert.equal(r.json().ok, false);
      assert.equal(r.json().code, "DELIVERY_FAILED");
      assert.ok(!("submission_id" in r.json()), "a failed delivery must not look delivered");
    });
  }

  test("classify maps status codes to stable tokens", () => {
    assert.equal(classify(401), "AUTH_401");
    assert.equal(classify(403), "AUTH_403");
    assert.equal(classify(429), "RATE_LIMITED");
    assert.equal(classify(500), "SERVER_500");
    assert.equal(classify(400), "HTTP_400");
  });

  test("create failure throws and reports failure", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: { status: 500, json: { message: "boom" } } });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_CREATE_SERVER_500/);
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
  });

  test("update failure throws and reports failure", async () => {
    stubFetch({ [SEARCH]: hit("55"), [patchKey("55")]: { status: 500, json: { message: "boom" } } });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_UPDATE_SERVER_500/);
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
  });

  test("create rate limit throws distinctly", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: { status: 429, json: { message: "slow down" } } });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_CREATE_RATE_LIMITED/);
  });

  test("a network-level failure surfaces as a 502, not a success", async () => {
    stubFetch({ [SEARCH]: new Error("ECONNRESET") });
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().ok, false);
  });

  const malformed = [
    ["search: no results array", { [SEARCH]: { json: { total: 0 } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: not JSON at all", { [SEARCH]: { text: "<html>502</html>" } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: empty body", { [SEARCH]: { text: "" } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: hit with no id", { [SEARCH]: { json: { results: [{ properties: {} }] } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["create: no id returned", { [SEARCH]: noHits, [CREATE]: { json: { properties: {} } } }, /HUBSPOT_CREATE_MALFORMED_RESPONSE/],
    ["create: not JSON", { [SEARCH]: noHits, [CREATE]: { text: "ok" } }, /HUBSPOT_CREATE_MALFORMED_RESPONSE/],
    ["update: no id returned", { [SEARCH]: hit("9"), [patchKey("9")]: { json: {} } }, /HUBSPOT_UPDATE_MALFORMED_RESPONSE/],
  ];

  for (const [name, routes, pattern] of malformed) {
    test("malformed response - " + name, async () => {
      stubFetch(routes);
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    });
  }

  test("a 200 with a malformed body still fails the visitor's submission", async () => {
    stubFetch({ [SEARCH]: { json: { total: 0 } } });
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().ok, false);
  });
});


/* ===================================================================== */
describe("The enquiry detail is never silently discarded", () => {
  const rejection = {
    status: 400,
    json: {
      status: "error", category: "VALIDATION_ERROR",
      message: 'Property "message" does not exist',
    },
  };

  test("a rejected detail property fails the lead instead of dropping it", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: rejection });
    await assert.rejects(() => createLead(payloadOf(validContact)),
      /HUBSPOT_DETAIL_PROPERTY_UNAVAILABLE/);
    assert.equal(countOf(calls, CREATE), 1,
      "must NOT retry without the enquiry detail - that would save a contact " +
      "with the whole enquiry silently missing");
  });

  test("the visitor sees a failure, not a false success", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: rejection });
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().ok, false);
  });

  test("an unrelated 400 is not mistaken for a detail-property problem", async () => {
    stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 400, json: { message: "Invalid email address", category: "VALIDATION_ERROR" } },
    });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_CREATE_HTTP_400/);
  });

  test("the operator is told exactly what to fix", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      stubFetch({ [SEARCH]: noHits, [CREATE]: rejection });
      await createLead(payloadOf(validContact)).catch(() => {});
    } finally { console.log = realLog; }
    const joined = lines.join("\n");
    assert.match(joined, /detail_property_unavailable/);
    assert.match(joined, /action_required/);
    assert.ok(joined.includes(DETAIL_PROPERTY));
  });
});


/* ===================================================================== */
describe("Existing guarantees still hold on the HubSpot path", () => {
  test("the honeypot never reaches HubSpot", async () => {
    const calls = stubFetch({ "*": noHits });
    const r = await call({ ...validContact, _gotcha: "bot" });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "REJECTED");
    assert.equal(calls.length, 0, "a honeypot hit must not touch the CRM");
  });

  test("overlength fields are rejected before any CRM call", async () => {
    for (const [field, max] of [["first_name", 40], ["last_name", 80], ["phone", 30]]) {
      _resetRateLimit();
      const calls = stubFetch({ "*": noHits });
      const r = await call({ ...validContact, [field]: "A".repeat(max + 1) });
      assert.equal(r.statusCode, 422, field);
      assert.equal(r.json().code, "FIELD_TOO_LONG");
      assert.equal(calls.length, 0, field + " reached HubSpot despite being overlength");
    }
  });

  test("an overlength email is rejected, never truncated into a wrong address", async () => {
    const calls = stubFetch({ "*": noHits });
    const r = await call({ ...validContact, email: "a".repeat(100) + "@example.com" });
    assert.equal(r.statusCode, 422);
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
    assert.equal(r.json().ok, true);
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(r.headers["cache-control"], "no-store");
  });
});


/* ===================================================================== */
describe("The token never escapes the server", () => {
  test("it is sent as a bearer header and nowhere else", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    for (const c of calls) {
      assert.equal(c.headers.Authorization, "Bearer " + TOKEN);
      assert.ok(!JSON.stringify(c.body || {}).includes(TOKEN), "token in a request body");
      assert.ok(!c.path.includes(TOKEN) && !c.search.includes(TOKEN), "token in a URL");
    }
  });

  test("no response body carries the token or its variable name", async () => {
    const bodies = [];
    for (const routes of [
      { [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } },
      { [SEARCH]: { status: 401, json: { message: "bad token " + TOKEN } } },
      { [SEARCH]: { status: 500, json: { message: TOKEN } } },
    ]) {
      _resetRateLimit();
      stubFetch(routes);
      bodies.push((await call(validContact)).body);
    }
    for (const b of bodies)
      for (const s of [TOKEN, "HUBSPOT_ACCESS_TOKEN", "Bearer ", "pat-na1"])
        assert.ok(!b.includes(s), "response leaked " + s);
  });

  test("a thrown error never carries the token, even when HubSpot echoes it", async () => {
    stubFetch({ [SEARCH]: { status: 401, json: { message: "invalid: " + TOKEN } } });
    await createLead(payloadOf(validContact)).then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.ok(!err.message.includes(TOKEN), "token in the error message");
        assert.ok(!String(err.stack).includes(TOKEN), "token in the stack");
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
    assert.ok(lines.length > 0, "nothing was logged");
    for (const s of [TOKEN, "pat-na1", "jane@example.com", "Jane", "4195551234",
                     "I would like to talk about selling."])
      assert.ok(!joined.includes(s), "log leaked " + s);
    assert.match(joined, /lead\.delivered/);
  });

  test("the HubSpot response body is never propagated into an error", async () => {
    /* HubSpot echoes submitted values back in validation errors, so a body
       pasted into an Error would put lead PII into the logs. */
    stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 400, json: { message: "Invalid input: jane@example.com / Jane Doe" } },
    });
    await createLead(payloadOf(validContact)).then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.ok(!err.message.includes("jane@example.com"));
        assert.ok(!err.message.includes("Jane"));
        assert.equal(err.message, "HUBSPOT_CREATE_HTTP_400");
      },
    );
  });

  test("the browser bundle references no HubSpot secret", async () => {
    const { readFileSync } = await import("node:fs");
    const js = readFileSync(new URL("../assets/js/main.js", import.meta.url), "utf8");
    for (const s of ["HUBSPOT_ACCESS_TOKEN", "hubapi.com", "pat-na1", "Bearer "])
      assert.ok(!js.includes(s), "main.js leaks " + s);
  });
});


/* ===================================================================== */
describe("findContactByEmail in isolation", () => {
  test("returns null when nothing matches", async () => {
    stubFetch({ [SEARCH]: noHits });
    assert.equal(await findContactByEmail("nobody@example.com"), null);
  });

  test("returns the id and the stored detail when it matches", async () => {
    stubFetch({ [SEARCH]: hit("13", "OLD") });
    assert.deepEqual(await findContactByEmail("jane@example.com"), { id: "13", detail: "OLD" });
  });

  test("a contact with no stored detail yields an empty string, not undefined", async () => {
    stubFetch({ [SEARCH]: { json: { results: [{ id: "14", properties: {} }] } } });
    assert.deepEqual(await findContactByEmail("jane@example.com"), { id: "14", detail: "" });
  });
});
