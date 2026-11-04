# Bridge integration — follow-up confirmations

> **Superseded in part by bridge_reply_3.md (decoupled lifecycles).** Where
> this document says a refresh ends the *event* and frees the station, the
> current truth is: refresh ends only the *browser session*; the event stays
> `active` until app Disconnect or the 2-hour expiry, and the app can fetch a
> re-entry code with the same `eventId`. Kept for the record.

Both remaining details are settled, and the mechanism is already implemented
and tested on our side. Summary: yes to refresh-detection, yes to polling
instead of callbacks, and yes — we keep cancellation tombstones.

## 1. Refresh frees the station (your deadlock scenario)

We can distinguish the transitions, and the behavior is now live:

- **Refresh / new visit without a tap:** play access is tab-memory only, but a
  marker in the tab's sessionStorage survives the refresh. On boot, marker
  present + no tap code in the URL = "refresh just killed play" → the client
  immediately calls `POST /session-end`. No grace window involved.
- **Tab close:** a `pagehide` beacon ends the session best-effort; if the
  beacon is lost, the server's 90-second browser-loss grace catches the dead
  socket and ends it.
- **Temporary backgrounding / network loss:** no marker, no beacon — the
  90-second grace applies, and a reconnect inside it keeps the session.
- **Website Disconnect:** our Sign out control doubles as it — immediate
  `POST /session-end`, no grace. Both Disconnect controls (app and website)
  remain usable, as you asked.

So your scenario 5 works: refresh → website session ends at once → your next
`POST /session-status` poll returns `ended` → the Pi clears its saved
connection → a fresh tap is accepted. **Please make the Pi treat
`status: "ended"` (or `expired`) as clearing its saved connection** — that is
the hand-off point on your side.

## 2. Polling instead of callbacks — accepted, already live

`POST /session-status` on our HTTPS host, exactly as you proposed:

```http
POST /session-status
Authorization: Bearer <BRIDGE_SECRET>
{ "eventId": "..." }
```

Responses:

```json
{ "ok": true, "status": "pending",  "expiresAt": 1792655713832 }
{ "ok": true, "status": "active",   "expiresAt": 1792662631375 }
{ "ok": true, "status": "ended",    "reason": "refresh" }
{ "ok": true, "status": "expired",  "reason": "code_expired" }
{ "ok": true, "status": "unknown" }
```

- `pending`: code minted, not yet redeemed. `expiresAt` = code expiry.
- `active`: redeemed and alive. `expiresAt` = session max lifetime.
- `ended` `reason`: `app_disconnect` | `refresh` | `tab_closed` |
  `signed_out` | `replaced` | `disconnected` (grace) | `disconnect_before_create`.
- `expired` `reason`: `code_expired` | `max_lifetime`.
- `unknown`: we have never seen this eventId (and it was never ended).

Vocabulary update: `/bridge/tap` duplicate responses now use this same status
set — `redeemed` is folded into `active`. (`expiresAt` semantics above.)

No outbound callbacks from us at all; your HTTP-only hosting is untouched.
Your app-initiated Disconnect still calls `POST /session-end` with the Bearer
header as agreed.

## Retry and cancellation

- **Retry semantics:** agreed — retries reuse the tap's `eventId`; a new
  eventId only ever comes from a genuine new authorized tap. Duplicates
  report the existing session's real status and never extend it.
- **Disconnect racing a delayed bridge call:** handled with tombstones.
  `/session-end` for a never-created event stores an `ended_events` record;
  when the delayed `/bridge/tap` arrives it is rejected:
  `409 { ok: false, status: "ended", detail: "event was ended before it was created" }`.
  Tombstones are retained indefinitely (they are tiny). An event that *was*
  created keeps answering with its real session status instead of the 409.
- **Acks for `/session-end`:** success → `200 { ok: true, status: "ended" }`;
  already ended → `200 { ok: true, status: "ended", already: true }`;
  tombstone created → `200 { ok: true, status: "ended" }`. All idempotent —
  retry freely until any 2xx; no special schedule needed.
- **Maximum session lifetime:** yes, now defined — **2 hours from
  redemption** (server-configurable). A sweeper ends overdue sessions and
  locks any still-open tab; polling also sees `expired` / `max_lifetime`.
  The 5-minute unused-code expiry and 90-second browser-loss grace are
  unchanged.

## Test status on our side

Your scenarios 1, 3, 5 and 6 are verified end to end (tap → redeem → active;
duplicate → original status; refresh → browser locked, event stays active;
Disconnect-before-create → 409). Scenarios 2 and 4 exercise your side
(authorization rejection, app Disconnect) — tell us when your adapter is up
and we'll run the full matrix together. Funnel reachability from Shanghai is
still the open connectivity item.
