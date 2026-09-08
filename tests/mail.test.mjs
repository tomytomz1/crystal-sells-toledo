/* Zoho Mail acknowledgement.
 *
 * NO SOCKET IS EVER OPENED. The transport is injected through
 * setTransportFactory(), so nothing here talks to smtppro.zoho.com, reads a
 * real credential, or sends mail to anybody. That is deliberate and also the
 * limit: these prove the message this code builds and the order it sends it
 * in. They do NOT prove Zoho accepts the login or that the mail arrives -
 * only a real send proves that.
 *
 * HubSpot is stubbed the same way, so the endpoint-level tests can reach the
 * point where a lead has actually been stored.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler from "../api/lead.js";
import {
  isMailConfigured, escapeHtml, buildAcknowledgement, classifyMailError,
  sendAcknowledgement, setTransportFactory,
  FROM, REPLY_TO, SUBJECT, SIGNATURE_IMAGE,
} from "../api/_lib/mail.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { mockReq, mockRes, validHomeValue, validContact } from "./helpers.mjs";

/* --- credentials that must never escape ------------------------------- */
const SMTP_PASSWORD = "smtp-pw-TESTONLY-must-never-appear-anywhere";
const SMTP_USER = "crystal@crystalsellstoledo.com";
const HUBSPOT_TOKEN = "pat-na1-TESTTOKEN-must-never-appear-anywhere";
const PORTAL = "247240486";
const GUID = "536a356d-d854-49ec-b204-b76e591cecaa";

const realFetch = globalThis.fetch;
const realEnv = {};
const ENV_KEYS = [
  "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD",
  "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID",
];

function setMailEnv() {
  process.env.ZOHO_SMTP_HOST = "smtppro.zoho.com";
  process.env.ZOHO_SMTP_PORT = "465";
  process.env.ZOHO_SMTP_USER = SMTP_USER;
  process.env.ZOHO_SMTP_PASSWORD = SMTP_PASSWORD;
}
function setHubspotEnv() {
  process.env.HUBSPOT_ACCESS_TOKEN = HUBSPOT_TOKEN;
  process.env.HUBSPOT_PORTAL_ID = PORTAL;
  process.env.HUBSPOT_FORM_GUID = GUID;
}

/** A transport that records what it was asked to send and never connects. */
function recordingTransport(behaviour = {}) {
  const sent = [];
  const factory = async () => ({
    async sendMail(message) {
      sent.push(message);
      if (behaviour.throws) throw behaviour.throws;
      return { accepted: [message.to], messageId: "<test@local>" };
    },
  });
  setTransportFactory(factory);
  return sent;
}

/* --- HubSpot stub ------------------------------------------------------ */
const SEARCH = "POST /crm/v3/objects/contacts/search";
const CREATE = "POST /crm/v3/objects/contacts";
const FORM = "POST /submissions/v3/integration/secure/submit/" + PORTAL + "/" + GUID;

function httpRes({ status = 200, json = null }) {
  const body = json === null ? "" : JSON.stringify(json);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

/** Stub HubSpot. `fail` makes the FORM step reject, mimicking a real outage. */
function stubHubspot({ formStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const key = (options.method || "GET") + " " + u.pathname;
    calls.push(key);
    if (key === SEARCH) return httpRes({ json: { total: 0, results: [] } });
    if (key === CREATE) return httpRes({ json: { id: "1", properties: {} } });
    if (key === FORM) {
      return formStatus === 200
        ? httpRes({ json: { inlineMessage: "Thanks." } })
        : httpRes({ status: formStatus, json: { message: "nope" } });
    }
    throw new Error("unstubbed call: " + key);
  };
  return calls;
}

async function post(body) {
  _resetRateLimit();
  const req = mockReq({ body });
  const res = mockRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  for (const k of ENV_KEYS) realEnv[k] = process.env[k];
  _resetRateLimit();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (realEnv[k] === undefined) delete process.env[k];
    else process.env[k] = realEnv[k];
  }
  globalThis.fetch = realFetch;
  setTransportFactory();          // restore the real Nodemailer factory
});

