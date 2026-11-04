# Bridge Brief — NFC Backend → Robot Chess Website

*The entire integration contract between the NexusBoard Flask/PostgreSQL
backend and the robot-chess website. One endpoint, one secret.*

## The flow

1. Player taps phone on a reader (PN532) → reader verifies the credential
   with Flask (`/api/hardware/nfc/verify-board`) — your system, unchanged
2. **After** account + reader + board + cluster authorization passes, Flask
   calls the bridge:
3. The website backend returns a one-time login URL
4. Your app polls Flask after Prepare tap, receives the URL once, opens it —
   the player lands on the website **already logged in, in play mode**

## The endpoint

```
POST https://eronkow.tail0202f0.ts.net/bridge/tap
Authorization: Bearer <BRIDGE_SECRET>        # header, never in the body
Content-Type: application/json

{
  "eventId": "<unique id per tap, e.g. uuid>",   // retries are safe
  "playerId": "P000123",                          // your stable SQL id
  "displayName": "<player's name>",               // shown on the website
  "clusterId": "7",                               // cluster authorized for THIS tap
  "clusterIds": ["7"],                            // all memberships (context)
  "stationId": "<your registered reader id>",
  "gameType": "xiangqi"                           // board on the holder; omit for chess
}
```

Responses:

```
200 { ok: true, uid: "sql_P000123", url: "https://...game.html?code=XXXXXXXX" }
200 { ok: true, uid, url, duplicate: true }   same eventId — same URL
401 bad bridge credentials
400 missing eventId / playerId
```

## Behavior to know

- The player's website identity is `sql_<playerId>` — no Firebase account is
  needed; the first tap creates the session implicitly.
- The redemption code is **single-use and expires in 5 minutes**. Deliver it
  to the app promptly.
- **Play mode does not survive a page refresh** — refreshing the site locks
  play again until the next tap. This is deliberate: tap = physically present.
- `gameType` themes the lobby and picks the board renderer (chess/xiangqi).
  Your board-identification NFC already knows which game it is — send it.

## Your checklist

- [ ] Connectivity test from the Shanghai server:
      `curl -X POST https://eronkow.tail0202f0.ts.net/bridge/tap -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" -d "{\"eventId\":\"test-1\",\"playerId\":\"P000000\",\"displayName\":\"Test\"}"`
      → expect JSON with a `url`. Timeout = tell us immediately.
- [ ] Flask: bridge call after successful verify-board
- [ ] Flask: store the returned URL against the player/session; expose it to
      the app's polling endpoint
- [ ] App: poll briefly after Prepare tap; open the URL once
- [ ] Deploy the SQL build to Shanghai

## Card taps

Physical player cards stay on our separate card system for this phase
(`/tap` + `cards` collection). A shared card bridge is a later conversation
once card identity mapping is agreed.
