// server/.smoke-party.js — two fake tapped kiosks play a physical party game.
// Needs: an engine with website_rooms (robots_arm pair_sim driver or real API) behind this
// server, XQ_STATION_MAP=2:<deviceA>,3:<deviceB>. Env: SMOKE_PORT (8081), SMOKE_MODE:
//   play      (default) host creates, guest joins, both screens follow ≥2 moves, guest ends -> loser/winner right
//   expire    host creates and nobody joins (run the server with PARTY_WAIT_MS=3000) -> party_expired + lobby
//   cancel    host creates then leaves -> lobby; machine is free (a second create works)
//   samestation  a second player at the HOST's own machine cannot join
//   abort-setup  guest ends the game while the boards are still being set up -> both hear station_game_failed
//   abort-setup-late  the same, 1.5 s after pairing (engine room exists); then a new party must work
//   call-reconnect  after pairing the guest's screen reloads: the host hears call_peer_left, both get a
//             fresh call_peer, and signals reach the NEW screen
//   leave-running  start a game, see a move, then quit WITHOUT ending it (then restart this server and run:)
//   recover   after a server restart the running web- game is ours again: both kiosks follow it, ending it works,
//             and the machines are free afterwards
// Exit code 0 = pass.
'use strict';

const PORT = Number(process.env.SMOKE_PORT) || 8081;
const MODE = process.env.SMOKE_MODE || 'play';
const DEVICE_OF = { 2: process.env.SMOKE_DEVICE_2 || 'sim-station-a', 3: process.env.SMOKE_DEVICE_3 || 'sim-station-b' };

const all = [];
function kiosk(station, name, uid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const k = { station, name, ws, events: [], waiters: [] };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'kiosk_hello', stationId: String(station) }));
    ws.send(JSON.stringify({ type: 'hello', name, uid }));
    ws.send(JSON.stringify({ type: 'session', sessionId: `smoke-${station}` })); // a tapped kiosk
    k.ready = true;
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'games' || m.type === 'welcome') return;
    k.events.push(m);
    console.log(`[${name}]`, m.type, JSON.stringify(m).slice(0, 110));
    k.waiters = k.waiters.filter((w) => !w(m));
  };
  all.push(ws);
  k.send = (o) => ws.send(JSON.stringify(o));
  k.wait = (type, ms = 20000) => new Promise((resolve, reject) => {
    const hit = k.events.find((m) => m.type === type);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`${name}: timeout waiting for ${type}`)), ms);
    k.waiters.push((m) => (m.type === type ? (clearTimeout(timer), resolve(m), true) : false));
  });
  k.count = (type) => k.events.filter((m) => m.type === type).length;
  return k;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); console.log('  ok:', msg); };

