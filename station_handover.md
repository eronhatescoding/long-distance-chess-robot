# Station integration — status and remaining work

*For the Xiangqi station backend (CV/rules/arm) team. Context: this is the
spectator-website side talking. Everything below under "done" is built,
tested, and running on our side — do not rebuild it. "Missing" is your side.*

## Verified working together (26 Oct, via your trycloudflare tunnel)

- Our watcher connected to your live API, discovered simulation games via
  `GET /api/xiangqi/devices/{id}`, streamed moves from
  `GET /api/xiangqi/games/{id}`, rendered them on the website's spectator
  board, and archived finished games as replays.
- Custom openings (`initial_board`) are supported: we translate the board
  dict to WXF FEN (`r_shuai→K`, `b_zu→p`, etc.) and replay from it.
- Your orientation answer is baked in: rank 1 = red home, files A–I left to
  right.

## What we built (the website side — done)

1. **Station watcher** (in our game server): polls your read-only endpoints
   every ~2.5 s per station and projects each active game into a spectatable
   room. Config via env: `XQ_API_BASE`, `XQ_READER_ID`, `XQ_READER_KEY`,
   `XQ_DEVICES=deviceId:Name,...`, `XQ_POLL_MS`.
2. **Live spectating**: station games appear in the website lobby's "Live
   games" list; watchers get the full move stream in real time.
3. **Replay archive**: every game is recorded move-by-move; games that finish
   while we're offline are still captured on next sight. Replays honor
   `initial_board`.
4. **Result safety**: if a game finishes between polls we take one final read
   so the result isn't lost.
5. **Station touchscreen flow** (with the NFC teammate): attract screen,
   card-tap login pushed straight to the machine's screen, busy protection
   (taps ignored while a game runs), 2-minute idle lock. The same screen can
   show the live digital board of the station's own game — usable as your
   CV verification display.
6. **Test harness**: a mock of your API + smoke clients, so contract changes
   can be regression-tested without hardware.

## Missing on your side (in order)

1. **Deploy the API to Aliyun**: persistent database, stable HTTPS URL
   (named tunnel or domain — quick tunnels change every restart), and the
   reader-key hash configured (`server.env`). We flip one config line and
   we're live.
2. **Physical station run**: Pi + camera + arm playing a real game that
   flows through the API. Current physical state is unknown per your
   handover — that's the next unknown to retire.
3. **CV reliability work** (your current focus): confidence scoring, the
   digital-board disambiguation loop (on uncertainty, compare against the
   server's known position and re-scan only the affected squares — never let
   the model override the camera), and a `sync_error` surfaced when truly
   stuck so the station screen can ask the player to fix the board.
4. **Simulation availability for joint tests**: keep
   `server/tools/simulate_xiangqi_spectator.py` (or a tunnel) runnable so we
   can retest after any contract-affecting change.

## Contract reminders (the parts that must not drift)

- `GET /api/xiangqi/devices/{id}` → `active_game_id` (null when finished),
  `unfinished_game_ids`, `online`.
- `GET /api/xiangqi/games/{id}` → read-only, append-only `moves` with
  `ply/by/side/source/destination/piece/captured`, plus `phase`, `winner`,
  `result_reason`, `human_side`, `turn`, `gameType`, `moves_complete`,
  `updatedAt`, `initial_board` when custom.
- Reader keys: Bearer + `X-Reader-ID`; rejected on write routes.
- Squares: files A–I, ranks 1–10, rank 1 = red home.

## Out of scope for this phase (don't build)

Remote-human mode (two stations sharing one game), chess support on the
camera side, spectator push (polling is fine).

## Acceptance test when deployed

We watch a simulation game appear in the website's live list within ~3 s,
stream every ply to a spectator, show game over with the winner, and replay
the game correctly from the archive. Then the same with real hardware.
