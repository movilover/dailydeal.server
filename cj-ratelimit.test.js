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
