import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import handler from "../api/lead.js";
import { validateLead, FieldError, normalizePhone } from "../api/_lib/validate.mjs";
import { buildDescription, DESCRIPTION_LABELS } from "../api/_lib/description.mjs";
import { toLeadRecord, withoutPicklists, COMPANY_BY_FORM } from "../api/_lib/zoho.mjs";
import { _resetRateLimit, originAllowed, allowedHosts } from "../api/_lib/security.mjs";
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

  /* ---------------------------------------------------------------
     Origin allow-list.

     `*.vercel.app` was once accepted as a suffix so preview deploys
     worked. vercel.app is a shared domain - anyone can hold a hostname
     on it in seconds - so that allowed every Vercel project on earth to
     drive a visitor's browser into posting here. This deployment's own
     hostnames come from VERCEL_URL and VERCEL_BRANCH_URL instead, which
     name exactly one deployment and one branch.

     None of this is authentication: a header is trivially forged by
     anything that is not a browser. It is CSRF hygiene, and the tests
     below only assert that the surface is no wider than intended.
     --------------------------------------------------------------- */
  const withEnv = async (vars, fn) => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const allows = (origin) => originAllowed({ headers: { origin } });

  const NO_VERCEL = { VERCEL_URL: undefined, VERCEL_BRANCH_URL: undefined, ALLOWED_ORIGINS: undefined };

  test("an unrelated *.vercel.app origin is rejected", async () => {
    await withEnv(NO_VERCEL, async () => {
      for (const host of [
        "https://someone-elses-project.vercel.app",
        "https://crystal-sells-toledo-evil.vercel.app",
        "https://vercel.app",
        "https://notvercel.app",
        "https://crystalsellstoledo.com.evil.vercel.app",
      ]) {
        assert.equal(allows(host), false, `${host} must not be allowed`);
      }
      const res = await call({
        body: validContact,
        headers: { origin: "https://someone-elses-project.vercel.app" },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().code, "FORBIDDEN_ORIGIN");
    });
  });

  /* The two hostnames Vercel sets for a deployment: the immutable
     deployment URL, and the generated branch URL that follows the latest
     successful deployment from that branch. Both are admitted; both are
     exact strings, so neither opens the shared domain. */
  const DEPLOY = "crystal-sells-toledo-abc123.vercel.app";
  const BRANCH = "crystal-sells-toledo-git-phase-3-integrity-tomas.vercel.app";
  const ON_VERCEL = { VERCEL_URL: DEPLOY, VERCEL_BRANCH_URL: BRANCH, ALLOWED_ORIGINS: undefined };

  test("the current VERCEL_URL hostname is accepted", async () => {
    await withEnv(ON_VERCEL, async () => {
      assert.equal(allows(`https://${DEPLOY}`), true);
      const res = await call({ body: validContact, headers: { origin: `https://${DEPLOY}` } });
      assert.notEqual(res.statusCode, 403);
    });
  });

  test("the current VERCEL_BRANCH_URL hostname is accepted", async () => {
    await withEnv(ON_VERCEL, async () => {
      assert.equal(allows(`https://${BRANCH}`), true);
      const res = await call({ body: validContact, headers: { origin: `https://${BRANCH}` } });
      assert.notEqual(res.statusCode, 403);
    });
  });

  test("a different branch or project on vercel.app is still rejected", async () => {
    await withEnv(ON_VERCEL, async () => {
      for (const host of [
        /* a sibling deployment of this same project */
        "https://crystal-sells-toledo-def456.vercel.app",
        /* a different branch of this same project */
        "https://crystal-sells-toledo-git-some-other-branch-tomas.vercel.app",
        /* another account's project entirely */
        "https://someone-elses-project.vercel.app",
        /* the branch host with anything appended - not the same string */
        `https://${BRANCH}.evil.vercel.app`,
      ]) {
        assert.equal(allows(host), false, `${host} must not be allowed`);
      }
      const res = await call({
        body: validContact,
        headers: { origin: "https://crystal-sells-toledo-git-some-other-branch-tomas.vercel.app" },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().code, "FORBIDDEN_ORIGIN");
    });
  });

  test("a referer is held to the same allow-list as an origin", async () => {
    await withEnv(ON_VERCEL, async () => {
      const byRef = (referer) => originAllowed({ headers: { referer } });
      assert.equal(byRef("https://someone-elses-project.vercel.app/x"), false);
      assert.equal(byRef(`https://${DEPLOY}/x`), true);
      assert.equal(byRef(`https://${BRANCH}/home-value`), true);
      assert.equal(byRef("https://www.crystalsellstoledo.com/home-value"), true);
    });
  });

  test("explicitly allowed origins remain accepted", async () => {
    await withEnv({ ...NO_VERCEL, ALLOWED_ORIGINS: "staging.example.com, preview-1.vercel.app" },
      async () => {
        assert.equal(allows("https://staging.example.com"), true);
        assert.equal(allows("https://preview-1.vercel.app"), true);
        assert.equal(allows("https://preview-2.vercel.app"), false);
        const res = await call({ body: validContact, headers: { origin: "https://staging.example.com" } });
        assert.notEqual(res.statusCode, 403);
      });
  });

  test("production and localhost origins remain accepted", async () => {
    await withEnv(NO_VERCEL, async () => {
      for (const host of [
        "https://crystalsellstoledo.com",
        "https://www.crystalsellstoledo.com",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]) {
        assert.equal(allows(host), true, `${host} must stay allowed`);
      }
      assert.ok(allowedHosts().has("crystalsellstoledo.com"));
      const res = await call({
        body: validContact,
        headers: { origin: "https://www.crystalsellstoledo.com" },
      });
      assert.notEqual(res.statusCode, 403);
    });
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
      for (const secret of ["ZOHO_", "HUBSPOT_", "client_secret", "refresh_token",
                            "oauthtoken", "Bearer ", "hubapi.com"])
        assert.ok(!b.includes(secret), `response leaked ${secret}`);
  });

  test("the 503 for an unconfigured CRM does not claim success", async () => {
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
    for (const s of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN",
                     "Zoho-oauthtoken", "HUBSPOT_ACCESS_TOKEN", "hubapi.com"])
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


/* =====================================================================
   Zoho Lead schema conformance - RETAINED FALLBACK, not the live path
   =====================================================================
   Delivery runs through HubSpot (tests/hubspot.test.mjs). This module is
   kept wired-but-unused so the migration can be rolled back without a
   rewrite, and these tests keep it from rotting while it sits there.

   Zoho rejects a Lead with no Company (MANDATORY_NOT_FOUND) and rejects
   values longer than the standard field maximums. Anything this layer
   accepts but Zoho refuses becomes a 502 for a visitor who already
   filled the form, so the two schemas must agree.
   ===================================================================== */
describe("Zoho Lead payload", () => {
  const build = (raw) => {
    const payload = validateLead(raw);
    payload.meta.submission_id = "csv_test";
    return toLeadRecord(payload);
  };

  test("Company is present for home_value", () => {
    const rec = build(validHomeValue);
    assert.equal(rec.Company, "Residential Seller");
  });

  test("Company is present for contact", () => {
    const rec = build(validContact);
    assert.equal(rec.Company, "Residential Real Estate Lead");
  });

  test("Company is never empty for any known form type", () => {
    for (const form of Object.keys(COMPANY_BY_FORM)) {
      assert.ok(COMPANY_BY_FORM[form] && COMPANY_BY_FORM[form].trim().length > 0,
        form + " has no Company value");
    }
  });

  test("mandatory Zoho fields are all populated", () => {
    for (const rec of [build(validHomeValue), build(validContact)]) {
      for (const field of ["Last_Name", "Company"])
        assert.ok(rec[field] && String(rec[field]).length > 0, field + " missing");
    }
  });

  test("standard field mapping is exact", () => {
    const rec = build(validHomeValue);
    assert.equal(rec.First_Name, "Sam");
    assert.equal(rec.Last_Name, "Rivera");
    assert.equal(rec.Email, "sam@example.com");
    assert.equal(rec.Phone, "(419) 555-0000");
    assert.equal(rec.Street, "123 Louisiana Ave, Perrysburg, OH 43551");
    assert.ok(rec.Description.startsWith("FORM: home_value"));
  });

  test("no field exceeds its Zoho maximum", () => {
    const MAX = { First_Name: 40, Last_Name: 80, Email: 100, Phone: 30, Street: 250 };
    for (const rec of [build(validHomeValue), build(validContact)])
      for (const [field, max] of Object.entries(MAX))
        if (rec[field]) assert.ok(rec[field].length <= max,
          field + " is " + rec[field].length + ", over Zoho's " + max);
  });
});

describe("Zoho picklists are never invented", () => {
  const build = (raw) => {
    const payload = validateLead(raw);
    payload.meta.submission_id = "csv_test";
    return toLeadRecord(payload);
  };

  test("Lead_Status is omitted unless explicitly configured", () => {
    const before = process.env.ZOHO_LEAD_STATUS;
    delete process.env.ZOHO_LEAD_STATUS;
    const rec = build(validContact);
    assert.ok(!("Lead_Status" in rec),
      "Lead_Status must not be sent with an unconfirmed picklist value");
    if (before !== undefined) process.env.ZOHO_LEAD_STATUS = before;
  });

  test("Lead_Status is sent when configured", () => {
    const before = process.env.ZOHO_LEAD_STATUS;
    process.env.ZOHO_LEAD_STATUS = "Not Contacted";
    assert.equal(build(validContact).Lead_Status, "Not Contacted");
    if (before === undefined) delete process.env.ZOHO_LEAD_STATUS;
    else process.env.ZOHO_LEAD_STATUS = before;
  });

  test("Lead_Source defaults to Website and is overridable", () => {
    const before = process.env.ZOHO_LEAD_SOURCE;
    delete process.env.ZOHO_LEAD_SOURCE;
    assert.equal(build(validContact).Lead_Source, "Website");
    process.env.ZOHO_LEAD_SOURCE = "Web Download";
    assert.equal(build(validContact).Lead_Source, "Web Download");
    if (before === undefined) delete process.env.ZOHO_LEAD_SOURCE;
    else process.env.ZOHO_LEAD_SOURCE = before;
  });

  test("the picklist-free retry keeps every lead-bearing field", () => {
    const rec = build(validHomeValue);
    const retry = withoutPicklists(rec);
    assert.ok(!("Lead_Source" in retry));
    assert.ok(!("Lead_Status" in retry));
    /* The point of the fallback: an unconfirmed dropdown value must cost a
       classification, never the lead itself. */
    for (const field of ["First_Name", "Last_Name", "Company", "Email", "Phone", "Street", "Description"])
      assert.ok(field in retry, "retry dropped " + field);
    assert.equal(retry.Description, rec.Description);
  });
});

describe("Overlength values are rejected, never truncated", () => {
  beforeEach(() => _resetRateLimit());

  const cases = [
    ["first_name", 40], ["last_name", 80], ["email", 100], ["phone", 30],
    ["property_address", 200],
  ];

  for (const [field, max] of cases) {
    test(`${field} over ${max} is rejected`, async () => {
      const base = field === "property_address" ? validHomeValue : validContact;
      let value;
      if (field === "email") value = "a".repeat(max) + "@example.com";
      else if (field === "phone") value = "1".repeat(max + 5);
      else value = "A".repeat(max + 1);
      const res = await call({ body: { ...base, [field]: value } });
      assert.equal(res.statusCode, 422, field + " should be rejected");
      assert.equal(res.json().code, "FIELD_TOO_LONG");
    });

    test(`${field} at exactly ${max} is accepted`, () => {
      const base = field === "property_address" ? validHomeValue : validContact;
      let value;
      if (field === "email") value = "a".repeat(max - 12) + "@example.com";
      else if (field === "phone") value = "1".repeat(max);
      else value = "A".repeat(max);
      const out = validateLead({ ...base, [field]: value });
      assert.ok(out.lead[field].length <= max);
    });
  }

  test("nothing is silently shortened", () => {
    const name = "A".repeat(41);
    assert.throws(() => validateLead({ ...validContact, first_name: name }),
      (e) => e.code === "FIELD_TOO_LONG");
    /* A truncating implementation would have returned a 40-char name and a
       200. Confirm a value one under the cap survives byte for byte. */
    const ok = validateLead({ ...validContact, first_name: "B".repeat(40) });
    assert.equal(ok.lead.first_name, "B".repeat(40));
    assert.equal(ok.lead.first_name.length, 40);
  });

  test("client maxlength matches the server limit on every form", () => {
    const dir = join(ROOT, "public");
    const expected = { first_name: 40, last_name: 80, email: 100, phone: 30 };
    for (const file of ["contact.html", "home-value.html"]) {
      const html = readFileSync(join(dir, file), "utf8");
      for (const [name, max] of Object.entries(expected)) {
        const tag = new RegExp('<input[^>]*name="' + name + '"[^>]*>').exec(html);
        assert.ok(tag, name + " input missing from " + file);
        const ml = /maxlength="(\d+)"/.exec(tag[0]);
        assert.ok(ml, name + " has no maxlength in " + file);
        assert.equal(Number(ml[1]), max,
          name + " maxlength in " + file + " disagrees with the server limit");
      }
    }
  });
});
