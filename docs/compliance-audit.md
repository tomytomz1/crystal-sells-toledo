# Advertising Compliance Review — crystalsellstoledo.com

**Licensee** Crystal Saylor · Ohio licence #2025003655
**Brokerage** Key Realty LTD · 6800 W. Central Ave, Unit B, Toledo, OH 43617
**Scope** 9 published pages, shared header/footer, structured data, social share card
**Revision** 4 — factual questions resolved by owner, 31 August 2026
**Status** Site is live. All REQUIRED items closed. No open findings.

> **Not legal advice.** This is an engineering review of what the site actually renders,
> prepared to be handed to Key Realty's compliance contact. Rule text below was retrieved via
> web search rather than by opening `codes.ohio.gov` directly (blocked from this environment),
> so **every quotation should be confirmed against the primary source before it is relied on.**
> Where this review and Key Realty disagree, Key Realty is right.

---

## Revision 2 — what changed and why

Three corrections to Revision 1. Two were errors in my analysis; one was an omission.

### 1. The equal-prominence test was applied to the wrong name

Revision 1 compared the marketing brand *Crystal Sells Toledo* against *Key Realty LTD* and
called the difference a critical black-letter violation. The rule does not say that. It says:

> "The name of the brokerage shall be displayed at least in equal prominence with the name of
> the **salesperson** in all advertising, including internet websites, that are within the
> ownership or direct control of the licensee or the brokerage with which the licensee is
> affiliated."
> — OAC 1301:5-1-02(B)

The correct comparison is **"Crystal Saylor" against "Key Realty LTD"**. I have no authority
treating a solo personal marketing brand as the salesperson's name, and absent that the original
finding does not stand as written. Reclassified and narrowed — see **R-4**.

### 2. The Consumer Guide link was wrongly classified REQUIRED

OAC 1301:5-6-05 and ORC 4735.56 require the broker to *develop* the Consumer Guide to Agency
Relationships and the licensee to *provide* it at first substantive contact. I found **no
provision requiring the guide, or a link to it, on a public marketing website.** Reclassified
to BROKERAGE POLICY — see **B-2**.

### 3. A REQUIRED item was missed entirely

OAC 1301:5-1-02(E) requires a displayed last-updated date. Revision 1 did not mention it. The
site currently discloses no such date on any page except a bare year on `/privacy`. This is a
straightforward failure — see **R-1**.

---

## Classification key

| Class | Meaning |
|---|---|
| **REQUIRED** | Mandated by statute or rule, with authority cited below. Non-compliance is actionable. |
| **REQUIRED IF APPLICABLE** | Mandated only if a triggering fact is true. The fact is currently unconfirmed or false. |
| **BROKERAGE POLICY** | No independent legal authority found. Key Realty's policy governs. |
| **BEST PRACTICE** | Risk reduction, professionalism, or defensibility. Not a rule. |

---

## Findings

