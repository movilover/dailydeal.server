// CJ মডিউল টেস্ট — আপনার আসল buildApp (helmet, CORS, অরিজিন-চেক, ফ্লাড-গার্ড) + memoryStore + নকল CJ সার্ভার। চালান: npm run test:cj
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { memoryStore } from './store.js';
import { mountCj } from './route-cj.js';
import { computePrice } from './cj-core.js';

const ORIGIN = 'https://shop.github.io';
let tokenCalls = 0;
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const ok = (d) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, result: true, message: 'Success', data: d })); };
    const p = u.pathname;
    if (p.endsWith('/authentication/getAccessToken')) { tokenCalls++; return ok({ accessToken: 'tok1', accessTokenExpiryDate: new Date(Date.now() + 15 * 864e5).toISOString(), refreshToken: 'r', refreshTokenExpiryDate: new Date(Date.now() + 180 * 864e5).toISOString() }); }
    if (req.headers['cj-access-token'] !== 'tok1') { res.statusCode = 401; return res.end('{"code":1600001,"result":false,"message":"bad token"}'); }
    if (p.endsWith('/setting/get')) return ok({ quotaLimits: [] });
    if (p.endsWith('/product/getCategory')) return ok([{ categoryFirstName: 'Home', categoryFirstList: [{ categorySecondName: 'Kitchen', categorySecondList: [{ categoryId: 'C1', categoryName: 'Gadgets' }] }] }]);
    if (p.endsWith('/product/list')) return ok({ total: 2, list: [{ pid: 'P1', productNameEn: 'Lamp', productSku: 'CJ-1', productImage: 'http://i/1.jpg', sellPrice: '10.00 -- 12.00', categoryId: 'C1' }, { pid: 'P2', productNameEn: 'Mug', productSku: 'CJ-2', productImage: '["https://i/2.jpg"]', sellPrice: 4, categoryId: 'C1' }] });
    if (p.endsWith('/product/query')) return ok({ pid: u.searchParams.get('pid'), productNameEn: 'Lamp', productSku: 'CJ-1', productImage: 'https://i/1.jpg', description: '<p>hi</p><script>alert(1)</script><br>there', sellPrice: '10', categoryId: 'C1', variants: [{ vid: 'V1', variantSku: 'CJ-1-BK-L', variantNameEn: 'Black L', variantKey: 'Black-L', variantSellPrice: 10 }, { vid: 'V2', variantSku: 'CJ-1-WH-L', variantNameEn: 'White L', variantKey: 'White-L', variantSellPrice: 12 }] });
    if (p.endsWith('/getInventoryByPid')) return ok({ variantInventories: [{ vid: 'V1', inventory: [{ totalInventory: 30 }] }, { vid: 'V2', inventory: [{ totalInventory: 5 }] }] });
    if (p.endsWith('/freightCalculate')) return ok([{ logisticName: 'CJPacket', logisticPrice: 3.2, logisticAging: '7-12' }]);
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => mock.listen(0, r));

const env = { FIREBASE_SERVICE_ACCOUNT_B64: 'x', FIREBASE_DATABASE_URL: 'https://x-default-rtdb.firebaseio.com', ADMIN_EMAIL: 'admin@shop.com', ALLOWED_ORIGINS: ORIGIN + '/', CONFIG_ENC_KEY: 'k'.repeat(40), OTP_HMAC_SECRET: 'h'.repeat(30),
  CJ_API_KEY: 'CJ@api@secret', CJ_BASE_URL: `http://127.0.0.1:${mock.address().port}/api2.0/v1`, CJ_MIN_GAP_MS: '2' };
