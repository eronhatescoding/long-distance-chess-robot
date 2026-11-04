# Server integration brief 2 — Xiangqi station backend (camera/arm)

*Supersedes the WebSocket-contract assumptions in server_integration_brief.md
for this integration. That README contract still applies to any future
browser-facing game server; the Xiangqi station backend is REST-only and
browsers never talk to it.*

## Agreed demo shape

- Each station runs **human vs bot** Xiangqi: camera validates the human's
  physical moves, the MG400 arm plays the bot's replies.
- Remote-human (two stations sharing one game) is **not** in this phase —
  it needs a two-device data model on the station backend.
- The website adds the online layer: tap-to-play identity, live spectating
  of station games, replays, friends.
- Chess is digital-only until the camera side adds it.

## Architecture

```
station (Pi + camera + arm)  ←→  his Xiangqi server (rules/bot, REST)
                                          ↑  polled every ~2.5 s
                                     OUR server (station watcher)
                                          ↓  existing WebSocket
                                      browsers (lobby, spectators, kiosk)
```

Our server holds a **read-only reader key** and calls only:

- `GET /api/xiangqi/devices/{id}` → `active_game_id` discovery
- `GET /api/xiangqi/games/{id}` → full state + move list (read-only)

We never call `/sync` (it's a station write) and never submit moves.
Each active station game becomes a "virtual room" on our side, so live
spectating, the lobby list and Firestore recordings work unchanged.

## Confirmed on his side (ef8a998, agent/claude branch)

- Read-only game endpoint with move list (`ply`, `by`, `side`, `source`,
  `destination`, `piece`, `captured`), `command_expired`, `moves_complete`.
- Device endpoint with `active_game_id` (null once the game is finished).
- Reader keys: `provision_xiangqi_device.py --reader NAME --output DIR`;
  rejected on all write routes; a reader can read any device's games.
- Camera-free simulation games can be created and driven over the API
  (`tests/run_xiangqi_http_demo.py`).

## Confirmed on our side (built and mock-tested)

- Station watcher: polls both endpoints, projects games into virtual rooms,
  streams `move_applied`/`turn`/`game_over` to spectators, records every
  game (including games that finished while we were offline).
- Move translation: his `B3` → renderer `b2` (A–I × 1–10 → file a–i,
  rank−1). **Open assumption: his rank 1 is red's home rank** — to be
  verified against the sample JSON below.
- Station games carry `minutes: null` (his engine has no clocks); the
  spectator UI hides clocks for them.

## Still needed from him

1. Merge `agent/claude` → main, deploy the server behind a **named tunnel**
   (stable HTTPS URL; quick tunnels change every restart; no redirects).
2. A sample `GET /api/xiangqi/games/{id}` response body from the simulation
   demo + the piece-name table (`r_shuai` …) — pins down the exact contract.
3. A provisioned reader key for our server, sent over a private channel.
4. The base URL when deployed.
5. **Variants registry push**: when staff create a special ruleset on your
   side, POST it to us so players see it in the lobby's Special games card:

   ```http
   POST /register-variant     (Bearer <BRIDGE_SECRET>)
   { "id": "blast3x3", "name": "Blast captures (3×3)", "nameZh": "爆炸吃子 (3×3)" }
   ```

   The variant id then rides every game-start (room events + the games
   recording). Your engine stays the referee — we only carry the choice.

## Joint test plan (when his tunnel is live)

1. He starts a simulation game; it appears in our lobby's live list.
2. Spectator opens it and watches moves stream in real time.
3. Game ends (rules or resign) → spectator sees game over → recording
   appears in Past games and replays correctly.
4. Station goes offline mid-game → watcher logs it, no phantom rooms.
5. Repeat on physical hardware with camera + arm.
