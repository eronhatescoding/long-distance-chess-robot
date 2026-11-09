# Bridge integration — tap speed and reliability (reply to the 9 Nov request)

Status: **implemented and tested locally, not yet deployed.** No live
stage timings exist yet; they appear in the server log and on each session
document once this is running (see "Timings" below). No codes, tokens,
secrets or login URLs appear anywhere in this reply.

Base: `cbd1d80` (the commit your patch targeted). New commits on `main`:

| Commit | What | Roll back alone? |
|---|---|---|
| `a098054` | Your `friend-browser-startup.patch` (SHA-256 `b9fbf011…c3e9` verified), applied unchanged, + `npm test` | yes |
| `35e18bd` | **Sign-out fix**: tap flow owns the screen until redeem + Firebase finish; timeouts; visible kiosk error | yes |
| `ee668c8` | Transactional bridge create / re-entry / Disconnect tombstone / redeem; timings; codes no longer logged | yes |
| `99f21d3` | In-place kiosk login (no page reload) + `tap_ready` diagnostics | yes |
| `bea7ccd` | Static files: public allowlist (**security**, below) + versioned caching | yes |
| `25ebdd6` | Follow-up to `35e18bd`: compare users by uid | with `35e18bd` |

## 1. Event `f902ee63-…` stayed `active` after website Sign out — cause found

Traced through the code; the server log of that run was not available to
us, so the exact responses are inferred from the code, not read from logs.

- Sign out on a kiosk ends a coupled event only if the page knows its
  **session id**, which it learns from `/redeem`.
- The kiosk browser still had a **cached Firebase login for the same
  player** (P000014 had used station 2 earlier that day; a kiosk session
  that ends by Disconnect, idle lock or game end does not sign Firebase
  out). On the tap, the page reported that cached user to the app straight
  away, before `/redeem` had returned, and therefore without a session id.
- `/redeem` then succeeded (≈ 11:52:09.447 UTC, matching your deadline
  arithmetic) and Firebase signed in again **as the same uid**. Firebase
  does not fire a new auth-state event for an unchanged uid, so the session
  id never reached the app.
- Sign out therefore had no session to end. `endTapSession` returned
  without calling `/session-end`, the event kept no `endedAt`, and
  `/session-status` correctly kept answering **`active`**. That includes
  the acknowledged polls at 11:56:35.669 and 11:56:41.057 UTC. The same gap
  also skipped linking the kiosk socket to the session, so the 90 s
  browser-loss fallback could not end it either.
- Your Disconnect worked because it ends the event by `eventId`
  server-side and does not depend on the browser.

Fix (`35e18bd`): while a tap sign-in runs, cached users are not reported;
the flow reports the player only after `/redeem` and Firebase both
succeed, always with the session id. Coupled kiosk lifecycle unchanged:
**website Sign out ends the station event**. The phone/app rule is
untouched.

## 2. What changed

**Browser**
- Your startup patch (config fetched during UI setup; auth not blocked by
  friends/Firestore; offline kiosks still load no Google SDK).
- Tap sign-in is one shared flow (initial `?code` links and kiosk pushes):
  `/redeem` 15 s per attempt, at most 3 attempts with a single attempt id,
  then Firebase sign-in limited to 20 s. On failure the kiosk attract
  screen shows the reason (timeout / network / used or expired code).
  Before, the error went to a hidden form and the screen stayed on
  "signing you in…".
- `station_login` is redeemed **in place** with the running Firebase Auth:
  no navigation, no second startup chain, no pagehide/refresh end. History
  stays `?station=<id>`; station registration and replacement rules
  unchanged. A repeated push of the same code joins the running sign-in; a
  late duplicate after it finished is ignored; a push naming another
  station is ignored. If auth failed to load, the old navigation is used.

**Server**
- `/bridge/tap`: creation runs in one Firestore transaction over a new
  `bridge_events/{eventId}` index, the legacy `eventId` query and the
  `ended_events` tombstone. Concurrent duplicates create one session, and a
  Disconnect that arrives first always wins. Existing sessions are found
  and indexed, never recreated or reset.
- Re-entry codes are minted in a transaction (concurrent retries agree on
  one code). The deadline still comes from the first redemption.
- App Disconnect before creation writes its tombstone in the same
  transaction that confirmed there was no session.
