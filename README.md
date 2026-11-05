# Long-Distance Robot Chess

## Quick start (every session)

1. VS Code terminal: `node server/stub-server.js` (leave it open — it takes
   the referee commands)
2. Both players open `https://eronkow.tail0202f0.ts.net` in a browser

Tailscale (HTTPS proxy + public Funnel) persists across restarts — nothing
else to set up. If the URL doesn't load right after a reboot, wait ~30s for
Tailscale to reconnect.

## Overview

Two robotic chess boards with screen "faces". Humans play each other over long
distance; each robot physically re-enacts the opponent's moves. Solo vs the
robot shows an animated face instead of video.

## Files

| Path | What |
|---|---|
| `index.html`, `face.css`, `face.js` | Standalone robot face (Step 1). Open directly; press `D` for dev panel. |
| `game.html`, `game.css` | Game client page: face/video base layers + overlay layer. |
| `js/client.js` | WebSocket client; maps server events to `face.setState(...)` and overlays. |
| `js/auth.js` | Firebase sign-in + tap-token handoff; gates the lobby (Phase 1). |
| `js/friends.js` | Friends + challenges via Firestore listeners (Phase 5). |
| `js/board.js` | Chessboard renderer for spectators/replays (chess.js via CDN); FEN-ready for the future position feed. |
| `js/xiangqi.js` | Xiangqi renderer (9×10, river/palaces, SVG glyphs); same interface as board.js, WXF FEN-ready. |
| `js/video.js` | WebRTC video call; signaling rides the same WebSocket (`signal` messages). |
| `js/emotion.js` | Emotion emoji overlay (`emotion` messages). |
| `server/stub-server.js` | Node game server: static files, WebSocket rooms, referee CLI, and the tap endpoint (`POST /tap`). |
| `server/env.js` | Loads `.env` and builds the Firebase Admin credential. |
| `server/add-card.js` | Assign an RFID card to a player: `node server/add-card.js <cardId> <email-or-uid>`. |

## Run (two laptops on the same LAN)

1. On one machine: `node server/stub-server.js` (port 8080, or `PORT=xxxx`).
2. On each laptop, open `http://<that-machine's-LAN-IP>:8080/game.html`.
   First to connect is player A, second is B.
3. Video starts automatically once both players are connected (browser will
   ask for camera/mic permission).

> **Camera caveat:** browsers only allow camera/mic in a "secure context" —
> `localhost` or HTTPS. Opening `http://<lan-ip>:8080` works for the game
> itself, but the camera is blocked there. For LAN testing, either:
> - both players open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
>   add `http://<lan-ip>:8080`, enable it, and restart the browser, or
> - use the Tailscale HTTPS URL below (recommended), or
> - test video solo first via `http://localhost:8080` in two windows.

## Run (over the internet — current setup)

The server machine runs Tailscale with Funnel exposing the stub publicly:

- `tailscale serve` → tailnet-only HTTPS at `https://eronkow.tail0202f0.ts.net`
- `tailscale funnel` → same URL reachable by **anyone on the internet**,
  no installs or accounts needed for players

So: host runs `node server/stub-server.js`, both players open
`https://eronkow.tail0202f0.ts.net`. Real HTTPS means cameras work with no
browser flags. Requires the host laptop to be on with Tailscale running.

To stop public exposure: `tailscale funnel --https=443 off`
To stop the tailnet-only proxy: `tailscale serve --https=443 off`

> **Note:** anyone with the URL can connect, and the stub only has two
> player slots (first come, first served) — share the URL only with your
> opponent. Real rooms/pairing come with the hosted-server phase.

## Local test (one machine)

`node server/stub-server.js`, then open `http://localhost:8080/game.html` in
two browser windows.

## How a game starts

Opening the page lands in the **lobby**. From there:

- **Quick match** — paired with the next stranger also waiting
- **Create party** — you get a 4-letter code; your friend enters it under
  **Join party**
- **Join party** — enter a friend's 4-letter code
- **Play vs robot** — solo game; no video call, the robot face IS the
  opponent. The referee CLI drives the robot: `turn b` (robot thinking),
  `move e7e5 b` (robot moves), `gameover b` (robot wins)

The pill in the top-left always shows where you stand: `in lobby`,
`party XXXX — waiting for opponent…`, `party XXXX · opponent connected`,
or `solo vs the robot`. A **Leave party** button (top-right) appears
whenever you're in a room.