| ID | Finding | Class | Authority | Site status |
|---|---|---|---|---|
| **R-1** | Website must disclose the date its information was last updated | REQUIRED | OAC 1301:5-1-02(E) | **CLOSED** — footer, all 9 pages |
| **R-2** | Outdated information updated within 14 days | REQUIRED | OAC 1301:5-1-02(E) | Process duty; no breach evident |
| **R-3** | Brokerage name on every viewable web page | REQUIRED | OAC 1301:5-1-02 | **PASS** — all 9 pages |
| **R-4** | Brokerage ≥ equal prominence with the salesperson's name | REQUIRED | OAC 1301:5-1-02(B) | **CLOSED** — lockup site-wide, `/about` h1 restructured |
| **R-5** | No statement indicating protected-class preference | REQUIRED | 42 U.S.C. §3604(c); R.C. 4112.02(H) | **FIXED & deployed** |
| **R-6** | No fabricated endorsements | REQUIRED | FTC Act §5; 16 CFR Part 255; R.C. 1345.02 | **FIXED & deployed** |
| **R-7** | No misrepresentation in advertising | REQUIRED | ORC 4735.18; R.C. 1345.02 | **PASS** — owner confirms biography accurate |
| **R-8** | Advertise under the licensed name | REQUIRED | OAC 1301:5-1-02 | **PASS** — "Crystal Saylor" |
| **A-1** | Team advertising requirements | REQUIRED IF APPLICABLE | OAC 1301:5-1-21 | **Not applicable** — solo licensee |
| **A-2** | Team advertising, Degnan Group | REQUIRED IF APPLICABLE | OAC 1301:5-1-21(B) | **NOT ENGAGED** — membership confirmed, not advertised |
| **A-3** | REALTOR® mark usage and representation of membership | REQUIRED IF APPLICABLE | NAR trademark licence; ORC 4735.18(A)(12) | **PASS** — active NAR member confirmed |
| **A-4** | NAR Code of Ethics, Articles 11 & 12 | **APPLICABLE** | Binds NAR members | **IN FORCE** — governs P-1 and P-2 |
| **A-5** | MLS / IDX display and attribution | REQUIRED IF APPLICABLE | NORIS rules | Not applicable — no IDX feed |
| **B-1** | Marketing-name approval / registration | BROKERAGE POLICY | No authority found for a solo brand | Confirm with Key Realty |
| **B-2** | Consumer Guide link on the website | BROKERAGE POLICY | *Reclassified from REQUIRED* | Optional |
| **B-3** | Consolidated footer disclosure wording | BROKERAGE POLICY | — | Broker usually supplies approved text |
| **P-1** | "Specialist" wording | BEST PRACTICE | — | Judgment, per use |
| **P-2** | Unsourced market assertions | BEST PRACTICE | Escalates to R-7 if materially misleading | 3 instances |
| **P-3** | Absolute service promises | BEST PRACTICE | — | 4 instances |
| **P-4** | Footer contrast 3.1:1 | BEST PRACTICE | WCAG 1.4.3 — not Ohio code | Supports R-4 legibility |

---

## Authority for each REQUIRED item

### R-1 · Last-updated date — **FAIL**

> "Each website maintained by a licensee shall disclose the date upon which the information
> contained therein was most recently updated."
> — OAC 1301:5-1-02(E)

Current state: no last-updated disclosure on any page. `/privacy` renders "Last updated 2026",
which is one page, and a year rather than a date.

**Implementation note.** A build-stamped date changes on every deploy even when no content
changed; the rule asks when the *information* was updated. Recommend a manually maintained
content date rather than a build timestamp. This is a deliberate choice, not a detail.

### R-2 · Fourteen-day currency

> "Information on an internet website maintained by a licensee which becomes outdated or
> expired, shall be updated within fourteen days of the information becoming outdated or
> expired."
> — OAC 1301:5-1-02(E)

The same paragraph provides a safe harbour where a third party maintains the site and the
licensee gives timely written notice of required changes.

### R-3 · Brokerage on every page — **PASS**

> "All internet advertising of real estate services shall disclose the name of the brokerage on
> every viewable web page of the website."
> — OAC 1301:5-1-02

Verified mechanically: all nine pages render from one shared template, so the footer carrying
*Key Realty LTD* cannot be omitted from any page.

| Page | Brokerage name | Licence # | EHO | Disclaimers |
|---|---|---|---|---|
| `/` | Footer | Yes | Yes | Yes |
| `/sell` | Footer | Yes | Yes | Yes |
| `/buy` | Footer | Yes | Yes | Yes |
| `/home-value` | Footer | Yes | Yes | Yes |
| `/neighborhoods` | Footer | Yes | Yes | Yes |
| `/about` | Footer + body | Yes | Yes | Yes |
| `/contact` | Footer + body | Yes | Yes | Yes |
| `/privacy` | Footer + body | Yes | Yes | Yes |
| `/404` | Footer | Yes | Yes | Yes |

### R-4 · Equal prominence — **FAIL on `/about` only**

Authority quoted in *Revision 2 §1* above.

```
/about   h1  "Hi, I'm Crystal Saylor."     font-size up to 4.25rem
/about       "Key Realty LTD"              ~1rem body text
                                           → not equal prominence

Every other page: "Crystal Saylor" appears only in the footer legal
paragraph at 0.78rem, where "Key Realty LTD" sits at the same size,
weight and colour                          → equal → PASS
```

Also flagged conservatively: the `<title>` on `/about` and `/contact` reads
*"… Crystal Saylor | Greater Toledo REALTOR®"* — salesperson name with no brokerage. Title tags
render in search results and browser tabs. Whether a `<title>` is "advertising" for the purposes
of (B) is a judgment call for the brokerage.

### R-5 · Fair housing — **FIXED & deployed**

42 U.S.C. §3604(c); Ohio R.C. 4112.02(H). Familial status is a protected class.

