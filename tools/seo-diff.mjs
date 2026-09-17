/* =====================================================================
   What moved between the two most recent search snapshots.
   Run: npm run seo:diff

   Why this exists
   ---------------
   tools/seo-report.mjs accumulates dated snapshots. Nothing read them.
   A file nobody opens is not a monitoring system, so this reports the
   delta between the newest two and says, in one place, whether anything
   moved that a human should look at.

   It makes NO recommendation and changes NOTHING. It reports arithmetic.
   Deciding what to do about a ranking is a judgement with fair-housing,
   equal-prominence and Ohio advertising constraints on it (CLAUDE.md
   rules 2, 3, 5, 6) that no generated diff is entitled to make.

   THE WINDOWS OVERLAP, AND THIS IS THE EASIEST THING TO GET WRONG HERE.
   Each snapshot covers a TRAILING 28 DAYS and they are taken weekly, so
   two consecutive snapshots share 21 of their 28 days. A delta between
   them is therefore NOT week-over-week change: it is the difference
   between two heavily overlapping windows, which damps real movement by
   roughly a factor of four and lags it by up to three weeks. Every
   report this prints says so, because a reader who forgets it will read
   a quarter of a change as the whole change.

   THE SNAPSHOT SHAPE CHANGED ONCE. docs/seo/2026-09-14.json carries
   `landingPages` in the raw Google shape - one page split across rows by
   query string, each with a `users` count. Every snapshot after it is
   folded by path and carries no per-page `users`. Both shapes are read
   here; see docs/seo/README.md.
   ===================================================================== */
import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.SEO_OUT_DIR || join(ROOT, "docs", "seo");

/* --- what counts as worth a human's attention ------------------------
   Deliberately explicit rather than tuned. At this site's volume almost
   everything is noise, so the bar is set where a change could not be a
   rounding artefact. Raise these as traffic grows; do not lower them to
   make the report look busier. */
const MATERIAL = {
  NEW_QUERY_IMPRESSIONS: 3,   /* a query that did not exist before */
  POSITION_MOVE: 5,           /* average position, either direction */
  PAGE_IMPRESSION_MOVE: 10,
  TOP_20_ENTRY: 20,           /* a page or query crossing into page 2 */
};