## Accounts & the tap-to-play gate (Phase 1)

Opening the game page now requires sign-in (Firebase email/password; the web
config lives in `js/auth.js` and is public by design). There are two session
modes, shown as a banner in the lobby:

- **Play mode** — arriving via a tap link (`game.html?token=...`) signs in
  with a Firebase custom token and unlocks Create party / Quick match /
  Play vs robot / Join. Tokens are minted by the server (Phase 2 — not built
  yet, so no real tap links exist for now).
- **Spectator mode** — signing in manually keeps those buttons locked.
  Watch/replay features arrive in Phase 6.

The mode survives refresh within the tab (sessionStorage) but a new tab
without a tap link always starts as spectator. For testing before Phase 2,
the dev panel (press `D`) has **dev: play mode** / **dev: spectator** toggles.

## Tap endpoints (Phase 2/2.5)

Secrets live in `.env` (gitignored — copy `.env.example` and fill it in):
the Firebase service-account fields, `PUBLIC_BASE_URL` (what login links
point at), and per machine a `STATION_<ID>_SECRET` plus an optional
`STATION_<ID>_CLUSTER` binding. `server/env.js` also accepts
`server/service-account.json` as a fallback credential source.

Three endpoints, all POST + JSON:

- **`/tap`** — a station reports a tap:
  `{ stationId, stationSecret, cardId }` (RFID card) or
  `{ stationId, stationSecret, playerToken }` (single-use HCE code from the
  app). Resolves the player, enforces cluster membership when the station
  is cluster-bound (players whose `users/{uid}.clusterId` doesn't match are
  rejected and stay spectators), records a `tap_sessions` doc, and replies
  `{ ok, uid, url }` where the URL carries a short redemption `?code=`.
- **`/redeem`** — the browser/app exchanges `{ code }` for the actual
  Firebase custom token. Single-use, 5-minute expiry.
- **`/hce-token`** — the app fetches its next tap code with header
  `Authorization: Bearer <Firebase ID token>`; replies
  `{ ok, code, expiresAt }`. Single-use, 90-second expiry. The app
  transmits this code over NFC when tapped.

Client access rules for these collections live in `firestore.rules`
(paste into the Firebase console).

Manage cards with `npm run add-card -- <cardId> <email-or-uid>`.

Simulate a card tap without hardware:

```
curl -X POST http://localhost:8080/tap -H "Content-Type: application/json" \
  -d '{"stationId":"STATION_A","stationSecret":"...","cardId":"04A3B2C1"}'
```

### HCE protocol (phone taps)

The NexusBoard app (0.5.0) implements the phone side; confirmed against its
Kotlin implementation:

- **SELECT** AID `F04E4558555301` (`00A4040007F04E455855530100`) → exactly
  `9000`, no FCI. Unknown AID: `6A82`.
- **Credential read** `8040000000` → **32 bytes ASCII** (`[A-Za-z0-9_-]{32}`)
  + `9000` (34 bytes total). Parse the last two bytes as the status word;
  only decode the 32-byte credential when it's `9000`.
- **Errors**: `6982` = no usable cached credential (locked/logged out,
  unprepared, or expired); `6985` = AID not selected first. Both are
  status-only — distinct from a transport timeout.
- The app serves the credential from memory (no network during the tap) after
  the player presses **Prepare tap**; backend lifetime 90s, app cache 80s.
  Backend replay protection makes re-reads harmless.

The app's credential/verify loop is entirely the NFC backend's
(Flask/PostgreSQL): `POST /api/player/nfc/issue` and
`POST /api/hardware/nfc/verify-board`. Integration into this website happens
**backend-to-backend after a successful verify**: the NFC backend calls
`POST /bridge/tap` here and delivers the returned redemption URL to the app.

### Bridge endpoint (Phase 4)

```
POST /bridge/tap
Authorization: Bearer <BRIDGE_SECRET>     # env var; never the app or reader

{ "eventId": "unique-per-tap", "playerId": "P000123",
  "displayName": "...", "clusterId": "7", "clusterIds": ["7"],
  "stationId": "<their reader id>" }

→ { ok, uid: "sql_P000123", url, status: "pending", expiresAt }   first sight
→ { ok, uid, url, duplicate: true, status, expiresAt }            repeat
```

