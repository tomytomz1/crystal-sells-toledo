# Address suggestions ranked Detroit above Perrysburg — 1 September 2026

Bug fix on the live site. Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**This one was caught by looking at the running site, not by the tests.** The
tests passed throughout. Section 4 is why.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. The homepage hero opens with a
home-valuation funnel whose first field is the property address. Earlier today
that field gained Google Places suggestions, and a Google Maps API key was set in
Vercel, making it live for the first time.

---

## 2. What was wrong

Typing `1240` on the live site returned, in order:

```
1240 Woodward Avenue, Detroit, MI      <- ~95 km away
1240 East 9th Street, Cleveland, OH    <- ~180 km away
12400 Williams Road, Perrysburg, OH    <- the target market, third
12400 W Axline St, Fostoria, OH
12400 Jerry City Road, Cygnet, OH
```

The code asks Google to bias results toward a 50 km circle around Perrysburg.
Detroit and Cleveland are both **outside** that circle, so their presence at the
top was proof the bias was not being applied at all — these are prominence-ranked
national results. Woodward Avenue is a famous address; Perrysburg is not.

For a seller in 43551, the first two suggestions were useless and the site looked
like it did not know where it operated.

---

## 3. Root cause — two mistakes, one visible

### 3.1 `subpremise` is not a supported autocomplete type

The request asked for:

```js
includedPrimaryTypes: ["street_address", "premise", "subpremise"]
```

Google's documentation is explicit that **Places Autocomplete does not support
`subpremise`**, and an unrecognised type causes the request to be rejected —
not ignored. So *every keystroke's* primary request was failing.

### 3.2 The retry threw away the bias along with the types

This is the mistake that actually caused the symptom. The fallback was written as
one all-or-nothing switch:

```js
function request(value, narrowed) {
  var req = { input: value, sessionToken: token, ... };
  if (narrowed) {
    req.locationBias = ADDRESS_BIAS;
    req.includedPrimaryTypes = [...];   // <- rejected
  }
  return Suggestion.fetchAutocompleteSuggestions(req);
}

request(value, true).catch(function () { return request(value, false); })
```

`locationBias` and `includedPrimaryTypes` fail independently, but they were
bundled into a single `narrowed` flag. A bad **type** value therefore cost the
**bias** too, on every single request.

The retry was deliberate — it exists so a parameter Google rejects cannot kill
autocomplete outright. That instinct was right. Bundling two unrelated parameters
behind one flag was not: it converted a small precision loss into the feature
silently doing the wrong thing.

---

## 4. Why no test caught this

Worth stating plainly, because the tests were green the whole time and the site
was still wrong.

The stubbed Google recorded `input` and `sessionToken` and nothing else. Nothing
asserted what `locationBias` or `includedPrimaryTypes` were actually set to, and
the stub never *rejected* anything the way the real API does — so the retry path
existed and was never exercised.

The tests verified the parts I had thought about. Ranking quality is not
expressible against a stub that returns a fixed list, so the failure lived
exactly in the gap between "the code does what I wrote" and "the result is
useful". Only the live site showed it.

---

## 5. What changed

```
EDIT  assets/js/main.js        bias decoupled from types; subpremise dropped; console warning
EDIT  tools/check.mjs          ADDRESS_TYPES declaration guard
EDIT  tests/browser.test.mjs   +3 tests; stub records bias/types and can reject
```

### 5.1 Parameters degrade one at a time

```js
request(value, { bias: true,  types: true  })    // preferred
  .catch(...)  request(value, { bias: true,  types: false })   // lose precision
  .catch(...)  request(value, { bias: false, types: false })   // last resort
```

Most useful last to go. Losing the type filter costs a little precision; losing
the bias makes the feature actively misleading, so it is now only given up to
save the feature entirely.

### 5.2 `subpremise` removed

```js
var ADDRESS_TYPES = ["street_address", "premise"];
```

Homes resolve as `street_address` or `premise`. A comment records why the third
value is absent, so nobody helpfully adds it back.

### 5.3 The fallback is no longer silent

A silent degrade is right for the visitor and wrong for whoever has to debug it.
The fallback now emits a one-off `console.warn` naming the rejected parameter.
Nothing is shown to the visitor.

---

## 6. Test results

```
npm test  →  build + check + 158 tests, 158 passing, 0 failing
```

Up from 155. Three new tests, each of which fails against the old code:

- **every lookup is biased to the Toledo area** — asserts `locationBias` is
  present on *every* request, with the expected centre
- **the bias survives a rejected type filter** — the stub now rejects any request
  carrying `includedPrimaryTypes`, exactly as Places did, and the test asserts
  the retry still carries the bias. This is the regression test for this bug.
- **only address types Places actually supports are requested** — no
  `subpremise`, at most five values

The stub now records `locationBias` and `includedPrimaryTypes` and can reject
requests, which is what made these tests possible at all.

### Negative testing — 4 of 4 caught, zero no-ops

```
the original bug restored (subpremise + coupled retry)    CAUGHT
bias re-coupled to the type filter (dropped on retry)     CAUGHT
bias omitted from the first request                       CAUGHT
more than five primary types requested                    CAUGHT
```

Plus the static guard, re-verified after it was itself corrected:

```
ADDRESS_TYPES containing subpremise    CAUGHT
ADDRESS_TYPES with six values          CAUGHT
ADDRESS_TYPES empty                    CAUGHT
```

**The first version of that static guard was wrong.** It grepped the whole file
for `subpremise`, so the comment explaining why the value is absent tripped the
check enforcing its absence — the build failed on correct code. It now parses the
`ADDRESS_TYPES` declaration and inspects the values, not the prose.

---

## 7. What is still unproven

- **The fix has not been seen working on the live site.** It is committed and
  merged; it needs a Vercel deploy and then the same `1240` test. Expected
  result: Perrysburg, Fostoria and Cygnet rank above Detroit and Cleveland.
- **Ranking quality is not testable here.** The stub returns a fixed list. Only
  a live key against real input shows whether suggestions are actually useful.
  This bug is the proof of that limitation, not an exception to it.
- Bias remains a **bias**, not a restriction. Out-of-area addresses will still
  appear, deliberately — Crystal works the wider Toledo metro and the site must
  not look like it refuses other areas.

---

## 8. What a human must do

1. **Redeploy** (the push to `main` should trigger it automatically).
2. Retype `1240` in the hero address field and confirm the Perrysburg result now
   ranks above Detroit and Cleveland.
3. If it still looks wrong, open the browser console and look for
   `[crystal] address type filter rejected by Places` or
   `[crystal] address location bias rejected by Places`. Those messages did not
   exist before this fix and will name which parameter Google is refusing.
