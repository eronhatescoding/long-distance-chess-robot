// server/stub-server.js
// Node.js (v24) game server for the robot-chess project: serves static
// files, relays WebSocket messages between the two players of a room,
// accepts manual game events from stdin, and runs the tap-to-play endpoint
// (POST /tap, Phase 2). Run: node server/stub-server.js
// (PORT env var, default 8080; secrets in .env — see server/env.js)

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ROOT = path.resolve(__dirname, '..');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// Room codes: 4 uppercase letters, skipping ambiguous O/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

// ---------------------------------------------------------------------------
// Tap-to-play setup (Phase 2): Firebase Admin + station credentials from env
// ---------------------------------------------------------------------------

const { firebaseCredentials } = require('./env');

let fbAuth = null;
let db = null;
let fsFieldValue = null;
let fsTimestamp = null;

const creds = firebaseCredentials();
if (creds) {
  try {
    const { initializeApp, cert } = require('firebase-admin');
    initializeApp({ credential: cert(creds) });
    fbAuth = require('firebase-admin/auth').getAuth();
    const fsAdmin = require('firebase-admin/firestore');
    db = fsAdmin.getFirestore();
    fsFieldValue = fsAdmin.FieldValue;
    fsTimestamp = fsAdmin.Timestamp;
    console.log('[tap] firebase admin ready');
  } catch (err) {
    console.warn(`[tap] firebase admin failed to init: ${err.message}`);
    fbAuth = null;
    db = null;
  }
} else {
  console.warn('[tap] no firebase credentials (.env or service-account.json) — tap endpoint disabled');
}

// Offline kiosk mode (the venue Raspberry Pi): no Firebase credentials — or
// an explicit OFFLINE=1 — tells the client to skip sign-in entirely and offer
// guest solo play only. The browser makes zero external requests in this mode,
// so a firewalled network changes nothing. The server contacts only the
// station engine, and only if the XQ_* vars configure one (see xqConfigured).
// (.trim(): cmd's `set OFFLINE=1 && node ...` captures a trailing space)
const OFFLINE = (process.env.OFFLINE || '').trim() === '1' || !creds;

// Station secrets arrive as STATION_<ID>_SECRET env vars (one per machine).
// Clients identify themselves by the full name, e.g. stationId "STATION_A".
// Optional STATION_<ID>_CLUSTER binds a machine to a NexusBoard cluster:
// only players whose users/{uid}.clusterId matches may tap in there.
const stations = {};
const stationClusters = {};
for (const [key, value] of Object.entries(process.env)) {
  const secret = key.match(/^STATION_([A-Z0-9]+)_SECRET$/);
  if (secret && value) stations[`STATION_${secret[1]}`] = value;
  const cluster = key.match(/^STATION_([A-Z0-9]+)_CLUSTER$/);
  if (cluster && value) stationClusters[`STATION_${cluster[1]}`] = value;
}
if (Object.keys(stations).length === 0) {
  console.warn('[tap] no STATION_*_SECRET env vars — all taps will be rejected');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/') urlPath = '/game.html';

  // Client config: where the game WebSocket lives. Default is same-origin;
  // when games run on a different server (e.g. the arm-server in China),
  // GAME_SERVER_URL points the client there without a rebuild. `offline`
  // tells the client to skip Firebase sign-in and run as a guest kiosk.
  if (urlPath === '/config.json') {
    // stationDevices tells a kiosk whether its station can start real machine
    // games (mapped) or stays on simulated solo play (unmapped)
    jsonResponse(res, 200, {
      gameServerUrl: process.env.GAME_SERVER_URL || null,
      offline: OFFLINE,
      // only advertise machines the watcher is actually driving; a kiosk with
      // no engine configured stays on simulated solo play
      stationDevices: xqConfigured() ? XQ_STATION_MAP : {},
    });
    return;
  }

  // Browsers auto-request this; we have no icon, so answer quietly.
  if (urlPath === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  // GET /variants — the public registry of staff-created special rulesets
  // (created on the CV team's staff site, pushed to us via /register-variant).
  if (urlPath === '/variants') {
    if (!db) return jsonResponse(res, 200, { ok: true, variants: [] });
    db.collection('variants').get()
      .then((snap) => jsonResponse(res, 200, {
        ok: true,
        variants: snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((v) => v.active !== false)
          .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)),
      }))
      .catch(() => jsonResponse(res, 200, { ok: true, variants: [] }));
    return;
  }

  // JSON endpoints (Phase 2/2.5/5) — station PCs, the app, and signed-in
  // clients POST here.
  if (urlPath === '/tap' || urlPath === '/redeem' || urlPath === '/hce-token' || urlPath === '/lookup-user' || urlPath === '/claim-username' || urlPath === '/bridge/tap' || urlPath === '/record-game' || urlPath === '/register-variant' || urlPath === '/session-end' || urlPath === '/session-status' || urlPath === '/session-choose') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('Method not allowed');
      return;
    }
    if (urlPath === '/tap') handleTap(req, res);
    else if (urlPath === '/redeem') handleRedeem(req, res);
    else if (urlPath === '/hce-token') handleHceToken(req, res);
    else if (urlPath === '/lookup-user') handleLookupUser(req, res);
    else if (urlPath === '/claim-username') handleClaimUsername(req, res);
    else if (urlPath === '/bridge/tap') handleBridgeTap(req, res);
    else if (urlPath === '/session-end') handleSessionEnd(req, res);
    else if (urlPath === '/session-status') handleSessionStatus(req, res);
    else if (urlPath === '/session-choose') handleSessionChoose(req, res);
    else if (urlPath === '/register-variant') handleRegisterVariant(req, res);
    else handleRecordGame(req, res);
    return;
  }

  const filePath = path.resolve(PROJECT_ROOT, '.' + urlPath);
  // Path traversal guard: the resolved path must stay under the project root.
  if (filePath !== PROJECT_ROOT && !filePath.startsWith(PROJECT_ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ---------------------------------------------------------------------------
// Tap-to-play endpoints (Phase 2/2.5)
// ---------------------------------------------------------------------------
// POST /tap        — station PC reports a tap:
//     { stationId, stationSecret, cardId }       RFID card -> uid via cards/
//     { stationId, stationSecret, playerToken }  phone HCE single-use code
//     Resolves the player, enforces cluster membership (if the station is
//     bound to a cluster), records a tap_sessions doc with a short
//     redemption code, and replies { ok, uid, url } where the url carries
//     ?code=... — never a raw Firebase token.
// POST /redeem     — browser/app exchanges a redemption code for the actual
//     custom token: { code } -> { ok, token }. Single-use, 5-minute expiry.
// POST /hce-token  — the app fetches a single-use HCE code to transmit on
//     its next tap. Header: Authorization: Bearer <Firebase ID token>.
//     Replies { ok, code, expiresAt }. 90-second expiry.

// Short human-safe codes (Crockford base32: no I, L, O, U).
const REDEEM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REDEEM_TTL_MS = Number(process.env.REDEEM_TTL_MS) || 5 * 60 * 1000;
const HCE_TTL_MS = 90 * 1000;

function makeCode(len = 8) {
  return Array.from({ length: len }, () => REDEEM_ALPHABET[crypto.randomInt(32)]).join('');
}

// Reader UIDs arrive in many casings/formats; the cards collection keys on
// uppercase hex only.
function normalizeCardId(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16384) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Wrap a POST handler: parses JSON, rejects when Firebase is offline, and
// turns thrown errors into 500s.
function postEndpoint(name, required, fn) {
  return (req, res) => {
    const fail = (code, detail) => {
      console.log(`[${name}] rejected: ${detail}`);
      jsonResponse(res, code, { ok: false, detail });
    };
    if (!fbAuth || !db) return fail(503, 'server has no firebase credentials');
    (async () => {
      let msg;
      try {
        msg = JSON.parse(await readBody(req));
      } catch {
        return fail(400, 'invalid JSON body');
      }
      for (const field of required) {
        if (msg[field] === undefined || msg[field] === null || msg[field] === '') {
          return fail(400, `missing field: ${field}`);
        }
      }
      await fn(msg, fail, res);
    })().catch((err) => fail(500, `${name} failed: ${err.message}`));
  };
}

const handleTap = postEndpoint('tap', ['stationId', 'stationSecret'], async (msg, fail, res) => {
  const { stationId, stationSecret } = msg;
  if (!stationId || stations[stationId] !== stationSecret) {
    return fail(403, `unknown station or bad secret (${stationId || 'no id'})`);
  }

  let uid, via;
  if (msg.cardId) {
    const cardId = normalizeCardId(msg.cardId);
    const doc = await db.collection('cards').doc(cardId).get();
    if (!doc.exists) return fail(404, `card ${cardId} is not assigned to a player`);
    uid = doc.data().uid;
    via = 'card';
  } else if (msg.playerToken) {
    // Single-use HCE code transmitted by the app over NFC.
    const code = String(msg.playerToken).toUpperCase().trim();
    const ref = db.collection('hce_tokens').doc(code);
    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      if (!doc.exists) return { error: 'unknown tap token — fetch a fresh one and tap again' };
      const d = doc.data();
      if (d.used) return { error: 'tap token already used — fetch a fresh one and tap again' };
      if (d.expiresAt.toMillis() < Date.now()) return { error: 'tap token expired — fetch a fresh one and tap again' };
      t.update(ref, { used: true });
      return { uid: d.uid };
    });
    if (result.error) return fail(403, result.error);
    uid = result.uid;
    via = 'phone';
  } else {
    return fail(400, 'need cardId or playerToken');
  }

  // Cluster gate: if this station is bound to a cluster, only players
  // assigned to that cluster may start robot games here. Unassigned
  // players stay spectators (backend-enforced, per the NexusBoard model).
  const requiredCluster = stationClusters[stationId];
  if (requiredCluster) {
    const userDoc = await db.collection('users').doc(uid).get();
    const userCluster = userDoc.exists ? userDoc.data().clusterId : null;
    if (userCluster !== requiredCluster) {
      return fail(403, `player is not assigned to cluster ${requiredCluster} for this board`);
    }
  }

  // Cards deliver to the machine's screen — refuse while that screen already
  // has a live session, so a tap can't hijack someone's game. Also refuse
  // when the screen is set to expect a phone tap.
  if (msg.cardId) {
    if (kioskRejectsCard(stationId)) {
      return fail(409, 'the screen is expecting a phone tap right now');
    }
    if (await kioskBusy(stationId)) {
      return fail(409, 'station busy — finish the current game first');
    }
  }

  const code = makeCode();
  await db.collection('tap_sessions').add({
    uid,
    stationId,
    via,
    // which physical board is on the holder right now — the reader/station
    // reports it, and the website themes the lobby to match
    gameType: msg.gameType === 'xiangqi' ? 'xiangqi' : null,
    code,
    createdAt: fsFieldValue.serverTimestamp(),
    expiresAt: fsTimestamp.fromMillis(Date.now() + REDEEM_TTL_MS),
    used: false,
  });

  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const url = `${base}/game.html?code=${code}`;
  // Cards belong to the machine's screen: push the login to the station's
  // kiosk (the URL carries the station id so the page keeps its identity
  // across the navigation).
  let delivered = false;
  if (msg.cardId) {
    delivered = deliverToKiosk(stationId, `${base}/game.html?station=${encodeURIComponent(stationId)}&code=${code}`);
  }
  console.log(`[tap] ${stationId}: ${via} tap -> uid ${uid}${delivered ? ' (pushed to kiosk)' : ''}`);
  jsonResponse(res, 200, { ok: true, uid, url, delivered });
});

const handleRedeem = postEndpoint('redeem', ['code'], async (msg, fail, res) => {
  const code = String(msg.code).toUpperCase().trim();
  const snap = await db.collection('tap_sessions').where('code', '==', code).limit(1).get();
  if (snap.empty) return fail(404, 'unknown login code');

  const ref = snap.docs[0].ref;
  const result = await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const d = doc.data();
    if (d.used) return { error: 'login code already used — tap again for a new one' };
    if (d.expiresAt.toMillis() < Date.now()) return { error: 'login code expired — tap again for a new one' };
    // The first redemption anchors the session's max lifetime. A re-entry
    // code (bridge duplicate on an active event) keeps the original anchor.
    const update = { used: true };
    if (!d.redeemedAt) update.redeemedAt = fsFieldValue.serverTimestamp();
    t.update(ref, update);
    return {
      uid: d.uid, displayName: d.displayName || null, gameType: d.gameType || null,
      redeemedAtMs: d.redeemedAt ? d.redeemedAt.toMillis() : Date.now(),
    };
  });
  if (result.error) return fail(410, result.error);

  // bridge players have no Firebase profile — carry the asserted display
  // name as a claim so the client can greet them properly
  const token = await fbAuth.createCustomToken(
    result.uid,
    result.displayName ? { name: result.displayName } : undefined
  );
  // the session id lets the client end its own tap session (refresh lock /
  // Disconnect button) and lets the server link the socket to the session
  activeSessions.set(ref.id, result.redeemedAtMs + SESSION_MAX_MS);
  console.log(`[redeem] ${code} -> uid ${result.uid}`);
  jsonResponse(res, 200, { ok: true, token, gameType: result.gameType, sessionId: ref.id });
});

// POST /lookup-user (Phase 5) — "add friend by email" needs to turn an email
// into a uid, which only the Admin SDK can do. Clients send their Firebase
// ID token so random internet strangers can't enumerate accounts.
const handleLookupUser = postEndpoint('lookup-user', ['idToken'], async (msg, fail, res) => {
  let requester;
  try {
    requester = await fbAuth.verifyIdToken(String(msg.idToken));
  } catch {
    return fail(401, 'not signed in');
  }
  // self-profile lookup (the profile card shows your own username)
  if (msg.self) {
    const doc = await db.collection('users').doc(requester.uid).get();
    const user = await fbAuth.getUser(requester.uid);
    return jsonResponse(res, 200, {
      ok: true,
      uid: requester.uid,
      name: (doc.exists && doc.data().username) || user.displayName || user.email.split('@')[0],
      username: doc.exists ? doc.data().username || null : null,
    });
  }
  // by username: the registry maps lowercase name -> uid
  if (msg.username) {
    const name = String(msg.username).trim().toLowerCase();
    const reg = await db.collection('usernames').doc(name).get();
    if (!reg.exists) return fail(404, 'no player with that username');
    const uid = reg.data().uid;
    const user = await fbAuth.getUser(uid);
    return jsonResponse(res, 200, { ok: true, uid, name, username: name });
  }
  const email = String(msg.email || '').trim().toLowerCase();
  if (!email) return fail(400, 'need email or username');
  try {
    const user = await fbAuth.getUserByEmail(email);
    jsonResponse(res, 200, {
      ok: true,
      uid: user.uid,
      name: user.displayName || user.email.split('@')[0],
    });
  } catch {
    return fail(404, 'no account with that email');
  }
});

// POST /claim-username (profile card) — { idToken, username }. Usernames are
// 3-16 chars [a-z0-9_-], unique via a usernames/{name} registry written in a
// transaction; changing your name frees the old one.
const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const handleClaimUsername = postEndpoint('claim-username', ['idToken', 'username'], async (msg, fail, res) => {
  let requester;
  try {
    requester = await fbAuth.verifyIdToken(String(msg.idToken));
  } catch {
    return fail(401, 'not signed in');
  }
  const username = String(msg.username).trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return fail(400, 'username must be 3-16 letters, numbers, or _');
  }
  const regRef = db.collection('usernames').doc(username);
  const userRef = db.collection('users').doc(requester.uid);
  try {
    await db.runTransaction(async (t) => {
      const reg = await t.get(regRef);
      if (reg.exists && reg.data().uid !== requester.uid) {
        throw new Error('taken');
      }
      const userDoc = await t.get(userRef);
      const old = userDoc.exists ? userDoc.data().username : null;
      if (old && old !== username) {
        t.delete(db.collection('usernames').doc(old));
      }
      t.set(regRef, { uid: requester.uid });
      t.set(userRef, { username }, { merge: true });
    });
  } catch (err) {
    if (err.message === 'taken') return fail(409, 'that username is taken');
    throw err;
  }
  console.log(`[profile] ${requester.uid} claimed username ${username}`);
  jsonResponse(res, 200, { ok: true, username });
});

