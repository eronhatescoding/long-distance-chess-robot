/* Board (Phase 6.5) — a chessboard renderer for spectators and replays.
 *
 * Driven by the UCI move stream (chess.js validates and tracks position).
 * When the physical board's FEN feed lands (see server_integration_brief
 * §7), setFen() snaps the display to the authoritative snapshot.
 *
 * The server coin-flips who moves first; UCI has no color, so "B moves
 * first" is modeled as the initial position with black to move.
 */

// vendored from chess.js@1.4.0 (jsdelivr +esm build) — a CDN import would
// take the whole page down on networks where the CDN is unreachable
import { Chess } from "./vendor/chess.js";

const GLYPHS = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
const BLACK_FIRST_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";

export function initBoard(container) {
  container.innerHTML = "";
  container.classList.add("chess-board");
  container.classList.remove("xq-board"); // shared container with the xiangqi renderer
  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = document.createElement("div");
      sq.className = "sq " + ((r + c) % 2 ? "sq-dark" : "sq-light");
      container.appendChild(sq);
      squares.push(sq);
    }
  }

  const chess = new Chess();

  function render() {
    const rows = chess.board(); // rank 8 -> rank 1, file a -> h
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cell = rows[r][c];
        const sq = squares[r * 8 + c];
        sq.textContent = cell ? GLYPHS[cell.type] : "";
        sq.classList.toggle("pc-w", !!cell && cell.color === "w");
        sq.classList.toggle("pc-b", !!cell && cell.color === "b");
      }
    }
  }

  /* ----- last-move markers + slide animation ----- */

  function clearLastMove() {
    for (const sq of squares) sq.classList.remove("sq-from", "sq-to", "sq-moved");
  }

  function squareRect(i) {
    const c = container.getBoundingClientRect();
    const s = squares[i].getBoundingClientRect();
    return { x: s.left - c.left, y: s.top - c.top, size: s.width };
  }

  let ghost = null;
  let ghostTimer = null;
  let ghostSq = null; // the destination square hidden while the ghost slides
  // Read the pre-move squares (piece still at the source), slide a ghost to
  // the destination, then let the real piece show. Fast consecutive moves
  // replace the old ghost rather than piling up.
  function slide(fromIdx, toIdx) {
    const glyph = squares[fromIdx].textContent;
    const colorCls = squares[fromIdx].classList.contains("pc-b") ? "pc-b" : "pc-w";
    const from = squareRect(fromIdx);
    const to = squareRect(toIdx);
    if (ghost) { ghost.remove(); clearTimeout(ghostTimer); }
    if (ghostSq) { ghostSq.classList.remove("sq-ghosting"); ghostSq = null; }
    ghost = document.createElement("div");
    ghost.className = "move-ghost " + colorCls;
    ghost.textContent = glyph;
    ghost.style.fontSize = getComputedStyle(squares[toIdx]).fontSize;
    ghost.style.width = from.size + "px";
    ghost.style.height = from.size + "px";
    ghost.style.transform = `translate(${from.x}px, ${from.y}px)`;
    container.appendChild(ghost);
    requestAnimationFrame(() => {
      if (ghost) ghost.style.transform = `translate(${to.x}px, ${to.y}px)`;
    });
    ghostSq = squares[toIdx];
    ghostTimer = setTimeout(() => {
      if (ghostSq) {
        ghostSq.classList.remove("sq-ghosting");
        ghostSq.classList.add("sq-moved"); // the landed piece glows until the next move
        ghostSq = null;
      }
      if (ghost) { ghost.remove(); ghost = null; }
    }, 300);
  }

  function reset(blackFirst = false) {
    chess.reset();
    if (blackFirst) chess.load(BLACK_FIRST_FEN);
    clearLastMove();
    if (ghost) { ghost.remove(); ghost = null; clearTimeout(ghostTimer); }
    if (ghostSq) { ghostSq.classList.remove("sq-ghosting"); ghostSq = null; }
    render();
  }

  function apply(uci, { animate = true } = {}) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || "q",
      });
      if (!move) return false;
      clearLastMove();
      const fromIdx = "abcdefgh".indexOf(move.from[0]) + (8 - Number(move.from[1])) * 8;
      const toIdx = "abcdefgh".indexOf(move.to[0]) + (8 - Number(move.to[1])) * 8;
      if (animate) {
        slide(fromIdx, toIdx); // reads the pre-render squares
        squares[toIdx].classList.add("sq-ghosting"); // hide until the ghost lands
      }
      render();
      squares[fromIdx].classList.add("sq-from");
      squares[toIdx].classList.add("sq-to");
      if (!animate) squares[toIdx].classList.add("sq-moved"); // animated slides mark it on landing
      return true;
    } catch {
      return false; // out-of-sync move; the FEN feed will repair this later
    }
  }

  // Rebuild from scratch — used by replay stepping and spectator catch-up.
  // Never animates: scrubbing through 40 slides would be nauseating.
  function replayTo(moves, upto = moves.length - 1) {
    reset(moves.length > 0 && moves[0].by === "B");
    for (let i = 0; i <= upto && i < moves.length; i++) apply(moves[i].move, { animate: false });
  }

  function setFen(fen) {
    try {
      chess.load(fen);
      clearLastMove();
      render();
      return true;
    } catch {
      return false;
    }
  }

  // Pieces each side has lost so far (light = white, dark = black), from the
  // move history — exact even when a pawn has promoted.
  function lost() {
    const out = { light: [], dark: [] };
    for (const mv of chess.history({ verbose: true })) {
      if (!mv.captured) continue;
      // the mover took a piece of the other colour
      (mv.color === "b" ? out.light : out.dark).push(GLYPHS[mv.captured]);
    }
    const order = "qrbnpk";
    const rank = (g) => order.indexOf(Object.keys(GLYPHS).find((k) => GLYPHS[k] === g));
    out.light.sort((a, b) => rank(a) - rank(b));
    out.dark.sort((a, b) => rank(a) - rank(b));
    return out;
  }

  reset();
  return { reset, apply, replayTo, setFen, lost };
}
