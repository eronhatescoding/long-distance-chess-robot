// Minimal in-memory Firestore for tests: documents, equality queries and
// optimistic transactions. A transaction records the version of every
// document (and every queried collection) it reads; at commit, any change
// since then aborts and retries it — the conflict behaviour that makes
// read-then-write races safe in real Firestore. Every operation yields to
// the event loop, so concurrent transactions genuinely interleave.
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const SERVER_TS = Symbol('serverTimestamp');

class Timestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  toMillis() { return this.ms; }
}

const FieldValue = { serverTimestamp: () => SERVER_TS };

function createFakeFirestore({ now = Date.now } = {}) {
  const docs = new Map(); // "col/id" -> { data, version }
  const colVersions = new Map(); // col -> version (bumped on any write)
  let autoId = 0;
  const stats = { commits: 0, retries: 0 };

  const clone = (v) => (v == null ? v : structuredCloneData(v));
  function structuredCloneData(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = v;
    return out;
  }
  const resolve = (data) => {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? Timestamp.fromMillis(now()) : v;
    return out;
  };
  const snapOf = (ref) => {
    const e = docs.get(ref.path);
    return { exists: !!e, id: ref.id, ref, data: () => clone(e && e.data) };
  };
  function bump(col) { colVersions.set(col, (colVersions.get(col) || 0) + 1); }
  function write(ref, kind, data) {
    const e = docs.get(ref.path);
    if (kind === 'create' && e) throw new Error(`ALREADY_EXISTS: ${ref.path}`);
    if (kind === 'update' && !e) throw new Error(`NOT_FOUND: ${ref.path}`);
    const next = kind === 'update' ? { ...e.data, ...resolve(data) } : resolve(data);
    docs.set(ref.path, { data: next, version: (e ? e.version : 0) + 1 });
    bump(ref.col);
  }

  function docRef(col, id) {
    const ref = {
      col, id, path: `${col}/${id}`,
      async get() { await tick(); return snapOf(ref); },
      async set(data) { await tick(); write(ref, 'set', data); },
      async update(data) { await tick(); write(ref, 'update', data); },
    };
    return ref;
  }

  function query(col, filters, lim) {
    const run = () => {
      const hits = [];
      for (const [p, e] of docs) {
        if (!p.startsWith(col + '/')) continue;
        if (filters.every(([f, v]) => e.data[f] === v)) hits.push(snapOf(docRef(col, p.slice(col.length + 1))));
        if (lim && hits.length >= lim) break;
      }
      return { empty: hits.length === 0, docs: hits };
    };
    return {
      isQuery: true, col,
      where: (f, op, v) => query(col, [...filters, [f, v]], lim),
      limit: (n) => query(col, filters, n),
      async get() { await tick(); return run(); },
      run,
    };
  }

  const db = {
    collection(col) {
      return {
        doc: (id) => docRef(col, id == null ? `auto${++autoId}` : String(id)),
        where: (f, op, v) => query(col, [[f, v]], 0),
        async add(data) { const ref = docRef(col, `auto${++autoId}`); await ref.set(data); return ref; },
      };
    },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const reads = new Map(); // key -> version
        const writes = [];
        const t = {
          async get(target) {
            await tick();
            if (target.isQuery) {
              reads.set(`col:${target.col}`, colVersions.get(target.col) || 0);
              const res = target.run();
              for (const d of res.docs) reads.set(d.ref.path, docs.get(d.ref.path).version);
              return res;
            }
            const e = docs.get(target.path);
            reads.set(target.path, e ? e.version : 0);
            return snapOf(target);
          },
          set(ref, data) { writes.push([ref, 'set', data]); return t; },
          create(ref, data) { writes.push([ref, 'create', data]); return t; },
          update(ref, data) { writes.push([ref, 'update', data]); return t; },
        };
        const result = await fn(t);
        await tick();
        // commit atomically (no await below): validate every read, then write
        let stale = false;
        for (const [key, ver] of reads) {
          const cur = key.startsWith('col:')
            ? colVersions.get(key.slice(4)) || 0
            : (docs.get(key) ? docs.get(key).version : 0);
          if (cur !== ver) { stale = true; break; }
        }
        if (stale) { stats.retries++; continue; }
        for (const [ref, kind, data] of writes) write(ref, kind, data);
        stats.commits++;
        return result;
      }
      throw new Error('transaction retried too often');
    },
    _docs: docs,
    _stats: stats,
  };
  return db;
}

module.exports = { createFakeFirestore, FieldValue, Timestamp };
