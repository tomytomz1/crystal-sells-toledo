import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import handler from "../api/lead.js";
import { validateLead, FieldError, normalizePhone } from "../api/_lib/validate.mjs";
import { buildDescription, DESCRIPTION_LABELS } from "../api/_lib/description.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { safeShape } from "../api/_lib/log.mjs";
import { mockReq, mockRes, validContact, validHomeValue } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function call(opts) {
  _resetRateLimit();
  const req = mockReq(opts);
  const res = mockRes();
  await handler(req, res);
  return res;
}

/* Zoho is intentionally NOT configured in tests. The endpoint must then
   refuse rather than claim success, which is exactly the behaviour under
   test for "never claim success unless the server accepted the lead". */
describe("POST /api/lead - method and transport", () => {
  beforeEach(() => _resetRateLimit());

  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    test(`rejects ${method}`, async () => {
      const res = await call({ method, body: validContact });
      assert.equal(res.statusCode, 405);
      assert.equal(res.json().ok, false);
      assert.equal(res.json().code, "METHOD_NOT_ALLOWED");
      assert.equal(res.headers.allow, "POST");
    });
  }

  test("rejects a foreign origin", async () => {
    const res = await call({ body: validContact, headers: { origin: "https://evil.example.com" } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, "FORBIDDEN_ORIGIN");
  });

  test("accepts a missing origin (privacy tools strip it)", async () => {
    const res = await call({ body: validContact, headers: { origin: "", referer: "" } });
    assert.notEqual(res.statusCode, 403);
  });

  test("rejects an oversized payload", async () => {
    const big = { ...validContact, message: "x".repeat(40_000) };
    const res = await call({ body: big });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().code, "PAYLOAD_TOO_LARGE");
  });

  test("rejects malformed JSON", async () => {
    const res = await call({ body: "{not json" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "INVALID_JSON");
  });

  test("responses are never cached", async () => {
    const res = await call({ body: validContact });
    assert.match(res.headers["cache-control"], /no-store/);
  });

  test("rate limits repeated submissions from one address", async () => {
    _resetRateLimit();
    let last;
    for (let i = 0; i < 7; i++) {
      const req = mockReq({ body: validContact, ip: "198.51.100.7" });
      const res = mockRes();
      await handler(req, res);
      last = res;
    }
    assert.equal(last.statusCode, 429);
    assert.equal(last.json().code, "RATE_LIMITED");
    assert.ok(last.headers["retry-after"]);
  });
});

