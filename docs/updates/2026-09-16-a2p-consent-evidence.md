# Machine-verifiable SMS consent evidence for A2P review

**Date:** 2026-09-16
**Status:** source prepared on a branch. **Not merged, not deployed, and the
Twilio Campaign has not been resubmitted.**

This document assumes no repository access and no memory of earlier sessions.

## What was wrong, and why it mattered

Twilio rejected the Crystal Sells Toledo A2P 10DLC Campaign with **error 30882
— "Terms and Conditions issues."** A previous change (`2026-09-16-a2p-30882-
remediation.md`) responded by publishing SMS-only legal pages at `/sms-privacy`
and `/sms-terms`, and the operator repointed the Campaign at them by hand.

The Campaign is still not clearing. Twilio's **"Check for errors"** continues to
return *"This registration needs additional review. Our pre-check was unable to
verify some of the information you provided."* Twilio support ticket
**#29582556** is open and has been transferred to Twilio's 10DLC Onboarding
team.

The finding behind this change is about **the consent disclosure itself, not the
legal pages.**

The real opt-in lives on **step 2** of the two-step `/home-value` form. Steps
toggle with the `hidden` attribute in `assets/js/main.js`. A crawler that does
not execute the script — or executes it but never clicks *next* — reads step 1
and stops. Step 1 contains only the property address.

A browser-based external extraction of production `/home-value` found the page
and **both SMS legal links**, but **did not surface the step-2 SMS disclosure in
its extracted text**. `/sms-privacy` and `/sms-terms` were directly crawlable.

**The limits of that evidence matter.** It is one external tool's behaviour,
reported by the operator. It is **not** a measurement of Twilio's verifier, and
nothing here establishes what Twilio's verifier does or why the pre-check is
unhappy. The hypothesis is plausible and cheap to eliminate; it is not proven,
and this change does not claim it is the cause.

Twilio's current guidance supports supplying publicly accessible evidence where
the consent experience is not directly machine-verifiable. That is what this is.

**This is not an attempt to bypass compliance.** The consent semantics are
unchanged in every respect. The point is to make existing compliant consent
evidence easy for an automated checker and a human reviewer to read.

## What changed

### A new public page: `/sms-consent-evidence`

Source: `src/pages/sms-consent-evidence.html`. It carries the existing
`communications_consent` feature gate, so it is built, indexed and sitemapped
only when the messaging programme is on, and is absent entirely when it is off.

It documents the opt-in in static, script-free text: who the sender is, the main
website, the actual opt-in URL, the program type, the opt-in method, customer
care, and both SMS legal surfaces — as a description list, in ordinary body
text, with no new structured-data types invented for it.

**It is inert, and that is enforced rather than intended.** Within the page's
own `<main>` there is no `<form>`, `<input>`, `<button>`, `<textarea>`,
`<select>`, submit control, consent field name, inline event handler, `<script>`
or reference to `/api/lead`. `tools/check.mjs` fails the build otherwise, and a
browser test asserts the rendered page exposes **zero** operable controls. The
checks read the page's `<main>` specifically, because the shared site chrome
legitimately contains a navigation `<button>` on every page.

**It cannot drift from the real disclosure.** The wording is never retyped. It
is injected from the same build variables the live checkbox label uses, fed by
`api/_lib/consent.mjs` — the module the server records the agreed wording from.
A test opens both the evidence page and step 2 of the real form in a browser and
asserts they display **the same string**, and that the string equals
`SMS_CONSENT.text`. A separate test asserts the page source contains the
template token and does **not** contain the literal disclosure sentence.

**The checkboxes are drawn unchecked**, with the word "unchecked" beside them
for anyone not looking at the picture, because the real boxes ship unchecked.
The static twin reuses the live `.consent` classes for type and spacing and adds
exactly one new modifier, `.consent__box--static`; no existing selector was
edited, so the live control on the four opt-in surfaces cannot be reached by it.

### A generated screenshot: `assets/img/sms-consent-step2.png`