/* =====================================================================
   Configuration
   ===================================================================== */
describe("mail configuration", () => {
  test("isMailConfigured requires all four variables", () => {
    for (const k of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"])
      delete process.env[k];
    assert.equal(isMailConfigured(), false);

    setMailEnv();
    assert.equal(isMailConfigured(), true);

    /* Each one alone is enough to disable the acknowledgement. A half
       configured mailbox must skip, never half-send. */
    for (const k of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"]) {
      setMailEnv();
      delete process.env[k];
      assert.equal(isMailConfigured(), false, `missing ${k} should disable mail`);
      setMailEnv();
      process.env[k] = "";
      assert.equal(isMailConfigured(), false, `empty ${k} should disable mail`);
    }
  });

  test("an unconfigured mailbox skips instead of throwing", async () => {
    for (const k of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"])
      delete process.env[k];
    const sent = recordingTransport();
    const out = await sendAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    assert.deepEqual(out, { sent: false, reason: "not_configured" });
    assert.equal(sent.length, 0, "an unconfigured mailbox must not build a transport");
  });
});

/* =====================================================================
   The message
   ===================================================================== */
describe("the acknowledgement message", () => {
  beforeEach(setMailEnv);

  test("addresses, reply-to and subject are exact", () => {
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    assert.equal(m.from, "Crystal Saylor <crystal@crystalsellstoledo.com>");
    assert.equal(FROM, "Crystal Saylor <crystal@crystalsellstoledo.com>");
    assert.equal(m.replyTo, "crystal@crystalsellstoledo.com");
    assert.equal(REPLY_TO, "crystal@crystalsellstoledo.com");
    assert.equal(m.subject, "I got your request");
    assert.equal(SUBJECT, "I got your request");
    assert.equal(m.to, "sam@example.com");
  });

  test("the recipient is exactly the validated lead email, normalised", () => {
    const lead = validateLead({ ...validHomeValue, email: "  SAM@Example.COM " }).lead;
    const m = buildAcknowledgement(lead);
    assert.equal(m.to, "sam@example.com");
  });

  test("the first name appears in both bodies", () => {
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    assert.match(m.text, /^Hi Sam,/);
    assert.match(m.html, /<p>Hi Sam,<\/p>/);
  });

  /* The one place visitor input reaches HTML. A name is a free-text field
     with a 40-character cap and no character restrictions, so it has to be
     escaped rather than trusted. */
  test("a first name cannot inject HTML", () => {
    const hostile = `<script>alert("x")</script> & 'quote' "dq"`;
    const m = buildAcknowledgement({ first_name: hostile, email: "sam@example.com" });

    assert.ok(!m.html.includes("<script>"), "raw <script> reached the HTML body");
    assert.ok(!m.html.includes("</script>"), "raw </script> reached the HTML body");
    assert.ok(m.html.includes("&lt;script&gt;"), "the tag was not escaped");
    assert.ok(m.html.includes("&amp;"), "the ampersand was not escaped");
    assert.ok(m.html.includes("&#39;"), "the apostrophe was not escaped");
    assert.ok(m.html.includes("&quot;"), "the double quote was not escaped");

    /* The plain-text part is not markup and must keep what was typed. */
    assert.ok(m.text.includes(hostile), "the text body should not be escaped");
  });

  test("escapeHtml covers every character that matters", () => {
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
    assert.equal(escapeHtml(""), "");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    /* Ampersand first, or "&lt;" becomes "&amp;lt;". */
    assert.equal(escapeHtml("<"), "&lt;");
  });

  /* The acknowledgement is a human note, not a receipt. Echoing the
     property address and phone number back to an address that has not been
     confirmed is a disclosure this email has no reason to make. */
  test("no lead detail other than the first name is included", () => {
    const lead = validateLead({
      ...validHomeValue,
      first_name: "Sam",
      property_address: "123 Louisiana Ave, Perrysburg, OH 43551",
      phone: "4195551234",
      timeline: "Within 3 months",
      condition: "Needs work",
      notes: "Roof replaced in 2022 and the basement is finished.",
      attribution: { utm_source: "google", gclid: "GC1", referrer: "https://www.google.com/" },
    }).lead;
    const m = buildAcknowledgement(lead);
    const both = m.text + "\n" + m.html;

    for (const forbidden of [
      "Louisiana", "43551", "(419) 555-1234", "4195551234", "Within 3 months",
      "Needs work", "Roof replaced", "basement", "google", "GC1", "utm_source",
      "Rivera",
    ]) {
      assert.ok(!both.includes(forbidden), `the acknowledgement leaked "${forbidden}"`);
    }
  });

  test("a contact-form message is not echoed back either", () => {
    const lead = validateLead({ ...validContact, message: "Please call me about selling." }).lead;
    const both = JSON.stringify(buildAcknowledgement(lead));
    assert.ok(!both.includes("Please call me about selling"));
    assert.ok(!both.includes("Selling my home"), "the topic was echoed back");
  });

  test("the signature carries every required line", () => {
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    for (const line of [
      "Crystal Saylor, REALTOR",
      "Key Realty LTD | Degnan Group",
      "License #2025003655",
      "(419) 245-4655",
      "crystal@crystalsellstoledo.com",
      "crystalsellstoledo.com",
      "Perrysburg, Toledo",
    ]) {
      assert.ok(m.text.includes(line), `text signature is missing "${line}"`);
      assert.ok(m.html.includes(line), `HTML signature is missing "${line}"`);
    }
    assert.ok(m.text.includes("Ohio Real Estate Salesperson"));
    assert.ok(m.html.includes("Ohio Real Estate Salesperson"));
  });

  test("the signature headshot points at main in this repository", () => {
    const expected =
      "https://raw.githubusercontent.com/tomytomz1/crystal-sells-toledo/main/" +
      "assets/img/Crystal%20Saylor%20Email%20Signature%20Headshot.jpg";
    assert.equal(SIGNATURE_IMAGE, expected);
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    assert.ok(m.html.includes(`src="${expected}"`), "the signature image src changed");
    assert.ok(m.html.includes('alt="Crystal Saylor"'));
  });

  /* This is an acknowledgement, not a campaign. */
  test("nothing marketing, tracked or measurable is attached", () => {
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    const both = (m.text + " " + m.html).toLowerCase();
    for (const banned of [
      "unsubscribe", "utm_", "newsletter", "click here", "open tracking",
      "pixel", "gclid", "list-unsubscribe", "1x1", "?ref=", "mailchimp",
    ]) {
      assert.ok(!both.includes(banned), `the acknowledgement contains "${banned}"`);
    }
    /* The only links are Crystal's own contact details. */
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(hrefs.sort(), [
      "https://crystalsellstoledo.com",
      "mailto:crystal@crystalsellstoledo.com",
      "tel:+14192454655",
    ]);
    const srcs = [...m.html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((x) => x[1]);
    assert.equal(srcs.length, 1, "the only image should be the headshot");
  });
});

/* =====================================================================
   Error classification
   ===================================================================== */
describe("mail errors are classified, never quoted", () => {
  /* A Nodemailer error's `message` and `response` carry the recipient
     address and the raw SMTP conversation. Neither may reach a log line. */
  const RECIPIENT = "sam@example.com";

  const cases = [
    [{ code: "EAUTH", responseCode: 535, message: `Invalid login for ${SMTP_USER}` }, "auth"],
    [{ code: "EENVELOPE", responseCode: 550, message: `550 5.1.1 <${RECIPIENT}> unknown` }, "envelope"],
    [{ code: "ETIMEDOUT", message: "Connection timeout" }, "connection"],
    [{ code: "ESOCKET", message: "socket hang up" }, "connection"],
    [{ code: "ECONNECTION", message: "ECONNREFUSED smtppro.zoho.com:465" }, "connection"],
    [{ code: "EMESSAGE", message: "message rejected" }, "message"],
    [{ responseCode: 421, message: "421 too many connections" }, "smtp_421"],
    [{ message: "something else entirely" }, "unknown"],
    [new Error("plain error"), "unknown"],
  ];

  for (const [err, expected] of cases) {
    test(`${err.code || err.responseCode || "bare error"} classifies as ${expected}`, () => {
      const code = classifyMailError(err);
      assert.equal(code, expected);
      /* The classification itself must be inert: a stable token, never a
         slice of the server's answer. */
      assert.ok(!code.includes(RECIPIENT), "the classification leaked the recipient");
      assert.ok(!code.includes(SMTP_USER), "the classification leaked the SMTP user");
      assert.ok(!code.includes(" "), "the classification is not a token");
    });
  }

  test("classification never returns undefined", () => {
    for (const bad of [null, undefined, {}, "string", 0])
      assert.equal(typeof classifyMailError(bad), "string");
  });
});

/* =====================================================================
   Ordering: HubSpot first, always
   ===================================================================== */
describe("the acknowledgement is secondary to HubSpot", () => {
  beforeEach(() => { setMailEnv(); setHubspotEnv(); });

  test("SMTP is attempted only after HubSpot has stored the lead", async () => {
    const order = [];
    const calls = stubHubspot();
    setTransportFactory(async () => ({
      async sendMail() { order.push("smtp"); return { accepted: [] }; },
    }));
    /* Record HubSpot's calls in the same list. */
    const stubbed = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const r = await stubbed(...args);
      order.push("hubspot:" + new URL(String(args[0])).pathname.split("/").pop());
      return r;
    };

    const res = await post(validHomeValue);
    assert.equal(res.statusCode, 200);

    assert.ok(order.includes("smtp"), "no acknowledgement was attempted");
    assert.equal(order[order.length - 1], "smtp",
      "SMTP did not run last - order was " + order.join(" -> "));
    assert.ok(calls.includes(SEARCH) && calls.includes(CREATE) && calls.includes(FORM),
      "HubSpot did not complete both steps first");
  });

  test("SMTP is NOT attempted when HubSpot fails", async () => {
    stubHubspot({ formStatus: 500 });
    const sent = recordingTransport();
    const res = await post(validHomeValue);

    assert.equal(res.statusCode, 502, "a HubSpot failure must still fail the submission");
    assert.equal(res.json().code, "DELIVERY_FAILED");
    assert.equal(sent.length, 0, "a visitor was thanked for a lead that was never stored");
  });

  test("SMTP is NOT attempted when the CRM is unconfigured", async () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const sent = recordingTransport();
    const res = await post(validHomeValue);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "NOT_CONFIGURED");
    assert.equal(sent.length, 0);
  });

  test("SMTP is NOT attempted when validation rejects the lead", async () => {
    stubHubspot();
    const sent = recordingTransport();
    const res = await post({ ...validHomeValue, phone: "" });
    assert.equal(res.statusCode, 422);
    assert.equal(sent.length, 0);
  });
});

