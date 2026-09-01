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
  createLead, isConfigured, toContactProperties, toNoteRecord, classify,
  parseConflictId, findContactByEmail, DETAIL_PROPERTY, DETAIL_MAX_BYTES,
  NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
} from "../api/_lib/hubspot.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { buildDescription, buildSummary, DESCRIPTION_LABELS, SUMMARY_LABELS }
  from "../api/_lib/description.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { mockReq, mockRes, validContact, validHomeValue } from "./helpers.mjs";

const TOKEN = "pat-na1-TESTTOKEN-must-never-appear-anywhere";
const realFetch = globalThis.fetch;

/* --- fetch stub -------------------------------------------------------- */

function res({ status = 200, json = null, text = null }) {
  const body = text !== null ? text : json === null ? "" : JSON.stringify(json);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

const SEARCH = "POST /crm/v3/objects/contacts/search";
const CREATE = "POST /crm/v3/objects/contacts";
const NOTES = "POST /crm/v3/objects/notes";
const patchKey = (id) => "PATCH /crm/v3/objects/contacts/" + id;

/** A note that succeeds. Association is not echoed, which HubSpot may omit. */
let noteSeq = 0;
const noteOk = () => ({ json: { id: "note_" + ++noteSeq } });

function stubFetch(routes) {
  const calls = [];
  /* The note route succeeds unless a test overrides it, so contact-path
     tests stay about the contact path. */
  const all = Object.assign({ [NOTES]: noteOk }, routes);
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
    assert.equal(r.json().code, "NOT_CONFIGURED");
    assert.ok(!("submission_id" in r.json()));
    assert.equal(calls.length, 0, "must not reach HubSpot with no token");
  });
});


/* ===================================================================== */
describe("Standard contact field mapping", () => {
  test("the property address maps to HubSpot's standard `address`", () => {
    const props = toContactProperties(payloadOf(validHomeValue));
    assert.equal(props.address, "123 Louisiana Ave, Perrysburg, OH 43551");
  });

  test("identity fields map to HubSpot's internal names", () => {
    const props = toContactProperties(payloadOf(validHomeValue));
    assert.equal(props.email, "sam@example.com");
    assert.equal(props.firstname, "Sam");
    assert.equal(props.lastname, "Rivera");
    assert.equal(props.phone, "(419) 555-0000");
  });

  test("only the agreed standard properties are sent", () => {
    const props = toContactProperties(payloadOf(validHomeValue));
    assert.deepEqual(Object.keys(props).sort(),
      ["address", "email", "firstname", "lastname", DETAIL_PROPERTY, "phone"].sort());
  });

  test("a form with no address does not send `address` at all", () => {
    /* Sending "" would blank the address HubSpot already holds. */
    const props = toContactProperties(payloadOf(validContact));
    assert.ok(!("address" in props), "blank address must be omitted, not sent empty");
  });

  test("a later address-less submission cannot erase a stored address", async () => {
    const calls = stubFetch({ [SEARCH]: hit("77"), [patchKey("77")]: { json: { id: "77" } } });
    await createLead(payloadOf(validContact));           // contact form: no address
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(!("address" in patch.body.properties),
      "the update carried an address key and would have erased the stored value");
    await createLead(payloadOf(validContact));
  });

  test("blank phone is still omitted, never sent empty", () => {
    const props = toContactProperties(payloadOf({ ...validContact, phone: "" }));
    assert.ok(!("phone" in props), "empty phone must not be sent");
  });

  test("a later phone-less submission cannot erase a stored phone", async () => {
    const calls = stubFetch({ [SEARCH]: hit("78"), [patchKey("78")]: { json: { id: "78" } } });
    await createLead(payloadOf({ ...validContact, phone: "" }));
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(!("phone" in patch.body.properties));
  });

  test("no custom or unscoped property is ever sent", () => {
    const props = toContactProperties(payloadOf(validHomeValue));
    for (const k of Object.keys(props))
      assert.ok(!k.startsWith("hs_") && !k.includes("__"), "unexpected property " + k);
  });
});


