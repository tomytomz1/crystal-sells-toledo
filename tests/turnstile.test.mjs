/* Cloudflare Turnstile — explicit activation, server verification and the
 * no-side-effect boundary on POST /api/lead. All Cloudflare traffic is stubbed;
 * no test in this file needs Internet access or a real credential. */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler from "../api/lead.js";
import { validateLead, FieldError } from "../api/_lib/validate.mjs";
import {
  readTurnstileConfig,
  TURNSTILE_STATES,
  TURNSTILE_CONFIG_REASONS,
} from "../api/_lib/turnstile-config.mjs";
import {
  verifyTurnstile,
  turnstileEnabled,
  turnstileState,
  turnstileLogShape,
  isTokenFault,
  REASONS,
  SITEVERIFY_URL,
  MAX_TOKEN_CHARS,
  TURNSTILE_TIMEOUT_MS,
} from "../api/_lib/turnstile.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { safeShape } from "../api/_lib/log.mjs";
import {
  prepareTurnstileBuildEnv,
  stripTurnstileFromNonFormPage,
} from "../tools/build-entry.mjs";
import { mockReq, mockRes, validContact, validHomeValue } from "./helpers.mjs";

const TEST_SITE = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const MANAGED_ENV = [
  "TURNSTILE_ENABLED", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
  "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID",
  "COMMUNICATIONS_CONSENT_ENABLED", "CONSENT_LEDGER_URL",
  "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD",
];
let savedEnv;
let savedFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  savedFetch = globalThis.fetch;
  _resetRateLimit();
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = savedFetch;
  _resetRateLimit();
});

function enable() {
  process.env.TURNSTILE_ENABLED = "true";
  process.env.TURNSTILE_SITE_KEY = TEST_SITE;
  process.env.TURNSTILE_SECRET_KEY = TEST_SECRET;
}

const okBody = (over = {}) => ({
  success: true,
  hostname: "crystalsellstoledo.com",
  action: "contact",
  "error-codes": [],
  challenge_ts: "2026-09-18T12:00:00.000Z",
  ...over,
});

const response = (body, { text } = {}) => ({
  ok: true,
  status: 200,
  async text() { return text === undefined ? JSON.stringify(body) : text; },
});

function siteverifyStub(responder) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

async function call(body, headers = {}) {
  const req = mockReq({ body, headers });
  const res = mockRes();
  await handler(req, res);
  return res;
}

describe("explicit configuration state", () => {
  test("absent, empty and exact false are disabled even when keys remain stored", () => {
    for (const flag of [undefined, "", "false"]) {
      const env = {
        TURNSTILE_SITE_KEY: TEST_SITE,
        TURNSTILE_SECRET_KEY: TEST_SECRET,
      };
      if (flag !== undefined) env.TURNSTILE_ENABLED = flag;
      const cfg = readTurnstileConfig(env);
      assert.equal(cfg.state, TURNSTILE_STATES.DISABLED);
    }
  });

  test("exact true plus both keys is enabled", () => {
    const cfg = readTurnstileConfig({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: TEST_SITE,
      TURNSTILE_SECRET_KEY: TEST_SECRET,
    });
    assert.equal(cfg.state, TURNSTILE_STATES.ENABLED);
  });

  test("enabled with a missing key is misconfigured, never silently disabled", () => {
    const noSecret = readTurnstileConfig({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: TEST_SITE,
    });
    assert.equal(noSecret.state, TURNSTILE_STATES.MISCONFIGURED);
    assert.equal(noSecret.reason, TURNSTILE_CONFIG_REASONS.MISSING_SECRET_KEY);

    const noSite = readTurnstileConfig({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SECRET_KEY: TEST_SECRET,
    });
    assert.equal(noSite.state, TURNSTILE_STATES.MISCONFIGURED);
    assert.equal(noSite.reason, TURNSTILE_CONFIG_REASONS.MISSING_SITE_KEY);
  });

  test("a typo in the flag is a fail-closed configuration error", () => {
    const cfg = readTurnstileConfig({ TURNSTILE_ENABLED: "TRUE" });
    assert.equal(cfg.state, TURNSTILE_STATES.MISCONFIGURED);
    assert.equal(cfg.reason, TURNSTILE_CONFIG_REASONS.INVALID_FLAG);
  });

  test("handler predicate enters the gate for misconfiguration", () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SITE_KEY = TEST_SITE;
    assert.equal(turnstileEnabled(), true);
    assert.equal(turnstileState(), TURNSTILE_STATES.MISCONFIGURED);
  });
});

