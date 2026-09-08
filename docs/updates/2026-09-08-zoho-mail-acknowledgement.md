# Zoho Mail lead acknowledgement

**Date:** 2026-09-08
**Base production `main`:** `593398fe2f0cf8f1942e8cf5e861da266c89ce6a`
**Status:** implemented and tested against a stubbed transport. **Not merged, not
deployed, and no email has ever actually been sent by this code.**

This document assumes no repo access and no memory of previous conversations.

---

## 1. What this adds

After a website lead has been stored in HubSpot, one short personal email now
goes to the visitor from Crystal's real mailbox:

> Hi Sam,
>
> I got your request through Crystal Sells Toledo. I'm going to look it over
> personally and I'll get back to you.
>
> If there's anything else I should know, just reply to this email.
>
> Crystal

Followed by Crystal's standard signature. Subject: **"I got your request."**
From and Reply-To: **Crystal Saylor \<crystal@crystalsellstoledo.com\>**.

The point is the gap between submitting a form and hearing from a human. Before
this, the visitor saw an on-page confirmation and then silence until Crystal got
to them. Now something lands in their inbox within seconds, from a real address
they can reply to.

## 2. What it must never do

**HubSpot remains the only authoritative lead store.** The acknowledgement is
strictly secondary and the whole design follows from one rule: a mail failure
must never turn a lead that IS in the CRM into a submission the visitor is told
to retry. A retry would create a duplicate enquiry against a contact that
already has it.

So:

| Situation | HubSpot | Email | Response to browser |
|---|---|---|---|
| Validation rejects the lead | not attempted | **not attempted** | existing 422 |
| CRM unconfigured | refused | **not attempted** | existing 503 |
| HubSpot fails | failed | **not attempted** | existing 502 |
| HubSpot OK, SMTP unconfigured | stored | skipped | **200 `{ok:true, submission_id}`** |
| HubSpot OK, SMTP fails | stored | failed, logged | **200 `{ok:true, submission_id}`** |
| HubSpot OK, SMTP OK | stored | sent | **200 `{ok:true, submission_id}`** |

The public response contract is **unchanged** and carries no email status.
Whether Crystal's mail server answered is not the browser's business, and the
GA4 `generate_lead` event — which fires on a confirmed 200 — is unaffected.

## 3. Where it sits in the sequence

```
validate  ->  HubSpot contact create/update
          ->  HubSpot form submission (the timeline activity)
          ->  BOTH confirmed  (createLead throws otherwise)
          ->  await Zoho SMTP acknowledgement   <- new, in its own try/catch
          ->  the existing 200
```

Reaching the acknowledgement line **is** the confirmation: `createLead()` throws
unless the contact write and the form submission both succeeded.

### The send is awaited, deliberately

```js
try {
  const ack = await sendAcknowledgement(payload.lead, { submission_id: sid });
  ...
} catch (mailErr) {
  log("lead.ack.failed", { submission_id: sid, reason: classifyMailError(mailErr) });
}
return send(res, 200, { ok: true, submission_id: sid });
```

Not `sendAcknowledgement(...); return response;`. Vercel may freeze the
container the moment the response is written, which would kill an in-flight SMTP
conversation partway through — and it would look fine in every log, because
nothing would have thrown yet. Awaiting costs a second or two of function time
and is the only way the send reliably happens.

`api/lead.js` `maxDuration` in `vercel.json` therefore goes **15s → 30s**. The
function already made sequential HubSpot calls and now waits on SMTP as well.
`memory` is unchanged at 256 MB.

## 4. New module: `api/_lib/mail.mjs`

**This is not `api/_lib/zoho.mjs`.** That file is dormant Zoho CRM rollback
code, imported by nothing. The two share a vendor name and nothing else:
`ZOHO_CLIENT_ID` and friends are CRM OAuth credentials for a path that is not
live; `ZOHO_SMTP_*` are mailbox credentials for a path that is. `zoho.mjs` was
not read, modified, imported or deleted by this change, and `tools/check.mjs`
now fails the build if either module references the other.

Exports:

