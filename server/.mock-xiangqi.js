// server/.mock-xiangqi.js — a fake of the camera/arm backend implementing the
// REAL "reader-2" contract (his writer API, 3 Nov) for testing the station
// watcher and website-controlled games without his hardware.
// Run: node server/.mock-xiangqi.js   (listens on 8090)
//
// Read: reader headers (X-Reader-ID + Bearer). Write: writer headers
// (X-Writer-ID + Bearer). GET /api/version -> { contract: "reader-2" }.
//
// Write side (real contract):
//   POST /api/xiangqi/games
//     { game_id: "web-<...>", device_id, mode: "physical"|"simulation",
//       human_side: "red"|"black", opening: "standard" }
//     -> 200 game object (phase "setup"); same game_id + settings = idempotent
//     -> 409 device busy; 422 missing device_id or id not starting "web-"
//   POST /api/xiangqi/games/{id}/abort  { event_id } -> { ok, phase,
//     abort_pending? }   (variant "slow-abort": abort_pending once, the game
//     finishes ~2.5s later with result_reason website_abort)
//
// setup -(SETUP_MS)-> playing -> finished. Magic variants: "fail-setup"
// (camera_not_ready), "sync-error-demo", "reject-demo", "pause-demo",
// "slow-abort", "operator-restart" (ends after 2 moves with result_reason
// operator_restart, as a station `restart` does), "setup-problem-demo" (the first half of setup reads
// paused + a Chinese board error, the second half clears before playing).
// MOCK_PVP=1: a PvP room appears on pi-board-01 + mac-board-01 — phase
// waiting_partner (one station) for 3s, then playing with both stations;
// moves key on side; winner red.
// Legacy: MOCK_AUTO=1 (default) plays the scripted auto game on MOCK_DEVICE
// (STATION_X1). MOCK_AUTO=0 disables it.

'use strict';

const http = require('http');

const READER_ID = 'test-reader';
const READER_KEY = 'test-reader-key';
const WRITER_ID = 'website';
const WRITER_KEY = 'test-writer-key';
const DEVICE = process.env.MOCK_DEVICE || 'STATION_X1';
const AUTO = process.env.MOCK_AUTO !== '0';
const PVP = process.env.MOCK_PVP === '1';
const SETUP_MS = Number(process.env.MOCK_SETUP_MS) || 1500;
const PVP_WAIT_MS = 3000;

const SCRIPT = [
  { ply: 1, side: 'red', source: 'B1', destination: 'B3', piece: 'r_ma', captured: null },
  { ply: 2, side: 'black', source: 'B10', destination: 'B8', piece: 'b_ma', captured: null },
  { ply: 3, side: 'red', source: 'H1', destination: 'H3', piece: 'r_ma', captured: null },
  { ply: 4, side: 'black', source: 'H10', destination: 'H8', piece: 'b_ma', captured: null },
  { ply: 5, side: 'red', source: 'A4', destination: 'A5', piece: 'r_bing', captured: null },
];

const games = new Map(); // id -> game
let autoNum = 0;
let autoFetches = 0;
let autoFinished = false;
let autoIdlePolls = 0;
let pvpRoom = null; // MOCK_PVP room state

function autoGameId() {
  return `sim-${autoNum}`;
}

function gamePhase(g, now = Date.now()) {
  if (g.abortAt && now >= g.abortAt) return 'finished'; // website_abort
  if (g.restarted) return 'finished'; // operator-restart: ended at the station, not by the website
  if (g.failSetup && now - g.createdAt >= SETUP_MS) return 'failed';
  if (now - g.createdAt < SETUP_MS) return 'setup';
  return g.finished ? 'finished' : 'playing';
}

