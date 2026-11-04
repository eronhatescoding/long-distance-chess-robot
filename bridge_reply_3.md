# Bridge integration — final confirmations

All clarifications accepted or answered below. The one open design question
(browser death vs. station occupation) is now decided and implemented:
**decoupled lifecycles**, matching your phone-as-a-card goal.

## Your three clarifications

1. **APDU response** — agreed and matches our record: `8040000000` after
   selecting AID `F04E4558555301` returns 32 ASCII credential bytes + the
   status word, 34 bytes total; the reader must check `90 00` before using
   the credential. (Reader-side detail; no website impact.)

2. **Returned-link transport** — agreed, and the wording in our integration
   document is corrected: HTTP between your components is a **demo-only
   limitation** acceptable for isolated disposable accounts. The link is a
   login credential until redeemed; real accounts require protected
   transport end to end.

3. **Station release timing** — agreed. Website-side ends appear on your
   next `/session-status` poll; the Pi releases after that short sync delay.
   Tab-close is best-effort beacon + 90 s browser-loss fallback, as before.

## Decoupled lifecycles (the decision)

Confirmed and live on our side:

- The **event** (your station occupation) ends ONLY on an app-initiated
  Disconnect (`/session-end` with `eventId`) or the 2-hour maximum from
  first redemption. Browser close, refresh, sign-out, and 90-second browser
  loss do **not** end it. Your poll keeps returning `active`.
- The **browser session** (play access in the tab) still ends on all of
  those — a refresh always locks the tab back to spectator.
- **Re-entry:** while the event is `active`, call `/bridge/tap` again with
  the SAME `eventId` and we return a one-time code (5-minute redemption
  window) — the currently live unused one if a retry follows a lost
  response, a freshly minted one otherwise. Unused re-entry codes never
  affect the event's status, and the event deadline never moves. This is how
  the player resumes after putting the phone away, and it requires the
  player's authenticated app, so a stranger at the machine cannot take over
  the station.
- Physical card taps (our separate card system) remain coupled — a card is
  always present to re-tap, so its browser end is a full end.

`/session-status` vocabulary is unchanged and continues to describe the
EVENT: `pending | active | ended | expired | unknown`.

## Secret hygiene — confirmed

`BRIDGE_SECRET` exists only in our server environment. It never appears in
browser JavaScript, and it is never needed by the APK or the Pi (both talk
only to Flask). The website authorizes its own clients with Firebase session
tokens; the browser's `/session-end` call uses the random per-session id
returned by `/redeem` as its capability — not the bridge secret. We will
deliver the secret over a private channel as you require.

## Status

Our side: complete and tested (tap → active; re-entry code; browser death →
event stays active; Disconnect → ended → fresh tap accepted; Disconnect
before create → 409). Your side: bridge adapter, authenticated URL-result
delivery, session-status sync. Joint test with isolated accounts when your
adapter is ready; Shanghai → Funnel connectivity check still open.
