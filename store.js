// Storage abstraction: Firebase RTDB (Admin SDK) in production, in-memory for tests.
const norm = (p) => String(p).replace(/^\/+|\/+$/g, '');
export function rtdbStore(db) {
  const r = (p) => db.ref(norm(p));
  return {
    async get(p) { const s = await r(p).get(); return s.exists() ? s.val() : null; },
    set: (p, v) => r(p).set(v),
    update: (p, v) => r(p).update(v),
    remove: (p) => r(p).remove(),
    async transaction(p, fn) { const res = await r(p).transaction((cur) => fn(cur)); return { committed: res.committed, value: res.snapshot.val() }; },
    async queryEqual(p, child, value) {
      const s = await r(p).orderByChild(child).equalTo(value).limitToFirst(5).get();
      const out = []; s.forEach((c) => { out.push({ key: c.key, ...c.val() }); }); return out;
    },
  };
}
export function memoryStore(seed = {}) {
  const root = JSON.parse(JSON.stringify(seed));
  const parts = (p) => norm(p).split('/').filter(Boolean);
  const getNode = (p) => { let n = root; for (const k of parts(p)) { if (n == null || typeof n !== 'object' || !(k in n)) return null; n = n[k]; } return n ?? null; };
  const setNode = (p, v) => {
    const ks = parts(p); if (!ks.length) throw new Error('root-write');
    let n = root; for (const k of ks.slice(0, -1)) { if (typeof n[k] !== 'object' || n[k] === null) n[k] = {}; n = n[k]; }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete n[last]; else n[last] = JSON.parse(JSON.stringify(v));
    for (let i = ks.length - 1; i > 0; i--) { const pp = ks.slice(0, i).join('/'); const pn = getNode(pp); if (pn && typeof pn === 'object' && !Object.keys(pn).length) setNode(pp, null); else break; }
  };
  return {
    async get(p) { const v = getNode(p); return v == null ? null : JSON.parse(JSON.stringify(v)); },
    async set(p, v) { setNode(p, v); },
    async update(p, v) { for (const [k, x] of Object.entries(v)) setNode(norm(p) + '/' + k, x); },
    async remove(p) { setNode(p, null); },
    async transaction(p, fn) {
      const cur = getNode(p); const next = fn(cur == null ? null : JSON.parse(JSON.stringify(cur)));
      if (next === undefined) return { committed: false, value: cur }; setNode(p, next); return { committed: true, value: next };
    },
    async queryEqual(p, child, value) {
      const n = getNode(p) || {}; return Object.entries(n).filter(([, v]) => v && v[child] === value).slice(0, 5).map(([key, v]) => ({ key, ...v }));
    },
    _root: root,
  };
}