function gameJson(g) {
  let phase = gamePhase(g);
  let moves = [];
  let rejectedMove = null;
  let paused = false;
  let error = null;
  // setup-problem-demo: the station's camera rejects the starting board for the
  // first half of setup (as the real station does after 5 s), then it is fixed
  if (phase === 'setup' && g.variant === 'setup-problem-demo' && Date.now() - g.createdAt < SETUP_MS / 2) {
    paused = true;
    error = '开局与要求的起点不一致：G9 应为红兵（相机未看到）；F9 多出红兵。请摆好后移开手。';
  }
  if (phase === 'playing' || phase === 'finished') {
    moves = SCRIPT.slice(0, Math.min(g.fetches, SCRIPT.length));
    // reject-demo: after 2 confirmed moves, a wrong placement is rejected;
    // the game does NOT advance while the board is wrong
    if (g.variant === 'reject-demo' && moves.length === 2 && (g.rejectTicks || 0) < 2) {
      g.rejectTicks = (g.rejectTicks || 0) + 1;
      rejectedMove = { detail: 'illegal move' };
    }
    // pause-demo: after 3 moves the camera loses the board briefly
    if (g.variant === 'pause-demo' && moves.length === 3 && (g.pauseTicks || 0) < 2) {
      g.pauseTicks = (g.pauseTicks || 0) + 1;
      paused = true;
      error = 'board mismatch — fix the board';
    }
    // operator-restart: after 2 moves the operator types `restart` at the station — the game ends with
    // no winner and the website never asked for it
    if (g.variant === 'operator-restart' && moves.length >= 2) {
      g.restarted = true;
      phase = 'finished';
    }
    if (!rejectedMove && !paused && !g.restarted) {
      g.fetches++;
      if (g.fetches > SCRIPT.length) g.finished = true;
      phase = gamePhase(g); // finishing move may have just landed
    }
  }
  // sync-error demo: while 2-3 moves are on the board, the camera loses
  // track of C5, then recovers on its own
  const syncError =
    g.variant === 'sync-error-demo' && moves.length >= 2 && moves.length <= 3
      ? { detail: 'camera unsure about C5', squares: ['C5'] }
      : null;
  return {
    id: g.id,
    mode: g.mode,
    phase,
    winner: phase === 'finished' && !g.abortAt && !g.restarted ? 'human' : null,
    result_reason: phase === 'finished'
      ? (g.abortAt ? 'website_abort' : g.restarted ? 'operator_restart' : 'checkmate') : null,
    failure_reason: phase === 'failed' ? 'camera_not_ready' : null,
    human_side: g.humanSide,
    variant: g.variant,
    turn: moves.length % 2 === 0 ? 'red' : 'black',
    moves,
    moves_complete: true,
    sync_error: syncError,
    rejected_move: rejectedMove,
    paused,
    error,
    updatedAt: Date.now(),
    command_expired: false,
  };
}

