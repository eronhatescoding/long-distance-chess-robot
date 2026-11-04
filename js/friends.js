/* Friends (Phase 5) — friendships and challenges, client ↔ Firestore
 * directly (rules in firestore.rules enforce the shape; the server is only
 * used for /lookup-user, which turns an email into a uid via the Admin SDK).
 *
 * Data:
 *   friendships/{id}  { users: [uidA, uidB], names: {uid: name},
 *                       status: "pending"|"accepted", requestedBy, createdAt }
 *   challenges/{id}   { from, to, fromName, code, status: "pending"|"declined",
 *                       createdAt }
 *
 * A challenge is a party code delivered by Firestore instead of by mouth:
 * the challenger creates a room as usual, the code rides the challenge doc,
 * and accepting just joins that room.
 */

import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { t, onLangChange } from "./i18n.js";

export function initFriends({ app, send, canPlay, getGameContext }) {
  const db = getFirestore(app);

  const btnFriends = document.getElementById("btnFriends");
  const panel = document.getElementById("friendsPanel");
  const emailInput = document.getElementById("friendEmail");
  const addBtn = document.getElementById("btnAddFriend");
  const errorEl = document.getElementById("friendsError");
  const requestsList = document.getElementById("friendRequests");
  const requestsSection = document.getElementById("friendRequestsSection");
  const friendsList = document.getElementById("friendsList");
  const challengePop = document.getElementById("challengePop");
  const challengeText = document.getElementById("challengeText");
  const challengeHint = document.getElementById("challengeHint");
  const btnAddOpponent = document.getElementById("btnAddOpponent");
  const friendToast = document.getElementById("friendToast");
  const friendToastText = document.getElementById("friendToastText");

  // stop "d" in the email field from toggling the dev panel
  emailInput.addEventListener("keydown", (e) => e.stopPropagation());

  let user = null; // Firebase user while signed in
  let friendships = []; // latest snapshot docs
  let firstFriendSnap = true; // don't toast for requests that predate sign-in
  let toastTimer = null;
  let outgoing = null; // { toUid, toName } waiting for a room code
  let incoming = null; // { id, fromName, code } shown in the popup
  let unsubs = [];

  /* ---------- helpers ---------- */

  function setError(text) {
    errorEl.textContent = text || "";
  }

  function myName() {
    return user.displayName || (user.email || "player").split("@")[0];
  }

  function friendRow(labelText) {
    const row = document.createElement("div");
    row.className = "watch-row friend-row";
    const label = document.createElement("span");
    label.className = "watch-label";
    label.textContent = labelText;
    row.appendChild(label);
    return row;
  }

  function rowButton(text, onClick, primary) {
    const btn = document.createElement("button");
    btn.className = primary ? "lbtn primary" : "lbtn";
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  /* ---------- rendering ---------- */

  function render() {
    if (!user) return;

    const incoming_ = friendships.filter((f) => f.status === "pending" && f.requestedBy !== user.uid);
    const outgoing_ = friendships.filter((f) => f.status === "pending" && f.requestedBy === user.uid);
    const accepted = friendships.filter((f) => f.status === "accepted");

    requestsSection.classList.toggle("hidden", !incoming_.length && !outgoing_.length);
    requestsList.innerHTML = "";
    for (const f of incoming_) {
      const row = friendRow(f.names[f.requestedBy] || "unknown");
      row.appendChild(rowButton(t("friends.accept"), () => acceptFriendship(f.id), true));
      row.appendChild(rowButton(t("friends.decline"), () => deleteDoc(doc(db, "friendships", f.id))));
      requestsList.appendChild(row);
    }
    for (const f of outgoing_) {
      const otherUid = f.users.find((u) => u !== user.uid);
      const row = friendRow(t("friends.waiting", { name: f.names[otherUid] || "unknown" }));
      row.appendChild(rowButton(t("friends.cancel"), () => deleteDoc(doc(db, "friendships", f.id))));
      requestsList.appendChild(row);
    }

    friendsList.innerHTML = "";
    if (!accepted.length) {
      friendsList.innerHTML = `<div class="watch-empty">${t("friends.empty")}</div>`;
    }
    for (const f of accepted) {
      const otherUid = f.users.find((u) => u !== user.uid);
      const name = f.names[otherUid] || "unknown";
      const row = friendRow(name);
      const cooling = (cooldowns[otherUid] || 0) - Date.now();
      // the button label itself explains why you can't challenge right now
      const challengeBtn = rowButton(
        !canPlay()
          ? t("friends.tap-to-play-short")
          : activeOut
            ? t("friends.challenge-pending")
            : cooling > 0
              ? t("friends.cooldown-btn", { n: Math.ceil(cooling / 1000) })
              : t("friends.challenge"),
        () => challenge(otherUid, name),
        true
      );
      challengeBtn.disabled = !canPlay() || !!activeOut || cooling > 0;
      row.appendChild(challengeBtn);
      row.appendChild(rowButton(t("friends.remove"), () => deleteDoc(doc(db, "friendships", f.id))));
      friendsList.appendChild(row);
    }
  }

  function renderChallengePop() {
    if (!incoming) {
      challengePop.classList.add("hidden");
      return;
    }
    hideReasons(); // always land on the main view
    challengeText.textContent = t("friends.popup", { name: incoming.fromName });
    challengeHint.textContent = canPlay() ? "" : t("friends.popup-hint");
    document.getElementById("btnAcceptChallenge").disabled = !canPlay();
    challengePop.classList.remove("hidden");
  }

  /* ---------- friend actions ---------- */

  function isConnected(uid) {
    return friendships.some((f) => f.users.includes(uid));
  }

  async function requestFriend(uid, name) {
    if (!user || uid === user.uid || isConnected(uid)) return;
    await addDoc(collection(db, "friendships"), {
      users: [user.uid, uid],
      names: { [user.uid]: myName(), [uid]: name },
      status: "pending",
      requestedBy: user.uid,
      createdAt: serverTimestamp(),
    });
    refreshAddButton();
  }

  async function addFriend() {
    setError("");
    const input = emailInput.value.trim().toLowerCase();
    if (!input) return setError(t("friends.err-email"));
    const byEmail = input.includes("@");
    if (byEmail && user.email && input === user.email.toLowerCase()) return setError(t("friends.err-self"));

    addBtn.disabled = true;
    try {
      // an @ means email lookup; anything else is a username lookup
      const res = await fetch("/lookup-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          byEmail
            ? { idToken: await user.getIdToken(), email: input }
            : { idToken: await user.getIdToken(), username: input }
        ),
      });
      const data = await res.json();
      if (!data.ok) return setError(data.detail || t("friends.err-lookup"));
      if (isConnected(data.uid)) return setError(t("friends.err-exists"));
      await requestFriend(data.uid, data.name);
      emailInput.value = "";
    } catch (err) {
      setError(err.message);
    } finally {
      addBtn.disabled = false;
    }
  }

  function acceptFriendship(id) {
    updateDoc(doc(db, "friendships", id), { status: "accepted" }).catch((e) => setError(e.message));
  }

  /* ---------- in-game "add opponent" button + request toast ---------- */

  // The + hangs next to the opponent's clock — only for human opponents in
  // a PvP room, never for the robot, never when already connected.
  function refreshAddButton() {
    const ctx = getGameContext ? getGameContext() : {};
    const show = !!(
      user &&
      ctx.inRoom &&
      !ctx.soloMode &&
      ctx.oppUid &&
      ctx.oppUid !== user.uid &&
      !isConnected(ctx.oppUid)
    );
    btnAddOpponent.classList.toggle("hidden", !show);
  }

  btnAddOpponent.onclick = async () => {
    const ctx = getGameContext ? getGameContext() : {};
    if (!ctx.oppUid) return;
    try {
      await requestFriend(ctx.oppUid, ctx.oppName || "opponent");
      showFriendToast(t("friends.toast-sent", { name: ctx.oppName || "opponent" }));
    } catch (err) {
      showFriendToast(t("friends.toast-fail", { err: err.message }));
    }
  };

  function showFriendToast(text) {
    friendToastText.textContent = text;
    friendToast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => friendToast.classList.add("hidden"), 5000);
  }

  // tapping the toast opens the panel so the request is one tap away
  friendToast.onclick = () => {
    friendToast.classList.add("hidden");
    panel.classList.remove("hidden");
    setError("");
    render();
  };

  /* ---------- challenges ---------- */

  const CHALLENGE_TIMEOUT_MS = 20000; // no response -> tell the sender they're busy
  const RECHALLENGE_COOLDOWN_MS = 10000; // base cooldown; escalates per decline
  const MAX_COOLDOWN_MS = 60000;
  const PRESET_REASONS = new Set(["not_at_machine", "busy", "later"]);

  const challengeMain = document.getElementById("challengeMain");
  const challengeReasons = document.getElementById("challengeReasons");
  const declineCustom = document.getElementById("declineCustom");
  declineCustom.addEventListener("keydown", (e) => e.stopPropagation());

  let activeOut = null; // { id, toUid, toName, code, timer } — challenge we sent
  const cooldowns = {}; // toUid -> timestamp when re-challenge is allowed
  const declineStreaks = {}; // toUid -> consecutive declines (escalates cooldown)

  function challenge(toUid, toName) {
    if (!canPlay() || activeOut) return;
    if (Date.now() < (cooldowns[toUid] || 0)) return;
    outgoing = { toUid, toName };
    setError("");
    send({ type: "create_room", minutes: 10 }); // code arrives via onRoomCreated
    setError(t("friends.challenging", { name: toName }));
  }

  async function onRoomCreated(code) {
    if (!outgoing || !user) return;
    const { toUid, toName } = outgoing;
    outgoing = null;
    try {
      const ref = await addDoc(collection(db, "challenges"), {
        from: user.uid,
        to: toUid,
        fromName: myName(),
        code,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      activeOut = {
        id: ref.id,
        toUid,
        toName,
        code,
        timer: setTimeout(expireChallenge, CHALLENGE_TIMEOUT_MS),
      };
    } catch (err) {
      setError(err.message);
    }
  }

  // 20s with no answer: expire it, free the room, tell the sender
  async function expireChallenge() {
    if (!activeOut) return;
    const { id, toUid, toName } = activeOut;
    activeOut = null;
    await updateDoc(doc(db, "challenges", id), { status: "expired" }).catch(() => {});
    send({ type: "leave_room" }); // destroy the waiting room we created
    showFriendToast(t("friends.notify-timeout", { name: toName }));
    startCooldown(toUid);
  }

  // 10s base, escalating per consecutive decline (capped) — and re-render
  // every second so the countdown is visible on the button itself
  let cooldownTick = null;

  function startCooldown(toUid) {
    declineStreaks[toUid] = (declineStreaks[toUid] || 0) + 1;
    const ms = Math.min(RECHALLENGE_COOLDOWN_MS * declineStreaks[toUid], MAX_COOLDOWN_MS);
    cooldowns[toUid] = Date.now() + ms;
    scheduleCooldownRender();
    render();
  }

  function scheduleCooldownRender() {
    if (cooldownTick) return;
    cooldownTick = setInterval(() => {
      const anyLeft = Object.values(cooldowns).some((until) => until > Date.now());
      render();
      if (!anyLeft) {
        clearInterval(cooldownTick);
        cooldownTick = null;
        render();
      }
    }, 1000);
  }

  function reasonText(reason) {
    if (!reason) return null;
    return PRESET_REASONS.has(reason) ? t("friends.reason-" + reason) : reason;
  }

  // our outgoing doc changed: declined (notify + cooldown) or vanished
  // (accepted — the game is starting; reset the escalation streak)
  function watchOutgoing(docs) {
    if (!activeOut) return;
    const doc_ = docs.find((d) => d.id === activeOut.id);
    if (!doc_) {
      clearTimeout(activeOut.timer);
      declineStreaks[activeOut.toUid] = 0; // accepted — streak resets
      activeOut = null;
      return;
    }
    if (doc_.status === "declined") {
      const { toUid, toName } = activeOut;
      clearTimeout(activeOut.timer);
      activeOut = null;
      send({ type: "leave_room" });
      const reason = reasonText(doc_.declineReason);
      showFriendToast(
        reason
          ? t("friends.notify-declined", { name: toName, reason })
          : t("friends.notify-declined-plain", { name: toName })
      );
      startCooldown(toUid);
    }
  }

  async function acceptChallenge() {
    if (!incoming || !canPlay()) return;
    const { id, code } = incoming;
    incoming = null;
    renderChallengePop();
    challengePop.classList.add("hidden");
    // delete first so a join failure doesn't leave a dead invite around;
    // the room code is already in hand
    await deleteDoc(doc(db, "challenges", id)).catch(() => {});
    send({ type: "join_room", code });
  }

  // Decline opens the reason picker; each path lands on declineWith()
  function showReasons() {
    challengeMain.classList.add("hidden");
    challengeReasons.classList.remove("hidden");
  }

  function hideReasons() {
    challengeReasons.classList.add("hidden");
    challengeMain.classList.remove("hidden");
    declineCustom.value = "";
  }

  function declineWith(reason) {
    if (!incoming) return;
    const update = { status: "declined" };
    if (reason) update.declineReason = String(reason).slice(0, 60);
    updateDoc(doc(db, "challenges", incoming.id), update).catch((err) =>
      showFriendToast(t("friends.toast-fail", { err: err.message }))
    );
    incoming = null;
    hideReasons();
    renderChallengePop();
  }

  addBtn.onclick = addFriend;
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFriend();
  });
  document.getElementById("btnCloseFriends").onclick = () => panel.classList.add("hidden");
  btnFriends.onclick = () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      setError("");
      render();
    }
  };
  document.getElementById("btnAcceptChallenge").onclick = acceptChallenge;
  document.getElementById("btnDeclineChallenge").onclick = showReasons;
  document.getElementById("btnDeclineBack").onclick = hideReasons;
  document.getElementById("btnDeclineCustom").onclick = () =>
    declineWith(declineCustom.value.trim() || null);
  challengeReasons.querySelectorAll(".reason").forEach((b) => {
    b.onclick = () => declineWith(b.dataset.reason);
  });

  /* ---------- auth wiring ---------- */

  function onSignIn(firebaseUser) {
    user = firebaseUser;
    btnFriends.classList.remove("hidden");

    unsubs.push(
      onSnapshot(
        query(collection(db, "friendships"), where("users", "array-contains", user.uid)),
        (snap) => {
          const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          // toast for genuinely new incoming requests (not the backlog
          // delivered on sign-in — those live in the panel)
          const fresh = docs.filter(
            (d) =>
              d.status === "pending" &&
              d.requestedBy !== user.uid &&
              !friendships.some((f) => f.id === d.id)
          );
          friendships = docs;
          render();
          refreshAddButton();
          if (!firstFriendSnap) {
            for (const f of fresh) {
              showFriendToast(t("friends.toast-new", { name: f.names[f.requestedBy] || "someone" }));
            }
          }
          firstFriendSnap = false;
        },
        (err) => console.warn("friends listener:", err.message)
      ),
      onSnapshot(
        query(
          collection(db, "challenges"),
          where("to", "==", user.uid),
          where("status", "==", "pending")
        ),
        (snap) => {
          const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          docs.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
          // stale challenges (e.g. arrived while offline) auto-expire —
          // no popup for something the sender has already given up on
          const now = Date.now();
          const stale = docs.filter(
            (d) => now - (d.createdAt?.toMillis?.() || now) > CHALLENGE_TIMEOUT_MS + 5000
          );
          for (const d of stale) {
            updateDoc(doc(db, "challenges", d.id), { status: "expired" }).catch(() => {});
          }
          incoming = docs.filter((d) => !stale.includes(d))[0] || null;
          renderChallengePop();
        },
        (err) => console.warn("challenge listener:", err.message)
      ),
      // our own outgoing challenges: decline notifications + cleanup
      onSnapshot(
        query(collection(db, "challenges"), where("from", "==", user.uid)),
        (snap) => watchOutgoing(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => console.warn("outgoing listener:", err.message)
      )
    );
  }

  function onSignOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    friendships = [];
    firstFriendSnap = true;
    outgoing = null;
    incoming = null;
    if (activeOut) clearTimeout(activeOut.timer);
    activeOut = null;
    btnFriends.classList.add("hidden");
    btnAddOpponent.classList.add("hidden");
    panel.classList.add("hidden");
    friendToast.classList.add("hidden");
    renderChallengePop();
  }

  // play mode changes which buttons are live — re-render everything
  function refreshMode() {
    render();
    renderChallengePop();
  }

  onLangChange(refreshMode);

  return { onSignIn, onSignOut, onRoomCreated, refreshAddButton, refreshMode };
}
