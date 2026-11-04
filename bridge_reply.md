# Bridge integration — confirmations and answers

> **Superseded in part by bridge_reply_2.md and bridge_reply_3.md.** Notably:
> the refresh behavior below ("only a fresh tap re-arms play") was refined
> into decoupled lifecycles — refresh locks the browser tab, but the station
> event stays `active` and the app can re-enter without a new NFC tap.
> Kept for the record.

Thanks for the detailed review. Answers to your five points, in order. Short
version: we agree with your framing almost everywhere; the one place we
deliberately differ is refresh behavior (point 2), and we'd like the Disconnect
contract to be symmetric (point 1).

## 1. Disconnect / session synchronization

Agreed on the goals: Disconnect is a pure server-to-server concern — no NFC
exchange, no reader reset, no public port on the Pi. Proposal, symmetric:

**App-initiated Disconnect (Flask -> us):**

```
POST /session-end
Authorization: Bearer <BRIDGE_SECRET>
{ "eventId": "..." }
```

We lock any live website session created by that tap back to spectator mode.
Idempotent: an unknown or already-ended `eventId` returns
`{ ok: true, ignored: true }`. Because every tap gets a fresh `eventId`, a
delayed request can only ever end its own session, never a newer one.

**Website-initiated session end (us -> Flask):**

```
POST <your callback endpoint — you name it>
Authorization: Bearer <BRIDGE_SECRET>
{ "eventId": "...", "reason": "disconnected" | "expired" | "signed_out" }
```

We fire it when: the website client drops for more than a 90-second grace
window (phones background browsers constantly; a brief drop must not end the
session), the redemption code expires unused, or the player signs out.
Same idempotency rules on your side.

The app's Disconnect control remains the primary path; both sides converge on
the same session state keyed by `eventId`. We will implement `/session-end`
and the outbound callback on our side; contract is frozen as above so you can
build against it now. If you prefer separate secrets per direction, say so —
otherwise the one shared `BRIDGE_SECRET` covers both.

## 2. Refresh behavior

Tap-per-visit is a firm requirement on the website. A refresh or a closed tab
returns the player to spectator mode; only a fresh tap (new `eventId`, new
code) re-arms play. Rationale: the tap proves presence at the machine, and a
persistent unlocked browser would let someone play after walking away.

Consistency between the interfaces: your app may treat the session as active
until Disconnect or expiry — that is your Pi-facing state. The website's tab
is a view onto it that always requires a fresh tap. When your app Disconnects,
`/session-end` also locks any still-open website tab, so the two never
contradict each other for long.

## 3. Reachability

`https://eronkow.tail0202f0.ts.net` is Tailscale **Funnel** — public internet
ingress, no tailnet membership required. Both your backend (bridge calls) and
player browsers (the returned URL) reach it as ordinary HTTPS. Two caveats:

- For the demo it terminates on a laptop that must be awake with Funnel
  running. Production hosting (a VPS with a real domain) removes that.
- Shanghai -> ts.net TLS connectivity is unverified. Your planned curl test
  from the server settles it; if it fails we fall back to relaying bridge
  calls through a host you can reach.

## 4. Duplicates, redemption state, expiry

Implemented as you suggested, already live on our side:

- Fresh tap: `{ ok, uid, url, status: "pending", expiresAt }`
  (`expiresAt` = epoch ms, 5-minute lifetime).
- Duplicate `eventId`: `{ ok, uid, url, duplicate: true, status, expiresAt }`
  where `status` is `pending` | `redeemed` | `expired`.
- A duplicate **never** extends the original lifetime — `expiresAt` in the
  duplicate response is the original timestamp. When you see `redeemed` or
  `expired` and still want a session, start a new `eventId` (your per-tap
  flow does this naturally).

## 5. Game types

`gameType: "chess"` and `"xiangqi"` are both accepted; absent means chess.
**`"go"` is unsupported for now** — no renderer exists; please do not send it
yet. When we agree on the Go board format (JSON snapshot + placement/pass
events, SGF for history, per the earlier exchange) we will announce support.

## Test plan

Agreed on isolated accounts first. Our side is ready for: successful tap,
duplicate delivery, expired code, and `/session-end` followed by a fresh tap.
For rejected authorization we rely on your Flask side (you never call the
bridge on failure). Physical cards stay on our separate card system this
phase, as you proposed.
