/* =====================================================================
   npm run zoho:verify
   ---------------------------------------------------------------------
   Confirms the Zoho account's real Lead schema BEFORE the first live
   submission, so nothing about picklists has to be assumed.

   Reports:
     - whether credentials work at all
     - the actual Lead_Source values this account holds
     - the actual Lead_Status values this account holds
     - whether the configured ZOHO_LEAD_SOURCE / ZOHO_LEAD_STATUS exist
     - whether Company is mandatory (it is, on a stock account)

   Reads env from the shell. Locally:
     ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... \
       npm run zoho:verify
   ===================================================================== */

import { describeLeadPicklists, isConfigured, COMPANY_BY_FORM } from "../api/_lib/zoho.mjs";

const tick = (ok) => (ok ? "PASS" : "FAIL");

if (!isConfigured()) {
  console.error("\nFAIL  Zoho credentials are not set in this shell.");
  console.error("      Need ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN.");
  console.error("      See README > Make the forms deliver.\n");
  process.exit(1);
}

let fields;
try {
  fields = await describeLeadPicklists();
} catch (err) {
  console.error("\nFAIL  Could not read the Lead schema: " + err.message);
  console.error("      Check the refresh token, the data-centre domains, and that the");
  console.error("      scope includes ZohoCRM.settings.fields.READ or ZohoCRM.modules.ALL.\n");
  process.exit(1);
}

console.log("\nZoho Lead schema for this account\n" + "=".repeat(60));

const wantSource = process.env.ZOHO_LEAD_SOURCE || "Website";
const wantStatus = process.env.ZOHO_LEAD_STATUS || "";
let problems = 0;

for (const [field, want] of [["Lead_Source", wantSource], ["Lead_Status", wantStatus]]) {
  const values = fields[field] || [];
  console.log("\n" + field + " - " + values.length + " values available:");
  console.log("  " + (values.join(" | ") || "(none returned)"));

  if (!want) {
    console.log("  ->  not configured; the integration will OMIT this field. Safe.");
    if (field === "Lead_Status") {
      const suggestion = values.find((v) => /not contacted|new/i.test(v));
      if (suggestion)
        console.log('  ->  to set it, add ZOHO_LEAD_STATUS="' + suggestion +
                    '" (closest to "new/uncontacted")');
    }
    continue;
  }

  const ok = values.includes(want);
  if (!ok) problems++;
  console.log("  ->  " + tick(ok) + ' configured value "' + want + '" ' +
              (ok ? "exists in this account." : "IS NOT IN THIS ACCOUNT."));
  if (!ok) {
    console.log("      Either add it in Zoho (Setup > Modules > Leads > Lead " +
                field.split("_")[1] + "),");
    console.log("      or set the env var to one of the values listed above.");
    console.log("      Until then the integration will retry without picklists and the");
    console.log("      lead will still be saved - but it will land unclassified.");
  }
}

console.log("\nCompany (mandatory field)\n" + "-".repeat(60));
const company = fields._company;
console.log("  system_mandatory : " + (company ? company.required : "unknown"));
console.log("  max length       : " + (company ? company.length : "unknown"));
for (const [form, value] of Object.entries(COMPANY_BY_FORM)) {
  const tooLong = company?.length ? value.length > company.length : false;
  if (tooLong) problems++;
  console.log("  " + form.padEnd(15) + '-> "' + value + '"  ' + tick(!tooLong));
}

console.log("\n" + "=".repeat(60));
if (problems) {
  console.log(problems + " problem(s) found. Fix them before the first live submission.\n");
  process.exit(1);
}
console.log("All checks passed. Safe to send a live test lead.\n");
