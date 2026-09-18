from pathlib import Path

p = Path('docs/CURRENT-STATE.md')
text = p.read_text()


def replace_once(old, new, label):
    global text
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected one anchor, found {n}')
    text = text.replace(old, new, 1)


replace_once(
'''- Three server endpoints, with their libraries under `api/_lib/`:
  - **`api/lead.js`** — the lead. **Live.**
  - **`api/twilio-inbound.js`** — inbound SMS, gate 7. **Inert**: `TWILIO_AUTH_TOKEN`
    is set in no environment and no Twilio number points at it.
  - **`api/operator-action.js`** — the operator's suppression entry, gate 7.
    **Inert**: `OPERATOR_ACTION_SECRET` is set in no environment.''',
'''- Four server endpoints, with their libraries under `api/_lib/`:
  - **`api/lead.js`** — the lead. **Live.**
  - **`api/twilio-inbound.js`** — inbound SMS, gate 7. **Inert**: `TWILIO_AUTH_TOKEN`
    is set in no environment and no Twilio number points at it.
  - **`api/operator-action.js`** — the operator's suppression entry, gate 7.
    **Inert**: `OPERATOR_ACTION_SECRET` is set in no environment.
  - **`api/operator-unsuppress.js`** — deliberate operator unsuppression.
    **Built, merged and inert**: it requires the separate
    `OPERATOR_UNSUPPRESS_SECRET` and `CONSENT_LEDGER_OPERATOR_URL`; neither is
    established as present in Production.''',
'shape')

replace_once(
'''- **Re-opt-in / unsuppression — NOW DESIGNED, STILL NOT BUILT.** The
  `unsuppressed` event type exists and **nothing writes it.** A
  `reoptin_requested` event is recorded, deliberately without clearing anything
  — a suppression is never cleared automatically — and **no operator workflow
  exists to clear one deliberately.** The semantics were settled on
  **15 September 2026** (`docs/updates/2026-09-15-unsuppression-reoptin-decision.md`);
  **no code, migration, endpoint or test was written.** See the section below.''',
'''- **Re-opt-in / unsuppression — BUILT, MERGED, AND INERT.** The database
  foundation from `db/003` is already applied in Production, and the deliberate
  operator workflow now exists at `api/operator-unsuppress.js`. It uses a
  separate 24-hour sealed capability, the dedicated `consent_ledger_operator`
  credential, fresh pre/post durable reads, `rowsAffected === 1` replay gating,
  and a HubSpot projection that can reset an actually-unblocked channel only to
  `never_granted` — never to `granted`. **It is not activated:**
  `OPERATOR_UNSUPPRESS_SECRET` and `CONSENT_LEDGER_OPERATOR_URL` are not
  established as present in Production. It does not reconcile Twilio and does
  not make SMS deliverability claims. See
  `docs/updates/2026-09-18-unsuppression-operator-workflow.md`.''',
'not-built bullet')

replace_once(
'## Unsuppression / re-opt-in — DATABASE FOUNDATION APPLIED IN PRODUCTION, WORKFLOW NOT BUILT',
'## Unsuppression / re-opt-in — DATABASE FOUNDATION APPLIED; OPERATOR WORKFLOW BUILT, MERGED, AND INERT',
'heading')

replace_once(
'''Design settled 15 September 2026:
`docs/updates/2026-09-15-unsuppression-reoptin-decision.md`. The **database
layer** of that design is now written, verified and **applied to production
Neon**; **nothing else is built.**

**Production DATABASE changed: YES** — `db/003`'s three functions, the
`consent_ledger_operator` role and its grants now exist on the live Neon
`Primary` branch. **Production APPLICATION behaviour changed: NO** — nothing in
`api/` or `src/` calls either new function, no endpoint or sender was
activated, and no outbound messaging, Twilio or Retell capability was turned
on.''',
'''Design settled 15 September 2026:
`docs/updates/2026-09-15-unsuppression-reoptin-decision.md`. The **database
layer** is written, verified and **applied to production Neon**. The first
application-layer operator workflow is now also **built and merged**, with the
implementation record in
`docs/updates/2026-09-18-unsuppression-operator-workflow.md`.

**Production DATABASE changed: YES** — `db/003`'s three functions, the
`consent_ledger_operator` role and its grants exist on the live Neon `Primary`
branch. **Production messaging behaviour changed: NO.** The new endpoint is
fail-closed and inert until both `OPERATOR_UNSUPPRESS_SECRET` and
`CONSENT_LEDGER_OPERATOR_URL` are deliberately configured. No outbound sender
was added, no message or call is placed, Twilio is not reconciled, and clearing
our durable block never grants consent.''',
'section intro')

p.write_text(text)
