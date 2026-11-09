// Caching for public static assets — and only those.
//
// Each release gets an asset version: a hash over every public JS/CSS file's
// path, size and modification time. HTML pages are served with their local
// script/stylesheet URLs rewritten to `?v=<version>`, plus an import map that
// pins every ES module (including dynamic `import("./auth.js")`) to the same
// version. A page therefore always loads one consistent set of modules: an
// old helper and a new client can never be mixed, and a new release changes
// every URL at once.
//
//   ?v=<current version>     public, one year, immutable
//   other public assets      no-cache + ETag (revalidate; 304 when unchanged)
//   HTML                     no-cache; no-store when it carries ?code/?token
//   everything else          no-store (APIs, config, login responses)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_ASSET_EXT = new Set([
  '.js', '.css', '.svg', '.png', '.ico', '.woff2', '.woff', '.ttf',
]);
const VERSIONED_EXT = new Set(['.js', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'server', 'tests', '.git', '.claude']);

function listVersionedFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || (dir === root && SKIP_DIRS.has(e.name))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (VERSIONED_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  })(root);
  return out.sort();
}

// Version of the current file set, recomputed at most every `ttlMs` so an
// edit on disk (git pull without restart) still produces a new version.
function createAssetVersioner(root, { ttlMs = 2000, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = -Infinity;
  return function current() {
    if (cached && now() - cachedAt < ttlMs) return cached;
    const files = listVersionedFiles(root);
    const h = crypto.createHash('sha256');
    for (const f of files) {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      h.update(`${path.relative(root, f)}\0${st.size}\0${st.mtimeMs}\n`);
    }
    cached = {
      version: h.digest('hex').slice(0, 12),
      modules: files
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.relative(root, f).split(path.sep).join('/')),
    };
    cachedAt = now();
    return cached;
  };
}

const isLocalRef = (ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref);

// Add ?v= to local <script src> / <link href> JS/CSS references and insert an
// import map for the module graph before the first module script.
function rewriteHtml(html, { version, modules }) {
  const withVersion = (ref) => {
    const clean = ref.split('#')[0];
    if (!isLocalRef(clean) || clean.includes('?')) return ref;
    if (!VERSIONED_EXT.has(path.extname(clean).toLowerCase())) return ref;
    return `${clean}?v=${version}`;
  };
  let out = html.replace(
    /(<script\b[^>]*\bsrc=")([^"]+)(")/gi,
    (_, a, ref, b) => a + withVersion(ref) + b
  );
  out = out.replace(
    /(<link\b[^>]*\brel="stylesheet"[^>]*\bhref=")([^"]+)(")/gi,
    (_, a, ref, b) => a + withVersion(ref) + b
  );
  const imports = {};
  for (const m of modules) imports[`./${m}`] = `./${m}?v=${version}`;
  const map = `<script type="importmap">${JSON.stringify({ imports })}</script>\n`;
  // an import map must precede every module script, so it goes in <head>
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `    ${map}</head>`);
  return out;
}

// Only the website itself is public. Everything else under the project root
// — .env (bridge secret, Firebase key), server/ (service-account.json and
// source), node_modules/, tests/, notes — is never served.
const PRIVATE_TOP = new Set(['server', 'node_modules', 'tests']);
function isPublicPath(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p.startsWith('.'))) return false;
  if (PRIVATE_TOP.has(parts[0])) return false;
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  return ext === '.html' || PUBLIC_ASSET_EXT.has(ext);
}

function etagFor(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

// Cache-Control for a static response.
//   ext          lower-case extension of the served file
//   query        URLSearchParams of the request
//   version      the current asset version
function cachePolicy(ext, query, version) {
  if (ext === '.html') {
    return query.has('code') || query.has('token') ? 'no-store' : 'no-cache';
  }
  if (!PUBLIC_ASSET_EXT.has(ext)) return 'no-store';
  if (VERSIONED_EXT.has(ext) && query.get('v') === version) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

module.exports = { createAssetVersioner, rewriteHtml, cachePolicy, etagFor, isPublicPath, PUBLIC_ASSET_EXT };
