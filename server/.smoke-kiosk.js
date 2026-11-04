// server/.smoke-kiosk.js — smoke test for kiosk tap delivery: registers as
// the touchscreen of a station over the game WebSocket and prints what it
// receives. Then a card tap (curl from the test driver) should arrive as a
// station_login push.
// Run: node server/.smoke-kiosk.js   (server under test on SMOKE_PORT, default 8081)

'use strict';

const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.SMOKE_PORT) || 8081;
const STATION = process.env.SMOKE_STATION || 'STATION_A';

const socket = net.connect(PORT, '127.0.0.1', () => {
  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + PORT + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
});

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  socket.write(Buffer.concat([header, mask, masked]));
}

let buf = Buffer.alloc(0);
let handshaken = false;
let gotLogin = null;
let gotWatch = false;
let gotAsk = null;
let specStates = 0;
let muted = false;

socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    handshaken = true;
    buf = buf.subarray(idx + 4);
    send({ type: 'kiosk_hello', stationId: STATION });
    console.log(`[smoke] registered as kiosk for ${STATION}`);
    if (process.env.SMOKE_MODE) {
      send({ type: 'kiosk_mode', mode: process.env.SMOKE_MODE, accept: process.env.SMOKE_ACCEPT || 'any' });
      console.log(`[smoke] mode set: ${process.env.SMOKE_MODE}, accept: ${process.env.SMOKE_ACCEPT || 'any'}`);
    }
  }
  for (;;) {
    if (buf.length < 2) return;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.type === 'station_login') {
        gotLogin = msg.url;
        console.log('[smoke] station_login:', msg.url);
      } else if (msg.type === 'station_ask') {
        console.log('[smoke] station_ask:', JSON.stringify(msg));
        gotAsk = msg;
        // SMOKE_CHOICE=phone|kiosk answers the prompt like a user would
        if (process.env.SMOKE_CHOICE) {
          const code = new URL(msg.url).searchParams.get('code');
          const choice = process.env.SMOKE_CHOICE === 'kiosk' ? 'kiosk' : 'phone';
          fetch(`http://127.0.0.1:${PORT}/session-choose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, choice }),
          }).then((r) => r.json()).then((d) => console.log('[smoke] session-choose:', JSON.stringify(d)));
        }
      } else if (msg.type === 'spec_state') {
        gotWatch = true;
        specStates++;
        console.log('[smoke] auto-watch spec_state:', JSON.stringify(msg).slice(0, 120));
      } else if (msg.type === 'game_over' && process.env.SMOKE_MUTE === '1' && !muted) {
        muted = true;
        console.log('[smoke] game over — pressing Leave (mute)');
        send({ type: 'leave_watch', mute: true });
      } else if (msg.type !== 'games') {
        console.log('[smoke] got:', JSON.stringify(msg).slice(0, 120));
      }
    } catch { /* pings */ }
  }
});

setTimeout(() => {
  // SMOKE_EXPECT=ask: pass when the station_ask prompt arrived
  if (process.env.SMOKE_EXPECT === 'ask') {
    console.log(gotAsk ? '[smoke] PASS — ask prompt received' : '[smoke] FAIL — no station_ask received');
    process.exit(gotAsk ? 0 : 1);
  }
  // SMOKE_MUTE=1: pass only if no second spec_state arrived after muting
  if (process.env.SMOKE_MUTE === '1') {
    console.log(`[smoke] spec_state count after mute: ${specStates}`);
    console.log(specStates === 1 ? '[smoke] PASS — auto-follow stopped' : '[smoke] FAIL — kept following after mute');
    process.exit(specStates === 1 ? 0 : 1);
  }
  // SMOKE_EXPECT=watch: pass when the auto-watch stream arrived (POV test);
  // default: pass when a station_login arrived (tap-delivery test)
  if (process.env.SMOKE_EXPECT === 'watch') {
    console.log(gotWatch ? '[smoke] PASS — auto-watch stream received' : '[smoke] FAIL — no spec_state received');
    process.exit(gotWatch ? 0 : 1);
  }
  console.log(gotLogin ? '[smoke] PASS — login delivered to kiosk' : '[smoke] FAIL — no station_login received');
  process.exit(gotLogin ? 0 : 1);
}, Number(process.env.SMOKE_MS) || 8000);