// /hce-token authenticates via the Authorization header, not the JSON body,
// so it doesn't use the postEndpoint wrapper.
async function handleHceToken(req, res) {
  const fail = (code, detail) => {
    console.log(`[hce-token] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!fbAuth || !db) return fail(503, 'server has no firebase credentials');
  try {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) return fail(401, 'missing Authorization: Bearer <id token>');

    const decoded = await fbAuth.verifyIdToken(idToken);
    const code = makeCode();
    const expiresAt = fsTimestamp.fromMillis(Date.now() + HCE_TTL_MS);
    await db.collection('hce_tokens').doc(code).set({
      uid: decoded.uid,
      createdAt: fsFieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });
    console.log(`[hce-token] issued ${code} for uid ${decoded.uid}`);
    jsonResponse(res, 200, { ok: true, code, expiresAt: expiresAt.toMillis() });
  } catch (err) {
    fail(401, `invalid id token: ${err.message}`);
  }
}

// POST /bridge/tap (Phase 4) — the NexusBoard Flask backend calls this after
// its own account/reader/board/cluster authorization succeeds. Identity is
// asserted by the backend (Bearer BRIDGE_SECRET header), never by the app or
// the reader. The player becomes a website user as uid sql_<playerId> — no
// Firebase account needed; the redemption code creates the session.
//
//   { eventId, playerId, displayName?, clusterId?, clusterIds?, stationId? }
//   -> { ok, uid, url }            first sight of eventId
//   -> { ok, uid, url, duplicate } repeat delivery of the same eventId
async function handleBridgeTap(req, res) {
  const fail = (code, detail) => {
    console.log(`[bridge] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!fbAuth || !db) return fail(503, 'server has no firebase credentials');
  const bridgeSecret = process.env.BRIDGE_SECRET;
  if (!bridgeSecret) return fail(503, 'bridge not configured (BRIDGE_SECRET unset)');
  if ((req.headers.authorization || '') !== `Bearer ${bridgeSecret}`) {
    return fail(401, 'bad bridge credentials');
  }

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }
  const { eventId, playerId } = msg || {};
  if (!eventId || !playerId) return fail(400, 'need eventId and playerId');

  try {
    const uid = `sql_${String(playerId)}`;
    const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

    // Idempotent: a retried or double-delivered tap returns the same session,
    // but never extends it — the caller learns what became of the original
    // code and can start a fresh eventId when it is already redeemed/expired.
    const dup = await db.collection('tap_sessions')
      .where('eventId', '==', String(eventId)).limit(1).get();
    if (!dup.empty) {
      const docRef = dup.docs[0].ref;
      const existing = dup.docs[0].data();
      const st = sessionStatus(existing);
      // A retry of a kiosk-delivered tap re-pushes the login — but only while
      // the code is still unused (a redeemed screen is already signed in).
      if (existing.deliverTo === 'kiosk' && existing.stationId && !existing.used && st.status !== 'ended' && st.status !== 'expired') {
        deliverToKiosk(
          existing.stationId,
          `${base}/game.html?station=${encodeURIComponent(existing.stationId)}&code=${existing.code}`
        );
      }
      if (st.status === 'active') {
        // Re-entry: the phone is the card and may be put away, so the app can
        // fetch a login code while the station is still occupied. The event
        // deadline (first redemption + max lifetime) never moves.
        // Idempotent: if a previous re-entry code is still live and unused,
        // return THAT one — a retry after a lost response must not invalidate
        // a code that may still be in transit to the phone.
        const now = Date.now();
        const curExp = existing.expiresAt ? existing.expiresAt.toMillis() : 0;
        if (!existing.used && curExp > now) {
          console.log(`[bridge] re-entry: returning live code for active event ${eventId}`);
          return jsonResponse(res, 200, {
            ok: true, uid, url: `${base}/game.html?code=${existing.code}`, duplicate: true,
            ...st,
          });
        }
        const newCode = makeCode();
        await docRef.update({
          code: newCode,
          used: false,
          expiresAt: fsTimestamp.fromMillis(now + REDEEM_TTL_MS),
        });
        console.log(`[bridge] re-entry code issued for active event ${eventId}`);
        return jsonResponse(res, 200, {
          ok: true, uid, url: `${base}/game.html?code=${newCode}`, duplicate: true,
          ...st,
        });
      }
      console.log(`[bridge] duplicate eventId ${eventId} — session is ${st.status}`);
      return jsonResponse(res, 200, {
        ok: true, uid, url: `${base}/game.html?code=${existing.code}`, duplicate: true,
        ...st,
      });
    }

    // Tombstone: a Disconnect that raced ahead of a delayed bridge request
    // wins — the ended event must never become playable afterwards. (After
    // the duplicate check: an event that *was* created reports its real
    // status above instead of this rejection.)
    const tomb = await db.collection('ended_events').doc(String(eventId)).get();
    if (tomb.exists) {
      console.log(`[bridge] rejected ${eventId}: session was ended before creation`);
      return jsonResponse(res, 409, {
        ok: false, status: 'ended', detail: 'event was ended before it was created',
      });
    }

    // Delivery routing. "station" (cards) always goes to the screen and
    // rejects when busy. "ask" prompts on the screen (idle only, else app
    // fallback). A plain phone tap is claimed by the station's screen when
    // the screen is in "play here" mode — his backend changes nothing; the
    // response's delivery field tells him whether to release the link.
    let delivery = 'app';
    let askKiosk = null;
    if (msg.deliver === 'station') {
      if (!msg.stationId) return fail(400, 'deliver: "station" needs stationId');
      if (kioskRejectsCard(msg.stationId)) {
        return fail(409, 'the screen is expecting a phone tap right now');
      }
      if (await kioskBusy(msg.stationId)) {
        return fail(409, 'station busy — finish the current game first');
      }
      delivery = 'kiosk';
    } else if (msg.deliver === 'ask') {
      if (!msg.stationId) return fail(400, 'deliver: "ask" needs stationId');
      const kiosk = kioskFor(msg.stationId);
      if (kiosk && !(await kioskBusy(msg.stationId))) {
        delivery = 'ask';
        askKiosk = kiosk;
      }
    } else if (msg.stationId) {
      // a screen in "play here" mode claims the phone tap — unless it's
      // expecting a card right now
      const kiosk = kioskFor(msg.stationId);
      if (kiosk && kiosk.kioskMode === 'screen' && kioskAcceptsPhone(msg.stationId) && !(await kioskBusy(msg.stationId))) {
        delivery = 'kiosk';
      }
    }

    const code = makeCode();
    const expiresAt = Date.now() + REDEEM_TTL_MS;
    const docRef = await db.collection('tap_sessions').add({
      uid,
      eventId: String(eventId),
      via: 'bridge',
      stationId: msg.stationId != null ? String(msg.stationId) : null,
      clusterId: msg.clusterId != null ? String(msg.clusterId) : null,
      displayName: msg.displayName ? String(msg.displayName).slice(0, 24) : null,
      gameType: msg.gameType === 'xiangqi' ? 'xiangqi' : null,
      // kiosk-delivered sessions stay coupled: the screen IS the station, so
      // a browser end (idle lock, crash, refresh) frees the machine.
      // deliverTo: null while an "ask" prompt is undecided.
      ...(delivery === 'kiosk' ? { coupled: true } : {}),
      deliverTo: delivery === 'ask' ? null : delivery,
      code,
      createdAt: fsFieldValue.serverTimestamp(),
      expiresAt: fsTimestamp.fromMillis(expiresAt),
      used: false,
    });
    const url = `${base}/game.html?code=${code}`;
    let delivered = false;
    if (delivery === 'kiosk') {
      delivered = deliverToKiosk(
        msg.stationId,
        `${base}/game.html?station=${encodeURIComponent(msg.stationId)}&code=${code}`
      );
    } else if (delivery === 'ask') {
      const askUrl = `${base}/game.html?station=${encodeURIComponent(msg.stationId)}&code=${code}`;
      sendJSON(askKiosk, { type: 'station_ask', url: askUrl, name: msg.displayName || null });
      console.log(`[bridge] tap ${eventId}: asking station ${msg.stationId} (screen or phone)`);
      // no choice within 30 s: the phone is the safe default
      setTimeout(async () => {
        try {
          const doc = await docRef.get();
          if (doc.exists && doc.data().deliverTo == null && !doc.data().used) {
            await docRef.update({ deliverTo: 'app' });
            console.log(`[bridge] ask ${eventId} timed out — delivering to app`);
          }
        } catch { /* session doc gone — nothing to default */ }
      }, 30000).unref();
    }
    console.log(`[bridge] tap ${eventId}: player ${playerId} -> ${uid}${delivered ? ' (pushed to kiosk)' : ''}`);
    jsonResponse(res, 200, {
      ok: true, uid, url, status: 'pending', expiresAt, delivered, delivery,
    });
  } catch (err) {
    fail(500, `bridge failed: ${err.message}`);
  }
}

