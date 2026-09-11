import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import handler from "../api/lead.js";
import { validateLead, FieldError, normalizePhone } from "../api/_lib/validate.mjs";
import { buildDescription, DESCRIPTION_LABELS } from "../api/_lib/description.mjs";
import { toLeadRecord, withoutPicklists, COMPANY_BY_FORM } from "../api/_lib/zoho.mjs";
import {
  _resetRateLimit, _rateLimitSize, rateLimit, originAllowed, allowedHosts,
  readBody, bodyErrorReason, MAX_BODY_BYTES,
  BODY_READ_TIMEOUT_MS, BODY_READ_TIMED_OUT, PAYLOAD_TOO_LARGE,
} from "../api/_lib/security.mjs";
import { safeShape } from "../api/_lib/log.mjs";
import { mockReq, mockRes, validContact, validHomeValue, withHttpServer } from "./helpers.mjs";

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

  /* Regression: a HubSpot contact was created from a real /home-value
     submission with an empty phone number. `phone` carried no `required`
     attribute and the server accepted the blank, so the row looked like a
     lead and could not be called. Every visitor-facing field except `notes`
     is mandatory now, and each one is asserted individually - a single "the
     full payload is accepted" test would stay green if any one check were
     dropped. `notes` is asserted in the other direction, below. */
  describe("every visitor-facing field except notes is mandatory", () => {
    beforeEach(() => _resetRateLimit());

    const homeValueRequired = [
      ["phone", "MISSING_PHONE"],
      ["property_address", "MISSING_ADDRESS"],
      ["timeline", "MISSING_TIMELINE"],
      ["condition", "MISSING_CONDITION"],
      ["first_name", "MISSING_FIRST_NAME"],
      ["last_name", "MISSING_LAST_NAME"],
      ["email", "MISSING_EMAIL"],
    ];

    for (const [field, code] of homeValueRequired) {
      for (const [label, value] of [["absent", undefined], ["blank", ""], ["whitespace", "   "]]) {
        test(`home_value with ${label} ${field} is rejected`, async () => {
          const body = { ...validHomeValue };
          if (value === undefined) delete body[field]; else body[field] = value;
          const res = await call({ body });
          assert.equal(res.statusCode, 422, `${field} ${label} should be a 422`);
          assert.equal(res.json().code, code);
          assert.equal(res.json().ok, false);
        });
      }
    }

    /* The opposite pin. "Anything I should know?" has no answer for a
       homeowner with nothing to add, so requiring it bought a field full of
       "N/A", "none" and "." rather than better leads. A blank must go
       through, and must still arrive as a normalised empty string rather
       than undefined - the enquiry block renders every row. */
    for (const [label, value] of [["absent", undefined], ["blank", ""],
                                  ["whitespace", "   "], ["a newline", "\n\n"]]) {
      test(`home_value with ${label} notes is accepted`, async () => {
        const body = { ...validHomeValue };
        if (value === undefined) delete body.notes; else body.notes = value;
        const out = validateLead(body);
        assert.equal(out.lead.notes, "");
        /* Through the endpoint too: a 503 here is the unconfigured-CRM
           refusal, which only happens AFTER validation accepted the lead.
           A 422 would mean notes had been rejected. */
        const res = await call({ body });
        assert.notEqual(res.statusCode, 422, `${label} notes was rejected`);
      });
    }

    test("notes is still normalised and capped when it is given", async () => {
      const out = validateLead({ ...validHomeValue, notes: "  roof   2022 \n\n\n\n  attic " });
      /* Runs of spaces collapse to one and four newlines collapse to a single
         paragraph break; the ends are trimmed. squashMultiline deliberately
         does NOT trim each line, so the spaces either side of the break
         survive - that is existing behaviour, pinned here so a later change
         to it is a decision rather than a surprise. */
      assert.equal(out.lead.notes, "roof 2022 \n\n attic");
      const res = await call({ body: { ...validHomeValue, notes: "x".repeat(4001) } });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().code, "FIELD_TOO_LONG");
    });

    for (const [field, code] of [["phone", "MISSING_PHONE"], ["topic", "MISSING_TOPIC"],
                                 ["message", "MISSING_MESSAGE"]]) {
      test(`contact with a blank ${field} is rejected`, async () => {
        const res = await call({ body: { ...validContact, [field]: "" } });
        assert.equal(res.statusCode, 422);
        assert.equal(res.json().code, code);
      });
    }

    /* The bug's exact shape: everything else present and correct, phone
       empty. Anything other than a 422 means the row reaches the CRM. */
    test("the reported failure - a complete lead with no phone - never reaches the CRM", async () => {
      const res = await call({ body: { ...validHomeValue, phone: "" } });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().code, "MISSING_PHONE");
      assert.match(res.json().message, /phone/i);
      /* Not the 503 the endpoint returns once a payload is accepted and the
         CRM is unconfigured - that would mean validation had let it past. */
      assert.notEqual(res.statusCode, 503);
    });

    test("a partial phone number is rejected, not stored as typed", async () => {
      for (const partial of ["419", "41955", "(419) 555-12", "call me"]) {
        const res = await call({ body: { ...validHomeValue, phone: partial } });
        assert.equal(res.json().code, "INVALID_PHONE", partial + " should be rejected");
      }
    });

    test("a full number still passes, in every shape a visitor might type", async () => {
      for (const good of ["4195551234", "(419) 555-1234", "419-555-1234", "1 419 555 1234",
                          "+44 20 7946 0000"]) {
        const out = validateLead({ ...validHomeValue, phone: good });
        assert.ok(out.lead.phone.replace(/\D/g, "").length >= 10, good + " should be accepted");
      }
    });

    /* The visitor has to be able to act on the rejection. A code alone in the
       status box tells them nothing about which field to go back to. */
    test("each rejection names the field in words the form uses", async () => {
      const named = {
        phone: /phone/i, timeline: /sell/i, condition: /condition/i,
        property_address: /address/i,
      };
      for (const [field, pattern] of Object.entries(named)) {
        const res = await call({ body: { ...validHomeValue, [field]: "" } });
        assert.match(res.json().message, pattern, field + " message should name the field");
        assert.doesNotMatch(res.json().message, /_/, field + " message leaks a field key");
      }
    });
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

