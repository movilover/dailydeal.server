// CJ রেট-লিমিট সেফগার্ড টেস্ট (cj-core.js শুধু)। চালান: node --test cj-ratelimit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCj } from './cj-core.js';

function setup() {
  const db = {}; const store = { get: async (p) => db[p] ?? null, set: async (p, v) => { db[p] = v; }, update: async (p, v) => { db[p] = { ...(db[p] || {}), ...v }; }, remove: async (p) => { delete db[p]; } };
  const calls = { token: 0, list: 0 }; let mode = 'ok';
  const fetchImpl = async (url) => {
    const p = new URL(url).pathname, json = (o, status = 200) => ({ status, json: async () => o });
    if (p.endsWith('/getAccessToken')) { calls.token++; return json({ code: 200, result: true, data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 15 * 864e5).toISOString(), refreshToken: 'r', refreshTokenExpiryDate: new Date(Date.now() + 180 * 864e5).toISOString() } }); }
    if (p.endsWith('/product/list')) {
      calls.list++;
      if (mode === 'rl-msg') return json({ code: 1600999, result: false, message: 'Too Many Requests, one ip limit 3 users, Your Ip is 1.2.3.4' });
      if (mode === 'rl-429') return json({}, 429);
      return json({ code: 200, result: true, data: { total: 1, list: [{ pid: 'P1' }] } });
    }
    return json({}, 404);
  };
  const cj = createCj({ store, newKey: () => 'k', env: { CJ_API_KEY: 'k', CJ_MIN_GAP_MS: '1' }, fetchImpl, sleep: async () => {} });
  return { cj, calls, setMode: (m) => { mode = m; } };
}
const q = { query: { categoryId: 'C1' } };

test('একই লিস্ট রিকোয়েস্ট ক্যাশ থেকে আসে, CJ-তে একবারই যায়; একসাথে দুটো হলেও একটাই', async () => {
  const { cj, calls } = setup();
  await Promise.all([cj.cj('GET', '/product/list', q), cj.cj('GET', '/product/list', q)]);
  await cj.cj('GET', '/product/list', q);
  assert.equal(calls.list, 1); assert.equal(calls.token, 1);
});
test('মেসেজ দেখে লিমিট চেনে ("one ip limit"), ৩ বার রিট্রাই করে, তারপর 429 + কুলডাউন (দ্রুত ব্যর্থ, CJ-তে যায় না)', async () => {
  const { cj, calls, setMode } = setup(); setMode('rl-msg');
  await assert.rejects(() => cj.cj('GET', '/product/list', q), (e) => e.status === 429 && /Too Many/.test(e.message));
  assert.equal(calls.list, 4);
  await assert.rejects(() => cj.cj('GET', '/product/list', { query: { categoryId: 'C2' } }), (e) => e.status === 429);
  assert.equal(calls.list, 4, 'কুলডাউনে CJ-তে নতুন কল যায়নি');
});
test('HTTP 429-ও লিমিট হিসেবে ধরা হয়', async () => {
  const { cj, calls, setMode } = setup(); setMode('rl-429');
  await assert.rejects(() => cj.cj('GET', '/product/list', q), (e) => e.status === 429); assert.equal(calls.list, 4);
});
test('লিমিট ধরলে আগের সফল ডাটা (stale) ফেরত আসে, এরর নয়', async () => {
  const { cj, setMode } = setup();
  const first = await cj.cj('GET', '/product/list', q); setMode('rl-msg');
  const again = await cj.cj('GET', '/product/list', { ...q, fresh: true });
  assert.deepEqual(again, first);
});