`status` is `pending` | `active` | `ended` | `expired`; `expiresAt` is epoch
ms. A duplicate never extends the original session — after `ended`/`expired`,
start a fresh `eventId`.

Session lifecycle (Phase 4.5): two decoupled lifecycles — the bridge EVENT
(station occupation) ends only on app Disconnect or the 2 h maximum
(`SESSION_MAX_MS`); the BROWSER session ends on refresh, tab close, sign-out,
or a 90 s browser loss (`SESSION_GRACE_MS`) and never frees the station.
Event state is anchored on first redemption: an unused re-entry code expiring
never regresses an active event. While an event is `active`, a duplicate
`/bridge/tap` (same eventId) returns the still-live re-entry code if a retry
follows a lost response, or mints a fresh one — without moving the deadline.
Card taps stay coupled (a physical re-tap is always possible). Ended bridge
events leave a tombstone in `ended_events/`, so a delayed `/bridge/tap` loses
the race to a Disconnect. There are no outbound callbacks — Flask polls:

```
POST /session-end                      Authorization: Bearer <BRIDGE_SECRET>
{ "eventId": "..." }                   app-side Disconnect
→ { ok, status: "ended", already? }    (tombstones unknown eventIds)

POST /session-status                   Authorization: Bearer <BRIDGE_SECRET>
{ "eventId": "..." }
→ { ok, status, reason?, expiresAt? }  status ∈ pending|active|ended|expired|unknown
```

The website tab ends its own session via `POST /session-end { sessionId }`
(no auth — the session id is the capability; `/redeem` returns it). See
bridge_reply_2.md for the full agreed contract.

## Station watcher (Xiangqi camera/arm backend)

The camera/arm backend is REST-only (Xiangqi rules + bot + MG400 arm, one
human-vs-bot game per station). This server polls its read-only endpoints and
projects each active station game into a virtual room, so the lobby's live
list, spectating and recording all treat it like any other game. Browsers
never contact his server; only this server does, with a read-only reader key.

- Config: `XQ_API_BASE`, `XQ_READER_ID`, `XQ_READER_KEY`,
  `XQ_DEVICES=deviceId:Display Name,...`, `XQ_POLL_MS` (default 2500).
- Reads: `GET /api/xiangqi/devices/{id}` (finds the active game) and
  `GET /api/xiangqi/games/{id}` (state + move list). Never calls `/sync` —
  that's a station-only write.
- Move translation: his squares A–I × 1–10 (`B3`) → the renderer's `b2`
  (rank 1 = red home = our rank 0). Human is room letter A, the bot B.
- Station games have no clocks (`minutes: null` end to end); the spectator
  UI hides clocks for them.
- A game that finishes while we're not watching is still recorded to
  Firestore (replays survive our downtime).
- Test without his hardware: `node server/.mock-xiangqi.js` (fake API on
  :8090) + run this server with the `XQ_*` vars above, then
  `node server/.smoke-station.js` to watch a scripted game end to end.

## Website-controlled station games (Phase 7)

The kiosk decides when a game starts; the camera/arm engine executes it.
A mapped kiosk (`XQ_STATION_MAP="2:pi-board-01,…"`, station id → his device
id) routes "Play vs robot" / variant play to the real machine instead of the
simulated solo game; unmapped stations keep the simulated game.

- Client → server: `start_station_game { gameType, variant?, difficulty? }`
  and `station_game_abort` (the "End game" button / session end).
