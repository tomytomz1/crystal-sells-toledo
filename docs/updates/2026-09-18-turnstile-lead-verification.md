# Cloudflare Turnstile — a human/bot verification gate on POST /api/lead

**Date** 18 September 2026
**Scope** `api/lead.js`, a new `api/_lib/turnstile.mjs`, the build, both lead
forms, the privacy page, the shipped browser bundle, and two new environment
variables.

This document assumes no repository access and no memory of any previous
conversation.

---

## 1. What was wrong

Production received seller submissions that were not from people. A real
example reached HubSpot with a two-letter first name, a two-letter surname, a
syntactically valid email, a syntactically valid phone number, a property
address reading `907 Po Box, Swannanoa, NC` — roughly 500 miles outside the
service area — and gibberish in the notes field. It arrived through
`/home-value`.

**Every existing guard passed it, and every one of them was right to.** The
guards that were already in place, confirmed from the code rather than from
memory:

| Guard | Where | What it did with the fake |
|---|---|---|
| method restriction | `api/lead.js` | POST, so it passed |
| origin allow-list | `api/_lib/security.mjs` `originAllowed()` | the site's own page, so it passed |
| per-IP sliding window (5 per 10 min) | `security.mjs` `rateLimit()` | one submission, nowhere near the limit |
| 16 KB body cap + 5 s read bound | `security.mjs` `readBody()` | a few hundred bytes, arriving promptly |
| `_gotcha` honeypot | `validate.mjs` | left empty, as any headless browser leaves it |
| full server-side field schema | `validate.mjs` | every required field present and well formed |
| email and phone-digit validation | `validate.mjs` | both satisfied |
| consent parser | `consent.mjs` `parseConsentFlag()` | both boxes unticked |

**The consent model behaved exactly as designed.** No SMS permission and no
AI-voice permission were created. That part of the system is not at fault and
is unchanged by this work.

What happened anyway, and what this change exists to stop:

1. a HubSpot contact was created or updated;
2. a HubSpot form-submission timeline activity was written;
3. HubSpot notified Crystal;
4. an acknowledgement email was sent to a stranger's address;
5. a consent-evidence row was written for a decision no human made;
6. the lead records were polluted.

### Why another guard of the same kind would not have helped

Every guard in the table above asks **"is this request well formed?"**. A
honeypot, a field-shape rule and a per-IP window are all answering that
question, and the fake request answers it correctly. None of them can ask
**"was there a person at the other end?"** — that is answerable only by
something that observes the browser itself.

That is the gap this change closes, and it is why the remediation is not a
second honeypot or a tighter rate limit.

---

## 2. What changed

### 2.1 A new server-side module — `api/_lib/turnstile.mjs`

Redeems a Turnstile token against Cloudflare's siteverify API and classifies
the answer. It never throws, never returns the token to its caller, and never
puts the token into a log line, an error or a thrown `Error`.

