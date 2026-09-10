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

   A SECOND MESSAGE NOW SHARES THIS TRANSPORT
   ------------------------------------------
   The OPERATOR NOTIFICATION for an unclassified inbound SMS — the bottom
   half of this file. It is the opposite of the acknowledgement in every
   way that matters: it goes TO the operator rather than to a visitor, it
   carries a consumer's number and words rather than deliberately omitting
   them, and its failure is NOT survivable — api/twilio-inbound.js answers
   503 when it cannot be sent, because an opt-out nobody saw is the failure
   this whole path exists to prevent.

   They share the transport, the timeouts and the error classifier, and
   nothing else. See
   docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md §4.
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

/* =====================================================================
   THE OPERATOR NOTIFICATION — an unclassified inbound SMS
   =====================================================================
   `api/twilio-inbound.js` classified a message as neither an opt-out, a
   re-opt-in nor a HELP request. It could be an ordinary lead reply — or
   an opt-out worded in a way the deterministic classifier does not match
   and Twilio does not block. AT ARRIVAL THE SYSTEM CANNOT TELL, so a
   human is the classifier of last resort and this email is how she
   becomes one.

   WHAT IS DELIBERATE HERE, AND WHY
   --------------------------------
   * THE SUBJECT CARRIES THE LAST FOUR DIGITS AND NOTHING MORE. A subject
     is rendered on a lock screen, in a notification banner, in an inbox
     list over someone's shoulder, and in every mail server's logs on the
     way. Four digits are enough to tell two conversations apart; the full
     number lives in the body, where it is needed to act.
   * THE FIRST BODY LINE IS FIXED TEXT. Mail clients show the opening of
     the body as the preview line, so a body that began with the
     consumer's words would put them on the lock screen too.
   * THE Message-ID IS DERIVED FROM THE MessageSid, so a redelivery
     carries the same one and many receivers collapse it. BEST-EFFORT AND
     NOTHING MORE: no standard requires a receiver to deduplicate, and
     this does NOT replace webhook idempotency — that is the ledger's
     dedupe key. A duplicate notification is the same message twice; a
     missing one is an opt-out nobody saw.
   * REPLYING REACHES NOBODY, and the email says so. This is sent from
     the operator's own mailbox to the operator's own mailbox; a reply
     would land in her own inbox, not with the consumer.
   * NO TRACKING, NO THIRD-PARTY IMAGE, NO SIGNATURE BLOCK. The
     acknowledgement's signature exists to be seen by a visitor. This is
     an internal notification and loads nothing remote.
   ===================================================================== */

/** Where an unclassified inbound message is surfaced. */
export const OPERATOR_ADDRESS = FROM_ADDRESS;
export const NOTIFICATION_SUBJECT_PREFIX = "Crystal Sells Toledo: inbound message ending ";

/* ONE OVERALL DEADLINE, and it is the point of this constant.
   Twilio's webhook request times out at roughly 15 seconds. The SMTP
   transport above is bounded at 5 s connection + 5 s greeting + 8 s
   socket, which are three INDEPENDENT bounds that do not add up to a
   promise — hitting all three would blow the webhook's budget and turn a
   surfacing failure into a Twilio timeout, which is a different and much
   quieter failure. So the send races a single deadline and anything
   slower is the failure case: 503, loudly.

   The deadline covers the ENTIRE attempt — creating the transport as well
   as sending — because the factory dynamically imports nodemailer and a
   stuck import would otherwise burn the budget before the clock started.

   A send that already started is NOT cancelled — nodemailer has no
   cancellation and the socket may still deliver. That is accepted: the
   outcome it risks is a duplicate email, which is benign, and the
   alternative is a webhook that hangs. A send that has NOT started when
   the deadline passes is never started. */
export const NOTIFICATION_DEADLINE_MS = 8000;
export const NOTIFICATION_TIMED_OUT = "MAIL_NOTIFICATION_TIMEOUT";

/** The last four digits, or `unknown` — never more, and never a throw. */
export function lastFour(phone) {
  const digits = String(phone == null ? "" : phone).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "unknown";
}

/**
 * Build the operator notification for one unclassified inbound message.
 *
 * `body` must ALREADY be capped by the ledger's capEvidence() rule, and
 * `actionUrl` must already be the sealed-token link — this function
 * composes, it does not decide what may be shown or how long it may be.
 */