`tools/consent-evidence-shot.mjs` builds nothing by itself; it serves the built
`public/` locally, drives Chromium through the real form, and captures the
`.valueform` panel at step 2 at 2× scale. Every request that is not the local
static server is aborted, so no analytics, font or provider call leaves the
machine.

It was **not** produced in an image editor. Before writing the file the script
asserts that neither checkbox is checked, that neither is required, and that
**every step-2 field is empty**, and throws rather than publish otherwise. Only
step 1's address field is filled — with the literal placeholder
`123 Example St, Toledo, OH`, because the form will not advance past an invalid
required field — and step 1 does not appear in the captured region. **The image
contains no name, email, phone number, property address or any other personal
data.**

### A carve-out on the broad privacy policy

`/privacy` legitimately says that information is shared where necessary to
complete a transaction — a title company, lender or inspector. **That sentence
was kept.** It is ordinary real-estate practice and deleting it to please a
carrier reviewer would make the page false.

A new gated paragraph (`src/partials/privacy-sms-scope.html`) immediately after
it states that this sharing **does not include mobile information, SMS opt-in
data, or SMS consent**, links `/sms-privacy`, and adds that the named service
providers process information on Crystal's behalf — which is not permission for
them, an affiliate or a lead buyer to market to anyone.

**It deliberately does not claim that no system processes SMS information.**
Twilio, HubSpot, Neon and Vercel each do, as processors, and `/sms-privacy`
names all four. A test asserts the processor sentence survives and that the page
carries no "no one ever processes your SMS data" style overclaim.

It is gated for a second, concrete reason: it links `/sms-privacy`, which is
itself gated. Ungated, it left a dead internal link in the consent-disabled
build — caught by the existing link checker, which is why it became a partial.

### A step-1 label

`src/partials/home-value-form.html`: the step-1 microcopy link label changed from
*"Privacy & terms"* to **"Website Privacy Policy"**. **The destination is
unchanged and still `/privacy`** — step 1 collects an address under the website
policy and contains no SMS consent, so pointing it at `/sms-privacy` would claim
a messaging relationship that does not exist at that point in the form. Only the
label is disambiguated, so a crawler that reads step 1 and stops cannot mistake
the broad policy for the campaign's SMS surface.

The footer and other form link labels were **not** renamed; they are navigation
text rather than a page title, and one is pinned by `tests/consent.test.mjs`.

## The CI gap this work found

**The release gate was running in the one state production is not in.**

`npm test` is `node tools/build.mjs && node tools/check.mjs && node --test
tests/*.test.mjs`, and `.github/workflows/test.yml` sets no
`COMMUNICATIONS_CONSENT_ENABLED`. The single `check.mjs` run in CI therefore had
`CONSENT_ON === false`, and **every guard inside `if (CONSENT_ON)` was never
reached**: checkbox defaults, the canonical-disclosure match, the legal-page
contract, the A2P surfaces. Those guards were correct. They simply never
executed on the gate — while Vercel Production runs with the flag **ON**.

Measured directly: `node tools/build.mjs && node tools/check.mjs` with no flag
reports **10 pages checked**; with the flag it reports **14**.

### The remediation

`tests/consent-build-gate.test.mjs` runs inside `npm test`, so it runs in CI. It:

1. builds and checks a throwaway copy of the repository with the flag **off**
   and again with it **on**, and requires both to pass;
2. asserts the consent-disabled build publishes none of
   `communications-terms.html`, `sms-privacy.html`, `sms-terms.html`,
   `sms-consent-evidence.html`, and the consent-enabled build publishes all
   four;
3. proves the enabled-path guards are **not vacuous**. Six mutations are applied
   to throwaway copies — a pre-ticked box, a required box, an evidence page
   whose disclosure stops coming from the canonical source, an evidence page
   that grows a real consent control, a privacy page that loses the SMS
   carve-out, and a step-1 label relabelled back — and each is asserted to
   **pass with the flag OFF and fail with the flag ON**, with the failure
   message matched. That asymmetry re-demonstrates the original gap on every
   run and would catch its reintroduction.

