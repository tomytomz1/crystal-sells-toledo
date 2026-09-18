/* GET / POST /api/operator-unsuppress — deliberate human-only clearance.
 *
 * This endpoint can lift a durable suppression; it can NEVER grant consent.
 * The database write is append-only and the current HubSpot projection is
 * reset to never_granted only when the durable fold says a channel actually
 * became unblocked. A fresh evidenced consent is required before Gate 8 could
 * ever authorize a future send.
 *
 * Security model:
 *   - separate secret and token family from api/operator-action.js
 *   - token minted off-platform only, for one number + one sealed lane
 *   - GET reads current blocking state and writes nothing
 *   - POST requires token-in-body, literal, attestation, last-four and an
 *     explicit reason; error corrections also require origin + named targets
 *   - POST re-reads active blocks before append; GET state is never trusted
 *   - order: pre-read -> append -> post-read -> best-effort HubSpot projection
 *   - replay/no-op (rowsAffected !== 1) never projects
 *   - no Twilio API call exists here; our lock and Twilio's lock are separate
 */

import {
  buildSuppressionEvent, EVENT_TYPE, SOURCE_OPERATOR, ledgerLogShape,
} from "./_lib/consent-ledger.mjs";
import {
  UNSUPPRESSION_REASON, UNSUPPRESSION_ERROR_ORIGIN,
} from "./_lib/consent.mjs";
import {
  unsealUnsuppressToken, operatorUnsuppressConfigured, matchesUnsuppressLiteral,
  unsuppressTokenLogShape, UnsuppressTokenError, UNSUPPRESS_TOKEN_ERROR,
  UNSUPPRESS_ACTION_PATH,
} from "./_lib/operator-unsuppress-token.mjs";
import {
  operatorLedgerConfigured, getActiveBlocks, getSuppressionLanes,
  appendOperatorUnsuppression, operatorLedgerLogShape,
} from "./_lib/operator-ledger.mjs";
import { suppressionFromLedgerRows } from "./_lib/permission.mjs";
import {
  consentStateEnabled, toHubSpotUnsuppressionProperties, suppressionWriteLogShape,
} from "./_lib/hubspot-consent-state.mjs";
import {
  findContactsByPhone, writeUnsuppressionProperties, isConfigured, HUBSPOT_TIMEOUT_MS,
} from "./_lib/hubspot.mjs";
import {
  readFormBody, parseFormParams, bodyErrorReason, bodyStillOutstanding,
} from "./_lib/twilio.mjs";
import { escapeHtml } from "./_lib/mail.mjs";
import { log } from "./_lib/log.mjs";

export const UNSUPPRESS_CONFIRM_LITERAL = "RECORD_UNSUPPRESSION";
export const MIN_ATTESTATION_CHARS = 20;
export const MAX_ATTESTATION_CHARS = 500;
export const MAX_ACTIVE_BLOCKS = 25;
export const MAX_UNSUPPRESS_PROJECTION_CONTACTS = 25;
export const UNSUPPRESS_PROJECTION_BUDGET_MS = 12000;
export const UNSUPPRESS_MIN_WRITE_MS = 500;

const REASONS = Object.freeze(Object.values(UNSUPPRESSION_REASON));
const ERROR_ORIGINS = Object.freeze(Object.values(UNSUPPRESSION_ERROR_ORIGIN));
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
            "base-uri 'none'; frame-ancestors 'none'";