/* ----- PvP room simulation (MOCK_PVP=1) ----- */
// waiting_partner with the creator only, then a second station joins and a
// scripted game plays out keyed on side. Both devices report the same id.
function pvpJson() {
  const now = Date.now();
  const elapsed = now - pvpRoom.createdAt;
  let phase = 'waiting_partner';
  let moves = [];
  if (elapsed >= PVP_WAIT_MS) {
    phase = 'playing';
    moves = SCRIPT.slice(0, Math.min(pvpRoom.fetches, SCRIPT.length));
    pvpRoom.fetches++;
    if (pvpRoom.fetches > SCRIPT.length) {
      phase = 'finished';
      pvpRoom.finished = true;
    }
  }
  const stations = [{ device_id: 'pi-board-01', side: 'red', online: true }];
  if (phase !== 'waiting_partner') stations.push({ device_id: 'mac-board-01', side: 'black', online: true });
  return {
    id: pvpRoom.id,
    mode: 'pvp',
    phase,
    winner: phase === 'finished' ? 'red' : null,
    result_reason: phase === 'finished' ? 'checkmate' : null,
    turn: moves.length % 2 === 0 ? 'red' : 'black',
    stations,
    moves,
    moves_complete: true,
    updatedAt: phase === 'waiting_partner' ? pvpRoom.createdAt : Date.now(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const isReader =
    req.headers.authorization === `Bearer ${READER_KEY}` &&
    req.headers['x-reader-id'] === READER_ID;
  const isWriter =
    req.headers.authorization === `Bearer ${WRITER_KEY}` &&
    req.headers['x-writer-id'] === WRITER_ID;

  // version is reader-accessible (the website checks it at startup)
  if (req.method === 'GET' && req.url === '/api/version') {
    if (!isReader && !isWriter) return json(res, 401, { error: 'bad credentials' });
    return json(res, 200, { contract: 'reader-2' });
  }

  // ---- write: create game (writer only) ----
  if (req.method === 'POST' && req.url === '/api/xiangqi/games') {
    if (!isWriter) return json(res, 401, { error: 'bad writer credentials' });
    let msg;
    try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!msg.device_id || !String(msg.game_id || '').startsWith('web-')) {
      return json(res, 422, { error: 'game_id must start with web- and device_id is required' });
    }
    const existing = games.get(msg.game_id);
    if (existing) return json(res, 200, gameJson(existing)); // idempotent
    for (const g of games.values()) {
      if (g.deviceId === msg.device_id && ['setup', 'playing'].includes(gamePhase(g))) {
        return json(res, 409, { error: 'device_busy', active_game_id: g.id });
      }
    }
    const g = {
      id: msg.game_id,
      deviceId: msg.device_id,
      mode: msg.mode === 'physical' ? 'physical' : 'simulation',
      humanSide: msg.human_side === 'black' ? 'black' : 'red',
      opening: msg.opening || 'standard',
      // mock-only test hook: MOCK_VARIANT applies a scripted behavior
      // (fail-setup / reject-demo / pause-demo / sync-error-demo / slow-abort)
      variant: process.env.MOCK_VARIANT || null,
      createdAt: Date.now(),
      fetches: 0,
      finished: false,
      abortAt: null,
      failSetup: (process.env.MOCK_VARIANT || msg.variant) === 'fail-setup',
    };
    games.set(g.id, g);
    console.log(`[mock-xq] created ${g.id} on ${msg.device_id} (${g.mode})${g.variant ? ` [${g.variant}]` : ''}`);
    return json(res, 200, gameJson(g));
  }

  // ---- write: abort game (writer only) ----
  const abortMatch = req.url.match(/^\/api\/xiangqi\/games\/([\w-]+)\/abort$/);
  if (req.method === 'POST' && abortMatch) {
    if (!isWriter) return json(res, 401, { error: 'bad writer credentials' });
    const g = games.get(abortMatch[1]);
    if (!g) return json(res, 404, { error: 'no such game' });
    if (g.abortAt) return json(res, 200, { ok: true, phase: gamePhase(g), abort_pending: false });
    if (g.variant === 'slow-abort') {
      // the arm is mid-move: finish after it lands
      g.abortAt = Date.now() + 2500;
      return json(res, 200, { ok: true, phase: gamePhase(g), abort_pending: true });
    }
    g.abortAt = Date.now();
    return json(res, 200, { ok: true, phase: 'finished', abort_pending: false });
  }

  // everything below is reader-only
  if (!isReader) return json(res, 401, { error: 'bad reader credentials' });

  // ---- read: device ----
  const devMatch = req.url.match(/^\/api\/xiangqi\/devices\/([\w-]+)$/);
  if (req.method === 'GET' && devMatch) {
    const deviceId = devMatch[1];
    if (PVP && (deviceId === 'pi-board-01' || deviceId === 'mac-board-01')) {
      if (!pvpRoom) {
        pvpRoom = { id: 'pvp-room-1', createdAt: Date.now(), fetches: 0, finished: false };
        console.log('[mock-xq] pvp room created (waiting_partner)');
      }
      return json(res, 200, {
        active_game_id: pvpRoom.finished ? null : pvpRoom.id,
        unfinished_game_ids: pvpRoom.finished ? [] : [pvpRoom.id],
        online: true,
      });
    }
    if (deviceId === DEVICE && AUTO) {
      if (autoNum === 0) autoNum = 1; // first contact starts the first game
      if (autoFinished) {
        autoIdlePolls++;
        if (autoIdlePolls >= 8) {
          autoNum++;
          autoFetches = 0;
          autoFinished = false;
          autoIdlePolls = 0;
          console.log(`[mock-xq] new game ${autoGameId()}`);
        }
      }
      const createdBusy = [...games.values()].some(
        (g) => g.deviceId === deviceId && ['setup', 'playing'].includes(gamePhase(g))
      );
      return json(res, 200, {
        active_game_id: autoFinished || createdBusy ? null : autoGameId(),
        unfinished_game_ids: autoFinished ? [] : [autoGameId()],
        online: true,
      });
    }
    const live = [...games.values()].filter(
      (g) => g.deviceId === deviceId && ['setup', 'playing'].includes(gamePhase(g))
    );
    const active = live.find((g) => gamePhase(g) === 'playing') || null;
    return json(res, 200, {
      active_game_id: active ? active.id : null,
      unfinished_game_ids: live.map((g) => g.id),
      online: true,
    });
  }

  // ---- read: game ----
  const gameMatch = req.url.match(/^\/api\/xiangqi\/games\/([\w-]+)$/);
  if (req.method === 'GET' && gameMatch) {
    if (PVP && gameMatch[1] === (pvpRoom && pvpRoom.id)) return json(res, 200, pvpJson());
    if (gameMatch[1] === autoGameId() && autoNum > 0) {
      const n = Math.min(autoFetches, SCRIPT.length);
      autoFetches++;
      if (n >= SCRIPT.length) autoFinished = true;
      const moves = SCRIPT.slice(0, n).map((m) => ({ ...m, by: m.side === 'red' ? 'human' : 'bot' }));
      return json(res, 200, {
        id: autoGameId(),
        mode: 'simulation',
        phase: autoFinished ? 'finished' : 'playing',
        winner: autoFinished ? 'human' : null,
        result_reason: autoFinished ? 'checkmate' : null,
        human_side: 'red',
        turn: moves.length % 2 === 0 ? 'red' : 'black',
        moves,
        moves_complete: true,
        updatedAt: Date.now(),
        command_expired: false,
      });
    }
    const g = games.get(gameMatch[1]);
    if (g) return json(res, 200, gameJson(g));
    return json(res, 404, { error: 'not found' });
  }

  json(res, 404, { error: 'not found' });
}).listen(8090, () => console.log('[mock-xq] listening on 8090 (reader-2 contract)'));
