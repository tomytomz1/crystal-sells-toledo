/* The consent-enabled build is a RELEASE GATE, not a local convenience.
 * =====================================================================
 * THE GAP THIS FILE CLOSES.
 *
 * `npm test` is `node tools/build.mjs && node tools/check.mjs && node
 * --test tests/*.test.mjs`, and .github/workflows/test.yml sets no
 * COMMUNICATIONS_CONSENT_ENABLED. So the one check.mjs run in CI has
 * CONSENT_ON === false, and EVERY guard inside `if (CONSENT_ON)` — the
 * checkbox defaults, the canonical disclosure match, the legal pages,
 * the A2P surfaces and the new /sms-consent-evidence page — never
 * executed on the gate. Those guards were real; they were simply never
 * reached. Production runs with the flag ON, so the only state CI
 * verified was the one production is not in.
 *
 * Nothing about production changes here. The remedy is that the gate now
 * runs check.mjs in BOTH states, from a test, which is portable in a way
 * an inline environment assignment in an npm script is not.
 *
 * WHY THE MUTATIONS. A guard that runs is not yet a guard that bites —
 * this repository has shipped a vacuous one before. Each case below
 * breaks one consent-enabled invariant in a THROWAWAY COPY and asserts
 * two things at once:
 *
 *   flag OFF  -> check.mjs still PASSES   (this is the gap, demonstrated)
 *   flag ON   -> check.mjs FAILS          (this is the coverage, proved)
 *
 * The working tree is never mutated: every case builds its own copy and
 * deletes it. See CLAUDE.md, "Never mutate the working tree to prove a
 * test".
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAG } from "../api/_lib/consent.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/* EVERY tracked file, not a hand-listed subset. check.mjs validates far
   more than the build reads - .env.example, db/*.sql, vercel.json, the
   api/ tree - and a tree missing any of them fails for reasons that have
   nothing to do with the mutation under test. An earlier proof in this
   repository hand-listed the inputs, omitted src/, and recorded fourteen
   identical ENOENT crashes as fourteen passes.

   `--others --exclude-standard` includes files added in the working tree
   but not yet committed, so a run before `git add` tests the same tree a
   run after it does; `.gitignore` still keeps node_modules and public
   out. */
const TRACKED = execFileSync(
  "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 },
).split("\0").filter(Boolean);

/** A complete throwaway copy of the repository at its working state. */
function freshTree() {
  const dir = mkdtempSync(join(tmpdir(), "cst-gate-"));
  for (const rel of TRACKED) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO, rel), dest);
  }
  for (const item of ["src", "assets", "tools", "api", "db", "package.json", ".env.example"])
    assert.ok(existsSync(join(dir, item)), `throwaway tree is missing ${item}`);
  return dir;
}