const STYLE = `<style>
  body { font: 16px/1.55 -apple-system, "Segoe UI", Verdana, Arial, sans-serif;
         color:#111; background:#fff; margin:0; padding:24px; }
  main { max-width:46rem; margin:0 auto; }
  h1 { font-size:1.4rem; line-height:1.3; margin:0 0 1rem; }
  h2 { font-size:1.05rem; margin:1.5rem 0 .5rem; }
  .meta { color:#444; font-size:.9rem; }
  .warn,.ok { border:1px solid #b00020; border-radius:6px; padding:.75rem 1rem; margin:1rem 0; }
  .ok { border-color:#1b7a3d; }
  fieldset { border:1px solid #ccc; border-radius:6px; margin:1.25rem 0; padding:1rem; }
  legend { font-weight:700; padding:0 .35rem; }
  label { display:block; margin:.55rem 0; }
  input[type=text], textarea { width:100%; box-sizing:border-box; font:inherit; padding:.55rem; }
  .block { border-left:3px solid #777; background:#f6f6f6; padding:.65rem .85rem; margin:.65rem 0; }
  code { word-break:break-all; font-size:.85rem; }
  button { font:inherit; font-weight:700; padding:.75rem 1.2rem; border:0; border-radius:6px;
           background:#b00020; color:#fff; cursor:pointer; }
</style>`;

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>` +
    `${STYLE}</head><body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body></html>`;
}

function page(req, res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
  if (bodyStillOutstanding(req)) res.setHeader("Connection", "close");
  res.end(html);
}

function notice(req, res, status, title, body) {
  return page(req, res, status, shell(title, `<div class="warn"><p>${body}</p></div>`));
}

function queryParam(req, name) {
  const direct = req?.query && req.query[name];
  if (direct != null && direct !== "")
    return String(Array.isArray(direct) ? direct[0] : direct);
  const raw = String(req?.url || "");
  const q = raw.indexOf("?");
  if (q === -1) return "";
  return String(parseFormParams(raw.slice(q + 1))[name] || "");
}

function lastFour(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-4);
}

function blockView(block) {
  return {
    dedupe_key: block.dedupe_key,
    event_type: block.event_type,
    reason_code: block.reason_code || "",
    source: block.source,
    occurred_at: block.occurred_at,
    recorded_at: block.recorded_at,
  };
}

function activeForScope(blocks, scope) {
  return blocks.filter((b) => b.channel === scope);
}

function laneNames(fold) {
  return ["sms", "ai_voice", "all"].filter((lane) => fold?.lanes?.[lane] === true);
}

function effectiveBlockedText(fold) {
  const blocked = [];
  if (fold?.effective?.sms) blocked.push("SMS");
  if (fold?.effective?.ai_voice) blocked.push("automated voice");
  return blocked.length ? blocked.join(" and ") : "none";
}

function renderBlocks(blocks, { selectable = false } = {}) {
  if (!blocks.length) return `<p class="meta">No active blocking events in this lane.</p>`;
  return blocks.map((b, i) => {
    const choose = selectable
      ? `<label><input type="checkbox" name="target_${i}" value="${escapeHtml(b.dedupe_key)}"> ` +
        `Select this event if it was recorded in error</label>` : "";
    return `<div class="block">${choose}` +
      `<div><strong>${escapeHtml(b.event_type)}</strong> · ${escapeHtml(b.source)}</div>` +
      `<div class="meta">Reason: ${escapeHtml(b.reason_code || "(none)")}</div>` +
      `<div class="meta">Occurred: ${escapeHtml(b.occurred_at)} · Recorded: ${escapeHtml(b.recorded_at)}</div>` +
      `<div class="meta"><code>${escapeHtml(b.dedupe_key)}</code></div></div>`;
  }).join("");
}

function confirmationPage(payload, token, allBlocks) {
  const scopeBlocks = activeForScope(allBlocks, payload.scope);
  if (!scopeBlocks.length) {
    return shell("Nothing to clear", `
      <div class="warn"><p>There is no active <strong>${escapeHtml(payload.scope)}</strong>
      blocking event for this number right now. Nothing can be cleared with this token.</p></div>
      <p class="meta">Mint a new capability only after confirming which durable lane is actually blocked.</p>`);
  }

  return shell("Review an unsuppression", `
    <div class="warn">
      <p><strong>This can remove a durable contact block. It does not grant consent.</strong>
      If a channel becomes unblocked, its HubSpot permission is reset to
      <code>never_granted</code> and fresh consent is required before any future send.</p>
      <p>For SMS, this does <strong>not</strong> clear any separate Twilio carrier or
      Messaging Service opt-out. Twilio reconciliation is a separate future action.</p>
    </div>

    <p class="meta">Sealed lane: <strong>${escapeHtml(payload.scope)}</strong> ·
       approval ${escapeHtml(payload.approvalId)}</p>
    <p>Number: <strong>${escapeHtml(payload.phone)}</strong></p>

    <h2>Active blocking events in the sealed lane</h2>
    ${renderBlocks(scopeBlocks, { selectable: true })}

    <form method="POST" action="${escapeHtml(UNSUPPRESS_ACTION_PATH)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <input type="hidden" name="confirm" value="${escapeHtml(UNSUPPRESS_CONFIRM_LITERAL)}">

      <fieldset>
        <legend>Why is this being cleared?</legend>
        <p class="meta">Choose one. There is no default.</p>
        <label><input type="radio" name="reason" value="consumer_request" required>
          The consumer asked to restore this channel</label>
        <label><input type="radio" name="reason" value="recorded_in_error" required>
          One or more blocking events were recorded in error</label>
      </fieldset>

      <fieldset>
        <legend>Error origin — only for “recorded in error”</legend>
        <p class="meta">Leave all unselected for a consumer request. Otherwise choose one.</p>
        ${ERROR_ORIGINS.map((v) => `<label><input type="radio" name="error_origin" value="${escapeHtml(v)}"> ${escapeHtml(v)}</label>`).join("")}
      </fieldset>

      <fieldset>
        <legend>Operator attestation</legend>
        <p class="meta">Required. State what you observed and when. Do not paste passwords,
        tokens, or unnecessary personal information.</p>
        <textarea name="attestation" rows="4" minlength="${MIN_ATTESTATION_CHARS}"
          maxlength="${MAX_ATTESTATION_CHARS}" required></textarea>
      </fieldset>

      <fieldset>
        <legend>Number check</legend>
        <p class="meta">Re-type the last four digits of the number shown above.</p>
        <input type="text" name="last4" inputmode="numeric" pattern="[0-9]{4}"
          minlength="4" maxlength="4" required>
      </fieldset>

      <p class="meta"><strong>Recorded-in-error only:</strong> select at least one event
      above. A consumer request clears the whole sealed lane and must have no selected targets.</p>
      <button type="submit">Record unsuppression</button>
    </form>`);
}

function resultPage({ payload, appendedNew, before, after, projection }) {
  const beforeText = effectiveBlockedText(before);
  const afterText = effectiveBlockedText(after);
  const durable = appendedNew
    ? "A new unsuppression event was recorded in the durable ledger."
    : "No new unsuppression event was recorded by this submission. This was a replay or the database did not confirm a new row.";
  const crm = projectionSentence(projection);
  return shell(appendedNew ? "Unsuppression recorded" : "No new clearance recorded", `
    <div class="${appendedNew ? "ok" : "warn"}">
      <p><strong>${escapeHtml(durable)}</strong></p>
      <p>Effective durable blocks before: <strong>${escapeHtml(beforeText)}</strong>.<br>
         Effective durable blocks now: <strong>${escapeHtml(afterText)}</strong>.</p>
    </div>
    <p>${escapeHtml(crm)}</p>
    <div class="warn">
      <p><strong>No consent was granted.</strong> Any channel that actually became
      unblocked must receive fresh evidenced consent before future automated contact.</p>
      <p>SMS carrier/Messaging Service opt-out state in Twilio was not changed or verified here.</p>
    </div>
    <p class="meta">Approval ${escapeHtml(payload.approvalId)} · sealed lane ${escapeHtml(payload.scope)}</p>`);
}

function projectionSentence(p) {
  if (!p || p.reason === "not_run") return "The CRM projection was not run.";
  if (p.reason === "not_new") return "The CRM projection was deliberately skipped because no new ledger row was confirmed.";
  if (p.reason === "no_effective_change") return "The durable event was recorded, but no communication channel became unblocked, so no CRM state was cleared.";
  if (p.reason === "consent_state_disabled") return "The CRM projection was not changed because communications-consent state is disabled in this environment.";
  if (p.reason === "hubspot_not_configured") return "The CRM projection was not changed because HubSpot is not configured in this environment.";
  if (p.reason === "no_contacts") return "No HubSpot contact currently holds this number, so there was no CRM projection to update.";
  if (p.reason === "failed") return "The durable record stands, but HubSpot could not be searched. CRM state may remain conservatively blocked.";
  const n = p.contacts || 0;
  const parts = [];
  if (p.written) parts.push(`${p.written} updated`);
  if (p.unchanged) parts.push(`${p.unchanged} already consistent`);
  if (p.failed) parts.push(`${p.failed} failed`);
  if (p.skipped) parts.push(`${p.skipped} not reached before the time limit`);
  return `HubSpot projection for ${n} contact${n === 1 ? "" : "s"}: ${parts.join("; ") || "no changes"}.`;
}

function refuseToken(req, res, err, method) {
  log("operator.unsuppress.token_refused", { method, ...unsuppressTokenLogShape(err) });
  if (err instanceof UnsuppressTokenError && err.token === UNSUPPRESS_TOKEN_ERROR.EXPIRED)
    return notice(req, res, 410, "This approval has expired",
      "Unsuppression approvals expire after 24 hours. Nothing was changed. Mint a new approval after re-checking the request.");
  return notice(req, res, 400, "This approval is not valid",
    "This capability could not be read. Nothing was changed.");
}

export default async function handler(req, res) {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return notice(req, res, 405, "Not allowed", "This endpoint accepts GET and POST only.");
  }

  if (!operatorUnsuppressConfigured() || !operatorLedgerConfigured()) {
    log("operator.unsuppress.not_configured", {
      method,
      token_configured: operatorUnsuppressConfigured(),
      ledger_configured: operatorLedgerConfigured(),
    });
    return notice(req, res, 503, "Not available",
      "Unsuppression is not configured in this deployment. Nothing was changed.");
  }

  return method === "GET" ? handleGet(req, res) : handlePost(req, res);
}

async function handleGet(req, res) {
  const token = queryParam(req, "t");
  let payload;
  try { payload = unsealUnsuppressToken(token); }
  catch (err) { return refuseToken(req, res, err, "get"); }

  let blocks;
  try { blocks = await getActiveBlocks(payload.phone); }
  catch (err) {
    log("operator.unsuppress.lookup_failed", {
      approval_id: payload.approvalId, stage: "get", ...operatorLedgerLogShape(err),
    });
    return notice(req, res, 503, "State unavailable",
      "The durable blocking state could not be read, so no decision can be made. Nothing was changed.");
  }
  if (blocks.length > MAX_ACTIVE_BLOCKS) {
    log("operator.unsuppress.too_many_blocks", {
      approval_id: payload.approvalId, count: blocks.length,
    });
    return notice(req, res, 503, "Manual review required",
      "This number has more active blocking events than this safety workflow will display. Nothing was changed.");
  }

  log("operator.unsuppress.confirmation_rendered", {
    approval_id: payload.approvalId, channel: payload.scope,
    active_blocks: activeForScope(blocks, payload.scope).length,
  });
  return page(req, res, 200, confirmationPage(payload, token, blocks));
}

async function handlePost(req, res) {
  if (queryParam(req, "t")) {
    log("operator.unsuppress.refused", { reason: "token_in_query" });
    return notice(req, res, 400, "Not recorded",
      "The capability was present in the URL of a write request. Nothing was changed. Open the original approval URL again.");
  }

  let params;
  try { params = await readFormBody(req); }
  catch (err) {
    log("operator.unsuppress.refused", { reason: bodyErrorReason(err) });
    return notice(req, res, 400, "Not recorded", "That submission could not be read. Nothing was changed.");
  }

  if (!matchesUnsuppressLiteral(params.confirm, UNSUPPRESS_CONFIRM_LITERAL)) {
    log("operator.unsuppress.refused", { reason: "no_confirmation" });
    return notice(req, res, 400, "Not recorded", "The page confirmation was missing. Nothing was changed.");
  }

  let payload;
  try { payload = unsealUnsuppressToken(params.t); }
  catch (err) { return refuseToken(req, res, err, "post"); }

  const shape = { approval_id: payload.approvalId, channel: payload.scope };
  if (String(params.last4 || "").trim() !== lastFour(payload.phone)) {
    log("operator.unsuppress.refused", { ...shape, reason: "last4_mismatch" });
    return notice(req, res, 400, "Not recorded", "The last four digits did not match. Nothing was changed.");
  }

  const attestation = String(params.attestation || "").trim();
  if (attestation.length < MIN_ATTESTATION_CHARS) {
    log("operator.unsuppress.refused", { ...shape, reason: "attestation_too_short" });
    return notice(req, res, 400, "Not recorded",
      `The attestation must contain at least ${MIN_ATTESTATION_CHARS} characters describing what was observed and when. Nothing was changed.`);
  }
  if (attestation.length > MAX_ATTESTATION_CHARS) {
    log("operator.unsuppress.refused", { ...shape, reason: "attestation_too_long" });
    return notice(req, res, 400, "Not recorded",
      `The attestation exceeds ${MAX_ATTESTATION_CHARS} characters. It was not shortened for you and nothing was changed.`);
  }

  const reason = String(params.reason || "").trim();
  if (!REASONS.includes(reason)) {
    log("operator.unsuppress.refused", { ...shape, reason: "reason_missing_or_unknown" });
    return notice(req, res, 400, "Not recorded", "Choose exactly why this block is being cleared. Nothing was changed.");
  }
  const errorOrigin = String(params.error_origin || "").trim();
  if (reason === UNSUPPRESSION_REASON.RECORDED_IN_ERROR) {
    if (!ERROR_ORIGINS.includes(errorOrigin)) {
      log("operator.unsuppress.refused", { ...shape, reason: "error_origin_missing_or_unknown" });
      return notice(req, res, 400, "Not recorded", "Choose the error origin for a recorded-in-error correction. Nothing was changed.");
    }
  } else if (errorOrigin) {
    log("operator.unsuppress.refused", { ...shape, reason: "error_origin_not_applicable" });
    return notice(req, res, 400, "Not recorded", "Error origin does not apply to a consumer request. Nothing was changed.");
  }

  /* PRE-READ AT POST TIME. The GET may be minutes old and is evidence only
     for the human; the write decision uses this fresh read. */
  let beforeBlocks;
  try { beforeBlocks = await getActiveBlocks(payload.phone); }
  catch (err) {
    log("operator.unsuppress.lookup_failed", { ...shape, stage: "pre", ...operatorLedgerLogShape(err) });
    return notice(req, res, 503, "Not recorded",
      "The durable blocking state could not be re-read, so nothing was changed.");
  }
  if (beforeBlocks.length > MAX_ACTIVE_BLOCKS) {
    log("operator.unsuppress.too_many_blocks", { ...shape, count: beforeBlocks.length });
    return notice(req, res, 503, "Not recorded",
      "Too many active blocking events exist for this safety workflow. Nothing was changed.");
  }

  const scopeBlocks = activeForScope(beforeBlocks, payload.scope);
  if (!scopeBlocks.length) {
    log("operator.unsuppress.refused", { ...shape, reason: "lane_not_active" });
    return notice(req, res, 400, "Nothing to clear",
      "The sealed lane no longer has an active blocking event. Nothing was written. Re-check the current state before minting another approval.");
  }

  const selected = Object.entries(params)
    .filter(([key, value]) => /^target_\d+$/.test(key) && String(value || "").trim())
    .map(([, value]) => String(value).trim());
  if (new Set(selected).size !== selected.length) {
    log("operator.unsuppress.refused", { ...shape, reason: "duplicate_target" });
    return notice(req, res, 400, "Not recorded", "A blocking event was selected more than once. Nothing was changed.");
  }

  const activeKeys = new Set(scopeBlocks.map((b) => b.dedupe_key));
  if (reason === UNSUPPRESSION_REASON.RECORDED_IN_ERROR) {
    if (!selected.length) {
      log("operator.unsuppress.refused", { ...shape, reason: "no_error_target" });
      return notice(req, res, 400, "Not recorded", "Select at least one currently active blocking event that was recorded in error. Nothing was changed.");
    }
    if (selected.some((key) => !activeKeys.has(key))) {
      log("operator.unsuppress.refused", { ...shape, reason: "target_not_active" });
      return notice(req, res, 400, "Not recorded",
        "At least one selected event is no longer active in this lane. Nothing was changed. Reload the approval page and review the current state.");
    }
  } else if (selected.length) {
    log("operator.unsuppress.refused", { ...shape, reason: "targets_not_applicable" });
    return notice(req, res, 400, "Not recorded",
      "A consumer-request lane clearance must not name individual error targets. Nothing was changed.");
  }

  const before = suppressionFromLedgerRows(beforeBlocks);
  const occurredAt = new Date().toISOString();
  const observed = beforeBlocks.map(blockView);
  const targets = scopeBlocks.filter((b) => selected.includes(b.dedupe_key)).map(blockView);

  let event;
  try {
    event = buildSuppressionEvent({
      occurredAt,
      channel: payload.scope,
      eventType: EVENT_TYPE.UNSUPPRESSED,
      phone: payload.phone,
      source: SOURCE_OPERATOR,
      sourceEventId: payload.approvalId,
      reasonCode: reason,
      evidenceText: null,
      metadata: {
        approval_id: payload.approvalId,
        approved_by: "operator",
        entered_via: "operator_unsuppress",
        token_v: payload.v,
        attestation,
        request_channel: payload.scope,
        request_observed_at: occurredAt,
        prior_blocked_lanes: laneNames(before),
        twilio_reconciled: false,
        ...(reason === UNSUPPRESSION_REASON.RECORDED_IN_ERROR
          ? { error_origin: errorOrigin } : {}),
        invalidates: reason === UNSUPPRESSION_REASON.RECORDED_IN_ERROR ? selected : [],
        intent: {
          targets,
          observed_active: observed,
          selected_of_active: `${selected.length} of ${scopeBlocks.length}`,
        },
      },
    });
  } catch (err) {
    log("operator.unsuppress.unrecordable", { ...shape, ...ledgerLogShape(err) });
    return notice(req, res, 400, "Not recorded", "The requested clearance could not be represented safely. Nothing was changed.");
  }

  let appendResult;
  try {
    appendResult = await appendOperatorUnsuppression(event);
  } catch (err) {
    log("operator.unsuppress.ledger_failed", { ...shape, ...operatorLedgerLogShape(err) });
    return notice(req, res, 503, "Not recorded",
      "The durable record could not be written, so nothing was changed. The approval remains usable until it expires.");
  }

  const appendedNew = appendResult?.rowsAffected === 1;
  log(appendedNew ? "operator.unsuppress.ledger_appended" : "operator.unsuppress.ledger_no_new_row", {
    ...shape,
    rows_affected_known: Number.isInteger(appendResult?.rowsAffected),
    new_row: appendedNew,
  });

  /* POST-READ is required even on replay: the result page reports what is
     blocked NOW. It is also the source for every HubSpot clearance decision. */
  let afterRows;
  try { afterRows = await getSuppressionLanes(payload.phone); }
  catch (err) {
    log("operator.unsuppress.lookup_failed", { ...shape, stage: "post", ...operatorLedgerLogShape(err) });
    return notice(req, res, 503, appendedNew ? "Recorded; state readback unavailable" : "State unavailable",
      appendedNew
        ? "The durable unsuppression event was written, but the resulting blocking state could not be read back. No CRM projection was attempted. Do not repeat this approval until the durable state is inspected."
        : "No new row was confirmed and the resulting durable state could not be read. No CRM projection was attempted.");
  }
  const after = suppressionFromLedgerRows(afterRows);

  let projection = { reason: "not_new" };
  if (appendedNew) {
    const effectiveChanged =
      (before.effective.sms && !after.effective.sms) ||
      (before.effective.ai_voice && !after.effective.ai_voice) ||
      (before.lanes.all && !after.lanes.all);
    projection = effectiveChanged
      ? await projectToHubSpot({ phone: payload.phone, before, after, shape })
      : { reason: "no_effective_change" };
  }

  return page(req, res, 200, resultPage({ payload, appendedNew, before, after, projection }));
}

/** Best-effort current-state projection after the durable record is settled. */
async function projectToHubSpot({ phone, before, after, shape }) {
  if (!consentStateEnabled()) {
    log("operator.unsuppress.projection_skipped", { ...shape, reason: "consent_state_disabled" });
    return { reason: "consent_state_disabled" };
  }
  if (!isConfigured()) {
    log("operator.unsuppress.projection_skipped", { ...shape, reason: "hubspot_not_configured" });
    return { reason: "hubspot_not_configured" };
  }

  const deadline = Date.now() + UNSUPPRESS_PROJECTION_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const requestMs = () => Math.min(HUBSPOT_TIMEOUT_MS, remaining());

  try {
    const contacts = await findContactsByPhone(phone, { timeoutMs: requestMs() });
    if (!contacts.length) {
      log("operator.unsuppress.projection_no_contacts", shape);
      return { reason: "no_contacts" };
    }

    let written = 0;
    let unchanged = 0;
    let failed = 0;
    let skipped = 0;
    let attempted = 0;

    for (const contact of contacts) {
      if (!contact.consent || typeof contact.consent !== "object") {
        failed += 1;
        continue;
      }

      let props;
      try {
        props = toHubSpotUnsuppressionProperties({ current: contact.consent, before, after });
      } catch {
        failed += 1;
        continue;
      }

      if (!props || !Object.keys(props).length) {
        unchanged += 1;
        continue;
      }
      if (attempted >= MAX_UNSUPPRESS_PROJECTION_CONTACTS || remaining() < UNSUPPRESS_MIN_WRITE_MS) {
        skipped += 1;
        continue;
      }

      attempted += 1;
      try {
        const result = await writeUnsuppressionProperties(contact.id, props, { timeoutMs: requestMs() });
        if (result.written) {
          written += 1;
          log("operator.unsuppress.projection_written", {
            ...shape, contact_id: contact.id, ...suppressionWriteLogShape(props),
          });
        } else unchanged += 1;
      } catch {
        if (remaining() < UNSUPPRESS_MIN_WRITE_MS) skipped += 1;
        else failed += 1;
      }
    }

    log("operator.unsuppress.projection_done", {
      ...shape, contacts: contacts.length, written, unchanged, failed, skipped,
    });
    return { reason: "written", contacts: contacts.length, written, unchanged, failed, skipped };
  } catch {
    log("operator.unsuppress.projection_failed", { ...shape });
    return { reason: "failed" };
  }
}
