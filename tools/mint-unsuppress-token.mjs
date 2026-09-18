#!/usr/bin/env node
/* Mint ONE short-lived operator unsuppression URL off-platform.
 *
 * This tool is intentionally local-only: there is no HTTP endpoint that can
 * mint a clearance capability. It reads OPERATOR_UNSUPPRESS_SECRET from the
 * operator's environment, validates one phone + one lane, creates a fresh
 * approval id, and prints exactly one URL to stdout.
 *
 * Usage:
 *   OPERATOR_UNSUPPRESS_SECRET='...' node tools/mint-unsuppress-token.mjs \
 *     --phone '+14195551234' --scope sms
 */

import {
  mintUnsuppressApprovalId, sealUnsuppressToken, unsuppressActionUrl,
  operatorUnsuppressConfigured, UNSUPPRESS_SCOPES,
} from "../api/_lib/operator-unsuppress-token.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? "" : String(process.argv[i + 1] || "").trim();
}

function die(message) {
  console.error(`mint-unsuppress-token: ${message}`);
  process.exit(1);
}

if (!operatorUnsuppressConfigured())
  die("OPERATOR_UNSUPPRESS_SECRET is absent or below the required entropy floor");

const phone = arg("phone");
const scope = arg("scope");
if (!phone) die("--phone is required");
if (!UNSUPPRESS_SCOPES.includes(scope))
  die(`--scope must be one of: ${UNSUPPRESS_SCOPES.join(", ")}`);

const approvalId = mintUnsuppressApprovalId();
let token;
try {
  token = sealUnsuppressToken({ approvalId, phone, scope });
} catch (err) {
  die(err?.token || "the approval could not be sealed");
}

/* stdout is deliberately URL-only so the result can be copied without
   accidentally copying a secret, diagnostic or second capability. */
process.stdout.write(unsuppressActionUrl(token) + "\n");
