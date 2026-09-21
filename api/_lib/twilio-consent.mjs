/* Twilio Consent Management API boundary for website SMS re-opt-in.
   =====================================================================
   This module does ONE provider-side job: after the application has found a
   fresh, durable website SMS consent that post-dates a STOP, ask Twilio to
   restore that recipient's SMS consent state.

   Twilio documents that a STOP received through a Messaging Service creates
   TWO provider blocks: one at the Messaging Service level and one at the
   specific sender-number level. Re-opt-in is complete only when BOTH opt-in
   records succeed. A partial response is therefore failure, never degraded
   success.

   It sends no SMS. It never touches Neon or HubSpot. It never uses the
   inbound TWILIO_AUTH_TOKEN. A dedicated API key pair is used so the consent
   capability can be enabled, rotated and revoked separately from message
   sending and inbound signature verification.
   ===================================================================== */

import { randomUUID } from "node:crypto";
import { toE164 } from "./consent-ledger.mjs";

export const TWILIO_CONSENT_API_KEY_SID_VAR = "TWILIO_CONSENT_API_KEY_SID";
export const TWILIO_CONSENT_API_KEY_SECRET_VAR = "TWILIO_CONSENT_API_KEY_SECRET";
export const TWILIO_CONSENT_SERVICE_SID_VAR = "TWILIO_CONSENT_MESSAGING_SERVICE_SID";
export const TWILIO_CONSENT_SENDER_VAR = "TWILIO_CONSENT_SENDER_NUMBER";
export const TWILIO_CONSENT_ENDPOINT = "https://accounts.twilio.com/v1/Consents/Bulk";
export const TWILIO_CONSENT_TIMEOUT_MS = 4500;

const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const CORRELATION_ID = /^[0-9a-fA-F]{32}$/;

export const TWILIO_CONSENT_STATUS = Object.freeze({
  CONFIRMED: "confirmed",
  NOT_CONFIRMED: "not_confirmed",
});

export const TWILIO_CONSENT_REASON = Object.freeze({
  MALFORMED_CALL: "TWILIO_CONSENT_MALFORMED_CALL",
  NOT_CONFIGURED: "TWILIO_CONSENT_NOT_CONFIGURED",
  CONFIG_MALFORMED: "TWILIO_CONSENT_CONFIG_MALFORMED",
  INVALID_TARGET: "TWILIO_CONSENT_INVALID_TARGET",
  INVALID_CONSENT_TIME: "TWILIO_CONSENT_INVALID_CONSENT_TIME",
  REQUEST_TIMEOUT: "TWILIO_CONSENT_REQUEST_TIMEOUT",
  REQUEST_FAILED: "TWILIO_CONSENT_REQUEST_FAILED",
  HTTP_REJECTED: "TWILIO_CONSENT_HTTP_REJECTED",
  MALFORMED_RESPONSE: "TWILIO_CONSENT_MALFORMED_RESPONSE",
  PARTIAL_FAILURE: "TWILIO_CONSENT_PARTIAL_FAILURE",
});