const snapshots = readdirSync(DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

if (snapshots.length < 2) {
  console.log(
    `Only ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} in ${DIR.replace(ROOT + "/", "")}.\n` +
      `A diff needs two. Nothing to compare yet — this becomes useful after the next weekly run.`,
  );
  emit(false);
  process.exit(0);
}

/* A corrupt snapshot should stop the run, but with a sentence naming the
   file rather than a bare SyntaxError from three frames down. */
const load = (f) => {
  try {
    return JSON.parse(readFileSync(join(DIR, f), "utf8"));
  } catch (e) {
    console.error(`✗ ${f} could not be read as a snapshot (${e.name}). It is committed data — inspect it rather than regenerating over it.`);
    process.exit(1);
  }
};
const prevFile = snapshots[snapshots.length - 2];
const currFile = snapshots[snapshots.length - 1];
const prev = load(prevFile);
const curr = load(currFile);

const material = [];
const note = (line) => material.push(line);

const out = [];
const say = (s = "") => out.push(s);

const num = (n) => (n == null ? "—" : String(n));
const signed = (n, digits = 0) =>
  n == null || Number.isNaN(n) ? "—" : (n > 0 ? "+" : "") + n.toFixed(digits);
/* Position is a rank: LOWER is better, so the arrow is inverted. */
const rank = (d) => (d == null || Number.isNaN(d) ? "—" : `${signed(d, 1)}${d < 0 ? " ▲" : d > 0 ? " ▼" : ""}`);

say(`# Search performance — what moved`);
say();
say(`| | window | days |`);
say(`|---|---|---|`);
say(`| previous | ${prev.range.start} → ${prev.range.end} | ${prev.range.days} |`);
say(`| current  | ${curr.range.start} → ${curr.range.end} | ${curr.range.days} |`);
say();

/* The warning is not optional and is not a footnote. */
const overlapDays = Math.max(
  0,
  Math.round((Date.parse(prev.range.end) - Date.parse(curr.range.start)) / 864e5) + 1,
);
/* The warning must match the windows in hand. Stating "these overlap" over
   a pair that does NOT overlap is worse than saying nothing: it tells the
   reader to discount a delta that is in fact a clean comparison. That
   happens whenever a weekly run is missed, or the tool is run by hand over
   an older pair. */
if (overlapDays > 0) {
  say(
    `> **These windows overlap by ${overlapDays} of ${curr.range.days} days.** Every number below is the ` +
      `difference between two overlapping trailing windows, **not** week-over-week change. A real shift ` +
      `shows up here damped and late. Do not read a delta as "what happened last week".`,
  );
} else {
  const gap = Math.round((Date.parse(curr.range.start) - Date.parse(prev.range.end)) / 864e5) - 1;
  say(
    `> **These windows do not overlap**${gap > 0 ? `, and there is a ${gap}-day gap between them` : ""}. ` +
      `The deltas below are a clean comparison of two separate periods — but ${gap > 0
        ? `whatever happened during the gap is in neither, so this is not a continuous history.`
        : `they are adjacent periods, not a trailing trend.`}`,
  );
}
say();

/* --- Search Console --------------------------------------------------- */
if (!curr.searchConsole || !prev.searchConsole) {
  say(`## Search Console`);
  say();
  say(
    `Not comparable — previous: \`${prev.sources?.searchConsole ?? "absent"}\`, ` +
      `current: \`${curr.sources?.searchConsole ?? "absent"}\`.`,
  );
  say();
} else {
  const a = prev.searchConsole;
  const b = curr.searchConsole;

  say(`## Search Console`);
  say();
  say(`| metric | previous | current | delta |`);
  say(`|---|---|---|---|`);
  say(`| clicks | ${num(a.totals.clicks)} | ${num(b.totals.clicks)} | ${signed(b.totals.clicks - a.totals.clicks)} |`);
  say(`| impressions | ${num(a.totals.impressions)} | ${num(b.totals.impressions)} | ${signed(b.totals.impressions - a.totals.impressions)} |`);
  say(`| avg position | ${a.totals.position?.toFixed(1) ?? "—"} | ${b.totals.position?.toFixed(1) ?? "—"} | ${rank(b.totals.position - a.totals.position)} |`);
  say(`| anonymised impressions | ${num(a.anonymisedImpressions)} | ${num(b.anonymisedImpressions)} | ${signed(b.anonymisedImpressions - a.anonymisedImpressions)} |`);
  say();

  if (b.totals.clicks !== a.totals.clicks)
    note(`clicks ${signed(b.totals.clicks - a.totals.clicks)} (${a.totals.clicks} → ${b.totals.clicks})`);

  /* Queries, keyed by text. */
  const byQuery = (s) => new Map((s.queries || []).map((q) => [q.query, q]));
  const A = byQuery(a);
  const B = byQuery(b);

  const appeared = [...B.keys()].filter((q) => !A.has(q));
  const vanished = [...A.keys()].filter((q) => !B.has(q));
  const shared = [...B.keys()].filter((q) => A.has(q));

  if (appeared.length) {
    say(`### Queries that appeared`);
    say();
    say(`| query | impressions | position |`);
    say(`|---|---|---|`);
    for (const q of appeared.sort((x, y) => B.get(y).impressions - B.get(x).impressions)) {
      const r = B.get(q);
      say(`| \`${q}\` | ${r.impressions} | ${r.position.toFixed(1)} |`);
      /* Volume and rank are two reasons a new query matters, but they are
         one query. Noting each separately inflates the item count, which
         is the number a reader skims. */
      const reasons = [];
      if (r.impressions >= MATERIAL.NEW_QUERY_IMPRESSIONS) reasons.push(`${r.impressions} impressions`);
      if (r.position <= MATERIAL.TOP_20_ENTRY) reasons.push(`straight into the top ${MATERIAL.TOP_20_ENTRY}`);
      if (reasons.length)
        note(`new query \`${q}\` — ${reasons.join(", ")}, position ${r.position.toFixed(1)}`);
    }
    say();
  }

  if (vanished.length) {
    say(`### Queries that stopped showing`);
    say();
    /* Not necessarily a loss: Search Console withholds low-volume queries,
       so a query can vanish from the table while the demand continues. */
    say(`Google withholds low-volume queries, so these may still be running — they are simply below the disclosure threshold now.`);
    say();
    for (const q of vanished) say(`- \`${q}\` (was ${A.get(q).impressions} impressions, position ${A.get(q).position.toFixed(1)})`);
    say();
  }

  const moved = shared
    .map((q) => ({ q, d: B.get(q).position - A.get(q).position, from: A.get(q).position, to: B.get(q).position }))
    .filter((m) => Math.abs(m.d) >= 0.1)
    .sort((x, y) => x.d - y.d);

  if (moved.length) {
    say(`### Position changes on queries present in both`);
    say();
    say(`| query | was | now | move |`);
    say(`|---|---|---|---|`);
    for (const m of moved) {
      say(`| \`${m.q}\` | ${m.from.toFixed(1)} | ${m.to.toFixed(1)} | ${rank(m.d)} |`);
      if (Math.abs(m.d) >= MATERIAL.POSITION_MOVE)
        note(`\`${m.q}\` moved ${m.d < 0 ? "up" : "down"} ${Math.abs(m.d).toFixed(1)} (${m.from.toFixed(1)} → ${m.to.toFixed(1)})`);
      if (m.to <= MATERIAL.TOP_20_ENTRY && m.from > MATERIAL.TOP_20_ENTRY)
        note(`\`${m.q}\` entered the top ${MATERIAL.TOP_20_ENTRY} (${m.from.toFixed(1)} → ${m.to.toFixed(1)})`);
    }
    say();
  }

  /* Pages. */
  const pageMap = (s) => new Map((s.pages || []).map((p) => [p.page, p]));
  const PA = pageMap(a);
  const PB = pageMap(b);
  const pageRows = [...new Set([...PA.keys(), ...PB.keys()])]
    .map((p) => ({
      p,
      was: PA.get(p)?.impressions ?? 0,
      now: PB.get(p)?.impressions ?? 0,
    }))
    .filter((r) => r.was !== r.now)
    .sort((x, y) => (y.now - y.was) - (x.now - x.was));

  if (pageRows.length) {
    say(`### Page impressions`);
    say();
    say(`| page | was | now | delta |`);
    say(`|---|---|---|---|`);
    for (const r of pageRows) {
      say(`| ${r.p} | ${r.was} | ${r.now} | ${signed(r.now - r.was)} |`);
      if (Math.abs(r.now - r.was) >= MATERIAL.PAGE_IMPRESSION_MOVE)
        note(`${r.p} impressions ${signed(r.now - r.was)} (${r.was} → ${r.now})`);
    }
    say();
  }
}

/* --- GA4 --------------------------------------------------------------- */
if (!curr.analytics || !prev.analytics) {
  say(`## GA4`);
  say();
  say(
    `Not comparable — previous: \`${prev.sources?.analytics ?? "absent"}\`, ` +
      `current: \`${curr.sources?.analytics ?? "absent"}\`.`,
  );
  say();
} else {
  const a = prev.analytics.totals;
  const b = curr.analytics.totals;
  say(`## GA4`);
  say();
  say(`| metric | previous | current | delta |`);
  say(`|---|---|---|---|`);
  for (const k of ["sessions", "users", "keyEvents"])
    say(`| ${k} | ${num(a[k])} | ${num(b[k])} | ${signed(b[k] - a[k])} |`);
  say();

  if (b.keyEvents !== a.keyEvents)
    note(`GA4 key events ${signed(b.keyEvents - a.keyEvents)} (${a.keyEvents} → ${b.keyEvents}) — still unverified what this counts`);

  const chan = (s) => new Map((s.channels || []).map((c) => [c.channel, c.sessions]));
  const CA = chan(prev.analytics);
  const CB = chan(curr.analytics);
  const chanRows = [...new Set([...CA.keys(), ...CB.keys()])]
    .map((c) => ({ c, was: CA.get(c) ?? 0, now: CB.get(c) ?? 0 }))
    .filter((r) => r.was !== r.now);

  if (chanRows.length) {
    say(`### Sessions by channel`);
    say();
    say(`| channel | was | now | delta |`);
    say(`|---|---|---|---|`);
    for (const r of chanRows.sort((x, y) => (y.now - y.was) - (x.now - x.was)))
      say(`| ${r.c} | ${r.was} | ${r.now} | ${signed(r.now - r.was)} |`);
    say();
  }

  /* landingPages changed shape once - raw rows with `users` before
     2026-09-15, folded by path without `users` after. Only the fields
     both shapes carry are compared, so the seam is not reported as a
     change in the data. */
  const landingComparable =
    !(prev.analytics.landingPages || []).some((p) => "users" in p) ===
    !(curr.analytics.landingPages || []).some((p) => "users" in p);
  if (!landingComparable) {
    say(
      `> Landing pages are not compared across this pair: the snapshot shape changed between them ` +
        `(raw rows before, folded by path after). See \`docs/seo/README.md\`.`,
    );
    say();
  }
}

/* --- verdict ----------------------------------------------------------- */
say(`## Anything worth a look?`);
say();
if (material.length) {
  say(`**Yes — ${material.length} item${material.length === 1 ? "" : "s"} crossed the reporting threshold.**`);
  say();
  for (const m of material) say(`- ${m}`);
  say();
  say(
    `This is arithmetic, not advice. Whether any of it should change the site is a judgement with ` +
      `fair-housing, equal-prominence and Ohio advertising constraints on it, and this report does not make it.`,
  );
} else {
  say(`No. Nothing crossed the thresholds in \`tools/seo-diff.mjs\`.`);
}
say();

const report = out.join("\n");
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

emit(material.length > 0);

function emit(isMaterial) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `material=${isMaterial}\n`);
}
