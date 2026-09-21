/* Durable completion boundary for automatic website SMS re-opt-in.
   =====================================================================
   db/005 owns the row shape and re-validates readiness inside PostgreSQL.
   This module never names the ledger table and cannot read it. It can call
   only the narrow completion function through CONSENT_LEDGER_REOPTIN_URL.
   ===================================================================== */

import { createHash } from "node:crypto";
import { driverShape } from "./consent-ledger.mjs";
import {
  REOPTIN_LEDGER_URL_VAR,
  REOPTIN_CONSENT_MAX_AGE_SECONDS,
} from "./reoptin.mjs";

export const WEBSITE_REOPTIN_STORE_TIMEOUT_MS = 2500;

export const WEBSITE_REOPTIN_STORE_ERROR = Object.freeze({
  NOT_CONFIGURED: "WEBSITE_REOPTIN_STORE_NOT_CONFIGURED",
  MALFORMED_CALL: "WEBSITE_REOPTIN_STORE_MALFORMED_CALL",
  TIMEOUT: "WEBSITE_REOPTIN_STORE_TIMEOUT",
  FAILED: "WEBSITE_REOPTIN_STORE_FAILED",
  MALFORMED_RESPONSE: "WEBSITE_REOPTIN_STORE_MALFORMED_RESPONSE",
});

export class WebsiteReoptinStoreError extends Error {
  constructor(token, driver = null) {
    super(token);
    this.name = "WebsiteReoptinStoreError";
    this.token = token;
    this.driver = driver;
  }
}

export function websiteReoptinStoreLogShape(err) {
  const driver = err?.driver || driverShape(err);
  return {
    reoptin_store_error: err?.token || WEBSITE_REOPTIN_STORE_ERROR.FAILED,
    ...(driver?.name ? { reoptin_store_driver_error: driver.name } : {}),
    ...(driver?.code ? { reoptin_store_driver_code: driver.code } : {}),
  };
}

export function providerEventId(consentDedupeKey) {
  const key = String(consentDedupeKey || "").trim();
  if (!key) throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_CALL);
  return "consentapi_" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

async function neonExecutor(text, params, { url, signal }) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) return result.rows;
  throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_RESPONSE);
}

function makeStore(executor) {
  return async function completeWebsiteSmsReoptin({ phone, consent, provider } = {}, {
    env = process.env,
    timeoutMs = WEBSITE_REOPTIN_STORE_TIMEOUT_MS,
  } = {}) {
    if (!env || typeof env !== "object" || Array.isArray(env) ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !consent || typeof consent !== "object" ||
        !provider || typeof provider !== "object")
      throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_CALL);

    const url = String(env[REOPTIN_LEDGER_URL_VAR] || "").trim();
    if (!url)
      throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.NOT_CONFIGURED);

    const consentKey = String(consent.dedupeKey || "").trim();
    const eventId = providerEventId(consentKey);
    const metadata = {
      provider: "twilio_consent_api",
      service_correlation_id: String(provider.service_correlation_id || ""),
      sender_correlation_id: String(provider.sender_correlation_id || ""),
      service_sid: String(provider.service_sid || ""),
    };

    if (!metadata.service_correlation_id || !metadata.sender_correlation_id || !metadata.service_sid)
      throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_CALL);

    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.TIMEOUT));
      }, Math.trunc(timeoutMs));
    });

    let result;
    try {
      result = await Promise.race([
        executor(
          "SELECT public.complete_website_sms_reoptin($1,$2,$3,$4::jsonb,$5) AS rows_inserted",
          [
            String(phone || "").trim(),
            consentKey,
            eventId,
            JSON.stringify(metadata),
            REOPTIN_CONSENT_MAX_AGE_SECONDS,
          ],
          { url, signal: ctrl.signal },
        ),
        deadline,
      ]);
    } catch (err) {
      if (err instanceof WebsiteReoptinStoreError) throw err;
      throw new WebsiteReoptinStoreError(
        WEBSITE_REOPTIN_STORE_ERROR.FAILED, driverShape(err));
    } finally {
      clearTimeout(timer);
    }

    const rows = rowsOf(result);
    if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object")
      throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_RESPONSE);

    const raw = rows[0].rows_inserted;
    const count = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(count) || count < 0 || count > 1)
      throw new WebsiteReoptinStoreError(WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_RESPONSE);

    return Object.freeze({ rowsAffected: count, providerEventId: eventId });
  };
}

export const completeWebsiteSmsReoptin = makeStore(neonExecutor);

export function _websiteReoptinStoreForTest(executor) {
  if (typeof executor !== "function") throw new TypeError("executor required");
  return makeStore(executor);
}
