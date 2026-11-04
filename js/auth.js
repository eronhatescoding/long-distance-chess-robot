/* Auth (Phase 1) — Firebase email/password sign-in plus the tap handoff.
 *
 * Two session modes, kept in sessionStorage so a refresh doesn't change them:
 *   "play"      — arrived via a tap link (?token=... minted by the server in
 *                 Phase 2); play actions in the lobby are unlocked
 *   "spectator" — signed in manually; watch/review only (Phase 6), play
 *                 actions stay locked
 *
 * client.js consumes this via initAuth({ onAuthed, onSignedOut }).
 * The web config below is public by design — security lives in Firestore
 * rules and the server-held service account key, not in this object.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithCustomToken,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { t, onLangChange } from "./i18n.js";

const firebaseConfig = {
  apiKey: "AIzaSyCD4GDPAc32Cw7hJ5492brlHQ9VCAQMkJI",
  authDomain: "nexusboard-d4432.firebaseapp.com",
  projectId: "nexusboard-d4432",
  storageBucket: "nexusboard-d4432.firebasestorage.app",
  messagingSenderId: "271360017705",
  appId: "1:271360017705:web:0c4b502894bdc3750f6338",
};

const ERROR_KEYS = {
  "auth/invalid-email": "auth.err.invalid-email",
  "auth/invalid-credential": "auth.err.invalid-credential",
  "auth/user-not-found": "auth.err.user-not-found",
  "auth/wrong-password": "auth.err.wrong-password",
  "auth/email-already-in-use": "auth.err.email-in-use",
  "auth/weak-password": "auth.err.weak-password",
  "auth/too-many-requests": "auth.err.too-many",
  "auth/network-request-failed": "auth.err.network",
  "auth/operation-not-allowed": "auth.err.not-allowed",
  "auth/invalid-custom-token": "auth.err.bad-token",
  "auth/custom-token-mismatch": "auth.err.token-mismatch",
};

function friendly(err) {
  const key = ERROR_KEYS[err?.code];
  return key ? t(key) : err?.message || "something went wrong";
}

export function initAuth({ onAuthed, onSignedOut }) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth();

  const screen = document.getElementById("authScreen");
  const form = document.getElementById("authForm");
  const emailEl = document.getElementById("authEmail");
  const passEl = document.getElementById("authPass");
  const submitBtn = document.getElementById("authSubmit");
  const toggleBtn = document.getElementById("authToggle");
  const errorEl = document.getElementById("authError");
  const subEl = document.getElementById("authSub");

  // don't let "d" toggle the dev panel while typing credentials
  [emailEl, passEl].forEach((el) =>
    el.addEventListener("keydown", (e) => e.stopPropagation())
  );

  let creating = false;

  function setError(text) {
    errorEl.textContent = text || "";
  }

  function renderFormText() {
    subEl.textContent = t("auth.sub");
    submitBtn.textContent = t(creating ? "auth.create" : "auth.signin");
    toggleBtn.textContent = t(creating ? "auth.to-signin" : "auth.to-create");
  }

  toggleBtn.onclick = () => {
    creating = !creating;
    passEl.autocomplete = creating ? "new-password" : "current-password";
    setError("");
    renderFormText();
  };

  onLangChange(renderFormText);
  renderFormText();

  form.onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    submitBtn.disabled = true;
    try {
      const fn = creating ? createUserWithEmailAndPassword : signInWithEmailAndPassword;
      await fn(auth, emailEl.value.trim(), passEl.value);
      tapPlay = false; // manual login = watch mode
    } catch (err) {
      setError(friendly(err));
    } finally {
      submitBtn.disabled = false;
    }
  };

  // Tap handoff. The server issues short single-use redemption codes
  // (Phase 2.5): the phone/station opens game.html?code=... and we exchange
  // it for a custom token via POST /redeem. (?token=... with a raw custom
  // token still works for dev.) Either way the tab lands in play mode.
  //
  // Play mode is intentionally NOT persisted anywhere: a refresh or a new
  // visit lands in spectator mode until the player taps again — the one-time
  // code has already been consumed, so only a fresh tap can re-unlock play.
  let tapPlay = false; // in-memory only, dies with the page
  let tapSessionId = null; // from /redeem — lets the client end its session

  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const code = params.get("code");

  function beginTapSignIn() {
    subEl.textContent = t("auth.tap");
    form.classList.add("hidden");
    toggleBtn.classList.add("hidden");
    // Optimistic: onAuthStateChanged reads the mode when the sign-in lands,
    // and it fires before the promises below resolve.
    tapPlay = true;
  }

  function failTapSignIn(message) {
    tapPlay = false;
    // a kiosk showing the signing-in state goes back to the normal attract
    document.getElementById("kioskAttract")?.classList.remove("signing-in");
    form.classList.remove("hidden");
    toggleBtn.classList.remove("hidden");
    renderFormText();
    setError(message);
  }

  // strip the credential from the URL (don't leak via refresh/share) but keep
  // the station param — a kiosk's identity lives there and must survive this
  const strippedUrl = (() => {
    const station = new URLSearchParams(location.search).get("station");
    return location.pathname + (station ? `?station=${encodeURIComponent(station)}` : "");
  })();

  if (code) {
    history.replaceState(null, "", strippedUrl);
    beginTapSignIn();
    fetch("/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.detail || t("auth.err.redeem"));
        // the machine's physical board determines the lobby's game theme
        if (data.gameType) sessionStorage.setItem("nxGame", data.gameType);
        tapSessionId = data.sessionId || null;
        return signInWithCustomToken(auth, data.token);
      })
      .catch((err) => failTapSignIn(friendly(err)));
  } else if (token) {
    history.replaceState(null, "", strippedUrl);
    beginTapSignIn();
    signInWithCustomToken(auth, token).catch((err) => failTapSignIn(friendly(err)));
  }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      screen.classList.add("hidden");
      onAuthed(user, tapPlay ? "play" : "spectator", tapPlay ? tapSessionId : null);
    } else {
      screen.classList.remove("hidden");
      onSignedOut();
    }
  });

  return {
    app,
    signOut() {
      tapPlay = false;
      return signOut(auth);
    },
  };
}
