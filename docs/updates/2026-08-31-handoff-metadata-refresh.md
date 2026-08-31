# Handoff metadata refresh — 31 August 2026

Documentation-only pass. **No production code was changed.**
Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`, merged to `main`.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead` that
validates website enquiries and writes them into **Zoho CRM (free edition)**.

`docs/PHASE-1-HANDOFF.md` is the master context document — the file handed to
another assistant so it can pick the project up cold. Its accuracy is the whole
point of it, so stale numbers in it are a real defect, not a cosmetic one.

An earlier pass corrected the Zoho Lead schema (commit `dc2d618`) but left some
of the handoff's own metadata describing the state *before* that correction.

---

## 2. What was wrong

| Location | Said | Should say | Why it mattered |
|---|---|---|---|
| Header, line 4 | reflects commit `9489b72` | `dc2d618` | Pointed at the state **before** the Zoho schema correction. A reader checking out that commit would get the version with no `Company` field and the wrong limits. |
| Repo layout | `node:test suites (40 tests)` | 62 | Understated coverage by a third. Someone seeing 62 tests run would reasonably wonder which file was lying. |
| Commands | `npm test  # build + check + 40 automated tests` | 62 | Same. |
| Commands | no `npm run zoho:verify` | listed | The command that confirms Zoho picklists before go-live was missing from the only place a new reader looks for commands. |

Four issues in total. Three were stale counts; the fourth was an omission that
mattered more than the counts, because `zoho:verify` is the step that prevents a
failed first live submission.

---

## 3. What was checked and found already correct

The brief asked for a sweep of several specific stale patterns. These were
searched and are all clear — the schema-correction pass had already updated them:

| Pattern | Result |
|---|---|
| `9489b72` (old commit) | clear after this pass |
| `40 tests` / `40 automated` | clear after this pass |
| `first_name 80` (pre-correction limit) | already clear |
| `email 254` (pre-correction limit) | already clear |
| `phone 40` (pre-correction limit) | already clear |
| `Lead_Status = New Lead` | already clear |
| `"Lead_Status": "New Lead"` in a payload | already clear |
| Missing `Company` | already documented, 6 mentions |
| Old Zoho scopes | already updated — `ZohoCRM.settings.fields.READ` present |

One mention of the phrase "New Lead" **remains, and is correct.** It appears in
the explanatory passage stating that `New Lead` is *not* a stock Zoho status:

> Zoho's stock statuses are `Not Contacted`, `Contacted`, `Pre-Qualified`, … —
> **`New Lead` is not among them** on a default account.

That sentence is the documentation of the fix, not a leftover of the bug. It was
deliberately kept.

---

## 4. What changed

Only `docs/PHASE-1-HANDOFF.md`. Three edits:

**1. Header reference re-pinned, and made stale-resistant.**

```
Everything below reflects the repo as of dc2d618, the most recent commit to
change production code (the Zoho Lead schema correction pass) ...

Later commits on this branch may be documentation-only; this reference is
deliberately pinned to the last code change so it does not go stale every time
a note is written.
```

Pinning to the last *code* commit rather than to `HEAD` is the point. Every
documentation commit moves `HEAD`, so a `HEAD` reference would be wrong again
within minutes of being written — which is precisely how the original went stale.

**2. Repo layout test count** — `(40 tests)` becomes `(62 tests)`.

**3. Commands block** — count corrected and the missing command added:

```bash
npm run build        # src/ + assets/ -> public/
npm run check        # static validation
npm test             # build + check + 62 automated tests
npm run zoho:verify  # confirm Zoho picklists against the real account
npm run dev          # build, then serve public/ on :3000
```

---

## 5. Verification

```
files modified            docs/PHASE-1-HANDOFF.md   (1 file)
production code changed   0 files
npm run check             9 pages checked, no errors, 2 warnings
```

The two warnings are long-standing and unrelated: 15 site images are still
placeholders, and one meta description runs 7 characters over the 160 target.

Stale-pattern scan after the edit: all eight patterns clear. Positive scan
confirms the doc now contains `dc2d618`, the 62-test count in both places,
`zoho:verify`, the `Company` field, the `ZohoCRM.settings.fields.READ` scope, and
the corrected limits `first_name 40` / `email 100` / `phone 30`.

No tests were run beyond `npm run check`, because no code changed. The full
62-test suite last passed at `dc2d618` and is unaffected by an edit to a Markdown
file that is not deployed.

---

## 6. What a human must still do

Nothing new from this pass. The outstanding manual work is unchanged and is
documented in `docs/updates/2026-08-31-zoho-schema-corrections.md` section 6:

1. Create the Zoho Self Client and exchange the code for a refresh token
2. **Run `npm run zoho:verify`** — confirms the account's real picklist values
3. Confirm `Website` exists in the Lead Source picklist, or set `ZOHO_LEAD_SOURCE`
4. Choose a Lead Status from what `zoho:verify` lists and set `ZOHO_LEAD_STATUS`
5. Set the environment variables in Vercel and redeploy
6. Submit a live test lead and confirm one Lead with a Note attached
7. Submit a second with the same email and confirm one Lead, two Notes

---

## 7. What is explicitly NOT done

- **No production code was touched.** No behaviour changed.
- **No contract changed.** The endpoint, CRM payload, field limits, environment
  variables and picklist handling are exactly as at `dc2d618`.
- **The Zoho integration remains unproven.** No live call has been made to a real
  Zoho account. That end-to-end test still has to happen.
- Nothing in `docs/PHASE-1-HANDOFF.md` section 6 (the constraints that must not be
  broken) was altered.