The throwaway tree is a **complete** copy of every tracked and
untracked-but-not-ignored file, because `check.mjs` reads far more than the build
does — `.env.example`, `db/*.sql`, `vercel.json`, the whole `api/` tree — and a
hand-listed subset fails for reasons unrelated to the mutation. An earlier proof
in this repository made exactly that mistake and recorded fourteen identical
`ENOENT` crashes as fourteen passes. **The working tree is never mutated.**

`tests/a2p-consent-evidence.test.mjs` adds the rendered-boundary half: both build
states, and a real browser for what only a browser can establish — that the
disclosure is readable **with JavaScript disabled**, that no operable control
renders, that the static boxes are actually visible at a checkbox's size, that
`/sms-consent-evidence`, `/sms-privacy`, `/sms-terms` and `/home-value` do not
scroll sideways at 360px, and that step 2 and the evidence page show the same
words.

**No production behaviour and no environment variable changed.** This is test
and build-time validation only.

## Resulting contract

- `/sms-consent-evidence` is public, indexable, in the sitemap, requires no
  login, no JavaScript, no query parameter and no form submission, and collects
  nothing.
- The evidence page's disclosure is the canonical disclosure, enforced at build
  time and in a browser.
- `/privacy` keeps its transaction-sharing disclosure and now scopes it away
  from mobile and SMS opt-in data, without overclaiming about processors.
- Step 1's privacy link reads "Website Privacy Policy" and still points at
  `/privacy`.
- `check.mjs`'s consent-enabled branch is exercised by CI and proved
  non-vacuous.

## Consent invariants — none changed

Unchanged: the SMS checkbox wording; the AI voice checkbox wording;
`CST_SMS_CONSENT_2026_09_V1`; `CST_AI_VOICE_CONSENT_2026_09_V1`; unchecked
defaults; optional status; `api/_lib/consent.mjs`; form submission behaviour;
required contact fields; the `/api/lead` contract; CRM behaviour; the consent
ledger; suppression; the Twilio inbound webhook; Gate 8; `/sms-privacy` and
`/sms-terms` content.

## Test results

- `tests/consent-build-gate.test.mjs` — 8/8 pass, including all six
  mutation cases.
- `tests/a2p-consent-evidence.test.mjs` — 25/25 pass, including 6 browser tests.
- `tools/check.mjs` — clean in both flag states (10 pages off, 14 on).
- Full suite: see the pull request for the CI run and its conclusion.

## What is unproven

- **That any of this causes Twilio to approve the Campaign.** It does not. It
  reduces ambiguity; the outcome of Twilio's pre-check and human review is
  unknown.
- **That the step-2 visibility hypothesis is the actual cause of the
  rejection.** One external extraction tool did not surface the disclosure. That
  is suggestive, not diagnostic, and Twilio's verifier was never observed.
- **That the live site carries any of this.** Nothing is deployed. No agent has
  loaded the production site in this work; `crystalsellstoledo.com` is
  unreachable from the environment this was built in.
- **Anything about the Twilio console.** Brand, Campaign, Messaging Service,
  ticket and pre-check states are all the operator's own report.

## What a human must still do

1. Review the pull request independently.
2. Merge after review and green CI.
3. Let Vercel Production deploy.
4. Verify live: `/sms-consent-evidence`, `/home-value` step 2, `/sms-privacy`,
   `/sms-terms`.
5. Re-run Twilio's Campaign "Check for errors".
6. Follow guidance on ticket #29582556.
7. Decide whether and when to resubmit the existing Campaign. **This change does
   not ask for a resubmission and does not schedule one.**

## Explicitly not done

No Twilio object was created, edited, submitted or resubmitted. No environment
variable was added, changed or read. No HubSpot, Neon or Retell write. No SMS
sent, no call placed, no email sent. Gate 8 remains inactive. The branch is not
merged.