/* ===================================================================== */
describe("The contact summary is short and is replaced, not accumulated", () => {
  test("it carries the enquiry substance, not the tracking rows", () => {
    /* Attribution MUST be populated here. With a blank payload the tracking
       rows are dropped as empty anyway, so this test would pass even if they
       were wrongly flagged for the summary. */
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
    assert.ok(summary.includes("NOTES: New roof in 2022."));
    for (const noisy of ["UTM SOURCE", "UTM MEDIUM", "UTM CAMPAIGN", "UTM TERM",
                         "UTM CONTENT", "GCLID", "GBRAID", "WBRAID", "FBCLID", "MSCLKID",
                         "SUBMISSION ID", "REFERRER", "LANDING PAGE", "FIRST TOUCH",
                         "CURRENT PAGE", "SUBMITTED"])
      assert.ok(!summary.includes(noisy), summary + "\n^ summary should not carry " + noisy);
    /* And not their values either. */
    for (const v of ["GCLIDVALUE", "csv_summary_test", "https://www.google.com/"])
      assert.ok(!summary.includes(v), "summary leaked tracking value " + v);
  });

  test("the summary labels are a subset of the full block, in the same order", () => {
    assert.ok(SUMMARY_LABELS.length < DESCRIPTION_LABELS.length);
    for (const l of SUMMARY_LABELS) assert.ok(DESCRIPTION_LABELS.includes(l), l);
    const order = SUMMARY_LABELS.map((l) => DESCRIPTION_LABELS.indexOf(l));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("blank fields are dropped from the summary", () => {
    const summary = buildSummary(payloadOf(validContact));
    assert.ok(!/:\s*-\s*$/m.test(summary), "summary should not carry empty placeholder rows");
  });

  test("a repeat submission REPLACES the summary rather than appending", async () => {
    let stored = null;
    const calls = stubFetch({
      [SEARCH]: hit("90"),
      [patchKey("90")]: (c) => { stored = c.body.properties[DETAIL_PROPERTY]; return { json: { id: "90" } }; },
    });
    await createLead(payloadOf({ ...validContact, message: "First enquiry." }, "csv_one"));
    const first = stored;
    await createLead(payloadOf({ ...validContact, message: "Second enquiry." }, "csv_two"));
    assert.ok(stored.includes("Second enquiry."));
    assert.ok(!stored.includes("First enquiry."),
      "the summary accumulated — history belongs on the timeline, not in a sidebar property");
    assert.ok(first.includes("First enquiry."));
    assert.ok(!/earlier submission/i.test(stored));
    assert.equal(countOf(calls, NOTES), 2, "both enquiries must still exist as activities");
  });

  test("the summary stays inside HubSpot's property limit", () => {
    const props = toContactProperties(payloadOf({
      ...validHomeValue, message: "m".repeat(4000), notes: "n".repeat(4000),
    }));
    assert.ok(Buffer.byteLength(props[DETAIL_PROPERTY]) <= DETAIL_MAX_BYTES);
  });
});


/* ===================================================================== */
describe("Every submission becomes a timeline activity", () => {
  const noteOf = (calls) => calls.find((c) => c.key === NOTES).body;

  test("the note is a real HubSpot note associated to the contact", () => {
    const rec = toNoteRecord(payloadOf(validHomeValue), "12345");
    assert.ok(rec.properties.hs_timestamp, "hs_timestamp is required by HubSpot");
    assert.ok(rec.properties.hs_note_body.length > 0);
    assert.equal(rec.associations.length, 1);
    assert.equal(rec.associations[0].to.id, "12345");
    assert.equal(rec.associations[0].types[0].associationCategory, "HUBSPOT_DEFINED");
    assert.equal(rec.associations[0].types[0].associationTypeId, 202);
    assert.equal(NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID, 202);
  });

  test("the note timestamp is the submission time", () => {
    const p = payloadOf(validHomeValue);
    assert.equal(toNoteRecord(p, "1").properties.hs_timestamp, p.meta.submitted_at);
  });

  test("first submission: one contact, one activity", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "500" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "create");
    assert.equal(countOf(calls, CREATE), 1);
    assert.equal(countOf(calls, NOTES), 1);
    assert.equal(noteOf(calls).associations[0].to.id, "500");
  });

  test("repeat email: one contact, two activities, first intact", async () => {
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
    const notes = calls.filter((c) => c.key === NOTES);
    assert.equal(notes.length, 2, "each submission needs its own activity");
    assert.notEqual(notes[0].body.properties.hs_note_body, notes[1].body.properties.hs_note_body);
    assert.ok(notes[0].body.properties.hs_note_body.includes("First."));
    assert.ok(notes[1].body.properties.hs_note_body.includes("Second."));
    for (const n of notes) assert.equal(n.body.associations[0].to.id, "501");
  });

  test("the activity carries the complete submission context", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "502" } } });
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

    const body = noteOf(calls).properties.hs_note_body;
    for (const label of DESCRIPTION_LABELS)
      assert.ok(body.includes(label + ":"), "activity missing row " + label);
    for (const value of [
      "home_value", "123 Louisiana Ave, Perrysburg, OH 43551", "Within 3 months",
      "Well maintained, some updates", "Listing consultation", "Please call after six.",
      "New roof in 2022.", "google", "cpc", "brand", "perrysburg realtor", "ad-a",
      "GC1", "GB1", "WB1", "FB1", "MS1", "/?utm_source=google",
      "https://www.google.com/", "2026-08-30T10:00:00.000Z", "csv_abc123",
    ]) assert.ok(body.includes(value), "activity lost " + value);
  });

  test("the submission id in the response is the one on the activity", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "503" } } });
    const r = await call(validContact);
    const sid = r.json().submission_id;
    assert.match(sid, /^csv_[0-9a-f]{24}$/);
    assert.ok(noteOf(calls).properties.hs_note_body.includes("SUBMISSION ID: " + sid));
  });

  test("attribution survives end to end onto the activity", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "504" } } });
    assert.equal((await call(validContact)).statusCode, 200);
    const body = noteOf(calls).properties.hs_note_body;
    assert.ok(body.includes("UTM SOURCE: google"));
    assert.ok(body.includes("UTM MEDIUM: cpc"));
    assert.ok(body.includes("GCLID: abc123"));
    assert.ok(body.includes("REFERRER: https://www.google.com/"));
    assert.ok(body.includes("FIRST TOUCH: 2026-08-30T10:00:00.000Z"));
  });

  test("a full-size lead stays inside HubSpot's note limit", () => {
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
});


