from pathlib import Path
import json


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "api/_lib/consent-ledger.mjs",
    '''export async function appendSuppressionEvents(events, {
  env = process.env, timeoutMs = LEDGER_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(events) || !events.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "events");

  const url = String(env[LEDGER_URL_VAR] || "").trim();
  if (!url) throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, LEDGER_URL_VAR);''',
    '''export async function appendSuppressionEvents(events, {
  env = process.env, timeoutMs = LEDGER_TIMEOUT_MS, urlVar = LEDGER_URL_VAR,
} = {}) {
  if (!Array.isArray(events) || !events.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "events");

  /* The SQL and column contract stay here, in ONE module. A privileged
     operator workflow may choose its own dedicated INSERT-capable role by
     naming that role's environment variable; the website and webhook callers
     omit this option and therefore remain on CONSENT_LEDGER_URL exactly as
     before. The variable NAME is server-owned code, never request input. */
  const credentialVar = String(urlVar || "").trim();
  if (!credentialVar)
    throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, "ledger_url_var");
  const url = String(env[credentialVar] || "").trim();
  if (!url) throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, credentialVar);''')

marker = '''/* ---------------------------------------------------------------------
   SUPPRESSION
   ---------------------------------------------------------------------'''
helper = '''/* ---------------------------------------------------------------------
   DURABLE SUPPRESSION FOLD FOR OPERATOR STATE
   --------------------------------------------------------------------- */
export function suppressionFromLedgerRows(rows) {
  if (!Array.isArray(rows)) throw new Error("SUPPRESSION_ROWS_MALFORMED");
  const lanes = { sms: false, ai_voice: false, all: false };
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("SUPPRESSION_ROWS_MALFORMED");
    const channel = String(row.channel == null ? "" : row.channel).trim();
    if (!Object.prototype.hasOwnProperty.call(lanes, channel))
      throw new Error("SUPPRESSION_ROWS_MALFORMED");
    lanes[channel] = true;
  }
  return Object.freeze({
    lanes: Object.freeze({ ...lanes }),
    effective: Object.freeze({
      sms: lanes.all || lanes.sms,
      ai_voice: lanes.all || lanes.ai_voice,
    }),
  });
}

'''
replace_once("api/_lib/permission.mjs", marker, helper + marker)

hs_marker = '''/**
 * The re-opt-in patch. Records that someone asked to come back and grants
 * NOTHING: no status, no consent timestamp, no version. A START from the
 * handset is stronger evidence than a ticked web box and is still not a
 * grant, because it carries no disclosure to have agreed to.
 */'''
hs_helper = '''/**
 * Project a DURABLE unsuppression into HubSpot current state.
 * Only durable blocked->unblocked transitions are cleared. A clearance
 * never restores an old grant: the permission becomes NEVER_GRANTED and
 * all five consent artefacts are cleared. Re-opt-in context is untouched.
 */
export function toHubSpotUnsuppressionProperties({ current, before, after } = {}) {
  if (!current || typeof current !== "object" || !before || !after)
    throw new ConsentStateError(MALFORMED_RESPONSE, "UNSUPPRESSION_PROJECT");

  const props = {};
  const S = SUPPRESSION_PROPERTIES;
  const clearText = (property, value) => { if (str(value)) props[property] = ""; };

  const globalCleared = before.lanes?.all === true && after.lanes?.all !== true;
  if (globalCleared) {
    const held = current.suppression?.global;
    if (held) props[S.doNotContact] = "false";
    clearText(S.doNotContactAt, held?.at);
    clearText(S.doNotContactReason, held?.reason);
  }

  const clearChannel = (name, map, heldKey, flag, atProp, reasonProp) => {
    if (before.effective?.[name] !== true || after.effective?.[name] === true) return;
    const state = current[name] || {};
    const held = current.suppression?.[heldKey];
    if (held || state.status === SUPPRESSED) props[flag] = "false";
    clearText(atProp, held?.at);
    clearText(reasonProp, held?.reason);
    if (state.status !== NEVER_GRANTED)
      props[map.status] = assertConsentEnum(map.status, NEVER_GRANTED, PERMISSION_STATUS_VALUES);
    clearText(map.at, state.consent_at);
    clearText(map.phone, state.consent_phone);
    clearText(map.source, state.consent_source);
    clearText(map.page, state.consent_page);
    clearText(map.version, state.consent_version);
  };

  clearChannel("sms", SMS_STATE_PROPERTIES, "sms",
    S.smsSuppressed, S.smsSuppressedAt, S.smsSuppressionReason);
  clearChannel("ai_voice", AI_VOICE_STATE_PROPERTIES, "voice",
    S.doNotCall, S.doNotCallAt, S.doNotCallReason);
  return props;
}

'''
replace_once("api/_lib/hubspot-consent-state.mjs", hs_marker, hs_helper + hs_marker)

