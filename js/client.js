/* Game client (Step 3) — WebSocket to the arm-server (or stub), maps server
 * events onto the robot face and the overlay layer.
 *
 * Lobby / room contract:
 *   -> { type: "quick_match" } | { type: "create_room" } | { type: "solo" }
 *      | { type: "join_room", code } | { type: "leave_room" }
 *   <- { type: "welcome" }                            connected, in lobby
 *   <- { type: "room_created", code }                 share the code
 *   <- { type: "match_waiting" }                      quick-match queued
 *   <- { type: "room_joined", code, player: "A"|"B", solo?: true }
 *   <- { type: "lobby" }                              back in the lobby
 *   <- { type: "error", detail }
 *
 * Solo rooms: you are A, the robot is B (driven by the server / referee).
 * No video call — the robot face on the base layer IS the opponent.
 *
 * Game event contract (draft + sync_ok addition):
 *   { type: "opponent_connected" } / { type: "opponent_disconnected" }
 *   { type: "game_start", first: "you"|"opponent" }   coin flip result
 *   { type: "your_turn" } / { type: "opponent_turn" }
 *   { type: "move_applied", move: "e2e4", by: "you"|"opponent" }
 *   { type: "illegal_move", reason: "...", for: "you"|"opponent" }
 *   { type: "opponent_fixing_move" }
 *   { type: "sync_ok" }                           board fixed & re-verified
 *   { type: "sync_error", detail: "..." }
 *   { type: "game_over", result: "win"|"lose" }
 *   { type: "signal", data: ... }                 -> handled by js/video.js
 *   { type: "emotion", label: "..." }             -> handled by js/emotion.js
 *
 * Auth (Phase 1, js/auth.js): nothing below runs until Firebase resolves.
 * Play actions are locked unless the session is in "play" mode (tap link).
 */

// auth.js and friends.js pull the Firebase SDK from a Google CDN, so they are
// imported dynamically at boot — only when /config.json says we're online.
// On the offline kiosk they are never even downloaded.
import { initBoard } from "./board.js";
import { initXiangqi } from "./xiangqi.js";
import { t, getLang, toggleLang, onLangChange, applyStaticTexts } from "./i18n.js";