describe("POST /api/lead - validation", () => {
  beforeEach(() => _resetRateLimit());

  test("honeypot submissions are rejected and never reach the CRM", async () => {
    const res = await call({ body: { ...validContact, _gotcha: "i am a bot" } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "REJECTED");
    assert.equal(res.json().ok, false);
  });

  test("invalid email rejected server-side", async () => {
    for (const bad of ["nope", "a@b", "a b@c.com", "@example.com", "a@.com", "a@b..com"]) {
      const res = await call({ body: { ...validContact, email: bad } });
      assert.equal(res.json().code, "INVALID_EMAIL", `should reject ${bad}`);
    }
  });

  test("excessively long fields rejected", async () => {
    const res = await call({ body: { ...validContact, first_name: "A".repeat(500) } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, "FIELD_TOO_LONG");
  });

  test("missing form_type rejected", async () => {
    const body = { ...validContact }; delete body.form_type;
    assert.equal((await call({ body })).json().code, "MISSING_FORM_TYPE");
  });

  test("unknown form_type rejected", async () => {
    assert.equal((await call({ body: { ...validContact, form_type: "wat" } })).json().code,
      "UNKNOWN_FORM_TYPE");
  });

  test("home_value requires a property address", async () => {
    const body = { ...validHomeValue }; delete body.property_address;
    assert.equal((await call({ body })).json().code, "MISSING_ADDRESS");
  });

  test("required fields serialize and normalise correctly", () => {
    const out = validateLead({
      ...validContact,
      first_name: "  jane  ", email: "  JANE@EXAMPLE.COM ", phone: "419.555.1234",
    });
    assert.equal(out.lead.first_name, "jane");
    assert.equal(out.lead.email, "jane@example.com");
    assert.equal(out.lead.phone, "(419) 555-1234");
    assert.equal(out.lead.form_type, "contact");
  });

  test("phone normalisation preserves international numbers", () => {
    assert.equal(normalizePhone("+44 20 7946 0000"), "+44 20 7946 0000");
    assert.equal(normalizePhone("14195551234"), "(419) 555-1234");
    assert.equal(normalizePhone(""), "");
  });

  test("attribution keys are all preserved", () => {
    const out = validateLead(validContact);
    assert.equal(out.attribution.utm_source, "google");
    assert.equal(out.attribution.gclid, "abc123");
    assert.equal(out.attribution.first_touch_at, "2026-08-30T10:00:00.000Z");
  });
});

describe("Description block", () => {
  test("emits every label in a fixed order, blanks included", () => {
    const payload = validateLead(validHomeValue);
    payload.meta.submission_id = "csv_test";
    const desc = buildDescription(payload);
    const lines = desc.split("\n");
    assert.equal(lines.length, DESCRIPTION_LABELS.length);
    DESCRIPTION_LABELS.forEach((label, i) => {
      assert.ok(lines[i].startsWith(label + ":"), `line ${i} should start with ${label}:`);
    });
    assert.match(desc, /FORM: home_value/);
    assert.match(desc, /SUBMISSION ID: csv_test/);
    assert.match(desc, /UTM SOURCE: -/); // absent values are explicit, not missing
  });
});

describe("Secrets and PII never leak", () => {
  beforeEach(() => _resetRateLimit());

  test("no response body contains credential material", async () => {
    const bodies = [
      (await call({ body: validContact })).body,
      (await call({ body: { ...validContact, email: "bad" } })).body,
      (await call({ method: "GET", body: validContact })).body,
    ];
    for (const b of bodies)
      for (const secret of ["ZOHO_", "client_secret", "refresh_token", "oauthtoken", "Bearer "])
        assert.ok(!b.includes(secret), `response leaked ${secret}`);
  });

  test("the 503 for unconfigured Zoho does not claim success", async () => {
    const res = await call({ body: validContact });
    assert.equal(res.json().ok, false);
    assert.equal(res.json().code, "NOT_CONFIGURED");
    assert.ok(!("submission_id" in res.json()));
  });

  test("log redaction hides PII values but keeps shape", () => {
    const shape = safeShape({ first_name: "Jane", email: "j@x.co", form_type: "contact", phone: "" });
    assert.equal(shape.first_name, "present:4");
    assert.equal(shape.email, "present:6");
    assert.equal(shape.phone, "absent");
    assert.equal(shape.form_type, "contact");
  });

  test("client bundle contains no server secret names", () => {
    const js = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
    for (const s of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "Zoho-oauthtoken"])
      assert.ok(!js.includes(s), `main.js leaks ${s}`);
  });
});

describe("Contact points are stable", () => {
  test("tel and email constants unchanged", () => {
    const js = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
    assert.ok(js.includes("+14192454655"));
    assert.ok(js.includes("crystal@crystalsellstoledo.com"));
  });

  test("every rendered page keeps the tel link", () => {
    const dir = join(ROOT, "public");
    for (const f of ["index.html", "contact.html", "home-value.html"]) {
      const html = readFileSync(join(dir, f), "utf8");
      assert.match(html, /tel:\+14192454655/);
    }
  });

  test("main.js posts to /api/lead and not to null", () => {
    const js = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
    assert.match(js, /leadEndpoint:\s*"\/api\/lead"/);
    assert.ok(!/leadEndpoint:\s*null/.test(js));
  });
});