describe("build activation", () => {
  test("disabled strips stored keys from the build process", () => {
    const env = {
      TURNSTILE_ENABLED: "false",
      TURNSTILE_SITE_KEY: TEST_SITE,
      TURNSTILE_SECRET_KEY: TEST_SECRET,
    };
    const cfg = prepareTurnstileBuildEnv(env);
    assert.equal(cfg.state, TURNSTILE_STATES.DISABLED);
    assert.equal(env.TURNSTILE_SITE_KEY, undefined);
    assert.equal(env.TURNSTILE_SECRET_KEY, undefined);
  });

  test("enabled build refuses missing configuration", () => {
    assert.throws(
      () => prepareTurnstileBuildEnv({ TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: TEST_SITE }),
      /configuration is invalid \(missing_secret_key\)/
    );
  });

  test("enabled build keeps both configured keys", () => {
    const env = {
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: TEST_SITE,
      TURNSTILE_SECRET_KEY: TEST_SECRET,
    };
    const cfg = prepareTurnstileBuildEnv(env);
    assert.equal(cfg.state, TURNSTILE_STATES.ENABLED);
    assert.equal(env.TURNSTILE_SITE_KEY, TEST_SITE);
    assert.equal(env.TURNSTILE_SECRET_KEY, TEST_SECRET);
  });

  test("Cloudflare loader is removed from pages without a lead form", () => {
    const loader = `\n<link rel="preconnect" href="https://challenges.cloudflare.com">\n` +
      `<!-- Cloudflare Turnstile. Public sitekey, injected at build time. The\n` +
      `SECRET key is never here - it is read only by the Vercel function. -->\n` +
      `<script>window.__csvTurnstile={};</script>\n` +
      `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=csvTurnstileReady"\n` +
      ` async defer onerror="window.__csvTurnstileReject()"></script>`;
    const plain = `<html><head>${loader}</head><body>About</body></html>`;
    const stripped = stripTurnstileFromNonFormPage(plain);
    assert.equal(stripped.includes("challenges.cloudflare.com"), false);

    const lead = `<html><head>${loader}</head><body><div data-turnstile></div></body></html>`;
    assert.equal(stripTurnstileFromNonFormPage(lead), lead);
  });
});

describe("siteverify contract", () => {
  beforeEach(enable);

  test("missing and malformed tokens are rejected locally", async () => {
    for (const token of [undefined, null, "", 123, {}, "abc\ndef", "x".repeat(MAX_TOKEN_CHARS + 1)]) {
      const fetchImpl = siteverifyStub(() => response(okBody()));
      const verdict = await verifyTurnstile({ token, expectedAction: "contact", fetchImpl });
      assert.equal(verdict.ok, false);
      assert.ok([REASONS.MISSING, REASONS.MALFORMED].includes(verdict.reason));
      assert.equal(fetchImpl.calls.length, 0);
    }
  });

  test("posts only secret and token to the documented endpoint", async () => {
    const fetchImpl = siteverifyStub(() => response(okBody()));
    const verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.ok, true);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, SITEVERIFY_URL);
    const body = JSON.parse(fetchImpl.calls[0].options.body);
    assert.deepEqual(Object.keys(body).sort(), ["response", "secret"]);
    assert.equal(body.response, TOKEN);
    assert.equal(body.secret, TEST_SECRET);
  });

  test("success must be boolean true", async () => {
    for (const success of ["true", 1, "1", undefined, null]) {
      const fetchImpl = siteverifyStub(() => response(okBody({ success })));
      const verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
      assert.equal(verdict.ok, false);
    }
  });

  test("hostname and action bind a token to this site and this form", async () => {
    let fetchImpl = siteverifyStub(() => response(okBody({ hostname: "attacker.example" })));
    let verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.reason, REASONS.HOSTNAME);

    fetchImpl = siteverifyStub(() => response(okBody({ action: "contact" })));
    verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "home_value", fetchImpl });
    assert.equal(verdict.reason, REASONS.ACTION);
  });

  test("expired/replayed token is a token fault", async () => {
    const fetchImpl = siteverifyStub(() => response({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    }));
    const verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.reason, REASONS.REJECTED);
    assert.equal(isTokenFault(verdict.reason), true);
  });

  test("invalid server secret is a configuration error", async () => {
    const fetchImpl = siteverifyStub(() => response({
      success: false,
      "error-codes": ["invalid-input-secret"],
    }));
    const verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.reason, REASONS.CONFIGURATION);
    assert.equal(verdict.config_reason, TURNSTILE_CONFIG_REASONS.INVALID_SECRET_KEY);
  });

  test("network and malformed responses fail closed", async () => {
    let fetchImpl = siteverifyStub(() => { throw new Error("network down"); });
    let verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.reason, REASONS.UNVERIFIED);

    fetchImpl = siteverifyStub(() => response(null, { text: "<html>bad gateway</html>" }));
    verdict = await verifyTurnstile({ token: TOKEN, expectedAction: "contact", fetchImpl });
    assert.equal(verdict.reason, REASONS.UNVERIFIED);
  });

  test("timeout has its own stable reason", async () => {
    const fetchImpl = siteverifyStub((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const verdict = await verifyTurnstile({
      token: TOKEN,
      expectedAction: "contact",
      fetchImpl,
      timeoutMs: 30,
    });
    assert.equal(verdict.reason, REASONS.TIMEOUT);
    assert.equal(TURNSTILE_TIMEOUT_MS, 5000);
  });
});