http_marker = '''export async function writeSuppressionProperties(contactId, props, { timeoutMs } = {}) {
  /* Nothing to write is not a request: an already-suppressed contact
     produces an empty patch and costs no network time and no budget. */
  if (!props || !Object.keys(props).length) return { written: false };
  await updateContact(contactId, props, false, timeoutMs);
  return { written: true };
}
'''
http_new = http_marker + '''
/** Write the already-computed unsuppression current-state projection. */
export async function writeUnsuppressionProperties(contactId, props, { timeoutMs } = {}) {
  if (!props || !Object.keys(props).length) return { written: false };
  await updateContact(contactId, props, false, timeoutMs);
  return { written: true };
}
'''
replace_once("api/_lib/hubspot.mjs", http_marker, http_new)

p = Path("vercel.json")
cfg = json.loads(p.read_text())
cfg.setdefault("functions", {})["api/operator-unsuppress.js"] = {
    "maxDuration": 30,
    "memory": 256,
}
p.write_text(json.dumps(cfg, indent=2) + "\n")

p = Path("package.json")
pkg = json.loads(p.read_text())
pkg["scripts"]["mint:unsuppress"] = "node tools/mint-unsuppress-token.mjs"
p.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n")

env_marker = '''CONSENT_LEDGER_URL=

# Twilio and Retell credentials are deliberately NOT documented here yet.'''
env_insert = '''CONSENT_LEDGER_URL=

# ===========================================================================
# OPERATOR UNSUPPRESSION - BUILT CAPABILITY, INERT UNTIL EXPLICITLY ACTIVATED
# ===========================================================================
# Both values are SERVER-SIDE SECRETS. Leave them blank until explicit
# activation after merge and review.
OPERATOR_UNSUPPRESS_SECRET=
CONSENT_LEDGER_OPERATOR_URL=

# Twilio and Retell credentials are deliberately NOT documented here yet.'''
replace_once(".env.example", env_marker, env_insert)

secret_anchor = '''  "OPERATOR_ACTION_SECRET",
  /* The Turnstile secret key.'''
secret_new = '''  "OPERATOR_ACTION_SECRET",
  "OPERATOR_UNSUPPRESS_SECRET", "CONSENT_LEDGER_OPERATOR_URL",
  /* The Turnstile secret key.'''
replace_once("tools/check.mjs", secret_anchor, secret_new)

