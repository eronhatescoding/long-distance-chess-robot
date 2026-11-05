// server/.smoke-station-game.js — end-to-end harness for website-controlled
// station games (Phase 7): registers as a kiosk, requests a game, prints the
// event stream. Env:
//   SMOKE_PORT     server under test (default 8081)
//   SMOKE_STATION  kiosk station id (default "2")
//   SMOKE_VARIANT  variant to request (e.g. "fail-setup", "sync-error-demo")
//   SMOKE_ABORT=1  send station_game_abort after the first move
//   SMOKE_DOUBLE=1 send start_station_game twice (double-start guard)
//   SMOKE_CANCEL=1 press Cancel as soon as the setup starts (the screen must hear station_game_failed)
//   SMOKE_SESSION=1 link a tap session (a tapped kiosk), as a real signed-in player has
//   SMOKE_MS       total run time (default 15000)
//   SMOKE_EXPECT   comma-separated event types that must appear in this order
//                  (e.g. "station_setup_problem,station_setup_ok,spec_state");
//                  exit code 1 if they do not
// Setup-problem check (mock MOCK_VARIANT=setup-problem-demo MOCK_SETUP_MS=8000):
//   SMOKE_EXPECT=station_game_requested,station_setup_problem,station_setup_ok,spec_state
'use strict';

const PORT = Number(process.env.SMOKE_PORT) || 8081;
const STATION = process.env.SMOKE_STATION || '2';
const MS = Number(process.env.SMOKE_MS) || 15000;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const seen = [];
let abortSent = false;

ws.onopen = () => {
  console.log('[harness] connected');
  ws.send(JSON.stringify({ type: 'kiosk_hello', stationId: STATION }));
  ws.send(JSON.stringify({ type: 'hello', name: 'Harness Player', uid: process.env.SMOKE_UID || null }));
  if (process.env.SMOKE_SESSION === '1') ws.send(JSON.stringify({ type: 'session', sessionId: 'smoke-session' }));
  setTimeout(() => {
    console.log('[harness] -> start_station_game', process.env.SMOKE_VARIANT || '(no variant)');
    ws.send(JSON.stringify({
      type: 'start_station_game',
      gameType: 'xiangqi',
      variant: process.env.SMOKE_VARIANT || undefined,
      difficulty: 3,
    }));
    if (process.env.SMOKE_DOUBLE === '1') {
      setTimeout(() => {
        console.log('[harness] -> start_station_game AGAIN (double-start test)');
        ws.send(JSON.stringify({ type: 'start_station_game', gameType: 'xiangqi' }));
      }, 500);
    }
  }, 300);
};

ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'games' || m.type === 'welcome') return;
  seen.push(m.type);
  console.log('[harness]', m.type, JSON.stringify(m).slice(0, 160));
  if (m.type === 'station_game_requested' && process.env.SMOKE_CANCEL === '1' && !abortSent) {
    abortSent = true;
    setTimeout(() => { console.log('[harness] -> station_game_abort (cancel during setup)'); ws.send(JSON.stringify({ type: 'station_game_abort' })); }, 300);
  }
  if (m.type === 'move_applied' && process.env.SMOKE_ABORT === '1' && !abortSent) {
    abortSent = true;
    console.log('[harness] -> station_game_abort');
    ws.send(JSON.stringify({ type: 'station_game_abort' }));
  }
};

ws.onclose = () => console.log('[harness] closed');
ws.onerror = () => console.log('[harness] socket error');

setTimeout(() => {
  console.log('[harness] event sequence:', seen.join(' -> ') || '(nothing)');
  const expect = (process.env.SMOKE_EXPECT || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (expect.length) {
    let i = 0;
    for (const type of seen) if (type === expect[i]) i++;
    if (i < expect.length) {
      console.log(`[harness] FAIL: expected ${expect.join(' -> ')}; missing from "${expect[i]}" on`);
      process.exit(1);
    }
    console.log(`[harness] PASS: saw ${expect.join(' -> ')} in order`);
  }
  process.exit(0);
}, MS);