function readEnv(env, name) {
  try {
    const value = env?.[name];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function twilioConsentConfig(env = process.env) {
  const keySid = readEnv(env, TWILIO_CONSENT_API_KEY_SID_VAR);
  const keySecret = readEnv(env, TWILIO_CONSENT_API_KEY_SECRET_VAR);
  const serviceSid = readEnv(env, TWILIO_CONSENT_SERVICE_SID_VAR);
  const senderRaw = readEnv(env, TWILIO_CONSENT_SENDER_VAR);

  if (!keySid || !keySecret || !serviceSid || !senderRaw)
    return { ok: false, reason: TWILIO_CONSENT_REASON.NOT_CONFIGURED };

  let senderNumber;
  try {
    senderNumber = toE164(senderRaw);
  } catch {
    return { ok: false, reason: TWILIO_CONSENT_REASON.CONFIG_MALFORMED };
  }

  if (!API_KEY_SID.test(keySid) || !SERVICE_SID.test(serviceSid))
    return { ok: false, reason: TWILIO_CONSENT_REASON.CONFIG_MALFORMED };

  return Object.freeze({ ok: true, keySid, keySecret, serviceSid, senderNumber });
}

function correlationId(uuidFactory) {
  let raw;
  try {
    raw = String(uuidFactory()).replace(/-/g, "");
  } catch {
    return "";
  }
  return CORRELATION_ID.test(raw) ? raw.toLowerCase() : "";
}

function notConfirmed(reason) {
  return Object.freeze({ status: TWILIO_CONSENT_STATUS.NOT_CONFIRMED, reason });
}

function parseInstant(value) {
  const d = new Date(String(value || ""));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function basicAuth(keySid, keySecret) {
  return "Basic " + Buffer.from(`${keySid}:${keySecret}`, "utf8").toString("base64");
}

function makeClient({ fetchImpl, uuidFactory }) {
  return async function upsertWebsiteSmsReoptin({ phone, consentAt } = {}, {
    env = process.env,
    timeoutMs = TWILIO_CONSENT_TIMEOUT_MS,
  } = {}) {
    if (!env || typeof env !== "object" || Array.isArray(env) ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_CALL);

    const config = twilioConsentConfig(env);
    if (!config.ok) return notConfirmed(config.reason);

    let target;
    try {
      target = toE164(phone);
    } catch {
      return notConfirmed(TWILIO_CONSENT_REASON.INVALID_TARGET);
    }

    const consentTime = parseInstant(consentAt);
    if (!consentTime) return notConfirmed(TWILIO_CONSENT_REASON.INVALID_CONSENT_TIME);

    const serviceCorrelation = correlationId(uuidFactory);
    const senderCorrelation = correlationId(uuidFactory);
    if (!serviceCorrelation || !senderCorrelation || serviceCorrelation === senderCorrelation)
      return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_CALL);

    const shared = {
      contact_id: target,
      date_of_consent: consentTime,
      status: "opt-in",
      source: "website",
    };
    const items = [
      {
        ...shared,
        correlation_id: serviceCorrelation,
        sender_id: config.serviceSid,
      },
      {
        ...shared,
        correlation_id: senderCorrelation,
        sender_id: config.senderNumber,
      },
    ];

    const body = new URLSearchParams();
    for (const item of items) body.append("Items", JSON.stringify(item));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.trunc(timeoutMs));
    let response;
    try {
      response = await fetchImpl(TWILIO_CONSENT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: basicAuth(config.keySid, config.keySecret),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: ctrl.signal,
      });
    } catch (err) {
      return notConfirmed(
        err?.name === "AbortError"
          ? TWILIO_CONSENT_REASON.REQUEST_TIMEOUT
          : TWILIO_CONSENT_REASON.REQUEST_FAILED);
    } finally {
      clearTimeout(timer);
    }

    if (!response || response.ok !== true)
      return notConfirmed(TWILIO_CONSENT_REASON.HTTP_REJECTED);

    let json;
    try {
      json = await response.json();
    } catch {
      return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);
    }

    if (!json || typeof json !== "object" || !Array.isArray(json.items))
      return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);

    const expected = new Set([serviceCorrelation, senderCorrelation]);
    const seen = new Set();
    for (const item of json.items) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);
      const id = String(item.correlation_id || "");
      if (!expected.has(id) || seen.has(id))
        return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);
      seen.add(id);
      if (Number(item.error_code) !== 0)
        return notConfirmed(TWILIO_CONSENT_REASON.PARTIAL_FAILURE);
    }
    if (seen.size !== 2)
      return notConfirmed(TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);

    return Object.freeze({
      status: TWILIO_CONSENT_STATUS.CONFIRMED,
      reason: null,
      provider: "twilio_consent_api",
      service_correlation_id: serviceCorrelation,
      sender_correlation_id: senderCorrelation,
      service_sid: config.serviceSid,
    });
  };
}

const CLIENT = makeClient({ fetchImpl: globalThis.fetch, uuidFactory: randomUUID });

export const upsertWebsiteSmsReoptin = CLIENT;

/** Test-only constructor. It returns a separate closed client and never
 * mutates the production binding above. */
export function _twilioConsentClientForTest({ fetchImpl, uuidFactory } = {}) {
  if (typeof fetchImpl !== "function" || typeof uuidFactory !== "function")
    throw new TypeError("test boundaries required");
  return makeClient({ fetchImpl, uuidFactory });
}

export function twilioConsentLogShape(result) {
  return {
    consent_provider_status: String(result?.status || "unknown"),
    ...(result?.reason ? { consent_provider_reason: String(result.reason) } : {}),
  };
}
