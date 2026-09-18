from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    p.write_text(text.replace(old, new, 1))

# A consumer-request row is a lane clearance in db/003. Its occurred_at must
# be bounded BEFORE a later STOP can exist, otherwise a STOP that lands between
# the pre-read and the append could be swept by the same clearance. The sealed
# token's iat is conservative: any block at or after that second survives,
# because db/003 deliberately keeps ties (`>=`).
replace_once(
    "api/operator-unsuppress.js",
    '''  /* PRE-READ AT POST TIME. The GET may be minutes old and is evidence only
     for the human; the write decision uses this fresh read. */
  let beforeBlocks;''',
    '''  /* PRE-READ AT POST TIME. The GET may be minutes old and is evidence only
     for the human; the write decision uses this fresh read.

     RACE BOUNDARY: a consumer_request is a lane clearance in db/003. If its
     occurred_at were "now" AFTER this read, a new STOP that landed between
     the read and the append could carry an earlier timestamp and be swept by
     the clearance. The sealed capability's iat is the conservative cutoff:
     any block at or after token issuance survives, and db/003 keeps exact
     timestamp ties in the blocked direction. */
  const clearanceCutoff = new Date(payload.issuedAt * 1000).toISOString();
  let beforeBlocks;''')

replace_once(
    "api/operator-unsuppress.js",
    '''  const before = suppressionFromLedgerRows(beforeBlocks);
  const occurredAt = new Date().toISOString();
  const observed = beforeBlocks.map(blockView);''',
    '''  const before = suppressionFromLedgerRows(beforeBlocks);
  const occurredAt = clearanceCutoff;
  const observed = beforeBlocks.map(blockView);''')

replace_once(
    "api/operator-unsuppress.js",
    '''        request_channel: payload.scope,
        request_observed_at: occurredAt,
        prior_blocked_lanes: laneNames(before),''',
    '''        request_channel: payload.scope,
        /* Conservative event-time boundary, NOT a claim that this is the
           consumer's exact request timestamp. The attestation carries the
           human's statement of what was observed and when. */
        request_observed_at: clearanceCutoff,
        capability_issued_at: clearanceCutoff,
        prior_blocked_lanes: laneNames(before),''')

# Pin the race boundary in the build guard: the cutoff must derive from the
# sealed token and be established before the POST-time active-block read.
p = Path("tools/check.mjs")
t = p.read_text()
old = '''    const preAt = code.indexOf("beforeBlocks = await getActiveBlocks(");
    const appendAt = code.indexOf("await appendOperatorUnsuppression(");
    const postReadAt = code.indexOf("afterRows = await getSuppressionLanes(");'''
new = '''    const cutoffAt = code.indexOf("clearanceCutoff = new Date(payload.issuedAt * 1000)");
    const preAt = code.indexOf("beforeBlocks = await getActiveBlocks(");
    const appendAt = code.indexOf("await appendOperatorUnsuppression(");
    const postReadAt = code.indexOf("afterRows = await getSuppressionLanes(");'''
if old not in t:
    raise SystemExit("check guard order anchor not found")
t = t.replace(old, new, 1)
old = '''    if (preAt === -1 || appendAt === -1 || postReadAt === -1)
      fail(rel, "required pre-read -> append -> post-read sequence is missing");
    else if (!(preAt < appendAt && appendAt < postReadAt))
      fail(rel, "durable-state ordering is wrong");'''
new = '''    if (cutoffAt === -1 || preAt === -1 || appendAt === -1 || postReadAt === -1)
      fail(rel, "required cutoff -> pre-read -> append -> post-read sequence is missing");
    else if (!(cutoffAt < preAt && preAt < appendAt && appendAt < postReadAt))
      fail(rel, "durable-state ordering is wrong");
    if (!code.includes("const occurredAt = clearanceCutoff"))
      fail(rel, "lane-clearance event time is not pinned to the pre-existing capability cutoff");'''
if old not in t:
    raise SystemExit("check guard condition anchor not found")
p.write_text(t.replace(old, new, 1))

# Add a targeted assertion that the durable event timestamp is the sealed
# capability boundary rather than an append-time timestamp.
p = Path("tests/operator-unsuppress-endpoint.test.mjs")
t = p.read_text()
anchor = '''    assert.equal(m.approval_id, AID);
    assert.equal(m.approved_by, "operator");'''
replacement = '''    assert.equal(m.approval_id, AID);
    assert.equal(m.approved_by, "operator");
    assert.equal(m.request_observed_at, m.capability_issued_at);
    assert.match(m.capability_issued_at, /^\\d{4}-\\d{2}-\\d{2}T/);'''
if anchor not in t:
    raise SystemExit("endpoint metadata test anchor not found")
p.write_text(t.replace(anchor, replacement, 1))