/* =====================================================================
   Content-QA regressions. These three are the reasons the privacy notice
   was inaccurate, not merely badly worded, so each is pinned by the
   behaviour the notice now describes.
   ===================================================================== */
describe("privacy: rate-limit addresses do not outlive their window (P03)", () => {
  const WIN = 10 * 60 * 1000;

  test("an idle address is dropped once its window has passed", () => {
    _resetRateLimit();
    const t = 1_700_000_000_000;
    rateLimit("198.51.100.1", t);
    rateLimit("198.51.100.2", t);
    assert.equal(_rateLimitSize(), 2);

    /* A later request from a third address must not leave the first two
       sitting in memory - the original implementation filtered timestamps
       but never removed the keys. */
    rateLimit("198.51.100.3", t + WIN + 1000);
    assert.equal(_rateLimitSize(), 1,
      "idle addresses were retained past the limiting window");
  });

  test("staggered arrivals leave only live addresses behind", () => {
    /* The scenario that defeated the first fix: it swept only when a window
       had elapsed since the LAST sweep, so C's arrival swept A but nothing
       later swept B. Every call sweeps now. */
    _resetRateLimit();
    const t = 1_700_000_000_000;
    rateLimit("A", t);              // expires at t + WIN
    rateLimit("B", t + WIN - 1);    // expires at t + 2*WIN - 1
    rateLimit("C", t + WIN);        // live
    rateLimit("D", t + 2 * WIN - 1);// live; B is expired by now
    assert.equal(_rateLimitSize(), 2,
      "an expired address survived a staggered arrival pattern");
  });

  test("limiting still works, and the window still reopens", () => {
    _resetRateLimit();
    const t = 1_700_000_000_000;
    let blockedAt = null;
    for (let i = 0; i < 6; i++) {
      const r = rateLimit("203.0.113.9", t + i * 1000);
      if (!r.allowed && blockedAt === null) blockedAt = i;
    }
    assert.equal(blockedAt, 5, "the sixth request in the window should be refused");
    assert.equal(rateLimit("203.0.113.9", t + WIN + 1).allowed, true,
      "the window should reopen once it has passed");
  });
});

