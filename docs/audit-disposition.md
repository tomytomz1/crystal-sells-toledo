# Content audit — disposition of all 87 findings

Source audit: content QA of `fb6e70c`, September 4, 2026.
Implemented in `8394893`; independently verified; corrected in the commit that
adds this file.

**Status key**

- **Fixed** — addressed in source or local behavior. Not a blanket approval of
  surrounding claims, and not a verification of production settings.
- **Pending** — needs a fact from Crystal, Key Realty or the site
  administrator. The unsupported wording is already gone; see
  `content-decisions.md` for the owner and the question.
- **Deferred** — could not be completed from this environment, with the reason.

Every external host (`ohio.gov`, `policies.google.com`, `legal.hubspot.com`,
`vercel.com`, `zillow.com`) is unreachable through this environment's egress
proxy. No URL was guessed to close a finding.

| ID | Status | Note |
|---|---|---|
| G01 | Pending | Oversized full name removed; every occurrence now renders at the same size and weight as its paired brokerage (13.12 / 15.2 / 15.2 px). Overall display is the broker's call. |
| G02 | Fixed | Footer, schema and page copy softened; the social image now reads "Perrysburg & Greater Toledo · Key Realty LTD". |
| G03 | Fixed | Same-day, few-hour and immediate-handling promises removed from all identified surfaces, including the contact success message in `main.js`. |
| G04 | Fixed | Fifteen-minute valuation promise replaced. |
| G05 | Fixed | "Privacy & terms" in the shared footer and beside form step one. |
| G06 | Fixed | Greater Toledo, backward, afterward, inquiry, backs up to. Also two British spellings the audit's own list missed: "two-storey", "centre of town". |
| G07 | Fixed | Independent-office sentence removed pending brokerage confirmation. |
| H01 | Fixed | Three-quarters statistic removed. |
| H02 | Fixed | "Add thousands" removed. |
| H03 | Pending | Universal-package wording removed everywhere; actual inclusions await Crystal. |
| H04 | Fixed | Street-speed causal claim removed; residence and family facts retained. |
| H05 | Fixed | Corrected on `/home-value` and `/sell` in `8394893`; the two homepage surfaces were missed and are fixed here. |
| H06 | Fixed | Competition informs pricing context rather than changing value. |
| H07 | Fixed | Homepage demand and recent-sales generalizations removed. |
| H08 | Fixed | Hero now states the broader service area explicitly; metadata aligned. |
| S01 | Fixed | "Only three things" and the guaranteed-value headline replaced. |
| S02 | Fixed | Loss, ten-day and nobody-wants-to-buy claims removed. |
| S03 | Fixed | Over-pricing framed as a risk, not an inevitability. |
| S04 | Fixed | 90-day and same-street promises replaced with relevance-based wording. |
| S05 | Fixed | Near-universal repair ROI claims removed. |
| S06 | Fixed | Unconditional cancellation right replaced; actual terms are a broker question (B1). |
| S07 | Fixed | Buyer-broker compensation is something the seller may agree to pay. |
| S08 | Fixed | Financing and occupancy options made conditional. |
| V01 | Fixed | Five-figure estimate-error claim removed. |
| V02 | Fixed | Market analysis distinguished from an appraisal and from a guaranteed price. |
| V03 | Pending | Copy now distinguishes the two services; the real deliverable difference awaits Crystal. |
| V04 | Pending | The unverified follow-up promise is removed — the page says only that the choice is recorded. Restore stronger wording only once the procedure is confirmed. |
| R01 | Fixed | Address, name and email requirements disclosed; FAQ tense corrected. |
| R02 | Fixed | "In writing" removed in `8394893`; "A person reads it before you do", "Listed out" and the note-on-the-range wording removed here. |
| R03 | Fixed | Shared privacy line parameterized per offer. |
| R04 | Fixed | "when you did it". |
| R05 | Fixed | Above-grade living area and basement space distinguished, with no value-equivalence claim. |
| R06 | Fixed | Bedroom-count hierarchy removed. |
| R07 | Fixed | Most/most-common frequency assertions removed. |
| R08 | Fixed | Price effects and savings qualified. |
| R09 | Fixed | Asking price separated from final sale price throughout. |
| R10 | Fixed | Repairs no longer characterized as mostly cheap. |
| R11 | Fixed | Absolute comparable-sale rules softened. |
| R12 | Fixed | "Holds up" removed; a possible in-person visit acknowledged. |
| R13 | Pending | **Fee is a launch decision.** Absence of a price does not settle it. |
| R14 | Fixed | Standing-next-to, ask-an-estimate and early-usefulness phrasing corrected. |
| R15 | Fixed | Appraisal wording directs the reader to the requiring party's scope. |
| B01 | Fixed | Guaranteed outcomes and universal pre-approval removed; cash buyers acknowledged. |
| B02 | Fixed | Alerts and pre-market sharing qualified by availability and permission. |
| B03 | Fixed | Representation and fees added in `8394893`, and moved ahead of showings here. Exact sequence still needs broker approval (B4). |
| B04 | Fixed | Document explanation scoped; eligibility directed to the lender. |
| B05 | Fixed | Buyer CTAs match their destination; the closing band is buyer-specific. |
| B06 | Fixed | Absent image and misleading location alt text removed; single-column layout. |
| A01 | Fixed | REPLACE comment resolved; attestation referenced, no new claim. |
| A02 | Fixed | Appreciation and outperform-the-neighbor claims removed. |
| A03 | Fixed | Six-county competence comparison removed. |
| A04 | Deferred | Over-broad "any Ohio license" fixed by naming the department. No link: every `ohio.gov` host is unreachable here, and the audit forbids guessing a portal. |
| N01 | Fixed | Intro rewritten; "areas that come up often" also removed here. |
| N02 | Fixed | All twelve placeholder frames removed. |
| N03 | Fixed | Value claims removed; sourced architectural description retained. |
| N04 | Fixed | Turnover and resident-behavior claims removed. |
| N05 | Fixed | Busiest-market claim removed; the "wide price range" tag also removed here. |
| N06 | Fixed | Cross-river value comparison removed. |
| N07 | Fixed | First-home generalization removed; water rights property-specific. |
| N08 | Fixed | Body qualified in `8394893`; the "Larger lots" and "Lake access" tags replaced here with the two city names. |
| N09 | Fixed | Inspection, photography and oldest/most-walkable absolutes removed. |
| N10 | Fixed | Dominance and maintenance claims removed; the residual landscaping/privacy assertion and low-project implication removed here. |
| N11 | Fixed | $60,000 example, last-month sale and walkthrough-return promise removed. |
| N12 | Fixed | Access and flood questions made property-specific and early. |
| N13 | Fixed | Downsizer and upkeep claims removed; the traffic/quiet comparison replaced here with "visit at different times". |
| N14 | Fixed | Build-quality and four-house claims removed; the "large share of the housing" magnitude claim introduced by the previous pass removed here. |
| N15 | Fixed | Any-street guarantee removed. |
| P01 | Fixed | Attribution acknowledged as stored with the inquiry. |
| P02 | Fixed | `email_click` strips the mailto query and body. Pinned by a browser test that fails against the old code. Historical events remain for the owner to review (A2). |
| P03 | Fixed | The first fix swept only when a window had elapsed since the last sweep, which retained an expired key under staggered arrivals (verified: 3 keys where 2 were live). It now sweeps on every call, and both privacy paragraphs describe lazy cleanup instead of promising a deletion moment. |
| P04 | Fixed | Maps script load and connection information disclosed. |
| P05 | Fixed | First-visit local storage and its lack of expiry disclosed. |
| P06 | Fixed | Private browsing no longer offered as an opt-out. |
| P07 | Pending | Legal-basis assertion removed; retention, deletion and approval outstanding. |
| P08 | Fixed | Shared reference number and deletion limits acknowledged. |
| P09 | Deferred | Plain-language changes made. Provider policy links not added: all three hosts are unreachable here and none could be verified. |
| P10 | Fixed | Notice names the Seller Strategy Review. |
| F01 | Fixed | Ordinary validation and transport messages fixed in `8394893`; hidden-field overlength now returns the generic recovery message, and the oversized-body error gives an action instead of a KB figure. |
| F02 | Fixed | 4,000-character help associated with each field; ambiguous condition option replaced; optional fields labeled. |
| F03 | Fixed | Dated example and "backs onto" replaced. |
| F04 | Fixed | Singular/plural and stale counts fixed in `8394893`; the no-results announcement added here. |
| F05 | Fixed | POST plus a noscript block that hides the form and gives phone and email. Pinned by a browser test that fails against the old code. |
| M01 | Pending | Person and business split into separate nodes with consistent `@id`s; the actual entity relationship needs confirmation. |
| M02 | Fixed | `priceRange` removed; uncertain municipalities typed as `Place`. |
| M03 | Fixed | Author and manifest use the full identity. |
| M04 | Fixed | Manual content date; per-page sitemap `lastmod` replaces the build timestamp. |
| M05 | Fixed | All seven descriptions replaced and propagated to Open Graph and Twitter. |

**Totals: 79 fixed, 6 pending a named owner's answer, 2 deferred for an
unreachable external source.**

Fixed does not mean approved. The service, fee, delivery, response-time,
retention and brokerage questions in `content-decisions.md` are still open, and
two of them block launch.
