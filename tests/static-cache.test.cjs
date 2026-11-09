const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetVersioner, rewriteHtml, cachePolicy, isPublicPath } = require('../server/static-cache.js');

const q = (s) => new URLSearchParams(s);

test('pages pin local scripts, styles and the module graph to one version', () => {
  const html = `<head>
<link rel="stylesheet" href="game.css">
<link rel="stylesheet" href="https://fonts.example/x.css">
</head><body>
<script type="module" src="face.js"></script>
<script src="js/video.js"></script>
<script src="https://cdn.example/lib.js"></script>
<script type="module" src="js/client.js"></script>
</body>`;
  const out = rewriteHtml(html, { version: 'abc123', modules: ['face.js', 'js/client.js', 'js/auth.js'] });
  assert.match(out, /href="game\.css\?v=abc123"/);
  assert.match(out, /src="face\.js\?v=abc123"/);
  assert.match(out, /src="js\/video\.js\?v=abc123"/);
  assert.match(out, /src="js\/client\.js\?v=abc123"/);
  assert.match(out, /href="https:\/\/fonts\.example\/x\.css"/, 'external untouched');
  assert.match(out, /src="https:\/\/cdn\.example\/lib\.js"/, 'external untouched');
  const map = JSON.parse(out.match(/<script type="importmap">(.*?)<\/script>/)[1]);
  assert.equal(map.imports['./js/auth.js'], './js/auth.js?v=abc123', 'dynamic imports versioned too');
  assert.ok(out.indexOf('importmap') < out.indexOf('type="module"'), 'import map precedes module scripts');
});

test('only versioned public assets are cached long-term', () => {
  const v = 'abc123';
  assert.equal(cachePolicy('.js', q('v=abc123'), v), 'public, max-age=31536000, immutable');
  assert.equal(cachePolicy('.css', q('v=abc123'), v), 'public, max-age=31536000, immutable');
  assert.equal(cachePolicy('.js', q('v=old'), v), 'no-cache', 'stale version revalidates');
  assert.equal(cachePolicy('.js', q(''), v), 'no-cache');
  assert.equal(cachePolicy('.woff2', q(''), v), 'no-cache');
  assert.equal(cachePolicy('.svg', q(''), v), 'no-cache');
  assert.equal(cachePolicy('.html', q('station=2'), v), 'no-cache');
  assert.equal(cachePolicy('.html', q('station=2&code=X'), v), 'no-store', 'login link never stored');
  assert.equal(cachePolicy('.html', q('token=X'), v), 'no-store');
  assert.equal(cachePolicy('.json', q('v=abc123'), v), 'no-store');
  assert.equal(cachePolicy('.env', q(''), v), 'no-store');
});

test('a changed file produces a new version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  fs.mkdirSync(path.join(root, 'js'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'js', 'a.js'), 'one');
  fs.writeFileSync(path.join(root, 'server', 'secret.js'), 'x');
  let clock = 0;
  const current = createAssetVersioner(root, { ttlMs: 10, now: () => clock });
  const v1 = current();
  assert.deepEqual(v1.modules, ['js/a.js'], 'server code is not public');
  fs.writeFileSync(path.join(root, 'js', 'a.js'), 'two!');
  assert.equal(current().version, v1.version, 'cached within ttl');
  clock = 100;
  assert.notEqual(current().version, v1.version);
  fs.rmSync(root, { recursive: true });
});

test('secrets, server code and notes are never public', () => {
  for (const p of ['.env', '.env.example', 'server/service-account.json', 'server/stub-server.js',
    'node_modules/firebase-admin/package.json', 'tests/x.cjs', '.git/config', 'js/.hidden.js',
    'bridge_brief.md', 'package.json', 'firestore.rules', '']) {
    assert.equal(isPublicPath(p), false, p);
  }
  for (const p of ['game.html', 'index.html', 'js/client.js', 'js/vendor/chess.js', 'game.css',
    'assets/fonts/Baloo2-600.woff2', 'assets/hexboard.svg', 'face.js']) {
    assert.equal(isPublicPath(p), true, p);
  }
});
