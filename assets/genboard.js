// Procedural generator for the tabletop hex board asset.
// Output: assets/hexboard.svg  (pointy-top hexes, extruded sides, number tokens)
const fs = require("fs");
const path = require("path");

const OUT = process.argv[2];

const R = 104;                 // circumradius
const W = Math.sqrt(3) * R;    // hex width
const DEPTH = 15;              // extrusion depth (px) -> chunky tile side
const VB_W = 1680, VB_H = 1320;
const CX = VB_W / 2, CY = VB_H / 2;

function axial(q, r) {
  return { x: CX + W * (q + r / 2), y: CY + 1.5 * R * r };
}

function hexPts(cx, cy, rad) {
  const p = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    p.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return p;
}
const poly = (pts) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

// ---- palette: warm, muted, board-game plastic ----------------------------
const TERRAIN = {
  forest:   { top: "#5b9a46", side: "#3c6a2e", edge: "#2f5525", deco: "#37682f", deco2: "#79bd5e" },
  pasture:  { top: "#8fc46a", side: "#66934a", edge: "#4e7739", deco: "#5f9344", deco2: "#eaf5df" },
  field:    { top: "#eec95c", side: "#c19c33", edge: "#9b7b24", deco: "#d8a93c", deco2: "#fbe9a8" },
  hills:    { top: "#cf7442", side: "#a1522b", edge: "#7f3f20", deco: "#a85632", deco2: "#eda078" },
  mountain: { top: "#a7b0b8", side: "#7b848d", edge: "#5d666e", deco: "#8c959d", deco2: "#e6ecf1" },
  desert:   { top: "#e3c791", side: "#b99b67", edge: "#957b50", deco: "#c9aa74", deco2: "#f5e7c9" },
  ocean:    { top: "#3f86b8", side: "#2b6390", edge: "#204d72", deco: "#6fb3d9", deco2: "#9fd2ec" },
};

// ---- decorations sitting ON the tile -------------------------------------
function tree(x, y, s, c) {
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})">
      <ellipse cx="0" cy="6" rx="13" ry="4" fill="#000" opacity=".16"/>
      <rect x="-3" y="-4" width="6" height="11" rx="2" fill="#6b4226"/>
      <path d="M0,-30 L13,-6 L-13,-6 Z" fill="${c}"/>
      <path d="M0,-30 L13,-6 L0,-6 Z" fill="#000" opacity=".13"/>
      <path d="M0,-22 L10,-2 L-10,-2 Z" fill="${c}"/>
      <path d="M0,-22 L10,-2 L0,-2 Z" fill="#000" opacity=".13"/>
    </g>`;
}
function peak(x, y, s, c, cap) {
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})">
      <ellipse cx="0" cy="4" rx="26" ry="5" fill="#000" opacity=".16"/>
      <path d="M0,-34 L26,4 L-26,4 Z" fill="${c}"/>
      <path d="M0,-34 L26,4 L0,4 Z" fill="#000" opacity=".16"/>
      <path d="M0,-34 L10,-20 L0,-15 L-10,-20 Z" fill="${cap}"/>
    </g>`;
}
function stripes(cx, cy, c) {
  let s = "";
  for (let i = -4; i <= 4; i++) {
    const y = i * 15;
    const half = 72 - Math.abs(i) * 5;
    s += `<rect x="${-half}" y="${y - 3.5}" width="${half * 2}" height="8" rx="4" fill="${c}" opacity=".9"/>`;
    s += `<rect x="${-half}" y="${y - 3.5}" width="${half * 2}" height="3" rx="1.5" fill="#fff" opacity=".22"/>`;
  }
  return `<g transform="translate(${cx} ${cy}) rotate(-16)">${s}</g>`;
}
function bricks(cx, cy, c) {
  let s = "";
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = cx - 44 + col * 24 + (row % 2 ? 12 : 0);
      const y = cy - 20 + row * 17;
      s += `<g><rect x="${x}" y="${y + 3}" width="20" height="11" rx="3" fill="#000" opacity=".18"/>
            <rect x="${x}" y="${y}" width="20" height="11" rx="3" fill="${c}"/>
            <rect x="${x + 2}" y="${y + 1.5}" width="16" height="3.5" rx="1.7" fill="#fff" opacity=".22"/></g>`;
    }
  }
  return s;
}
function sheep(x, y, c) {
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <ellipse cx="0" cy="8" rx="16" ry="4" fill="#000" opacity=".15"/>
      <rect x="-12" y="-9" width="24" height="16" rx="8" fill="${c}"/>
      <circle cx="10" cy="-8" r="6" fill="#d8cfc2"/>
      <rect x="-7" y="5" width="4" height="6" rx="2" fill="#a89b8b"/>
      <rect x="3" y="5" width="4" height="6" rx="2" fill="#a89b8b"/>
    </g>`;
}
function dune(cx, cy, c) {
  return `<g opacity=".7">
      <path d="M${cx - 50},${cy + 6} q25,-16 50,0 q25,16 50,0" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>
      <path d="M${cx - 40},${cy + 28} q22,-14 44,0" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"/>
      <path d="M${cx - 34},${cy - 20} q20,-13 40,0" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"/>
    </g>`;
}
function waves(cx, cy, c) {
  return `<g opacity=".45" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round">
      <path d="M${cx - 42},${cy - 14} q14,-10 28,0 q14,10 28,0"/>
      <path d="M${cx - 50},${cy + 10} q14,-10 28,0 q14,10 28,0"/>
      <path d="M${cx - 30},${cy + 32} q14,-10 28,0"/>
    </g>`;
}

function decorate(kind, cx, cy) {
  const t = TERRAIN[kind];
  switch (kind) {
    case "forest":
      return tree(cx - 40, cy + 14, 1.05, t.deco) + tree(cx + 6, cy + 30, 1.2, t.deco) +
             tree(cx + 42, cy + 2, 0.95, t.deco) + tree(cx - 8, cy - 18, 0.85, t.deco);
    case "pasture":
      return sheep(cx - 26, cy - 8, t.deco2) + sheep(cx + 24, cy + 22, t.deco2) +
             tree(cx + 34, cy - 22, 0.62, t.deco);
    case "field":
      return stripes(cx, cy, t.deco);
    case "hills":
      return bricks(cx, cy, t.deco);
    case "mountain":
      return peak(cx - 26, cy + 26, 1.0, t.deco, t.deco2) + peak(cx + 28, cy + 14, 0.8, t.deco, t.deco2);
    case "desert":
      return dune(cx, cy, t.deco);
    case "ocean":
      return waves(cx, cy, t.deco2);
  }
  return "";
}

// ---- number token (cream disc, serif numeral, probability pips) ----------
function token(cx, cy, n) {
  const hot = n === 6 || n === 8;
  const pipCount = 6 - Math.abs(7 - n);
  let pips = "";
  for (let i = 0; i < pipCount; i++) {
    const px = cx - (pipCount - 1) * 4.5 + i * 9;
    pips += `<circle cx="${px.toFixed(1)}" cy="${cy + 22}" r="2.8" fill="${hot ? "#c2452f" : "#6b5535"}"/>`;
  }
  return `<g>
      <ellipse cx="${cx}" cy="${cy + 10}" rx="40" ry="38" fill="#000" opacity=".22"/>
      <circle cx="${cx}" cy="${cy + 4}" r="39" fill="#c8b48c"/>
      <circle cx="${cx}" cy="${cy}" r="39" fill="#f6ead0"/>
      <circle cx="${cx}" cy="${cy}" r="39" fill="none" stroke="#b09a6e" stroke-width="3"/>
      <circle cx="${cx}" cy="${cy - 5}" r="31" fill="#fff" opacity=".35"/>
      <text x="${cx}" y="${cy + 7}" text-anchor="middle"
            font-family="Georgia, 'Times New Roman', serif" font-size="38" font-weight="700"
            fill="${hot ? "#c2452f" : "#5c482c"}">${n}</text>
      ${pips}
    </g>`;
}

