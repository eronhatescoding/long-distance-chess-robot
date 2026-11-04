# Server Integration Brief — NexusBoard / Robot Chess

*For the teammate building the game/arm server (Alibaba Cloud). Read fully before
architecting — two items below are project-level constraints.*

## 1. Region (critical)

**Do not deploy in mainland China.** Google APIs (Firebase Auth, Firestore) are
blocked there, and the entire login/tap/friends stack depends on them. Use an
Alibaba **Hong Kong or Singapore** region — this also avoids ICP filing if a
domain is bound later.

## 2. Architecture: split databases, shared identity

The team agreed data can be split across databases. The rule that makes it work:

**Firebase Auth is the only identity system.** Clients hold a Firebase ID token;
every server verifies it with the Firebase Admin SDK (`verifyIdToken`) and uses
the `uid` as the user key everywhere. No second account system, ever.

Current data ownership (Firebase project `nexusboard-d4432`):

| Collection | Contents | Owned by |
|---|---|---|
| `users` | profiles, `clusterId`, role | web server (Admin SDK) |
| `cards` | RFID card → uid | web server |
| `tap_sessions` / `hce_tokens` | tap-to-play login flow | web server |
| `friendships` / `challenges` | social layer (clients read/write per `firestore.rules`) | Firebase direct |
| `clusters` | cluster registry | web server |
| `games` | recorded games for spectating/replay | **game server** (moves come from you) |

Your server owns: live game state, matchmaking, robot telemetry/logs, and the
game recording stream. Anything you want in your own DB is fine — keep `games`
recordings compatible with the existing spectator/replay contract (see §4), or
write them to Firestore with a service account.

## 3. The client contract (do not break)

The website (`game.html` + `js/client.js`) speaks a fixed WebSocket protocol,
fully documented in the repo README ("Stub server CLI" + "Notes for the
arm-server team"). Summary:

- Client → server: `quick_match`, `create_room {minutes}`, `join_room {code}`,
  `solo {difficulty}`, `leave_room`, `rematch`, `signal`, `emotion`, `hello`
  (display name + uid — replace with verified ID token auth, see §5),
  `watch` / `leave_watch` / `list_games` / `list_past` / `get_game` (spectating)
- Server → client: `welcome`, `room_created`, `match_waiting`, `room_joined`,
  `lobby`, `opponent_connected {name, uid}`, `opponent_disconnected`,
  `game_start {first}`, `your_turn`, `opponent_turn`, `move_applied {move, by}`,
  `illegal_move {reason, for}`, `opponent_fixing_move`, `sync_ok`,
  `sync_error {detail}`, `game_over {result}`, `rematch_offer`, `rematch_start`,
  plus the spectator stream (`spec_state`, neutral `game_start`/`turn`/
  `move_applied`/`game_over`, `player_left`, `spec_end`)

The robot referee replaces the CLI: `turn <a|b>`, `move <uci> <a|b>`,
`illegal <a|b> <reason>`, `fixed <a|b>`, `syncerr <detail>`, `gameover <a|b>`.
`sync_ok` is a required addition over the draft — the illegal-move blocker
waits for it.

**Recommended path:** build on `server/stub-server.js` in the repo — all of the
above (rooms, spectating, recording, tap endpoints) already works and is tested.
Your job becomes: arm connection + game events. Writing from scratch means
reimplementing the contract exactly.

## 4. Robot arm link

`robot_controller.py` on the machine PC exposes a WebSocket (port 8765).
**The machine should connect outbound to your server**, not the reverse —
venues/school networks won't allow inbound. Each machine authenticates with its
station credentials (`STATION_<ID>_SECRET` env pattern) and registers as
station `<ID>`; the server binds games to stations.

## 5. Client identity on your server

Today `hello` is self-reported (fine for the stub). On the real server:

1. Client sends `{ type: "auth", idToken }` right after connect
2. Server: `admin.auth().verifyIdToken(idToken)` → uid; reject/close on failure
3. Use the uid for names, recordings, and the cluster check below

Cluster enforcement: a player may only start a robot-controlled game if
`users/{uid}.clusterId` matches the station's cluster. Unassigned players can
spectate but not play. Enforced server-side (both at tap issuance on our side
and at game start on yours).

## 6. Deployment checklist

- Node.js ≥ 20.12 (we use `process.loadEnvFile`; dev on v24)
- HTTPS mandatory: the Android app only opens HTTPS URLs and browsers require
  a secure context for camera/mic (WebRTC). Domain + cert (Caddy or Alibaba
  SLB/CDN TLS). A bare IP over HTTP will not work.
- Secrets arrive via a secure channel (never group chat): Firebase service
  account JSON, station secrets. Coordinate handover when ready.
- `.env` drives config: `PUBLIC_BASE_URL`, `STATION_<ID>_SECRET`,
  `STATION_<ID>_CLUSTER`, Firebase credentials — see `.env.example`.

## 7. Board position feed (future — agreed contract with the NFC team)

The NFC side currently identifies board + game type and authorizes players;
piece-position sensing is future work on their side. The agreed shape for
when it lands:

| Game | Full position | Move format |
|---|---|---|
| Chess | Standard FEN | from/to coordinates incl. promotion (UCI — already our `move` format) |
| Xiangqi | Xiangqi FEN (WXF convention; agree orientation + piece letters first) | from/to coordinates on 9×10 |
| Go | JSON snapshot (board size + stone coordinates) | placement or pass, incl. captured stones |

Rules of engagement:

- Publish after each completed move; a full position snapshot is available
  for spectator (re)connection.
- Every position event carries game ID, board ID, sequence number, timestamp.
- **`gameType` rides every game from creation**: rooms, recordings, and
  spectator events carry it (chess today; xiangqi already renders on the
  client). Add it to the position-feed envelope from day one — retrofitting
  it later touches every producer and consumer.
- The game server stays authoritative for turns, clocks, and rule validation.
  The physical board reports uncertain readings as `sync_error`; the server
  emits `illegal_move` when a proposed move fails validation.
- Go additionally uses SGF for recorded games/export (a snapshot alone can't
  support repetition checks).

Spectator boards can be built from the move stream alone today; the position
feed upgrades them to self-correcting snapshots later.

## 8. Integration sequence

1. Answer the open questions (region, build-on-stub vs scratch, domain)
2. Deploy `stub-server.js` unchanged on the Alibaba server → smoke-test
   WebSocket + `/tap` against it
3. Point DNS + `PUBLIC_BASE_URL` at it; re-run the tap flow end-to-end
4. Wire arm events in place of the CLI referee
5. Full loop: tap card/phone → play → arm moves → spectators watch → replay
   appears in Past games
