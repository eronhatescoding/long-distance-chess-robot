// Tap-session storage rules that must hold under concurrent requests:
// bridge event creation, re-entry codes, Disconnect tombstones and code
// redemption. Every decision that reads and then writes runs inside one
// Firestore transaction, so two overlapping retries of the same event can
// never create two sessions, mint two different codes, or redeem one code
// twice.
//
// Kept free of HTTP and WebSocket code so tests can run it against an
// in-memory Firestore (tests/tap-store.test.cjs).
'use strict';

const crypto = require('crypto');

// Firestore document ids may not contain "/" and may not be "." or "..".
// NexusBoard event ids are UUIDs, which pass through unchanged (and match the
// ids already used for ended_events tombstones).
function eventDocId(eventId) {
  const id = String(eventId);
  if (/^[A-Za-z0-9_.-]{1,200}$/.test(id) && id !== '.' && id !== '..') return id;
  return 'h_' + crypto.createHash('sha256').update(id).digest('hex');
}

// The browser's redeem attempt id is a capability for one thing only: a retry
// after a lost /redeem response. Store its hash, never the id itself.
function hashAttempt(attempt) {
  if (!attempt) return null;
  const a = String(attempt);
  if (!/^[0-9a-f]{16,64}$/i.test(a)) return null;
  return crypto.createHash('sha256').update(a).digest('hex');
}

