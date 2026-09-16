# Gate 8 — send-time permission enforcement

**16 September 2026. IMPLEMENTATION IN REVIEW. No outbound automation is activated by this change.**

This slice puts the compliance decision immediately in front of every future automated SMS or AI-voice sender. It does not send a message, place a call, configure Twilio/Retell, or add a production environment variable.

## The contract

A send is allowed only when all of these are true at the moment of the attempted communication:

1. communications consent is enabled;
2. current consent state was successfully read from HubSpot;
3. HubSpot's conservative suppression projection does not independently block the channel;
4. the channel's current permission is `granted` for the actual target number;
5. **after those checks**, the durable phone-keyed suppression lookup succeeds;
6. the durable ledger reports no active block for the requested channel and no `all` block.

Any dependency failure refuses the send. `api/_lib/permission.mjs` remains the only policy engine that returns the final `{ allowed, reason }` decision.

### Why the durable lookup is last

The first implementation draft did the durable suppression read before HubSpot. That was a material time-of-check/time-of-use defect: HubSpot may take seconds to answer, and a consumer can send STOP during that interval. A suppression check that was true at the beginning of the authorization is stale by the time the sender acts.

The corrected sequence reads mutable consent first and the authoritative phone-keyed suppression state **last**, immediately before the future sender's external side effect. An already-denied consent state returns early because it can never authorize anything. A potential `ALLOWED` result must always cross the final durable lookup. The future sender must not cache an earlier permission result.

This does not claim an impossible zero-race system — a STOP can arrive after any finite check. It narrows the application-controlled window by placing the most safety-critical read at the final provider boundary before send.

## Two credentials stay separate

Gate 8 introduces the **name** `CONSENT_LEDGER_SENDER_URL` for the future server-side sender-role connection string. It is not `CONSENT_LEDGER_URL`.

- `CONSENT_LEDGER_URL` — website/application role: append evidence; no read.
- `CONSENT_LEDGER_SENDER_URL` — sender role: execute `get_suppression_state(text)` for one number; no table `SELECT`, no insert.

The `consent_ledger_sender` **role** exists in production Neon — that is on the repository record from the migration-002/003 provisioning work, not something this change re-verified. What is **not** established is any of: the connection string being present in a Vercel environment, the role being reachable from Vercel, or Neon's live HTTP response shape under that credential. **This implementation adds no environment variable.** Until an operator explicitly adds the string, any otherwise-sendable communication fails closed with `SUPPRESSION_LOOKUP_UNAVAILABLE`.

## Durable suppression lookup

`api/_lib/send-permission.mjs` calls only:

```sql
SELECT channel, suppressed_at
FROM public.get_suppression_state($1)
```

with the target normalized to E.164. It never names the ledger table and cannot enumerate the ledger through the sender role's database privileges.

Returned rows are treated as untrusted provider data. Only `sms`, `ai_voice`, and `all` are accepted, and `suppressed_at` must be a valid instant. A malformed row, timeout, missing credential, or driver failure is not "no suppression" — it is a refusal.

## CRM current state

Gate 8 first reads the contact through the existing HubSpot email search and uses its already-established consent-state parser. A missing contact means `NO_CONSENT`; a failed or malformed CRM read means `CONSENT_STATE_UNAVAILABLE`.

If that current state already denies the requested channel, Gate 8 returns the denial without spending the durable lookup. Only a state that could otherwise allow proceeds to the final phone-keyed suppression read.

The durable ledger is authoritative for suppression by phone. HubSpot suppression flags remain a conservative projection: either source may block, and neither source can create a grant.

## What is deliberately not in this slice

- no Twilio send function;
- no Retell call function;
- no SMS conversation engine;
- no calendar booking;
- no cold-list workflow;
- no environment-variable change;
- no live provider call;
- no unsuppression endpoint or HubSpot unsuppression projection;
- no claim that A2P is approved — the Campaign submitted 16 September 2026 was **REJECTED with error 30882 (Terms & Conditions)** and, on operator evidence, **has not been resubmitted**; Twilio support ticket #29582556 is open with the 10DLC Onboarding team.

The next sender must call Gate 8 immediately before its external side effect. It must not cache an earlier allow decision.

## Evidence and remaining boundary

The implementation tests inject both provider boundaries and exercise the real permission resolver. They prove fail-closed composition, lane separation, phone binding, E.164 lookup input, provider ordering on an allow path, and PII-free error shaping. They do **not** prove Neon HTTP's production response shape or a live HubSpot read in the sender path.