Contract source: Cloudflare's *Validate the token* and *Widget configurations*
documentation, read on 18 September 2026 (the pages were retrieved from the
`cloudflare/cloudflare-docs` sources because `developers.cloudflare.com` is
blocked from this environment's egress). The properties relied on are the
documented ones: a token is at most 2048 characters, is valid for 300 seconds,
is **single-use**, and the response carries `success`, `error-codes`,
`hostname`, `action`, `challenge_ts` and `cdata`.

**Three things are checked, not one.**

1. **`success === true`**, read as the boolean and nothing else. A JSON
   `"true"`, a `1` or a missing field does not open the gate — the same
   narrowest-possible-parser rule `parseConsentFlag()` already applies to a
   consent decision.
2. **`hostname` is in the site's own allow-list.** A sitekey is printed in
   every page, so anyone can render this site's widget on a page of their own,
   solve a real challenge there, and post the resulting token here;
   `success: true` is true of that token. The hostname Cloudflare reports is
   *not* client-supplied — it is Cloudflare's own record of where it served the
   challenge — which is exactly why it is worth checking. It is checked against
   `allowedHosts()`, the same set the origin check uses, so the two cannot
   drift and preview deployments keep working through `VERCEL_URL` /
   `VERCEL_BRANCH_URL` with no second list.
3. **`action` equals the `form_type` being submitted.** Every widget on the
   site sets `action` to its form's type, so a token solved on `/contact`
   cannot be replayed into a `home_value` submission. An absent action is
   treated as a mismatch — see §7 for the cost of that choice.

### 2.2 Failure is attributed to the right party

Cloudflare's error codes are split by **whose fault they name**:

| Codes | Classification | HTTP | What the visitor is told |
|---|---|---|---|
| `invalid-input-response`, `timeout-or-duplicate`, `missing-input-response` | the **token** | 403 `VERIFICATION_FAILED` | we could not verify this came from a person |
| `missing-input-secret`, `invalid-input-secret`, `bad-request`, `internal-error`, **anything unrecognised**, no codes at all, a non-JSON body, a network failure, a timeout | **ours, or unknown** | 503 `VERIFICATION_UNAVAILABLE` | the check is temporarily unavailable, your details are still in the form |

A response mixing the two families is **not** a token fault: it has not
established that the token was bad.

This is the same honesty rule `api/lead.js` already applies when it answers
408 rather than 400 for a body that never finished arriving. A homeowner must
never be told they failed a bot check because this deployment's secret key is
wrong or because Cloudflare was unreachable.

### 2.3 Where the gate sits in `api/lead.js`

```
method -> origin -> rate limit -> bounded body read -> JSON parse
       -> honeypot + full field validation
       -> TURNSTILE VERIFICATION          <-- the new step
       -> submission id
       -> consent evidence
       -> durable consent ledger append
       -> HubSpot contact + form activity
       -> acknowledgement email
```

Everything above the gate is local and costs no network call, so a malformed
or obviously hostile request is still refused without a packet leaving the
function. Everything below it is a side effect that cannot be taken back. **A
refusal returns before the submission id is minted**, which is the
machine-checkable form of "no downstream effect happened" and is asserted as
such in the tests.

### 2.4 The token goes nowhere

- It is read from the raw request body and is **never attached to `payload`**.
  The enquiry block, the consent evidence, the ledger row, the HubSpot write
  and the acknowledgement email are all built from `payload` alone, so none of
  them can carry it.
- `verifyTurnstile()` never returns it, so no caller can store it.
- `turnstileLogShape()` emits the outcome, the classified reason and
  Cloudflare's closed-vocabulary codes — never the token, and not even its
  length.
- `api/_lib/log.mjs` now redacts `turnstile_token` and `cf-turnstile-response`
  as a structural backstop, so a future caller that hands a whole body to
  `safeShape()` cannot print one.
- The widget is rendered with `response-field: false`, so no hidden input
  exists, nothing enters `FormData`, and nothing reaches the mailto recovery
  link the form offers after a failure.
- Nothing about it is sent to analytics.

### 2.5 The browser half

Explicit rendering, driven from `assets/js/main.js`, which is already the only
place that knows which form is which. One implementation covers every present
and future form instead of a build variable per form type.

- `appearance: "interaction-only"` — the widget has **no visual footprint at
  all** until Cloudflare itself decides a human interaction is needed. There is
  no checkbox to find, nothing to read and nothing extra to click. The normal
  homeowner fills the form, presses the existing submit button, and submits.
- `execution` is left at its default, so the challenge runs when the widget
  renders and the token is normally in hand long before anyone submits.
- `refresh-expired` is left at its default of `auto`, so a slowly-filled form
  silently gets a fresh token rather than submitting an expired one.
- A submit waits at most **6 s** for a token that is not ready yet.
- When Cloudflare puts an **interactive** challenge on screen, the submission
  stops, the button is restored, and the status asks the visitor to complete
  the check they can now see and press send again. Holding a disabled button
  until a timer expires tells them nothing.
- **Every failed submission resets the widget.** A Turnstile token is
  single-use; without this, a visitor whose submission failed for any reason —
  a HubSpot outage, a 502 — would be refused by the *verification* gate on
  every retry, and the form would look permanently broken to exactly the person
  whose lead was already at risk.
- The mount point sits immediately before the submit control on both forms, so
  a challenge that does appear is the next thing in the tab order.

### 2.6 Coverage — every form that can create a lead

Both public lead forms are covered, not just `/home-value`:

| Form | `form_type` | Pages |
|---|---|---|
| shared valuation partial | `home_value` | `/`, `/home-value`, `/43551-seller-review` |
| contact form | `contact` | `/contact` |

`buyer_inquiry` is an accepted `form_type` in `validate.mjs` and `check.mjs`
but **no page currently renders such a form**. It needs no separate work: the
gate is keyed off `data-form-type`, so a future buyer form is covered the
moment it exists.

`tools/check.mjs` now **fails the build** when the number of Turnstile mount
points on a page does not equal the number of forms that post to `/api/lead`.
A missing container is not a weaker form — once the secret is set it is a form
whose every submission is refused.

---

## 3. The configuration contract

| Variable | Secret? | Read at | Decides |
|---|---|---|---|
| `TURNSTILE_SITE_KEY` | **No** — public by design, printed into every page, exactly like `GOOGLE_MAPS_API_KEY` | build | whether any page renders a widget |
| `TURNSTILE_SECRET_KEY` | **Yes** — server-side only | runtime | whether anything is **enforced** |

**The secret alone is the enforcement switch.** A whitespace-only value counts
as absent.

**Setting the secret without the site key fails the build, deliberately.** That
combination would enforce verification while rendering no widget, so no
submission would carry a token and **every lead would be refused** — silently,
with every test passing and every page looking right. Failing the build fails
the deployment, so the previously deployed revision keeps serving and no
visitor ever meets that state. The reverse — a site key with no secret — is
safe, is a legitimate staged rollout, and is reported as a build warning
reading `NOT enforcing`.

`tools/check.mjs` fails the build if `TURNSTILE_SECRET_KEY` ever appears in
anything delivered to a browser. The **site** key is deliberately not on that
list.

### Inactivity is not enforcement — CLAUDE.md rule 19

With `TURNSTILE_SECRET_KEY` unset, `api/lead.js` behaves **exactly as it did
before this feature existed**. That is *absence of enforcement*, not a lenient
enforcement mode. No document may describe such a deployment as protected. The
endpoint logs `lead.turnstile.not_configured` on every submission so that a
deployment which believes it is protected and is not shows up in the ordinary
log stream rather than in an incident.

**This change sets no environment variable anywhere.** It ships the mechanism;
it does not switch it on. Whether Vercel currently holds either variable is not
something this repository can observe and is therefore not asserted — the two
places that answer it are the build log line and the
`lead.turnstile.not_configured` line `api/lead.js` emits on every submission.

---

## 4. The privacy disclosure

A new gated section names Cloudflare Turnstile as a processor. It renders only
when `TURNSTILE_SITE_KEY` is set — the same condition under which any page
actually loads Cloudflare's script — so a build that never contacts Cloudflare
never claims it does.

It states what the site does and no more: Cloudflare's script receives normal
connection information including the IP address, it receives nothing the
visitor types, the server-side check sends the token **only** — not the name,
email, phone, address, message or IP — and the token is never stored, never
added to contact records and never included in any email.

It does **not** claim anything about Cloudflare's own cookie or storage
behaviour, because that has not been measured here.

---

## 5. Decisions taken, and the alternatives rejected

**Fail closed when Cloudflare is unreachable.** Rejected the alternative of
accepting unverified submissions during a verification outage. That fail-open
branch is a bypass inherited by anyone able to disrupt the check, and it would
make the gate unfalsifiable. The cost is stated rather than hidden: while
siteverify is unreachable this endpoint stops accepting leads. The visitor
keeps every field they typed and is given the phone number, the email address
and the mailto fallback — the same recovery the existing 502 and 503 paths rely
on. **This is the trade-off the operator should review** (§8).

**No `remoteip`.** Rejected sending the visitor's IP as a risk signal. The only
address available is `clientIp()`'s, which reads `x-forwarded-for` — a header
Vercel sets in production but which is client-supplied anywhere else. Feeding a
forgeable address to a risk engine as though it were observed is worse than
sending nothing, and Cloudflare already observes the real address when it
serves the challenge in the browser. Sending less to a third party is also the
right default here.

**No `idempotency_key`, and no retry.** Cloudflare documents the key for
callers that retry a failed redemption. This module makes exactly one call, so
sending a key would state an intent the code does not act on. A retry would
also double the gate's claim on a 30 s budget already spent on HubSpot, and the
retryable case (`internal-error`) is returned to the visitor as a try-again —
which is a retry by the only party who can mint a fresh token anyway.

**`challenge_ts` is not checked.** Cloudflare enforces the 300-second validity
itself and answers `timeout-or-duplicate` for an expired token. A second
deadline computed against this function's clock would add no security and would
refuse valid tokens whenever the two clocks disagreed.

**Explicit rendering, not the implicit `cf-turnstile` class scan.** Each form's
challenge must be minted for its own action, and `main.js` already knows which
form is which. Rejected the implicit scan because it would have required a
build variable per form type and would not have covered a future form.

**5 s verification timeout.** Derived, not round: a siteverify redemption
normally answers in well under a second, so 5 s never refuses a slow genuine
visitor; and 5 s is a sixth of the 30 s budget and less than one HubSpot
request's ceiling, so a stalled Cloudflare edge can never dominate the
invocation. The abort covers the **response body**, not only the headers — the
same correction `api/_lib/hubspot.mjs` already carries.

---

## 6. Verification actually performed

**Targeted tests, all passing locally.** No live external call was made.

| Suite | Result |
|---|---|
| `tests/turnstile.test.mjs` (new, 77 tests) | 77 pass |
| `tests/api.test.mjs`, `consent-build-gate`, `a2p-legal-pages`, `a2p-sms-legal` + the new suite together | 218 pass |
| `tests/browser.test.mjs` (111 tests, 8 new) | 111 pass, at a real Chromium |
| `npm run build` + `npm run check` | 10 pages, 0 errors, 0 warnings |
| build with consent **and** Turnstile enabled | 14 pages, 0 errors, 0 warnings |
| privacy page with site key only | does **not** claim a submission is refused |
| privacy page with both keys | claims it, and the section renders |

Build-guard behaviour observed directly:

- secret without site key → build exits **1** with the refusal message;
- implausible site key → build refuses to emit it;
- site key without secret → builds, printing `NOT enforcing`;
- neither set → builds, printing `no TURNSTILE_SITE_KEY … no verification is claimed`.

**What the tests are, and are not.** Cloudflare's siteverify is stubbed in the
server tests and `window.turnstile` is stubbed in the browser tests. That is
the right boundary for every claim made, because every claim made is about code
this repository owns: which guards run before the network is touched, how a
given response is classified, what happens downstream of each classification,
what never leaves the process, and what the shipped bundle asks a browser for.

The browser tests run against the **shipped** `public/` bundle at a real
Chromium, supplying only the build-time global `tools/build.mjs` would have
injected.

---

## 6a. What the pre-handoff adversarial review found

The review ran once over the complete diff and found **three material items**,
all fixed before this was presented. Recorded because a review that reports
nothing is only credible if one that finds something says so.

1. **`turnstileLogShape()` echoed two unbounded external strings.**
   `error-codes` went through a closed-vocabulary sanitiser; `hostname` and
   `action` — from the same response, into the same log line — went through
   nothing. They are the values a hostile caller has the most influence over,
   precisely because the reason they are echoed is that they did not match.
   Log *forgery* was never possible (`log()` emits `JSON.stringify()`, which
   escapes a newline), so the defect was the **absence of a bound**: a response
   with a megabyte-long hostname would have put a megabyte into a retained
   Vercel log on every submission. Fixed with `safeEcho()` — control characters
   stripped, 128 characters, an ellipsis so a reader can see it was cut — plus
   three regression tests.

2. **The privacy page would have asserted enforcement where none existed.**
   The processor section rendered whenever `TURNSTILE_SITE_KEY` was set, and it
   ended with *"If the check does not pass, the submission is refused…"*. But
   the build deliberately permits a site key **without** the secret as a staged
   rollout, and in that state nothing is refused. That is CLAUDE.md rule 19 —
   inactivity described as enforcement — on the page a compliance reviewer is
   most likely to open. The disclosure of what loads and what is sent stays
   tied to the site key, where it belongs; the sentence claiming a refusal is
   now injected separately and is empty unless the secret is configured for the
   same build. Both states are verified against the built output.

   Fixing this introduced, and the delta review caught, a second-order bug: the
   first attempt wrote the new variable's own template token inside the
   partial's HTML comment — exactly what `consent-block.html` warns about,
   since `tools/build.mjs` substitutes variables in comments too. The partial
   now carries that warning itself.

3. **Both documents asserted a fact about Vercel that cannot be observed from
   here.** They said neither environment variable is set in any environment.
   Nothing in this repository can read Vercel's configuration, and this project
   has already been hurt by a plausible assumption written down as a fact. Both
   now state what is actually knowable — that this change sets no variable —
   and name the two places that answer the live question: the build log line
   and `lead.turnstile.not_configured`.

**Lesson promotion: nothing promoted.** Finding 1 is an application of an
existing rule (18 — prose may not outrun the evidence; the code's own sanitiser
set the standard its neighbours failed), finding 2 is an application of rule 19,
and finding 3 of rule 18 again. No new invariant is worth obeying forever here,
and manufacturing one would itself be a failure (rule 20).

**Repo-wide pattern search (rule 17)** for finding 1 — the shape, not the
identifier: every place an external response value is written into a log line.
`api/_lib/consent-ledger.mjs` `ledgerLogShape()` and `api/_lib/mail.mjs`
`classifyMailError()` both return **fixed classification strings only** and echo
nothing external; `api/_lib/log.mjs` `logError()` emits `err.message`, which
callers on the sensitive paths already avoid for exactly this reason (the
ledger and mail failures use `log()` with a classification instead). No other
instance of the pattern was found, so nothing was widened into.

---

## 7. Still UNPROVEN

State these as unproven; none of them is established by a passing test.

1. **Nothing has been verified against Cloudflare.** No live siteverify call
   has been made from this repository. That Cloudflare accepts this module's
   request shape, and that a real widget mints a token these assertions would
   recognise, are both untested.
2. **Nothing was switched on by this work, and the live configuration was not
   read.** This change sets no environment variable and creates no Cloudflare
   widget. What Vercel currently holds has not been observed from here, so
   "the gate is inert in Production" is an expectation, not a reading — the
   build log line and `lead.turnstile.not_configured` are what confirm it.
   "Tests pass" does not mean "this works in production" (CLAUDE.md rule 13).
3. **The strict `action` check has a stated cost.** Every widget here sets an
   action, so an absent one is not a token of ours — but if Cloudflare ever
   stopped returning `action`, this check would refuse **every** lead. The
   failure is logged with its own distinguishable reason and value (`absent`
   versus a wrong string) so it is diagnosable in one log line rather than
   being folded into a generic rejection. It has not been observed live.
4. **Widget behaviour inside a hidden step is unmeasured.** The valuation form
   is two-step and its widget mounts inside step 2, which is `hidden` until the
   visitor advances. Whether Cloudflare runs the challenge immediately or waits
   until the element is displayed has not been measured. Both are handled — the
   submit button lives in that same step, so the widget is on screen by the
   time anyone can submit, and the 6 s wait covers a challenge that only starts
   then — but which of the two actually happens is not known.
5. **Accessibility has been checked structurally, not with assistive
   technology.** The mount point's position in the tab order is asserted; no
   screen-reader testing was performed.
6. **Real-world friction is unmeasured.** How often Cloudflare decides a real
   Perrysburg homeowner needs an interactive challenge is a question only
   production traffic can answer.

---

## 8. What a human must still do

In order. Nothing below has been done.

1. **Create the Turnstile widget** in the Cloudflare dashboard. Mode
   **Managed**.
2. **Add the hostnames** under the widget's Hostname Management:
   `crystalsellstoledo.com` and `www.crystalsellstoledo.com`. Add the Vercel
   preview hostnames too if preview deployments are to be testable — the server
   checks the hostname Cloudflare reports against the same allow-list the
   origin check uses.

   **Do not add `localhost` or `127.0.0.1` to a production widget.** Cloudflare
   recommends against it, and it matters here specifically: `allowedHosts()`
   accepts both, so a production sitekey that Cloudflare will mint `localhost`
   tokens for would let someone run this site's widget on a local page of their
   own and produce tokens this server accepts. Cloudflare's Hostname Management
   is the control for that, not the server. Use Cloudflare's published testing
   sitekeys for local development instead.

   **This step has no build guard and no test behind it.** A site key whose
   hostname list omits the live domain builds cleanly, passes every test, and
   then refuses every lead in production. Step 6 is the only thing that catches
   it.
3. **Decide the outage posture (§5).** The gate currently fails **closed**: if
   Cloudflare's siteverify is unreachable, the site stops accepting leads until
   it recovers. This is the specified behaviour and it is what protects the
   gate from being bypassed, but it trades availability for integrity on the
   lead path — the one path this project treats as most costly to lose. This is
   the operator's call to confirm, not the agent's.
4. **Set both variables together**, in the same Vercel environment:
   `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. Setting only the secret
   fails the build by design. Consider Preview first.
5. **Redeploy**, and confirm the build log prints
   `Cloudflare Turnstile enabled - widget renders AND the endpoint enforces`.
6. **Submit one real test lead** from a browser on the live host and confirm
   `lead.turnstile.verified` appears in the Vercel function log and the lead
   reaches HubSpot. **Do not skip this.** It is the only check that catches a
   Cloudflare-side hostname misconfiguration (step 2), which otherwise presents
   as every lead being refused with nothing in the build or the test suite
   showing anything wrong. If `lead.turnstile.refused` with
   `reason: hostname_mismatch` appears instead, the log line names the hostname
   Cloudflare reported — add that hostname in step 2. Until this step passes,
   item 1 of §7 stands.
7. **Then, and only then**, update `docs/CURRENT-STATE.md` to say the gate is
   live — and not before, because an unconfigured gate is not enforcement.

---

## 9. What is explicitly NOT done

- No live Cloudflare call, no Cloudflare account configuration, no dashboard
  widget created.
- No environment variable set in any environment.
- **No change to the consent model, the consent ledger, HubSpot, the
  acknowledgement email, Twilio, Retell or the suppression endpoints.** Gate 7
  and gate 8 are untouched and remain inert.
- No change to the existing honeypot, rate limiter, origin check, body bounds
  or field validation. Every one of them still runs, and still runs *first*.
- No retry, no caching of verification results, no new persistence of any kind.
- No `buyer_inquiry` form was added.