/* =====================================================================
   The response contract does not move
   ===================================================================== */
describe("a mail outcome never changes what the browser gets", () => {
  beforeEach(() => { setMailEnv(); setHubspotEnv(); });

  const expect200 = (res) => {
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.match(body.submission_id, /^csv_[0-9a-f]{24}$/);
    /* No email status of any kind reaches the browser. */
    assert.deepEqual(Object.keys(body).sort(), ["ok", "submission_id"]);
    return body;
  };

  test("SMTP success returns the existing 200", async () => {
    stubHubspot();
    const sent = recordingTransport();
    const body = expect200(await post(validHomeValue));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, validateLead(validHomeValue).lead.email);
    assert.ok(body.submission_id);
  });

  test("SMTP failure returns the SAME existing 200", async () => {
    stubHubspot();
    const err = Object.assign(new Error("550 <sam@example.com> rejected"), {
      code: "EENVELOPE", responseCode: 550,
    });
    const sent = recordingTransport({ throws: err });
    expect200(await post(validHomeValue));
    assert.equal(sent.length, 1, "the send should have been attempted");
  });

  test("an auth failure - a wrong password - returns the SAME existing 200", async () => {
    stubHubspot();
    recordingTransport({
      throws: Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }),
    });
    expect200(await post(validHomeValue));
  });

  test("a transport that never resolves its factory returns the SAME existing 200", async () => {
    stubHubspot();
    setTransportFactory(async () => { throw new Error("cannot reach smtppro.zoho.com"); });
    expect200(await post(validHomeValue));
  });

  test("missing SMTP configuration returns the SAME existing 200", async () => {
    stubHubspot();
    for (const k of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"])
      delete process.env[k];
    const sent = recordingTransport();
    expect200(await post(validHomeValue));
    assert.equal(sent.length, 0);
  });

  test("the contact form is acknowledged the same way", async () => {
    stubHubspot();
    const sent = recordingTransport();
    expect200(await post(validContact));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "jane@example.com");
    assert.equal(sent[0].subject, "I got your request");
  });
});

