const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFirestore, FieldValue, Timestamp } = require('./fake-firestore.cjs');
const { createTapStore, eventDocId } = require('../server/tap-store.js');

const MAX = 2 * 60 * 60 * 1000;
const TTL = 5 * 60 * 1000;

function setup() {
  let clock = 1_000_000_000_000;
  const now = () => clock;
  const db = createFakeFirestore({ now });
  let n = 0;
  const store = createTapStore({
    db, FieldValue, Timestamp, sessionMaxMs: MAX, redeemTtlMs: TTL,
    makeCode: () => `C${String(++n).padStart(7, '0')}`, now,
  });
  const advance = (ms) => { clock += ms; };
  const sessionDocs = () => [...db._docs.keys()].filter((k) => k.startsWith('tap_sessions/'));
  const build = (code) => ({
    uid: 'sql_P000014', eventId: 'evt-1', stationId: '2', deliverTo: 'kiosk', coupled: true,
    code, createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now() + TTL), used: false,
  });
  return { db, store, now, advance, sessionDocs, build };
}

const attempt = (c) => c.repeat(32);

test('concurrent deliveries of one event create exactly one session', async () => {
  const { store, sessionDocs, build } = setup();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => store.createBridgeEvent('evt-1', build))
  );
  assert.equal(results.filter((r) => r.kind === 'created').length, 1);
  assert.equal(results.filter((r) => r.kind === 'existing').length, 5);
  assert.equal(new Set(results.map((r) => r.ref.id)).size, 1);
  assert.equal(sessionDocs().length, 1);
});

test('a session created before the index existed is found, not duplicated', async () => {
  const { db, store, build, sessionDocs } = setup();
  await db.collection('tap_sessions').add(build('LEGACY01'));
  const r = await store.createBridgeEvent('evt-1', build);
  assert.equal(r.kind, 'existing');
  assert.equal(r.data.code, 'LEGACY01');
  assert.equal(sessionDocs().length, 1);
  assert.ok(db._docs.has(`bridge_events/${eventDocId('evt-1')}`), 'legacy session indexed');
  assert.equal((await store.findSession({ eventId: 'evt-1' })).data.code, 'LEGACY01');
});

test('Disconnect racing creation never leaves a playable event behind', async () => {
  for (let i = 0; i < 40; i++) {
    const { store, build } = setup();
    const ops = [
      store.createBridgeEvent('evt-1', build),
      store.findOrTombstone('evt-1', 'disconnect_before_create'),
    ];
    if (i % 2) ops.reverse();
    const [a, b] = await Promise.all(ops);
    const created = i % 2 ? b : a;
    const ended = i % 2 ? a : b;
    if (created.kind === 'created') {
      // the end request must have seen the session (and can end it)
      assert.ok(ended && ended.ref.id === created.ref.id, `iteration ${i}`);
    } else {
      assert.equal(created.kind, 'tombstoned', `iteration ${i}`);
      assert.equal(ended, null);
    }
  }
});

test('concurrent re-entry retries agree on one code', async () => {
  const { store, build, advance } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  const first = await store.redeem((await ref.get()).data().code, attempt('a'));
  assert.equal(first.replay, false);
  advance(TTL + 1); // the first code's window is over
  const out = await Promise.all(Array.from({ length: 5 }, () => store.reentryCode(ref)));
  assert.equal(new Set(out.map((o) => o.code)).size, 1);
  assert.equal(out.filter((o) => o.reused === false).length, 1);
  // the deadline is still anchored on the first redemption
  assert.equal(out[0].status.expiresAt, first.redeemedAtMs + MAX - 0);
});

test('redeem rechecks code, end and deadline inside the transaction', async () => {
  const { store, build, advance } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  const code1 = (await ref.get()).data().code;
  assert.equal((await store.redeem(code1, attempt('a'))).replay, false);

  // a re-entry code replaces the old one: the old code no longer works
  advance(TTL + 1);
  const re = await store.reentryCode(ref);
  assert.notEqual(re.code, code1);
  assert.ok((await store.redeem(code1, attempt('a'))).error, 'replaced code refused');
  assert.equal((await store.redeem(re.code, attempt('b'))).replay, false);

  // an ended event cannot be redeemed, even with a fresh code on it
  await ref.update({ code: 'ENDEDXX1', used: false, expiresAt: Timestamp.fromMillis(Date.now() * 2), endedAt: Timestamp.fromMillis(1) });
  assert.match((await store.redeem('ENDEDXX1', attempt('c'))).error, /ended/);
});

test('redeem refuses anything past the original two-hour deadline', async () => {
  const { store, build, advance, now } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  await store.redeem((await ref.get()).data().code, attempt('a'));
  advance(MAX + 1);
  await ref.update({ code: 'LATECODE', used: false, expiresAt: Timestamp.fromMillis(now() + TTL) });
  assert.match((await store.redeem('LATECODE', attempt('b'))).error, /expired/);
});

test('expired and unknown codes are refused', async () => {
  const { store, build, advance } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  const code = (await ref.get()).data().code;
  assert.equal((await store.redeem('NOSUCHCD', attempt('a'))).http, 404);
  advance(TTL + 1);
  assert.match((await store.redeem(code, attempt('a'))).error, /expired/);
});

test('lost response: only the same attempt gets the answer again', async () => {
  const { store, build } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  const code = (await ref.get()).data().code;
  const first = await store.redeem(code, attempt('a'));
  assert.equal(first.replay, false);
  const again = await store.redeem(code, attempt('a'));
  assert.equal(again.replay, true);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.redeemedAtMs, first.redeemedAtMs);
  assert.match((await store.redeem(code, attempt('b'))).error, /already used/);
  assert.match((await store.redeem(code)).error, /already used/);
});

test('two different browsers redeeming one code at once: exactly one wins', async () => {
  const { store, build } = setup();
  const { ref } = await store.createBridgeEvent('evt-1', build);
  const code = (await ref.get()).data().code;
  const out = await Promise.all(['a', 'b', 'c', 'd'].map((c) => store.redeem(code, attempt(c))));
  assert.equal(out.filter((o) => o.replay === false).length, 1);
  assert.equal(out.filter((o) => o.error).length, 3);
});

test('session status keeps its agreed meanings', async () => {
  const { store, now } = setup();
  const ts = Timestamp.fromMillis;
  assert.equal(store.sessionStatus({ expiresAt: ts(now() + 1) }).status, 'pending');
  assert.equal(store.sessionStatus({ expiresAt: ts(now() - 1) }).status, 'expired');
  assert.deepEqual(store.sessionStatus({ redeemedAt: ts(now()), used: false, expiresAt: ts(0) }),
    { status: 'active', expiresAt: now() + MAX });
  assert.equal(store.sessionStatus({ redeemedAt: ts(now() - MAX - 1) }).status, 'expired');
  assert.deepEqual(store.sessionStatus({ endedAt: ts(1), endReason: 'signed_out', redeemedAt: ts(now()) }),
    { status: 'ended', reason: 'signed_out' });
});

test('event ids that are not valid document ids are hashed', () => {
  assert.equal(eventDocId('f902ee63-9afe-49e1-bca6-7ee216d9286a'), 'f902ee63-9afe-49e1-bca6-7ee216d9286a');
  assert.match(eventDocId('a/b'), /^h_[0-9a-f]{64}$/);
  assert.match(eventDocId('..'), /^h_/);
});
