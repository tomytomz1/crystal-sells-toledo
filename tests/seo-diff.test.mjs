/* tools/seo-diff.mjs — the arithmetic, and the caveats it must carry.
 *
 * Drives the script as a REAL CHILD PROCESS against snapshots written into
 * a throwaway directory via SEO_OUT_DIR. Nothing here writes into
 * docs/seo: CLAUDE.md forbids mutating the working tree to prove a test,
 * and .github/workflows/seo-report.yml commits whatever is under that
 * path, so a stray file would be committed as though it were real search
 * data.
 *
 * These prove the deltas, the threshold decisions, and — as much as the
 * numbers themselves — that the report carries the two caveats a reader
 * needs to not misread it: that consecutive windows OVERLAP, and that a
 * query vanishing from the table is not necessarily lost traffic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "seo-diff.mjs");

const OUT = mkdtempSync(join(tmpdir(), "seo-diff-test-"));
process.on("exit", () => rmSync(OUT, { recursive: true, force: true }));

/** A fresh directory per case, so cases cannot see each other's files. */
function dirWith(files) {
  const dir = mkdtempSync(join(OUT, "case-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
  return dir;
}

function run(dir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath, [SCRIPT],
      { env: { PATH: process.env.PATH, SEO_OUT_DIR: dir }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

const snapshot = ({ start, end, gsc, ga4, sources } = {}) => ({
  generated: `${end}T12:00:00.000Z`,
  range: { start, end, days: 28 },
  sources: sources || { searchConsole: "queried", analytics: "queried" },
  ...(gsc === null ? {} : {
    searchConsole: {
      site: "sc-domain:example.com",
      totals: { clicks: 2, impressions: 76, ctr: 0.026, position: 16.3 },
      queries: [], pages: [], daily: [], anonymisedImpressions: 61,
      ...gsc,
    },
  }),
  ...(ga4 === null ? {} : {
    analytics: {
      property: "123456",
      totals: { sessions: 66, users: 45, keyEvents: 1 },
      channels: [], landingPages: [],
      ...ga4,
    },
  }),
});

const q = (query, impressions, position) => ({ query, clicks: 0, impressions, ctr: 0, position });

describe("before there is anything to compare", () => {
  test("one snapshot says so plainly and is not material", async () => {
    const { code, stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14" }),
    }));
    assert.equal(code, 0);
    assert.match(stdout, /Only 1 snapshot/);
    assert.match(stdout, /A diff needs two/);
  });

  test("an empty directory does not crash", async () => {
    const { code, stdout } = await run(dirWith({}));
    assert.equal(code, 0);
    assert.match(stdout, /Only 0 snapshots/);
  });
});

describe("the overlap caveat", () => {
  /* The single most misreadable thing in this report. Weekly snapshots of
     a trailing 28-day window share 21 days, so a delta is not week-over-
     week. If this warning ever stops being printed, every number above it
     becomes misleading. */
  test("is stated, with the correct day count, on every comparison", async () => {
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14" }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21" }),
    }));
    assert.match(stdout, /overlap by 21 of 28 days/);
    assert.match(stdout, /not\*{0,2} week-over-week/i);
  });

  test("is NOT claimed when the windows do not overlap", async () => {
    /* A missed weekly run, or a hand-run over an older pair. Telling the
       reader to discount a delta that is actually a clean comparison is
       worse than saying nothing. */
    const { stdout } = await run(dirWith({
      "2026-06-30.json": snapshot({ start: "2026-06-03", end: "2026-06-30" }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21" }),
    }));
    assert.match(stdout, /do not overlap/);
    assert.match(stdout, /55-day gap/);
    assert.match(stdout, /not a continuous history/);
    assert.ok(!/overlap by \d+ of/.test(stdout), "an overlap was claimed for a non-overlapping pair");
  });
});

