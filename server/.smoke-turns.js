// Temporary coin-flip/auto-advance + regression smoke test. Deleted after the run.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const http = require('http');

const PORT = 8094;
let serverLog = '';
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`);
  if (!cond) failures++;
}

function wsClient(name) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const client = { name, messages: [], sock, send, sendClose };
    let buf = Buffer.alloc(0), handshook = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        handshook = true; buf = buf.subarray(i + 4); resolve(client);
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const opcode = buf[0] & 0x0f;
        if (opcode === 0x1) {
          try { client.messages.push(JSON.parse(buf.subarray(off, off + len).toString())); } catch {}
        } else if (opcode === 0x8) sock.end();
        buf = buf.subarray(off + len);
      }
    });
    sock.on('error', () => {});
    function frame(opcode, data) {
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
      sock.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), mask, masked]));
    }
    function send(obj) { frame(0x1, Buffer.from(JSON.stringify(obj))); }
    function sendClose() { frame(0x8, Buffer.alloc(0)); }
  });
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const has = (c, pred) => c.messages.some(pred);
const lastOf = (c, type) => [...c.messages].reverse().find((m) => m.type === type);
// The turn event paired with a game_start = the message right after it.
function turnAfterGameStart(c) {
  const i = c.messages.map((m) => m.type).lastIndexOf('game_start');
  return i >= 0 ? c.messages[i + 1] : undefined;
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'stub-server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  const cli = (line) => child.stdin.write(line + '\n');
  await sleep(700);

  // ===================== regression: HTTP + lobby =====================
  check('GET / serves game.html', (await httpGet('/')) === 200);
  check('GET /favicon.ico -> 204', (await httpGet('/favicon.ico')) === 204);

  const a1 = await wsClient('a1');
  await sleep(150);
  check('welcome without player', has(a1, (m) => m.type === 'welcome' && !('player' in m)));

  // ===================== coin flip: 2-player room fill =====================
  a1.send({ type: 'create_room' });
  await sleep(150);
  const code1 = a1.messages.find((m) => m.type === 'room_created').code;
  const b1 = await wsClient('b1');
  b1.send({ type: 'join_room', code: code1 });
  await sleep(900); // past the 500ms settle delay
  check('2p room_joined A/B + opponent_connected',
    has(a1, (m) => m.type === 'room_joined' && m.player === 'A' && !('solo' in m)) &&
    has(b1, (m) => m.type === 'room_joined' && m.player === 'B'));
  const gsA = lastOf(a1, 'game_start'), gsB = lastOf(b1, 'game_start');
  check('2p coin flip: both got game_start with opposite first',
    !!gsA && !!gsB && ((gsA.first === 'you' && gsB.first === 'opponent') ||
    (gsA.first === 'opponent' && gsB.first === 'you')),
    `A=${gsA && gsA.first} B=${gsB && gsB.first}`);
  const tA = turnAfterGameStart(a1), tB = turnAfterGameStart(b1);
  check('2p turn events consistent with flip',
    tA && tB && gsA.first === 'you' ?
      (tA.type === 'your_turn' && tB.type === 'opponent_turn') :
      (tA.type === 'opponent_turn' && tB.type === 'your_turn'),
    `A turn=${tA && tA.type} B turn=${tB && tB.type}`);
  const flippedFirst = gsA.first === 'you' ? 'A' : 'B';
  cli('rooms');
  await sleep(200);
  check('rooms shows turn after flip', new RegExp(`\\[rooms\\] ${code1}:.* turn=${flippedFirst}`).test(serverLog),
    serverLog.split('\n').filter((l) => l.includes(code1)).slice(-1)[0]);

  // ===================== auto-advance on move (2-player) =====================
  const moverLetter = flippedFirst; // whoever's turn it is moves
  const mover = moverLetter === 'A' ? a1 : b1;
  const waiter = moverLetter === 'A' ? b1 : a1;
  cli(`@${code1} move e2e4 ${moverLetter}`);
  await sleep(250);
  check('2p move_applied to both',
    has(mover, (m) => m.type === 'move_applied' && m.move === 'e2e4' && m.by === 'you') &&
    has(waiter, (m) => m.type === 'move_applied' && m.move === 'e2e4' && m.by === 'opponent'));
  check('2p move auto-advances turn',
    lastOf(mover, 'opponent_turn') && lastOf(waiter, 'your_turn') &&
    mover.messages[mover.messages.length - 1].type === 'opponent_turn' &&
    waiter.messages[waiter.messages.length - 1].type === 'your_turn');
  cli('rooms');
  await sleep(200);
  const otherL = moverLetter === 'A' ? 'B' : 'A';
  check('rooms shows advanced turn', new RegExp(`\\[rooms\\] ${code1}:.* turn=${otherL}`).test(serverLog));

  // ===================== manual turn override =====================
  cli(`@${code1} turn a`);
  await sleep(200);
  check('manual turn a override', a1.messages[a1.messages.length - 1].type === 'your_turn' &&
    b1.messages[b1.messages.length - 1].type === 'opponent_turn');
  cli('rooms');
  await sleep(200);
  check('rooms shows overridden turn=A', new RegExp(`\\[rooms\\] ${code1}:.* turn=A`).test(serverLog.split('\n').slice(-8).join('\n')));

  // ===================== gameover clears turn =====================
  cli(`@${code1} gameover a`);
  await sleep(200);
  check('2p game_over win/lose', has(a1, (m) => m.type === 'game_over' && m.result === 'win') &&
    has(b1, (m) => m.type === 'game_over' && m.result === 'lose'));
  cli('rooms');
  await sleep(200);
  check('gameover clears turn', new RegExp(`\\[rooms\\] ${code1}:.* turn=-`).test(serverLog.split('\n').slice(-8).join('\n')));

  // ===================== coin flip on rematch completion =====================
  a1.send({ type: 'rematch' });
  b1.send({ type: 'rematch' });
  await sleep(900);
  check('rematch_start both', has(a1, (m) => m.type === 'rematch_start') && has(b1, (m) => m.type === 'rematch_start'));
  const gsA2 = lastOf(a1, 'game_start'), gsB2 = lastOf(b1, 'game_start');
  check('coin flip fires after rematch',
    !!gsA2 && !!gsB2 && gsA2 !== gsA && ((gsA2.first === 'you') !== (gsB2.first === 'you')));
  check('rematch flip has turn events',
    ['your_turn', 'opponent_turn'].includes(turnAfterGameStart(a1).type) &&
    ['your_turn', 'opponent_turn'].includes(turnAfterGameStart(b1).type));

  // ===================== solo: coin flip + auto-advance =====================
  const s1 = await wsClient('s1');
  s1.send({ type: 'solo' });
  await sleep(900);
  const soloJoined = s1.messages.find((m) => m.type === 'room_joined');
  const soloCode = soloJoined.code;
  check('solo room_joined {player:A, solo:true}', !!soloJoined && soloJoined.solo === true);
  const gsS = lastOf(s1, 'game_start');
  check('solo coin flip fired', !!gsS && ['you', 'opponent'].includes(gsS.first), JSON.stringify(gsS));
  check('solo flip followed by turn event',
    gsS && turnAfterGameStart(s1).type === (gsS.first === 'you' ? 'your_turn' : 'opponent_turn'));

  cli(`@${soloCode} move e7e5 b`);
  await sleep(250);
  check('solo move b -> move_applied by:opponent then your_turn',
    has(s1, (m) => m.type === 'move_applied' && m.move === 'e7e5' && m.by === 'opponent') &&
    s1.messages[s1.messages.length - 1].type === 'your_turn');
  cli(`@${soloCode} move d2d4 a`);
  await sleep(250);
  check('solo move a -> move_applied by:you then opponent_turn',
    has(s1, (m) => m.type === 'move_applied' && m.move === 'd2d4' && m.by === 'you') &&
    s1.messages[s1.messages.length - 1].type === 'opponent_turn');

  // solo rematch -> immediate start + coin flip
  const soloGsCount = s1.messages.filter((m) => m.type === 'game_start').length;
  s1.send({ type: 'rematch' });
  await sleep(900);
  check('solo rematch -> rematch_start + new coin flip',
    count2(s1, 'rematch_start') >= 1 && s1.messages.filter((m) => m.type === 'game_start').length === soloGsCount + 1);

  // dev_gameover clears turn
  s1.send({ type: 'dev_gameover', result: 'win' });
  await sleep(200);
  check('solo dev_gameover win', has(s1, (m) => m.type === 'game_over' && m.result === 'win'));
  cli('rooms');
  await sleep(200);
  check('dev_gameover clears turn', new RegExp(`\\[rooms\\] ${soloCode}:.* turn=-`).test(serverLog.split('\n').slice(-8).join('\n')));

  // ===================== remaining regression =====================
  const q1 = await wsClient('q1');
  q1.send({ type: 'quick_match' });
  await sleep(150);
  const q2 = await wsClient('q2');
  q2.send({ type: 'quick_match' });
  await sleep(200);
  check('quick match paired', has(q1, (m) => m.type === 'match_waiting') &&
    has(q1, (m) => m.type === 'room_joined' && m.player === 'A') &&
    has(q2, (m) => m.type === 'room_joined' && m.player === 'B'));
  a1.send({ type: 'signal', x: 1 });
  await sleep(150);
  check('2p signal relayed', has(b1, (m) => m.type === 'signal' && m.x === 1));
  b1.sendClose();
  await sleep(250);
  check('2p opponent_disconnected still works', has(a1, (m) => m.type === 'opponent_disconnected'));

  function count2(c, type) { return c.messages.filter((m) => m.type === type).length; }

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  child.kill();
  await sleep(200);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
