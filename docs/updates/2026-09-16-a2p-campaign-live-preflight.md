# A2P Campaign live-form preflight — 16 September 2026

## Status

Twilio A2P Campaign registration has begun but **has not been submitted**.

Operator-supplied Console evidence establishes that:

- the approved **Sole Proprietor** Brand is being used;
- the existing Messaging Service is selected;
- the Campaign description step was reached;
- the Message Flow step is open;
- the live Campaign form explicitly requires the Privacy URL to point to a page titled **Privacy Policy** and the Terms URL to point to a page titled **Terms & Conditions** or **Terms of Service**;
- the same form explicitly calls for a privacy non-sharing statement and an SMS Terms section.

Submission is intentionally paused until the legal-page source change in this work is merged, deployed and observed live.

## Source correction

The existing legal URLs stay unchanged:

- `https://crystalsellstoledo.com/privacy`
- `https://crystalsellstoledo.com/communications-terms`

The source now labels those pages for the review contract:

- `/privacy` → title/H1 **Privacy Policy**;
- `/communications-terms` → title/H1 **Terms & Conditions**;
- the text-message section is visibly headed **SMS Terms**;
- the Privacy Policy carries the exact sentence: **“We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.”**;
- the Terms page carries **“Carriers are not liable for any delayed or undelivered messages.”**;
- the existing message-frequency, message/data-rate, STOP, HELP, support-contact and separate AI-voice disclosures remain.

## What did not change

- No consent checkbox wording changed.
- No consent version identifier changed.
- No consent grant, suppression or ledger semantics changed.
- No Twilio object was created, submitted or approved by this source change.
- No Vercel, Neon, HubSpot or Retell configuration was changed by this source change.

## Release proof

A dedicated CI test builds the site with `COMMUNICATIONS_CONSENT_ENABLED=true` in a throwaway tree and asserts the generated Privacy Policy and Terms & Conditions pages, so the release check cannot pass merely because the feature-gated legal copy was omitted.

After merge and Production deployment, an operator must load both live URLs and verify the new titles/headings and required disclosures before returning to the open Twilio Message Flow step.
