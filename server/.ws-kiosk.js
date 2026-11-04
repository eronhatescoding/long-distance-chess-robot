// server/.ws-kiosk.js — kiosk harness using Node's real WebSocket client.
// Registers as a station's touchscreen and prints what it receives.
// Env: KIOSK_STATION (default "2"), KIOSK_MS (default 10000), KIOSK_PORT (default 8080)
'use strict';

const STATION = process.env.KIOSK_STATION || '2';
const PORT = Number(process.env.KIOSK_PORT) || 8080;
const MS = Number(process.env.KIOSK_MS) || 10000;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let gotLogin = null;

ws.onopen = () => {
  console.log(`[kiosk] connected, registering as station ${STATION}`);
  ws.send(JSON.stringify({ type: 'kiosk_hello', stationId: STATION }));
};
ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'station_login') {
    gotLogin = m.url;
    console.log('[kiosk] station_login:', m.url);
  } else if (m.type === 'station_ask') {
    console.log('[kiosk] station_ask:', JSON.stringify(m));
  } else if (m.type !== 'games' && m.type !== 'welcome') {
    console.log('[kiosk] msg:', JSON.stringify(m).slice(0, 140));
  }
};
ws.onclose = (e) => console.log('[kiosk] closed', e.code);
ws.onerror = () => console.log('[kiosk] error');

setTimeout(() => {
  console.log(gotLogin ? '[kiosk] PASS — login delivered' : '[kiosk] FAIL — no station_login');
  process.exit(gotLogin ? 0 : 1);
}, MS);
