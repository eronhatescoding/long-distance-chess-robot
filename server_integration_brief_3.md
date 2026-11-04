# Integration brief — what the website needs from the engine (3 Nov 2026)

Context: the website side is built and tested against a mock implementing the
shapes below. Everything here comes from your own answers to the 33-item list
and the PvP follow-ups — this document just fixes them as the contract. Where
you've since decided something differently, say so and we adapt on our side.

Already working between us (no action needed): reader-key polling of
devices/games, move streaming, custom openings via `initial_board`, finished
games recorded for replay, station screens auto-following their games.

## What to build, in the order we agreed

### 1. Paused/error state + version (your current task)

- Game object gains `paused: true|false` and `error: string|null` (whatever
  you already store internally is fine — we just need to see it).
- `GET /api/health` already exists; add the deployed version/commit anywhere
  convenient (`GET /api/version`, or a field in health).

Website behavior once live: paused/error shows a bilingual "fix the board"
overlay on the kiosk and spectator screens; clearing it resumes play.

### 2. PvP rooms in the reader API

- Both devices list the shared room id in `active_game_id` (and
  `unfinished_game_ids` while unfinished). Same id on both — our dedup
  expects exactly that.
- `GET /api/xiangqi/games/{id}` returns the room in the normal game shape:
  - `phase`: `waiting_partner` | `playing` | `finished` (your internal
    arm-copy step can stay `playing`)
  - `moves`: `{ply, side, source, destination, piece, captured}` — no `by`
    field needed; we key on `side`
  - `winner`: `red` | `black` | `draw` | null
  - `result_reason`: resign, agreement, checkmate, stalemate,
    perpetual_check, perpetual_chase, repetition, natural_movecount,
    insufficient_material (no operator_restart for PvP — leaving = resign)
  - `updatedAt`: bump only on website-visible changes (join, move, phase
    change, result) — your planned semantics, so a stall reads as frozen
    timestamp + one station `online:false`
  - stations with sides: e.g. `stations: [{device_id, side, online}]` so each
    kiosk can show its own player's POV and we can label both names
- `waiting_partner` rooms expose the creator's device id and side. The join
  code stays out of the reader API (agreed — it's the seat's only secret).

Website behavior once live: lobby shows "waiting for opponent" rooms; when
the second station joins, both kiosks show their own player's POV and
spectators get the neutral view; replays record as usual.

### 3. Writer keys + website create / abort / resign

- New credential type: a website writer key (same Bearer + X-Reader-ID header
  style is fine), distinct from reader and station keys.
- `POST /api/xiangqi/games` accepting the writer key:
  - body: `{ game_id, device_id, mode, human_side, initial_board?, opening? }`
  - `game_id` is chosen by us (format `web-<uuid>`) — same id + same settings
    returns the existing game (your existing idempotency, keep it)
  - the game sits as a request the station terminal picks up; the station
    starts it once its camera confirms the board matches
  - 409 when the device has any unfinished game (your suggestion — agreed)
- `POST /api/xiangqi/games/{id}/abort` with the writer key: ends as finished,
  winner null, reason `operator_restart` or a new `website_abort` — either is
  fine, we'll map it.
- `POST /api/xiangqi/games/{id}/resign` with the writer key: finishes with
  the other side as winner, reason `resign`. (The kiosk's "End game" button
  uses abort; a future in-game resign button uses this.)
- Station pickup: the terminal polls (or is pushed) requested games for its
  device, then runs its normal start flow. Until pickup, the game should be
  visible to us somehow — `unfinished_game_ids` is enough.

### 4. Later (not blocking): clocks, bot difficulty, variants

No clocks on machine games for now; the website hides its clock UI for them
already. Difficulty slider and variant chips will be hidden on kiosks until
these exist.

## The flows we're building to

**A. Website-controlled bot game (player vs robot at a machine)**
1. Player taps card at the machine → screen signs in (already working).
2. Player picks "Play vs Robot" → website POSTs create with a `web-` game id.
3. Station picks up the request, camera verifies the board, game starts →
   appears in `active_game_id`.
4. Physical moves: camera-confirmed, append-only, in the game object.
5. Bot moves: arm executes, camera confirms, then the move appears
   (contractual — keep it).
6. The kiosk shows the player's POV, spectators the neutral board, moves
   animate on both.
7. End: phase finished + winner + reason → result screens, replay saved.

**B. PvP machine vs machine**
1. Station A creates a room (join code on its own terminal, not the API).
2. Reader API shows the room as `waiting_partner` → our lobby shows
   "waiting for opponent".
3. Station B joins → both devices report the room as playing.
4. Each move records only after both cameras confirm; our screens mirror it.
5. Leaving = resign; draws by agreement. If a station goes dark, moves are
   refused and we show the stall (frozen timestamp + offline flag).

**C. Failure handling**
- Camera confusion mid-game → `paused`/`error` → our overlay; clears on
  recovery.
- Player walks away → the website aborts via the writer key; the arm stops
  once idle (station confirms).
- Station program dies → `online:false` → we abandon the game on our side
  after 60 s and free the kiosk.

**D. What the website handles (nothing for you to build)**: tap-to-login,
session lifecycle, spectator lobby, replays, bilingual UI, turn/result
presentation, move animations.

## Testing together

Each item lands → tell us → we integration-test that piece the same day
(your simulators + our harnesses; no hardware needed until the final
physical run). Suggested joint acceptance at the end: one website-started
bot game on the real machine, and one two-station PvP game with spectators
watching both kiosks and a phone.
