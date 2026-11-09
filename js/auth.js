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

  // One tap sign-in at a time: an initial ?code link and a kiosk push share
  // this flow. While it runs, onAuthStateChanged must NOT hand a cached
  // Firebase user to the app — that is someone's previous login, not the
  // tapped player (and if it is the same uid, Firebase never re-fires after
  // signInWithCustomToken, so the session id would be lost: Sign out then
  // could not end the station event).
  let tap = null; // { key, promise } while in flight
  let deliveredUser = null; // the User object last handed to onAuthed

  const REDEEM_TIMEOUT_MS = 15000; // per /redeem attempt
  const REDEEM_ATTEMPTS = 3; // same code + same attempt id each time
  const SIGNIN_TIMEOUT_MS = 20000; // browser -> Google identity service

  const kioskError = document.getElementById("kioskSignInError");

  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const code = params.get("code");

  function beginTapSignIn() {
    subEl.textContent = t("auth.tap");
    form.classList.add("hidden");
    toggleBtn.classList.add("hidden");
    setError("");
    if (kioskError) kioskError.textContent = "";
    document.getElementById("kioskAttract")?.classList.add("signing-in");
  }

  function failTapSignIn(message) {
    tapPlay = false;
    // a kiosk showing the signing-in state goes back to the normal attract,
    // and says why — its auth form is hidden, so setError alone is invisible
    document.getElementById("kioskAttract")?.classList.remove("signing-in");
    if (kioskError) kioskError.textContent = message;
    form.classList.remove("hidden");
    toggleBtn.classList.remove("hidden");
    renderFormText();
    setError(message);
    // a sign-in that failed leaves whatever account Firebase already had;
    // report it (as spectator) now that the tap no longer owns the screen
    const user = auth.currentUser;
    if (user && user.uid !== deliveredUser?.uid) {
      deliveredUser = user;
      screen.classList.add("hidden");
      onAuthed(user, "spectator", null);
    }
  }

  function tapError(key, extra) {
    return Object.assign(new Error(t(key)), { tapKey: key }, extra || {});
  }

  function withTimeout(promise, ms, key) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(tapError(key)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // POST /redeem with bounded retries. The attempt id makes a retry after a
  // lost response safe: the server re-issues the token only to the caller
  // that consumed the code, never to anyone else holding the same code.
  async function postRedeem(tapCode, attempt) {
    let lastErr = null;
    for (let i = 0; i < REDEEM_ATTEMPTS; i++) {
      if (i) await sleep(800 * i);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REDEEM_TIMEOUT_MS);
      try {
        const r = await fetch("/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: tapCode, attempt }),
          cache: "no-store",
          signal: ctl.signal,
        });
        if (r.status >= 500) { lastErr = tapError("auth.err.network"); continue; }
        const data = await r.json();
        if (!data.ok) throw tapError("auth.err.redeem", { final: true, detail: data.detail });
        return data;
      } catch (err) {
        if (err.final) throw err;
        lastErr = tapError(ctl.signal.aborted ? "auth.err.timeout" : "auth.err.network");
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  function newAttemptId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // Runs one tap sign-in. `getToken` resolves { token, sessionId?, gameType? }.
  // A second call with the same key (a repeated kiosk push of the same code)
  // shares the running operation; a different key while one runs is refused.
  function runTapSignIn(key, getToken) {
    if (tap) {
      if (tap.key === key) return tap.promise;
      return Promise.reject(tapError("auth.err.busy", { busy: true }));
    }
    beginTapSignIn();
    const marks = { start: performance.now() };
    const promise = (async () => {
      const data = await getToken();
      marks.redeemed = performance.now();
      if (data.gameType) sessionStorage.setItem("nxGame", data.gameType);
      const cred = await withTimeout(
        signInWithCustomToken(auth, data.token), SIGNIN_TIMEOUT_MS, "auth.err.timeout"
      );
      marks.signedIn = performance.now();
      tapPlay = true;
      tapSessionId = data.sessionId || null;
      tap = null;
      deliveredUser = cred.user;
      screen.classList.add("hidden");
      await onAuthed(cred.user, "play", tapSessionId);
      marks.ready = performance.now();
      return {
        sessionId: tapSessionId,
        timings: {
          redeemMs: Math.round(marks.redeemed - marks.start),
          firebaseMs: Math.round(marks.signedIn - marks.redeemed),
          uiMs: Math.round(marks.ready - marks.signedIn),
          totalMs: Math.round(marks.ready - marks.start),
        },
      };
    })();
    tap = { key, promise };
    promise.catch((err) => {
      if (tap && tap.promise === promise) tap = null;
      failTapSignIn(err.tapKey ? err.message : friendly(err));
    });
    return promise;
  }

  function redeemTap(tapCode) {
    const c = String(tapCode || "").toUpperCase().trim();
    if (!c) return Promise.reject(tapError("auth.err.redeem"));
    const attempt = newAttemptId();
    return runTapSignIn(`code:${c}`, () => postRedeem(c, attempt));
  }

  // strip the credential from the URL (don't leak via refresh/share) but keep
  // the station param — a kiosk's identity lives there and must survive this
  const strippedUrl = (() => {
    const station = new URLSearchParams(location.search).get("station");
    return location.pathname + (station ? `?station=${encodeURIComponent(station)}` : "");
  })();

  let initialTap = null;
  if (code) {
    history.replaceState(null, "", strippedUrl);
    initialTap = redeemTap(code);
  } else if (token) {
    history.replaceState(null, "", strippedUrl);
    initialTap = runTapSignIn("token", async () => ({ token }));
  }
  initialTap?.catch(() => {}); // failTapSignIn already reported it

  onAuthStateChanged(auth, (user) => {
    if (tap) return; // the tap flow reports its own user when it completes
    if (user) {
      // already reported (by the tap flow, or a token refresh of the same
      // account): never re-report — that would downgrade play to spectator
      if (deliveredUser && user.uid === deliveredUser.uid) return;
      deliveredUser = user;
      screen.classList.add("hidden");
      onAuthed(user, "spectator", null);
    } else {
      deliveredUser = null;
      screen.classList.remove("hidden");
      onSignedOut();
    }
  });

  return {
    app,
    redeemTap,
    initialTap,
    signOut() {
      tapPlay = false;
      return signOut(auth);
    },
  };
}