- `/redeem` rechecks inside its transaction that the code still matches
  the session and is unused and unexpired, and that the event has neither
  ended nor passed its original 2 h deadline. **Lost response:** a retry
  carrying the same random attempt id (stored only as a SHA-256 hash) gets
  the same answer while the code's 5-minute window lasts. Any other caller
  gets "already used". No new event is ever created.
- Duplicate replies now include `delivery` and `delivered`. A kiosk login
  is not re-pushed within 20 s of the last push for the same session. An
  active kiosk event no longer mints app re-entry codes.
- Unchanged: Firebase Authentication, single-use codes, the 5-minute
  unused window, the 2 h deadline, staff/player rules, `deliver:
  "station"`, the phone path, and the meanings of `delivery`, `delivered`
  and `/session-status`. `deliver: "ask"` is still accepted as before; we
  did not reintroduce it anywhere.

**Static files**
- **Security fix:** the server returned *any* file under the project
  root, including `.env` (bridge secret, Firebase key) and
  `server/service-account.json`. Now only the website itself is served.
  **Recommendation: treat the bridge secret and the Firebase service
  account key as possibly exposed and rotate both after deploying.** We
  have not checked whether anyone fetched them.
- Caching: pages pin scripts, styles and an import map for every ES
  module to one release version, so an old helper and a new client cannot
  mix. Versioned URLs: one year, immutable. Other public assets: ETag
  revalidation (304). HTML: `no-cache`, and `no-store` when it carries a
  code or token. All API responses: `no-store`.

## 3. Timings (sanitized)

Server log lines `[timing] event <id> session <id>: …` and the session
document field `timing`:

| Stage | Field |
|---|---|
| bridge request accepted | `bridgeAcceptMs` |
| kiosk push → redeem completed | `pushToRedeemMs` |
| redeem handler / token creation | `redeemMs`, `tokenMs` |
| browser: redeem, Firebase, UI | `browser.redeemMs`, `browser.firebaseMs`, `browser.uiMs`, `browser.path` |
| kiosk push → screen ready | `pushToReadyMs`, `bridgeToReadyMs`, `uiReadyAt` |

These keep "request accepted", "redeemed" and "screen ready" separate.

**Proposed acknowledgement (not active in the contract):** the browser
already sends `tap_ready { sessionId, timings }` over its game socket
after the play UI is visible. The server accepts it only from the socket
linked to that session, and records `uiReadyAt`. If you agree, we would add
an optional `screenReadyAt` (ms) to `/session-status`, present only once
recorded. It is not set by a reconnect without a fresh `tap_ready`. Until
you have reviewed it, `/session-status` does not include it.

## 4. Tests

`npm test`: **26 passed, 0 failed**
- 11 from your patch (`tests/client-boot.test.cjs`).
- 11 lifecycle tests (`tests/tap-store.test.cjs`) run against an in-memory
  Firestore with real optimistic-transaction retries and interleaved
  requests:
  - 6 concurrent deliveries of one event create one session.
  - A legacy session is found, not duplicated.
  - Disconnect racing creation: 40 interleavings, never a playable event.
  - Concurrent re-entry: one code.
  - A replaced code, an ended event, a passed deadline and an expired
    code are all refused.
  - Lost response: only the same attempt id gets the answer again.
  - 4 browsers on one code: exactly one wins.
  - Status meanings unchanged.
- 4 static tests: secrets are never served; only versioned assets are
  cached long-term; HTML with a code is `no-store`; the version changes
  with the files.
- Local server smoke test without credentials: `.env`-style paths return
  404, versioned assets return `immutable`, revalidation returns 304, and
  the page loads the whole module graph versioned with no script errors.

**Not yet tested:** real Firebase sign-in, a physical card or phone,
station 2 timings, the friends UI, real Firestore transaction contention.
Please run your physical sequence after we deploy, with one station-2 tab.

## 5. Deploy and roll back

Deploy: pull `main` on the website server and restart it (server and
browser changes ship together). No data reset, no credential change, no
Firestore index needed.

Roll back: `git revert <commit>` for any single row above, then restart.
Or check out `cbd1d80` and restart for everything. The `bridge_events`
index documents are additive; the old code ignores them.

## Separate note

`assets/fonts.css` points at `assets/<font>.woff2`, but the files are in
`assets/fonts/`, so the vendored fonts have never loaded (9 × 404 per page
load). This is visual only, the bug predates these changes, and we have
left it for the site owner.