report_anchor = '''/* --- report ---------------------------------------------------------- */'''
guards = r'''/* =====================================================================
   OPERATOR UNSUPPRESSION — opposite-risk boundary
   ===================================================================== */
{
  const rel = "api/operator-unsuppress.js";
  const path = join(API, "operator-unsuppress.js");
  const tokenRel = "api/_lib/operator-unsuppress-token.mjs";
  const tokenPath = join(API, "_lib/operator-unsuppress-token.mjs");
  const statePath = join(API, "_lib/hubspot-consent-state.mjs");
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  if (!existsSync(path)) fail(rel, "missing - approved unsuppression workflow is not implemented");
  else {
    const code = strip(readFileSync(path, "utf8"));
    if (!/EVENT_TYPE\.UNSUPPRESSED/.test(code))
      fail(rel, "does not build EVENT_TYPE.UNSUPPRESSED");
    for (const forbidden of ["EVENT_TYPE.SUPPRESSED", "EVENT_TYPE.REVOKED",
                             "EVENT_TYPE.CONSENT_SELECTED", "EVENT_TYPE.CONSENT_NOT_SELECTED"])
      if (code.includes(forbidden))
        fail(rel, `names ${forbidden} - this endpoint may only emit UNSUPPRESSED`);

    const getAt = code.indexOf("async function handleGet");
    const postAt = code.indexOf("async function handlePost");
    if (getAt === -1 || postAt === -1 || postAt <= getAt)
      fail(rel, "GET/POST split is missing or reordered");
    else {
      const getBody = code.slice(getAt, postAt);
      for (const writeName of ["appendOperatorUnsuppression", "writeUnsuppressionProperties"])
        if (getBody.includes(writeName + "("))
          fail(rel, `GET calls ${writeName} - a scanner could change suppression state`);
    }

    const preAt = code.indexOf("beforeBlocks = await getActiveBlocks(");
    const appendAt = code.indexOf("await appendOperatorUnsuppression(");
    const postReadAt = code.indexOf("afterRows = await getSuppressionLanes(");
    const projectAt = code.indexOf("await projectToHubSpot(");
    if (preAt === -1 || appendAt === -1 || postReadAt === -1)
      fail(rel, "required pre-read -> append -> post-read sequence is missing");
    else if (!(preAt < appendAt && appendAt < postReadAt))
      fail(rel, "durable-state ordering is wrong");
    if (!/rowsAffected\s*===\s*1/.test(code))
      fail(rel, "does not require rowsAffected === 1 before a new clearance may project");
    if (projectAt !== -1 && postReadAt !== -1 && projectAt < postReadAt)
      fail(rel, "projects HubSpot before post-append durable readback");

    for (const forbidden of ["messages.create", "TWILIO_AUTH_TOKEN"])
      if (code.includes(forbidden))
        fail(rel, `contains ${forbidden} - Twilio reconciliation is a separate phase`);
  }

  if (!existsSync(tokenPath)) fail(tokenRel, "missing");
  else {
    const token = strip(readFileSync(tokenPath, "utf8"));
    if (!token.includes('"OPERATOR_UNSUPPRESS_SECRET"'))
      fail(tokenRel, "does not use separate OPERATOR_UNSUPPRESS_SECRET");
    if (!/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(token))
      fail(tokenRel, "token TTL is not 24 hours");
    if (!/operator-unsuppress-token/.test(token))
      fail(tokenRel, "HKDF namespace is not distinct");
  }

  const state = strip(readFileSync(statePath, "utf8"));
  const fnAt = state.indexOf("export function toHubSpotUnsuppressionProperties(");
  const nextAt = state.indexOf("export function toHubSpotReoptinProperties(", fnAt);
  if (fnAt === -1 || nextAt === -1)
    fail("api/_lib/hubspot-consent-state.mjs", "unsuppression projection writer is missing");
  else {
    const fn = state.slice(fnAt, nextAt);
    if (/\bGRANTED\b/.test(fn))
      fail("api/_lib/hubspot-consent-state.mjs", "unsuppression projection names GRANTED");
    for (const field of ["map.at", "map.phone", "map.source", "map.page", "map.version"])
      if (!fn.includes(field))
        fail("api/_lib/hubspot-consent-state.mjs", `does not clear ${field}`);
    if (!fn.includes("NEVER_GRANTED"))
      fail("api/_lib/hubspot-consent-state.mjs", "does not reset permission to NEVER_GRANTED");
    if (/REOPTIN_PROPERTIES/.test(fn))
      fail("api/_lib/hubspot-consent-state.mjs", "touches re-opt-in context");
  }
}

'''
replace_once("tools/check.mjs", report_anchor, guards + report_anchor)
