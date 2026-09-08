/* Zoho Mail acknowledgement — the SECONDARY half of a lead.
   =====================================================================
   HubSpot is the authoritative lead store. This module sends one short
   personal email from Crystal's real mailbox after a lead has already
   been saved there, so the visitor hears back inside seconds instead of
   wondering whether the form worked.

   Nothing here may ever cost a lead. A missing password, a refused
   connection, a rejected recipient - every one of those is a failure of
   the acknowledgement, never of the submission. api/lead.js awaits this
   inside a try/catch and returns its existing 200 either way.

   NOT api/_lib/zoho.mjs. That file is dormant Zoho CRM rollback code,
   imported by nothing, and has no relationship to this beyond the vendor
   name. The two must not be confused: ZOHO_CLIENT_ID and friends are CRM
   OAuth credentials for a path that is not live; ZOHO_SMTP_* below are
   mailbox credentials for a path that is.
   ===================================================================== */

import { log } from "./log.mjs";

/* The mailbox this is sent from. Zoho rejects a From that is not the
   authenticated user, so this address and ZOHO_SMTP_USER must be the same
   mailbox - isMailConfigured() does not check that, the SMTP server does,
   and a mismatch surfaces as an `envelope` failure in the logs. */
export const FROM_NAME = "Crystal Saylor";
export const FROM_ADDRESS = "crystal@crystalsellstoledo.com";
export const FROM = `${FROM_NAME} <${FROM_ADDRESS}>`;
export const REPLY_TO = FROM_ADDRESS;
export const SUBJECT = "I got your request";

/* Bounded on every axis. A serverless function that hangs on a socket
   burns its whole maxDuration and turns a saved lead into a visitor
   staring at a spinner. Failing fast and logging is strictly better. */
const CONNECTION_TIMEOUT_MS = 5000;
const GREETING_TIMEOUT_MS = 5000;
const SOCKET_TIMEOUT_MS = 8000;

const REQUIRED_ENV = ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"];

/** True only when every SMTP variable is present and non-empty. */
export function isMailConfigured() {
  return REQUIRED_ENV.every((k) => Boolean(process.env[k]));
}

/** Escape for HTML text content and double-quoted attributes alike. */
export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* --- the message ------------------------------------------------------
   Only the first name and the email address are used. The property
   address, phone, timeline, condition, notes, message and every
   attribution value stay out: this is a human acknowledgement, not a
   receipt, and mail is not a place to echo someone's data back at them.
   No tracking pixel, no click wrapping, no UTM parameters, no marketing
   footer - the only links are Crystal's own contact details. */

const SIGNATURE_TEXT = [
  "Crystal Saylor, REALTOR®",
  "Key Realty LTD | Degnan Group",
  "Ohio Real Estate Salesperson | License #2025003655",
  "(419) 245-4655",
  "crystal@crystalsellstoledo.com",
  "https://crystalsellstoledo.com",
  "Perrysburg, Toledo & Northwest Ohio",
].join("\n");

/* Pinned to raw.githubusercontent.com on `main`, so the image the
   recipient loads is whatever main carries. */
export const SIGNATURE_IMAGE =
  "https://raw.githubusercontent.com/tomytomz1/crystal-sells-toledo/main/" +
  "assets/img/Crystal%20Saylor%20Email%20Signature%20Headshot.jpg";

const SIGNATURE_HTML = `<div style="font-family:Verdana, Arial, sans-serif; color:rgb(17, 17, 17); max-width:480px; width:100%">
    <div style="display:inline-block; vertical-align:top; width:110px; max-width:110px; margin:0 14px 10px 0">
        <img
            src="${SIGNATURE_IMAGE}"
            width="110"
            alt="Crystal Saylor"
            style="display:block; width:100%; max-width:110px; height:auto; border:0; outline:none; text-decoration:none"
        >
    </div>
    <div style="display:inline-block; vertical-align:top; width:100%; max-width:335px">
        <div style="font-size:14px; line-height:18px; font-weight:700; margin:0">
            Crystal Saylor, REALTOR&reg;
        </div>
        <div style="font-size:14px; line-height:18px; font-weight:700; margin:0 0 2px 0">
            Key Realty LTD | Degnan Group
        </div>
        <div style="font-size:12px; line-height:17px; margin:0 0 4px 0">
            Ohio Real Estate Salesperson | License #2025003655
        </div>
        <div style="font-size:12px; line-height:17px; margin:0">
            &#9742;
            <a href="tel:+14192454655" style="color:rgb(17, 85, 204); text-decoration:underline">
                (419) 245-4655
            </a>
        </div>
        <div style="font-size:12px; line-height:17px; margin:0">
            &#9993;
            <a href="mailto:crystal@crystalsellstoledo.com" style="color:rgb(17, 85, 204); text-decoration:underline">
                crystal@crystalsellstoledo.com
            </a>
        </div>
        <div style="font-size:12px; line-height:17px; margin:0">
            &#127760;
            <a href="https://crystalsellstoledo.com" style="color:rgb(17, 85, 204); text-decoration:underline">
                crystalsellstoledo.com
            </a>
        </div>
        <div style="font-size:12px; line-height:17px; margin:0">
            &#128205; Perrysburg, Toledo &amp; Northwest Ohio
        </div>
    </div>
</div>`;

