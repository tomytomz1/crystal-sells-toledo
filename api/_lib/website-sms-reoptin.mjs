/* Automatic website SMS re-opt-in orchestrator.
   =====================================================================
   A fresh website checkbox is sufficient evidence for a new SMS opt-in only
   because the disclosure is explicit, optional, server-versioned and stored
   durably before this function runs. A previous STOP still wins until the
   provider and our durable ledger have both been reconciled.

   Order for a previously stopped number:
     1. Read durable readiness from db/004.
     2. Require active SMS block, no global block, and fresh website consent.
     3. Ask Twilio Consent Management API to process BOTH provider opt-ins.
     4. Re-validate inside db/005 and append an `unsuppressed` row.
     5. Re-read Gate 8's durable suppression fold.
     6. Only if the lane is actually clear, project the fresh grant to HubSpot.

   No SMS is sent here. The caller invokes the existing sender afterwards,
   which performs Gate 8 again immediately before Twilio message creation.
   ===================================================================== */

import {
  reoptinActive,
  lookupReoptinReadiness,
  evaluateReoptin,
  REOPTIN_DECISION,
  reoptinLogShape,
} from "./reoptin.mjs";
import { CHANNEL } from "./consent-ledger.mjs";
import {
  upsertWebsiteSmsReoptin,
  TWILIO_CONSENT_STATUS,
  twilioConsentLogShape,
} from "./twilio-consent.mjs";
import {
  completeWebsiteSmsReoptin,
  websiteReoptinStoreLogShape,
} from "./website-reoptin-store.mjs";
import {
  lookupDurableSuppression,
  suppressionLookupLogShape,
} from "./send-permission.mjs";
import {
  findContactByEmail,
  writeUnsuppressionProperties,
} from "./hubspot.mjs";
import { toHubSpotReoptinGrantProperties } from "./hubspot-consent-state.mjs";