/* ───── নতুন: Firebase-ক্যাশ + অটো-ইমপোর্ট কিউ ───── */
function setup2(opts = {}) {
  const db = {}; const store = { get: async (p) => { const parts = p.split('/'); let c = db; for (const k of parts) { c = c && c[k]; } return c === undefined ? null : c; },
    set: async (p, v) => { const parts = p.split('/'); let c = db; parts.slice(0, -1).forEach((k) => { c[k] = c[k] || {}; c = c[k]; }); c[parts.at(-1)] = JSON.parse(JSON.stringify(v)); },
    update: async (p, v) => { const cur = (await store.get(p)) || {}; await store.set(p, { ...cur, ...v }); },
    remove: async (p) => { const parts = p.split('/'); let c = db; for (const k of parts.slice(0, -1)) { c = c && c[k]; if (!c) return; } delete c[parts.at(-1)]; } };
  const calls = { list: 0, query: 0 }; let blocked = false; let seq = 0;
  const fetchImpl = async (url) => {
    const p = new URL(url).pathname, json = (o, status = 200) => ({ status, json: async () => o });
    if (String(url).includes('er-api.com')) return json({ result: 'success', rates: { BDT: 120 } });
    if (p.endsWith('/getAccessToken')) return json({ code: 200, result: true, data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 15 * 864e5).toISOString(), refreshToken: 'r', refreshTokenExpiryDate: new Date(Date.now() + 180 * 864e5).toISOString() } });
    if (p.endsWith('/product/list')) { calls.list++; if (blocked) return json({ code: 1600201, result: false, message: 'Too Many Requests, one ip limit 3 users' }); return json({ code: 200, result: true, data: { total: 1, list: [{ pid: 'P1' }] } }); }
    if (p.endsWith('/product/query')) { calls.query++; if (blocked) return json({ code: 1600201, result: false, message: 'Too Many Requests, one ip limit 3 users' }); return json({ code: 200, result: true, data: { pid: 'P1', productNameEn: 'Lamp', productSku: 'CJ-1', productImage: 'https://i/1.jpg', sellPrice: '10', categoryId: 'C1', variants: [{ vid: 'V1', variantSku: 'CJ-1-A', variantNameEn: 'A', variantKey: 'A', variantSellPrice: 10 }] } }); }
    if (p.endsWith('/getInventoryByPid')) return json({ code: 200, result: true, data: { variantInventories: [{ vid: 'V1', inventory: [{ totalInventory: 9 }] }] } });
    return json({}, 404);
  };
  const env = { CJ_API_KEY: 'k', CJ_MIN_GAP_MS: '1', ...(opts.env || {}) };
  const cj = createCj({ store, newKey: () => 'key' + (++seq), env, fetchImpl, sleep: async () => {} });
  return { cj, calls, store, db, setBlocked: (b) => { blocked = b; } };
}
test('Firebase-ক্যাশ: সার্ভার রিস্টার্ট (নতুন createCj) হলেও আগের লিস্ট CJ-তে না গিয়ে আসে; লিমিটে পুরোনো ডাটা আসে', async () => {
  const a = setup2(); await a.cj.cj('GET', '/product/list', q); assert.equal(a.calls.list, 1);
  await new Promise((r) => setTimeout(r, 20));                                   // পেছনের write শেষ হতে দিন
  const fetchImpl2 = async () => { throw new Error('CJ-তে যাওয়া উচিত না'); };
  const b = createCj({ store: a.store, newKey: () => 'k', env: { CJ_API_KEY: 'k', CJ_MIN_GAP_MS: '1' }, fetchImpl: fetchImpl2, sleep: async () => {} });
  const r = await b.cj('GET', '/product/list', q); assert.equal(r.total, 1);
  const hk = Object.keys(a.db.serverState.cj.cache); assert.equal(hk.length, 1);
});
test('ইমপোর্টের সময় CJ লিমিট → কিউতে যায় (failed না); লিমিট কাটলে processQueue নিজে ইমপোর্ট করে', async () => {
  const t = setup2(); t.setBlocked(true);
  const r = await t.cj.runImport([{ pid: 'P1', intlCat: 'Home' }], 'admin');
  assert.equal(r.queued.length, 1); assert.equal(r.failed.length, 0); assert.equal((await t.cj.queueList()).length, 1);
  t.setBlocked(false);
  const q1 = await t.cj.processQueue(); assert.equal(q1.waiting, true);        // কুলডাউন চলছে
  await new Promise((res) => setTimeout(res, 20));
  // কুলডাউন পার করতে ঘড়ি এগিয়ে দিই
  const realNow = Date.now; Date.now = () => realNow() + 30000;
  try { const q2 = await t.cj.processQueue(); assert.equal(q2.processed, 1); assert.equal(q2.remaining, 0); } finally { Date.now = realNow; }
  assert.equal(Object.values(t.db.products || {}).length, 1);
});
