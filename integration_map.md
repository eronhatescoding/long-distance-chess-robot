# NexusBoard ↔ Robot Chess — how the link works now

One page describing the whole integration as it stands. Both sides: read the
flow once, then check your "to do" list at the bottom.

## The pieces

- **Phone app** (NexusBoard): account login, NFC credential, tap UX, opens the
  returned link in the phone's browser.
- **NFC reader + Raspberry Pi**: reads the phone's credential and the board
  tag; holds the "station occupied" state.
- **Flask backend** (NexusBoard, Shanghai): verifies every tap against SQL
  records; the ONLY component allowed to assert identity to the website.
- **Robot-chess web server** (this project, HTTPS via Tailscale Funnel):
  mints one-time login links, runs the website, tracks session lifecycle.

## The tap flow

1. Player opens the app, logs in, prepares a tap → app fetches a short-lived
   NFC credential from Flask (`/api/player/nfc/issue`).
2. Phone taps the reader → Pi reads the credential (HCE APDU protocol:
   AID `F04E4558555301`, command `8040000000` → 32 ASCII chars) plus the
   board tag (which game is on the holder).
3. Pi → Flask: verify. Flask checks player status, reader, board context and
   cluster assignment (`/api/hardware/nfc/verify-board` path). If anything
   fails: **no bridge call, nothing happens on the website.**
4. Flask → our server:

   ```http
   POST https://eronkow.tail0202f0.ts.net/bridge/tap
   Authorization: Bearer <BRIDGE_SECRET>
   { "eventId": "<unique per authorized tap>", "playerId": "P000123",
     "displayName": "...", "clusterId": "7", "stationId": "<reader id>",
     "gameType": "chess" | "xiangqi" }
   ```

   Response: `{ ok, uid, url, status: "pending", expiresAt }`.
   Same `eventId` on retries — duplicates never create a second session.
5. Flask stores `url` against the authorized event/player.
6. App polls Flask briefly for its result and opens `url` once in the
   phone's external browser. **Demo limitation:** the link carries a one-time
   login credential, and our app↔Flask hop is HTTP — fine only for the
   isolated, disposable-account demo. Production requires protected
   transport for this hop.
7. The browser hits our `/redeem` with the one-time code (single-use,
   5-minute expiry) → signed into the website as `sql_<playerId>` →
   **play mode**. No Firebase account needed for the player.
8. While the session is live, Flask polls:

   ```http
   POST /session-status    (Bearer <BRIDGE_SECRET>)
   { "eventId": "..." }
   → { ok, status: "pending"|"active"|"ended"|"expired"|"unknown",
       reason?, expiresAt? }
   ```

   **When status is `ended` or `expired`, the Pi clears its saved
   connection** — the station is free for the next tap. (Website-side ends
   appear on your next poll — allow that short sync delay.)
9. The two lifecycles are **decoupled** (the phone acts as a card):
   - The **event** (station occupation) ends ONLY on: app Disconnect →
     Flask → `POST /session-end` (Bearer, `{ eventId }`), or the 2-hour
     maximum from first redemption.
   - The **browser session** (play access in the tab) ends on refresh,
     tab close, sign-out, or a 90 s browser loss — it never frees the
     station. To resume, the app fetches a **re-entry link**: call
     `/bridge/tap` again with the SAME `eventId`; while the event is
     `active` we return a one-time re-entry code (a retry after a lost
     response returns the still-live code; an expired/used one is replaced).
     The event deadline never moves, and an unused re-entry code expiring
     never changes the event's status.

## Card taps → the machine's screen (kiosk delivery)

For players without phones (e.g. printed cards for elderly players), a card
tap can deliver the login straight to the machine's touchscreen instead of
the app:

- Flask verifies the card→player mapping (cards live in NexusBoard SQL) and
  calls `/bridge/tap` with `deliver: "station"` plus the `stationId`.
- The station's screen runs our page with `?station=<stationId>` and
  registers over the game WebSocket; we push `station_login` to it and it
  signs in automatically.
- Busy rule: `409 station busy` while the screen has a live session, is in a
  game, or received a login within the last 10 s.
- Kiosk-delivered sessions are **coupled** (browser end = event end), and a
  2-minute idle timer (outside active games) ends the session so a walk-away
  player never leaves the machine occupied.
- App-initiated Disconnect still works and locks the screen too.

## Phone taps with a delivery choice ("ask")

**Replaced by kiosk-side mode selection** (the ask protocol caused bugs on
the NexusBoard side and is deprecated — kept working for compat, but unused):

- The station screen's attract page first asks the player where to play:
  "on this screen" or "on my phone". The choice rides the game WebSocket
  (`kiosk_mode`), so it's known BEFORE any tap.
- Flask sends plain phone taps exactly as the proven flow (no `deliver`
  field). If the station's screen is in "play here" mode and idle, we push
  the login to the screen instead of releasing it — and the `/bridge/tap`
  response's `delivery` field says `"kiosk"` (don't release to the app) or
  `"app"` (release as usual). No polling, no holding, no waiting state.
- Cards keep `deliver: "station"` and always go to the screen.
- `/session-status` still carries `deliverTo` (`"app"`|`"kiosk"`) for
  reconciliation.

### Legacy: the "ask" flow (deprecated)

`deliver: "ask"` still works: the kiosk prompts after the tap, the answer
goes via `POST /session-choose { code, choice }`, `deliverTo` stays null
until chosen (30 s default to `"app"`). Do not build on it.

## Website behavior the player sees

- Tap link → play mode (create party, quick match, vs robot).
- Manual visit → spectator only (watch live games, replay past games).
- Refresh or closed tab → the tab locks back to spectator, but the station
  stays occupied. The player reopens play through the app (which fetches a
  re-entry link); a stranger without the player's phone cannot take over.
- The Pi's own touchscreen runs a guest kiosk (play vs robot, no account) —
  independent of this flow.

## Transport rules (the only ones that matter)

- Everything **into** our server is HTTPS — already true via Funnel.
- The link we return is always `https://…ts.net/...`, so the phone browser
  lands in a secure context (camera works).
- App ↔ Flask over `ws://`/`http://` is a **demo-only limitation**: the
  returned link is a credential until redeemed, and HTTP can expose it.
  Acceptable for the isolated demo with disposable accounts; protected
  transport is required before real accounts.
- `BRIDGE_SECRET` exists only in our server environment — never in browser
  JavaScript, the APK, or the Pi config. Browsers authenticate with
  Firebase session tokens; the client-side `/session-end` call uses the
  random session id as its capability.

## To do — NexusBoard side

- [ ] Bridge adapter: after successful verification, call `/bridge/tap`
      (step 4), persist the returned URL + eventId, retry with the SAME
      eventId on timeout.
- [ ] App: result polling endpoint + open the URL once.
- [ ] Pi: clear saved connection when `/session-status` says `ended`/`expired`.
- [ ] From the Shanghai host: `curl -I https://eronkow.tail0202f0.ts.net/config.json`
      to prove mainland → Funnel connectivity.

## To do — robot-chess (website) side

- [x] `/bridge/tap`, `/redeem`, `/session-end`, `/session-status` — live,
      tested (tap → active; refresh → browser locked, event stays active;
      re-entry via duplicate on active → fresh code, same deadline;
      Disconnect → ended; Disconnect-before-create → 409 tombstone).
- [ ] Keep the laptop awake with Funnel running during joint tests.
- [ ] Send `BRIDGE_SECRET` over a private channel (never group chat).

Contract details and rationale: bridge_brief.md, bridge_reply.md,
bridge_reply_2.md (latest wins where they differ).