- Server → engine (reader-2 contract, live on his side):
  - `POST /api/xiangqi/games` with writer headers (`X-Writer-ID` + Bearer):
    `{ game_id: "web-<uuid>", device_id, mode: "physical"|"simulation",
    human_side: "red"|"black", opening: "standard" }` — nothing else; unknown
    fields get 422. `game_id` IS the idempotency key. Success is 200 with the
    normal game object. Errors: 404 unknown station, 409 busy, 422 bad body.
  - `POST /api/xiangqi/games/{id}/abort` with `{ event_id }` (fresh per user
    action, reused on network retry). `abort_pending: true` = arm mid-move —
    the kiosk shows "ending after the current move" and the watcher closes
    the room when the game reaches finished.
  - `POST /api/xiangqi/games/{id}/resign` with `{ event_id }` — only on the
    player's turn (409 otherwise); our End-game button tries resign first and
    falls back to abort.
  - A just-created game reads `setup` (older engines: playing with no moves)
    until the camera verifies the board (we show "waiting for the machine to
    set up the board" in that window), then `playing`, and an
    abort lands as finished + winner null + `website_abort`
    (`operator_restart` when the operator ends it). Board trouble is
    `paused: true` + `error: "<text>"` — the only fix-the-board signals.
  - The setup timeout is 8 minutes (`XQ_SETUP_TIMEOUT_MS`), and a timed-out
    request is aborted so it can't squat on the station and 409 later
    creates.
- Server → kiosk: `station_game_requested` (setting up…), then the normal
  auto-watch stream; `station_game_failed { reason }` on failure (busy /
  unavailable / timeout / camera_not_ready).
- Setup board problems: while the game reads phase `setup` with
  `paused: true` and/or `error: "<text>"` (the station's camera saw a wrong
  starting position, or no complete stable board for 5 s), the asking kiosk
  gets `station_setup_problem { detail }` — `detail` is the station's own
  Chinese text, passed through untouched (physical A–J/1–9 squares; a piece
  the camera did not see is "未看到", never "empty"). It is sent once per new
  detail; `station_setup_ok` follows once when paused/error clear. The kiosk
  shows "board not ready: <detail>" / "棋盘未就绪：<detail>" on its
  setting-up status and goes back to "setting up" on ok; going live or
  failing replaces it. Only single-machine website games report setup
  problems: two-machine party rooms do not yet (paired stations drop the
  setup attention, and the engine's paired-room view reads `paused` only in
  its `paused` phase, which shows as `playing`, never during `setup`), so
  party kiosks just stay on "setting up". The setup timeout keeps running
  during a problem. Test:
  `MOCK_AUTO=0 MOCK_VARIANT=setup-problem-demo MOCK_SETUP_MS=8000 node
  server/.mock-xiangqi.js`, then `SMOKE_EXPECT=station_game_requested,station_setup_problem,station_setup_ok,spec_state
  node server/.smoke-station-game.js` (exit 1 if the order is not seen).
- Guards: one website game per station (double-press returns "busy"), the
  8-minute setup timeout above, taps rejected while a website game
  is pending/live, operator-started games are adopted but never aborted, and
  ending the kiosk session aborts the machine game with it.
- The website is the only thing that starts a kiosk's game: a kiosk screen
  follows only rooms this server requested (`createdByUs`). A game the
  operator starts at the station stays in the lobby's Live games for
  spectators but never moves a kiosk off its attract screen or out of a
  tapped session. Regression test: `server/.smoke-authority.js` (mock with
  `MOCK_AUTO=1`, kiosk id = device id).
- Machine games are untimed, and quick match is refused on kiosks (no
  strangers moving real pieces).
- Write credentials: `XQ_WRITER_ID` / `XQ_WRITER_KEY` (default to the reader
  pair until his API issues a separate writer key).

### Two-machine games (party code or friend challenge)

Both players must be at a machine and signed in by a tap; a typed URL only
spectates, and guests play the robot only. On a mapped kiosk, a xiangqi
**Create party** / **Join party** (and a friend challenge, which carries the
party code) is a real game between the two machines:

1. The host's machine is held while the party waits for a joiner
   (`PARTY_WAIT_MS`, default 10 min; then `party_expired`). Nothing exists on
   the engine yet.
2. When a player at the *other* machine joins, the website picks random sides
   and calls `POST /api/xiangqi/pvp/v1/website/rooms` (writer key) to seat both
   stations. Both kiosks get `station_game_requested`, then follow the game like
   any station game (moves are mirrored by the arms; both cameras confirm each).
   The two players' sockets keep a signalling path for the video call.
3. **End game** on a kiosk resigns that player's side (retried for up to ~30 s
   while an arm finishes a step, `XQ_RESIGN_RETRIES`), else aborts. Cancelling
   during setup aborts the room on the engine.
4. A setup that never starts is aborted after `XQ_SETUP_TIMEOUT_MS`. After a
   website restart, a live `web-` game is taken back as ours (kiosks re-attach,
   End game still works); a stale one is aborted on the engine so the machines
   are freed.

Needs an engine whose `/api/version` lists `features: ["website_rooms"]`; the
stations run `--paired --website-only` (robots_arm runbook). `XQ_PVP_VERIFY=squares`
selects the faster Dobot two-square check. Test with no hardware:
`server/.smoke-party.js` (modes play, cancel, samestation, abort-setup, expire,
leave-running + recover) against robots_arm's simulated stations.