(() => {
  // Kiosk station mode: ?station=<id> marks this page as a machine's
  // touchscreen. From the URL only — never sessionStorage: a bare typed URL
  // must always be spectator mode, even in a tab that was once a kiosk. The
  // tap-login URL strip keeps the station param (auth.js), so a real kiosk
  // keeps its identity across the login navigation and refreshes.
  const bootParams = new URLSearchParams(location.search);
  const stationKiosk = bootParams.get("station") || null;

  const blocker = document.getElementById("blocker");
  const blockerTitle = document.getElementById("blockerTitle");
  const blockerReason = document.getElementById("blockerReason");
  const faceLayer = document.getElementById("faceLayer");
  const videoLayer = document.getElementById("videoLayer");

  /* ---------- chess clock ---------- */
  const clockMe = document.getElementById("clockMe");
  const clockThem = document.getElementById("clockThem");
  const clockMeTime = document.getElementById("clockMeTime");
  const clockThemTime = document.getElementById("clockThemTime");
  const clockThemLabel = document.getElementById("clockThemLabel");
  const clockMeLabel = clockMe.querySelector(".clock-label");
  let clockStartMs = 5 * 60 * 1000;
  let myMs = clockStartMs;
  let themMs = clockStartMs;
  let clockActive = null; // "mine" | "theirs" | null (paused)
  let clockLast = 0;
  let clockTick = null;

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function renderClocks() {
    clockMeTime.textContent = fmtClock(myMs);
    clockThemTime.textContent = fmtClock(themMs);
    clockMe.classList.toggle("active", clockActive === "mine");
    clockThem.classList.toggle("active", clockActive === "theirs");
    clockMe.classList.toggle("low", myMs <= 10000);
    clockThem.classList.toggle("low", themMs <= 10000);
  }

  function resetClocks() {
    myMs = themMs = clockStartMs;
    clockActive = null;
    clockMeLabel.textContent = t("clock.you"); // spectating relabels both clocks
    clockThemLabel.textContent = soloMode ? t("clock.robot") : t("clock.opp");
    clockMe.classList.remove("hidden");
    clockThem.classList.remove("hidden");
    renderClocks();
    // Resume immediately from the current turn instead of waiting for the
    // next turn event (there may not be one for a while mid-game).
    if (turnState === "your_turn") setActiveClock("mine");
    else if (turnState === "thinking") setActiveClock("theirs");
  }

  function hideClocks() {
    clockActive = null;
    clearInterval(clockTick);
    clockTick = null;
    clockMe.classList.add("hidden");
    clockThem.classList.add("hidden");
  }

  // Only the side to move runs down; the other is paused.
  function setActiveClock(side) {
    if (clockMe.classList.contains("hidden") || side === clockActive) return;
    clockActive = side;
    renderClocks();
    if (side && !clockTick) {
      clockLast = Date.now();
      clockTick = setInterval(() => {
        const now = Date.now();
        const dt = now - clockLast;
        clockLast = now;
        if (clockActive === "mine") myMs -= dt;
        else if (clockActive === "theirs") themMs -= dt;
        renderClocks();
        if (myMs <= 0 || themMs <= 0) flagFall();
      }, 250);
    }
  }

  // Time ran out. If it was mine, I report my own loss through the server;
  // if it was theirs, their client reports it and game_over reaches us.
  function flagFall() {
    const mineLost = myMs <= 0;
    hideClocks();
    if (mineLost) send({ type: "dev_gameover", result: "lose" });
  }

  /* ---------- turn indicators + coin flip ---------- */
  const turnChip = document.getElementById("turnChip");
  const turnGlow = document.getElementById("turnGlow");
  const coinflip = document.getElementById("coinflip");
  const coin = document.getElementById("coin");
  const coinflipText = document.getElementById("coinflipText");
  let coinflipTimers = [];

  function showTurn(mine) {
    turnChip.className = "turn-chip " + (mine ? "mine" : "theirs");
    turnChip.textContent = mine
      ? t("turn.mine")
      : soloMode ? t("turn.robot") : t("turn.theirs");
    turnGlow.classList.toggle("hidden", !mine);
  }

  function hideTurn() {
    turnChip.classList.add("hidden");
    turnGlow.classList.add("hidden");
  }

  function showCoinflip(youFirst) {
    coinflipTimers.forEach(clearTimeout);
    coinflip.classList.remove("hidden");
    coin.classList.add("spinning");
    coinflipText.textContent = t("coin.flipping");
    coinflipTimers = [
      setTimeout(() => {
        coin.classList.remove("spinning");
        coinflipText.textContent = youFirst
          ? t("coin.you")
          : soloMode ? t("coin.robot") : t("coin.opp");
      }, 1100),
      setTimeout(() => coinflip.classList.add("hidden"), 2400),
    ];
  }

  /* ---------- keep the phone screen awake during a game ---------- */
  let wakeLock = null;

  async function keepAwake() {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // unsupported or refused — the game still works, screen may sleep
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && inRoom) keepAwake();
  });

  /* ---------- game-over end screen ---------- */
  const gameoverPanel = document.getElementById("gameoverPanel");
  const gameoverHint = document.getElementById("gameoverHint");
  const gameoverResult = document.getElementById("gameoverResult");
  const btnRematch = document.getElementById("btnRematch");
  const gpMeBadge = document.getElementById("gpMeBadge");
  const gpThemBadge = document.getElementById("gpThemBadge");
  const gpThemIcon = document.getElementById("gpThemIcon");
  const gpThemName = document.getElementById("gpThemName");
  const ENDSCREEN_SECONDS = 5;
  let endTimer = null;

  function setBadge(badge, mark) {
    badge.textContent = mark; // "✓" or "✗"
    badge.classList.remove("hidden");
  }

  function showGameover() {
    document.body.classList.add("endscreen");
    gpThemIcon.textContent = soloMode ? "🤖" : "🧑";
    gpThemName.textContent = soloMode ? t("go.robot") : t("go.opponent");
    gpMeBadge.classList.add("hidden");
    gpThemBadge.classList.add("hidden");
    if (soloMode) setBadge(gpThemBadge, "✓"); // the robot always accepts
    btnRematch.disabled = false;
    gameoverPanel.classList.remove("hidden");

    // 5s to decide, then back to the lobby
    let left = ENDSCREEN_SECONDS;
    gameoverHint.textContent = t("end.rematch-wait", { n: left });
    clearInterval(endTimer);
    endTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        hideGameover();
        send({ type: "leave_room" });
        return;
      }
      gameoverHint.textContent = t("end.rematch-wait", { n: left });
    }, 1000);
  }

  function hideGameover() {
    clearInterval(endTimer);
    document.body.classList.remove("endscreen");
    gameoverPanel.classList.add("hidden");
  }

  // Opponent left while the end screen was up = declined the rematch
  function gameoverDeclined() {
    setBadge(gpThemBadge, "✗");
    gameoverHint.textContent = t("end.declined");
    btnRematch.disabled = true;
    clearInterval(endTimer);
    setTimeout(() => {
      hideGameover();
      send({ type: "leave_room" });
    }, 1500);
  }

  /* ---------- lobby ---------- */
  const lobby = document.getElementById("lobby");
  const lobbyStatus = document.getElementById("lobbyStatus");
  const partyCodeInput = document.getElementById("partyCode");
  const btnLeave = document.getElementById("btnLeave");
  const btnBoardView = document.getElementById("btnBoardView");
  const btnCamToggle = document.getElementById("btnCamToggle");
  let inRoom = false;
  let pendingGame = false; // created a party / queued for quick match, no opponent yet
  // a machine game the website asked for is being set up (boards checked); ends on spec_state or failure
  let stationSetup = false;
  // the waiting party is a machine party: the server closes it after 10 min, so the idle lock may wait
  let pendingPhysical = false;
  let remoteVideoOn = false; // the opponent's camera is streaming (a party game's base layer can show it)
  // server error details that have a translated message
  const SERVER_ERROR_KEYS = {
    "this machine is busy": "station.failed.busy",
    "physical games are not available right now": "station.failed.unavailable",
    "sign in with your card to play with others": "party.sign-in",
    "your opponent has to be at the other machine": "party.other-machine",
    "join from a machine to play a physical game": "party.from-machine",
    "no such room": "party.no-room",
    "room full": "party.full",
  };
  let roomCode = null;
  let soloMode = false; // playing the robot: no video call, face is the opponent
  let roomGameType = "chess"; // from room_joined — picks the board renderer
  let playerBoard = null; // the player's own board view (spectators have specBoard)
  const playerCache = {};

  /* ---------- auth + play gate (Phase 1) ---------- */
  const btnSignOut = document.getElementById("btnSignOut");
  const modeBanner = document.getElementById("modeBanner");
  const lobbyWelcome = document.querySelector(".lobby-welcome");
  const playButtons = [
    document.getElementById("btnSolo"),
    document.getElementById("btnCreate"),
    document.getElementById("btnQuick"),
    document.getElementById("btnJoin"),
  ];
  let currentUser = null;
  let playMode = false; // unlocked by a tap link; manual sign-in is spectator
  let myName = null;
  let myUid = null;
  let guestMode = false; // offline kiosk: no sign-in, solo vs robot only
  let friends = null; // initialized at boot, online mode only

  function applyModeGate() {
    playButtons.forEach((b) => (b.disabled = !playMode));
    partyCodeInput.disabled = !playMode;
    modeBanner.textContent = t(guestMode ? "mode.guest" : playMode ? "mode.play" : "mode.spectator");
    modeBanner.classList.toggle("play", playMode);
    // spectators get the watch/past-games panel instead of the play carousel
    lobbyStage.classList.toggle("hidden", !playMode);
    watchPanel.classList.toggle("hidden", playMode);
    if (!playMode) refreshWatchLists();
    if (guestMode) {
      // guest kiosk is solo-only: the other cards need accounts and a second
      // player, neither of which exists offline. CSS (body.guest) hides them;
      // disabling too keeps Enter-handlers honest. playButtons[0] is the
      // solo button; the rest are party/quick/join.
      playButtons.slice(1).forEach((b) => (b.disabled = true));
      partyCodeInput.disabled = true;
    }
    friends?.refreshMode(); // challenge/accept buttons track play mode
    renderKioskState();
  }

  // belt-and-braces: disabled buttons don't fire clicks, but Enter-handlers
  // and future UI paths all funnel through here
  function requirePlay() {
    if (playMode) return true;
    showLobby("mode.spectator");
    return false;
  }

  // Tap session marker. Play mode itself is memory-only (a refresh always
  // locks back to spectator), but the marker survives a refresh — which is
  // exactly how we tell "this tab was just refreshed out of a play session"
  // apart from a fresh visit, and end the old session so the station frees
  // up for a new tap (NexusBoard bridge contract).
  let tapSessionId = null;
  function endTapSession(reason) {
    if (!tapSessionId) return;
    const sid = tapSessionId;
    tapSessionId = null;
    sessionStorage.removeItem("nxSession");
    fetch("/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, reason }),
      keepalive: true,
    }).catch(() => {});
  }

  async function onAuthed(user, mode, sessionId) {
    currentUser = user;
    playMode = mode === "play";
    if (sessionId) {
      tapSessionId = sessionId;
      sessionStorage.setItem("nxSession", sessionId);
    }
    // bridge players (sql_*) have no email/displayName — the tap's asserted
    // display name arrives as a custom-token claim
    let name = user.displayName || (user.email || "").split("@")[0] || null;
    try {
      const tokenResult = await user.getIdTokenResult();
      if (tokenResult.claims.name) name = tokenResult.claims.name;
    } catch {
      // claims unavailable — fall back to whatever we have
    }
    if (!name) name = "player";
    myName = name;
    myUid = user.uid;
    lobbyWelcome.textContent = t("lobby.welcome", { name });
    refreshProfile();
    applyModeGate();
    btnSignOut.classList.remove("hidden");
    friends?.onSignIn(user);
    connect(); // first login — or a no-op when the kiosk pre-connected at boot
    if (ws && ws.readyState === WebSocket.OPEN) {
      // the kiosk socket opened while signed out (its hello carried no
      // identity) — refresh it now, and link the tap session so the
      // grace-window teardown can find it
      send({ type: "hello", name: myName, uid: myUid });
      if (tapSessionId) send({ type: "session", sessionId: tapSessionId });
    }
    // A pre-connected kiosk receives its welcome BEFORE auth finishes, so
    // the lobby was shown too early and the attract screen hid it again —
    // land on the lobby (the game carousel) now that the mode is settled.
    showLobby(playMode ? "lobby.connected" : "lobby.connected-spec");
    updateStatus();
  }

  function onSignedOut() {
    currentUser = null;
    playMode = false;
    myName = null;
    myUid = null;
    btnSignOut.classList.add("hidden");
    friends?.onSignOut();
    renderKioskState(); // a kiosk goes back to the attract screen
    // a kiosk keeps its socket through sign-out — staying registered for tap
    // pushes matters more than the brief identity reset a reconnect would cause
    if (ws && !stationKiosk) ws.close(); // onclose skips the reconnect here
  }

  // Guest kiosk mode (the server reported offline: true — the venue Pi). No
  // accounts, no Firebase: a pseudo-user keeps the connection/reconnect and
  // status logic unchanged, play mode is on, and applyModeGate restricts the
  // lobby to solo vs robot. The auth screen is simply never shown.
  function enterGuestMode() {
    guestMode = true;
    playMode = true;
    currentUser = { guest: true };
    myName = t("guest.name");
    myUid = null;
    document.body.classList.add("guest");
    // the kiosk starts clean — dev tools stay available via the corner button
    document.getElementById("devpanel").classList.add("hidden");
    lobbyWelcome.textContent = t("lobby.welcome", { name: myName });
    carouselIndex = 0; // bot card front and center (the others are hidden)
    refreshCarouselCards();
    layoutCarousel();
    applyModeGate();
    connect();
    // the pre-connected kiosk socket's welcome already fired (signed out) and
    // the attract screen hid the lobby meanwhile — show the carousel now
    showLobby();
    updateStatus();
  }

  // Back out of guest mode (kiosk only): the player changed their mind —
  // drop the pseudo-session and return to the attract screen. The WebSocket
  // stays connected so the kiosk keeps receiving tap pushes.
  function exitGuestMode() {
    guestMode = false;
    playMode = false;
    currentUser = null;
    myName = null;
    myUid = null;
    document.body.classList.remove("guest");
    applyModeGate();
    refreshCarouselCards();
    layoutCarousel();
    renderKioskState();
  }

  /* ---------- kiosk attract screen + idle auto-lock ---------- */
  const kioskAttract = document.getElementById("kioskAttract");
  const kioskAsk = document.getElementById("kioskAsk");
  const askTitle = document.getElementById("askTitle");
  let pendingAsk = null; // { url, code } while the phone-or-screen prompt is up
  let staffOverride = false; // staff sign-in shows the normal site instead

  // The screen's delivery preference, chosen on the attract screen:
  // "screen" claims phone taps for the display; "phone" lets the app have
  // them. Survives the tap-login navigation via sessionStorage; cleared when
  // a session ends so the next player gets the choice again.
  let kioskMode = sessionStorage.getItem("nxKioskMode") || null;

  let tapKindSel = null; // "card" | "phone" — the sub-choice inside screen mode

  function pushKioskMode() {
    if (ws && ws.readyState === WebSocket.OPEN && stationKiosk) {
      // accept narrows what the reader may accept: card-only, phone-only, any
      const accept = kioskMode === "screen" ? (tapKindSel || "any")
        : kioskMode === "phone" ? "phone" : "any";
      send({ type: "kiosk_mode", mode: kioskMode, accept });
    }
  }

  function setKioskMode(mode) {
    kioskMode = mode;
    tapKindSel = null; // a fresh mode choice resets the card/phone sub-choice
    if (mode) sessionStorage.setItem("nxKioskMode", mode);
    else sessionStorage.removeItem("nxKioskMode");
    pushKioskMode();
    renderAttractMode();
  }

  function renderAttractMode() {
    document.getElementById("modeChoose").classList.toggle("hidden", !!kioskMode);
    document.getElementById("modeHint").classList.toggle("hidden", !kioskMode);
    // screen mode asks card-vs-phone first; phone mode goes straight to the hint
    const pickingKind = kioskMode === "screen" && !tapKindSel;
    document.getElementById("tapKindQ").classList.toggle("hidden", !pickingKind);
    document.getElementById("tapKind").classList.toggle("hidden", !pickingKind);
    const hintEl = document.getElementById("kioskHint");
    const showHint = kioskMode === "phone" || !!tapKindSel;
    hintEl.classList.toggle("hidden", !showHint);
    if (showHint) {
      hintEl.textContent = t(tapKindSel === "card" ? "kiosk.tap-hint-card" : "kiosk.tap-hint-phone");
    }
  }

  function hideAsk() {
    pendingAsk = null;
    kioskAsk.classList.add("hidden");
  }

  // A resting kiosk (no play session, no game) shows the attract screen and
  // hides the lobby/auth screens. Called on state changes and on a 1 s
  // interval as a catch-all — it only toggles a class.
  function renderKioskState() {
    if (!stationKiosk) return;
    const resting = !playMode && !inRoom && !pendingGame && !watching && !staffOverride;
    kioskAttract.classList.toggle("hidden", !resting);
    // the guest back-button exists only while a guest is idle in the lobby
    document.getElementById("btnGuestBack").classList.toggle(
      "hidden", !(guestMode && !inRoom && !pendingGame)
    );
    if (resting) {
      lobby.classList.add("hidden");
      document.getElementById("authScreen").classList.add("hidden");
    }
  }

  // A kiosk session belongs to whoever is standing at the machine. A game in
  // progress never locks (physical players think without touching the
  // screen); everywhere else, two idle minutes end the session.
  const KIOSK_IDLE_MS = 2 * 60 * 1000;
  let kioskLastActive = Date.now();
  if (stationKiosk) {
    ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
      window.addEventListener(ev, () => { kioskLastActive = Date.now(); }, { passive: true })
    );
    setInterval(() => {
      if (!playMode) { kioskLastActive = Date.now(); return; }
      if (inRoom && turnState) { kioskLastActive = Date.now(); return; } // mid-game
      // waiting for a friend to join (the server closes the party after 10 min) or for the machines to
      // set up the boards: the player is waiting on purpose, not walking away
      if (stationSetup || (pendingGame && pendingPhysical)) { kioskLastActive = Date.now(); return; }
      // a live website-started machine game IS the player's activity — the
      // physical player never touches the screen; the game ends itself and
      // the lock resumes afterwards
      if (watching && watching.createdByUs && stationPov) { kioskLastActive = Date.now(); return; }
      if (Date.now() - kioskLastActive < KIOSK_IDLE_MS) return;
      if (inRoom || pendingGame) send({ type: "leave_room" });
      endTapSession("idle");
      setKioskMode(null); // the next player gets the where-to-play choice
      // the server's session_end push also locks the tab; do it locally in
      // case the push races us
      playMode = false;
      applyModeGate();
      showLobby("session.ended");
    }, 5000);
  }

  function showLobby(key, vars) {
    if (key !== undefined) lobbyStatusMsg = { key, vars };
    lobbyStatus.textContent = t(lobbyStatusMsg.key, lobbyStatusMsg.vars);
    lobby.classList.remove("hidden");
  }

  function hideLobby() {
    lobby.classList.add("hidden");
  }

  let lobbyStatusMsg = { key: "lobby.connecting" };

  function resetRoomState() {
    inRoom = false;
    pendingGame = false;
    pendingPhysical = false;
    stationSetup = false;
    roomCode = null;
    soloMode = false;
    opponentConnected = false;
    oppName = null;
    oppUid = null;
    callState = "new";
    turnState = null; // a stale turn must not resurrect the chip (e.g. on lang change)
    videoCall.polite = null;
    videoCall.peerAvailable = false;
    friends?.refreshAddButton();
  }

  /* ---------- connection status pill ---------- */
  const connStatus = document.getElementById("connStatus");
  const connText = document.getElementById("connText");
  let opponentConnected = false;
  let oppName = null; // opponent's display name, from opponent_connected
  let oppUid = null; // opponent's uid — powers the in-game "add friend" button
  let callState = "new"; // last RTCPeerConnectionState from video.js

  function renderConn() {
    const serverUp = ws && ws.readyState === WebSocket.OPEN;
    let cls, text;
    if (!currentUser) {
      cls = "warn";
      text = t("conn.nosignin");
    } else if (!serverUp) {
      cls = "bad";
      text = t("conn.offline");
    } else if (watching) {
      cls = "ok";
      text = t("conn.watching", { a: watching.names.A, b: watching.names.B });
    } else if (!inRoom) {
      cls = "warn";
      text = t("conn.lobby");
    } else if (soloMode) {
      cls = "ok";
      text = t("conn.solo");
    } else if (!opponentConnected) {
      cls = "warn";
      text = t("conn.waiting", { code: roomCode });
    } else if (callState === "connected") {
      cls = "ok";
      text = t("conn.video", { code: roomCode });
    } else {
      cls = "ok";
      text = t("conn.connected", { code: roomCode });
    }
    connStatus.className = "conn-status " + cls;
    connText.textContent = text;
    // one leave/cancel button for every escapable state: queued, hosting,
    // playing, spectating
    btnLeave.textContent = watching && watching.createdByUs && stationPov
      ? t("btn.endgame") // ending a website-started machine game aborts it
      : watching
        ? t("btn.stopwatch")
        : pendingGame || stationSetup
          ? t("btn.cancel")
          : t("btn.leave");
    btnLeave.classList.toggle("hidden", !inRoom && !watching && !pendingGame && !stationSetup);
  }

  /* ---------- face state tracking ---------- */
  let faceState = "idle";
  let turnState = null; // last turn-driven face state, restored after sync_ok

  function setFace(state, opts = {}) {
    faceState = state;
    if (state === "your_turn" || state === "thinking") turnState = state;
    face.setState(state, opts);
  }

  /* ---------- sound cues (venue screens) ---------- */
  // Gentle Web Audio cues so a player staring at physical pieces notices
  // state changes: a chime when it becomes their move, a buzz for a
  // rejected move, a jingle at game end. Browsers require a gesture before
  // audio — the first tap anywhere unlocks it. Toggle persists per machine.
  let audioCtx = null;
  let soundOn = localStorage.getItem("nxSound") !== "off";

  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  window.addEventListener("pointerdown", () => { if (soundOn) ensureAudio(); }, { passive: true });

  function tone(freq, startAt, dur, type = "sine", vol = 0.05) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + startAt;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function sfx(name) {
    if (!soundOn) return;
    if (name === "ready") { tone(660, 0, 0.18); tone(880, 0.12, 0.25); }
    else if (name === "mistake") { tone(180, 0, 0.25, "square", 0.04); }
    else if (name === "win") { tone(523, 0, 0.15); tone(659, 0.12, 0.15); tone(784, 0.24, 0.35); }
    else if (name === "lose") { tone(392, 0, 0.2); tone(311, 0.18, 0.35); }
  }

  const btnSound = document.getElementById("btnSound");
  function renderSound() {
    btnSound.textContent = soundOn ? "🔊" : "🔇";
    btnSound.classList.toggle("off", !soundOn);
  }
  btnSound.onclick = () => {
    soundOn = !soundOn;
    localStorage.setItem("nxSound", soundOn ? "on" : "off");
    renderSound();
    if (soundOn) sfx("ready"); // prove it works the moment it's on
  };
  renderSound();

  /* ---------- illegal-move / sync-error blocker ---------- */
  // Two independent causes can hold the blocker: a sync/paused error from
  // the engine, and a rejected physical move. Track both so one clearing
  // never dismisses the other's message. syncBlockDetail null = inactive.
  let blocked = false;
  let syncBlockDetail = null;
  let mistakeActive = false;

  function showBlocker(title, reason) {
    blocked = true;
    blockerTitle.textContent = title;
    blockerReason.textContent = reason || "";
    blocker.classList.remove("hidden");
  }

  function hideBlocker() {
    if (!blocked) return;
    blocked = false;
    blocker.classList.add("hidden");
  }

  function refreshBlocker() {
    if (syncBlockDetail !== null) showBlocker(t("block.sync"), syncBlockDetail);
    else if (mistakeActive) showBlocker(t("block.mistake"), t("block.mistake-hint"));
    else hideBlocker();
  }

  /* ---------- event -> face mapping ---------- */
  const EVENT_HANDLERS = {
    welcome() {
      resetRoomState();
      showLobby(playMode ? "lobby.connected" : "lobby.connected-spec");
      if (!playMode) refreshWatchLists();
      updateStatus();
    },

    // nobody joined the machine party in time; the server already freed the machine
    party_expired() {
      resetRoomState(); // the server sends no 'lobby' after this, so the message stays up
      showLobby("lobby.party-expired");
      renderConn();
    },

    room_created(msg) {
      roomCode = msg.code;
      pendingGame = true; // seated and waiting — show a cancel path
      pendingPhysical = !!msg.physical;
      friends?.onRoomCreated(msg.code); // delivers the code if a challenge is pending
      showLobby("lobby.party", { code: msg.code });
      renderConn();
    },

    match_waiting() {
      pendingGame = true;
      showLobby("lobby.matchmaking");
      renderConn();
    },

    room_joined(msg) {
      inRoom = true;
      pendingGame = false;
      roomCode = msg.code;
      soloMode = !!msg.solo;
      roomGameType = msg.gameType || "chess";
      playerBoard = null; // rebuilt on game_start with the right renderer
      btnBoardView.classList.remove("hidden");
      btnBoardView.textContent = t("view.board");
      btnCamToggle.classList.toggle("hidden", soloMode); // the robot has no camera
      btnCamToggle.classList.add("off");
      // the camera tile rests as an empty box; media only ever starts when
      // the player presses the camera button (opt-in, never automatic)
      pipWrap.classList.remove("hidden");
      pipWrap.classList.add("cam-off");
      // sync the buttons to the resting state (nothing is streaming yet)
      videoCall.onMediaState?.({ camOn: false, micOn: false, active: false });
      if (msg.minutes >= 1 && msg.minutes <= 60) clockStartMs = msg.minutes * 60 * 1000;
      videoCall.polite = msg.player === "B"; // perfect negotiation: B is polite
      hideLobby();
      hideGameover();
      keepAwake(); // phone on a stand must not sleep mid-game
      setFace("waiting", {
        message: soloMode ? "Solo game vs the robot" : "Waiting for opponent…",
      });
      renderConn();
    },

    lobby() {      resetRoomState();
      exitSpectator();
      setBaseMode("face");
      setFace("idle");
      hideGameover();
      hideTurn();
      hideClocks();
      btnBoardView.classList.add("hidden"); // board view is an in-game thing
      btnCamToggle.classList.add("hidden");
      playerBoard = null;
      videoCall.stop(); // leaving the room kills the camera — never leave it warm
      showLobby("lobby.back");
      if (!playMode) refreshWatchLists();
      renderConn();
    },

    opponent_connected(msg) {
      opponentConnected = true;
      oppName = msg.name || null;
      oppUid = msg.uid || null; // null for the robot and legacy servers
      friends?.refreshAddButton();
      videoCall.peerAvailable = !soloMode; // the robot has no camera
      hideLobby(); // rejoining mid-session safety
      hideBlocker();
      setFace(turnState || "idle");
      // no auto-start: the camera is strictly opt-in (camera button)
      renderConn();
    },

    opponent_disconnected() {
      opponentConnected = false;
      oppName = null;
      oppUid = null;
      friends?.refreshAddButton();
      callState = "new";
      videoCall.peerAvailable = false;
      videoCall.hangup(); // drop the call, keep our camera ready for rejoin
      setBaseMode("face");
      if (!gameoverPanel.classList.contains("hidden")) {
        gameoverDeclined(); // left from the end screen = declined the rematch
      } else {
        setFace("waiting", { message: "Opponent disconnected — waiting…" });
      }
      renderConn();
    },

    your_turn() {
      hideBlocker();
      showTurn(true);
      setActiveClock("mine");
      setFace("your_turn");
      if (stationKiosk) sfx("ready");
    },

    opponent_turn() {
      hideBlocker();
      showTurn(false);
      setActiveClock("theirs");
      setFace("thinking");
    },

    game_start(msg) {
      hideGameover();
      resetClocks();
      // the player's own board: rebuild with the room's renderer and reset
      // (chess: black-first variant when the opponent opens; xiangqi ignores)
      playerBoard = boardFor(roomGameType, specBoardEl, playerCache);
      playerBoard.reset(msg.first === "opponent");
      if (stationKiosk) setBaseMode("board"); // station screens default to the board
      showCoinflip(msg.first === "you");
    },

    move_applied(msg) {
      hideBlocker();
      playerBoard?.apply(msg.move); // the board tracks every verified move
      if (msg.by === "opponent") {
        setFace("happy", { hold: 1500, returnTo: turnState || faceState });
      }
      // "by": "you" — turn events drive the state; nothing to show
    },

    illegal_move(msg) {
      if (msg.for === "you") {
        setFace("sad", { message: msg.reason });
        mistakeActive = true;
        refreshBlocker();
        sfx("mistake");
      } else {
        setFace("waiting", { message: "state.waiting.msg" });
      }
    },

    opponent_fixing_move() {
      setFace("waiting", { message: "state.waiting.msg" });
    },

    sync_ok() {
      // board fixed and re-verified — both block causes clear
      syncBlockDetail = null;
      mistakeActive = false;
      refreshBlocker();
      setFace(turnState || "idle");
    },

    sync_error(msg) {
      setFace("sad", { message: msg.detail });
      syncBlockDetail = msg.detail || "";
      refreshBlocker();
    },

    game_over(msg) {
      hideBlocker();
      hideTurn();
      hideClocks();
      turnState = null;
      const won = msg.result === "win";
      setBaseMode("face"); // the win/lose face replaces the video
      setFace(won ? "win" : "lose");
      gameoverResult.textContent = won ? t("go.win") : t("go.lose");
      gameoverResult.className = "gameover-result " + (won ? "win" : "lose");
      showGameover();
      if (stationKiosk) sfx(won ? "win" : "lose");
    },

    rematch_offer() {
      setBadge(gpThemBadge, "✓"); // opponent wants the rematch too
      if (!btnRematch.disabled) gameoverHint.textContent = t("end.opponent-rematch");
    },

    rematch_start() {
      hideGameover();
      hideTurn(); // a fresh coin flip follows
      hideClocks();
      turnState = null;
      setFace("idle"); // referee drives the new game's turns from here
      if (!soloMode && callState === "connected") setBaseMode("video");
    },

    signal(msg) {
      videoCall.handleSignal(msg.data);
    },

    // A machine party paired this screen with the other machine's: the video call becomes available
    // (still opt-in — the camera only starts on the camera button). Sent again after a reconnect, so drop
    // any old connection and renegotiate if our camera is already running.
    call_peer(msg) {
      videoCall.hangup();
      remoteVideoOn = false;
      videoCall.polite = !!msg.polite;
      videoCall.peerAvailable = true;
      btnCamToggle.classList.remove("hidden");
      if (videoCall.isActive()) {
        videoCall.start().catch((err) => face.setMessage("Camera: " + err.message));
      } else {
        btnCamToggle.classList.add("off");
        pipWrap.classList.remove("hidden");
        pipWrap.classList.add("cam-off");
        videoCall.onMediaState?.({ camOn: false, micOn: false, active: false });
      }
    },
    // the other screen dropped: hang up, keep our camera; a fresh call_peer arrives when it returns
    call_peer_left() {
      videoCall.hangup();
      remoteVideoOn = false;
      if (baseMode === "video") {
        setBaseMode(watching ? "board" : "face");
        btnBoardView.textContent = t(watching ? "view.face" : "view.board");
      }
    },
    // the party is over: end the call and turn the camera off
    call_end() {
      videoCall.peerAvailable = false;
      videoCall.stop();
      remoteVideoOn = false;
      btnCamToggle.classList.add("hidden");
      if (baseMode === "video") {
        setBaseMode(watching ? "board" : "face");
        btnBoardView.textContent = t(watching ? "view.face" : "view.board");
      }
    },

    // The tap session ended elsewhere (app Disconnect, grace timeout, or the
    // max lifetime sweep): drop any game and lock back to spectator.
    session_end() {
      tapSessionId = null;
      sessionStorage.removeItem("nxSession");
      playMode = false;
      setKioskMode(null); // next player gets the where-to-play choice again
      if (inRoom || pendingGame) send({ type: "leave_room" });
      if (watching) send({ type: "leave_watch" });
      applyModeGate();
      showLobby("session.ended");
      updateStatus();
    },

    // A tap at this machine's reader delivered a login to this screen:
    // navigate to the URL and the normal redeem flow signs the player in.
    station_login(msg) {
      if (!stationKiosk || !msg.url) return;
      location.href = msg.url;
    },

    // Website-controlled machine game (Phase 7): the engine accepted our
    // request and is setting the board up; play begins when the watcher
    // sees the game live (the kiosk auto-follows it like any station game).
    station_game_requested() {
      // a party host stops "waiting for a friend" here: both machines are now being set up
      pendingGame = false;
      stationSetup = true;
      showLobby("station.setting-up");
      renderConn();
    },
    station_game_failed(msg) {
      // "busy" while our own game is being set up answers a second press, not the game in progress
      if (msg.reason === "busy" && stationSetup) return;
      stationSetup = false;
      renderConn();
      const known = ["busy", "unavailable", "timeout", "camera_not_ready", "failed", "aborted"];
      const key = known.includes(msg.reason) ? `station.failed.${msg.reason}` : "station.failed.failed";
      showLobby(key);
      renderKioskState();
    },
    // abort landed while the arm was mid-move — the game ends after it
    station_game_ending() {
      face.setMessage("station.ending");
    },

    // Another tab registered as this station's screen: pushes now go there,
    // so this tab would otherwise sit on the attract page looking alive while
    // receiving nothing. Say so, and offer a tap to take the station back.
    kiosk_replaced() {
      if (!stationKiosk) return;
      const el = document.getElementById("kioskDisplaced");
      el.classList.remove("hidden");
      el.onclick = () => location.reload(); // deliberate takeover
    },

    // A phone tapped at this station and the player must choose where the
    // game opens (deliver: "ask" from the bridge). Only shown on idle kiosks.
    station_ask(msg) {
      if (!stationKiosk || !msg.url) return;
      pendingAsk = { url: msg.url, code: new URL(msg.url).searchParams.get("code") };
      askTitle.textContent = t("ask.title", { name: msg.name || t("guest.name") });
      kioskAsk.classList.remove("hidden");
    },

    emotion(msg) {
      emotionOverlay.show(msg.label);
    },

    error(msg) {
      console.warn("server error:", msg.detail);
      const key = SERVER_ERROR_KEYS[msg.detail];
      const text = key ? t(key) : msg.detail || "server error";
      if (!lobby.classList.contains("hidden")) {
        lobbyStatus.textContent = text;
      } else {
        face.setMessage(text);
      }
    },
  };

  /* ---------- WebSocket with auto-reconnect ---------- */
  let ws = null;
  let reconnectTimer = null;
  // when games run on a separate server (the arm-server), /config.json
  // points the game WebSocket there; unset means same-origin. Fetched at
  // boot (bottom of this file), which also decides online vs guest mode.
  let gameServerUrl = null;
  // which stations command a real machine (server config, XQ_STATION_MAP) —
  // an unmapped station keeps simulated solo play instead of failing
  let stationDevices = {};

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState <= WebSocket.OPEN) return; // already connecting/open
    let url;
    if (gameServerUrl) {
      url = gameServerUrl;
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      url = `${proto}://${location.host}`;
    }
    ws = new WebSocket(url);

    ws.onopen = () => {
      // display identity for room names + the games recording (self-reported)
      send({ type: "hello", name: myName, uid: myUid });
      // a station touchscreen registers itself for tap-login pushes
      if (stationKiosk) {
        send({ type: "kiosk_hello", stationId: stationKiosk });
        if (kioskMode) pushKioskMode();
      }
      // link this socket to its tap session — the server ends the session if
      // a tapped-in browser vanishes past the grace window
      if (tapSessionId) send({ type: "session", sessionId: tapSessionId });
      updateStatus();
      // server sends "welcome" next, which opens the lobby
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        console.warn("bad message from server:", e.data);
        return;
      }
      // while spectating, game events carry a neutral perspective and go to
      // the spectator UI instead of the player handlers
      if (watching && SPEC_EVENT_TYPES.has(msg.type)) {
        spectateEvent(msg);
        return;
      }
      const handler = EVENT_HANDLERS[msg.type];
      if (handler) handler(msg);
      else console.warn("no handler for event:", msg);
    };

    ws.onclose = () => {
      resetRoomState();
      exitSpectator();
      updateStatus();
      hideBlocker();
      hideGameover();
      hideTurn();
      hideClocks();
      videoCall.stop();
      showLobby("lobby.lost");
      setFace("waiting", { message: "lobby.lost" });
      renderKioskState(); // a resting kiosk keeps the attract screen on top
      // a kiosk reconnects even signed out — without its socket, no tap push
      // can ever reach it (station 2 joint-test finding, 2 Nov)
      if (currentUser || stationKiosk) reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }

  /* ---------- base layer: face <-> video <-> board ---------- */
  let baseMode = "face";
  const boardLayer = document.getElementById("boardLayer");

  function setBaseMode(mode) {
    baseMode = mode;
    faceLayer.classList.toggle("hidden", mode !== "face");
    videoLayer.classList.toggle("hidden", mode !== "video");
    boardLayer.classList.toggle("hidden", mode !== "board");
  }

  videoCall.onRemoteStream = () => {
    remoteVideoOn = true;
    // a machine game keeps the board up: the opponent's video is one tap away on the view button
    if (watching && stationPov) {
      btnBoardView.textContent = t(baseMode === "board" ? "view.video" : "view.board");
      return;
    }
    setBaseMode("video");
  };
  videoCall.onPeerStateChange = (state) => {
    callState = state;
    renderConn();
  };

  /* ---------- dev panel ---------- */
  const gamecontrols = document.getElementById("gamecontrols");

  const statusEl = document.createElement("div");
  statusEl.className = "dev-status";
  gamecontrols.appendChild(statusEl);

  function updateStatus() {
    const conn = ws && ws.readyState === WebSocket.OPEN ? "connected" : "disconnected";
    const player = videoCall.polite === null ? "?" : videoCall.polite ? "B" : "A";
    const who = currentUser ? `${myName || "?"} (${playMode ? "play" : "spectator"})` : "signed out";
    statusEl.textContent =
      `server: ${conn} · user: ${who} · room: ${roomCode || "—"} · player: ${player} · base: ${baseMode} · call: ${callState}`;
    renderConn();
  }

  function addButton(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = fn;
    gamecontrols.appendChild(b);
    return b;
  }

  addButton("toggle base", () => {
    setBaseMode(baseMode === "face" ? "video" : "face");
    updateStatus();
  });
  // Mode overrides for testing the gate before the tap pipeline (Phase 2)
  // exists — a real play session only ever comes from a tap link.
  addButton("dev: play mode", () => { playMode = true; applyModeGate(); updateStatus(); });
  addButton("dev: spectator", () => { playMode = false; applyModeGate(); updateStatus(); });
  addButton("start video", () => videoCall.start().catch((err) => face.setMessage("Camera: " + err.message)));
  addButton("stop video", () => videoCall.stop());
  addButton("leave room", () => send({ type: "leave_room" }));

  // End the current game for real — both players get the end screen
  // (goes through the server; the bare "win"/"lose" buttons above from
  // face.js only change the face and are for face-demo purposes)
  addButton("end game: I won", () => send({ type: "dev_gameover", result: "win" }));
  addButton("end game: I lost", () => send({ type: "dev_gameover", result: "lose" }));

  // Turn switching + clock config for prototyping
  addButton("turn: mine", () => send({ type: "dev_turn", player: "me" }));
  addButton("turn: theirs", () => send({ type: "dev_turn", player: "opponent" }));

  // Play a move as this player (the CLI "move" command, reachable from the
  // browser since the dev panel can't type into the server's stdin).
  // The list alternates white/black so alternating clicks make legal moves.
  const DEV_MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"];
  let devMoveIdx = 0;
  addButton("dev: move", () => {
    send({ type: "dev_move", move: DEV_MOVES[devMoveIdx++ % DEV_MOVES.length] });
  });
  addButton("dev: robot move", () => {
    send({ type: "dev_move", move: DEV_MOVES[devMoveIdx++ % DEV_MOVES.length], as: "opponent" });
  });

  // Game type + theme. The machine's physical board (reported through the
  // tap) decides the lobby's game flavor; the dev toggle overrides it for
  // previewing.
  let devGameType = "chess";
  const stationGame = sessionStorage.getItem("nxGame");
  if (stationGame === "xiangqi") devGameType = "xiangqi";

  function applyTheme(type) {
    document.body.dataset.game = type === "xiangqi" ? "xiangqi" : "chess";
  }

  const gameTypeBtn = addButton(`game: ${devGameType}`, () => {
    devGameType = devGameType === "chess" ? "xiangqi" : "chess";
    gameTypeBtn.textContent = `game: ${devGameType}`;
    applyTheme(devGameType);
  });
  applyTheme(devGameType);

  const clockRow = document.createElement("div");
  clockRow.className = "dev-status";
  const clockMinInput = document.createElement("input");
  clockMinInput.type = "number";
  clockMinInput.min = "1";
  clockMinInput.max = "60";
  clockMinInput.value = "5";
  clockMinInput.style.width = "4ch";
  clockMinInput.title = "minutes per player";
  clockRow.appendChild(clockMinInput);
  const clockMinLabel = document.createElement("span");
  clockMinLabel.textContent = " min clocks";
  clockRow.appendChild(clockMinLabel);
  gamecontrols.appendChild(clockRow);

  addButton("reset clocks", () => {
    const min = Math.max(1, Math.min(60, Number(clockMinInput.value) || 5));
    clockStartMs = min * 60 * 1000;
    resetClocks();
  });
  btnLeave.onclick = () => {
    // a machine game still being set up: cancelling must end it on the machines too
    if (stationSetup) {
      send({ type: "station_game_abort" });
      return;
    }
    // station POV of a website-started game: leaving means ending the real
    // machine game, not just stopping watching
    if (watching && watching.createdByUs && stationPov) {
      send({ type: "station_game_abort" });
      return;
    }
    send({ type: watching ? "leave_watch" : "leave_room" });
  };
  btnRematch.onclick = () => {
    if (!send({ type: "rematch" })) return;
    clearInterval(endTimer); // my decision is made; the wait is on them now
    setBadge(gpMeBadge, "✓");
    btnRematch.disabled = true;
    gameoverHint.textContent = t(soloMode ? "end.rematching" : "end.waiting-opp");
  };
  document.getElementById("btnGameoverLeave").onclick = () =>
    send({ type: watching ? "leave_watch" : "leave_room" });
  // station-kiosk end-of-game CTAs: "play again" returns to the attract
  // screen but lets the next station game take over; "leave" also stops the
  // auto-follow for the rest of this page view
  document.getElementById("btnSpecAgain").onclick = () => send({ type: "leave_watch" });
  document.getElementById("btnSpecLeave").onclick = () => send({ type: "leave_watch", mute: true });

  /* ---------- lobby controls ---------- */
  // 3D carousel: active card front and center, the rest fanned on the ring
  // (N-card generic — ±1 angled close, ±2 smaller behind, beyond that hidden)
  const lobbyStage = document.getElementById("lobbyStage");
  const allCarouselCards = [...document.querySelectorAll("#lobbyCarousel .lcard")];
  let carouselCards = allCarouselCards;
  let carouselIndex = 1;

  function refreshCarouselCards() {
    // cards hidden by mode (guest mode, Special Games on kiosks) leave the
    // ring entirely — no invisible slots, no holes
    carouselCards = allCarouselCards.filter((c) => getComputedStyle(c).display !== "none");
    if (carouselIndex >= carouselCards.length) carouselIndex = 0;
  }

  function layoutCarousel() {
    const n = carouselCards.length;
    carouselCards.forEach((card, i) => {
      let off = (i - carouselIndex + n) % n;
      if (off > n / 2) off -= n; // signed shortest distance on the ring
      const a = Math.abs(off);
      if (off === 0) {
        card.style.transform = "translateX(0) translateZ(0) rotateY(0deg) scale(1)";
        card.style.zIndex = 5;
        card.style.filter = "none";
        card.style.opacity = "1";
        card.style.pointerEvents = "auto";
      } else if (a <= 2) {
        card.style.transform =
          `translateX(${off * 34}vmin) translateZ(${-22 * a}vmin) rotateY(${Math.max(-64, Math.min(64, off * -38))}deg) scale(${a === 1 ? 0.8 : 0.68})`;
        card.style.zIndex = 4 - a;
        card.style.filter = `brightness(${a === 1 ? 0.88 : 0.76}) saturate(0.85)`;
        card.style.opacity = "1";
        card.style.pointerEvents = "auto";
      } else {
        card.style.opacity = "0";
        card.style.pointerEvents = "none";
        card.style.zIndex = 1;
      }
    });
  }

  function rotateCarousel(dir) {
    if (guestMode) return; // the kiosk shows only the bot card
    carouselIndex = (carouselIndex + dir + carouselCards.length) % carouselCards.length;
    layoutCarousel();
  }

  document.getElementById("carLeft").onclick = () => rotateCarousel(-1);
  document.getElementById("carRight").onclick = () => rotateCarousel(1);

  // Click a side card to bring it forward (without hitting its buttons)
  refreshCarouselCards();
  carouselCards.forEach((card, i) => {
    card.addEventListener("click", (e) => {
      if (i !== carouselIndex && !e.target.closest("button, input")) {
        carouselIndex = i;
        layoutCarousel();
      }
    });
  });

  // Swipe / drag to rotate
  let swipeX = null;
  lobbyStage.addEventListener("pointerdown", (e) => {
    swipeX = e.clientX;
  });
  lobbyStage.addEventListener("pointerup", (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 40) rotateCarousel(dx < 0 ? 1 : -1);
    swipeX = null;
  });
  layoutCarousel();

  document.getElementById("btnQuick").onclick = () => {
    if (!requirePlay()) return;
    if (send({ type: "quick_match", gameType: devGameType })) showLobby("lobby.matchmaking");
  };

  // Time control chips (Blitz/Rapid/Classic) — shared with the joiner via
  // the create_party minutes, and used for solo clocks too.
  let selectedMinutes = 10;
  const timeChips = document.getElementById("timeChips");
  timeChips.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      timeChips.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      selectedMinutes = Number(b.dataset.min) || 10;
    };
  });

  // Difficulty slider — cosmetic until the engine exists; sent with "solo"
  const diffSlider = document.getElementById("diffSlider");
  const diffPieces = document.getElementById("diffPieces");
  const updateDiffPieces = () => {
    [...diffPieces.children].forEach((s, i) =>
      s.classList.toggle("sel", i === Number(diffSlider.value) - 1)
    );
  };
  diffSlider.addEventListener("input", updateDiffPieces);
  updateDiffPieces();

  document.getElementById("btnCreate").onclick = () => {
    if (!requirePlay()) return;
    if (send({ type: "create_room", minutes: selectedMinutes, gameType: devGameType })) showLobby("lobby.creating");
  };
  document.getElementById("btnSolo").onclick = () => {
    if (!requirePlay()) return;
    // a machine screen starts the real game on its own machine (Phase 7) when
    // its station is mapped to an engine device; unmapped stations and
    // everywhere else stay simulated
    if (stationKiosk && stationDevices[stationKiosk]) {
      if (send({ type: "start_station_game", gameType: devGameType, difficulty: Number(diffSlider.value) })) {
        showLobby("station.requesting");
      }
      return;
    }
    clockStartMs = selectedMinutes * 60 * 1000;
    if (send({ type: "solo", difficulty: Number(diffSlider.value), gameType: devGameType })) {
      showLobby("lobby.solo");
    }
  };
  const joinParty = () => {
    if (!requirePlay()) return;
    const code = partyCodeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      showLobby("lobby.enter-code");
      return;
    }
    if (send({ type: "join_room", code })) showLobby("lobby.joining", { code });
  };
  document.getElementById("btnJoin").onclick = joinParty;
  partyCodeInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let "d" toggle the dev panel while typing
    if (e.key === "Enter") joinParty();
  });

  /* ---------- special-games card (variant carrier) ---------- */
  const variantChips = document.getElementById("variantChips");
  let selectedVariant = "blast3x3";
  function selectVariantChip(btn) {
    selectedVariant = btn.dataset.variant;
    variantChips.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === btn));
  }
  variantChips.querySelectorAll("button").forEach((b) => {
    b.onclick = () => selectVariantChip(b);
  });

  // The variant list comes from the staff-created registry (the CV team's
  // rules site pushes each new ruleset via POST /register-variant). The
  // seeded chips in the HTML are the fallback when the registry is empty.
  async function loadVariants() {
    try {
      const res = await fetch("/variants");
      const data = await res.json();
      if (!data.ok || !data.variants.length) return;
      variantChips.innerHTML = "";
      data.variants.forEach((v, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.variant = v.id;
        b.textContent = (getLang() === "zh" && v.nameZh) ? v.nameZh : v.name;
        if (i === 0) b.classList.add("sel");
        b.onclick = () => selectVariantChip(b);
        variantChips.appendChild(b);
      });
      selectedVariant = data.variants[0].id;
    } catch { /* registry unreachable — the seeded chips stay */ }
  }
  loadVariants();
  document.getElementById("btnVariantPlay").onclick = () => {
    if (!requirePlay()) return;
    if (stationKiosk && stationDevices[stationKiosk]) {
      if (send({ type: "start_station_game", gameType: devGameType, variant: selectedVariant })) {
        showLobby("station.requesting");
      }
      return;
    }
    clockStartMs = selectedMinutes * 60 * 1000;
    if (send({ type: "solo", variant: selectedVariant, gameType: devGameType })) {
      showLobby("lobby.solo");
    }
  };

  /* ---------- profile card (username claim) ---------- */
  const usernameInput = document.getElementById("usernameInput");
  const profileCurrent = document.getElementById("profileCurrent");
  const profileNote = document.getElementById("profileNote");

  async function refreshProfile() {
    if (!currentUser) return;
    try {
      const res = await fetch("/lookup-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: await currentUser.getIdToken(), self: true }),
      });
      const data = await res.json();
      profileCurrent.textContent = data.ok && data.username
        ? t("card.profile.current", { name: data.username })
        : t("card.profile.none");
    } catch { /* leave the placeholder on failure */ }
  }

  usernameInput.addEventListener("keydown", (e) => e.stopPropagation());
  document.getElementById("btnSaveUsername").onclick = async () => {
    if (!currentUser) return;
    profileNote.textContent = "";
    try {
      const res = await fetch("/claim-username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: await currentUser.getIdToken(), username: usernameInput.value }),
      });
      const data = await res.json();
      if (!data.ok) {
        profileNote.textContent = data.detail || t("card.profile.invalid");
      } else {
        profileNote.textContent = t("card.profile.saved");
        usernameInput.value = "";
        refreshProfile();
      }
    } catch (err) {
      profileNote.textContent = err.message;
    }
  };

  const emoRow = document.createElement("div");
  emoRow.className = "dev-section";
  gamecontrols.appendChild(emoRow);
  ["happy", "sad", "surprised", "angry", "neutral"].forEach((label) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      if (send({ type: "emotion", label })) emotionOverlay.show(label, true);
    };
    emoRow.appendChild(b);
  });

  setInterval(updateStatus, 1000);

  /* ---------- spectating & replays (Phase 6) ---------- */
  const watchPanel = document.getElementById("watchPanel");
  const liveList = document.getElementById("liveList");
  const pastList = document.getElementById("pastList");
  const replayPanel = document.getElementById("replayPanel");
  const replayTitle = document.getElementById("replayTitle");
  const replayMove = document.getElementById("replayMove");
  const replayPos = document.getElementById("replayPos");

  const SPEC_EVENT_TYPES = new Set([
    "game_start", "turn", "move_applied", "game_over", "player_left", "spec_end",
    "sync_error", "sync_ok", "move_rejected", "reject_clear",
  ]);

  let watching = null; // { code, names, minutes }
  let stationPov = false; // watching OUR station's game: present it as the player's POV
  let stationSide = "A"; // which letter OUR station plays in a shared game
  let specClockA = 0;
  let specClockB = 0;
  let specClockActive = null; // "A" | "B" | null
  let specClockTick = null;

  // one container per board slot; the renderer is (re)built only when the
  // game type changes
  function boardFor(type, el, cache) {
    if (cache.el !== el || cache.type !== type) {
      cache.el = el;
      cache.type = type;
      cache.api = type === "xiangqi" ? initXiangqi(el) : initBoard(el);
    }
    return cache.api;
  }
  const specCache = {};
  const replayCache = {};
  const specBoardEl = document.getElementById("specBoard");
  const replayBoardEl = document.getElementById("replayBoard");
  let specBoard = null;
  let replayBoard = null;

  // Station POV readiness chip: "your move — go ahead" vs "please wait…".
  // Each state holds for at least a second — camera verification lag must
  // not make the chip flicker between wait and ready.
  let povChipShownAt = 0;
  let povChipTimer = null;
  function showTurnPov(mine) {
    const wait = Math.max(0, 1000 - (Date.now() - povChipShownAt));
    clearTimeout(povChipTimer);
    povChipTimer = setTimeout(() => {
      povChipShownAt = Date.now();
      turnChip.className = "turn-chip " + (mine ? "mine" : "theirs");
      turnChip.textContent = mine ? t("station.ready") : t("station.wait");
      turnGlow.classList.toggle("hidden", !mine);
      setFace(mine ? "your_turn" : "thinking");
      if (mine) sfx("ready");
    }, wait);
  }

  function refreshWatchLists() {
    send({ type: "list_games" });
    send({ type: "list_past" });
  }

  function watchRow(labelText, btnText) {
    const row = document.createElement("div");
    row.className = "watch-row";
    const label = document.createElement("span");
    label.className = "watch-label";
    label.textContent = labelText;
    const btn = document.createElement("button");
    btn.className = "lbtn";
    btn.textContent = btnText;
    row.append(label, btn);
    return { row, btn };
  }

  function renderLiveList(games) {
    lastLiveGames = games;
    liveList.innerHTML = "";
    if (!games.length) {
      liveList.innerHTML = `<div class="watch-empty">${t("watch.empty-live")}</div>`;
      return;
    }
    for (const g of games) {
      const { row, btn } = watchRow(
        t(g.minutes ? "watch.row" : "watch.row-nc",
          { a: g.names.A, b: g.names.B, m: g.minutes, status: t("watch.status." + g.status) }),
        t("watch.watch")
      );
      btn.onclick = () => send({ type: "watch", code: g.code });
      liveList.appendChild(row);
    }
  }

  function renderPastList(games) {
    lastPastGames = games;
    pastList.innerHTML = "";
    if (!games.length) {
      pastList.innerHTML = `<div class="watch-empty">${t("watch.empty-past")}</div>`;
      return;
    }
    for (const g of games) {
      const winner = g.result ? g.names[g.result] : null;
      const { row, btn } = watchRow(
        t("watch.row-past", { a: g.names.A, b: g.names.B, n: g.moveCount }) +
          (winner ? t("watch.row-won", { name: winner }) : ""),
        t("watch.replay")
      );
      btn.onclick = () => send({ type: "get_game", id: g.id });
      pastList.appendChild(row);
    }
  }

  let lastLiveGames = null;
  let lastPastGames = null;

  /* ----- spectator clocks: both sides visible, active side highlighted ----- */
  function specRenderClocks() {
    clockMeTime.textContent = fmtClock(specClockA);
    clockThemTime.textContent = fmtClock(specClockB);
    clockMe.classList.toggle("active", specClockActive === "A");
    clockThem.classList.toggle("active", specClockActive === "B");
  }

  function specSetClocks(minutes) {
    specClockA = specClockB = minutes * 60 * 1000;
    specClockActive = null;
    clockMeLabel.textContent = watching.names.A;
    clockThemLabel.textContent = watching.names.B;
    clockMe.classList.remove("hidden");
    clockThem.classList.remove("hidden");
    specRenderClocks();
  }

  function specSetActiveClock(side) {
    if (!watching || !watching.minutes) return; // station games have no clocks
    specClockActive = side;
    specRenderClocks();
    if (side && !specClockTick) {
      let last = Date.now();
      specClockTick = setInterval(() => {
        const now = Date.now();
        if (specClockActive === "A") specClockA -= now - last;
        else specClockB -= now - last;
        last = now;
        specRenderClocks();
      }, 250);
    }
  }

  function specStopClocks() {
    clearInterval(specClockTick);
    specClockTick = null;
    specClockActive = null;
    clockMe.classList.add("hidden");
    clockThem.classList.add("hidden");
  }

  /* ----- spectator game-over panel (player panel, neutral wording) ----- */
  const gameoverPlayers = document.querySelector(".gameover-players");
  const gameoverActions = document.querySelector(".gameover-actions");
  const specCta = document.getElementById("specCta");

  function showSpecGameover(winner) {
    clearInterval(specClockTick);
    specClockTick = null;
    specClockActive = null;
    specRenderClocks();
    hideTurn();
    // station POV speaks to the player ("YOU WIN"); neutral spectating names the side
    gameoverResult.textContent = stationPov
      ? t(winner === stationSide ? "go.win" : winner ? "go.lose" : "go.draw")
      : winner
        ? t("go.specwin", { name: watching.names[winner] })
        : t("go.draw");
    gameoverResult.className = "gameover-result " + (winner ? "win" : "");
    gameoverHint.textContent = "";
    gameoverPlayers.style.display = "none";
    gameoverActions.style.display = "none";
    // station kiosk: the player needs a next step, not a dead end
    specCta.classList.toggle("hidden", !stationPov);
    gameoverPanel.classList.remove("hidden");
    if (stationPov) sfx(winner === stationSide ? "win" : "lose");
  }

  function hideSpecGameover() {
    gameoverPlayers.style.display = "";
    gameoverActions.style.display = "";
    specCta.classList.add("hidden");
    gameoverPanel.classList.add("hidden");
  }

  /* ----- enter / exit / event stream ----- */
  function enterSpectator(state) {
    watching = { code: state.code, names: state.names, minutes: state.minutes, createdByUs: !!state.createdByUs };
    hideAsk(); // a live game supersedes the phone-or-screen prompt
    // station kiosk watching its own game: present it as the human's POV —
    // "you" vs the robot/opponent, the player turn chip, the face reacts.
    // Match by kiosk id (website-started games) or by mapped device id (PvP
    // rooms carry device ids); the side comes from his stations array.
    const myDevice = stationDevices[stationKiosk] || null;
    const stationList = state.stations || (state.station ? [state.station] : []);
    stationPov = !!(
      stationKiosk &&
      (stationList.includes(stationKiosk) || (myDevice && stationList.includes(myDevice)))
    );
    if (stationPov) {
      const sideMap = myDevice && state.stationSides && state.stationSides[myDevice];
      stationSide = sideMap
        ? sideMap === "black" ? "B" : "A"
        : stationList.indexOf(myDevice || stationKiosk) === 1 ? "B" : "A";
      const oppLabel = state.solo ? t("clock.robot") : t("clock.opp");
      watching.names = stationSide === "A"
        ? { A: t("clock.you"), B: oppLabel }
        : { A: oppLabel, B: t("clock.you") };
      btnBoardView.classList.remove("hidden");
      btnBoardView.textContent = t("view.face");
    }
    hideLobby();
    hideGameover();
    keepAwake();
    setBaseMode("board"); // spectators watch the board, not the face
    specBoard = boardFor(state.gameType || "chess", specBoardEl, specCache);
    // custom openings start from the server's board snapshot, not the
    // standard initial position
    if (state.initialFen && specBoard.setFen(state.initialFen)) {
      for (const m of state.moves || []) specBoard.apply(m.move);
    } else {
      specBoard.replayTo(state.moves || []); // catch up to the live position
    }
    if (state.minutes) {
      specSetClocks(state.minutes);
      if (state.turn) specSetActiveClock(state.turn);
    }
    // a website-created game reads "playing" with no moves while the station
    // sets up the board and the camera verifies it — say so until move one
    if (watching.createdByUs && !(state.moves && state.moves.length)) {
      face.setMessage("station.setting-up");
    }
    if (stationPov && state.turn) {
      // joining mid-game: show whose move it is right away
      showTurnPov(state.turn === stationSide);
    }
    // a game already in a sync error shows the fix-the-board overlay on join
    if (state.syncError) {
      syncBlockDetail = state.syncError;
      refreshBlocker();
    }
    if (state.moves && state.moves.length) {
      face.setMessage("spec.moves-so-far", { n: state.moves.length });
    }
    renderConn();
  }

  function exitSpectator() {
    if (!watching) return;
    watching = null;
    stationPov = false;
    stationSide = "A";
    syncBlockDetail = null;
    mistakeActive = false;
    refreshBlocker();
    clearTimeout(povChipTimer);
    btnBoardView.classList.add("hidden");
    specStopClocks();
    hideTurn();
    hideSpecGameover();
    setBaseMode("face");
    renderConn();
  }

  function spectateEvent(msg) {
    const names = watching.names;
    switch (msg.type) {
      case "game_start":
        hideSpecGameover();
        specBoard.reset(msg.first === "B");
        if (msg.minutes || watching.minutes) specSetClocks(msg.minutes || watching.minutes);
        break;
      case "turn":
        if (stationPov) {
          showTurnPov(msg.player === stationSide);
        } else {
          turnChip.className = "turn-chip " + (msg.player === "A" ? "mine" : "theirs");
          turnChip.textContent = t("turn.spec", { name: names[msg.player] });
          specSetActiveClock(msg.player);
        }
        break;
      case "move_applied":
        specBoard.apply(msg.move);
        // the board is set up and the game is real now — clear the wait note
        if (watching.createdByUs) face.setMessage(null);
        if (stationPov && msg.by === "B") setFace("happy", { hold: 1500, returnTo: "thinking" });
        break;
      case "sync_error":
        syncBlockDetail = msg.detail || "";
        refreshBlocker();
        break;
      case "sync_ok":
        syncBlockDetail = null;
        mistakeActive = false;
        refreshBlocker();
        break;
      case "move_rejected":
        // the player at the machine placed something illegal — big, friendly,
        // and stays up until the piece goes back
        mistakeActive = true;
        refreshBlocker();
        sfx("mistake");
        break;
      case "reject_clear":
        mistakeActive = false;
        refreshBlocker();
        break;
      case "game_over":
        showSpecGameover(msg.winner);
        break;
      case "player_left":
        face.setMessage("spec.left", { name: names[msg.player] });
        break;
      case "spec_end":
        exitSpectator();
        showLobby("lobby.ended");
        if (!playMode) refreshWatchLists();
        break;
    }
  }

  /* ----- replay of recorded games ----- */
  let replay = null; // { game, i, playing, timer }

  function openReplay(game) {
    replayBoard = boardFor(game.gameType || "chess", replayBoardEl, replayCache);
    replay = { game, i: -1, playing: false, timer: null };
    replayTitle.textContent = t(game.minutes ? "replay.title" : "replay.title-nc",
      { a: game.names.A, b: game.names.B, m: game.minutes });
    replayPanel.classList.remove("hidden");
    renderReplay();
  }

  function renderReplay() {
    if (!replay) return;
    const moves = replay.game.moves;
    // custom openings start from the recorded board snapshot
    if (replay.game.initialFen && replayBoard.setFen(replay.game.initialFen)) {
      for (let i = 0; i <= replay.i && i < moves.length; i++) replayBoard.apply(moves[i].move);
    } else {
      replayBoard.replayTo(moves, replay.i);
    }
    if (replay.i < 0) {
      replayMove.textContent = t("replay.start");
    } else {
      const m = moves[replay.i];
      replayMove.textContent = `${replay.i + 1}. ${m.move} — ${replay.game.names[m.by]}`;
    }
    replayPos.textContent = `${replay.i + 1} / ${moves.length}`;
    document.getElementById("repPlay").textContent = t(replay.playing ? "replay.pause" : "replay.play");
  }

  function stepReplay(dir) {
    replay.i = Math.max(-1, Math.min(replay.game.moves.length - 1, replay.i + dir));
    renderReplay();
  }

  function stopReplayAuto() {
    replay.playing = false;
    clearInterval(replay.timer);
    renderReplay();
  }

  document.getElementById("repPrev").onclick = () => { stopReplayAuto(); stepReplay(-1); };
  document.getElementById("repNext").onclick = () => { stopReplayAuto(); stepReplay(1); };
  document.getElementById("repPlay").onclick = () => {
    if (replay.playing) return stopReplayAuto();
    replay.playing = true;
    replay.timer = setInterval(() => {
      if (replay.i >= replay.game.moves.length - 1) return stopReplayAuto();
      stepReplay(1);
    }, 1000);
    renderReplay();
  };
  document.getElementById("repClose").onclick = () => {
    if (replay) stopReplayAuto();
    replay = null;
    replayPanel.classList.add("hidden");
  };

  document.getElementById("btnWatchRefresh").onclick = refreshWatchLists;

  Object.assign(EVENT_HANDLERS, {
    games(msg) { renderLiveList(msg.games); },
    past_games(msg) { renderPastList(msg.games); },
    game(msg) { openReplay(msg); },
    spec_state(msg) { stationSetup = false; enterSpectator(msg); },
  });

  /* ---------- go ---------- */
  videoCall.init({
    send,
    localVideo: document.getElementById("localVideo"),
    remoteVideo: document.getElementById("remoteVideo"),
  });

  // Inline the lobby's hex board so individual tiles can animate; the CSS
  // background stays as the fallback if the fetch fails.
  fetch("assets/hexboard.svg")
    .then((r) => r.text())
    .then((text) => {
      const plane = document.querySelector(".board-plane");
      if (!plane) return;
      plane.innerHTML = text;
      plane.style.background = "none";
      const svg = plane.querySelector("svg");
      svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
      // a random third of the tiles slowly rise and settle, like the board
      // is breathing
      const tiles = [...svg.querySelectorAll(".tile")];
      tiles
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.ceil(tiles.length / 3))
        .forEach((t) => {
          t.classList.add("bob");
          t.style.setProperty("--bob-dur", (5 + Math.random() * 5).toFixed(1) + "s");
          t.style.setProperty("--bob-delay", (-Math.random() * 8).toFixed(1) + "s");
        });
    })
    .catch(() => {});

  window.gameClient = { send, setFace, setBaseMode };

  // i18n: static texts at boot; dynamic views re-render on language switch
  applyStaticTexts();
  document.body.classList.toggle("lang-zh", getLang() === "zh");
  document.getElementById("btnLang").onclick = toggleLang;

  // in-game face/board view toggle (the board shows the live position)
  btnBoardView.onclick = () => {
    if (baseMode === "board") {
      // in a machine party with the opponent's camera on, the other view is their video
      const next = watching && stationPov && remoteVideoOn ? "video" : "face";
      setBaseMode(next);
      btnBoardView.textContent = t("view.board");
    } else {
      setBaseMode("board");
      btnBoardView.textContent = t("view.face");
    }
  };

  // PiP media controls: camera/mic toggles (hover to reveal; tap on touch)
  const pipWrap = document.getElementById("pipWrap");
  const btnPipCam = document.getElementById("btnPipCam");
  const btnPipMic = document.getElementById("btnPipMic");
  // PiP media controls: camera/mic toggles (hover to reveal; tap on touch).
  // With no stream yet, either button starts it (requests permission) —
  // the empty tile is an invitation, not a dead end.
  const startMedia = () => videoCall.start().catch((err) => face.setMessage("Camera: " + err.message));
  btnPipCam.onclick = () => (videoCall.isActive() ? videoCall.toggleCamera() : startMedia());
  btnPipMic.onclick = () => (videoCall.isActive() ? videoCall.toggleMic() : startMedia());
  videoCall.onMediaState = ({ camOn, micOn, active }) => {
    btnPipCam.classList.toggle("off", !camOn);
    btnPipMic.classList.toggle("off", !micOn);
    btnPipCam.title = t(camOn ? "pip.cam-off" : "pip.cam-on");
    btnPipMic.title = t(micOn ? "pip.mic-off" : "pip.mic-on");
    btnCamToggle.classList.toggle("off", !active || !camOn);
    btnCamToggle.title = t(active && camOn ? "cam.on" : "cam.off");
  };
  // the in-game camera master switch (PvP only): starts media if never
  // started, otherwise mutes the camera track — the dark preview box stays,
  // like a Zoom tile with the camera off
  btnCamToggle.onclick = () => {
    if (!videoCall.isActive()) {
      videoCall.start().catch((err) => face.setMessage("Camera: " + err.message));
    } else {
      videoCall.toggleCamera();
    }
  };
  // touchscreens have no hover — tapping the preview reveals the controls
  pipWrap.addEventListener("click", (e) => {
    if (e.target.closest(".pip-btn")) return;
    pipWrap.classList.toggle("show-controls");
  });

  // kiosk wiring: attract-screen buttons + the resting-state sweeper
  if (stationKiosk) {
    document.body.classList.add("kiosk"); // hides the Friends button (public screen)
    document.getElementById("btnGuestPlay").onclick = () => enterGuestMode();
    document.getElementById("btnGuestBack").onclick = () => exitGuestMode();
    document.getElementById("btnStaffSignin").onclick = () => {
      staffOverride = true;
      renderKioskState();
      document.getElementById("authScreen").classList.remove("hidden");
    };
    document.getElementById("btnModeScreen").onclick = () => setKioskMode("screen");
    document.getElementById("btnModePhone").onclick = () => setKioskMode("phone");
    document.getElementById("btnModeBack").onclick = () => setKioskMode(null);
    // the card/phone sub-choice inside screen mode (instructional only —
    // the server treats both identically when the screen is in play-here mode)
    document.getElementById("btnTapCard").onclick = () => { tapKindSel = "card"; renderAttractMode(); pushKioskMode(); };
    document.getElementById("btnTapPhone").onclick = () => { tapKindSel = "phone"; renderAttractMode(); pushKioskMode(); };
    // the attract page's scattered discs are draggable toys with table-hockey
    // physics: push one into another and it slides away (with friction, wall
    // bounces, and chain reactions). Positions live in the DOM only — a page
    // reload resets the layout.
    (() => {
      const discs = [...document.querySelectorAll(".at-piece")].map((el) => {
        const r = el.getBoundingClientRect();
        return { el, x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2, vx: 0, vy: 0, dragging: false, touching: new Set() };
      });
      const FRICTION = 0.94; // per frame at ~60fps
      const REST = 0.35; // wall restitution

      // the attract page starts hidden — rects are all zero until it's shown,
      // so measure lazily on the first touch instead of at boot
      let measured = false;
      function measureAll() {
        for (const p of discs) {
          const r = p.el.getBoundingClientRect();
          if (r.width === 0) return; // still hidden
          p.x = r.left + r.width / 2;
          p.y = r.top + r.height / 2;
          p.r = r.width / 2;
        }
        measured = true;
      }

      function sync(p) {
        p.el.style.left = (p.x / window.innerWidth * 100) + "%";
        p.el.style.top = (p.y / window.innerHeight * 100) + "%";
      }

      let looping = false;
      function step() {
        let moving = false;
        for (const p of discs) {
          if (p.dragging) continue;
          if (Math.abs(p.vx) + Math.abs(p.vy) < 0.3) { p.vx = p.vy = 0; continue; }
          moving = true;
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= FRICTION;
          p.vy *= FRICTION;
          if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx) * REST; }
          if (p.x > window.innerWidth - p.r) { p.x = window.innerWidth - p.r; p.vx = -Math.abs(p.vx) * REST; }
          if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy) * REST; }
          if (p.y > window.innerHeight - p.r) { p.y = window.innerHeight - p.r; p.vy = -Math.abs(p.vy) * REST; }
          sync(p);
        }
        // free-piece collisions: equal-mass swap of normal velocities
        for (let i = 0; i < discs.length; i++) {
          for (let j = i + 1; j < discs.length; j++) {
            const a = discs[i], b = discs[j];
            if (a.dragging || b.dragging) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const min = a.r + b.r;
            if (dist >= min) continue;
            const nx = dx / dist, ny = dy / dist;
            const overlap = min - dist;
            a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
            b.x += nx * overlap / 2; b.y += ny * overlap / 2;
            const avn = a.vx * nx + a.vy * ny;
            const bvn = b.vx * nx + b.vy * ny;
            if (avn - bvn > 0) { // approaching
              a.vx += (bvn - avn) * nx; a.vy += (bvn - avn) * ny;
              b.vx += (avn - bvn) * nx; b.vy += (avn - bvn) * ny;
              moving = true;
            }
            sync(a); sync(b);
          }
        }
        if (moving) requestAnimationFrame(step);
        else looping = false;
      }
      function wake() {
        if (!looping) { looping = true; requestAnimationFrame(step); }
      }

      discs.forEach((p) => {
        p.el.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          if (!measured) measureAll();
          if (!measured) return; // page not visible yet — nothing to drag
          p.el.setPointerCapture(e.pointerId);
          p.el.classList.add("dragging");
          p.dragging = true;
          p.vx = p.vy = 0;
          p.touching.clear();
          let lastX = e.clientX, lastY = e.clientY;
          const onMove = (ev) => {
            p.vx = ev.clientX - lastX; // pointer velocity (px/event ≈ px/frame)
            p.vy = ev.clientY - lastY;
            lastX = ev.clientX; lastY = ev.clientY;
            p.x += p.vx;
            p.y += p.vy;
            p.x = Math.min(window.innerWidth - p.r, Math.max(p.r, p.x));
            p.y = Math.min(window.innerHeight - p.r, Math.max(p.r, p.y));
            sync(p);
            // bump others out of the way and hand them the momentum
            for (const q of discs) {
              if (q === p || q.dragging) continue;
              const dx = q.x - p.x, dy = q.y - p.y;
              const dist = Math.hypot(dx, dy) || 0.01;
              const min = p.r + q.r;
              if (dist >= min) { p.touching.delete(q); continue; }
              const nx = dx / dist, ny = dy / dist;
              q.x = p.x + nx * min;
              q.y = p.y + ny * min;
              if (!p.touching.has(q)) {
                p.touching.add(q);
                const speed = Math.max(0, p.vx * nx + p.vy * ny) * 1.25 + 2; // a little livelier than the hand
                q.vx = nx * speed;
                q.vy = ny * speed;
                wake();
              }
              sync(q);
            }
          };
          const onUp = () => {
            p.dragging = false;
            p.el.classList.remove("dragging");
            p.el.removeEventListener("pointermove", onMove);
            p.el.removeEventListener("pointerup", onUp);
            p.el.removeEventListener("pointercancel", onUp);
          };
          p.el.addEventListener("pointermove", onMove);
          p.el.addEventListener("pointerup", onUp);
          p.el.addEventListener("pointercancel", onUp);
        });
      });
    })();
    renderAttractMode();
    // the phone-or-screen choice: "screen" redeems straight into the login
    // flow; "phone" releases the link to the app and returns to the attract
    document.getElementById("btnAskScreen").onclick = () => {
      if (!pendingAsk) return;
      fetch("/session-choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pendingAsk.code, choice: "kiosk" }),
      }).catch(() => {});
      location.href = pendingAsk.url;
    };
    document.getElementById("btnAskPhone").onclick = () => {
      if (pendingAsk) {
        fetch("/session-choose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: pendingAsk.code, choice: "phone" }),
        }).catch(() => {});
      }
      hideAsk();
    };
    setInterval(renderKioskState, 1000);
    renderKioskState();
  }
  onLangChange(() => {
    lobbyWelcome.textContent = myName
      ? t("lobby.welcome", { name: myName })
      : t("lobby.welcome-default");
    // only re-render the lobby text when the lobby is on screen —
    // mid-game this must not pull the menu over the game
    if (!lobby.classList.contains("hidden")) showLobby();
    applyModeGate();
    renderConn();
    if (lastLiveGames) renderLiveList(lastLiveGames);
    if (lastPastGames) renderPastList(lastPastGames);
    if (replay) renderReplay();
    if (!clockMe.classList.contains("hidden") && !watching) {
      clockMeLabel.textContent = t("clock.you");
      clockThemLabel.textContent = soloMode ? t("clock.robot") : t("clock.opp");
    }
    if (turnState) showTurn(turnState === "your_turn");
  });

  // A tap session's marker survives a refresh (sessionStorage is per-tab).
  // Booting with a marker but no tap code in the URL means a refresh just
  // locked this tab out of play — end the old session immediately so the
  // station frees up for a fresh tap. (An ordinary network drop has no
  // marker at boot; that case is the server's grace window.)
  tapSessionId = sessionStorage.getItem("nxSession");
  if (tapSessionId) {
    // a fresh tap link replaces the old session; anything else (plain
    // refresh) means play was just locked out — either way the old
    // session ends now, not after a grace window
    const reason = new URLSearchParams(location.search).get("code") ? "replaced" : "refresh";
    endTapSession(reason);
  }

  // Closing the tab ends the session too (best-effort beacon; if it never
  // lands, the server's grace window catches the dead socket instead).
  window.addEventListener("pagehide", () => {
    const sid = sessionStorage.getItem("nxSession");
    if (sid) {
      navigator.sendBeacon(
        "/session-end",
        new Blob([JSON.stringify({ sessionId: sid, reason: "tab_closed" })], { type: "application/json" })
      );
    }
  });

  // Boot: /config.json decides which personality this page has.
  //   online  — load the Firebase-backed modules (auth.js, friends.js) and
  //             require sign-in; the lobby opens once Firebase confirms who
  //             this is. (onAuthStateChanged fires asynchronously, so
  //             `friends` is always initialized before onAuthed runs.)
  //   offline — the kiosk Pi: skip sign-in, guest solo play, and the
  //             Google-hosted SDK is never requested at all.
  (async () => {
    let config = {};
    try {
      config = await (await fetch("/config.json")).json();
    } catch {
      // page served by something other than the game server — assume online
    }
    gameServerUrl = config.gameServerUrl || null;
    stationDevices = config.stationDevices || {};
    // a station screen must be reachable for tap pushes BEFORE anyone signs
    // in — the push IS the login. Connect immediately, signed-out.
    if (stationKiosk) connect();
    if (config.offline) {
      enterGuestMode();
      return;
    }
    const [{ initAuth }, { initFriends }] = await Promise.all([
      import("./auth.js"),
      import("./friends.js"),
    ]);
    const authApi = initAuth({ onAuthed, onSignedOut });
    friends = initFriends({
      app: authApi.app,
      send,
      canPlay: () => playMode,
      getGameContext: () => ({ inRoom, soloMode, oppUid, oppName }),
    });
    // Sign out doubles as the website's Disconnect: the tap session ends
    // immediately, no grace window.
    btnSignOut.onclick = () => {
      endTapSession("signed_out");
      authApi.signOut();
    };
  })();
})();