export const WEBSITE_REOPTIN_STATUS = Object.freeze({
  NOT_NEEDED: "not_needed",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const WEBSITE_REOPTIN_REASON = Object.freeze({
  MALFORMED_CALL: "WEBSITE_REOPTIN_MALFORMED_CALL",
  INACTIVE: "WEBSITE_REOPTIN_INACTIVE",
  NOT_BLOCKED: "WEBSITE_REOPTIN_NOT_BLOCKED",
  GLOBAL_BLOCK: "WEBSITE_REOPTIN_GLOBAL_BLOCK",
  NO_FRESH_CONSENT: "WEBSITE_REOPTIN_NO_FRESH_CONSENT",
  READINESS_FAILED: "WEBSITE_REOPTIN_READINESS_FAILED",
  PROVIDER_FAILED: "WEBSITE_REOPTIN_PROVIDER_FAILED",
  STORE_FAILED: "WEBSITE_REOPTIN_STORE_FAILED",
  STILL_BLOCKED: "WEBSITE_REOPTIN_STILL_BLOCKED",
  PROJECTION_FAILED: "WEBSITE_REOPTIN_PROJECTION_FAILED",
});

const result = (status, reason, extra = {}) => Object.freeze({ status, reason, ...extra });

function grantConsent(readiness) {
  if (!readiness?.consent) return null;
  return {
    phone: readiness.phone,
    occurredAt: readiness.consent.occurredAt,
    version: readiness.consent.version,
    formType: readiness.consent.formType,
    pagePath: readiness.consent.pagePath,
  };
}

async function projectGrant({ email, readiness }, { contactLookup, contactWrite }) {
  const consent = grantConsent(readiness);
  if (!consent) return false;
  const found = await contactLookup(email);
  if (!found?.id) return false;
  const props = toHubSpotReoptinGrantProperties({ channel: CHANNEL.SMS, consent });
  if (!props || !Object.keys(props).length) return false;
  const written = await contactWrite(found.id, props);
  return written?.written === true;
}

function makeOrchestrator(deps) {
  return async function reconcileWebsiteSmsReoptin({ email, phone } = {}, {
    env = process.env,
  } = {}) {
    if (!env || typeof env !== "object" || Array.isArray(env) ||
        !String(email || "").trim() || !String(phone || "").trim())
      return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.MALFORMED_CALL);

    /* Feature off or the db/004 credential absent means the old Gate 8 path
       remains authoritative. Do not invent a new failure for ordinary leads. */
    if (!reoptinActive(env))
      return result(WEBSITE_REOPTIN_STATUS.SKIPPED, WEBSITE_REOPTIN_REASON.INACTIVE);

    let readiness;
    try {
      readiness = await deps.readinessLookup(phone, { channel: CHANNEL.SMS, env });
    } catch (err) {
      return result(
        WEBSITE_REOPTIN_STATUS.FAILED,
        WEBSITE_REOPTIN_REASON.READINESS_FAILED,
        { diagnostics: reoptinLogShape(err) });
    }

    const verdict = evaluateReoptin({ channel: CHANNEL.SMS, readiness });

    if (!verdict.eligible) {
      if (verdict.reason === REOPTIN_DECISION.GLOBAL_BLOCK)
        return result(WEBSITE_REOPTIN_STATUS.BLOCKED, WEBSITE_REOPTIN_REASON.GLOBAL_BLOCK);
      if (verdict.reason === REOPTIN_DECISION.NO_FRESH_CONSENT)
        return result(WEBSITE_REOPTIN_STATUS.BLOCKED, WEBSITE_REOPTIN_REASON.NO_FRESH_CONSENT);

      if (verdict.reason === REOPTIN_DECISION.NOT_BLOCKED) {
        /* A previous provider+ledger completion may have succeeded while its
           HubSpot projection failed. If a fresh website consent is still
           available, repair that mutable projection before the sender asks
           Gate 8. A concurrent new STOP is still safe: Gate 8 re-reads Neon
           after this write and denies. */
        if (readiness?.consent) {
          try {
            const repaired = await projectGrant(
              { email: String(email).trim(), readiness },
              { contactLookup: deps.contactLookup, contactWrite: deps.contactWrite });
            if (!repaired)
              return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.PROJECTION_FAILED);
            return result(WEBSITE_REOPTIN_STATUS.COMPLETED, WEBSITE_REOPTIN_REASON.NOT_BLOCKED, {
              projected: true,
            });
          } catch {
            return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.PROJECTION_FAILED);
          }
        }
        return result(WEBSITE_REOPTIN_STATUS.NOT_NEEDED, WEBSITE_REOPTIN_REASON.NOT_BLOCKED);
      }

      return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.READINESS_FAILED);
    }

    let provider;
    try {
      provider = await deps.providerUpsert({
        phone: readiness.phone,
        consentAt: readiness.consent.occurredAt,
      }, { env });
    } catch {
      return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.PROVIDER_FAILED);
    }
    if (provider?.status !== TWILIO_CONSENT_STATUS.CONFIRMED)
      return result(
        WEBSITE_REOPTIN_STATUS.FAILED,
        WEBSITE_REOPTIN_REASON.PROVIDER_FAILED,
        { diagnostics: twilioConsentLogShape(provider) });

    try {
      await deps.storeComplete({
        phone: readiness.phone,
        consent: readiness.consent,
        provider,
      }, { env });
    } catch (err) {
      return result(
        WEBSITE_REOPTIN_STATUS.FAILED,
        WEBSITE_REOPTIN_REASON.STORE_FAILED,
        { diagnostics: websiteReoptinStoreLogShape(err) });
    }

    /* The completion insert can legitimately report a replay, and a STOP can
       race after it. Never infer current state from rowsAffected. Read the
       same durable fold Gate 8 uses and require the lane to be clear NOW. */
    let durable;
    try {
      durable = await deps.durableLookup(readiness.phone, { env });
    } catch (err) {
      return result(
        WEBSITE_REOPTIN_STATUS.FAILED,
        WEBSITE_REOPTIN_REASON.STILL_BLOCKED,
        { diagnostics: suppressionLookupLogShape(err) });
    }
    const channels = Array.isArray(durable?.channels) ? durable.channels : [];
    if (durable?.status !== "ok" || channels.includes(CHANNEL.SMS) || channels.includes(CHANNEL.ALL))
      return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.STILL_BLOCKED);

    try {
      const projected = await projectGrant(
        { email: String(email).trim(), readiness },
        { contactLookup: deps.contactLookup, contactWrite: deps.contactWrite });
      if (!projected)
        return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.PROJECTION_FAILED);
    } catch {
      return result(WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_REASON.PROJECTION_FAILED);
    }

    return result(WEBSITE_REOPTIN_STATUS.COMPLETED, null, { projected: true });
  };
}

const REAL = Object.freeze({
  readinessLookup: lookupReoptinReadiness,
  providerUpsert: upsertWebsiteSmsReoptin,
  storeComplete: completeWebsiteSmsReoptin,
  durableLookup: lookupDurableSuppression,
  contactLookup: findContactByEmail,
  contactWrite: writeUnsuppressionProperties,
});

export const reconcileWebsiteSmsReoptin = makeOrchestrator(REAL);

/** Test-only independent orchestrator. It cannot alter the production binding. */
export function _websiteSmsReoptinForTest(overrides = {}) {
  return makeOrchestrator({ ...REAL, ...overrides });
}

export function websiteSmsReoptinLogShape(value) {
  const safe = {
    website_reoptin_status: String(value?.status || "unknown"),
    ...(value?.reason ? { website_reoptin_reason: String(value.reason) } : {}),
  };
  if (value?.diagnostics && typeof value.diagnostics === "object")
    Object.assign(safe, value.diagnostics);
  return safe;
}