Removed: `Family-heavy` as a neighbourhood tag; "Who it suits: families"; school-district
framing used as a reason to prefer an area; "downsizers" as an age proxy; JSON-LD
`knowsAbout: "Perrysburg schools"`. Every "Who it suits" label became "Best for", describing the
housing rather than the household.

Stating a school district as a neutral fact in answer to a client's question is a different act
from using it as a selling proposition. The site now does neither on its own initiative.

### R-6 · Fabricated endorsements — **FIXED & deployed**

FTC Act §5; 16 CFR Part 255; Ohio R.C. 1345.02.

Three placeholder quotation blocks attributed to "Client name · Perrysburg" were removed rather
than reworded. The section returns when real reviews exist, verbatim and with permission.

### R-7 · Misrepresentation — **PASS**

ORC 4735.18 (grounds for disciplinary action); Ohio Consumer Sales Practices Act, R.C. 1345.02.

The `/about` biography previously carried checkable personal assertions that had been drafted as
scaffolding and never confirmed. **The owner has confirmed all current biography statements are
factually accurate**, and they are treated as verified for the purposes of this review. No copy
was invented or substituted; the text stands as written.

This finding rests on the owner's representation. If any statement later proves inaccurate, the
finding reopens.

### R-8 · Licensed name — **PASS**

OAC 1301:5-1-02 requires advertising to identify the licensee by name. The site uses
"Crystal Saylor", matching the licence. Note the related provision: a preferred first name or
maiden name differing from the licence must be *registered with the Division* and must not be
misleading. Not currently engaged.

---

## Conditional items

### A-1 / A-2 · Team advertising — **membership confirmed, requirements NOT ENGAGED**

> "'Team' includes any group of **two or more** associated real estate licensees affiliated with
> the same brokerage … who advertise together in a group with a group name."
> — OAC 1301:5-1-21

**Owner confirms Crystal is a current member of the Degnan Group.** Membership and *advertising
as a team* are separate triggers. Under OAC 1301:5-1-21(B) the enhanced requirements attach when
the licensee **advertises as part of a team**.

**Factual finding: this website does not.** An exhaustive scan of every deployed surface returned
zero occurrences of "Degnan" or any group name:

| Surface scanned | Result |
|---|---|
| Rendered HTML — visible copy, headings, body | none |
| `<title>` tags | none |
| Meta description, author, geo | none |
| OpenGraph and Twitter card properties | none |
| JSON-LD structured data | none |
| Image `alt` text and filenames | none |
| SVG internals | none |
| CSS, including `content:` properties | none |
| JavaScript strings | none |
| `sitemap.xml`, `robots.txt`, `site.webmanifest` | none |
| Raw byte scan of all deployed files | none |

The scan was positive-controlled: a probe file containing "Degnan Group" was written into
`public/`, detected, and removed — confirming the search would have found a real occurrence.

Supporting evidence that no team is advertised:

- Only one licensee is named anywhere in deployed output: **Crystal Saylor** (36 occurrences).
  Only one brokerage: **Key Realty LTD** (36 occurrences). No second licensee appears.