/* ===================================================================== */
describe("A missing activity is never a success", () => {
  test("activity creation failure fails the lead", async () => {
    stubFetch({
      [SEARCH]: noHits, [CREATE]: { json: { id: "600" } },
      [NOTES]: { status: 500, json: { message: "boom" } },
    });
    await assert.rejects(() => createLead(payloadOf(validContact)), /HUBSPOT_NOTE_SERVER_500/);
    const r = await call(validContact);
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().ok, false);
    assert.ok(!("submission_id" in r.json()), "a contact with no activity is not a delivered lead");
  });

  test("a missing notes scope is named, not left as a generic 403", async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(String(l));
    try {
      stubFetch({
        [SEARCH]: noHits, [CREATE]: { json: { id: "601" } },
        [NOTES]: { status: 403, json: { message: "This app hasn't been granted all required scopes", category: "MISSING_SCOPES" } },
      });
      await assert.rejects(() => createLead(payloadOf(validContact)),
        /HUBSPOT_NOTES_SCOPE_MISSING/);
    } finally { console.log = realLog; }
    const joined = lines.join("\n");
    assert.match(joined, /notes_scope_missing/);
    assert.match(joined, /crm\.objects\.notes\.write/);
    assert.match(joined, /action_required/);
  });

  test("an unassociated note fails — it would be invisible on the timeline", async () => {
    stubFetch({
      [SEARCH]: noHits, [CREATE]: { json: { id: "602" } },
      [NOTES]: { json: { id: "n9", associations: { contacts: { results: [{ id: "999" }] } } } },
    });
    await assert.rejects(() => createLead(payloadOf(validContact)),
      /HUBSPOT_NOTE_NOT_ASSOCIATED/);
  });

  test("an echoed association matching the contact is accepted", async () => {
    stubFetch({
      [SEARCH]: noHits, [CREATE]: { json: { id: "603" } },
      [NOTES]: { json: { id: "n10", associations: { contacts: { results: [{ id: "603" }] } } } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.noteId, "n10");
  });

  test("a malformed activity response fails", async () => {
    for (const bad of [{ json: { ok: true } }, { text: "not json" }, { text: "" }]) {
      _resetRateLimit();
      stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "604" } }, [NOTES]: bad });
      await assert.rejects(() => createLead(payloadOf(validContact)),
        /HUBSPOT_NOTE_MALFORMED_RESPONSE/);
    }
  });

  test("activity 401/429 fail the lead", async () => {
    for (const [status, pattern] of [[401, /HUBSPOT_NOTE_AUTH_401/], [429, /HUBSPOT_NOTE_RATE_LIMITED/]]) {
      _resetRateLimit();
      stubFetch({
        [SEARCH]: noHits, [CREATE]: { json: { id: "605" } },
        [NOTES]: { status, json: { message: "nope" } },
      });
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    }
  });

  test("a failed activity is never retried by dropping the enquiry", async () => {
    const calls = stubFetch({
      [SEARCH]: noHits, [CREATE]: { json: { id: "606" } },
      [NOTES]: { status: 500, json: { message: "boom" } },
    });
    await createLead(payloadOf(validContact)).catch(() => {});
    assert.equal(countOf(calls, NOTES), 1, "no silent retry");
    for (const c of calls.filter((x) => x.key === NOTES))
      assert.ok(c.body.properties.hs_note_body.length > 0, "an empty enquiry was sent");
  });

  test("a retry after an activity failure does not duplicate the contact", async () => {
    /* The documented partial-write recovery: the contact already exists, so
       the resubmit updates it and writes the activity that was missing. */
    let noteFails = true;
    const calls = stubFetch({
      [SEARCH]: (c, all) => (countOf(all, CREATE) === 0 ? noHits : hit("607")),
      [CREATE]: { json: { id: "607" } },
      [patchKey("607")]: { json: { id: "607" } },
      [NOTES]: () => (noteFails ? { status: 500, json: { message: "boom" } } : noteOk()),
    });
    await createLead(payloadOf(validContact, "csv_first")).catch(() => {});
    noteFails = false;
    const out = await createLead(payloadOf(validContact, "csv_retry"));

    assert.equal(out.action, "update");
    assert.equal(countOf(calls, CREATE), 1, "the retry created a duplicate contact");
    assert.equal(countOf(calls, NOTES), 2);
  });
});