async function main() {
  const host = kiosk(2, 'Alice', 'uid-alice');
  const guest = kiosk(3, 'Bob', 'uid-bob');
  await sleep(500);

  if (MODE === 'recover') {
    const [hs, gs] = await Promise.all([host.wait('spec_state', 20000), guest.wait('spec_state', 20000)]);
    check(hs.code === gs.code && hs.createdByUs, 'after a restart both kiosks follow the game again, as ours');
    guest.send({ type: 'station_game_abort' });
    await Promise.all([host.wait('game_over', 30000), guest.wait('game_over', 30000)]);
    check(true, 'the recovered game can still be ended from a kiosk');
    await sleep(3000);
    host.events.length = 0;
    host.send({ type: 'create_room', gameType: 'xiangqi' });
    const fresh = await host.wait('room_created', 5000);
    check(!!fresh.code, 'machines are free again');
    return;
  }

  host.send({ type: 'create_room', gameType: 'xiangqi' });
  const created = await host.wait('room_created');
  check(/^[A-Z]{4}$/.test(created.code), `party code ${created.code}`);

  if (MODE === 'expire') {
    await host.wait('party_expired', 8000);
    guest.send({ type: 'join_room', code: created.code });
    const err = await guest.wait('error', 3000);
    check(/no such room/.test(err.detail), 'expired code is gone');
    return;
  }
  if (MODE === 'cancel') {
    host.send({ type: 'leave_room' });
    await host.wait('lobby');
    host.events.length = 0;
    host.send({ type: 'create_room', gameType: 'xiangqi' });
    const again = await host.wait('room_created');
    check(again.code !== created.code, 'machine is free again after cancelling');
    return;
  }
  if (MODE === 'samestation') {
    const twin = kiosk(2, 'Carol', 'uid-carol'); // second socket claiming the host's own machine
    await sleep(300);
    twin.send({ type: 'join_room', code: created.code });
    const err = await twin.wait('error', 3000);
    check(/other machine/.test(err.detail), 'cannot play yourself on one machine');
    return;
  }

  guest.send({ type: 'join_room', code: created.code });
  await Promise.all([host.wait('station_game_requested'), guest.wait('station_game_requested')]);
  check(true, 'both screens told the game is being set up (only after the joiner arrived)');

  // video call: each screen learns its peer and role; red leads (impolite), black is polite
  const [hc, gc] = await Promise.all([host.wait('call_peer'), guest.wait('call_peer')]);
  check(hc.polite !== gc.polite && hc.name === 'Bob' && gc.name === 'Alice', `call roles and names (${hc.polite}/${gc.polite})`);
  const relay = async (from, to, tag) => {
    const before = to.count('signal');
    from.send({ type: 'signal', data: { probe: tag } });
    await sleep(400);
    return to.events.filter((m) => m.type === 'signal').slice(before).some((m) => m.data && m.data.probe === tag);
  };
  check(await relay(host, guest, 'h1') && await relay(guest, host, 'g1'), 'video signalling relays both ways');

  if (MODE === 'call-reconnect') {
    guest.ws.close();
    await host.wait('call_peer_left', 5000);
    check(true, "host hears the guest's screen dropped");
    host.events.length = 0;
    const back = kiosk(3, 'Bob', 'uid-bob');
    const [h2, b2] = await Promise.all([host.wait('call_peer', 8000), back.wait('call_peer', 8000)]);
    check(h2.polite !== b2.polite, 'both screens get a fresh call_peer after the reconnect');
    check(await relay(host, back, 'h2') && await relay(back, host, 'b2'), 'signals reach the reconnected screen');
    back.send({ type: 'station_game_abort' });
    await Promise.all([host.wait('call_end', 30000), back.wait('call_end', 30000)]);
    check(true, 'the call ends with the game');
    return;
  }

  if (MODE === 'abort-setup' || MODE === 'abort-setup-late') {
    // late: cancel after the engine has created the room (the watcher may never see it before it ends)
    if (MODE === 'abort-setup-late') await sleep(1500);
    guest.send({ type: 'station_game_abort' });
    if (MODE === 'abort-setup-late') {
      // a fast setup may already be playing by now: then it is a resignation; either way both screens hear it
      const ended = (k) => Promise.race([k.wait('station_game_failed', 30000), k.wait('game_over', 30000)]);
      const [a, b] = await Promise.all([ended(host), ended(guest)]);
      check(a.type === b.type, `both screens hear the end (${a.type})`);
      await sleep(3000);
      host.events.length = 0;
      host.send({ type: 'create_room', gameType: 'xiangqi' });
      check(!!(await host.wait('room_created', 5000)).code, 'machines are free again');
      return;
    }
    const [a, b] = await Promise.all([host.wait('station_game_failed', 15000), guest.wait('station_game_failed', 15000)]);
    check(a.reason === 'aborted' && b.reason === 'aborted', 'both screens hear the setup was aborted');
    return;
  }

  const [hs, gs] = await Promise.all([host.wait('spec_state', 90000), guest.wait('spec_state', 90000)]);
  check(hs.code === gs.code && hs.createdByUs && gs.createdByUs, 'both tapped kiosks follow the same website-started game');
  check(hs.names.A === (hs.stationSides[DEVICE_OF[2]] === 'red' ? 'Alice' : 'Bob'), `names follow the random sides (${JSON.stringify(hs.names)})`);
  check(hs.stationSides[DEVICE_OF[2]] !== hs.stationSides[DEVICE_OF[3]], 'machines got opposite sides');

  if (MODE === 'leave-running') {
    await host.wait('move_applied', 90000);
    check(true, 'a game is running; quitting without ending it');
    return;
  }

  const deadline = Date.now() + 90000;
  while ((host.count('move_applied') < 2 || guest.count('move_applied') < 2) && Date.now() < deadline) await sleep(500);
  check(host.count('move_applied') >= 2 && guest.count('move_applied') >= 2, 'both screens saw the physical moves');
  const hm = host.events.filter((m) => m.type === 'move_applied').map((m) => m.move + m.by).join(',');
  const gm = guest.events.filter((m) => m.type === 'move_applied').map((m) => m.move + m.by).join(',');
  check(gm.startsWith(hm.split(',').slice(0, 2).join(',')) || hm.startsWith(gm.split(',').slice(0, 2).join(',')), 'both screens saw the same moves');

  const guestSide = hs.stationSides[DEVICE_OF[3]];
  guest.send({ type: 'station_game_abort' }); // Bob ends the game: Bob's side resigns
  const over = await host.wait('game_over', 30000);
  await guest.wait('game_over', 30000);
  check(over.winner === (guestSide === 'red' ? 'B' : 'A'), `resigning player loses (winner ${over.winner}, Bob was ${guestSide})`);
  await Promise.all([host.wait('call_end', 10000), guest.wait('call_end', 10000)]);
  check(true, 'the video call ends with the game');
  check(!(await relay(host, guest, 'after')), 'no signalling after the game');
}

// close sockets properly: a bare process.exit leaves the server holding dead seats until its heartbeat reaps them
const finish = async (code) => { all.forEach((w) => { try { w.close(); } catch {} }); await sleep(400); process.exit(code); };
main().then(() => { console.log('[party] PASS (' + MODE + ')'); return finish(0); },
  (err) => { console.log('[party] ' + err.message + ' (' + MODE + ')'); return finish(1); });
