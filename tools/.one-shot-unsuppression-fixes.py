from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    p.write_text(text.replace(old, new, 1))

# Fix the review form: target checkboxes must be inside the POST form or the
# human's explicit recorded-in-error choices never reach the server.
replace_once(
    "api/operator-unsuppress.js",
    '''    <h2>Active blocking events in the sealed lane</h2>
    ${renderBlocks(scopeBlocks, { selectable: true })}

    <form method="POST" action="${escapeHtml(UNSUPPRESS_ACTION_PATH)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <input type="hidden" name="confirm" value="${escapeHtml(UNSUPPRESS_CONFIRM_LITERAL)}">

      <fieldset>''',
    '''    <form method="POST" action="${escapeHtml(UNSUPPRESS_ACTION_PATH)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <input type="hidden" name="confirm" value="${escapeHtml(UNSUPPRESS_CONFIRM_LITERAL)}">

      <h2>Active blocking events in the sealed lane</h2>
      ${renderBlocks(scopeBlocks, { selectable: true })}

      <fieldset>''')

# Permission-resolver assertions need the feature on; the projection itself is
# independent of the feature gate, but canSend*/canPlace* are not.
p = Path("tests/operator-unsuppress-state.test.mjs")
t = p.read_text()
t = t.replace(
    'canSendSms(roundTrip, PHONE).reason, "NO_CONSENT"',
    'canSendSms(roundTrip, PHONE, { env: { COMMUNICATIONS_CONSENT_ENABLED: "true" } }).reason, "NO_CONSENT"')
t = t.replace(
    'canSendSms(roundTrip, PHONE).reason, "SUPPRESSED"',
    'canSendSms(roundTrip, PHONE, { env: { COMMUNICATIONS_CONSENT_ENABLED: "true" } }).reason, "SMS_SUPPRESSED_STOP"')
t = t.replace(
    'canPlaceAutomatedVoiceCall(roundTrip, PHONE).reason, "NO_CONSENT"',
    'canPlaceAutomatedVoiceCall(roundTrip, PHONE, { env: { COMMUNICATIONS_CONSENT_ENABLED: "true" } }).reason, "NO_CONSENT"')
p.write_text(t)

# Exercise both directions of the token-family separation with the actual
# suppression-token opener rather than a synthetic assertion.
p = Path("tests/operator-unsuppress-token.test.mjs")
t = p.read_text()
t = t.replace(
    '''import {
  OPERATOR_SECRET_VAR, sealOperatorToken,
} from "../api/_lib/operator-token.mjs";''',
    '''import {
  OPERATOR_SECRET_VAR, sealOperatorToken, unsealOperatorToken,
} from "../api/_lib/operator-token.mjs";''')
old = '''    assert.throws(() => unsealUnsuppressToken(suppress, { now: NOW }), UnsuppressTokenError);
    assert.throws(() => {
      /* operator-token has its own error type; the assertion here is simply
         that an unsuppression capability cannot be opened as a suppression one. */
      const env = { [OPERATOR_SECRET_VAR]: SUPPRESS_SECRET };
      // dynamic import is unnecessary; the existing module's public opener is
      // exercised in its own suite. A different first byte/payload namespace is
      // sufficient for the reverse-family property here.
      if (unsuppress === suppress || !env[OPERATOR_SECRET_VAR]) return;
      throw new Error("families_separate");
    }, /families_separate/);'''
new = '''    assert.throws(() => unsealUnsuppressToken(suppress, { now: NOW }), UnsuppressTokenError);
    assert.throws(() => unsealOperatorToken(unsuppress, {
      env: { [OPERATOR_SECRET_VAR]: SUPPRESS_SECRET }, now: NOW,
    }));'''
if old not in t:
    raise SystemExit("token reverse-family anchor not found")
t = t.replace(old, new, 1)
p.write_text(t)