describe("Search Console arithmetic", () => {
  const pair = (prevGsc, currGsc) => dirWith({
    "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", gsc: prevGsc }),
    "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21", gsc: currGsc }),
  });

  test("totals deltas are signed correctly", async () => {
    const { stdout } = await run(pair(
      { totals: { clicks: 2, impressions: 76, ctr: 0.026, position: 16.3 }, anonymisedImpressions: 61 },
      { totals: { clicks: 5, impressions: 90, ctr: 0.055, position: 12.1 }, anonymisedImpressions: 70 },
    ));
    assert.match(stdout, /\| clicks \| 2 \| 5 \| \+3 \|/);
    assert.match(stdout, /\| impressions \| 76 \| 90 \| \+14 \|/);
    assert.match(stdout, /anonymised impressions \| 61 \| 70 \| \+9/);
  });

  test("a FALLING average position reads as an improvement, not a loss", async () => {
    /* Position is a rank: lower is better. Rendering -4.2 without marking
       it as an improvement is the classic way to make a good week look
       like a bad one. */
    const { stdout } = await run(pair(
      { totals: { clicks: 0, impressions: 10, ctr: 0, position: 16.3 } },
      { totals: { clicks: 0, impressions: 10, ctr: 0, position: 12.1 } },
    ));
    assert.match(stdout, /avg position \| 16\.3 \| 12\.1 \| -4\.2 ▲/);
  });

  test("a new query above the threshold is called out; a trivial one is not", async () => {
    const { stdout } = await run(pair(
      { queries: [q("crystal saylor", 3, 8)] },
      { queries: [q("crystal saylor", 3, 8), q("perrysburg listing agent", 9, 31), q("noise", 1, 88)] },
    ));
    assert.match(stdout, /Queries that appeared/);
    assert.match(stdout, /perrysburg listing agent/);
    assert.match(stdout, /new query .*perrysburg listing agent.* — 9 impressions/);
    /* Present in the table, absent from the verdict. */
    assert.match(stdout, /\| `noise` \| 1 \|/);
    assert.ok(!/new query `noise`/.test(stdout), "a 1-impression query is not material");
  });

  test("a vanished query is reported WITH the anonymisation caveat", async () => {
    /* Without this sentence a reader concludes the traffic died, when
       Google may simply have stopped disclosing it. */
    const { stdout } = await run(pair(
      { queries: [q("toledo home sellers", 2, 46.5)] },
      { queries: [] },
    ));
    assert.match(stdout, /Queries that stopped showing/);
    assert.match(stdout, /withholds low-volume queries/);
    assert.match(stdout, /toledo home sellers/);
  });

  test("a large position move is material; a small one is reported but not flagged", async () => {
    const { stdout } = await run(pair(
      { queries: [q("big", 5, 40), q("small", 5, 20)] },
      { queries: [q("big", 5, 12), q("small", 5, 19)] },
    ));
    assert.match(stdout, /`big` moved up 28\.0/);
    assert.ok(!/`small` moved/.test(stdout), "a 1.0 move is below the threshold");
    /* ...but it still appears in the detail table. */
    assert.match(stdout, /\| `small` \| 20\.0 \| 19\.0 \|/);
  });

  test("crossing into the top 20 is called out on its own", async () => {
    const { stdout } = await run(pair(
      { queries: [q("climber", 5, 24)] },
      { queries: [q("climber", 5, 18)] },
    ));
    assert.match(stdout, /entered the top 20/);
  });

  test("page impression moves above the threshold are material", async () => {
    const page = (p, impressions) => ({ page: p, clicks: 0, impressions, ctr: 0, position: 10 });
    const { stdout } = await run(pair(
      { pages: [page("https://example.com/sell", 16)] },
      { pages: [page("https://example.com/sell", 40)] },
    ));
    assert.match(stdout, /\/sell impressions \+24/);
  });
});

describe("GA4", () => {
  test("a key-event change is material and carries its unverified caveat", async () => {
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", ga4: { totals: { sessions: 66, users: 45, keyEvents: 1 } } }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21", ga4: { totals: { sessions: 70, users: 48, keyEvents: 4 } } }),
    }));
    assert.match(stdout, /key events \+3 \(1 → 4\)/);
    assert.match(stdout, /still unverified what this counts/);
  });
});

describe("shapes that do not line up", () => {
  test("a source skipped on one side is 'not comparable', never a fake delta", async () => {
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", ga4: null, sources: { searchConsole: "queried", analytics: "skipped — GA4_PROPERTY_ID unset" } }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21" }),
    }));
    assert.match(stdout, /Not comparable/);
    assert.match(stdout, /skipped — GA4_PROPERTY_ID unset/);
    /* A missing section must not be read as zero. */
    assert.ok(!/sessions \| 0 \|/.test(stdout), "an absent section was treated as zeroes");
  });

  test("the landingPages shape seam is declared, not silently diffed", async () => {
    /* docs/seo/2026-09-14.json carries raw rows with `users`; later
       snapshots are folded without it. Comparing across the seam would
       report a code change as a traffic change. */
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", ga4: { landingPages: [{ page: "/", sessions: 40, users: 35, keyEvents: 1 }] } }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21", ga4: { landingPages: [{ page: "/", sessions: 43, keyEvents: 1 }] } }),
    }));
    assert.match(stdout, /snapshot shape changed between them/);
  });
});

describe("the verdict", () => {
  test("says no when nothing crossed a threshold", async () => {
    const same = { queries: [q("steady", 4, 20)], totals: { clicks: 0, impressions: 40, ctr: 0, position: 20 } };
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", gsc: same }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21", gsc: same }),
    }));
    assert.match(stdout, /Nothing crossed the thresholds/);
  });

  test("refuses to give advice even when something moved", async () => {
    /* The report is arithmetic. Deciding what to change about a licensed
       agent's advertising is not a call it is entitled to make. */
    const { stdout } = await run(dirWith({
      "2026-09-14.json": snapshot({ start: "2026-08-18", end: "2026-09-14", gsc: { queries: [] } }),
      "2026-09-21.json": snapshot({ start: "2026-08-25", end: "2026-09-21", gsc: { queries: [q("new one", 12, 15)] } }),
    }));
    assert.match(stdout, /crossed the reporting threshold/);
    assert.match(stdout, /arithmetic, not advice/);
    assert.match(stdout, /fair-housing/);
  });
});