function createTapStore({ db, FieldValue, Timestamp, sessionMaxMs, redeemTtlMs, makeCode, now = Date.now }) {
  const sessions = () => db.collection('tap_sessions');
  const index = () => db.collection('bridge_events');
  const ended = () => db.collection('ended_events');

  // pending -> active -> ended|expired. "active" is anchored on redeemedAt:
  // once any code has been redeemed, the event stays active until its max
  // lifetime — an unused re-entry code expiring must NOT regress it to
  // pending/expired (joint-test finding, 26 Oct).
  function sessionStatus(d, at = now()) {
    if (d.endedAt) return { status: 'ended', reason: d.endReason || null };
    if (d.redeemedAt) {
      const deadline = d.redeemedAt.toMillis() + sessionMaxMs;
      return deadline < at
        ? { status: 'expired', reason: 'max_lifetime', expiresAt: deadline }
        : { status: 'active', expiresAt: deadline };
    }
    // redeemed before redeemedAt existed (pre-lifecycle test docs)
    if (d.used) return { status: 'expired', reason: 'max_lifetime', expiresAt: null };
    const expMs = d.expiresAt ? d.expiresAt.toMillis() : 0;
    return expMs < at
      ? { status: 'expired', reason: 'code_expired', expiresAt: expMs }
      : { status: 'pending', expiresAt: expMs };
  }

  // Event lookup inside a transaction: the bridge_events index first, then
  // the legacy eventId query for sessions created before the index existed.
  async function lookupEventTx(t, eventId) {
    const idxRef = index().doc(eventDocId(eventId));
    const idx = await t.get(idxRef);
    if (idx.exists) {
      const doc = await t.get(sessions().doc(idx.data().sessionId));
      if (doc.exists) return { idxRef, indexed: true, ref: doc.ref, data: doc.data() };
    }
    const snap = await t.get(sessions().where('eventId', '==', String(eventId)).limit(1));
    if (!snap.empty) return { idxRef, indexed: false, ref: snap.docs[0].ref, data: snap.docs[0].data() };
    return { idxRef, indexed: false, ref: null, data: null };
  }

  async function findSession({ sessionId, eventId }) {
    if (sessionId) {
      const doc = await sessions().doc(String(sessionId)).get();
      return doc.exists ? { ref: doc.ref, data: doc.data() } : null;
    }
    const idx = await index().doc(eventDocId(eventId)).get();
    if (idx.exists) {
      const doc = await sessions().doc(idx.data().sessionId).get();
      if (doc.exists) return { ref: doc.ref, data: doc.data() };
    }
    const snap = await sessions().where('eventId', '==', String(eventId)).limit(1).get();
    return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
  }

  // Create the session for a bridge event exactly once. `build(code)` returns
  // the new document's fields. Result kinds:
  //   created    — this call created it
  //   existing   — another request (or an earlier delivery) already did
  //   tombstoned — a Disconnect for this event arrived first
  async function createBridgeEvent(eventId, build) {
    return db.runTransaction(async (t) => {
      const found = await lookupEventTx(t, eventId);
      if (found.ref) {
        if (!found.indexed) t.set(found.idxRef, { sessionId: found.ref.id });
        return { kind: 'existing', ref: found.ref, data: found.data };
      }
      const tomb = await t.get(ended().doc(String(eventId)));
      if (tomb.exists) return { kind: 'tombstoned', reason: tomb.data().reason || null };
      const ref = sessions().doc();
      const data = build(makeCode());
      t.create(found.idxRef, { sessionId: ref.id });
      t.set(ref, data);
      return { kind: 'created', ref, data };
    });
  }

  // Re-entry for an active event: return the live unused code, or mint one.
  // Transactional so concurrent retries agree on a single code.
  async function reentryCode(ref) {
    return db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const d = doc.data();
      const st = sessionStatus(d);
      if (st.status !== 'active') return { status: st, code: null };
      const curExp = d.expiresAt ? d.expiresAt.toMillis() : 0;
      if (!d.used && curExp > now()) return { status: st, code: d.code, reused: true };
      const code = makeCode();
      t.update(ref, {
        code,
        used: false,
        expiresAt: Timestamp.fromMillis(now() + redeemTtlMs),
        redeemAttempt: null,
      });
      return { status: st, code, reused: false };
    });
  }

  // App Disconnect: end the event, or tombstone it when the bridge request
  // has not created it yet. The tombstone is written in the same transaction
  // that confirmed no session exists, so a concurrent create either sees it
  // or is seen by it.
  async function findOrTombstone(eventId, reason) {
    return db.runTransaction(async (t) => {
      const found = await lookupEventTx(t, eventId);
      if (found.ref) return { ref: found.ref, data: found.data };
      t.set(ended().doc(String(eventId)), { endedAt: FieldValue.serverTimestamp(), reason });
      return null;
    });
  }

  // Exchange a one-time code for the session's identity. Everything that
  // decides validity is re-read inside the transaction: the code still
  // belongs to this session (a re-entry may have replaced it), it is unused
  // and unexpired, and the event has neither ended nor passed its original
  // deadline. A retry carrying the same attempt id as the request that
  // consumed the code gets the same answer again (lost response), within the
  // code's validity window only.
  async function redeem(rawCode, attempt) {
    const code = String(rawCode || '').toUpperCase().trim();
    if (!code) return { error: 'unknown login code', http: 404 };
    const snap = await sessions().where('code', '==', code).limit(1).get();
    if (snap.empty) return { error: 'unknown login code', http: 404 };
    const ref = snap.docs[0].ref;
    const attemptHash = hashAttempt(attempt);
    const at = now();
    return db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      if (!doc.exists) return { error: 'unknown login code', http: 404 };
      const d = doc.data();
      const gone = { error: 'login code is no longer valid — tap again for a new one', http: 410 };
      if (d.code !== code) return gone;
      if (d.endedAt) return { error: 'this session has ended — tap again', http: 410 };
      if (d.redeemedAt && d.redeemedAt.toMillis() + sessionMaxMs < at) {
        return { error: 'this session has expired — tap again', http: 410 };
      }
      const expired = !d.expiresAt || d.expiresAt.toMillis() < at;
      const identity = {
        uid: d.uid,
        displayName: d.displayName || null,
        gameType: d.gameType || null,
        eventId: d.eventId || null,
        sessionId: ref.id,
        redeemedAtMs: d.redeemedAt ? d.redeemedAt.toMillis() : at,
      };
      if (d.used) {
        if (attemptHash && d.redeemAttempt === attemptHash && !expired) {
          return { ...identity, replay: true };
        }
        return { error: 'login code already used — tap again for a new one', http: 410 };
      }
      if (expired) return { error: 'login code expired — tap again for a new one', http: 410 };
      // the first redemption anchors the event's max lifetime; a re-entry
      // code keeps the original anchor
      const update = { used: true, redeemAttempt: attemptHash };
      if (!d.redeemedAt) update.redeemedAt = FieldValue.serverTimestamp();
      t.update(ref, update);
      return { ...identity, replay: false };
    });
  }

  return {
    sessionStatus, findSession, createBridgeEvent, reentryCode, findOrTombstone, redeem,
  };
}

module.exports = { createTapStore, eventDocId, hashAttempt };