/* ===================================================================== */
describe("Deduplication by email", () => {
  test("no existing contact: one create, no update", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "900" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "create");
    assert.equal(countOf(calls, CREATE), 1);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  test("existing contact: one update, no create", async () => {
    const calls = stubFetch({ [SEARCH]: hit("321"), [patchKey("321")]: { json: { id: "321" } } });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(countOf(calls, CREATE), 0, "must not create over an existing contact");
  });

  test("the search filters on email with EQ", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } });
    await createLead(payloadOf(validContact));
    const f = calls[0].body.filterGroups[0].filters[0];
    assert.equal(f.propertyName, "email");
    assert.equal(f.operator, "EQ");
    assert.equal(f.value, "jane@example.com");
  });

  test("409 from create is folded into an update, not a duplicate", async () => {
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { status: "error", message: "Contact already exists. Existing ID: 654321" } },
      [patchKey("654321")]: { json: { id: "654321" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    assert.equal(out.id, "654321");
    assert.equal(countOf(calls, CREATE), 1, "create must not be retried");
    assert.equal(countOf(calls, NOTES), 1, "the conflict path still needs its activity");
  });

  test("409 with no parseable id falls back to the email-as-id path", async () => {
    const email = encodeURIComponent("jane@example.com");
    const calls = stubFetch({
      [SEARCH]: noHits,
      [CREATE]: { status: 409, json: { status: "error", message: "Contact already exists." } },
      [patchKey(email)]: { json: { id: "42" } },
    });
    const out = await createLead(payloadOf(validContact));
    assert.equal(out.action, "update");
    const patch = calls.find((c) => c.method === "PATCH");
    assert.match(patch.search, /idProperty=email/);
    /* The note must associate to the real numeric id the PATCH returned,
       not to the email that addressed it. */
    assert.equal(calls.find((c) => c.key === NOTES).body.associations[0].to.id, "42");
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
      assert.equal(r.json().code, "DELIVERY_FAILED");
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

  test("a network-level failure surfaces as a 502", async () => {
    stubFetch({ [SEARCH]: new Error("ECONNRESET") });
    assert.equal((await call(validContact)).statusCode, 502);
  });

  const malformed = [
    ["search: no results array", { [SEARCH]: { json: { total: 0 } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: not JSON", { [SEARCH]: { text: "<html>502</html>" } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["search: hit with no id", { [SEARCH]: { json: { results: [{ properties: {} }] } } }, /HUBSPOT_SEARCH_MALFORMED_RESPONSE/],
    ["create: no id returned", { [SEARCH]: noHits, [CREATE]: { json: { properties: {} } } }, /HUBSPOT_CREATE_MALFORMED_RESPONSE/],
    ["update: no id returned", { [SEARCH]: hit("9"), [patchKey("9")]: { json: {} } }, /HUBSPOT_UPDATE_MALFORMED_RESPONSE/],
  ];
  for (const [name, routes, pattern] of malformed) {
    test("malformed response - " + name, async () => {
      stubFetch(routes);
      await assert.rejects(() => createLead(payloadOf(validContact)), pattern);
    });
  }
});


/* ===================================================================== */
describe("The enquiry detail is never silently discarded", () => {
  const rejection = {
    status: 400,
    json: { status: "error", category: "VALIDATION_ERROR", message: 'Property "message" does not exist' },
  };

  test("a rejected summary property fails the lead instead of dropping it", async () => {
    const calls = stubFetch({ [SEARCH]: noHits, [CREATE]: rejection });
    await assert.rejects(() => createLead(payloadOf(validContact)),
      /HUBSPOT_DETAIL_PROPERTY_UNAVAILABLE/);
    assert.equal(countOf(calls, CREATE), 1, "must NOT retry without the enquiry detail");
  });

  test("the visitor sees a failure, not a false success", async () => {
    stubFetch({ [SEARCH]: noHits, [CREATE]: rejection });
    assert.equal((await call(validContact)).statusCode, 502);
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
      assert.equal(calls.length, 0, field + " reached HubSpot despite being overlength");
    }
  });

  test("an overlength address is rejected, not truncated", async () => {
    const calls = stubFetch({ "*": noHits });
    const r = await call({ ...validHomeValue, property_address: "A".repeat(201) });
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
      assert.ok(!JSON.stringify(c.body || {}).includes(TOKEN));
      assert.ok(!c.path.includes(TOKEN) && !c.search.includes(TOKEN));
    }
  });

  test("no response body carries the token", async () => {
    const bodies = [];
    for (const routes of [
      { [SEARCH]: noHits, [CREATE]: { json: { id: "1" } } },
      { [SEARCH]: { status: 401, json: { message: "bad token " + TOKEN } } },
      { [SEARCH]: noHits, [CREATE]: { json: { id: "1" } }, [NOTES]: { status: 500, json: { message: TOKEN } } },
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
    assert.match(joined, /hubspot\.note\.created/);
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

  test("returns the id when it matches", async () => {
    stubFetch({ [SEARCH]: hit("13") });
    assert.deepEqual(await findContactByEmail("jane@example.com"), { id: "13" });
  });
});