**Video call.** Once paired, each kiosk gets `call_peer {polite, name}` (red
leads the WebRTC negotiation, black is polite) and the server relays `signal`
between the two screens. The camera stays opt-in (camera button); the board
stays the main view and the view button switches to the opponent's video once
it flows. `call_peer_left` / a fresh `call_peer` handle a screen reconnecting;
`call_end` ends the call with the game.

### Try a two-machine game on one laptop (no robots)

Two browser windows play the two machine screens, robots_arm's simulator plays
the stations and arms, and `curl` stands in for the card readers. Uses your real
`.env` (Firebase) and the laptop camera for the video call.

1. In robots_arm (any Python with its server requirements):
   `python -m client.xiangqi.website_engine_sim /tmp/engine.json`
   (keep it running; it prints `[engine] ready http://127.0.0.1:8093`).
2. In this repo, add to `.env`: `STATION_A_SECRET=…`, `STATION_B_SECRET=…`,
   `XQ_DEVICES=sim-station-a:Machine A,sim-station-b:Machine B`,
   `XQ_STATION_MAP=STATION_A:sim-station-a,STATION_B:sim-station-b`,
   `XQ_GAME_MODE=simulation`, plus `XQ_API_BASE`, `XQ_READER_ID/KEY` and
   `XQ_WRITER_ID/KEY` copied from `/tmp/engine.json`. Then `node server/stub-server.js`.
3. Give two of your test accounts a card each:
   `npm run add-card -- CARD-A you@example.com` and `npm run add-card -- CARD-B friend@example.com`.
4. Open `http://localhost:8080/game.html?station=STATION_A` and
   `…?station=STATION_B` in two windows (localhost, so the camera is allowed).
5. "Tap" each card at its machine:

   ```bash
   curl -X POST http://localhost:8080/tap -H "Content-Type: application/json" \
     -d '{"stationId":"STATION_A","stationSecret":"<A secret>","cardId":"CARD-A","gameType":"xiangqi"}'
   ```

   and the same for `STATION_B` / `CARD-B`. Each window signs in by itself.
6. Window A: **Create party**. Window B: **Join party** with the code. Both show
   "setting up", then the board; the simulator's players start moving. Press the
   camera button in either window to start the video call.

### Confirmed contract facts (his answers, 3 Nov)

- `online` = the station terminal's heartbeat (`POST /sync` within 20 s), not
  the camera/arm/engine. `online:false` + active game = station program gone.
- `active_game_id` appears only once the game is *started* (board verified);
  games in setup appear only in `unfinished_game_ids`. Several unfinished
  games per device are possible — track the whole list.
- `updatedAt` bumps on every game save (including pauses) but not on plain
  heartbeats. Bot moves appear only after the arm physically moved and the
  camera confirmed — moves are confirmed-only and append-only.
- His `POST /games` exists but is station-keyed: client-chosen `game_id`
  (idempotent retries), `mode` (simulation/physical), `initial_board`,
  `human_side`, `opening`. A website create will be a *request the station
  picks up* — starting requires the station's camera to verify the board.
  Abort is `POST /abandon` (station confirms the arm is idle; ends as
  finished / winner null / operator_restart).
- PvP (live in the reader API, watch-only): rooms with `mode: "pvp"`, phases
  `waiting_partner` / `playing` / `finished`; winner red/black/draw. Moves
  `{ply, side, source, destination, piece, captured}` (key on `side`).
  `stations: [{device_id, side, online}]` — read `side` from each entry
  (listed red first); guest stations appear as `guest-…` ids and display as
  "Guest". LAN rooms never reach the server, and the website cannot create,
  join, abort or resign rooms.
- No variants (fixed WXF rules), no bot difficulty (one fixed bot), no
  clocks, no FEN/position feed — positions are replayed from `initial_board`
  + confirmed moves. The kiosk hides the Special Games card and difficulty
  slider for machine games.
- His build order (agreed): paused/error state + version endpoint → PvP rooms
  in the reader API → writer keys (website create/abort/resign) → clocks +
  difficulty.

### Watcher hardening from those answers

