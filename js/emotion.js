/* Emotion overlay (Step 4) — renders emotion labels received from the peer's
 * local CV as floating emoji badges on the overlay layer. Stands alone:
 * client.js routes { type: "emotion" } events here; nothing here touches
 * the face or chess state.
 */

window.emotionOverlay = (() => {
  const EMOJI = {
    happy: "😄",
    sad: "😢",
    surprised: "😮",
    angry: "😠",
    neutral: "🙂",
  };

  const HOLD_MS = 3000;
  const MAX_BADGES = 4;

  function layer() {
    return document.getElementById("emotionLayer");
  }

  function show(label, local = false) {
    const container = layer();
    if (!container) return;

    while (container.children.length >= MAX_BADGES) {
      container.firstChild.remove();
    }

    const badge = document.createElement("div");
    badge.className = "emotion-badge" + (local ? " local" : "");
    badge.textContent = EMOJI[label] || "❓";
    badge.title = label + (local ? " (you)" : "");
    container.appendChild(badge);

    setTimeout(() => badge.remove(), HOLD_MS);
  }

  return { show, EMOJI };
})();