const cfg = loadConfig(env);
const store = memoryStore({ products: { old: { productId: 41, name: 'existing', price: 5 } } });
const adminAuth = { verifyIdToken: async (t) => { if (t === 'admin-token') return { uid: 'a', email: 'admin@shop.com' }; if (t === 'user-token') return { uid: 'u', email: 'cust@x.com' }; throw new Error('bad'); }, setCustomUserClaims: async () => {} };
let seq = 0; const newKey = () => '-Nkey' + String(++seq).padStart(4, '0');
const { app } = buildApp({ cfg, store, adminAuth, appCheck: { verifyToken: async () => ({}) }, extra: (a) => mountCj(a, { auth: createAuth({ adminAuth, appCheck: {}, cfg }), store, newKey, env }) });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const H = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json', Origin: ORIGIN };
const api = async (m, p, b, h = H) => { const r = await fetch(base + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})), r }; };
const CJ = '/api/admin/cj';

test('বিদ্যমান রুট অক্ষত: CJ ছাড়া আসল অ্যাপের সাথে হুবহু একই উত্তর (স্ট্যাটাস + কোড)', async () => {
  const { app: plain } = buildApp({ cfg, store: memoryStore(), adminAuth, appCheck: { verifyToken: async () => ({}) } });   // CJ মাউন্ট ছাড়া = আগের অ্যাপ
  const s2 = plain.listen(0); const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    for (const [m, p, h] of [['GET', '/healthz', { Origin: ORIGIN }], ['GET', '/admin/otp/config', { Origin: ORIGIN }], ['GET', '/admin/otp/config', H], ['GET', '/nope', { Origin: ORIGIN }], ['POST', '/otp/send', { Origin: ORIGIN, 'Content-Type': 'application/json' }], ['GET', '/api/referral/health', { Origin: ORIGIN }], ['GET', '/x', { Origin: 'https://evil.com' }]]) {
      const a = await fetch(base + p, { method: m, headers: h }), c = await fetch(b2 + p, { method: m, headers: h });
      const ja = await a.json().catch(() => ({})), jc = await c.json().catch(() => ({}));
      assert.equal(a.status, c.status, `${m} ${p} status`); assert.equal(ja.code ?? ja.ok, jc.code ?? jc.ok, `${m} ${p} code`);
    }
  } finally { s2.close(); }
});
test('/ping: 204, অথ/ডাটাবেস লাগে না', async () => { const r = await fetch(base + '/ping'); assert.equal(r.status, 204); assert.equal(r.headers.get('cache-control'), 'no-store'); });
test('অথ: টোকেন নেই→401, সাধারণ ইউজার→403, ভুল অরিজিন→403', async () => {
  assert.equal((await api('GET', CJ + '/status', null, { Origin: ORIGIN })).s, 401);
  assert.equal((await api('GET', CJ + '/status', null, { ...H, Authorization: 'Bearer user-token' })).s, 403);
  assert.equal((await api('GET', CJ + '/status', null, { ...H, Origin: 'https://evil.com' })).s, 403);
});
test('CORS: অনুমোদিত অরিজিনে PATCH preflight চলে', async () => {
  const r = await fetch(base + CJ + '/delivery-requests/DDW-ABC', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.match(r.headers.get('access-control-allow-methods') || '', /PATCH/);
});
test('CJ টোকেন একবারই আনা হয় (ক্যাশ), স্ট্যাটাস/টেস্ট/ক্যাটাগরি', async () => {
  assert.equal((await api('GET', CJ + '/status')).j.keyConfigured, true);
  assert.equal((await api('POST', CJ + '/test')).s, 200);
  assert.equal((await api('POST', CJ + '/categories/sync')).j.count, 3);
  await api('GET', CJ + '/categories'); assert.equal(tokenCalls, 1);
  assert.equal((await store.get('serverState/cj/token')).access, 'tok1');                         // সার্ভার-অনলি পাথে সংরক্ষিত
});
test('প্রাইসিং: গ্লোবাল %, ফিক্সড+এক্সট্রা, অগ্রাধিকার প্রোডাক্ট>ক্যাটাগরি>গ্লোবাল', async () => {
  await api('PUT', CJ + '/settings', { fx: { mode: 'manual', manualRate: 100, currency: 'BDT' }, pricing: { global: { mode: 'percent', value: 30 }, rounding: 'integer', compareAtPct: 0, extraFixed: 0, extraPct: 0 } });
  assert.equal((await api('POST', CJ + '/pricing/preview', { costUsd: 10 })).j.price, 1300);
  await api('PUT', CJ + '/settings', { pricing: { global: { mode: 'fixed', value: 500 }, extraFixed: 50, extraPct: 5 } });
  assert.equal((await api('POST', CJ + '/pricing/preview', { costUsd: 10 })).j.price, 1600);
  await api('PUT', CJ + '/settings', { pricing: { global: { mode: 'percent', value: 10 }, extraFixed: 0, extraPct: 0 } });
  await api('PUT', CJ + '/rules/categories/C1', { rule: { mode: 'percent', value: 20 } });
  let r = (await api('POST', CJ + '/pricing/preview', { costUsd: 10, categoryId: 'C1', pid: 'P1' })).j; assert.deepEqual([r.price, r.ruleSource], [1200, 'category']);
  await api('PUT', CJ + '/rules/products/P1', { rule: { mode: 'fixed', value: 700 } });
  r = (await api('POST', CJ + '/pricing/preview', { costUsd: 10, categoryId: 'C1', pid: 'P1' })).j; assert.deepEqual([r.price, r.ruleSource], [1700, 'product']);
  r = (await api('POST', CJ + '/pricing/preview', { costUsd: 10, categoryId: 'Z', pid: 'X' })).j; assert.deepEqual([r.price, r.ruleSource], [1100, 'global']);
  assert.equal((await api('PUT', CJ + '/rules/products/P9', { rule: { mode: 'percent', value: -5 } })).s, 400);
  assert.equal(computePrice({ costUsd: 4, fx: 100, settings: { pricing: { global: { mode: 'percent', value: 50 }, extraFixed: 0, extraPct: 0, rounding: 'integer', compareAtPct: 0 } }, rules: { categories: {}, products: {} } }).price, 600);
});
test('তালিকা: নরমালাইজড, দাম সহ; ডিটেইল: ভ্যারিয়েন্ট+স্টক; শিপিং রেট', async () => {
  const l = (await api('GET', CJ + '/products?categoryId=C1&inStock=1&minPrice=1')).j;
  assert.equal(l.list[0].priceMin, 10); assert.equal(l.list[0].priceMax, 12); assert.ok(l.list[0].image.startsWith('https://')); assert.equal(l.list[1].image, 'https://i/2.jpg'); assert.equal(l.list[0].imported, false);
  const d = (await api('GET', CJ + '/products/P1')).j; assert.equal(d.stockTotal, 35); assert.equal(d.product.variants[1].stock, 5);
  assert.equal((await api('POST', CJ + '/shipping/estimate', { vid: 'V1', quantity: 2, country: 'AE' })).j.options[0].priceUsd, 3.2);
});
test('ইমপোর্ট: ক্যাটাগরি ছাড়া ব্যর্থ; ড্রাফট সেভ বিদ্যমান স্কিমায়; ডুপ্লিকেট PID/SKU বাদ; পুরোনো প্রোডাক্ট অক্ষত', async () => {
  assert.equal((await api('POST', CJ + '/import', { items: [{ pid: 'P1' }] })).j.failed.length, 1);
  const r = (await api('POST', CJ + '/import', { items: [{ pid: 'P1', intlCat: 'Home', intlSub: 'Kitchen', delivery: { mode: 'confirm' } }] })).j;
  assert.equal(r.done.length, 1, JSON.stringify(r)); const p = await store.get('products/' + r.done[0].key);
  assert.equal(p.active, false); assert.equal(p.intl, true); assert.equal(p.productId, 42); assert.equal(p.price, 1700); assert.equal(p.source.supplierProductId, 'P1');
  assert.equal(p.deliveryConfirm, true); assert.deepEqual(p.colors, ['Black', 'White']); assert.equal(p.stock, 35); assert.equal(p.desc, 'hi\n\nthere');
  assert.equal(r.done[0].key.startsWith('-Nkey'), true);
  assert.equal((await api('POST', CJ + '/import', { items: [{ pid: 'P1', intlCat: 'Home' }] })).j.skipped.length, 1);
  assert.match((await api('POST', CJ + '/import', { items: [{ pid: 'P7', intlCat: 'Home' }] })).j.skipped[0].reason, /SKU/);
  assert.equal((await store.get('products/old')).name, 'existing');
  assert.ok((await api('GET', CJ + '/history')).j.list.some((x) => x.type === 'import'));
});
test('সিঙ্ক: নিজে বদলানো দাম নীরবে বদলায় না → পেন্ডিং, অ্যাপ্রুভাল লাগে', async () => {
  const key = Object.keys(await store.get('products')).find((k) => k !== 'old');
  await store.update('products/' + key, { price: 2222 }); const cur = await store.get('products/' + key); await store.update('products/' + key, { pricing: { ...cur.pricing, costUsd: 8 } });
  await api('PUT', CJ + '/settings', { sync: { autoPrice: true, autoStock: false, intervalHours: 12, defaultStockIfUnknown: 50 } });
  const r = (await api('POST', CJ + '/sync/run')).j; assert.equal(r.priceApplied, 0); assert.equal(r.pending, 1); assert.equal((await store.get('products/' + key)).price, 2222);
  const s = (await api('GET', CJ + '/sync')).j; assert.equal(s.pending[key].custom, true);
  await api('POST', CJ + '/sync/apply', { keys: [key], useSuggested: false }); assert.equal((await store.get('products/' + key)).price, 2222);   // "আমার দাম রাখো"
});
test('পাবলিক: ডেলিভারি রিকোয়েস্ট ভ্যালিডেটেড+স্যানিটাইজড; অ্যাডমিন দেখে/স্ট্যাটাস বদলায়; শুধু WhatsApp নম্বর প্রকাশ', async () => {
  const PUB = { 'Content-Type': 'application/json', Origin: ORIGIN };
  assert.equal((await api('POST', '/api/public/delivery-request', { name: 'x' }, PUB)).s, 400);
  const r = (await api('POST', '/api/public/delivery-request', { name: '<img src=x onerror=alert(1)>Ali', phone: '+97150000', country: 'UAE', address: 'Dubai <script>x</script>', items: [{ name: '<b>Lamp</b>', qty: 1, price: 5 }] }, PUB)).j;
  assert.match(r.ref, /^DDW-/); assert.ok(!/[<>]/.test(JSON.stringify(await store.get('serverState/cj/deliveryRequests/' + r.ref))));
  const l = (await api('GET', CJ + '/delivery-requests')).j.list; assert.equal(l.length, 1);
  assert.equal((await api('PATCH', CJ + '/delivery-requests/' + r.ref, { status: 'quoted' })).s, 200); assert.equal((await api('PATCH', CJ + '/delivery-requests/' + r.ref, { status: 'hax' })).s, 400);
  await api('PUT', CJ + '/settings', { delivery: { whatsapp: '+971 50 123 4567' } });
  assert.deepEqual(Object.keys((await api('GET', '/api/public/config', null, PUB)).j).sort(), ['ok', 'whatsapp']);
});
test('রিকোয়েস্ট গার্ড: text/plain বডি → 415; ভুল অরিজিনের POST → 403', async () => {
  const r = await fetch(base + '/api/public/delivery-request', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: ORIGIN }, body: '{"name":"x"}' }); assert.equal(r.status, 415);
  assert.equal((await api('POST', '/api/public/delivery-request', { name: 'x' }, { 'Content-Type': 'application/json', Origin: 'https://evil.com' })).s, 403);
});
test('ডেটা শুধু serverState/cj এ — ক্লায়েন্ট-দৃশ্য টপ-লেভেল নোডে কোনো CJ সেটিংস/টোকেন নেই', async () => {
  const top = Object.keys(store._root); for (const k of ['cjSettings', 'cjRules', 'cjSync', 'cjImportLog', 'deliveryRequests', '_server']) assert.ok(!top.includes(k), k);
  assert.ok(await store.get('serverState/cj/settings'));
});
test.after(() => { srv.close(); mock.close(); });