- Watchdog uses `online` + `updatedAt` together: a dark station's game is
  abandoned after `XQ_OFFLINE_STALE_MS` (default 60 s), a live station's
  after `XQ_STALE_MS` (default 3 min).
- PvP: when both stations report the same game id, the room becomes non-solo
  and the second station takes the B name slot (dedup was already in place).
- `winner: "draw"` maps to no winner.
- Test: `MOCK_AUTO=0 node server/.mock-xiangqi.js`, this server with
  `XQ_API_BASE=http://localhost:8090 XQ_DEVICES="pi-board-01:Pi Board"
  XQ_STATION_MAP=2:pi-board-01`, then
  `SMOKE_PORT=8081 node server/.smoke-station-game.js` (env: SMOKE_VARIANT,
  SMOKE_ABORT=1, SMOKE_DOUBLE=1 for the failure paths).

The player gets a website session as `sql_<playerId>` — no Firebase account
needed; the asserted `displayName` rides the redemption as a token claim.
`/redeem` works exactly as for card taps.

## Spectating & replays (Phase 6)

Spectator mode (manual sign-in) shows **Live games** and **Past games**
instead of the play carousel. Spectators attach to a room read-only
(`watch` / `leave_watch`) and receive a neutral-perspective event stream
(player letters instead of you/opponent): `game_start`, `turn`,
`move_applied`, `game_over`, `player_left`, `spec_end`, plus a `spec_state`
catch-up on join.