- Seven first-person-plural instances exist. All are agent-and-client ("We walk the house
  together, room by room. **I** tell you what buyers will notice") or the brokerage fair-housing
  statement. Surrounding copy is consistently first-person singular. None implies a group of
  licensees.
- *Crystal Sells Toledo* contains neither "group" nor "team", which OAC 1301:5-1-21 requires a
  team name to include — so it is not being used as one.

**Conclusion.** Team-advertising requirements are not presently engaged by this website. Per
instruction, the Degnan Group has **not** been added for compliance purposes, and the existing
Crystal Saylor | Key Realty LTD lockup is preserved unchanged.

**Standing condition.** If the Degnan Group is ever named on this site, OAC 1301:5-1-21(B)(2)
engages and Key Realty LTD must then be displayed in equal or greater prominence with **both**
the team name and the salesperson's name. The current lockup would need extending to three
names at parity, not two.

### A-3 / A-4 · REALTOR® and the NAR Code — **RESOLVED**

**Owner confirms Crystal Saylor is an active REALTOR® and a current NAR member**, and a member
of the Toledo-area REALTOR® association (TBOR).

Ohio treats false representation of association membership as a disciplinary ground:

> ORC **4735.18(A)(12)** — falsely representing membership in a real estate professional
> association.

With membership confirmed, existing REALTOR® usage across the nine pages is authorised and may
remain. On-site format is correct: full capitals with the ® symbol.

Two consequences:

- **A-4 moves from conditional to APPLICABLE.** The NAR Code of Ethics binds members, so
  Articles 11 (competence) and 12 (true picture) now govern this site directly rather than as a
  fallback to the Ohio CSPA. Findings **P-1** and **P-2** are evaluated under them.
- **No association branding was added.** TBOR membership is recorded here only; per instruction
  no TBOR logo or other association mark has been placed on the site.

### A-5 · MLS / IDX

The footer displays a REALTOR® ∣ MLS badge, but the site carries no IDX feed and no listing
data. Not a violation. When a feed is added, NORIS display rules apply — data-source
attribution, a last-updated timestamp, and per-listing broker attribution. Budget for that
before switching a feed on.

---

## Proposed remedy for R-4 — legal identity lockup

Preserves *Crystal Sells Toledo* as the primary marketing brand and places a legal identity
lockup adjacent to it. Satisfies (B) on every page regardless of how "salesperson's name" is
read, which is the point of solving it conservatively.

```
Crystal Sells Toledo                    ← brand, unchanged, primary
──────────────────────────────
Crystal Saylor  |  Key Realty LTD       ← identical size, weight, colour,
Licensed in Ohio                           letter-spacing, opacity
```

Requirements for the implementation:

- Both names emitted from **one CSS rule** so they cannot drift apart in a future edit.
- Both **shrink together** at every breakpoint. Hiding the brokerage on small screens would
  recreate the violation for the majority of traffic.
- Same colour token and opacity — prominence is judged on legibility as well as size.
- Present site-wide, including `/about`, where the current failure is.

---

## Sequence

| # | Action | Finding | Owner |
|---|---|---|---|
| 1 | ~~Delete placeholder testimonials~~ | R-6 | **Done** |
| 2 | ~~Replace protected-class phrasing~~ | R-5 | **Done** |
| 3 | ~~Add site-wide last-updated date~~ | R-1 | **Done** — manual constant |
| 4 | ~~Add legal identity lockup + fix `/about` h1~~ | R-4 | **Done** |
| 5 | Crystal rewrites `/about` in verified facts | R-7 | Crystal |
| 6 | Confirm NAR membership | A-3 | Crystal — gates A-4, P-1, P-2 |
| 7 | Confirm Degnan Group status | A-2 | Key Realty |
| 8 | Confirm marketing-name approval | B-1 | Key Realty |
| 9 | Verify or soften market assertions | P-2 | Crystal, from NORIS |
| 10 | Adopt broker's approved footer wording | B-3 | Key Realty |

Items 1 and 2 are deployed. Items 3 and 4 are the open REQUIRED work and need a decision on the
date source and broker sign-off on the lockup respectively. Item 5 only Crystal can do.

---

## Already compliant

- Registered brokerage name **Key Realty LTD** present on all nine pages
- Licensee advertised under her **licensed name**, Crystal Saylor
- **Ohio licence number** published site-wide with a link to the eLicense system — above the minimum
- **Equal Housing Opportunity** logo and full non-discrimination statement on every page
- **"Deemed reliable but not guaranteed"** and **non-solicitation** language present
- Brokerage **street address and telephone** published
- Header and footer **structurally guaranteed** on every page by a shared template
- Commission described as **negotiable with no standard rate**
- Privacy notice discloses **analytics and data handling**; no data sold
- Social share card names the brokerage at **parity** with the personal brand

---

## Sources

Rule text was retrieved via web search; the primary sources below were not directly reachable
from the review environment and **should be opened and confirmed**.

- [OAC 1301:5-1-02 — Advertising](https://codes.ohio.gov/ohio-administrative-code/rule-1301:5-1-02)
- [OAC 1301:5-1-21 — Team advertising](https://codes.ohio.gov/ohio-administrative-code/rule-1301:5-1-21)
- [OAC 1301:5-6-05 — Consumer Guide to agency relationships](https://codes.ohio.gov/ohio-administrative-code/rule-1301:5-6-05)
- [ORC 4735.56](https://codes.ohio.gov/ohio-revised-code/section-4735.56)
- [Cornell LII — Ohio Admin. Code 1301:5-1-02](https://www.law.cornell.edu/regulations/ohio/Ohio-Admin-Code-1301-5-1-02)
