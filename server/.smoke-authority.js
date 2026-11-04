// server/.smoke-authority.js — regression test: the website is the only thing
// that starts a kiosk's game. An operator-started game (one the website never
// requested) must stay watchable in the lobby but must NOT pull the kiosk
// off its attract screen.
// Needs: mock API with its scripted auto game (MOCK_AUTO=1, MOCK_DEVICE=<id>),
// this server with XQ_STATION_MAP=<kiosk>:<id>. Env: SMOKE_PORT (8081),
// SMOKE_STATION (kiosk id, default "2"), SMOKE_MS (watch time, default 9000).
// Exit code 0 = pass, 1 = fail.
'use strict';

const PORT = Number(process.env.SMOKE_PORT) || 8081;
const STATION = process.env.SMOKE_STATION || '2';
const MS = Number(process.env.SMOKE_MS) || 9000;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let sawGameInList = false;
let kioskWasPulled = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'kiosk_hello', stationId: STATION }));
  setInterval(() => ws.send(JSON.stringify({ type: 'list_games' })), 1000);
};
ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'games' && Array.isArray(m.games) && m.games.length) sawGameInList = true;
  if (m.type === 'spec_state') {
    kioskWasPulled = true;
    console.log('[authority] FAIL: kiosk was attached to a game it never requested');
  }
};
setTimeout(() => {
  const ok = sawGameInList && !kioskWasPulled;
  console.log(`[authority] operator game listed for spectators: ${sawGameInList}`);
  console.log(`[authority] kiosk left on attract screen: ${!kioskWasPulled}`);
  console.log(ok ? '[authority] PASS' : '[authority] FAIL');
  process.exit(ok ? 0 : 1);
}, MS);