describe("privacy: visitor-facing failures say what to do (F01)", () => {
  test("an over-long note names the field and the limit, not the field key", async () => {
    const res = await call({ body: { ...validHomeValue, notes: "x".repeat(4001) } });
    assert.equal(res.statusCode, 422);
    const m = res.json().message;
    assert.match(m, /notes/i);
    assert.match(m, /4,000 characters/);
    assert.doesNotMatch(m, /exceeds|form_type/i,
      "implementation terms must not reach the public status box");
  });

  test("an over-long message names the message field, not 'message exceeds'", async () => {
    const res = await call({ body: { ...validContact, message: "x".repeat(4001) } });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /shorten your message to 4,000 characters/i);
  });

  test("a malformed body does not ask the visitor to repair JSON", async () => {
    const res = await call({ body: "{not json" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "INVALID_JSON", "the code stays machine-readable");
    assert.doesNotMatch(res.json().message, /JSON/i,
      "the visitor-facing message must not mention JSON");
    assert.match(res.json().message, /refresh the page|contact Crystal/i);
  });
});

/* =====================================================================
   readBody() AGAINST A REAL node:http SOCKET
   =====================================================================
   THE TWO DEFECTS THIS SECTION EXISTS TO HAVE CAUGHT, both on the LIVE
   lead path, both merged and live until #30:

     1. the streaming oversize branch called req.destroy(). `req` and
        `res` share ONE socket, so that destroyed the response with the
        request. res.end() still succeeds and res.writableEnded still
        becomes true, so THE HANDLER IS TOLD NOTHING — it logged a 413
        the visitor never received. The client got ECONNRESET.
     2. the streaming fallback had no time bound at all. A client that
        opened a request, sent part of a body and stalled held the
        invocation until the platform killed it.

   WHY THE WHOLE EXISTING SUITE WAS BLIND TO BOTH. tests/helpers.mjs
   mockReq() sets `req.body`, so EVERY pre-existing test in this file
   takes the already-parsed fast path. The streaming branch — the only
   branch either defect lived in — was never executed by any test, and
   the suite was green over both for as long as they existed.

   HOW THE STREAMING OVERSIZE BRANCH IS ACTUALLY REACHED, measured
   11 September 2026 against a real client on a throwaway copy of the
   tree with the two branches temporarily given distinct tokens:

     declared Content-Length over the cap  ->  the HEADER FAST PATH
     chunked, no Content-Length, over cap  ->  the STREAMING check

   So every streaming test below omits Content-Length and lets Node use
   chunked transfer encoding. A test that declares an oversize length is
   testing the header check, whatever its name says.
   ===================================================================== */