| Export | Purpose |
|---|---|
| `isMailConfigured()` | true only when all four `ZOHO_SMTP_*` variables are present and non-empty |
| `buildAcknowledgement({first_name, email})` | the message. Takes only the two fields it is allowed to use, so a future caller cannot widen it by passing the whole payload |
| `escapeHtml(v)` | `& < > " '` |
| `classifyMailError(err)` | a stable token: `auth`, `envelope`, `connection`, `message`, `smtp_<code>`, `unknown` |
| `sendAcknowledgement(lead, {submission_id})` | the send |
| `setTransportFactory(fn)` | the DI seam; tests inject a recorder |
| `FROM` `REPLY_TO` `SUBJECT` `SIGNATURE_IMAGE` | pinned constants |

Nodemailer is a **production** dependency (`nodemailer@^10.0.1`), imported
lazily inside the transport factory so it is not loaded when SMTP is
unconfigured or when tests inject their own transport. No hand-rolled SMTP.

SMTP settings: host and port from the environment, `secure: true` when the port
is 465 (implicit TLS; 587 would be STARTTLS), and bounded timeouts —
`connectionTimeout` 5s, `greetingTimeout` 5s, `socketTimeout` 8s. A function
that hangs on a socket burns its whole `maxDuration` and leaves the visitor
watching a spinner; failing fast and logging is strictly better. The transport
is created per invocation rather than pooled, because a serverless container can
be frozen between requests and a held connection is probably already dead.

## 5. The message

Only the **first name** and the **email address** are used. The property
address, phone, timeline, condition, notes, message, topic and every attribution
value are deliberately excluded — this is a human note, not a receipt, and
echoing someone's data back to an address that has not been confirmed is a
disclosure the email has no reason to make. A test enumerates those values and
asserts none of them appears in either body.

No tracking pixel, no open or click tracking, no UTM parameters, no marketing
footer, no unsubscribe language. A test asserts the only three links in the HTML
are `tel:+14192454655`, `mailto:crystal@crystalsellstoledo.com` and
`https://crystalsellstoledo.com`, and that the only image is the signature
headshot.

**The first name is the one place visitor input reaches HTML**, and it is a
free-text field with a 40-character cap and no character restrictions, so it is
escaped. The plain-text part is not markup and keeps what was typed.

The HTML signature is sent explicitly. Zoho Mail's saved GUI signature applies
only to messages composed in Zoho Mail's web client; SMTP automation gets
nothing unless it sends it. Zoho's stored signature was not queried or modified.

The headshot is referenced from
`https://raw.githubusercontent.com/tomytomz1/crystal-sells-toledo/main/assets/img/Crystal%20Saylor%20Email%20Signature%20Headshot.jpg`
— pinned to `main`, so the image recipients load is whatever `main` carries.

## 6. Logging and privacy

The repository has a strict no-PII logging policy and this preserves it. Three
events, carrying `submission_id`, `form_type` and an outcome, and nothing else:

- `lead.ack.sent`
- `lead.ack.skipped` (with `reason: "not_configured"`)
- `lead.ack.failed` (with `reason: <classification>`)

Plus `mail.ack.accepted` with `submission_id` and a duration.

**`logError()` is deliberately not used on the mail path.** It emits
`err.message`, and a Nodemailer error's message and `response` carry the
recipient address and the raw SMTP conversation — including, on an auth failure,
whatever the server chose to echo. The catch uses `log()` with a classification
token instead. `tools/check.mjs` fails the build if `logError` reappears in
`api/_lib/mail.mjs` or is handed the mail error in `api/lead.js`.

No recipient address, first name, last name, phone, property address, message,
notes, SMTP username, password, raw message object or raw SMTP response is
logged anywhere.

## 7. Build guards

`tools/check.mjs` gained a block for the three ways this quietly stops being
harmless, none of which breaks a build or a test on its own:

1. **The send stops being awaited** — fails on a bare `sendAcknowledgement(`.
2. **The send moves above `createLead`** — fails on source order, so a visitor
   cannot be thanked for a lead that was never stored.
3. **A mail failure stops being swallowed** — fails if the `catch (mailErr)`
   goes away.

Plus: `api/lead.js` must not import `zoho.mjs`; `mail.mjs` must not reference
it; `logError` must not touch the mail path; `isMailConfigured`,
`classifyMailError` and `setTransportFactory` must stay exported; and
`vercel.json` must keep `api/lead.js` at `maxDuration >= 30`.

Comments are stripped before those regexes run, so a comment explaining
*"this is NOT zoho.mjs"* cannot trip the rule it documents.

`SECRET_NAMES` gained all four `ZOHO_SMTP_*` names, so the existing scan of
browser-delivered output fails the build if any of them ever appears there.