export function buildInboundNotification({ from, body, messageSid, receivedAt, actionUrl }) {
  const number = String(from || "").trim();
  const message = String(body == null ? "" : body);
  const sid = String(messageSid || "").trim();
  const at = String(receivedAt || "").trim();
  const link = String(actionUrl || "").trim();

  const subject = NOTIFICATION_SUBJECT_PREFIX + lastFour(number);

  /* The fixed opening line. It must stay first, and it must not contain
     anything the consumer wrote. */
  const opener =
    "A text message arrived that the automatic opt-out rules did not recognise. " +
    "It needs a person to read it.";

  const text = [
    opener,
    "",
    `From: ${number}`,
    `Received (server time, UTC): ${at}`,
    `Twilio MessageSid: ${sid}`,
    "",
    "Message:",
    message,
    "",
    "--",
    "IF THIS IS SOMEONE ASKING NOT TO BE CONTACTED, record it here:",
    link,
    "",
    "That link opens a confirmation page. Nothing is recorded until you choose",
    "what to stop and confirm it. A recorded opt-out cannot be undone.",
    "",
    "IF THIS IS AN ORDINARY MESSAGE, just reply from your phone:",
    `  Call: ${number}`,
    `  Text: ${number}`,
    "Nothing is recorded when you do nothing.",
    "",
    "REPLYING TO THIS EMAIL REACHES NOBODY. It was sent by the website to your",
    "own mailbox; a reply arrives back in this inbox and never reaches the sender.",
    "",
  ].join("\n");

  const safeNumber = escapeHtml(number);
  const safeMessage = escapeHtml(message);
  const html = `<div style="font-family:Verdana, Arial, sans-serif; color:#111111; font-size:14px; line-height:21px;">
    <p>${escapeHtml(opener)}</p>

    <p>
        <strong>From:</strong> ${safeNumber}<br>
        <strong>Received (server time, UTC):</strong> ${escapeHtml(at)}<br>
        <strong>Twilio MessageSid:</strong> ${escapeHtml(sid)}
    </p>

    <p style="border-left:3px solid #cccccc; padding-left:12px; white-space:pre-wrap;">${safeMessage}</p>

    <p>
        <strong>If this is someone asking not to be contacted, record it here:</strong><br>
        <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>
    </p>

    <p>
        That link opens a confirmation page. Nothing is recorded until you choose what to
        stop and confirm it. A recorded opt-out cannot be undone.
    </p>

    <p>
        <strong>If this is an ordinary message, just reply from your phone:</strong><br>
        <a href="tel:${escapeHtml(number)}">Call ${safeNumber}</a> &nbsp;|&nbsp;
        <a href="sms:${escapeHtml(number)}">Text ${safeNumber}</a><br>
        Nothing is recorded when you do nothing.
    </p>

    <p style="color:#666666;">
        Replying to this email reaches nobody. It was sent by the website to your own
        mailbox; a reply arrives back in this inbox and never reaches the sender.
    </p>
</div>`;

  return {
    from: FROM,
    to: OPERATOR_ADDRESS,
    subject,
    text,
    html,
    /* Deliberate, benign misuse of a field RFC 5322 wants unique — see
       the block comment above. */
    messageId: `<inbound-${sid}@crystalsellstoledo.com>`,
  };
}

/**
 * Send the operator notification, under ONE overall deadline.
 *
 * Returns `{ sent: true }`, returns `{ sent: false, reason }` when there
 * is nothing to attempt, and THROWS when a configured transport failed or
 * the deadline passed. The caller answers 503 on either — never a silent
 * 200, which is the defect this whole path exists to remove.
 */
export async function sendInboundNotification(message, { deadlineMs = NOTIFICATION_DEADLINE_MS } = {}) {
  if (!isMailConfigured()) return { sent: false, reason: "not_configured" };

  const started = Date.now();

  /* THE TIMER STARTS BEFORE ANYTHING ELSE, AND THAT IS THE FIX.
     This function previously awaited transportFactory() and only then
     began the race, so transport creation was OUTSIDE the deadline. The
     real factory does a dynamic `import("nodemailer")`, which can be slow
     on a cold container and can in principle hang — and a hang there
     would consume the whole webhook budget before the 8-second clock had
     started ticking. A deadline that does not cover the whole attempt is
     not a deadline; it is a deadline on the part that happened to be
     easiest to wrap. */
  let expired = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const err = new Error(NOTIFICATION_TIMED_OUT);
      err.code = "ETIMEDOUT";
      reject(err);
    }, deadlineMs);
    /* DELIBERATELY NOT unref()'d. The whole point of this timer is to be
       the thing that still fires when the SMTP socket has gone quiet, and
       an unref'd timer lets the runtime decide the request is finished
       before the deadline is reached — which would turn a bounded failure
       back into a hang. It is cleared in the `finally` below the moment
       the race settles, so it holds nothing open afterwards. */
  });

  /* One promise for the WHOLE attempt: create the transport, then send. */
  const attempt = (async () => {
    const transport = await transportFactory();
    /* THE DEADLINE HAS ALREADY PASSED — do not start a send now. The
       caller has answered 503 and the request is over; opening an SMTP
       connection at this point would send a notification nobody is
       waiting on, from a function that has already reported failure.
       A send that had ALREADY STARTED cannot be cancelled — nodemailer
       has no cancellation — and may still deliver, which is the
       documented, benign duplicate-email risk. This guard is about the
       send that has not started yet, which is a different thing and is
       simply not started. */
    if (expired) {
      const err = new Error(NOTIFICATION_TIMED_OUT);
      err.code = "ETIMEDOUT";
      throw err;
    }
    return transport.sendMail(message);
  })();

  try {
    /* Promise.race() attaches a reaction to `attempt`, so a rejection
       arriving after the deadline has already won is handled rather than
       becoming an unhandled rejection. */
    await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }

  /* Deliberately no messageId, no recipient, no subject, no SMTP
     response — and above all no number and no body. */
  log("mail.inbound_notification.accepted", { ms: Date.now() - started });
  return { sent: true };
}