/* =====================================================================
   Nothing secret escapes
   ===================================================================== */
describe("no credential reaches a response, a log or an error", () => {
  beforeEach(() => { setMailEnv(); setHubspotEnv(); });

  test("the SMTP password appears in no response body and no log line", async () => {
    stubHubspot();
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      recordingTransport({
        throws: Object.assign(new Error(`535 auth failed for ${SMTP_USER} pw=${SMTP_PASSWORD}`), {
          code: "EAUTH", responseCode: 535, response: `535 ${SMTP_PASSWORD}`,
        }),
      });
      const res = await post(validHomeValue);
      assert.equal(res.statusCode, 200);
      assert.ok(!res.body.includes(SMTP_PASSWORD), "the response leaked the SMTP password");
      assert.ok(!res.body.includes(SMTP_USER), "the response leaked the SMTP user");
      assert.ok(!res.body.includes(HUBSPOT_TOKEN), "the response leaked the HubSpot token");

      const logged = lines.join("\n");
      assert.ok(!logged.includes(SMTP_PASSWORD), "a log line leaked the SMTP password");
      assert.ok(!logged.includes(HUBSPOT_TOKEN), "a log line leaked the HubSpot token");
      /* The failure IS recorded - silently swallowing it would hide an
         outage - but only as a classification. */
      assert.match(logged, /lead\.ack\.failed/);
      assert.match(logged, /"reason":"auth"/);
    } finally {
      console.log = realLog;
    }
  });

  test("a successful acknowledgement logs no recipient and no name", async () => {
    stubHubspot();
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      recordingTransport();
      await post(validHomeValue);
      const logged = lines.join("\n");
      assert.match(logged, /lead\.ack\.sent/);
      for (const pii of ["sam@example.com", "Sam", "Rivera", "Louisiana", "555-0000"])
        assert.ok(!logged.includes(pii), `a log line leaked "${pii}"`);
    } finally {
      console.log = realLog;
    }
  });

  test("an unconfigured mailbox is logged as skipped, with a reason and nothing else", async () => {
    stubHubspot();
    for (const k of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"])
      delete process.env[k];
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      recordingTransport();
      await post(validHomeValue);
      const logged = lines.join("\n");
      assert.match(logged, /lead\.ack\.skipped/);
      assert.match(logged, /"reason":"not_configured"/);
    } finally {
      console.log = realLog;
    }
  });

  test("the mail module never reads a credential into its exports", () => {
    /* buildAcknowledgement takes the lead, not the environment. Nothing it
       returns can carry a mailbox password. */
    const m = buildAcknowledgement({ first_name: "Sam", email: "sam@example.com" });
    const flat = JSON.stringify(m);
    assert.ok(!flat.includes(SMTP_PASSWORD));
    assert.ok(!flat.includes("ZOHO_SMTP"));
  });
});