Every game is recorded to Firestore `games/` (names, minutes, moves in
order, result, status). The lobby's Past games list loads them via
`list_past` / `get_game` and replays move by move. The list is personal:
`list_past` returns only your own games and your accepted friends' games
(strangers' and machine-vs-robot games are not advertised). Clients
introduce themselves with a `hello` message after connecting (display
name + uid, self-reported — used for names, recordings, and the replay
filter, not security).

Spectators and replays see a real board in place of the robot face: chess
via `js/board.js` (chess.js, validates moves) or xiangqi via
`js/xiangqi.js` (display-only — the server stays authoritative, per the
integration contract). The room's `gameType` picks the renderer end to end:
creation (`solo`/`create_room`/`quick_match`), spectator catch-up
(`spec_state`), and recordings. A `position {fen}` feed (integration brief
§7) will later snap either board to the physical truth via `setFen()`.

The game type also themes the lobby: taps (`/tap`, `/bridge/tap`) accept a
`gameType` field from the reader — the physical board on the machine's
holder decides it — and `/redeem` returns it, so a tap lands the player in
a lobby styled for that game (`body[data-game]`): xiangqi swaps the Start
New Match decorations for 車/炮 discs, the difficulty slider and accents go
deep red, and the carousel cards pick up a red trim. The robot host and
layout never change.

## Friends & challenges (Phase 5)

The **Friends** button (top-right, under Sign out) opens the friends panel:
add by email, accept/decline requests, and challenge a friend. Friendships
and challenges live in Firestore (`friendships/`, `challenges/`) and sync
live to clients via listeners — the server is only involved in
`POST /lookup-user` (email → uid, requires the caller's Firebase ID token).

A challenge is a party code delivered by Firestore: the challenger creates
a normal room, the code rides the challenge doc, and accepting joins that
room. Challenging requires play mode (tap session); accepting also requires
play mode — both players tap in, as with any robot game.

## Stub server CLI

Type in the server's terminal to simulate arm-server events. (Or use the
browser dev panel — press `D` — whose "end game: I won / I lost" buttons
end the game for both players properly.) With one room,
bare commands work; with several rooms, prefix with `@CODE`:

```
turn a                  give the turn to player A (B sees "opponent_turn")
move e2e4 a             A played e2e4 (B sees it as opponent's move)
illegal a <reason>      A made an illegal move (A blocked, B waits)
fixed a                 board fixed and camera re-verified (sync_ok to both)
syncerr <detail>        camera does not match expected position
gameover a              A wins, B loses
rooms                   list rooms, members, and the quick-match queue
@XKCD turn a            same, but targeting room XKCD
help                    list commands
```

## Notes for the arm-server team

- The stub adds `{ "type": "sync_ok" }` to the draft event contract: the
  blocking illegal-move overlay needs a "board fixed / re-verified" signal.
  The client also clears the block on any subsequent `your_turn` /
  `opponent_turn` / `move_applied` as a fallback.
- Rematch is a small handshake: client sends `{ "type": "rematch" }`;
  server replies `{ "type": "rematch_offer" }` to the opponent and
  `{ "type": "rematch_start" }` to both once both agree (instantly in
  solo games — the robot always accepts).
- Client→server messages: lobby actions (`quick_match`, `create_room`,
  `join_room`, `solo`, `leave_room`, `rematch`), plus `signal` (WebRTC
  SDP/ICE relay) and `emotion` (emotion label relay). Everything else
  flows server→client.

## Variants, profiles & the registry

- **Special games**: the lobby's Special Games card lists staff-created
  rulesets from the `variants` registry. The CV team's staff site pushes each
  new ruleset via `POST /register-variant` (Bearer `BRIDGE_SECRET`,
  `{ id, name, nameZh?, description? }`); players read the live list via
  `GET /variants`. The variant id rides `create_room`/`solo` → room →
  `room_joined`/`spec_state` → the games recording. **Rule enforcement is
  never our server's job** — the station's engine validates; the website
  carries and displays the choice.
- **Profiles**: `POST /claim-username` (idToken + 3–16 char `[a-z0-9_-]`
  username, unique via a `usernames/` registry transaction; renaming frees
  the old one). `/lookup-user` now also accepts `{ username }` (friend search)
  and `{ self: true }` (the profile card).
- The lobby carousel holds any number of cards and spins through all of them.

## Offline kiosk mode (Raspberry Pi at the venue)

The same codebase runs on the Pi's touchscreen for people without a phone:
guests play vs the robot, no sign-in. The mode is automatic — no Firebase
credentials on the machine (no `.env`, no `server/service-account.json`)
puts the server in offline mode; `OFFLINE=1` forces it even with
credentials present.

- `/config.json` reports `offline: true`; the client then skips the auth
  screen, never downloads the Firebase SDK, and shows a solo-only lobby
  ("Guest" vs the robot). Recordings are skipped (no Firestore).
- Offline is about accounts, not the engine: with the `XQ_*` vars set (and
  `XQ_STATION_MAP` for the kiosk), the station watcher runs and "Play vs
  robot" starts a real machine game even in offline mode. Without them the
  guest game stays simulated. `/config.json` lists `stationDevices` only
  when the watcher is running.
- Nothing is fetched from the internet in either mode: fonts
  (`assets/fonts/`) and chess.js (`js/vendor/`) are vendored, so the page
  works the same behind a firewall or with no uplink at all.
- Pi quick setup: `node server/stub-server.js` at boot, then
  `chromium-browser --kiosk http://localhost:8080`. Install
  `fonts-noto-cjk` for the Chinese UI and `fake-hwclock` so TLS/cert
  checks survive power cycles without a real-time clock.

## Station kiosk with card login (online screens)

A machine screen with internet access runs the normal site with a station
parameter: `http://localhost:8080/game.html?station=STATION_A` (or the public
URL — any browser can be a station's screen). Kiosk identity comes from the
URL only: a bare typed URL is always spectator mode (sign in, watch live
games and friends' replays), even in a tab that was once a kiosk, and the
tap-login URL strip keeps the station param so a real kiosk keeps its
identity. In kiosk mode:

- Resting state is an attract screen ("Tap to play" + guest option + staff
  sign-in); the page connects and registers itself with `kiosk_hello` at
  boot, signed-out, and reconnects after drops without needing a login.
- A card tap (`/tap` with `cardId`) or a bridge tap with
  `deliver: "station"` pushes `station_login` to that screen, which
  navigates to the URL and signs the player in — no phone needed.
- Busy protection: a tap is rejected with `409 station busy` while the kiosk
  is in a game, holds a live session, or received a login within 10 s.
- Phone taps: the attract screen first asks where to play (this screen / my
  phone); the choice rides the game WebSocket (`kiosk_mode`). A plain bridge
  tap is then claimed by the screen (`delivery: "kiosk"` in the response) or
  released to the app (`delivery: "app"`) — no changes needed on the
  NexusBoard side beyond reading that field.
- Kiosk-delivered sessions are coupled: idle (2 min outside a game), refresh,
  close, or sign-out ends the whole session and frees the station. A game in
  progress never auto-locks.
- Test without hardware: `node server/.smoke-kiosk.js` registers as a fake
  kiosk; fire a card tap and watch the login arrive.