A separate CI test scans the generated browser-delivered output for `CONSENT_LEDGER_SENDER_URL`, so the new sender-role variable name cannot silently leak into built HTML, JS, CSS or metadata.

Before outbound automation is activated, an operator must add the sender-role connection string to the appropriate production environment and a controlled real-boundary verification must confirm `get_suppression_state(text)` is reachable under that credential. A2P approval remains a separate prerequisite for production SMS traffic.

---

## Re-review on current main — 16 September 2026

Gate 8 was branched from `5429815`, before PRs #42, #43 and #44. Current `main`
(`9736ce2`) was merged into the branch and the boundary re-reviewed cold against
the architecture it will actually land in. No conflict arose: the files Gate 8
touches were not modified by that later work.

**Two material defects were found in the Gate 8 code itself and fixed.**

### 1. The target was not actually required

`api/_lib/permission.mjs` resolves `target || ch.consent_phone`. That is correct
for the consent **model** — it answers "may this contact be reached on the line
they consented to". It is wrong for Gate 8, whose entire question is "may this
channel reach **this** number right now".

Measured before the fix:

```
authorizeSms({ email }) with phone undefined / null / ""
  -> {"allowed":false,"reason":"SUPPRESSION_LOOKUP_UNAVAILABLE"}
```

It refused, but for the wrong reason and by accident. The CRM pre-decision
returned `ALLOWED` via the fallback, and the request was stopped only because
`toE164(undefined)` happened to throw inside the suppression lookup. An operator
reading that reason would have gone to debug a database that was working. A
refactor that normalised the phone earlier, or made the lookup tolerant of a
missing argument, would have turned it into a genuine `ALLOWED`.

Gate 8 now validates the target with the project's canonical `toE164` rules
**before any provider is contacted**, and refuses with `INVALID_PHONE`. Verified:
an absent, blank, non-numeric or short target now performs **zero** CRM reads and
**zero** durable lookups.

### 2. An unknown channel was dispatched as voice

`decisionFor` is a two-way ternary, so anything that was not `"sms"` fell through
to `canPlaceAutomatedVoiceCall`. A future `whatsapp` or `rcs` lane would have been
authorized by the **AI-voice** consent record. There is now an explicit allow-list
and a `REASON.UNSUPPORTED_CHANNEL`.

### 3. The bypass is now enforced, not merely documented

The original PR named this as its own highest residual risk: a future sender can
import `canSendSms()` directly, get an `ALLOWED` decided on CRM state alone, and
never consult the phone-keyed ledger — texting people who sent STOP while every
test in the suite still passes. Convention cannot carry that.

`tools/check.mjs` now fails the build if any module under `api/` other than
`api/_lib/send-permission.mjs` names `canSendSms` or `canPlaceAutomatedVoiceCall`
(comments stripped, so a doc comment is not a call). It also fails if Gate 8 stops
calling `public.get_suppression_state($1)`, names the ledger table, or reuses
`CONSENT_LEDGER_URL` instead of the sender credential.

All four guards were proved non-vacuous by mutation in a throwaway tree, and those
mutations are kept permanently in `tests/consent-build-gate.test.mjs`, asserted to
fail with the feature flag **both** off and on.

### Test and CI accuracy

- `tests/send-permission.test.mjs` — 32 cases, covering both lanes independently,
  per-lane and global suppression, CRM-only and ledger-only blocks, a historical
  grant losing to a later STOP, clearing a suppression **not** creating consent,
  timeout, malformed CRM shape, phone mismatch, unusable target, provider
  ordering, and a PII-free decision object.
- `tests/send-permission-secret.test.mjs` — widened from the sender variable alone
  to every server-only credential name, with a non-vacuity assertion that the
  build output actually being scanned is non-empty.
- The consent-enabled CI gate added in #44 is preserved and extended; nothing here
  reintroduces the flag-off-only blind spot.

### Still unproven, and stated as unproven

- `CONSENT_LEDGER_SENDER_URL` is configured in **no** environment.
- Live Neon sender-role connectivity from Vercel has **never been tested**.
- Neon's live HTTP response shape under that credential is unobserved; the tests
  inject the executor.
- No live HubSpot read happens in the sender path in any test.
- No agent has loaded the production site or the Twilio console in this work.

**A2P approval is not a prerequisite for merging this.** Gate 8 causes no
messaging: it is a read-and-decide boundary that can only ever refuse more than
the system already refuses. Campaign review is an external, separate track, and
activation is a separate future gate requiring the operator to add the credential
and a controlled real-boundary verification to pass.
