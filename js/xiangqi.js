/* Xiangqi renderer (multi-game Phase) — 中国象棋 board for spectators and
 * replays. Same interface as js/board.js so the client can swap renderers
 * by gameType: reset / apply / replayTo / setFen.
 *
 * Board: 9 files × 10 ranks, pieces on intersections, river between ranks
 * 4 and 5. Red moves from the bottom. No move validation here — per the
 * agreed contract the game server is authoritative; this only displays.
 *
 * Internal model: lowercase = red, uppercase = black.
 * Moves: coordinate strings like "h2e2" — file a–i (left→right from red's
 * view), rank 0–9 (red home rank = 0).
 * setFen reads WXF Xiangqi FEN (red = uppercase there; converted here).
 *
 * Everything lives in one SVG (viewBox 0 0 800 900) so lines and pieces
 * scale together at any display size.
 */

const RED_GLYPHS = { g: "帥", a: "仕", e: "相", h: "傌", r: "俥", c: "炮", s: "兵" };
const BLACK_GLYPHS = { G: "將", A: "士", E: "象", H: "馬", R: "車", C: "砲", S: "卒" };

// WXF FEN letter -> internal piece (WXF: uppercase = red, lowercase = black)
const FEN_TO_MODEL = {};
for (const [fen, model] of Object.entries({ K: "g", A: "a", E: "e", H: "h", R: "r", C: "c", P: "s" })) {
  FEN_TO_MODEL[fen] = model; // red
  FEN_TO_MODEL[fen.toLowerCase()] = model.toUpperCase(); // black
}

// rank 0 = red home rank (bottom of the screen)
const INITIAL = [
  ["r", "h", "e", "a", "g", "a", "e", "h", "r"],
  [null, null, null, null, null, null, null, null, null],
  [null, "c", null, null, null, null, null, "c", null],
  ["s", null, "s", null, "s", null, "s", null, "s"],
  [null, null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null, null],
  ["S", null, "S", null, "S", null, "S", null, "S"],
  [null, "C", null, null, null, null, null, "C", null],
  [null, null, null, null, null, null, null, null, null],
  ["R", "H", "E", "A", "G", "A", "E", "H", "R"],
];

function buildLines() {
  const parts = [];
  const line = (x1, y1, x2, y2, w = 3) =>
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${w}"/>`);

  line(0, 0, 800, 0, 7); // border
  line(0, 900, 800, 900, 7);
  line(0, 0, 0, 900, 7);
  line(800, 0, 800, 900, 7);

  for (let f = 1; f < 8; f++) {
    line(f * 100, 0, f * 100, 400); // verticals stop at the river…
    line(f * 100, 500, f * 100, 900); // …and resume below it
  }
  for (let r = 1; r < 9; r++) line(0, r * 100, 800, r * 100);

  // palace diagonals: black palace (top), red palace (bottom)
  line(300, 0, 500, 200);
  line(500, 0, 300, 200);
  line(300, 700, 500, 900);
  line(500, 700, 300, 900);

  return parts.join("");
}

// Flipping the board for the black-side player: pieces and marks remap
// through xy(), and each river text rotates 180° about its own center so it
// still reads upright from the black side (like turning the physical board).
function riverTexts(flipped) {
  const rot = (x) => (flipped ? ` transform="rotate(180 ${x} 455)"` : "");
  return (
    `<text x="200" y="468" class="xq-river-text" text-anchor="middle"${rot(200)}>楚 河</text>` +
    `<text x="600" y="468" class="xq-river-text" text-anchor="middle"${rot(600)}>漢 界</text>`
  );
}