### One existing guard had to be made precise

`.env.example` was previously checked with: *no `ZOHO_*` variable may appear
above the `ROLLBACK ONLY` heading.* That rule exists so Zoho **CRM** never reads
as the live lead destination. `ZOHO_SMTP_*` is a live path that happens to share
the vendor prefix, so the rule as written made "document the SMTP section as
live" and "keep the CRM rollback section" mutually exclusive.

The ordering rule now applies to Zoho CRM variables only (`^ZOHO_(?!SMTP_)`),
and two new assertions were added in its place: all four SMTP variables must be
documented, `ZOHO_SMTP_PASSWORD` must be documented **empty**, and the SMTP
section must sit **above** the rollback heading. The CRM rule is otherwise
unchanged and the rollback section is retained verbatim.

## 8. Tests

| Suite | Result |
|---|---|
| `npm run build` | 10 pages |
| `npm run check` | 10 pages, 0 errors, 0 warnings |
| `npm run test:unit` | **97 passed, 0 failed** |
| `npm run test:browser` | **103 passed, 0 failed** |
| `npm run test:hubspot` | **90 passed, 0 failed** |
| `npm run test:mail` (new) | **36 passed, 0 failed** |

`tests/mail.test.mjs` opens **no socket**. The transport is injected via
`setTransportFactory()`, HubSpot is a stubbed `fetch`, and no real credential is
read. It covers ordering (SMTP only after HubSpot, never on a HubSpot failure,
never on a validation rejection, never when the CRM is unconfigured), the
response contract under every mail outcome, the exact From / Reply-To / Subject
/ recipient, HTML escaping against a hostile first name, the absence of every
lead field other than the name, the full signature and its image URL, the
absence of marketing and tracking, error classification, and that neither the
SMTP password nor the HubSpot token reaches a response body or a log line.

### The guards were proved to fail

Four mutations in a **throwaway copy** of the tree (the working tree was never
modified, per the project's working agreement):

| Mutation | Caught by |
|---|---|
| Drop the `await` (fire-and-forget) | `check.mjs` |
| Move the acknowledgement above `createLead` | `check.mjs` **and 2 mail tests** |
| Remove the `catch` so mail failures escape | `check.mjs` (and the mail suite aborts) |
| Log the raw error via `logError` | `check.mjs` **and the credential-leak test** |
| Revert `maxDuration` to 15 | `check.mjs` |

The fourth one matters most: it proves the credential-leak test is not a no-op.

## 9. What is explicitly NOT done

- **No email has ever been sent by this code.** Every test uses an injected
  transport. Nothing here proves Zoho accepts the login, that
  `smtppro.zoho.com:465` is reachable from a Vercel function, that the From
  address is accepted, or that the message renders correctly in any mail client.
  **Only a real send proves those.**
- Not merged, not deployed. The SMTP variables exist only in Vercel Production.
- No production form was submitted and no HubSpot contact was created.
- No change to validation, the HubSpot mapping, dedupe, the enquiry block, rate
  limiting, attribution, GA4, any analytics event, the browser bundle, DNS, or
  any Vercel environment variable.
- `api/_lib/zoho.mjs` untouched.
- `vercel.json` `memory` untouched.
- **`docs/PHASE-1-HANDOFF.md` was not updated.** It describes the current
  *production* state, and production does not do this yet. It should gain the
  acknowledgement path when this deploys.

## 10. What a human must still do

1. **Merge and deploy** — nothing above reaches production otherwise.
2. **Send one real test lead through the deployed site** (not the production
   form with a fake identity — a real submission from an address Crystal
   controls) and confirm: the HubSpot contact appears, the email arrives, the
   signature image loads, and the From address is not rewritten.
3. **Check the Vercel logs for `lead.ack.sent`.** If you see `lead.ack.failed`
   with `reason: "auth"`, the app password is wrong or Zoho requires an
   application-specific password rather than the account password. `envelope`
   usually means the From address is not the authenticated mailbox.
4. **Consider naming Zoho Mail on `/privacy`.** The page already says details
   are used "to reply to you" and are shared with "the service providers that
   run this site", which covers this, and the acknowledgement adds no new
   category of data. But Zoho is now a processor that handles the visitor's
   email address, and the page names its other processors explicitly. I did not
   change it — this task's scope forbade copy changes — but it is the one
   loose end I would not leave indefinitely.