/**
 * Build the acknowledgement for one validated lead.
 * Takes ONLY the fields it is allowed to use, so a future caller cannot
 * accidentally widen it by passing the whole payload.
 */
export function buildAcknowledgement({ first_name, email }) {
  const name = String(first_name || "").trim();
  const safeName = escapeHtml(name);

  const text =
    `Hi ${name},\n\n` +
    "I got your request through Crystal Sells Toledo. I'm going to look it over " +
    "personally and I'll get back to you.\n\n" +
    "If there's anything else I should know, just reply to this email.\n\n" +
    "Crystal\n\n" +
    SIGNATURE_TEXT + "\n";

  const html = `<div style="font-family:Verdana, Arial, sans-serif; color:#111111; font-size:14px; line-height:21px;">
    <p>Hi ${safeName},</p>

    <p>I got your request through Crystal Sells Toledo. I'm going to look it over personally and I'll get back to you.</p>

    <p>If there's anything else I should know, just reply to this email.</p>

    <p>Crystal</p>
</div>

<div style="height:12px;"></div>

${SIGNATURE_HTML}`;

  return { from: FROM, to: email, replyTo: REPLY_TO, subject: SUBJECT, text, html };
}

/* --- error classification --------------------------------------------
   Nodemailer errors carry the recipient address, the envelope and the raw
   server response in `message` and `response`. None of that may reach a
   log line, so callers get a stable token and nothing else. logError()
   emits err.message, which is exactly why the caller must use log() with
   one of these instead. */
export function classifyMailError(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  const status = err && Number.isInteger(err.responseCode) ? err.responseCode : 0;

  if (code === "EAUTH" || status === 535 || status === 534) return "auth";
  if (code === "EENVELOPE" || status === 550 || status === 553) return "envelope";
  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION" ||
      code === "EDNS" || code === "ECONNREFUSED" || code === "ECONNRESET") return "connection";
  if (code === "EMESSAGE") return "message";
  if (status >= 400) return "smtp_" + status;
  return "unknown";
}

/* --- transport --------------------------------------------------------
   Created per invocation. A serverless container may be frozen between
   requests, so a pooled connection held across them is a socket that is
   probably already dead. */
async function createNodemailerTransport() {
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.ZOHO_SMTP_PORT);
  return nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST,
    port,
    secure: port === 465,          // implicit TLS on 465, STARTTLS otherwise
    auth: {
      user: process.env.ZOHO_SMTP_USER,
      pass: process.env.ZOHO_SMTP_PASSWORD,
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

/* The injection seam. Tests replace this with a fake that records what it
   was asked to send; nothing in the automated suite opens a socket to
   Zoho or reads an SMTP credential. */
let transportFactory = createNodemailerTransport;

/** Replace the transport factory. Pass nothing to restore the real one. */
export function setTransportFactory(factory) {
  transportFactory = factory || createNodemailerTransport;
}

/**
 * Send the acknowledgement. Call ONLY after HubSpot has confirmed the lead.
 *
 * Returns { sent: true } on success and { sent: false, reason } when there
 * is nothing to attempt. Throws only when a configured transport actually
 * failed - the caller catches that, classifies it and carries on.
 */
export async function sendAcknowledgement({ first_name, email }, { submission_id } = {}) {
  if (!isMailConfigured()) return { sent: false, reason: "not_configured" };
  if (!email) return { sent: false, reason: "no_recipient" };

  const message = buildAcknowledgement({ first_name, email });
  const transport = await transportFactory();
  const started = Date.now();
  await transport.sendMail(message);
  /* Deliberately no messageId, no recipient, no SMTP response. */
  log("mail.ack.accepted", { submission_id, ms: Date.now() - started });
  return { sent: true };
}