// POST /record-game — when games run on the arm-server (which can't reach
// Firestore from its network), it reports finished games here so replays
// and the Past games list keep working. Same trust model as /bridge/tap.
//
//   { playerA: {name, uid?}, playerB: {name, uid?}|null, solo, gameType,
//     minutes, moves: [{move, by}], result: "A"|"B"|null, startedAt? }
//   -> { ok, id }
async function handleRecordGame(req, res) {
  const fail = (code, detail) => {
    console.log(`[record-game] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!db) return fail(503, 'server has no firebase credentials');
  const bridgeSecret = process.env.BRIDGE_SECRET;
  if (!bridgeSecret) return fail(503, 'bridge not configured (BRIDGE_SECRET unset)');
  if ((req.headers.authorization || '') !== `Bearer ${bridgeSecret}`) {
    return fail(401, 'bad bridge credentials');
  }

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }
  if (!msg.playerA?.name || !Array.isArray(msg.moves)) {
    return fail(400, 'need playerA.name and moves[]');
  }

  try {
    const ref = await db.collection('games').add({
      code: msg.code || null,
      solo: !!msg.solo,
      gameType: msg.gameType === 'xiangqi' ? 'xiangqi' : 'chess',
      variant: msg.variant ? String(msg.variant).slice(0, 32) : null,
      names: {
        A: String(msg.playerA.name),
        B: msg.solo || !msg.playerB ? 'robot' : String(msg.playerB.name),
      },
      uids: {
        A: msg.playerA.uid ? String(msg.playerA.uid) : null,
        B: msg.solo || !msg.playerB ? null : msg.playerB.uid ? String(msg.playerB.uid) : null,
      },
      minutes: Number(msg.minutes) || 5,
      moves: msg.moves.slice(0, 500).map((m) => ({
        move: String(m.move || '').slice(0, 8),
        by: m.by === 'B' ? 'B' : 'A',
      })),
      startedAt: msg.startedAt
        ? fsTimestamp.fromMillis(Number(msg.startedAt))
        : fsFieldValue.serverTimestamp(),
      endedAt: fsFieldValue.serverTimestamp(),
      status: 'over',
      result: msg.result === 'A' || msg.result === 'B' ? msg.result : null,
    });
    console.log(`[record-game] recorded ${ref.id} (${msg.moves.length} moves)`);
    jsonResponse(res, 200, { ok: true, id: ref.id });
  } catch (err) {
    fail(500, `record failed: ${err.message}`);
  }
}

// POST /register-variant — the CV team's staff site pushes a newly created
// special ruleset here so it appears in the website's Special games card.
// Same trust model as /record-game and /bridge/tap.
//
//   { id: "blast3x3", name: "Blast captures (3×3)", nameZh?: "…", description?: "…" }
//   -> { ok, id }
async function handleRegisterVariant(req, res) {
  const fail = (code, detail) => {
    console.log(`[register-variant] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!db) return fail(503, 'server has no firebase credentials');
  const bridgeSecret = process.env.BRIDGE_SECRET;
  if (!bridgeSecret) return fail(503, 'bridge not configured (BRIDGE_SECRET unset)');
  if ((req.headers.authorization || '') !== `Bearer ${bridgeSecret}`) {
    return fail(401, 'bad bridge credentials');
  }
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }
  const id = String(msg.id || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(id)) return fail(400, 'id must be 2-32 chars [a-z0-9_-]');
  if (!msg.name) return fail(400, 'need name');
  try {
    await db.collection('variants').doc(id).set({
      name: String(msg.name).slice(0, 48),
      nameZh: msg.nameZh ? String(msg.nameZh).slice(0, 48) : null,
      description: msg.description ? String(msg.description).slice(0, 200) : null,
      active: true,
      createdAt: fsFieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[variants] registered ${id}`);
    jsonResponse(res, 200, { ok: true, id });
  } catch (err) {
    fail(500, `register failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle (bridge Phase 4.5)
// ---------------------------------------------------------------------------
// Two decoupled lifecycles per bridge tap (the phone acts as a card):
//   EVENT   — the station occupation; ends ONLY on app Disconnect
//             (/session-end with eventId), the max lifetime, or an unused
//             code expiring. This is what /session-status reports.
//   BROWSER — the website tab's play access; ends on refresh, tab close,
//             sign-out, or a 90 s browser loss. Never frees the station.
// Card taps (no eventId) stay coupled: a browser end is a full end.
// Ended bridge events leave a tombstone in ended_events/ so a delayed
// /bridge/tap can never resurrect them. Flask polls /session-status over our
// HTTPS Funnel — no outbound callbacks (their hosting is HTTP-only).

const SESSION_GRACE_MS = Number(process.env.SESSION_GRACE_MS) || 90 * 1000;
const SESSION_MAX_MS = Number(process.env.SESSION_MAX_MS) || 2 * 60 * 60 * 1000;
const sessionTimers = new Map(); // sessionId -> grace timeout (browser lost)
const activeSessions = new Map(); // sessionId -> max-lifetime deadline (ms)

async function findSession({ sessionId, eventId }) {
  if (sessionId) {
    const doc = await db.collection('tap_sessions').doc(String(sessionId)).get();
    return doc.exists ? { ref: doc.ref, data: doc.data() } : null;
  }
  const snap = await db.collection('tap_sessions')
    .where('eventId', '==', String(eventId)).limit(1).get();
  return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
}

// pending -> active -> ended|expired. "active" is anchored on redeemedAt:
// once any code has been redeemed, the event stays active until its max
// lifetime — an unused re-entry code expiring must NOT regress it to
// pending/expired (joint-test finding, 26 Oct: refresh + lost re-entry
// response did exactly that).
function sessionStatus(d, now = Date.now()) {
  if (d.endedAt) return { status: 'ended', reason: d.endReason || null };
  if (d.redeemedAt) {
    const deadline = d.redeemedAt.toMillis() + SESSION_MAX_MS;
    return deadline < now
      ? { status: 'expired', reason: 'max_lifetime', expiresAt: deadline }
      : { status: 'active', expiresAt: deadline };
  }
  // redeemed before redeemedAt existed (pre-lifecycle test docs): any such
  // session is long past its 2 h lifetime — report it as expired
  if (d.used) {
    return { status: 'expired', reason: 'max_lifetime', expiresAt: null };
  }
  // never redeemed: the initial code's 5-minute expiry applies
  const expMs = d.expiresAt ? d.expiresAt.toMillis() : 0;
  return expMs < now
    ? { status: 'expired', reason: 'code_expired', expiresAt: expMs }
    : { status: 'pending', expiresAt: expMs };
}

async function endSession(found, reason) {
  if (found.data.endedAt) return false; // idempotent
  await found.ref.update({
    endedAt: fsFieldValue.serverTimestamp(),
    endReason: reason,
  });
  if (found.data.eventId) {
    await db.collection('ended_events').doc(String(found.data.eventId))
      .set({ endedAt: fsFieldValue.serverTimestamp(), reason });
  }
  activeSessions.delete(found.ref.id);
  const pending = sessionTimers.get(found.ref.id);
  if (pending) { clearTimeout(pending); sessionTimers.delete(found.ref.id); }
  console.log(`[session] ended ${found.ref.id} (${reason})`);
  // a kiosk session ending also aborts the website-started game on its
  // machine — the machine must never keep playing to an empty chair
  for (const socket of clients) {
    if (socket.sessionId === found.ref.id && socket.kioskStation && !socket.destroyed) {
      xqAbortStationGame(socket.kioskStation, 'session_ended');
    }
  }
  // a live website tab locks back to spectator immediately
  for (const socket of clients) {
    if (socket.sessionId === found.ref.id && !socket.destroyed) {
      sendJSON(socket, { type: 'session_end', reason });
    }
  }
  return true;
}

// Bridge sessions are decoupled: the phone acts as a card and may be put
// away, so a closed/refreshed/lost browser must NOT free the station. The
// browser end is recorded for debugging; only an app Disconnect or the max
// lifetime ends the event. Card taps have no event — their browser end is a
// full end, since a physical re-tap is always possible.
async function endBrowserSession(found, reason) {
  // coupled sessions (kiosk-delivered, cards): the screen IS the station,
  // so a browser end is a full end and frees the machine
  if (!found.data.eventId || found.data.coupled) return endSession(found, reason);
  if (found.data.endedAt) return false;
  await found.ref.update({
    browserEndedAt: fsFieldValue.serverTimestamp(),
    browserEndReason: reason,
  });
  console.log(`[session] browser ended ${found.ref.id} (${reason}) — event stays active until Disconnect/expiry`);
  return true;
}

// POST /session-end — two callers:
//   Flask (Bearer BRIDGE_SECRET, { eventId })  app-side Disconnect
//   website tab ({ sessionId }, no auth)       refresh lock / beacon / sign-out;
//                                              the session id is the capability
async function handleSessionEnd(req, res) {
  const fail = (code, detail) => {
    console.log(`[session-end] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!db) return fail(503, 'server has no firebase credentials');
  const authed = (req.headers.authorization || '') === `Bearer ${process.env.BRIDGE_SECRET || '\0'}`;

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }

  try {
    if (authed && msg.eventId) {
      const found = await findSession({ eventId: msg.eventId });
      if (!found) {
        // Disconnect raced ahead of the bridge request: leave a tombstone so
        // the tap can never create a session when it finally arrives.
        await db.collection('ended_events').doc(String(msg.eventId))
          .set({ endedAt: fsFieldValue.serverTimestamp(), reason: 'disconnect_before_create' });
        console.log(`[session-end] tombstoned ${msg.eventId} (ended before creation)`);
        return jsonResponse(res, 200, { ok: true, status: 'ended' });
      }
      const did = await endSession(found, 'app_disconnect');
      return jsonResponse(res, 200, { ok: true, status: 'ended', already: !did });
    }
    if (msg.sessionId) {
      const found = await findSession({ sessionId: msg.sessionId });
      // unknown ids stay indistinguishable from ended ones — no oracle
      if (!found) return jsonResponse(res, 200, { ok: true, ignored: true });
      // browser-initiated ends (refresh lock, tab close, sign-out) never free
      // a bridge station — only the browser side ends
      const did = await endBrowserSession(found, String(msg.reason || 'client_end').slice(0, 32));
      return jsonResponse(res, 200, { ok: true, status: 'ended', already: !did });
    }
    return fail(400, authed ? 'need eventId' : 'need sessionId');
  } catch (err) {
    fail(500, `session-end failed: ${err.message}`);
  }
}

// POST /session-choose — the kiosk answers a station_ask prompt. The one-time
// code is the capability (the screen that received the push has it).
// { code, choice: "kiosk"|"phone" } → { ok, deliverTo }
async function handleSessionChoose(req, res) {
  const fail = (code, detail) => {
    console.log(`[session-choose] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!db) return fail(503, 'server has no firebase credentials');
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }
  const code = String(msg.code || '').toUpperCase().trim();
  const choice = msg.choice === 'kiosk' ? 'kiosk' : msg.choice === 'phone' ? 'app' : null;
  if (!code || !choice) return fail(400, 'need code and choice (kiosk|phone)');

  try {
    const snap = await db.collection('tap_sessions').where('code', '==', code).limit(1).get();
    if (snap.empty) return fail(404, 'unknown login code');
    const ref = snap.docs[0].ref;
    const d = snap.docs[0].data();
    if (d.used) return jsonResponse(res, 200, { ok: true, deliverTo: 'kiosk', already: true });
    if (d.deliverTo) {
      return jsonResponse(res, 200, { ok: true, deliverTo: d.deliverTo, already: true });
    }
    await ref.update({ deliverTo: choice });
    console.log(`[session-choose] ${code} -> ${choice}`);
    jsonResponse(res, 200, { ok: true, deliverTo: choice });
  } catch (err) {
    fail(500, `session-choose failed: ${err.message}`);
  }
}

// POST /session-status — Flask polls its own event after a tap instead of
// receiving callbacks (their public hosting is HTTP-only; ours is HTTPS).
// Bearer BRIDGE_SECRET, { eventId }.
async function handleSessionStatus(req, res) {
  const fail = (code, detail) => {
    console.log(`[session-status] rejected: ${detail}`);
    jsonResponse(res, code, { ok: false, detail });
  };
  if (!db) return fail(503, 'server has no firebase credentials');
  if ((req.headers.authorization || '') !== `Bearer ${process.env.BRIDGE_SECRET || '\0'}`) {
    return fail(401, 'bad bridge credentials');
  }
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return fail(400, 'invalid JSON body');
  }
  if (!msg.eventId) return fail(400, 'need eventId');

  try {
    const found = await findSession({ eventId: msg.eventId });
    if (!found) {
      const tomb = await db.collection('ended_events').doc(String(msg.eventId)).get();
      if (tomb.exists) {
        return jsonResponse(res, 200, { ok: true, status: 'ended', reason: tomb.data().reason || null });
      }
      return jsonResponse(res, 200, { ok: true, status: 'unknown' });
    }
    jsonResponse(res, 200, {
      ok: true,
      ...sessionStatus(found.data),
      deliverTo: found.data.deliverTo ?? null, // null while an "ask" is undecided
    });
  } catch (err) {
    fail(500, `session-status failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Station kiosks (card tap -> machine screen login)
// ---------------------------------------------------------------------------
// A machine's touchscreen page registers itself over the game WebSocket with
// { type: 'kiosk_hello', stationId } after connecting. A card tap (our /tap)
// or a bridge tap with deliver: "station" then pushes the one-time login URL
// straight to that screen, which navigates to it and signs the player in.
//
// Demo-trust note: kiosk registration is unauthenticated — a malicious client
// could claim a station id and race the real kiosk for the pushed code. The
// real kiosk redeems within milliseconds, so the window is theoretical at a
// venue; a per-station kiosk token is the proper fix later.

const kioskByStation = new Map(); // stationId -> socket
const kioskLastDelivery = new Map(); // stationId -> ms of last pushed login

function kioskFor(stationId) {
  const k = kioskByStation.get(String(stationId));
  return k && !k.destroyed ? k : null;
}

// Push the login URL to the station's screen. Returns true if a kiosk
// received it.
function deliverToKiosk(stationId, url) {
  const kiosk = kioskFor(stationId);
  if (!kiosk) return false;
  console.log(`[kiosk] delivering login to station ${stationId}`);
  kioskLastDelivery.set(String(stationId), Date.now());
  sendJSON(kiosk, { type: 'station_login', url });
  return true;
}

// A kiosk already in a play session must ignore new taps: the current player
// keeps their machine. Busy = seated in a room (incl. guest games), watching
// its station's live game, a login delivered in the last 10 s (the screen is
// still navigating/redeeming), or the kiosk holds a pending or active session.
async function kioskBusy(stationId) {
  // a website-started game pending or live on this station's machine blocks
  // new taps even if the kiosk screen itself has crashed
  const xst = xqStationByDevice(XQ_STATION_MAP[stationId]);
  if (xst && (xst.requested || xst.partyRoom || (xst.room && xst.room.createdByUs))) return true;
  const kiosk = kioskFor(stationId);
  if (!kiosk) return false;
  if (kiosk.room || watchingLive(kiosk)) return true;
  if (Date.now() - (kioskLastDelivery.get(String(stationId)) || 0) < 10000) return true;
  if (!kiosk.sessionId || !db) return false;
  const found = await findSession({ sessionId: kiosk.sessionId });
  if (!found) return false;
  const st = sessionStatus(found.data);
  return st.status === 'pending' || st.status === 'active';
}

// The kiosk's attract screen chooses which tap kind is expected right now
// (kioskAccept: 'any' | 'card' | 'phone'). A mismatched CARD tap is rejected
// with a reason; a mismatched PHONE tap is never dead-ended — it just falls
// back to the app (handled by the caller skipping the screen claim).
function kioskRejectsCard(stationId) {
  const kiosk = kioskFor(stationId);
  if (!kiosk) return false;
  const accept = kiosk.kioskAccept || 'any';
  return accept === 'phone';
}

function kioskAcceptsPhone(stationId) {
  const kiosk = kioskFor(stationId);
  if (!kiosk) return true;
  return (kiosk.kioskAccept || 'any') !== 'card';
}

// When a station's physical game starts, its touchscreen automatically
// watches it (player-POV presentation is a client-side concern). Skipped
// while the kiosk has its own play session. Shared (PvP) games attach the
// kiosks of BOTH stations — device ids map back to kiosk ids via
// XQ_DEVICE_TO_STATION; unmapped devices just have no screen to notify.
function kioskAutoWatch(room) {
  const kioskIds = room.station
    ? [room.station]
    : (room.stations || []).map((d) => XQ_DEVICE_TO_STATION[d] || d);
  for (const kioskId of kioskIds) {
    kioskAutoWatchOne(kioskId, room);
  }
}

function kioskAutoWatchOne(kioskId, room) {
  // The website is the only thing that starts a kiosk's game: a screen follows
  // only rooms this server requested (createdByUs). A game the operator
  // started at the station stays watchable from the lobby, but never pulls a
  // kiosk off its attract screen or out of a tapped player's session.
  if (!room.createdByUs) return;
  const kiosk = kioskFor(kioskId);
  // A tapped kiosk carries a sessionId, and it must still follow the game it asked for; only
  // a kiosk seated in a room as a player, or one that left the stream on purpose, is skipped.
  if (!kiosk || kiosk.room || kiosk.noAutoWatch) return;
  if (kiosk.watching) {
    const current = kiosk.watching;
    if (rooms.get(current.code) === current) return; // a live room — stay
    // The old room just finished: let the result screen breathe. The new
    // game takes over after the closure window, not mid-celebration.
    const elapsed = Date.now() - (current.finishedAt || 0);
    const wait = Math.max(0, 8000 - elapsed);
    setTimeout(() => {
      if (kiosk.destroyed) return;
      // moved on to another live room meanwhile? leave it alone
      if (kiosk.watching && kiosk.watching !== current &&
          rooms.get(kiosk.watching.code) === kiosk.watching) return;
      if (kiosk.watching === current) detachSpectator(kiosk);
      if (rooms.get(room.code) !== room) return; // the new game is also gone
      kiosk.watching = room;
      room.spectators.add(kiosk);
      sendJSON(kiosk, specStateMsg(room));
      console.log(`[kiosk] station ${kioskId} followed to room ${room.code}`);
      broadcastLobbyGames();
    }, wait).unref();
    return;
  }
  kiosk.watching = room;
  room.spectators.add(kiosk);
  sendJSON(kiosk, specStateMsg(room));
  console.log(`[kiosk] station ${kioskId} auto-watching room ${room.code}`);
  broadcastLobbyGames(); // spectator count changed
}

// ---------------------------------------------------------------------------
// Station watcher (Xiangqi REST API bridge)
// ---------------------------------------------------------------------------
// The camera/arm backend is REST-only: Xiangqi rules + bot + arm, one
// human-vs-bot game per station (see server_integration_brief_2.md). This
// watcher polls its read-only endpoints and projects each active station
// game into a "virtual room" here, so the lobby's live-games list,
// spectating and Firestore recording all work unchanged. Browsers never
// talk to his server; this server is the only client, with a read-only key.
//
// Config (.env):
//   XQ_API_BASE=https://...              his server's base URL
//   XQ_READER_ID / XQ_READER_KEY         a --reader credential
//   XQ_DEVICES=deviceId:Display Name,... the stations to watch
//   XQ_POLL_MS=2500                      poll cadence per station

const XQ_API_BASE = (process.env.XQ_API_BASE || '').replace(/\/$/, '');
const XQ_READER_ID = process.env.XQ_READER_ID || '';
const XQ_READER_KEY = process.env.XQ_READER_KEY || '';
const XQ_POLL_MS = Number(process.env.XQ_POLL_MS) || 2500;
// a game with no activity for this long is dead (operator reset, camera
// stuck) — end it cleanly instead of haunting the lobby forever
const XQ_STALE_MS = Number(process.env.XQ_STALE_MS) || 3 * 60 * 1000;
// kiosk station id -> his device id, e.g. XQ_STATION_MAP="2:pi-board-01".
// Only mapped stations can start website-controlled games on the machine.
const XQ_STATION_MAP = (process.env.XQ_STATION_MAP || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .reduce((m, entry) => {
    const [k, ...rest] = entry.split(':');
    if (k && rest.length) m[k.trim()] = rest.join(':').trim();
    return m;
  }, {});
// write credentials default to the reader pair until his API issues a
// separate writer key (XQ_WRITER_ID / XQ_WRITER_KEY)
const XQ_WRITER_ID = process.env.XQ_WRITER_ID || XQ_READER_ID;
const XQ_WRITER_KEY = process.env.XQ_WRITER_KEY || XQ_READER_KEY;
// reverse lookup: his device id -> our kiosk station id (for PvP auto-watch)
const XQ_DEVICE_TO_STATION = Object.fromEntries(
  Object.entries(XQ_STATION_MAP).map(([kioskId, deviceId]) => [deviceId, kioskId])
);
// a requested game that never reaches "playing" within this window is failed.
// His guidance: setup takes MINUTES (operator starts the request, someone
// sets up the board, the camera confirms) — 5-10 min, not 45 s. On timeout
// we abort the request so it doesn't linger on the station and cause 409s.
const XQ_SETUP_TIMEOUT_MS = Number(process.env.XQ_SETUP_TIMEOUT_MS) || 8 * 60 * 1000;
// a live game whose STATION PROGRAM has gone dark (online:false — no /sync
// heartbeat for 20s+) is abandoned much sooner than a merely quiet one
const XQ_OFFLINE_STALE_MS = Number(process.env.XQ_OFFLINE_STALE_MS) || 60 * 1000;
const xqStations = (process.env.XQ_DEVICES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id, ...nameParts] = entry.split(':');
    return { id: id.trim(), name: nameParts.join(':').trim() || id.trim() };
  });
const xqGames = new Map(); // gameId -> virtual room (dedupes shared PvP games)

// His squares are files A-I x ranks 1-10 ("B3"); our xiangqi renderer takes
// "b2"-style coordinates (file a-i, rank 0 = red home).
// ASSUMPTION: his rank 1 is red's home rank — verify against a live game.
function xqSquare(sq) {
  const m = String(sq || '').match(/^([A-Ia-i])(10|[1-9])$/);
  if (!m) return null;
  return m[1].toLowerCase() + String(Number(m[2]) - 1);
}

// a game's winner can be a side (red/black — PvP), a role (human/bot — solo),
// or "draw" (PvP agreement/repetition — no winner)
function xqWinnerLetter(g) {
  if (g.winner === 'red') return 'A';
  if (g.winner === 'black') return 'B';
  if (g.winner === 'draw') return null;
  if (g.winner === 'human') return 'A';
  if (g.winner === 'bot') return 'B';
  if (g.winner && g.human_side) return g.winner === g.human_side ? 'A' : 'B';
  return null;
}

function xqRoomMove(mv) {
  const from = xqSquare(mv.source);
  const to = xqSquare(mv.destination);
  if (!from || !to) return null;
  // side-based mapping works for bot games AND future player-vs-player games
  // (both humans); fall back to the human/bot flag for older payloads
  const by = mv.side ? (mv.side === 'red' ? 'A' : 'B') : mv.by === 'bot' ? 'B' : 'A';
  // his API tells us exactly what was captured — authoritative, no deriving
  return { move: from + to, by, captured: mv.captured || null };
}

async function xqGet(pathname) {
  // a hung fetch must not freeze this station's polling forever — abort
  // after 8s and let the next poll retry (the link to China drops a lot of
  // handshakes; failing fast is fine, hanging is fatal)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(XQ_API_BASE + pathname, {
      headers: { Authorization: `Bearer ${XQ_READER_KEY}`, 'X-Reader-ID': XQ_READER_ID },
      redirect: 'error', // his clients refuse redirects; match that
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Write side (website-controlled games): create/abort. Same hardening as
// xqGet. Uses the WRITER headers (X-Writer-ID + writer Bearer), gated on the
// contract check at startup. Errors carry .status so callers can tell
// "device busy" (409) from "engine unreachable" (no status).
async function xqPost(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(XQ_API_BASE + pathname, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${XQ_WRITER_KEY}`,
        'X-Writer-ID': XQ_WRITER_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// reader-2 contract gates the write features; checked once at startup
let xqWriteEnabled = false;
// website-seated PvP rooms (the engine advertises features: ["website_rooms"])
let xqRoomsEnabled = false;

async function xqCheckContract() {
  try {
    const v = await xqGet('/api/version');
    xqWriteEnabled = v.contract === 'reader-2';
    xqRoomsEnabled = xqWriteEnabled && Array.isArray(v.features) && v.features.includes('website_rooms');
    console.log(`[xq] contract: ${v.contract || 'unknown'} — website game control ${xqWriteEnabled ? 'ENABLED' : 'disabled (engine too old)'}, party rooms ${xqRoomsEnabled ? 'ENABLED' : 'disabled'}`);
  } catch (err) {
    // no version endpoint at all = pre-reader-2
    console.warn(`[xq] contract check failed (${err.message}) — website game control disabled`);
  }
  // his deploy may land after our startup — keep checking until it does
  if (!xqWriteEnabled) {
    setTimeout(xqCheckContract, 30000).unref();
  }
}

function xqStationByDevice(deviceId) {
  return xqStations.find((s) => s.id === deviceId) || null;
}

// His piece ids -> WXF Xiangqi FEN letters (uppercase = red, lowercase = black)
const XQ_PIECE_TO_FEN = {
  r_shuai: 'K', b_jiang: 'k',
  r_shi: 'A', b_shi: 'a',
  r_xiang: 'E', b_xiang: 'e',
  r_che: 'R', b_che: 'r',
  r_ma: 'H', b_ma: 'h',
  r_pao: 'C', b_pao: 'c',
  r_bing: 'P', b_zu: 'p',
};

// His initial_board ({"E1":"r_shuai",...}, empty squares omitted) -> WXF FEN
// (rows rank 10 down to rank 1, files A-I, digits = empty). Standard openings
// omit initial_board -> null.
function xqBoardToFen(board) {
  if (!board || typeof board !== 'object') return null;
  const rows = [];
  for (let rank = 10; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 9; file++) {
      const piece = XQ_PIECE_TO_FEN[board[String.fromCharCode(65 + file) + rank]];
      if (piece) {
        if (empty) { row += empty; empty = 0; }
        row += piece;
      } else {
        empty++;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

function xqStationError(st, err) {
  if (st.reachable !== false) {
    console.warn(`[xq] ${st.id}: unreachable (${err.message})`);
  }
  st.reachable = false;
}

// ---------------------------------------------------------------------------
// Website-controlled station games (Phase 7)
// ---------------------------------------------------------------------------
// The kiosk decides a game starts; his engine executes it. Our room exists
// from the moment of the request (setupState: requested -> setting_up ->
// playing), and the watcher tracks the expected game id directly — the
// device endpoint may not report a game that fails during setup.
//
// Guards against the failure modes we know: double-press (one pending/active
// website game per station), busy device (409), engine down (fetch error),
// setup that never completes (timeout), and operator games (createdByUs =
// false) which we adopt but never abort.

// Create on his engine, with self-healing for the classic failure: a kiosk
// that refreshed or a laptop that died left an unfinished website-created
// game squatting on the device, so every later create 409s. Only `web-` ids
// with NO moves and a stale timestamp are cleaned up — anything with moves
// could be a live game and is never touched.
async function xqCreateWithCleanup(st, gameId) {
  const body = {
    game_id: gameId,
    device_id: st.id,
    mode: process.env.XQ_GAME_MODE === 'simulation' ? 'simulation' : 'physical',
    human_side: 'red',
    opening: 'standard',
  };
  try {
    return await xqPost('/api/xiangqi/games', body);
  } catch (err) {
    if (err.status !== 409) throw err;
    const info = await xqGet(`/api/xiangqi/devices/${encodeURIComponent(st.id)}`);
    let cleaned = 0;
    for (const id of info.unfinished_game_ids || []) {
      if (!String(id).startsWith('web-')) continue;
      let g;
      try {
        g = await xqGet(`/api/xiangqi/games/${encodeURIComponent(id)}`);
      } catch { continue; }
      const noMoves = !(g.moves && g.moves.length);
      const staleMs = Date.now() - Number(g.updatedAt || 0);
      if (noMoves && staleMs > 2 * 60 * 1000) {
        console.log(`[xq] ${st.id}: cleaning up stale website game ${id}`);
        await xqPost(`/api/xiangqi/games/${encodeURIComponent(id)}/abort`, { event_id: crypto.randomUUID() });
        cleaned++;
      }
    }
    if (!cleaned) throw err; // genuinely busy
    return xqPost('/api/xiangqi/games', body); // second and final attempt
  }
}

async function xqRequestStationGame(socket, msg) {
  const stationId = socket.kioskStation;
  socket.noAutoWatch = false; // asking for a game means following it, whatever was left earlier
  const st = xqStationByDevice(XQ_STATION_MAP[stationId]);
  if (!st || !xqWriteEnabled) {
    return send(socket, { type: 'station_game_failed', reason: 'unavailable' });
  }
  if (st.requested && st.requested.socket === socket) {
    // the same screen pressed Play again while its own game sets up: not "busy", just still coming
    return send(socket, { type: 'station_game_requested' });
  }
  if (st.requested || st.room || st.partyRoom) {
    // a website game pending/live, or an operator game we adopted — the
    // machine can only play one game at a time
    return send(socket, { type: 'station_game_failed', reason: 'busy' });
  }
  const room = createRoom(true, 'xiangqi', msg.variant);
  room.noClock = true; // machine games are untimed — his engine has no clocks
  room.station = stationId; // the KIOSK id: the screen follows its own station
  room.deviceId = st.id;
  room.createdByUs = true;
  room.setupState = 'requested';
  room.humanLetter = 'A'; // we create with human_side red (red = A)
  room.players.A = { playerName: socket.playerName || st.name, playerUid: socket.playerUid || null };
  // game_id is ours and idempotent: a retried create returns the same game
  const gameId = `web-${crypto.randomUUID()}`;
  st.requested = { key: gameId, room, socket };
  console.log(`[xq] ${st.id}: game requested by station ${stationId} (${gameId})`);
  try {
    const res = await xqCreateWithCleanup(st, gameId);
    st.expectedGameId = res.id || gameId;
    room.setupState = 'setting_up';
    send(socket, { type: 'station_game_requested' });
    setTimeout(() => {
      if (st.requested && st.requested.key === gameId && room.setupState !== 'playing') {
        console.warn(`[xq] ${st.id}: game never started — timing out and aborting the request`);
        // tell his server to drop it, or it sits on the station and 409s
        // every later create
        xqPost(`/api/xiangqi/games/${encodeURIComponent(st.expectedGameId || gameId)}/abort`,
          { event_id: crypto.randomUUID() })
          .catch((err) => console.warn(`[xq] ${st.id}: timeout abort failed: ${err.message}`));
        xqFailRequest(st, 'timeout');
      }
    }, XQ_SETUP_TIMEOUT_MS).unref();
  } catch (err) {
    console.warn(`[xq] ${st.id}: create failed: ${err.message}`);
    xqFailRequest(st, err.status === 409 ? 'busy' : 'unavailable');
  }
}

function xqFailRequest(st, reason) {
  const req = st.requested;
  if (!req) return;
  st.requested = null;
  st.expectedGameId = null;
  if (rooms.get(req.room.code) === req.room) rooms.delete(req.room.code);
  send(req.socket, { type: 'station_game_failed', reason });
  broadcastLobbyGames();
}

// ---------------------------------------------------------------------------
// Physical party rooms (two machines, one game)
// ---------------------------------------------------------------------------
// A tapped player at machine X creates a party (a 4-letter code, or a friend
// challenge that carries the code); a tapped player at machine Y joins it. The
// website alone decides the game starts: only when the joiner arrives does it
// ask the engine to seat BOTH stations (random sides, no engine-side code),
// then the normal watcher stream drives both kiosks. The players' sockets stay
// out of the room — their kiosks watch it like any station game — and keep a
// signalling path to each other for the video call.
//
//   waiting (host seated, PARTY_WAIT_MS) -> requested (engine create in flight)
//   -> setting_up (stations attach, boards checked) -> playing -> finished

const PARTY_WAIT_MS = Number(process.env.PARTY_WAIT_MS) || 10 * 60 * 1000;

// The machine a socket plays on, when it may start a physical party: a kiosk
// of a mapped station, xiangqi only (chess has no camera side yet).
function xqPartyStation(socket, gameType) {
  if (!socket.kioskStation || gameType !== 'xiangqi') return null;
  return xqStationByDevice(XQ_STATION_MAP[socket.kioskStation]);
}

function xqPartyNotify(room, msg) {
  for (const peer of room.callPeers || []) if (!peer.destroyed) sendJSON(peer, msg);
}

function xqCreateParty(socket, st) {
  socket.noAutoWatch = false; // asking for a game means following it
  if (!xqRoomsEnabled) return send(socket, { type: 'error', detail: 'physical games are not available right now' });
  if (!socket.playerUid) return send(socket, { type: 'error', detail: 'sign in with your card to play with others' });
  if (st.requested || st.room || st.partyRoom) return send(socket, { type: 'error', detail: 'this machine is busy' });
  removeFromQueue(socket);
  const room = createRoom(false, 'xiangqi');
  room.noClock = true; // machine games are untimed
  room.physical = true;
  room.station = socket.kioskStation;
  room.hostDevice = st.id;
  seatPlayer(room, socket, 'A');
  st.partyRoom = room;
  room.partyTimer = setTimeout(() => xqExpireParty(room), PARTY_WAIT_MS);
  room.partyTimer.unref();
  console.log(`[party] ${room.code} created at ${st.id} (waits ${Math.round(PARTY_WAIT_MS / 1000)}s for a joiner)`);
  send(socket, { type: 'room_created', code: room.code, physical: true, expiresInMs: PARTY_WAIT_MS });
}

function xqExpireParty(room) {
  if (rooms.get(room.code) !== room || room.createdByUs) return;
  const host = room.players.A;
  console.log(`[party] ${room.code} expired with no joiner`);
  if (host && !host.destroyed) {
    unseatPlayer(host); // frees the room, the machine and (via the empty-room path) the timer
    send(host, { type: 'party_expired' }); // no 'lobby' after it: that would overwrite the message
  } else {
    rooms.delete(room.code);
    xqPartyDone(room);
  }
}

async function xqJoinParty(socket, room) {
  const st = xqPartyStation(socket, 'xiangqi');
  const fail = (detail) => send(socket, { type: 'error', detail });
  if (room.createdByUs || room.players.B) return fail('room full');
  if (!st) return fail('join from a machine to play a physical game');
  if (!xqRoomsEnabled) return fail('physical games are not available right now');
  if (!socket.playerUid) return fail('sign in with your card to play with others');
  if (st.id === room.hostDevice) return fail('your opponent has to be at the other machine');
  if (st.requested || st.room || st.partyRoom) return fail('this machine is busy');
  const host = room.players.A;
  const hostSt = xqStationByDevice(room.hostDevice);
  if (!host || host.destroyed || !hostSt) return fail('no such room');
  removeFromQueue(socket);
  clearTimeout(room.partyTimer);
  socket.noAutoWatch = false;
  host.noAutoWatch = false;

  // random sides: the host is red half the time
  const hostIsRed = crypto.randomInt(2) === 0;
  const red = hostIsRed ? { sock: host, st: hostSt } : { sock: socket, st };
  const black = hostIsRed ? { sock: socket, st } : { sock: host, st: hostSt };
  const person = (sock) => ({ playerName: sock.playerName || 'player', playerUid: sock.playerUid || null });
  room.partyPlayers = { red: person(red.sock), black: person(black.sock) };
  room.players = { A: room.partyPlayers.red, B: room.partyPlayers.black }; // A = red, B = black
  // sockets leave the room (their kiosks watch it) but stay connected as a video pair
  host.room = null;
  host.playerLetter = null;
  room.callPeers = [host, socket];
  host.callRoom = room;
  socket.callRoom = room;
  // video: red leads the negotiation (impolite), black is polite — the same roles A/B have in virtual rooms
  room.callRoles = {
    [red.sock.kioskStation]: { polite: false, peer: room.partyPlayers.black.playerName },
    [black.sock.kioskStation]: { polite: true, peer: room.partyPlayers.red.playerName },
  };
  xqCallAnnounce(room);
  room.stations = [red.st.id, black.st.id];
  room.stationSides = { [red.st.id]: 'red', [black.st.id]: 'black' };
  room.station = null; // no single owner: both kiosks match through `stations`
  room.createdByUs = true;
  room.setupState = 'requested';
  room.started = false;
  room.xqGameId = `web-${crypto.randomUUID()}`;
  xqGames.set(room.xqGameId, room);
  st.partyRoom = room;
  console.log(`[party] ${room.code}: ${red.st.id} (red) vs ${black.st.id} (black) — asking the engine for room ${room.xqGameId}`);
  xqPartyNotify(room, { type: 'station_game_requested' });
  broadcastLobbyGames();

  try {
    await xqPost('/api/xiangqi/pvp/v1/website/rooms', {
      room_id: room.xqGameId,
      red_device: red.st.id,
      black_device: black.st.id,
      mode: process.env.XQ_GAME_MODE === 'simulation' ? 'simulation' : 'physical',
      verify: process.env.XQ_PVP_VERIFY === 'squares' ? 'squares' : 'board',
    });
  } catch (err) {
    console.warn(`[party] ${room.code}: engine create failed: ${err.message}`);
    return xqFailParty(room, err.status === 409 ? 'busy' : 'unavailable');
  }
  room.apiCreated = true;
  if (room.cancelled || rooms.get(room.code) !== room) {
    // a player backed out while the create call was in flight
    xqPost(`/api/xiangqi/games/${encodeURIComponent(room.xqGameId)}/abort`, { event_id: crypto.randomUUID() })
      .catch((err) => console.warn(`[party] ${room.code}: late abort failed: ${err.message}`));
    return;
  }
  room.setupState = 'setting_up';
  // stations that never attach (not running, wrong mode) must not squat on the machines forever
  room.setupTimer = setTimeout(() => {
    if (room.started || rooms.get(room.code) !== room) return;
    console.warn(`[party] ${room.code}: stations never started the game — timing out`);
    xqFailParty(room, 'timeout'); // also aborts it on the engine
  }, XQ_SETUP_TIMEOUT_MS);
  room.setupTimer.unref();
}

// The party never became a game (or was cancelled): tell both screens and free everything.
function xqFailParty(room, reason) {
  if (room.failed) return;
  room.failed = true;
  xqPartyNotify(room, { type: 'station_game_failed', reason });
  if (room.xqGameId && reason !== 'busy') {
    // the create call may have succeeded even if we saw an error (a timeout): end it, or the next poll
    // re-adopts it as ours and starts a game nobody is waiting for. Aborting an absent room is a harmless 404.
    xqPost(`/api/xiangqi/games/${encodeURIComponent(room.xqGameId)}/abort`, { event_id: crypto.randomUUID() })
      .catch((err) => { if (err.status !== 404) console.warn(`[party] ${room.code}: abort failed: ${err.message}`); });
  }
  if (rooms.get(room.code) === room) rooms.delete(room.code);
  for (const peer of room.callPeers || []) if (peer.room === room) { peer.room = null; peer.playerLetter = null; }
  const host = room.players.A;
  if (host && host.room === room) {
    // never paired: the host is still seated in a waiting party — send them back to the lobby
    host.room = null;
    host.playerLetter = null;
    if (!host.destroyed) send(host, { type: 'lobby' });
  }
  xqPartyDone(room);
  broadcastLobbyGames();
}

// Release the machines and the video pair once the party is over (finished, failed or never paired).
function xqPartyDone(room) {
  clearTimeout(room.partyTimer);
  clearTimeout(room.setupTimer);
  for (const st of xqStations) {
    if (st.partyRoom === room) st.partyRoom = null;
    if (st.room === room && !room.started) { st.room = null; st.gameId = null; }
  }
  if (room.xqGameId) xqGames.delete(room.xqGameId);
  for (const peer of room.callPeers || []) {
    if (peer.callRoom !== room) continue;
    peer.callRoom = null;
    if (!peer.destroyed) sendJSON(peer, { type: 'call_end' });
  }
}

// Tell both screens of a paired party who they are calling and which role they take. Sent at pairing and
// again when one screen reconnects, so both sides drop the old connection and negotiate afresh.
function xqCallAnnounce(room) {
  for (const peer of room.callPeers || []) {
    const role = room.callRoles && room.callRoles[peer.kioskStation];
    if (role && !peer.destroyed) sendJSON(peer, { type: 'call_peer', polite: role.polite, name: role.peer });
  }
}

// Abort the website-started game on a kiosk's station (player left, session
// ended, resign). Operator-started games are never aborted by us. If the arm
// is mid-move the engine answers abort_pending and finishes after the move —
// the kiosk hears about it and the watcher closes the room when it lands.
function xqAbortStationGame(stationId, why) {
  const st = xqStationByDevice(XQ_STATION_MAP[stationId]);
  if (!st) return;
  if (!st.requested && !st.partyRoom && !(st.room && st.room.createdByUs)) return;
  const party = st.partyRoom || (st.room && st.room.physical ? st.room : null);
  if (party && !party.createdByUs) {
    // still waiting for a joiner: nothing exists on the engine yet
    return xqFailParty(party, 'aborted');
  }
  if (party && !party.started) {
    // Not playing yet: clean up here, never wait for the watcher — an engine room aborted during setup may
    // never be seen by it, which would leave both machines held. xqFailParty also aborts it on the engine.
    if (!party.apiCreated) party.cancelled = true; // create call in flight — its .then() aborts it too
    return xqFailParty(party, 'aborted');
  }
  const gameId = st.gameId || st.expectedGameId || (party && party.xqGameId);
  if (!gameId) {
    // create call still in flight — mark it dead locally; the watcher's
    // timeout/failed path will not resurrect it
    if (st.requested) xqFailRequest(st, 'aborted');
    return;
  }
  console.log(`[xq] ${st.id}: aborting game ${gameId} (${why})`);
  // an explicit end on the player's own turn is a resignation — a recorded
  // loss is more honest than a null result. Outside their turn (or if the
  // turn moved on mid-click, 409), it's a plain abort.
  const room = st.room || party;
  // a party game: the leaving player's side resigns (the engine refuses before play starts,
  // and while the arm is mid-step — both fall back to a plain abort below)
  const pvpSide = party && party.stationSides ? party.stationSides[st.id] : null;
  const canResign = party
    ? !!(party.started && pvpSide)
    : room && room.createdByUs && room.turn === (room.humanLetter || 'A');
  const ending = (res) => {
    if (res && res.abort_pending) {
      const kiosk = kioskFor(stationId);
      if (kiosk) sendJSON(kiosk, { type: 'station_game_ending' });
    }
  };
  const abort = () => xqPost(`/api/xiangqi/games/${encodeURIComponent(gameId)}/abort`, { event_id: crypto.randomUUID() })
    .then(ending)
    .catch((err) => console.warn(`[xq] ${st.id}: abort failed: ${err.message}`));
  if (!canResign) return abort();
  // Leaving a two-machine game is a resignation. The engine refuses it (409) only while an arm is
  // mid-step, which lasts seconds — so keep trying for a while before settling for a no-result abort.
  // A bot game's resign is refused when it is no longer the player's turn: abort straight away there.
  const resignId = crypto.randomUUID(); // one user action; a refused attempt records nothing
  const body = pvpSide ? { event_id: resignId, side: pvpSide } : { event_id: resignId };
  const tryResign = (attempt) => xqPost(`/api/xiangqi/games/${encodeURIComponent(gameId)}/resign`, body)
    .then(ending)
    .catch((err) => {
      if (err.status === 409 && pvpSide && attempt < XQ_RESIGN_RETRIES) {
        if (attempt === 0) console.log(`[xq] ${st.id}: resign waits for the arm to finish its step`);
        return new Promise((r) => setTimeout(r, 2000)).then(() => tryResign(attempt + 1));
      }
      if (err.status === 409) {
        console.log(`[xq] ${st.id}: resign refused — aborting instead`);
        return abort();
      }
      console.warn(`[xq] ${st.id}: end-game call failed: ${err.message}`);
    });
  return tryResign(0);
}
// ~30 s of retries: longer than any single Dobot step, short enough that a walk-away still ends the game
const XQ_RESIGN_RETRIES = Number(process.env.XQ_RESIGN_RETRIES) || 15;

// The watcher tracks a requested game by id until it starts (or dies).
function xqApplyRequested(st, g) {
  const req = st.requested;
  const room = req.room;
  if (g.phase === 'failed') {
    console.warn(`[xq] ${st.id}: game setup failed (${g.failure_reason || 'unknown'})`);
    return xqFailRequest(st, g.failure_reason || 'failed');
  }
  if (g.phase === 'aborted' || (g.phase === 'finished' &&
      (g.result_reason === 'website_abort' || g.result_reason === 'operator_restart'))) {
    // aborted by us (player left) or by the operator — either way, no result. The screen that asked is
    // still on "setting up" (it only watches a game once it is live), so tell it directly.
    if (req.socket && !req.socket.destroyed) send(req.socket, { type: 'station_game_failed', reason: 'aborted' });
    st.room = room;
    st.gameId = g.id;
    xqGames.set(g.id, room);
    st.requested = null;
    st.expectedGameId = null;
    return xqFinishRoom(st, {}, 'aborted');
  }
  if (g.phase === 'setup' || g.phase === 'setting_up') {
    // engine is preparing the board. The asking screen is not watching yet, so a board the camera
    // rejects (wrong start, or no stable complete view) goes straight to it, and so does the fix.
    xqSetupProblem(req, g, (msg) => {
      if (req.socket && !req.socket.destroyed) send(req.socket, msg);
    });
    return;
  }
  // playing (or already finished): attach and hand to the normal flow
  st.requested = null;
  st.expectedGameId = null;
  room.setupState = 'playing';
  room.started = true;
  room.turn = g.turn === 'black' ? 'B' : 'A';
  st.room = room;
  st.gameId = g.id;
  xqGames.set(g.id, room);
  recordGameStart(room);
  room.moves = (g.moves || []).map(xqRoomMove).filter(Boolean);
  xqSyncError(room, g);
  console.log(`[xq] ${st.id}: website game ${g.id} live as room ${room.code}`);
  broadcastLobbyGames();
  kioskAutoWatch(room);
  if (g.phase === 'finished') xqFinishRoom(st, g, 'over');
}

// Board trouble during setup (reader-2: phase setup + paused/error — the station's camera saw a
// wrong starting position, or no complete stable board). `holder` remembers the last detail so a
// screen hears each new problem once and station_setup_ok once when it clears. The detail is the
// station's own text (Chinese, physical square names); we pass it through untouched.
function xqSetupProblem(holder, g, notify) {
  const detail = g.paused || g.error ? String(g.error || 'board not ready') : null;
  if (detail && detail !== holder.setupProblem) notify({ type: 'station_setup_problem', detail });
  else if (!detail && holder.setupProblem) notify({ type: 'station_setup_ok' });
  holder.setupProblem = detail;
}

// Surface camera trouble to everyone watching (and clear it when it clears).
// sync_error is the structured form; a paused game or a plain error string
// mean the same thing to a player: stop and fix the board.
function xqSyncError(room, g) {
  const err =
    g.sync_error ||
    (g.error ? { detail: String(g.error) } : null) ||
    (g.paused ? { detail: 'game paused' } : null);
  const had = room.syncError || null;
  if (err && !had) {
    specSend(room, { type: 'sync_error', detail: err.detail || 'board mismatch' });
  } else if (!err && had) {
    specSend(room, { type: 'sync_ok' });
  }
  room.syncError = err;
}

// A rejected physical move (illegal placement) — transient: appears while
// the board is wrong, clears when the player puts the piece back.
function xqRejectedMove(room, g) {
  const rej = g.rejected_move || null;
  if (rej && !room.rejectedMove) {
    specSend(room, { type: 'move_rejected', detail: rej.detail || null });
  } else if (!rej && room.rejectedMove) {
    specSend(room, { type: 'reject_clear' });
  }
  room.rejectedMove = rej;
}

// A new game appeared on this station: build the virtual room and seed it
// with any moves already played (joining mid-game is normal for us).
// PvP rooms carry their stations with sides; called at adoption and again
// when a waiting room's opponent joins (the second station appears then).
function xqApplyPvpStations(room, g) {
  if (!Array.isArray(g.stations)) return;
  room.stations = [];
  room.stationSides = {};
  for (const s of g.stations) {
    // guest stations have no registered name — show them as "Guest"
    const name = String(s.device_id).startsWith('guest-')
      ? 'Guest'
      : (xqStationByDevice(s.device_id) || {}).name || s.device_id;
    // a party room knows who is sitting at each machine; the machine's name is only the fallback
    room.players[s.side === 'black' ? 'B' : 'A'] = (room.partyPlayers && room.partyPlayers[s.side === 'black' ? 'black' : 'red'])
      || { playerName: name, playerUid: null };
    room.stations.push(s.device_id);
    room.stationSides[s.device_id] = s.side;
  }
  room.station = null; // no single owner — both kiosks match via stations
}

function xqStartRoom(st, gameId, g) {
  // PvP rooms carry both stations with sides; a waiting_partner room has one.
  const isPvp = g.mode === 'pvp' && Array.isArray(g.stations);
  // not playing yet: a PvP room waiting for its partner, or any game whose boards are still being set up
  const waiting = g.phase === 'waiting_partner' || g.phase === 'setup';
  // web- ids are only ever created by this website. After a restart we have no memory of the game, but it
  // is still ours: take it back so its kiosks follow it again and its End-game button can end it —
  // otherwise both machines stay "busy" with a game nobody controls.
  const ours = String(gameId).startsWith('web-');
  const room = createRoom(!isPvp, 'xiangqi');
  room.noClock = true; // his engine has no clocks
  room.station = st.id;
  room.stations = [st.id];
  xqGames.set(gameId, room);
  room.initialFen = xqBoardToFen(g.initial_board); // custom openings render from this
  if (isPvp) {
    xqApplyPvpStations(room, g);
  } else {
    // display-only pseudo players: the station's human takes THEIR side
    // (red = A, black = B — the bot moves first against black), the bot the
    // other slot. Sides are recorded so kiosks render the right POV.
    const humanLetter = g.human_side === 'black' ? 'B' : 'A';
    const botLetter = humanLetter === 'A' ? 'B' : 'A';
    room.players[humanLetter] = { playerName: st.name, playerUid: null };
    room.players[botLetter] = { playerName: 'robot', playerUid: null };
    room.stationSides = { [st.id]: g.human_side === 'black' ? 'black' : 'red' };
    if (ours) {
      room.station = XQ_DEVICE_TO_STATION[st.id] || st.id; // the KIOSK id, as for a fresh request
      room.deviceId = st.id;
      room.humanLetter = humanLetter;
    }
  }
  if (ours) {
    room.createdByUs = true;
    room.setupState = waiting ? 'setting_up' : 'playing';
    if (isPvp) {
      room.physical = true;
      room.xqGameId = gameId;
      room.apiCreated = true;
    }
    if (waiting) {
      // the setup timer died with the old process: one that never starts must still free the machines
      room.setupTimer = setTimeout(() => {
        if (room.started || rooms.get(room.code) !== room) return;
        console.warn(`[xq] ${st.id}: recovered game ${gameId} never started — aborting it`);
        xqPost(`/api/xiangqi/games/${encodeURIComponent(gameId)}/abort`, { event_id: crypto.randomUUID() })
          .catch((err) => console.warn(`[xq] ${st.id}: abort of recovered game failed: ${err.message}`));
      }, XQ_SETUP_TIMEOUT_MS);
      room.setupTimer.unref();
    }
  }
  room.started = !waiting;
  st.room = room;
  st.gameId = gameId;
  room.turn = g.turn === 'black' ? 'B' : 'A'; // turn arrives as a side
  // a waiting room isn't recorded yet — the game begins when play does
  if (!waiting) {
    recordGameStart(room); // resets room.moves
    const seed = (g.moves || []).map(xqRoomMove).filter(Boolean);
    room.moves = seed;
    if (db && room.gameReady && seed.length) {
      room.gameReady.then(() => {
        if (room.gameId) {
          db.collection('games').doc(room.gameId).update({ moves: seed })
            .catch((err) => console.warn(`[xq] seed record failed: ${err.message}`));
        }
      });
    }
  }
  console.log(`[xq] ${st.id}: watching game ${gameId} as room ${room.code} (${room.moves.length} moves so far${waiting ? ', not started yet' : ''}${ours ? ', ours — recovered after a restart' : ''})`);
  broadcastLobbyGames(); // a new watchable game appeared
  if (!waiting) kioskAutoWatch(room); // the station's own screen follows its game
}

function xqApplyState(st, g) {
  const room = st.room;
  // staleness watchdog: the operator reset the board, or the camera is stuck
  // — either way the game is dead. A dark station program (online:false —
  // its heartbeat stopped) gets a much shorter leash than a live one.
  // Only PLAYING games are watchdog-eligible: a waiting_partner room is
  // supposed to sit still (nobody is moving pieces yet).
  const staleMs = st.online === false ? XQ_OFFLINE_STALE_MS : XQ_STALE_MS;
  const watchdogApplies = !room.createdByUs || st.online === false;
  if (watchdogApplies && g.phase === 'playing' && g.updatedAt && Date.now() - Number(g.updatedAt) > staleMs) {
    // remember the dead game so we don't resurrect it on the next poll (his
    // device endpoint only stops reporting it when a game is FINISHED)
    // (on every station: the other station of a shared PvP game must not re-adopt it either)
    for (const other of xqStations) {
      other.abandonedGames.set(st.gameId, g.updatedAt ?? null);
      // the other machine of a shared game stops at the abandoned check and would keep pointing here
      if (other !== st && other.room === room) { other.room = null; other.gameId = null; }
    }
    console.log(`[xq] ${st.id}: game ${st.gameId} stale for >${Math.round(staleMs / 1000)}s — abandoning`);
    if (room.createdByUs && String(st.gameId).startsWith('web-')) {
      // ours: end it on the engine too, or both machines stay claimed by a dead game and every new
      // website game is refused as busy. Operator games are never ended by us.
      xqPost(`/api/xiangqi/games/${encodeURIComponent(st.gameId)}/abort`, { event_id: crypto.randomUUID() })
        .catch((err) => console.warn(`[xq] ${st.id}: abort of stale game failed: ${err.message}`));
    }
    xqFinishRoom(st, {}, 'abandoned');
    return;
  }
  // (Two-machine party rooms need no station_setup_problem: their opening check reads as playing, and
  // an engine with accepts_attention reports a wrong opening as paused + error naming the side
  // ("红方棋盘：…"), which xqSyncError below shows on both kiosks and clears when it is fixed.)
  // a waiting PvP room whose opponent just joined becomes a live game
  if (!room.started && g.phase === 'playing') {
    xqApplyPvpStations(room, g); // the second station appears only now
    room.started = true;
    room.setupState = 'playing'; // a party room joins the lobby's live list now
    room.turn = g.turn === 'black' ? 'B' : 'A';
    clearTimeout(room.setupTimer);
    recordGameStart(room);
    room.moves = [];
    console.log(`[xq] ${st.id}: game ${st.gameId} started (opponent joined)`);
    broadcastLobbyGames();
    kioskAutoWatch(room);
  }
  const moves = (g.moves || []).map(xqRoomMove).filter(Boolean);
  if (moves.length < room.moves.length) {
    // should never happen; his moves list is append-only
    console.warn(`[xq] ${st.id}: move list shrank (${room.moves.length} -> ${moves.length}), resyncing`);
    room.moves = moves;
    return;
  }
  // One poll can carry both new moves and a pause change. A pause that CLEARED happened before
  // those moves (play resumed), so clear the overlay first; a NEW pause came after them, so it goes last.
  const pausedNow = !!(g.sync_error || g.error || g.paused);
  if (!pausedNow) xqSyncError(room, g);
  for (let i = room.moves.length; i < moves.length; i++) {
    const m = moves[i];
    room.turn = m.by === 'A' ? 'B' : 'A';
    console.log(`[xq] ${st.id}: move ${m.move} by ${m.by} (room ${room.code})`);
    specSend(room, { type: 'move_applied', move: m.move, by: m.by });
    specSend(room, { type: 'turn', player: room.turn });
    recordMove(room, m.move, m.by, m.captured);
  }
  if (pausedNow) xqSyncError(room, g);
  xqRejectedMove(room, g);
  // aborts (ours or the operator's) land as finished + a reason — no winner
  const aborted =
    g.phase === 'finished' &&
    (g.result_reason === 'website_abort' || g.result_reason === 'operator_restart');
  if (aborted) xqFinishRoom(st, g, 'aborted');
  else if (g.phase === 'finished') xqFinishRoom(st, g, 'over');
  else if (g.phase === 'aborted') xqFinishRoom(st, g, 'aborted');
}

function xqFinishRoom(st, g, status) {
  const room = st.room;
  if (!room) return;
  if (rooms.get(room.code) !== room) {
    // already finished via the other station of a shared (PvP) game
    st.room = null;
    st.gameId = null;
    return;
  }
  let winner = null;
  if (status === 'over') winner = xqWinnerLetter(g);
  if (status === 'over') {
    specSend(room, { type: 'game_over', winner });
    recordGameOver(room, winner, 'over');
    rooms.delete(room.code);
    room.finishedAt = Date.now(); // kiosks let the result breathe before following
    // Let spectators actually SEE the result before the stream closes —
    // spec_end immediately after game_over hides the panel in the same
    // instant. Only close watchers still on THIS room (a new game may have
    // already pulled the kiosk onto the next one).
    const watchers = [...room.spectators];
    setTimeout(() => {
      for (const s of watchers) {
        if (!s.destroyed && s.watching === room) {
          sendJSON(s, { type: 'spec_end' });
          s.watching = null;
        }
      }
    }, 8000).unref();
  } else {
    specSend(room, { type: 'spec_end' });
    recordGameOver(room, null, 'abandoned');
    rooms.delete(room.code);
    // The stream is over for its watchers too: a kiosk left "watching" a deleted room is refused every
    // new game ("already in a room") and every tap (busy) until the server restarts.
    for (const s of room.spectators) if (s.watching === room) s.watching = null;
    room.spectators.clear();
  }
  console.log(`[xq] ${st.id}: game ${st.gameId} ${status} (winner ${winner || '—'})`);
  if (room.physical) {
    // aborted before play began: both screens are still on "setting up" and need to hear it
    if (!room.started && !room.failed) xqPartyNotify(room, { type: 'station_game_failed', reason: 'aborted' });
    xqPartyDone(room);
  }
  xqGames.delete(st.gameId);
  st.room = null;
  st.gameId = null;
  broadcastLobbyGames();
}

async function xqPollStation(st) {
  // a website-requested game is tracked by id directly — the device endpoint
  // may not report it during setup, and stops reporting it once failed/aborted
  if (st.requested && st.expectedGameId) {
    let g;
    try {
      g = await xqGet(`/api/xiangqi/games/${encodeURIComponent(st.expectedGameId)}`);
    } catch (err) {
      return xqStationError(st, err);
    }
    if (st.reachable === false) console.log(`[xq] ${st.id}: reachable again`);
    st.reachable = true;
    return xqApplyRequested(st, g);
  }

  let info;
  try {
    info = await xqGet(`/api/xiangqi/devices/${encodeURIComponent(st.id)}`);
  } catch (err) {
    return xqStationError(st, err);
  }
  if (st.reachable === false) console.log(`[xq] ${st.id}: reachable again`);
  st.reachable = true;
  // online = the station's terminal program heartbeat, not the camera/arm —
  // false with an active game means the station crashed or was closed
  st.online = info.online !== false;
  // his API allows several unfinished games per device (the station normally
  // ends the old one first) — worth a warning when it happens
  const unfinished = info.unfinished_game_ids || [];
  if (unfinished.length > 1) {
    console.warn(`[xq] ${st.id}: ${unfinished.length} unfinished games at once (${unfinished.join(', ')})`);
  }

  const gameId = info.active_game_id;
  if (!gameId) {
    if (st.room) {
      // One last read before giving up: the game may have FINISHED between
      // polls (his device endpoint nulls active_game_id the moment it's
      // done), and we don't want to lose the result as "abandoned".
      try {
        const g = await xqGet(`/api/xiangqi/games/${encodeURIComponent(st.gameId)}`);
        if (g.phase === 'finished') xqApplyState(st, g); // finishes the room properly
        else xqFinishRoom(st, {}, 'abandoned');
      } catch {
        xqFinishRoom(st, {}, 'abandoned');
      }
    }
    return;
  }
  let g;
  try {
    g = await xqGet(`/api/xiangqi/games/${encodeURIComponent(gameId)}`);
  } catch (err) {
    return xqStationError(st, err);
  }
  if (!st.room && g.phase === 'finished') {
    // the game ended before we ever saw it (our server was down, the tunnel
    // flapped…). Record it directly so replays aren't lost, but don't open
    // a watchable room for a game that's already over.
    if (st.lastRecordedGameId !== gameId) {
      st.lastRecordedGameId = gameId;
      xqRecordUnseen(st, gameId, g);
    }
    return;
  }
  // a game we already abandoned stays dead until its updatedAt moves (new
  // activity) — otherwise we'd resurrect the same ghost every poll
  const deadAt = st.abandonedGames.get(gameId);
  if (deadAt !== undefined && deadAt === (g.updatedAt ?? null)) return;
  st.abandonedGames.delete(gameId);

  if (!st.room || st.gameId !== gameId) {
    const shared = xqGames.get(gameId);
    if (shared) {
      // PvP: both stations report the same game — attach, never recreate.
      // The second station is the opponent (black), not a robot.
      st.room = shared;
      st.gameId = gameId;
      if (!shared.stations.includes(st.id)) shared.stations.push(st.id);
      if (shared.solo) {
        shared.solo = false;
        shared.players.B = { playerName: st.name, playerUid: null };
      }
      console.log(`[xq] ${st.id}: joined shared game ${gameId} (room ${shared.code})`);
    } else {
      xqStartRoom(st, gameId, g);
    }
  }
  xqApplyState(st, g);
}
// A finished game we never watched: write it straight to the recordings.
function xqRecordUnseen(st, gameId, g) {
  if (!db) return;
  const moves = (g.moves || []).map(xqRoomMove).filter(Boolean);
  const winner = xqWinnerLetter(g);
  db.collection('games').add({
    code: null,
    solo: true,
    gameType: 'xiangqi',
    names: { A: st.name, B: 'robot' },
    uids: { A: null, B: null },
    minutes: null,
    initialFen: xqBoardToFen(g.initial_board),
    moves,
    startedAt: fsFieldValue.serverTimestamp(),
    endedAt: fsFieldValue.serverTimestamp(),
    status: 'over',
    result: winner,
  })
    .then(() => console.log(`[xq] ${st.id}: recorded unseen finished game ${gameId} (${moves.length} moves)`))
    .catch((err) => console.warn(`[xq] ${st.id}: record unseen failed: ${err.message}`));
}

// "Offline" means no Firebase (guest kiosk, no accounts) — it says nothing
// about the engine. The venue Pi is offline in that sense yet still has to
// command its own machine, so configuring the XQ_* vars is what enables the
// watcher, in either mode.
function xqConfigured() {
  return !!(XQ_API_BASE && XQ_READER_KEY && XQ_READER_ID && xqStations.length > 0);
}

function startStationWatcher() {
  if (!XQ_API_BASE && xqStations.length === 0) return; // not configured at all
  if (!xqConfigured()) {
    console.warn('[xq] station watcher disabled — need XQ_API_BASE, XQ_READER_ID, XQ_READER_KEY, XQ_DEVICES');
    return;
  }
  console.log(`[xq] station watcher: ${xqStations.map((s) => s.id).join(', ')} via ${XQ_API_BASE}, every ${XQ_POLL_MS}ms`);
  xqCheckContract(); // gates website game control on the reader-2 contract
  for (const st of xqStations) {
    st.room = null;
    st.gameId = null;
    st.reachable = null;
    st.lastRecordedGameId = null;
    st.partyRoom = null; // a website party (waiting for a joiner, or seated and setting up) holding this machine
    st.requested = null; // { key, room, socket } while a website game is pending
    st.expectedGameId = null; // the id his engine assigned to our request
    st.abandonedGames = new Map(); // gameId -> updatedAt when we gave up on it
    const tick = () => {
      xqPollStation(st)
        .catch((err) => xqStationError(st, err))
        .finally(() => setTimeout(tick, XQ_POLL_MS));
    };
    setTimeout(tick, 500);
  }
}

// ---------------------------------------------------------------------------
// WebSocket framing (RFC 6455)
// ---------------------------------------------------------------------------

// Send an unmasked server frame. opcode: 0x1 text, 0x8 close, 0xA pong.
function sendFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!socket.destroyed) socket.write(Buffer.concat([header, data]));
}

// Incremental frame parser. Calls handlers for complete frames.
function makeFrameParser(socket, handlers) {
  let buf = Buffer.alloc(0);

  return function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const opcode = b0 & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) {
          handlers.onProtocolError('frame too large');
          return;
        }
        len = Number(big);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;

      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      }
      buf = buf.subarray(offset + maskLen + len);

      switch (opcode) {
        case 0x1: handlers.onText(payload.toString('utf8')); break;
        case 0x0: break; // continuation frame: ignore gracefully
        case 0x8: handlers.onClose(); return;
        case 0x9: sendFrame(socket, 0xA, payload); break; // ping -> pong
        case 0xA: socket.lastPong = Date.now(); break; // pong: heartbeat proof
        default: break; // unknown opcode: ignore
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Lobby and room model
// ---------------------------------------------------------------------------
// Every connected socket starts in the lobby. A room is
// { code, solo, players: { A: socket|null, B: socket|null } }; a socket in a
// room carries .room and .playerLetter. In a solo room only A is a human;
// the CLI referee drives the robot as "B". The quick-match queue holds lobby
// sockets waiting for a partner.

const clients = new Set();
const rooms = new Map();
const quickQueue = [];

function otherLetter(letter) {
  return letter === 'A' ? 'B' : 'A';
}

function sendJSON(socket, obj) {
  if (socket && !socket.destroyed) sendFrame(socket, 0x1, JSON.stringify(obj));
}

function label(socket) {
  return socket.room ? `${socket.room.code}/${socket.playerLetter}` : 'lobby';
}

function logEvent(target, obj) {
  console.log(`[event] -> ${target}: ${JSON.stringify(obj)}`);
}

function send(socket, obj) {
  logEvent(label(socket), obj);
  sendJSON(socket, obj);
}

// ---------------------------------------------------------------------------
// Spectators + game recording (Phase 6)
// ---------------------------------------------------------------------------
// Spectators attach to a room read-only and receive a neutral-perspective
// event stream (player letters instead of you/opponent). Every game that
// starts is recorded to Firestore games/ — moves appended as they happen,
// finalized on game_over, marked abandoned if the room dies mid-game.

function specSend(room, obj) {
  for (const s of room.spectators) {
    if (!s.destroyed) sendJSON(s, obj);
  }
}

function roomNames(room) {
  return {
    A: (room.players.A && room.players.A.playerName) || 'player A',
    // the bot slot carries the name "robot" explicitly since a human may
    // play black (B) in station games
    B: (room.players.B && room.players.B.playerName) || (room.solo ? 'robot' : 'player B'),
  };
}

// The spectator catch-up snapshot — also what an auto-attached station kiosk
// receives when its game starts.
function specStateMsg(room) {
  return {
    type: 'spec_state',
    code: room.code,
    solo: room.solo,
    gameType: room.gameType,
    names: roomNames(room),
    variant: room.variant || null,
    minutes: room.noClock ? null : room.clockMinutes || 5,
    initialFen: room.initialFen || null,
    station: room.station || null, // set on virtual (station-watcher) rooms
    stations: room.stations || null, // shared games list both stations
    stationSides: room.stationSides || null, // PvP: device id -> red|black
    createdByUs: !!room.createdByUs, // website-started: the kiosk may end it
    syncError: room.syncError ? (room.syncError.detail || 'board mismatch') : null,
    turn: room.turn,
    moves: room.moves,
    status: room.started ? 'playing' : 'waiting',
  };
}

function recordGameStart(room) {
  room.moves = [];
  if (!db) return;
  const names = roomNames(room);
  // gameReady gates all writes for this game: the document id arrives
  // asynchronously, and fast games (robot moves!) must not lose early moves.
  room.gameReady = db.collection('games')
    .add({
      code: room.code,
      solo: room.solo,
      gameType: room.gameType,
      variant: room.variant || null,
      names,
      uids: {
        A: (room.players.A && room.players.A.playerUid) || null,
        B: room.solo ? null : (room.players.B && room.players.B.playerUid) || null,
      },
      minutes: room.noClock ? null : room.clockMinutes || 5, // station games have no clock
      initialFen: room.initialFen || null, // xiangqi custom openings
      startedAt: fsFieldValue.serverTimestamp(),
      status: 'playing',
      result: null,
      moves: [],
    })
    .then((ref) => {
      room.gameId = ref.id;
    })
    .catch((err) => console.warn(`[games] record start failed: ${err.message}`));
}

function recordMove(room, move, by, captured) {
  const entry = captured ? { move, by, captured } : { move, by };
  room.moves.push(entry);
  if (!db || !room.gameReady) return;
  room.gameReady.then(() => {
    if (!room.gameId) return;
    db.collection('games')
      .doc(room.gameId)
      .update({ moves: fsFieldValue.arrayUnion(entry) })
      .catch((err) => console.warn(`[games] record move failed: ${err.message}`));
  });
}

function recordGameOver(room, winner, status) {
  if (!db || !room.gameReady) return;
  room.gameReady.then(() => {
    if (!room.gameId) return;
    db.collection('games')
      .doc(room.gameId)
      .update({ status, result: winner, endedAt: fsFieldValue.serverTimestamp() })
      .catch((err) => console.warn(`[games] record end failed: ${err.message}`));
    room.gameId = null; // a rematch records a fresh document
    room.gameReady = null;
  });
}

// Whether a socket is watching a room that is still live. A room that has finished (a result still on
// screen, or one that ended some way that never cleared the link) no longer counts: it is detached here,
// so starting a new game, watching another one or a card tap is never refused because of it.
function watchingLive(socket) {
  const room = socket.watching;
  if (!room) return false;
  if (rooms.get(room.code) === room) return true;
  detachSpectator(socket);
  return false;
}

function detachSpectator(socket) {
  const room = socket.watching;
  if (!room) return;
  room.spectators.delete(socket);
  socket.watching = null;
  console.log(`[spec] ${socket.playerName || 'client'} stopped watching ${room.code} (${room.spectators.size} left)`);
  broadcastLobbyGames(); // spectator count changed
}

// ---------------------------------------------------------------------------
// Lobby games list (live push to spectators)
// ---------------------------------------------------------------------------

function lobbyGames() {
  return [...rooms.values()]
    .filter((r) => r.players.A) // has at least a host
    // website-requested games appear only once they're actually playing —
    // a "setting up" room is not watchable yet
    .filter((r) => !(r.createdByUs && r.setupState !== 'playing'))
    // a party waiting for its joiner is not a game yet (it lives on a machine, not in the lobby)
    .filter((r) => !(r.physical && !r.createdByUs))
    .map((r) => ({
      code: r.code,
      solo: r.solo,
      gameType: r.gameType,
      variant: r.variant || null,
      station: r.station || null,
      names: roomNames(r),
      minutes: r.noClock ? null : r.clockMinutes || 5,
      status: r.started ? 'playing' : 'waiting',
      spectators: r.spectators.size,
    }));
}

// Push the current list to every lobby client (not in a room, not watching).
// sendJSON directly — this fires on every room change, so keep it out of the
// event log.
function broadcastLobbyGames() {
  const games = lobbyGames();
  for (const socket of clients) {
    if (!socket.room && !socket.watching && !socket.destroyed) {
      sendJSON(socket, { type: 'games', games });
    }
  }
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(solo, gameType, variant) {
  const room = {
    code: makeRoomCode(),
    solo: !!solo,
    gameType: gameType === 'xiangqi' ? 'xiangqi' : 'chess', // chess is the default
    // a special-ruleset id (e.g. "blast3x3") — carried to the station engine
    // and recordings; our server never enforces rules itself
    variant: typeof variant === 'string' && variant ? variant.slice(0, 32) : null,
    players: { A: null, B: null },
    rematchOffers: new Set(), // letters that have offered a rematch
    turn: null, // letter whose turn it is, null outside a running game
    spectators: new Set(), // read-only watcher sockets (Phase 6)
    started: false, // a game is actually in progress
    moves: [], // { move, by } in order — powers spectator catch-up + recording
    gameId: null, // Firestore games doc id while a game is being recorded
  };
  rooms.set(room.code, room);
  console.log(`[room] created ${room.code}${room.solo ? ' (solo)' : ''}`);
  return room;
}

function seatPlayer(room, socket, letter) {
  room.players[letter] = socket;
  socket.room = room;
  socket.playerLetter = letter;
  console.log(`[room] ${label(socket)} seated (${socket.remoteAddress}:${socket.remotePort})`);
}

// Both slots filled: tell each player their code, letter, and that the
// opponent is here (both sides learn it so both can start video). The
// opponent's name/uid ride along so the client can offer "add friend".
function announceRoomStart(room) {
  for (const letter of ['A', 'B']) {
    const socket = room.players[letter];
    const opp = room.players[otherLetter(letter)];
    send(socket, { type: 'room_joined', code: room.code, player: letter, minutes: room.clockMinutes || 5, gameType: room.gameType, variant: room.variant });
    send(socket, {
      type: 'opponent_connected',
      name: (opp && opp.playerName) || null,
      uid: (opp && opp.playerUid) || null,
    });
  }
  scheduleGameStart(room);
}

// Coin flip after a short settle delay: pick who moves first, tell each
// player, and send the opening turn events. Skipped if the room is gone.
function scheduleGameStart(room) {
  setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    const first = crypto.randomInt(2) === 0 ? 'A' : 'B';
    room.turn = first;
    room.started = true;
    recordGameStart(room);
    specSend(room, { type: 'game_start', first, minutes: room.clockMinutes || 5 });
    broadcastLobbyGames(); // waiting -> playing
    console.log(`[game] ${room.code} started, first move: ${first}`);
    if (room.solo) {
      const a = room.players.A;
      if (a && !a.destroyed) {
        send(a, { type: 'game_start', first: first === 'A' ? 'you' : 'opponent' });
        send(a, { type: first === 'A' ? 'your_turn' : 'opponent_turn' });
      }
      return;
    }
    for (const letter of ['A', 'B']) {
      const s = room.players[letter];
      if (!s || s.destroyed) continue;
      send(s, { type: 'game_start', first: letter === first ? 'you' : 'opponent' });
      send(s, { type: letter === first ? 'your_turn' : 'opponent_turn' });
    }
  }, 500);
}

// Free the socket's slot (leave or disconnect). A normal room survives with
// the remaining player; a later join_room reclaims the freed letter. Solo
// rooms have no one to wait for, so they are destroyed with the player.
// Empty rooms are destroyed.
//
// forfeit: a deliberate leave mid-game is a resignation — the other side
// wins (in solo rooms, the robot), spectators see the game_over, and the
// recording gets a real result instead of vanishing. A disconnect (network
// drop) is NOT a forfeit: the room waits for a rejoin.
function unseatPlayer(socket, { forfeit = false } = {}) {
  const room = socket.room;
  if (!room || !socket.playerLetter) return;
  const letter = socket.playerLetter;
  const other = room.players[otherLetter(letter)];
  room.players[letter] = null;
  room.rematchOffers.clear();
  console.log(`[room] ${label(socket)} left${forfeit ? ' (forfeit)' : ''}`);
  specSend(room, { type: 'player_left', player: letter });
  socket.room = null;
  socket.playerLetter = null;

  if (forfeit && room.started && room.turn !== null) {
    const winner = room.solo ? 'B' : otherLetter(letter);
    room.turn = null;
    if (!room.solo && other && !other.destroyed) {
      send(other, { type: 'game_over', result: 'win' });
    }
    specSend(room, { type: 'game_over', winner });
    recordGameOver(room, winner, 'over');
  }

  if (room.solo) {
    specSend(room, { type: 'spec_end' });
    if (room.gameId) recordGameOver(room, null, 'abandoned');
    rooms.delete(room.code);
    console.log(`[room] destroyed ${room.code} (solo game over)`);
    broadcastLobbyGames();
    return;
  }
  const remaining = room.players.A || room.players.B;
  if (remaining && !remaining.destroyed) {
    // a forfeit already told them they won; a disconnect still means "wait"
    if (!forfeit) send(remaining, { type: 'opponent_disconnected' });
  } else {
    specSend(room, { type: 'spec_end' });
    if (room.gameId) recordGameOver(room, null, 'abandoned');
    rooms.delete(room.code);
    if (room.physical && !room.createdByUs) xqPartyDone(room); // host left a waiting party
    console.log(`[room] destroyed ${room.code} (empty)`);
  }
  broadcastLobbyGames();
}

function removeFromQueue(socket) {
  const i = quickQueue.indexOf(socket);
  if (i !== -1) {
    quickQueue.splice(i, 1);
    console.log(`[lobby] removed from quick-match queue (${quickQueue.length} waiting)`);
  }
}

function alreadyInRoom(socket) {
  send(socket, { type: 'error', detail: 'already in a room' });
}

function handleClientMessage(socket, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.log(`[lobby] non-JSON from ${label(socket)}, ignored`);
    return;
  }
  const type = msg && msg.type;

  switch (type) {
    case 'quick_match': {
      // no strangers at a physical machine — a quick-matched opponent would
      // be an unknown person moving real pieces at a venue
      if (socket.kioskStation) {
        return send(socket, { type: 'error', detail: 'quick match is not available on machines' });
      }
      if (socket.room) return alreadyInRoom(socket);
      // remember the requested game; the player who waited first picks it
      socket.wantGameType = msg.gameType === 'xiangqi' ? 'xiangqi' : 'chess';
      if (quickQueue.includes(socket)) {
        console.log('[lobby] duplicate quick_match, still waiting');
        return send(socket, { type: 'match_waiting' });
      }
      const partner = quickQueue.shift();
      if (partner && !partner.destroyed) {
        const room = createRoom(false, partner.wantGameType);
        seatPlayer(room, partner, 'A');
        seatPlayer(room, socket, 'B');
        console.log(`[lobby] quick match paired in room ${room.code}`);
        announceRoomStart(room);
        broadcastLobbyGames();
      } else {
        quickQueue.push(socket);
        console.log(`[lobby] queued for quick match (${quickQueue.length} waiting)`);
        send(socket, { type: 'match_waiting' });
      }
      break;
    }
    case 'create_room': {
      if (socket.room) return alreadyInRoom(socket);
      // a machine's party is a real two-machine game: the website seats both stations when the joiner arrives
      const partyStation = xqPartyStation(socket, msg.gameType);
      if (partyStation) return xqCreateParty(socket, partyStation);
      removeFromQueue(socket);
      const room = createRoom(false, msg.gameType, msg.variant);
      // Time control chosen on the home screen; shared with the joiner via
      // room_joined so both clocks agree.
      const min = Number(msg.minutes);
      room.clockMinutes = min >= 1 && min <= 60 ? Math.round(min) : 5;
      seatPlayer(room, socket, 'A');
      send(socket, { type: 'room_created', code: room.code });
      broadcastLobbyGames(); // a waiting game is now watchable
      break;
    }
    case 'solo': {
      if (socket.room) return alreadyInRoom(socket);
      removeFromQueue(socket);
      const room = createRoom(true, msg.gameType, msg.variant);
      seatPlayer(room, socket, 'A');
      send(socket, { type: 'room_joined', code: room.code, player: 'A', solo: true, gameType: room.gameType, variant: room.variant });
      send(socket, { type: 'opponent_connected' }); // the robot is always present
      scheduleGameStart(room);
      broadcastLobbyGames();
      break;
    }
    case 'join_room': {
      if (socket.room) return alreadyInRoom(socket);
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(socket, { type: 'error', detail: 'no such room' });
      if (room.solo) return send(socket, { type: 'error', detail: 'cannot join a solo game' });
      if (room.physical) return xqJoinParty(socket, room);
      if (room.gameType === 'xiangqi' && xqPartyStation(socket, 'xiangqi')) {
        return send(socket, { type: 'error', detail: 'join from a machine to play a physical game' });
      }
      const letter = room.players.A ? (room.players.B ? null : 'B') : 'A';
      if (!letter) return send(socket, { type: 'error', detail: 'room full' });
      removeFromQueue(socket);
      seatPlayer(room, socket, letter);
      if (room.players.A && room.players.B) announceRoomStart(room);
      break;
    }
    case 'leave_room': {
      // also the cancel path for queued quick-match and waiting party hosts
      removeFromQueue(socket);
      if (!socket.room) {
        // a party that was paired a moment ago: this player's screen is no longer seated, but leaving
        // must still end the game on both machines
        if (socket.callRoom && socket.kioskStation) xqAbortStationGame(socket.kioskStation, 'player_left');
        send(socket, { type: 'lobby' });
        return;
      }
      // a deliberate leave mid-game is a resignation
      unseatPlayer(socket, { forfeit: true });
      send(socket, { type: 'lobby' });
      break;
    }
    case 'hello': {
      // Display identity, self-reported after Firebase sign-in on the client.
      // Used for room names and the games recording — NOT a security
      // boundary (verified identity arrives with the arm-server phase).
      socket.playerName = String(msg.name || 'player').slice(0, 24);
      socket.playerUid = msg.uid ? String(msg.uid) : null;
      break;
    }
    case 'session': {
      // Link this socket to its tap session so a lost browser can be told
      // apart from a live one (grace window in the teardown path). Knowing
      // the session id is the capability; there is nothing to verify.
      socket.sessionId = String(msg.sessionId || '').slice(0, 64) || null;
      const pending = sessionTimers.get(socket.sessionId);
      if (pending) {
        clearTimeout(pending); // browser came back inside the grace window
        sessionTimers.delete(socket.sessionId);
      }
      break;
    }
    case 'kiosk_hello': {
      // a machine's touchscreen registering for login pushes
      // (demo-trust: unauthenticated — see the kiosk section comment)
      const id = String(msg.stationId || '').slice(0, 32);
      if (!id) return;
      socket.kioskStation = id;
      socket.noAutoWatch = false; // a fresh page view re-subscribes
      const prev = kioskByStation.get(id);
      if (prev && prev !== socket && !prev.destroyed) {
        // two tabs claiming one station: the newest wins every push, so the
        // older tab must say on screen that it receives nothing anymore —
        // otherwise it looks alive and nobody can tell which tab is real
        console.log(`[kiosk] station ${id}: new tab displaced the previous one`);
        sendJSON(prev, { type: 'kiosk_replaced' });
      }
      kioskByStation.set(id, socket);
      for (const room of rooms.values()) {
        if (!room.callPeers || !room.callRoles || !room.callRoles[id]) continue;
        const i = room.callPeers.findIndex((p) => p.kioskStation === id && p !== socket);
        if (i === -1) continue;
        room.callPeers[i] = socket; // the old socket is gone or displaced: this screen is the call peer now
        socket.callRoom = room;
        xqCallAnnounce(room);
      }
      console.log(`[kiosk] station ${id} registered (${kioskByStation.size} kiosk(s))`);
      // if its station already has a live game, attach immediately
      for (const room of rooms.values()) {
        // a two-machine game names its machines in `stations` (device ids), not in `station`
        const mine = room.station === id ||
          (room.stations || []).some((d) => (XQ_DEVICE_TO_STATION[d] || d) === id);
        if (mine && room.started) {
          kioskAutoWatch(room);
          break;
        }
      }
      break;
    }
    case 'kiosk_mode': {
      // the screen's delivery preference + what tap kind it's expecting,
      // chosen on the attract screen. mode: "screen" claims phone taps for
      // the display; accept narrows which tap kind is welcome right now.
      if (!socket.kioskStation) return;
      socket.kioskMode = msg.mode === 'screen' ? 'screen' : 'phone';
      socket.kioskAccept = ['card', 'phone'].includes(msg.accept) ? msg.accept : 'any';
      console.log(`[kiosk] station ${socket.kioskStation} mode: ${socket.kioskMode}, accept: ${socket.kioskAccept}`);
      break;
    }
    case 'list_games': {
      send(socket, { type: 'games', games: lobbyGames() });
      break;
    }
    case 'start_station_game': {
      // a kiosk starts a real game on its own machine (Phase 7): the website
      // commands the engine, the engine confirms and plays it out
      if (!socket.kioskStation) {
        return send(socket, { type: 'error', detail: 'only a station screen can start machine games' });
      }
      if (socket.room || watchingLive(socket)) return alreadyInRoom(socket);
      xqRequestStationGame(socket, msg);
      break;
    }
    case 'station_game_abort': {
      // the kiosk ends the website-started game on its machine (player left,
      // resign, idle lock). Operator-started games are never aborted by us.
      if (!socket.kioskStation) return;
      xqAbortStationGame(socket.kioskStation, 'player_left');
      break;
    }
    case 'watch': {
      if (socket.room) return alreadyInRoom(socket);
      if (watchingLive(socket)) return send(socket, { type: 'error', detail: 'already watching a game' });
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(socket, { type: 'error', detail: 'no such game' });
      if (room.createdByUs && room.setupState !== 'playing') {
        return send(socket, { type: 'error', detail: 'that game is still setting up' });
      }
      removeFromQueue(socket);
      socket.watching = room;
      room.spectators.add(socket);
      console.log(`[spec] ${socket.playerName || 'client'} watching ${room.code} (${room.spectators.size} watching)`);
      send(socket, specStateMsg(room));
      broadcastLobbyGames(); // spectator count changed
      break;
    }
    case 'leave_watch': {
      if (!socket.watching) {
        console.log('[spec] leave_watch from client not watching, ignored');
        return;
      }
      detachSpectator(socket);
      // a kiosk that explicitly leaves asks to stop auto-following its
      // station's games for the rest of this page view (cleared on re-register)
      if (socket.kioskStation && msg.mute) {
        socket.noAutoWatch = true;
        console.log(`[kiosk] station ${socket.kioskStation} muted auto-follow`);
      }
      send(socket, { type: 'lobby' });
      break;
    }
    case 'list_past': {
      if (!db) return send(socket, { type: 'past_games', games: [] });
      // Replays are personal, not a global archive: you see your own games
      // and your accepted friends' games — every machine game (no website
      // uids) and every stranger's game stays out of the list.
      const uid = socket.playerUid;
      if (!uid) return send(socket, { type: 'past_games', games: [] });
      db.collection('friendships')
        .where('users', 'array-contains', uid)
        .get()
        .then((frSnap) => {
          const visible = new Set([uid]);
          for (const d of frSnap.docs) {
            const f = d.data();
            if (f.status !== 'accepted') continue;
            for (const u of f.users || []) visible.add(u);
          }
          return db.collection('games')
            // newest first by startedAt (single-field index, always present);
            // the status filter runs here in JS because status+startedAt
            // would need a composite index we don't have
            .orderBy('startedAt', 'desc')
            .limit(100)
            .get()
            .then((snap) => {
              const games = snap.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .filter((g) => g.status === 'over')
                .filter((g) => visible.has(g.uids && g.uids.A) || visible.has(g.uids && g.uids.B))
                .slice(0, 20)
                .map((g) => ({
                  id: g.id,
                  names: g.names,
                  minutes: g.minutes,
                  result: g.result,
                  solo: g.solo,
                  gameType: g.gameType || 'chess',
                  moveCount: (g.moves || []).length,
                  startedAt: g.startedAt?.toMillis?.() || null,
                }));
              send(socket, { type: 'past_games', games });
            });
        })
        .catch((err) => {
          console.warn(`[games] list_past failed: ${err.message}`);
          send(socket, { type: 'past_games', games: [] });
        });
      break;
    }
    case 'get_game': {
      if (!db) return send(socket, { type: 'error', detail: 'recording unavailable' });
      db.collection('games')
        .doc(String(msg.id || ''))
        .get()
        .then((doc) => {
          if (!doc.exists) return send(socket, { type: 'error', detail: 'no such game' });
          const g = doc.data();
          send(socket, {
            type: 'game',
            id: doc.id,
            names: g.names,
            minutes: g.minutes,
            result: g.result,
            solo: g.solo,
            gameType: g.gameType || 'chess',
            initialFen: g.initialFen || null,
            moves: g.moves || [],
            startedAt: g.startedAt?.toMillis?.() || null,
          });
        })
        .catch((err) => send(socket, { type: 'error', detail: err.message }));
      break;
    }
    case 'dev_move': {
      // Testability sugar: the referee CLI has a "move" command, but the
      // browser dev panel can't reach stdin — this lets it play moves too.
      const room = socket.room;
      if (!room) return send(socket, { type: 'error', detail: 'not in a room' });
      const move = String(msg.move || '').slice(0, 8);
      if (!move) return send(socket, { type: 'error', detail: 'missing move' });
      // "as: opponent" moves as the other side — in solo rooms, the robot
      const letter =
        msg.as === 'opponent' ? otherLetter(socket.playerLetter) : socket.playerLetter;
      if (room.solo) {
        send(socket, { type: 'move_applied', move, by: letter === 'A' ? 'you' : 'opponent' });
        room.turn = otherLetter(letter);
        send(socket, { type: room.turn === 'A' ? 'your_turn' : 'opponent_turn' });
      } else {
        sendToPlayer(room, letter, { type: 'move_applied', move, by: 'you' });
        sendToPlayer(room, otherLetter(letter), { type: 'move_applied', move, by: 'opponent' });
        room.turn = otherLetter(letter);
        sendToPlayer(room, letter, { type: 'opponent_turn' });
        sendToPlayer(room, otherLetter(letter), { type: 'your_turn' });
      }
      specSend(room, { type: 'move_applied', move, by: letter });
      specSend(room, { type: 'turn', player: room.turn });
      recordMove(room, move, letter);
      break;
    }
    case 'rematch': {
      const room = socket.room;
      if (!room) return send(socket, { type: 'error', detail: 'not in a room' });
      if (room.solo) {
        console.log(`[rematch] ${label(socket)} vs robot -- robot accepts`);
        send(socket, { type: 'rematch_start' });
        scheduleGameStart(room);
        return;
      }
      const letter = socket.playerLetter;
      if (room.rematchOffers.has(letter)) {
        console.log(`[rematch] duplicate offer from ${label(socket)}, ignored`);
        return;
      }
      room.rematchOffers.add(letter);
      console.log(`[rematch] offer from ${label(socket)}`);
      if (room.rematchOffers.size === 2) {
        room.rematchOffers.clear();
        console.log(`[rematch] both players agreed in ${room.code}`);
        for (const l of ['A', 'B']) {
          const s = room.players[l];
          if (s && !s.destroyed) send(s, { type: 'rematch_start' });
        }
        scheduleGameStart(room);
      } else {
        const other = room.players[otherLetter(letter)];
        if (other && !other.destroyed) {
          send(other, { type: 'rematch_offer' });
        } else {
          console.log(`[rematch] ${label(socket)} offered, no opponent connected`);
        }
      }
      break;
    }
    case 'dev_gameover': {
      // Stub-only sugar: the real arm-server decides game over itself.
      const room = socket.room;
      if (!room) return send(socket, { type: 'error', detail: 'not in a room' });
      if (msg.result !== 'win' && msg.result !== 'lose') {
        return send(socket, { type: 'error', detail: 'result must be win or lose' });
      }
      room.rematchOffers.clear(); // a fresh game-over invalidates any pending handshake
      room.turn = null;
      console.log(`[dev] dev_gameover from ${label(socket)}: ${msg.result}`);
      send(socket, { type: 'game_over', result: msg.result });
      if (!room.solo) {
        const other = room.players[otherLetter(socket.playerLetter)];
        if (other && !other.destroyed) {
          send(other, { type: 'game_over', result: msg.result === 'win' ? 'lose' : 'win' });
        }
      }
      const winner = msg.result === 'win' ? socket.playerLetter : otherLetter(socket.playerLetter);
      specSend(room, { type: 'game_over', winner });
      recordGameOver(room, winner, 'over');
      break;
    }
    case 'dev_turn': {
      // Stub-only sugar: force whose turn it is from the browser dev panel.
      const room = socket.room;
      if (!room) return send(socket, { type: 'error', detail: 'not in a room' });
      if (msg.player !== 'me' && msg.player !== 'opponent') {
        return send(socket, { type: 'error', detail: 'player must be me or opponent' });
      }
      const letter = socket.playerLetter;
      const target = msg.player === 'me' ? letter : otherLetter(letter);
      console.log(`[dev] dev_turn from ${label(socket)}: ${msg.player} (${target} to move)`);
      if (room.solo) {
        send(socket, { type: target === 'A' ? 'your_turn' : 'opponent_turn' });
      } else {
        sendToPlayer(room, target, { type: 'your_turn' });
        sendToPlayer(room, otherLetter(target), { type: 'opponent_turn' });
      }
      room.turn = target;
      specSend(room, { type: 'turn', player: target });
      break;
    }
    case 'signal':
    case 'emotion': {
      const room = socket.room;
      if (!room) {
        // players of a physical party stay out of the room (their kiosks watch it) but still call each other
        const call = socket.callRoom;
        const peer = call && call.callPeers.find((p) => p !== socket);
        if (peer && !peer.destroyed) sendFrame(peer, 0x1, text);
        else console.log(`[relay] ${type} from lobby client, ignored`);
        return;
      }
      const other = room.players[otherLetter(socket.playerLetter)];
      if (other && !other.destroyed) {
        console.log(`[relay] ${label(socket)} -> ${label(other)}: ${text}`);
        sendFrame(other, 0x1, text); // verbatim relay
      } else {
        console.log(`[relay] ${type} from ${label(socket)}: no opponent connected`);
      }
      break;
    }
    default:
      console.log(`[lobby] ignored message type ${JSON.stringify(type)} from ${label(socket)}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket upgrade handling
// ---------------------------------------------------------------------------

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const isValid =
    req.method === 'GET' &&
    (req.headers.upgrade || '').toLowerCase() === 'websocket' &&
    typeof key === 'string' && key.trim() !== '' &&
    version === '13';

  if (!isValid) {
    console.log('[ws] rejected invalid upgrade request');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key.trim() + WS_GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );
  socket.setNoDelay(true);

  socket.room = null;
  socket.playerLetter = null;
  socket.playerName = null; // set by the client's "hello"
  socket.playerUid = null;
  socket.watching = null; // room being spectated, if any
  socket.lastPong = Date.now(); // heartbeat: see the interval below
  clients.add(socket);
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[lobby] client connected (${remote}, ${clients.size} online)`);
  send(socket, { type: 'welcome' });

  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    clients.delete(socket);
    if (socket.kioskStation && kioskByStation.get(socket.kioskStation) === socket) {
      kioskByStation.delete(socket.kioskStation);
      console.log(`[kiosk] station ${socket.kioskStation} unregistered`);
    }
    removeFromQueue(socket);
    detachSpectator(socket);
    if (socket.callRoom) {
      const peer = socket.callRoom.callPeers.find((p) => p !== socket);
      if (peer && !peer.destroyed) sendJSON(peer, { type: 'call_peer_left' });
    }
    unseatPlayer(socket);
    // A tapped-in browser that vanishes gets a grace window (phones background
    // tabs constantly); if it never re-links its session, the session ends so
    // the station frees up for the next tap. A refresh or the Disconnect
    // button never reaches here — the client ends those sessions explicitly.
    if (socket.sessionId && db) {
      const sid = socket.sessionId;
      sessionTimers.set(sid, setTimeout(() => {
        sessionTimers.delete(sid);
        findSession({ sessionId: sid })
          .then((found) => {
            if (found && found.data.used && !found.data.endedAt) {
              // a vanished browser never frees a bridge station (decoupled)
              return endBrowserSession(found, 'disconnected');
            }
          })
          .catch((err) => console.warn(`[session] grace-end failed: ${err.message}`));
      }, SESSION_GRACE_MS));
      sessionTimers.get(sid).unref?.();
    }
    console.log(`[lobby] client disconnected (${remote}, ${clients.size} online)`);
    if (!socket.destroyed) socket.destroy();
  };

  const parse = makeFrameParser(socket, {
    onText: (text) => handleClientMessage(socket, text),
    onClose() {
      sendFrame(socket, 0x8, Buffer.alloc(0));
      teardown();
    },
    onProtocolError(reason) {
      console.log(`[ws] protocol error from ${label(socket)} (${remote}): ${reason}`);
      teardown();
    },
  });

  socket.on('data', parse);
  socket.on('error', (err) => {
    // a dead socket is still holding a seat — free it instead of waiting
    console.log(`[ws] socket error (${remote}): ${err.message}`);
    teardown();
  });
  socket.on('close', teardown);
});

// ---------------------------------------------------------------------------
// Heartbeat: browsers auto-answer pings with pongs. A socket that stops
// answering (crashed tab, dead hotspot) is reaped so zombie rooms and stale
// "live" games disappear instead of lingering. Tunable for tests via env.
// ---------------------------------------------------------------------------

const PING_MS = Number(process.env.WS_PING_MS) || 30000;
const DEAD_MS = Number(process.env.WS_DEAD_MS) || 75000;

setInterval(() => {
  const now = Date.now();
  for (const socket of clients) {
    if (socket.destroyed) continue;
    if (now - (socket.lastPong || 0) > DEAD_MS) {
      console.log(
        `[ws] heartbeat lost (${socket.remoteAddress}:${socket.remotePort}) — dropping`
      );
      socket.destroy(); // close event runs teardown
    } else {
      sendFrame(socket, 0x9, Buffer.alloc(0));
    }
  }
}, PING_MS).unref();

// Maximum session lifetime: a redeemed tap session stays active at most
// SESSION_MAX_MS. This sweeper proactively ends overdue sessions (and locks
// any live tab); /session-status also checks lazily from the stored
// redeemedAt, so a server restart can't resurrect an expired session.
setInterval(() => {
  if (!db) return;
  const now = Date.now();
  for (const [sid, deadline] of activeSessions) {
    if (deadline > now) continue;
    activeSessions.delete(sid);
    findSession({ sessionId: sid })
      .then((found) => {
        if (found && !found.data.endedAt) return endSession(found, 'max_lifetime');
      })
      .catch((err) => console.warn(`[session] max-lifetime sweep failed: ${err.message}`));
  }
}, 60000).unref();

// ---------------------------------------------------------------------------
// CLI: referee commands on stdin, scoped to a room
// ---------------------------------------------------------------------------

const HELP = [
  'Commands (player letter case-insensitive). With more than one active room,',
  'prefix the command with @CODE, e.g. "@ABCD turn a".',
  '  turn <a|b>                 override whose turn it is (normally automatic)',
  '  move <uci> <a|b>           move_applied {move, by: you|opponent}, then the',
  '                             turn passes to the other side automatically',
  '  illegal <a|b> <reason...>  illegal_move {reason, for} + opponent_fixing_move',
  '  fixed <a|b>                sync_ok -> both',
  '  syncerr <detail...>        sync_error {detail} -> both',
  '  gameover <a|b>             game_over {result: win|lose}',
  '  rooms                      list rooms ([solo] = vs robot), queue size',
  '  help                       this list',
  'In a [solo] room the CLI drives the robot: commands targeting b are',
  'delivered to player A from the opponent perspective.',
  'Client dev messages: {"type":"dev_gameover","result":"win"|"lose"} ends',
  'the sender\'s game from the browser dev panel (stub only).',
].join('\n');

function playerOf(arg) {
  if (!arg) return null;
  const c = arg.trim().toUpperCase();
  return c === 'A' || c === 'B' ? c : null;
}

function roomCodes() {
  return [...rooms.keys()].join(', ') || '(none)';
}

// Resolve which room a command targets: explicit @CODE, or the only room.
function resolveRoom(parts) {
  if (parts[0] && parts[0].startsWith('@')) {
    const code = parts[0].slice(1).toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      console.log(`[cli] no room with code ${code} -- active rooms: ${roomCodes()}`);
      return null;
    }
    return { room, rest: parts.slice(1) };
  }
  if (rooms.size === 1) {
    return { room: rooms.values().next().value, rest: parts };
  }
  if (rooms.size === 0) {
    console.log('[cli] no active rooms');
  } else {
    console.log(`[cli] multiple rooms active, prefix with @CODE: ${roomCodes()}`);
  }
  return null;
}

function sendToPlayer(room, letter, obj) {
  const socket = room.players[letter];
  if (!socket || socket.destroyed) {
    console.log(`[cli] room ${room.code} player ${letter} slot is empty, nothing sent`);
    return false;
  }
  send(socket, obj);
  return true;
}

function handleCommand(line) {
  let parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return;
  const cmd = parts[0].toLowerCase();

  if (cmd === 'rooms') {
    for (const room of rooms.values()) {
      console.log(
        `[rooms] ${room.code}:${room.solo ? ' [solo]' : ''} A=${room.players.A ? 'connected' : 'empty'}` +
        ` B=${room.solo ? 'robot' : room.players.B ? 'connected' : 'empty'}` +
        ` turn=${room.turn || '-'}`
      );
    }
    if (rooms.size === 0) console.log('[rooms] no active rooms');
    console.log(`[rooms] quick-match queue: ${quickQueue.length} waiting`);
    return;
  }
  if (cmd === 'help') {
    console.log(HELP);
    return;
  }

  const resolved = resolveRoom(parts);
  if (!resolved) return;
  const { room, rest } = resolved;
  const sub = (rest[0] || '').toLowerCase();

  // Solo room: the only human is A; commands targeting B are the robot's
  // actions and are delivered to A from the opponent perspective.
  if (room.solo) {
    const a = room.players.A;
    const toA = (obj) => {
      if (a && !a.destroyed) return send(a, obj), true;
      console.log(`[cli] room ${room.code} player A slot is empty, nothing sent`);
      return false;
    };
    const p = sub === 'move' ? playerOf(rest[2]) : playerOf(rest[1]);
    switch (sub) {
      case 'turn': {
        if (!p) return console.log('[cli] usage: [@CODE] turn <a|b>');
        if (toA({ type: p === 'A' ? 'your_turn' : 'opponent_turn' })) {
          room.turn = p;
          specSend(room, { type: 'turn', player: p });
        }
        return;
      }
      case 'move': {
        const uci = rest[1];
        if (!uci || !p) return console.log('[cli] usage: [@CODE] move <uci> <a|b>');
        if (toA({ type: 'move_applied', move: uci, by: p === 'A' ? 'you' : 'opponent' })) {
          // Auto-advance: after a move the turn passes to the other side.
          room.turn = otherLetter(p);
          toA({ type: room.turn === 'A' ? 'your_turn' : 'opponent_turn' });
          specSend(room, { type: 'move_applied', move: uci, by: p });
          recordMove(room, uci, p);
        }
        return;
      }
      case 'illegal': {
        const reason = rest.slice(2).join(' ');
        if (!p || !reason) return console.log('[cli] usage: [@CODE] illegal <a|b> <reason...>');
        toA({ type: 'illegal_move', reason, for: p === 'A' ? 'you' : 'opponent' });
        return;
      }
      case 'fixed': {
        if (!p) return console.log('[cli] usage: [@CODE] fixed <a|b>');
        toA({ type: 'sync_ok' });
        return;
      }
      case 'syncerr': {
        const detail = rest.slice(1).join(' ');
        if (!detail) return console.log('[cli] usage: [@CODE] syncerr <detail...>');
        toA({ type: 'sync_error', detail });
        return;
      }
      case 'gameover': {
        if (!p) return console.log('[cli] usage: [@CODE] gameover <a|b>');
        if (toA({ type: 'game_over', result: p === 'A' ? 'win' : 'lose' })) {
          room.turn = null;
          specSend(room, { type: 'game_over', winner: p });
          recordGameOver(room, p, 'over');
        }
        return;
      }
      default:
        console.log(`[cli] unknown command "${cmd}" -- type "help" for the command list`);
        return;
    }
  }

  switch (sub) {
    case 'turn': {
      const p = playerOf(rest[1]);
      if (!p) return console.log('[cli] usage: [@CODE] turn <a|b>');
      if (sendToPlayer(room, p, { type: 'your_turn' })) {
        sendToPlayer(room, otherLetter(p), { type: 'opponent_turn' });
        room.turn = p;
        specSend(room, { type: 'turn', player: p });
      }
      break;
    }
    case 'move': {
      const uci = rest[1];
      const p = playerOf(rest[2]);
      if (!uci || !p) return console.log('[cli] usage: [@CODE] move <uci> <a|b>');
      if (sendToPlayer(room, p, { type: 'move_applied', move: uci, by: 'you' })) {
        sendToPlayer(room, otherLetter(p), { type: 'move_applied', move: uci, by: 'opponent' });
        // Auto-advance: after a move the turn passes to the other side.
        room.turn = otherLetter(p);
        sendToPlayer(room, p, { type: 'opponent_turn' });
        sendToPlayer(room, otherLetter(p), { type: 'your_turn' });
        specSend(room, { type: 'move_applied', move: uci, by: p });
        recordMove(room, uci, p);
      }
      break;
    }
    case 'illegal': {
      const p = playerOf(rest[1]);
      const reason = rest.slice(2).join(' ');
      if (!p || !reason) return console.log('[cli] usage: [@CODE] illegal <a|b> <reason...>');
      const other = otherLetter(p);
      if (sendToPlayer(room, p, { type: 'illegal_move', reason, for: 'you' })) {
        sendToPlayer(room, other, { type: 'illegal_move', reason, for: 'opponent' });
        sendToPlayer(room, other, { type: 'opponent_fixing_move' });
      }
      break;
    }
    case 'fixed': {
      const p = playerOf(rest[1]);
      if (!p) return console.log('[cli] usage: [@CODE] fixed <a|b>');
      sendToPlayer(room, 'A', { type: 'sync_ok' });
      sendToPlayer(room, 'B', { type: 'sync_ok' });
      break;
    }
    case 'syncerr': {
      const detail = rest.slice(1).join(' ');
      if (!detail) return console.log('[cli] usage: [@CODE] syncerr <detail...>');
      sendToPlayer(room, 'A', { type: 'sync_error', detail });
      sendToPlayer(room, 'B', { type: 'sync_error', detail });
      break;
    }
    case 'gameover': {
      const winner = playerOf(rest[1]);
      if (!winner) return console.log('[cli] usage: [@CODE] gameover <a|b>');
      if (sendToPlayer(room, winner, { type: 'game_over', result: 'win' })) {
        sendToPlayer(room, otherLetter(winner), { type: 'game_over', result: 'lose' });
        room.turn = null;
        specSend(room, { type: 'game_over', winner });
        recordGameOver(room, winner, 'over');
      }
      break;
    }
    default:
      console.log(`[cli] unknown command "${cmd}" -- type "help" for the command list`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', handleCommand);

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} is already in use — is another stub-server already running?`);
    console.error('[server] close the other one first (or find it: netstat -ano | findstr :' + PORT + ')');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[server] stub listening on http://localhost:${PORT} (serving ${PROJECT_ROOT})`);
  if (OFFLINE) console.log('[server] OFFLINE MODE — guest solo play only, no Firebase');
  console.log('[server] type "help" for CLI commands');
  startStationWatcher();
});

function shutdown() {
  console.log('\n[server] shutting down');
  for (const s of clients) {
    if (!s.destroyed) {
      sendFrame(s, 0x8, Buffer.alloc(0));
      s.destroy();
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