describe("readBody over a real socket", () => {
  /* The three lines api/lead.js actually runs on a body failure, kept in
     one place so every case below answers the way the endpoint does. */
  const answer = (res, reason) => {
    if (reason === "too_large") { res.statusCode = 413; res.end("PAYLOAD_TOO_LARGE"); return; }
    if (reason === "timed_out") { res.statusCode = 408; res.end("BODY_READ_TIMED_OUT"); return; }
    res.statusCode = 400; res.end("BAD_REQUEST");
  };

  /** Read the body the way api/lead.js does, then answer. */
  const leadLike = (opts = {}) => async (req, res, out) => {
    let raw;
    try {
      raw = await readBody(req, opts);
      out.server.reason = "resolved";
      out.server.bytes = Buffer.byteLength(raw);
      out.server.raw = raw;
    } catch (err) {
      out.server.reason = bodyErrorReason(err);
      out.server.token = err?.token;
    }
    /* THE ASSERTION THE STUBS COULD NOT MAKE — read BEFORE answering. */
    out.server.socketDestroyedBeforeAnswer = res.socket ? res.socket.destroyed : null;
    if (out.server.reason === "resolved") { res.statusCode = 200; res.end("ok"); }
    else answer(res, out.server.reason);
  };

  /* ---- 1. STREAMED OVERSIZE REACHES THE CLIENT AS 413 -------------- */
  test("a streamed oversize body is refused AND the client receives the 413", async () => {
    const seen = await withHttpServer(leadLike(), {
      /* No content-length: chunked, so the STREAMING size check decides. */
      headers: { "content-type": "application/json" },
      write: "x".repeat(MAX_BODY_BYTES + 1024),
      end: true,
    });

    assert.equal(seen.server.reason, "too_large", "the streaming byte cap did not refuse");
    assert.equal(seen.server.token, PAYLOAD_TOO_LARGE);
    assert.equal(seen.server.socketDestroyedBeforeAnswer, false,
      "the socket was already destroyed when the handler went to answer - the 413 cannot be delivered");
    assert.equal(seen.clientError, null,
      `the client got ${seen.clientError} instead of a response - the refusal was lost on the wire`);
    assert.equal(seen.clientStatus, 413, "the client did not receive the 413");
    assert.equal(seen.clientBody, "PAYLOAD_TOO_LARGE");
  });

  /* ---- 2. A STALLED BODY TIMES OUT AND THE CLIENT IS ANSWERED ------ */
  test("a stalled streamed body times out AND the client receives the 408", async () => {
    const seen = await withHttpServer(leadLike({ timeoutMs: 150 }), {
      headers: { "content-type": "application/json", "content-length": "200" },
      write: '{"form_type":"cont',   // a partial body, and then nothing - ever
      end: false,
    });

    assert.equal(seen.server.reason, "timed_out", "the bound did not fire");
    assert.equal(seen.server.token, BODY_READ_TIMED_OUT);
    assert.equal(seen.server.socketDestroyedBeforeAnswer, false);
    assert.equal(seen.clientError, null,
      `the client got ${seen.clientError} instead of a response - the refusal was lost on the wire`);
    assert.equal(seen.clientStatus, 408, "the client did not receive the timeout refusal");
    assert.equal(seen.clientBody, "BODY_READ_TIMED_OUT");
  });

  /* ---- THE REAL HANDLER, NOT A RESTATEMENT OF IT ------------------
     An earlier draft of this test re-implemented api/lead.js's sequence
     inside the test and asserted that nothing after the await ran. That
     proves how `try` works, not what the endpoint does. This one drives
     THE ACTUAL EXPORTED HANDLER over a real socket.

     WHY THE STATUS IS THE PROOF. HUBSPOT_ACCESS_TOKEN is absent in the
     test environment, so isConfigured() is false and ANY body that got
     as far as delivery answers 503 NOT_CONFIGURED. A 408 therefore means
     the request stopped at the body read: it never parsed, never
     validated, never built consent evidence, never appended to the
     ledger, never reached HubSpot and never reached the mailer. A 503 -
     or a 422, or a 200 - would each say it had gone further. */
  test("api/lead.js itself stops at the body read and never reaches delivery", async () => {
    _resetRateLimit();
    const seen = await withHttpServer(async (req, res) => {
      await handler(req, res);
    }, {
      headers: { "content-type": "application/json", "content-length": "200" },
      write: '{"form_type":"cont',
      end: false,
      guardMs: 9000,
    });

    assert.notEqual(seen.clientStatus, 503,
      "the handler reached the delivery stage - a body that never arrived must not get that far");
    assert.equal(seen.clientStatus, 408,
      `the real handler answered ${seen.clientStatus}, not the timeout refusal`);
    assert.equal(JSON.parse(seen.clientBody).code, "BODY_READ_TIMED_OUT");
    assert.equal(JSON.parse(seen.clientBody).ok, false);
  });

  /* THE PAIRED TEST THAT MAKES THE ONE ABOVE MEAN SOMETHING. If a
     complete body did NOT answer 503 here, "not 503" would be an
     assertion that could never fail and the 408 would prove only that
     something refused. This is the control: same handler, same socket,
     a body that DOES arrive, and it gets all the way to the delivery
     stage before failing for want of a CRM token. */
  test("a complete body over the same socket does reach delivery (the control)", async () => {
    _resetRateLimit();
    const body = JSON.stringify({
      form_type: "contact", first_name: "Jane", last_name: "Doe",
      email: "jane@example.com", phone: "4195551234", topic: "Selling my home",
      message: "I would like to talk about selling.", page: "/contact", attribution: {},
    });
    const seen = await withHttpServer(async (req, res) => {
      await handler(req, res);
    }, {
      headers: { "content-type": "application/json" },   // chunked
      write: body,
      end: true,
      guardMs: 9000,
    });

    assert.equal(seen.clientStatus, 503,
      "a complete body no longer reaches the delivery stage - the 408 test's discriminator is gone");
    assert.equal(JSON.parse(seen.clientBody).code, "NOT_CONFIGURED");
  });

  /* The same endpoint, the same socket, an oversize streamed body. */
  test("api/lead.js answers 413 over a real socket for a streamed oversize body", async () => {
    _resetRateLimit();
    const seen = await withHttpServer(async (req, res) => {
      await handler(req, res);
    }, {
      headers: { "content-type": "application/json" },   // chunked
      write: "x".repeat(MAX_BODY_BYTES + 1024),
      end: true,
      guardMs: 9000,
    });

    assert.equal(seen.clientError, null,
      `the visitor got ${seen.clientError} instead of a refusal - this is the live lead path`);
    assert.equal(seen.clientStatus, 413);
    assert.equal(JSON.parse(seen.clientBody).code, "PAYLOAD_TOO_LARGE");
  });

  /* ---- 3. AN ORDINARY STREAMED BODY IS UNAFFECTED ------------------ */
  test("a complete streamed body still resolves and answers 200", async () => {
    const body = JSON.stringify({ form_type: "contact", message: "hello" });
    const seen = await withHttpServer(leadLike(), {
      headers: { "content-type": "application/json" },   // chunked again
      write: body,
      end: true,
    });

    assert.equal(seen.server.reason, "resolved", "a complete streamed body was refused");
    assert.equal(seen.server.raw, body, "the body was altered or truncated in transit");
    assert.equal(seen.clientStatus, 200);
    assert.equal(seen.clientBody, "ok");
  });

  /* A body that arrives in pieces, slowly, but INSIDE the bound is a real
     visitor on a poor connection - not a stall. It must succeed. This is
     the direction that matters on the lead path: a bound tight enough to
     refuse a slow-but-genuine upload loses the lead, which is the outcome
     this project treats as worst. The chunks land at 60/120/180 ms
     against a 1500 ms bound, so the margin is deliberate and the test
     does not depend on machine speed to pass. */
  test("a body delivered in slow pieces inside the bound still succeeds", async () => {
    const head = '{"form_type":"contact","message":"';
    const tail = 'slow"}';
    const seen = await withHttpServer(leadLike({ timeoutMs: 1500 }), {
      headers: { "content-type": "application/json" },
      write: head,
      writes: [[60, "a"], [120, "b"], [180, tail]],
      endAt: 240,
      end: false,
      guardMs: 3000,
    });

    assert.equal(seen.server.reason, "resolved",
      `a slow but complete body was refused as ${seen.server.reason} - that is a lost lead`);
    assert.equal(seen.server.raw, head + "ab" + tail, "the reassembled body is not what was sent");
    assert.equal(seen.clientStatus, 200);
    assert.ok(seen.ms >= 180, `the body cannot have been fully read in ${seen.ms}ms`);
  });

  /* ---- THE BOUND IS TOTAL, NOT AN INACTIVITY GAP ------------------
     THIS IS THE TEST THAT DISTINGUISHES THEM, and without it the claim
     in the source - that the deadline covers the whole wait rather than
     the gap between chunks - would be inspection only.

     The client sends a chunk every 40 ms, forever. An INACTIVITY timer
     of 300 ms would be reset by every one of those chunks and would
     never fire; a TOTAL bound of 300 ms fires while data is still
     arriving. The body is never ended, so only the bound can settle it. */
  test("a body that keeps dripping past the deadline is still refused", async () => {
    const drip = [];
    for (let at = 40; at <= 1200; at += 40) drip.push([at, "."]);

    const seen = await withHttpServer(leadLike({ timeoutMs: 300 }), {
      headers: { "content-type": "application/json" },
      write: "{",
      writes: drip,
      end: false,
      guardMs: 4000,
    });

    assert.equal(seen.server.reason, "timed_out",
      "a client still sending data was not bounded - the deadline resets on activity");
    assert.equal(seen.clientStatus, 408, "the client did not receive the timeout refusal");
    /* THE DISCRIMINATING NUMBER, and an earlier draft of this assertion
       got it wrong. The drip runs to 1200 ms, so an INACTIVITY timer of
       300 ms would settle at roughly 1500 ms - which a loose ceiling of
       2000 ms would have accepted, making the test pass against the very
       behaviour it exists to rule out. A TOTAL bound settles at ~300 ms.
       900 ms sits well clear of both: three times the total bound, and
       well under the inactivity one. */
    assert.ok(seen.ms < 900,
      `the refusal took ${seen.ms}ms - at a 300ms total bound that is an inactivity timer being reset by the drip`);
  });

  /* ---- 4. THE DECLARED-LENGTH FAST PATH IS UNCHANGED --------------- */
  test("a declared Content-Length over the cap is still refused immediately", async () => {
    const seen = await withHttpServer(leadLike(), {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_BODY_BYTES + 64),
      },
      /* Nothing is written at all: the refusal must come from the header
         alone, before a byte of body is read. */
      write: null,
      end: false,
    });

    assert.equal(seen.server.reason, "too_large", "the declared-length fast path stopped refusing");
    assert.equal(seen.server.socketDestroyedBeforeAnswer, false);
    assert.equal(seen.clientStatus, 413, "the client did not receive the 413");
    assert.ok(seen.ms < 1000,
      `the header refusal took ${seen.ms}ms - it must not wait for a body it already refused`);
  });

  /* ---- 5. THE ALREADY-PARSED FAST PATH IS UNCHANGED ---------------- */
  test("an already-populated req.body still works and stays immediate", async () => {
    const body = JSON.stringify({ form_type: "contact", message: "platform-parsed" });
    const seen = await withHttpServer(async (req, res, out) => {
      /* What the platform does before the handler runs. The socket is
         real; this branch is simply not reachable by writing bytes. */
      req.body = body;
      await leadLike()(req, res, out);
    }, {
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      /* The bytes are deliberately NEVER sent. If this path waited on the
         stream at all - or armed a timer for it - the test would stall
         and the guard would report NO_ANSWER. */
      write: null,
      end: false,
    });

    assert.equal(seen.server.reason, "resolved", "the pre-parsed fast path stopped working");
    assert.equal(seen.server.raw, body);
    assert.equal(seen.clientStatus, 200);
    assert.ok(seen.ms < 1000,
      `the pre-parsed path took ${seen.ms}ms - it must not wait on a stream it never reads`);
  });

  test("an oversize already-populated req.body is still refused", async () => {
    const big = JSON.stringify({ message: "x".repeat(MAX_BODY_BYTES + 64) });
    const seen = await withHttpServer(async (req, res, out) => {
      req.body = big;
      await leadLike()(req, res, out);
    }, {
      headers: { "content-type": "application/json" },
      write: null,
      end: false,
    });

    assert.equal(seen.server.reason, "too_large");
    assert.equal(seen.clientStatus, 413);
  });
});
