/* Deterministic lead-quality guards that run before Turnstile, consent logging,
   HubSpot, or email. These are intentionally narrow: reject facts we can prove
   from the submitted value, not subjective guesses about whether a person or
   property "looks real". */

const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

const STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
]);

/* Ohio ZIP codes occupy 430xx-459xx. A ZIP at the end of a normalized US
   address is strong evidence even when the visitor omitted a state token. */
function zipOutsideOhio(value) {
  const m = String(value || "").match(
    /\b(\d{5})(?:-\d{4})?(?:\s*,?\s*(?:USA|United States))?\s*$/i
  );
  if (!m) return false;
  const prefix = Number(m[1].slice(0, 3));
  return prefix < 430 || prefix > 459;
}

function explicitState(value) {
  let s = String(value || "").trim();
  if (!s) return null;

  /* Remove only trailing country and ZIP syntax so the final comma-delimited
     component can be evaluated without mistaking a street suffix for a state. */
  s = s.replace(/\s*,?\s*(?:USA|United States)\s*$/i, "").trim();
  const hadZip = /\s+\d{5}(?:-\d{4})?\s*$/.test(s);
  s = s.replace(/\s+\d{5}(?:-\d{4})?\s*$/, "").trim();

  const parts = s.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts.at(-1) || "";
  if (!last) return null;

  /* Two-letter postal abbreviations are unambiguous enough to act on by
     themselves. Full state names are different: values such as
     "123 Main St, Delaware" or "123 Main St, Oregon" can be a street plus
     locality with no state supplied. In that two-component/no-ZIP shape the
     service-area evidence is ambiguous, so fail open and let the other controls
     continue. A ZIP or a separate city component makes a trailing state name
     affirmative evidence. */
  const upper = last.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;

  const lower = last.toLowerCase();
  if (!STATE_NAMES.has(lower)) return null;
  if (lower === "ohio") return "OH";
  if (hadZip || parts.length >= 3) return "OTHER";
  return null;
}

/**
 * True only when the address itself contains affirmative evidence that the
 * property is outside Ohio. An address with no recognizable state/ZIP is not
 * rejected here; losing a real Ohio homeowner because they typed "123 Main St,
 * Toledo" is worse than allowing an ambiguous address to continue through the
 * other controls.
 */
export function addressOutsideOhio(value) {
  if (zipOutsideOhio(value)) return true;
  const state = explicitState(value);
  return state !== null && state !== "OH";
}

/* Keyboard-adjacent runs observed in automated junk submissions. Five-letter
   runs make this much narrower than a general "gibberish" classifier and keep
   ordinary unusual names valid. Nonletters are ignored so "a-s-d-f-g" cannot
   evade the same deterministic rule.

   Repeated-key junk is deliberately narrower still: the entire compact value
   must be one repeated letter, and it must look like a short keyboard mash.
   The previous unbounded substring rule treated legitimate elongated words
   and synthetic max-length contract fixtures as spam, which made the guard
   broader than the evidence justified. */
const KEYBOARD_RUNS = [
  "qwert", "werty", "ertyu", "rtyui", "tyuio", "yuiop",
  "asdfg", "sdfgh", "dfghj", "fghjk", "ghjkl",
  "zxcvb", "xcvbn", "cvbnm",
];
const MAX_SINGLE_KEY_SMASH = 24;

export function looksLikeKeyboardSmash(value) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!compact) return false;
  if (KEYBOARD_RUNS.some((run) => compact.includes(run))) return true;
  return compact.length <= MAX_SINGLE_KEY_SMASH && /^([a-z])\1{5,}$/.test(compact);
}