describe("runtime endpoint boundary", () => {
  test("disabled flag makes no Turnstile request even if both keys are stored", async () => {
    process.env.TURNSTILE_ENABLED = "false";
    process.env.TURNSTILE_SITE_KEY = TEST_SITE;
    process.env.TURNSTILE_SECRET_KEY = TEST_SECRET;
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;
    const res = await call(validContact);
    assert.equal(res.json().code, "NOT_CONFIGURED");
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("enabled valid challenge proceeds into the existing lead pipeline", async () => {
    enable();
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;
    const res = await call({ ...validContact, turnstile_token: TOKEN });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(res.json().code, "NOT_CONFIGURED");
  });

  test("enabled missing token is refused before a submission id or downstream work", async () => {
    enable();
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;
    const res = await call(validContact);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, "VERIFICATION_FAILED");
    assert.equal(res.json().submission_id, undefined);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("enabled but missing secret fails closed instead of silently disabling", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SITE_KEY = TEST_SITE;
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;
    const res = await call({ ...validContact, turnstile_token: TOKEN });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "VERIFICATION_UNAVAILABLE");
    assert.equal(res.json().submission_id, undefined);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("Cloudflare outage fails closed before submission id", async () => {
    enable();
    const fetchImpl = siteverifyStub(() => { throw new Error("down"); });
    globalThis.fetch = fetchImpl;
    const res = await call({ ...validContact, turnstile_token: TOKEN });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().submission_id, undefined);
  });

  test("honeypot and schema validation still reject before Cloudflare", async () => {
    enable();
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;

    let res = await call({ ...validContact, _gotcha: "spam", turnstile_token: TOKEN });
    assert.equal(res.json().code, "REJECTED");
    assert.equal(fetchImpl.calls.length, 0);

    _resetRateLimit();
    res = await call({ ...validContact, email: "not-email", turnstile_token: TOKEN });
    assert.equal(res.json().code, "INVALID_EMAIL");
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("token never appears in logs or safeShape output", async () => {
    enable();
    const fetchImpl = siteverifyStub(() => response(okBody()));
    globalThis.fetch = fetchImpl;
    const lines = [];
    const real = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await call({ ...validContact, turnstile_token: TOKEN });
    } finally {
      console.log = real;
    }
    assert.equal(lines.join("\n").includes(TOKEN), false);
    const shaped = safeShape({ turnstile_token: TOKEN, "cf-turnstile-response": TOKEN });
    assert.equal(JSON.stringify(shaped).includes(TOKEN), false);
  });
});

describe("home_value physical-address rule", () => {
  test("normal physical street addresses are accepted", () => {
    for (const address of [
      "123 Main St, Toledo, OH 43604",
      "7824 Oak Ridge Drive, Sylvania, OH",
      "10 Boxwood Lane, Perrysburg, OH 43551",
      /* "Post Office" WITHOUT "Box" is a street name, not a mail drop. The
         rule's spelled-out branch requires BOX; drop that requirement and
         these real addresses are hard-rejected before the CRM. */
      "1 Post Office Road, Maumee, OH",
      "5 Post Office Square, Toledo, OH",
    ]) {
      const result = validateLead({ ...validHomeValue, property_address: address });
      assert.equal(result.lead.property_address, address);
    }
  });

  test("common P.O. Box spellings are rejected for home_value", () => {
    for (const address of [
      "PO Box 123, Toledo, OH",
      "P.O. Box 123",
      "P O Box 123",
      "Post Office Box 123",
      "907 Po Box, Swannanoa, NC",
    ]) {
      assert.throws(
        () => validateLead({ ...validHomeValue, property_address: address }),
        (err) => err instanceof FieldError
          && err.code === "INVALID_PROPERTY_ADDRESS"
          && /physical street address/i.test(err.message),
        address
      );
    }
  });

  test("P.O. Box text in a contact message is not treated as a property address", () => {
    const result = validateLead({
      ...validContact,
      message: "My mailing address is P.O. Box 99; I am asking a general question.",
    });
    assert.equal(result.lead.form_type, "contact");
  });
});

describe("safe log vocabulary", () => {
  test("configuration and mismatches are bounded and token-free", () => {
    const cfg = turnstileLogShape({
      ok: false,
      reason: REASONS.CONFIGURATION,
      config_reason: TURNSTILE_CONFIG_REASONS.MISSING_SECRET_KEY,
    });
    assert.deepEqual(cfg, {
      ok: false,
      reason: REASONS.CONFIGURATION,
      config_reason: TURNSTILE_CONFIG_REASONS.MISSING_SECRET_KEY,
    });

    const mismatch = turnstileLogShape({
      ok: false,
      reason: REASONS.HOSTNAME,
      hostname: "a".repeat(5000),
      token: TOKEN,
    });
    assert.ok(mismatch.hostname.length <= 129);
    assert.equal(JSON.stringify(mismatch).includes(TOKEN), false);
  });
});