// ---- one extruded tile ---------------------------------------------------
let clipSeq = 0;
function tile(cx, cy, kind, num) {
  const t = TERRAIN[kind];
  const top = hexPts(cx, cy, R - 4);
  const bot = hexPts(cx, cy + DEPTH, R - 4);
  const inner = hexPts(cx, cy, R - 20);
  const cid = `c${clipSeq++}`;

  // silhouette of the extruded side: lower hex + the two lower faces
  const side = `<polygon points="${poly(bot)}" fill="${t.side}"/>
    <polygon points="${poly([top[2], top[3], top[4], bot[4], bot[3], bot[2]])}" fill="${t.edge}"/>`;

  return `<g class="tile">
    <clipPath id="${cid}"><polygon points="${poly(hexPts(cx, cy, R - 7))}"/></clipPath>
    ${side}
    <polygon points="${poly(top)}" fill="${t.top}" stroke="${t.edge}" stroke-width="5" stroke-linejoin="round"/>
    <g clip-path="url(#${cid})">
      <polygon points="${poly(inner)}" fill="#fff" opacity=".10"/>
      ${decorate(kind, cx, cy)}
    </g>
    <polygon points="${poly(top)}" fill="url(#bevel)" opacity=".5" pointer-events="none"/>
    ${num ? token(cx, cy, num) : ""}
  </g>`;
}

// ---- board composition ---------------------------------------------------
const LAND = [
  ["mountain", 10], ["pasture", 2], ["forest", 9],
  ["field", 12], ["hills", 6], ["pasture", 4], ["hills", 10],
  ["field", 9], ["forest", 11], ["desert", 0], ["mountain", 3], ["forest", 8],
  ["hills", 8], ["mountain", 4], ["pasture", 5], ["field", 5],
  ["forest", 6], ["field", 3], ["pasture", 11],
];

const cells = [];
for (let r = -2; r <= 2; r++) {
  for (let q = -2; q <= 2; q++) {
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 2) cells.push([q, r]);
  }
}
cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

let body = "";

// outer ocean ring (radius 3)
for (let r = -3; r <= 3; r++) {
  for (let q = -3; q <= 3; q++) {
    const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    if (d !== 3) continue;
    const { x, y } = axial(q, r);
    body += tile(x, y, "ocean", 0);
  }
}
// land
cells.forEach(([q, r], i) => {
  const { x, y } = axial(q, r);
  const [kind, num] = LAND[i];
  body += tile(x, y, kind, num);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}" width="${VB_W}" height="${VB_H}">
  <defs>
    <linearGradient id="bevel" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".22"/>
    </linearGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
    </filter>
    <radialGradient id="tablelight" cx="50%" cy="34%" r="72%">
      <stop offset="0" stop-color="#ffe9c0" stop-opacity=".30"/>
      <stop offset="1" stop-color="#3a2413" stop-opacity=".38"/>
    </radialGradient>
  </defs>
  <rect width="${VB_W}" height="${VB_H}" fill="#2f6f9e"/>
  <g>${body}</g>
  <rect width="${VB_W}" height="${VB_H}" fill="url(#tablelight)"/>
  <rect width="${VB_W}" height="${VB_H}" filter="url(#grain)" opacity=".05"/>
</svg>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);
console.log("wrote", OUT, svg.length, "bytes");
