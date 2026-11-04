/* Robot Face — standalone display component (Step 1)
 *
 * Public API (used by console, and later by the game client):
 *   face.setState("thinking")                 -> switch to a state
 *   face.setState("happy", { hold: 1500 })    -> auto-return to previous state after 1.5s
 *   face.setState("sad", { message: "King in check" })
 *   face.setMessage("custom text")
 *
 * States: idle | your_turn | thinking | happy | sad | waiting | win | lose
 *
 * Labels and default messages are i18n keys (js/i18n.js). Callers may pass
 * either a key or a literal string as `message` — t() returns non-dict
 * strings unchanged, and {vars} interpolate in both cases.
 */

import { t, onLangChange } from "./js/i18n.js";

const STATES = {
  idle:      { label: "state.idle.label", mouth: "small", msg: "" },
  your_turn: { label: "state.your_turn.label", mouth: "small", msg: "state.your_turn.msg" },
  thinking:  { label: "state.thinking.label", mouth: "flat", msg: "state.thinking.msg" },
  happy:     { label: "state.happy.label", mouth: "smile", msg: "" },
  sad:       { label: "state.sad.label", mouth: "frown", msg: "state.sad.msg" },
  waiting:   { label: "state.waiting.label", mouth: "small", msg: "state.waiting.msg" },
  win:       { label: "state.win.label", mouth: "smile", msg: "state.win.msg" },
  lose:      { label: "state.lose.label", mouth: "frown", msg: "state.lose.msg" },
};

const stage = document.getElementById("stage");
const stateLabel = document.getElementById("stateLabel");
const messageEl = document.getElementById("message");

let current = "idle";
let prev = "idle";
let holdTimer = null;

function setMessage(text, vars) {
  messageEl.textContent = text ? t(text, vars) : "";
}

function setState(name, opts = {}) {
  if (!STATES[name]) {
    console.warn("Unknown state:", name);
    return;
  }
  prev = current;
  current = name;

  stage.className = "stage state-" + name;
  stateLabel.textContent = t(STATES[name].label);

  document.querySelectorAll(".mouth path").forEach((p) => p.classList.remove("active"));
  const m = document.getElementById("m-" + STATES[name].mouth);
  if (m) m.classList.add("active");

  setMessage(opts.message !== undefined ? opts.message : STATES[name].msg, opts.vars);

  if (opts.hold) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => setState(opts.returnTo || "idle"), opts.hold);
  }
}

// re-render the current state when the language changes
onLangChange(() => setState(current));

/* ---------- dev panel ---------- */
const devbuttons = document.getElementById("devbuttons");
Object.keys(STATES).forEach((name) => {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => setState(name);
  devbuttons.appendChild(b);
});

// demo: "happy" auto-reverts so you can see transient-state behavior
const demoBtn = document.createElement("button");
demoBtn.textContent = "happy (1.5s)";
demoBtn.onclick = () => setState("happy", { hold: 1500 });
devbuttons.appendChild(demoBtn);

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "d") {
    document.getElementById("devpanel").classList.toggle("hidden");
  }
});

// TEMP: touchscreen toggle for keyboard-less stations (remove with #devToggle)
document.getElementById("devToggle").addEventListener("click", () => {
  document.getElementById("devpanel").classList.toggle("hidden");
});

setState(current);

window.face = { setState, setMessage, STATES };
