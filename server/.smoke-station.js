// server/.smoke-station.js — smoke test for the station watcher: connects as
// a spectator over the game WebSocket, finds the virtual station room in the
// lobby games list, watches it, and prints the event stream. Expects the
// mock Xiangqi API (server/.mock-xiangqi.js) on :8090 and the game server
// with XQ_* env pointing at it on :8081.
// Run: node server/.smoke-station.js

'use strict';

const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.SMOKE_PORT) || 8081;
const SCRIPT_MOVES = 5; // the mock's scripted game length
const events = [];

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
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  socket.write(Buffer.concat([header, mask, masked]));
}

let buf = Buffer.alloc(0);
let handshaken = false;

socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    handshaken = true;
    buf = buf.subarray(idx + 4);
    send({ type: 'list_games' });
  }
  for (;;) {
    if (buf.length < 2) return;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      handle(msg);
    } catch { /* pings etc. */ }
  }
});

let watched = false;
let seedMoves = 0;
function handle(msg) {
  events.push(msg.type);
  console.log('[smoke] got:', JSON.stringify(msg).slice(0, 140));
  if (msg.type === 'spec_state') seedMoves = (msg.moves || []).length;
  if (msg.type === 'games' && !watched) {
    const room = msg.games.find((g) => g.gameType === 'xiangqi');
    if (room) {
      watched = true;
      console.log(`[smoke] watching room ${room.code}:`, JSON.stringify(room));
      send({ type: 'watch', code: room.code });
    }
    // no room yet — the server pushes the list on every change, so just wait
  }
}

// in case we connected between broadcasts
setInterval(() => { if (!watched) send({ type: 'list_games' }); }, 3000).unref();

setTimeout(() => {
  const streamed = events.filter((t) => t === 'move_applied').length;
  const total = seedMoves + streamed;
  const over = events.includes('game_over');
  const ended = events.includes('spec_end');
  console.log(`\n[smoke] summary: ${seedMoves} seeded + ${streamed} streamed = ${total} moves, game_over=${over}, spec_end=${ended}`);
  console.log(total === SCRIPT_MOVES && over && ended ? '[smoke] PASS' : '[smoke] INCOMPLETE — check the log above');
  process.exit(0);
}, Number(process.env.SMOKE_MS) || 15000);