export function initXiangqi(container) {
  container.innerHTML = "";
  container.classList.add("xq-board");
  container.classList.remove("chess-board"); // shared container with the chess renderer

  container.innerHTML =
    `<svg class="xq-svg" viewBox="-45 -45 890 990" aria-hidden="true">` +
    buildLines() +
    `<g class="xq-river"></g><g class="xq-marks"></g><g class="xq-pieces"></g></svg>`;
  const piecesLayer = container.querySelector(".xq-pieces");
  const marksLayer = container.querySelector(".xq-marks");
  const riverLayer = container.querySelector(".xq-river");
  const SVG_NS = "http://www.w3.org/2000/svg";

  let model = INITIAL.map((row) => row.slice());
  let markers = null; // last move's [[fromRank, fromFile], [toRank, toFile]]
  let movedAt = null; // [rank, file] of the piece that last moved (highlighted)
  let ghost = null;
  let ghostTimer = null;
  let flipped = false; // black-side POV: own pieces at the bottom

  // model coords -> SVG coords (normal: red home at the bottom)
  function xy(rank, file) {
    return flipped
      ? { x: (8 - file) * 100, y: rank * 100 }
      : { x: file * 100, y: (9 - rank) * 100 };
  }

  function setFlip(next) {
    flipped = !!next;
    riverLayer.innerHTML = riverTexts(flipped);
    render();
  }
  riverLayer.innerHTML = riverTexts(false);

  function makePiece(piece, extraCls = "") {
    const isRed = piece === piece.toLowerCase();
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "xq-piece " + extraCls + (isRed ? "xq-red" : "xq-black"));
    const disc = document.createElementNS(SVG_NS, "circle");
    disc.setAttribute("r", "44");
    disc.setAttribute("class", "xq-piece-disc");
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("r", "34");
    ring.setAttribute("class", "xq-ring");
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.textContent = isRed ? RED_GLYPHS[piece] : BLACK_GLYPHS[piece];
    g.append(disc, ring, text);
    return g;
  }

  function render(hideAt = null) {
    marksLayer.innerHTML = "";
    if (markers) {
      markers.forEach(([r, f], i) => {
        const p = xy(r, f);
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("class", "xq-mark " + (i === 0 ? "xq-mark-from" : "xq-mark-to"));
        c.setAttribute("cx", p.x);
        c.setAttribute("cy", p.y);
        c.setAttribute("r", "22");
        marksLayer.appendChild(c);
      });
    }
    piecesLayer.innerHTML = "";
    for (let rank = 0; rank < 10; rank++) {
      for (let file = 0; file < 9; file++) {
        const piece = model[rank][file];
        if (!piece) continue;
        const hidden = hideAt && hideAt[0] === rank && hideAt[1] === file;
        const moved = movedAt && movedAt[0] === rank && movedAt[1] === file;
        const p = xy(rank, file);
        const g = makePiece(piece, (hidden ? "xq-ghosting " : "") + (moved ? "xq-moved " : ""));
        g.setAttribute("transform", `translate(${p.x} ${p.y})`);
        piecesLayer.appendChild(g);
      }
    }
  }

  // Slide a ghost piece from source to destination; the real destination
  // piece stays hidden until the ghost lands.
  function slide(piece, fromFile, fromRank, toFile, toRank) {
    if (ghost) { ghost.remove(); clearTimeout(ghostTimer); }
    ghost = makePiece(piece, "xq-ghost ");
    const from = xy(fromRank, fromFile);
    const to = xy(toRank, toFile);
    ghost.style.transform = `translate(${from.x}px, ${from.y}px)`;
    piecesLayer.appendChild(ghost);
    requestAnimationFrame(() => {
      if (ghost) ghost.style.transform = `translate(${to.x}px, ${to.y}px)`;
    });
    ghostTimer = setTimeout(() => {
      if (ghost) { ghost.remove(); ghost = null; }
      render(); // restore the destination piece
    }, 300);
  }

  // The game's starting position: captured pieces are the ones it had that
  // the board no longer has (xiangqi has no promotion, so counts are exact;
  // custom openings with missing pieces count from their own start).
  let start = INITIAL.map((row) => row.slice());

  // Pieces each side has lost so far, as board glyphs, most valuable first.
  // light = red (lost red pieces), dark = black.
  function lost() {
    const count = (m) => {
      const c = {};
      for (const row of m) for (const p of row) if (p) c[p] = (c[p] || 0) + 1;
      return c;
    };
    const before = count(start);
    const now = count(model);
    const out = { light: [], dark: [] };
    for (const k of "grhceas") {
      for (const p of [k, k.toUpperCase()]) {
        const n = (before[p] || 0) - (now[p] || 0);
        for (let i = 0; i < n; i++) {
          if (p === k) out.light.push(RED_GLYPHS[k]);
          else out.dark.push(BLACK_GLYPHS[p]);
        }
      }
    }
    return out;
  }

  function reset() {
    model = INITIAL.map((row) => row.slice());
    start = INITIAL.map((row) => row.slice());
    markers = null;
    movedAt = null;
    if (ghost) { ghost.remove(); ghost = null; clearTimeout(ghostTimer); }
    render();
  }

  // "h2e2"-style: file letter + rank digit, from then to. Captures are just
  // overwrites — the server is the referee, not us.
  function apply(uci, { animate = true } = {}) {
    const m = String(uci || "").match(/^([a-i])([0-9])([a-i])([0-9])$/);
    if (!m) return false;
    const fromFile = m[1].charCodeAt(0) - 97;
    const fromRank = Number(m[2]);
    const toFile = m[3].charCodeAt(0) - 97;
    const toRank = Number(m[4]);
    const piece = model[fromRank][fromFile];
    if (!piece) return false;
    model[toRank][toFile] = piece;
    model[fromRank][fromFile] = null;
    markers = [[fromRank, fromFile], [toRank, toFile]];
    movedAt = [toRank, toFile];
    if (animate) {
      render([toRank, toFile]);
      slide(piece, fromFile, fromRank, toFile, toRank);
    } else {
      render();
    }
    return true;
  }

  function replayTo(moves, upto = moves.length - 1) {
    reset();
    for (let i = 0; i <= upto && i < moves.length; i++) apply(moves[i].move, { animate: false });
  }

  // WXF Xiangqi FEN: rows from black's home rank (top) to red's, '/'-separated,
  // digits = empty intersections. Everything after the first space is ignored.
  function setFen(fen) {
    try {
      const rows = String(fen).split(" ")[0].split("/");
      if (rows.length !== 10) return false;
      const next = INITIAL.map((row) => row.map(() => null));
      for (let i = 0; i < 10; i++) {
        let file = 0;
        for (const ch of rows[i]) {
          if (/\d/.test(ch)) {
            file += Number(ch);
          } else {
            const piece = FEN_TO_MODEL[ch];
            if (!piece || file > 8) return false;
            next[9 - i][file] = piece;
            file++;
          }
        }
        if (file !== 9) return false;
      }
      model = next;
      start = next.map((row) => row.slice());
      render();
      return true;
    } catch {
      return false;
    }
  }

  reset();
  return { reset, apply, replayTo, setFen, setFlip, lost };
}