/** Build and check one tree in one flag state. Returns {ok, output}. */
function buildAndCheck(dir, on) {
  const env = { ...process.env, [FEATURE_FLAG]: on ? "true" : "false" };
  for (const script of ["tools/build.mjs", "tools/check.mjs"]) {
    try {
      execFileSync(process.execPath, [script], { cwd: dir, env, stdio: "pipe" });
    } catch (e) {
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`, script };
    }
  }
  return { ok: true, output: "" };
}

const edit = (dir, rel, fn) => {
  const p = join(dir, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  assert.notEqual(after, before, `mutation for ${rel} matched nothing - the test proves nothing`);
  writeFileSync(p, after);
};

describe("the consent-enabled build is verified by the gate", () => {
  test("a clean tree passes check.mjs in BOTH flag states", () => {
    const dir = freshTree();
    try {
      for (const on of [false, true]) {
        const r = buildAndCheck(dir, on);
        assert.ok(r.ok, `clean tree failed with the flag ${on ? "ON" : "OFF"}:\n${r.output}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the consent-enabled build publishes what the consent-disabled build must not", () => {
    const dir = freshTree();
    try {
      buildAndCheck(dir, false);
      const off = join(dir, "public");
      for (const f of ["communications-terms.html", "sms-privacy.html", "sms-terms.html",
                       "sms-consent-evidence.html"])
        assert.equal(existsSync(join(off, f)), false, `${f} was published with the feature off`);

      buildAndCheck(dir, true);
      const on = join(dir, "public");
      for (const f of ["communications-terms.html", "sms-privacy.html", "sms-terms.html",
                       "sms-consent-evidence.html"])
        assert.equal(existsSync(join(on, f)), true, `${f} was not published with the feature on`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /* ------------------------------------------------------------------
     Non-vacuity. Each case is a real defect a reviewer would care about.
     ------------------------------------------------------------------ */
  const CASES = [
    {
      name: "a pre-ticked SMS consent box",
      apply: (dir) => edit(dir, "src/partials/consent-block.html", (s) =>
        s.replace('id="consent-sms" name="sms_consent" type="checkbox" value="true"',
                  'id="consent-sms" name="sms_consent" type="checkbox" value="true" checked')),
      expect: /pre-checked/,
    },
    {
      name: "a required SMS consent box",
      apply: (dir) => edit(dir, "src/partials/consent-block.html", (s) =>
        s.replace('id="consent-sms" name="sms_consent" type="checkbox" value="true"',
                  'id="consent-sms" name="sms_consent" type="checkbox" value="true" required')),
      expect: /is required/,
    },
    {
      name: "an evidence page whose disclosure no longer comes from the canonical source",
      apply: (dir) => edit(dir, "src/pages/sms-consent-evidence.html", (s) =>
        s.replace("{{consentSmsHtml}}",
                  "I agree to receive text messages from Crystal Sells Toledo about my inquiry.")),
      expect: /does not match the canonical text/,
    },
    {
      name: "an evidence page that grew a real consent control",
      apply: (dir) => edit(dir, "src/pages/sms-consent-evidence.html", (s) =>
        s.replace('<span class="consent__box consent__box--static" aria-hidden="true"></span>',
                  '<input class="consent__box" name="sms_consent" type="checkbox" value="true">')),
      expect: /must not be a real control|record consent/,
    },
    {
      name: "a privacy page that lost the SMS opt-in carve-out",
      apply: (dir) => edit(dir, "src/partials/privacy-sms-scope.html", (s) =>
        s.replace("SMS opt-in and your SMS consent are never transferred", "details are shared as needed")),
      expect: /not transferred by transaction-related sharing/,
    },
    {
      name: "a privacy page that overclaims mobile information is never shared in a transaction",
      apply: (dir) => edit(dir, "src/partials/privacy-sms-scope.html", (s) =>
        s.replace("<p><strong>Your SMS opt-in and your SMS consent are never transferred as part of that",
                  "<p><strong>This transaction-related sharing does not include mobile information, and your SMS consent is never transferred as part of that")),
      expect: /claims transaction sharing excludes mobile information outright/,
    },
    {
      name: "a step-1 link relabelled back to something a reviewer reads as the SMS policy",
      apply: (dir) => edit(dir, "src/partials/home-value-form.html", (s) =>
        s.replace('<a href="/privacy">Website Privacy Policy</a>',
                  '<a href="/privacy">Privacy &amp; terms</a>')),
      expect: /Website Privacy Policy/,
    },
  ];

  for (const c of CASES) {
    test(`${c.name}: passes with the flag OFF, fails with the flag ON`, () => {
      const dir = freshTree();
      try {
        c.apply(dir);

        const off = buildAndCheck(dir, false);
        assert.ok(off.ok,
          "the consent-disabled gate caught this, so it proves nothing about the " +
          `consent-enabled path. Rewrite the case.\n${off.output}`);

        const on = buildAndCheck(dir, true);
        assert.equal(on.ok, false,
          "the consent-ENABLED gate did not catch it - the guard is vacuous");
        assert.match(on.output, c.expect,
          `it failed, but not for the expected reason:\n${on.output}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

/* =====================================================================
   Gate 8 — the guards that must hold in BOTH flag states.
   =====================================================================
   The consent guards above are flag-asymmetric by nature: they describe a
   surface that only exists when the programme is on. The Gate 8 guards are
   not. A future sender importing the pure resolver directly is a defect
   whether or not the opt-in UI is rendering, so these mutations must fail
   with the flag OFF *and* ON.

   Each case was verified to fail by construction before being written
   down; they are kept so the guards cannot quietly stop biting.
   ===================================================================== */
describe("the Gate 8 send-time boundary cannot be bypassed", () => {
  const GATE8 = "api/_lib/send-permission.mjs";

  const CASES = [
    {
      name: "a future sender that imports the pure resolver directly",
      apply: (dir) => writeFileSync(join(dir, "api/_lib/twilio-sender.mjs"),
        'import { canSendSms } from "./permission.mjs";\n' +
        'export const send = (s, p) => canSendSms(s, p);\n'),
      expect: /calls canSendSms\(\) directly - every sender must go through/,
    },
    {
      name: "a Gate 8 that stops consulting the durable ledger",
      apply: (dir) => edit(dir, GATE8, (s) =>
        s.replace("public.get_suppression_state($1)", "public.some_other_thing($1)")),
      expect: /does not call public\.get_suppression_state/,
    },
    {
      name: "a Gate 8 that reads the ledger table instead of the narrow function",
      apply: (dir) => edit(dir, GATE8, (s) =>
        s.replace("FROM public.get_suppression_state($1)", "FROM communication_consent_events")),
      expect: /names the ledger table/,
    },
    {
      name: "a Gate 8 that reuses the append credential for send authorization",
      apply: (dir) => edit(dir, GATE8, (s) =>
        s.replace('export const SUPPRESSION_LOOKUP_TIMEOUT_MS',
                  'const reused = process.env.CONSENT_LEDGER_URL;\nexport const SUPPRESSION_LOOKUP_TIMEOUT_MS')),
      expect: /reuses the append credential/,
    },
  ];

  for (const c of CASES) {
    test(`${c.name}: fails the gate with the flag OFF and ON`, () => {
      const dir = freshTree();
      try {
        c.apply(dir);
        for (const on of [false, true]) {
          const r = buildAndCheck(dir, on);
          assert.equal(r.ok, false,
            `the gate accepted it with the flag ${on ? "ON" : "OFF"} - the guard is vacuous`);
          assert.match(r.output, c.expect,
            `it failed with the flag ${on ? "ON" : "OFF"}, but not for the expected reason:\n${r.output}`);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
