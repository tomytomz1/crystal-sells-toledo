/* TEMPORARY ONE-SHOT PRODUCTION PROBE — remove immediately after verification.
 *
 * Purpose: prove that the deployed Vercel Production application can execute
 * Gate 8's durable suppression lookup through CONSENT_LEDGER_SENDER_URL.
 *
 * Safety properties:
 * - read-only; imports no outbound sender and cannot send SMS;
 * - accepts no phone/email input;
 * - queries one NANP fictional-use number only (+1 202-555-0199);
 * - returns no suppression data and logs only structural, PII-free facts;
 * - intended to exist for one verification deployment only.
 */
import {
  lookupDurableSuppression,
  suppressionLookupLogShape,
} from "./_lib/send-permission.mjs";

const FIXED_PROBE_PHONE = "+12025550199";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const result = await lookupDurableSuppression(FIXED_PROBE_PHONE);
    console.log(JSON.stringify({
      event: "gate8.sender_role.probe_ok",
      status: result?.status === "ok" ? "ok" : "unexpected",
      channel_count: Array.isArray(result?.channels) ? result.channels.length : null,
    }));
    return res.status(204).end();
  } catch (err) {
    console.error(JSON.stringify({
      event: "gate8.sender_role.probe_failed",
      ...suppressionLookupLogShape(err),
    }));
    return res.status(503).json({ error: "sender_role_probe_failed" });
  }
}
