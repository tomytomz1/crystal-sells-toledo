/* Gate 9 — automatic acknowledgement for a freshly consented seller lead.
   =====================================================================
   This is the ONE production module allowed to import the outbound SMS
   transport. It is not an endpoint and exposes no generic send surface.

   Eligibility is about THIS submission, not merely the contact's historic
   HubSpot state. The current /home-value submission must carry a fresh SMS
   grant whose server-built evidence was acknowledged by the durable ledger.
   Only then is the existing sender invoked. The sender still performs Gate 8
   immediately before Twilio, so an intervening STOP, suppression, revoked
   permission, phone mismatch or dependency failure still denies the send.

   The acknowledgement is a courtesy after HubSpot has already captured the
   lead. The production acknowledgement function therefore never rejects:
   malformed input, ineligibility and an unexpected sender exception all become
   a PII-free NOT_SENT result.

   The SMS body is fixed. No browser-supplied field is interpolated into it;
   doing so would turn this otherwise narrow acknowledgement path into a
   user-controlled SMS-content relay.
   ===================================================================== */

import { sendSms, SMS_STATUS, smsSendLogShape } from "./sms-sender.mjs";

export const LEAD_SMS_ACK_REASON = Object.freeze({
  MALFORMED_PAYLOAD: "SMS_ACK_MALFORMED_PAYLOAD",
  FORM_NOT_ELIGIBLE: "SMS_ACK_FORM_NOT_ELIGIBLE",
  NO_FRESH_CONSENT: "SMS_ACK_NO_FRESH_CONSENT",
  CONSENT_NOT_DURABLE: "SMS_ACK_CONSENT_NOT_DURABLE",
  EVIDENCE_MISMATCH: "SMS_ACK_EVIDENCE_MISMATCH",
  UNEXPECTED_FAILURE: "SMS_ACK_UNEXPECTED_FAILURE",
});

const notSent = (reason) => ({ status: SMS_STATUS.NOT_SENT, reason });

/**
 * Fixed, use-case-aligned variant of the first message sample submitted with
 * the approved A2P campaign. The campaign sample used a property placeholder,
 * but the website address field is still visitor-controlled text. Keeping the
 * body fixed prevents the lead form from becoming an arbitrary SMS relay.
 */
const LEAD_SMS_ACK_BODY =
  "Crystal Sells Toledo: Thanks for your real estate inquiry about your property. " +
  "I'll follow up with the information you requested and help with the next step. " +
  "Reply STOP to opt out.";

export function buildLeadSmsAcknowledgement() {
  return LEAD_SMS_ACK_BODY;
}

function makeLeadSmsAcknowledgement(sender) {
  return async function sendLeadSmsAcknowledgement(payload, options) {
    try {
      /* Keep argument handling inside the try. A signature such as
         `(payload, { env = process.env } = {})` still throws on `null` before
         this body runs, which would contradict this boundary's never-rejects
         contract. Malformed options fail shut and never reach the sender. */
      let env;
      if (options === undefined) {
        env = process.env;
      } else if (options === null || typeof options !== "object" || Array.isArray(options)) {
        return notSent(LEAD_SMS_ACK_REASON.MALFORMED_PAYLOAD);
      } else if (options.env === undefined) {
        env = process.env;
      } else if (options.env === null || typeof options.env !== "object" || Array.isArray(options.env)) {
        return notSent(LEAD_SMS_ACK_REASON.MALFORMED_PAYLOAD);
      } else {
        env = options.env;
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          !payload.lead || typeof payload.lead !== "object" ||
          !payload.meta || typeof payload.meta !== "object")
        return notSent(LEAD_SMS_ACK_REASON.MALFORMED_PAYLOAD);

      const { lead, meta, consent } = payload;
      if (lead.form_type !== "home_value")
        return notSent(LEAD_SMS_ACK_REASON.FORM_NOT_ELIGIBLE);

      /* Fresh means THIS request granted SMS. An older HubSpot grant is not
         enough to make an unticked current submission generate a new text. */
      if (lead.sms_consent !== true || consent?.sms?.granted !== true)
        return notSent(LEAD_SMS_ACK_REASON.NO_FRESH_CONSENT);

      /* A grant is not sendable until this process received confirmation that
         its evidence reached the append-only ledger. */
      if (consent.durable !== true)
        return notSent(LEAD_SMS_ACK_REASON.CONSENT_NOT_DURABLE);

      /* Bind the evidence to this exact validated submission before handing
         anything to Gate 8. These values are server-owned when the payload is
         built by api/lead.js; a mismatch is a programming error and fails shut.
         property_address is required here only as a completeness invariant; it
         is deliberately never inserted into the outbound message body. */
      if (!meta.submission_id || consent.submission_id !== meta.submission_id ||
          consent.form_type !== lead.form_type || consent.sms.phone !== lead.phone ||
          !lead.email || !lead.phone || !lead.property_address)
        return notSent(LEAD_SMS_ACK_REASON.EVIDENCE_MISMATCH);

      const body = buildLeadSmsAcknowledgement();
      return await sender({ email: lead.email, phone: lead.phone, body }, { env });
    } catch {
      /* Never expose a provider/request exception. The lead is already safe in
         HubSpot by the time this function is called. */
      return notSent(LEAD_SMS_ACK_REASON.UNEXPECTED_FAILURE);
    }
  };
}

/** Production path: permanently bound to the real Gate-8-enforcing sender. */
export const sendLeadSmsAcknowledgement = makeLeadSmsAcknowledgement(sendSms);

/** Test only: creates an independent acknowledgement path over a fake sender. */
export function _leadSmsAckForTest({ sender } = {}) {
  return makeLeadSmsAcknowledgement(sender);
}

/** PII-free structure for api/lead.js logs. */
export function leadSmsAckLogShape(result) {
  return smsSendLogShape(result);
}
