# Completion checklist adopted — 31 August 2026

Process change plus a verification run. **No production code was changed.**
Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`, merged to `main`.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead` that
validates website enquiries and writes them into **Zoho CRM (free edition)**.

`CLAUDE.md` at the repo root is read automatically at the start of any session,
including by an assistant with no memory of previous conversations. It is where
working agreements are recorded so they survive.

---

## 2. What changed

### 2.1 A completion checklist is now part of the working agreement

Added to `CLAUDE.md`. Six steps, required before reporting any work as finished:

1. Run the full test suite — `npm test`
2. Write `docs/updates/YYYY-MM-DD-<slug>.md`
3. Update `docs/PHASE-1-HANDOFF.md` if any contract changed
4. Commit
5. Push the branch
6. Report: commit SHA, update-document path, test result, whether anything
   remains blocked, whether human action is required

Two clauses were written to close specific gaps rather than as boilerplate:

> **Run the full test suite.** Not a subset, and not "no code changed so it
> cannot have broken": run it and report the real number.

This exists because on the previous pass the full suite was skipped on the
reasoning that a Markdown edit could not affect it. That reasoning was correct
and the outcome was fine, but it is the wrong default — the cost of running 62
tests is seconds, and the cost of being wrong about what "cannot" break is a
defect shipped with a clean report attached.

> Never let "tests pass" imply "this works in production" when no live call has
> been made.

This exists because the Zoho integration is fully tested and entirely unproven at
the same time, and those two facts are easy to conflate in a summary.

### 2.2 The skipped suite was run

`npm test` was executed against the current tree to close the gap from the
documentation-only pass.

---

## 3. Files changed

```
EDIT  CLAUDE.md                                    completion checklist
NEW   docs/updates/2026-08-31-completion-checklist.md   this file
```

No code, no configuration, no contract.

---

## 4. Test result

```
npm test

  Built 9 pages into public/
  9 pages checked - no errors, 2 warnings

  # tests      62
  # suites      9
  # pass       62
  # fail        0
  # cancelled   0
  # skipped     0
```

The two warnings are long-standing and unrelated to this pass: 15 site images are
still placeholders, and one meta description runs 7 characters over the 160-char
target.

This run confirms the previous documentation-only pass broke nothing — which was
expected, but is now verified rather than assumed.

---

## 5. Contract status

**Unchanged.** The endpoint, CRM payload, field limits, environment variables and
picklist handling are exactly as at `dc2d618`. `docs/PHASE-1-HANDOFF.md` needed
no update and was not modified in this pass.

For completeness, the contract as it stands:

- `POST /api/lead`, JSON only, 16 KB cap, same-origin
- `200 { ok: true, submission_id }` or `4xx { ok: false, code, message }`
- Limits `first_name 40 · last_name 80 · email 100 · phone 30`, aligned to Zoho,
  rejected rather than truncated
- Zoho Lead carries `Company` (mandatory), `Lead_Source` configurable,
  `Lead_Status` omitted unless `ZOHO_LEAD_STATUS` is set
- Upsert on `Email` plus a Note on every submission

---

## 6. What a human must still do

Unchanged from `docs/updates/2026-08-31-zoho-schema-corrections.md` section 6.
Nothing in this pass added or removed a manual step.

1. Create the Zoho Self Client and exchange the code for a refresh token
2. **Run `npm run zoho:verify`** — confirms the account's real picklist values
3. Confirm `Website` exists in the Lead Source picklist, or set `ZOHO_LEAD_SOURCE`
4. Choose a Lead Status from what `zoho:verify` lists and set `ZOHO_LEAD_STATUS`
5. Set the environment variables in Vercel and redeploy
6. Submit a live test lead; confirm one Lead with a Note attached
7. Submit a second with the same email; confirm one Lead, two Notes

---

## 7. What is explicitly NOT done

- **No production code was touched.** No behaviour changed.
- **No contract changed.**
- **The Zoho integration remains unproven.** 62 passing tests describe how the
  code behaves against mocks and a documented schema. No call has been made to a
  real Zoho account. Until step 6 above happens, "tested" and "working" are
  different claims.
- Nothing in `docs/PHASE-1-HANDOFF.md` section 6 was altered.
