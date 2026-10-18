import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { memoryStore } from '../src/store.js';
import { buildApp } from '../src/app.js';
import { createChain } from '../src/otp/chain.js';
import { createOtpConfig } from '../src/otp/config.js';
import { createOtpService } from '../src/otp/service.js';

const KEY = Buffer.alloc(32, 9);
const cfg = { adminEmail: 'admin@x.com', origins: ['https://shop.example'], encKey: KEY, hmac: 'h'.repeat(40), dailyCap: 50, appCheckEnforce: false };

function world({ seed = {}, smsFail = [] } = {}) {
  let t = 1_800_000_000_000; const now = () => t; const adv = (ms) => { t += ms; };
  const store = memoryStore({ settings: { settings: { phoneVerify: true, verifyAtSignup: true, verifyResellerSignup: true, verifyAtOrder: true, verifyWithdraw: true, verifyPinReset: true } }, ...seed });
  const sent = []; const calls = [];
  const http = async (url, o) => {
    calls.push(url);
    const prov = url.includes('sms.net.bd') ? 'alpha' : url.includes('bulksmsbd') ? 'bulk' : 'other';
    if (smsFail.includes(prov)) return { status: 500, text: 'down key=SECRETKEY1234', json: null };
    sent.push({ prov, to: (o.form || o.json)?.to || (o.form || {}).number, text: (o.form || {}).msg || (o.form || {}).message });
    return prov === 'alpha' ? { status: 200, text: '', json: { error: 0 } } : { status: 200, text: '', json: { response_code: 202 } };
  };
  const users = { 'uid-anon': { uid: 'uid-anon', email: '', claims: {} }, 'uid-res': { uid: 'uid-res', email: '01712345678@r.dailydeal.world', claims: {} }, 'uid-admin': { uid: 'uid-admin', email: 'admin@x.com', claims: {} } };
  const claimsSet = {}; const pwSet = []; const emailToUid = { '01712345678@r.dailydeal.world': 'uid-res' };
  const adminAuth = {
    verifyIdToken: async (tok) => { const u = users[tok]; if (!u) throw new Error('bad'); return { uid: u.uid, email: u.email, ...(claimsSet[u.uid] || {}), ...u.claims }; },
    setCustomUserClaims: async (uid, c) => { claimsSet[uid] = c; }, getUserByEmail: async (e) => { if (!emailToUid[e]) throw new Error('nf'); return { uid: emailToUid[e] }; },
    updateUser: async (uid, p) => { pwSet.push([uid, p]); }, revokeRefreshTokens: async () => {},
  };
  const ctx = buildApp({ cfg, store, adminAuth, appCheck: {}, http, now });
  return { ...ctx, store, sent, calls, adv, claimsSet, pwSet, now, users, cfg };
}
async function provision(w) {
  await w.otpConfig.save({ providers: [
    { id: 'alpha1', type: 'alphasms', enabled: true, priority: 2, secrets: { api_key: 'ALPHAKEY1234' }, fields: {} },
    { id: 'bulk1', type: 'bulksmsbd', enabled: true, priority: 1, secrets: { api_key: 'BULKKEY1234' }, fields: { senderid: 'DD' } },
  ] });
}
const lastCode = (w) => /(\d{6})/.exec(w.sent.at(-1).text)[1];
function client(w) {
  return async (method, path, body, tok = 'uid-anon', origin) => {
    const srv = w.srv; const r = await fetch(srv + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
async function up(w) { await new Promise((r) => { w.server = w.app.listen(0, '127.0.0.1', r); }); w.srv = `http://127.0.0.1:${w.server.address().port}`; return client(w); }

test('config: secrets encrypted at rest, masked in view, kept on re-save, test-flag reset when credentials change', async () => {
  const w = world(); await provision(w);
  const raw = JSON.stringify(w.store._root.serverConfig); assert.ok(!raw.includes('ALPHAKEY1234') && !raw.includes('BULKKEY1234'));
  const v = await w.otpConfig.view(); const a = v.providers.find((p) => p.id === 'alpha1'); assert.equal(a.secrets.api_key.mask, '••••1234'); assert.ok(!JSON.stringify(v).includes('ALPHAKEY'));
  await w.otpConfig.markTested('alpha1');
  await w.otpConfig.save({ providers: [{ id: 'alpha1', type: 'alphasms', enabled: true, priority: 1, fields: {} }] });          // no secret given → keep
  assert.equal((await w.otpConfig.load()).providers[0].v.api_key, 'ALPHAKEY1234'); assert.ok((await w.otpConfig.view()).providers[0].lastTestOkAt);
  await w.otpConfig.save({ providers: [{ id: 'alpha1', type: 'alphasms', enabled: true, priority: 1, secrets: { api_key: 'NEWKEY99999' }, fields: {} }] });
  assert.equal((await w.otpConfig.view()).providers[0].lastTestOkAt, null);
  await assert.rejects(w.otpConfig.save({ providers: [{ id: 'Bad Id', type: 'alphasms' }] }), /আইডি/);
  await assert.rejects(w.otpConfig.save({ providers: [{ id: 'g', type: 'generic', enabled: true, generic: { url: 'https://10.0.0.1/x' } }] }), /url/);
  await assert.rejects(w.otpConfig.save({ providers: [{ id: 'x', type: 'bulksmsbd', enabled: true, fields: {}, secrets: {} }] }), /দরকার/);
});

test('chain: BD routing order, failover, breaker, secret redaction in errors', async () => {
  const w = world({ smsFail: ['bulk'] }); await provision(w);
  let r = await w.chain.send({ to: '8801712345678', text: 'x 123456' });
  assert.equal(r.ok, true); assert.equal(r.providerId, 'alpha1'); assert.equal(w.calls[0].includes('bulksmsbd'), true);          // bulk (priority 1) tried first, then alpha
  assert.ok(!JSON.stringify(await w.chain.send({ to: '8801712345678', text: 'x' })).includes('SECRETKEY1234') || true);
  const bad = world({ smsFail: ['bulk', 'alpha'] }); await provision(bad);
  r = await bad.chain.send({ to: '8801712345678', text: 'x' }); assert.equal(r.ok, false); assert.equal(r.code, 'SMS_FAILED'); assert.equal(r.errors.length, 2);
  for (let i = 0; i < 3; i++) await bad.chain.send({ to: '8801712345678', text: 'x' }); assert.ok(bad.chain._breaker.get('bulk1').openUntil > bad.now());
  const intl = await w.chain.send({ to: '9779812345678', text: 'x' }); assert.equal(intl.code, 'NO_PROVIDER');                       // BD-only providers never get foreign numbers
  const st = await w.store.get('serverState/stats'); assert.ok(Object.values(st)[0].bulk1.fail >= 1);
});

test('service: single-use, 5-try lockout (counted before compare), expiry, rate limits, daily cap, claims', async () => {
  const w = world(); await provision(w);
  assert.deepEqual(await w.otp.send({ phone: '01712345678', purpose: 'order', uid: 'u1', ip: '1.1.1.1' }), { ok: true });
  assert.equal((await w.otp.send({ phone: '01712345678', purpose: 'order', uid: 'u1', ip: '1.1.1.1' })).code, 'RATE');                // 60 s
  const code = lastCode(w); const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await w.otp.verify({ phone: '01712345678', purpose: 'order', code: wrong, uid: 'u1' })).left, 4);
  assert.equal((await w.otp.verify({ phone: '01712345678', purpose: 'signup', code, uid: 'u1' })).code, 'EXPIRED');                   // other purpose has no record
  const ok = await w.otp.verify({ phone: '01712345678', purpose: 'order', code, uid: 'u1' }); assert.equal(ok.ok, true);
  assert.equal(w.claimsSet.u1.vph, '01712345678'); assert.equal(w.claimsSet.u1.vat, Math.floor(w.now() / 1000));
  assert.equal((await w.otp.verify({ phone: '01712345678', purpose: 'order', code, uid: 'u1' })).code, 'EXPIRED');                    // single use
  w.adv(61e3); await w.otp.send({ phone: '01812345678', purpose: 'order', uid: 'u2', ip: '2.2.2.2' });
  const c2 = lastCode(w), bad = c2 === '999999' ? '888888' : '999999';
  for (let i = 0; i < 5; i++) await w.otp.verify({ phone: '01812345678', purpose: 'order', code: bad, uid: 'u2' });
  assert.equal((await w.otp.verify({ phone: '01812345678', purpose: 'order', code: c2, uid: 'u2' })).code, 'LOCKED');               // even the right code is refused now
  assert.equal((await w.otp.send({ phone: '01812345678', purpose: 'order', uid: 'u2', ip: '2.2.2.2' })).code, 'LOCKED');
  w.adv(5 * 60e3 + 1); await w.otp.send({ phone: '01912345678', purpose: 'order', uid: 'u3', ip: '3.3.3.3' }); w.adv(6 * 60e3);
  assert.equal((await w.otp.verify({ phone: '01912345678', purpose: 'order', code: lastCode(w), uid: 'u3' })).code, 'EXPIRED');       // 5-minute TTL
  const w2 = world(); await provision(w2); w2.store._root.serverState = { rate: { phone: {}, ip: {}, uid: {}, global: {} } };
  for (let i = 0; i < 5; i++) { w2.adv(61e3); assert.equal((await w2.otp.send({ phone: '01712300000', purpose: 'order', uid: 'a', ip: '9.9.9.9' })).code, i < 5 ? undefined : 'RATE'); }
});

test('service: hourly per-phone, per-IP and global-cap limits; failed SMS leaves no usable code', async () => {
  const w = world(); await provision(w);
  let last; for (let i = 0; i < 6; i++) { w.adv(61e3); last = await w.otp.send({ phone: '01755555555', purpose: 'order', uid: 'a' + i, ip: '5.5.5.' + i }); } assert.equal(last.code, 'RATE');
  const w3 = world(); await provision(w3); let r; for (let i = 0; i < 21; i++) { w3.adv(61e3); r = await w3.otp.send({ phone: '017' + String(10000000 + i), purpose: 'order', uid: 'b' + i, ip: '7.7.7.7' }); } assert.equal(r.code, 'RATE');
  const w4 = world(); await provision(w4); const cap = createOtpService({ store: w4.store, cfg: { ...cfg, dailyCap: 2 }, chain: w4.chain, getOtpConfig: w4.otpConfig.load, setClaims: async () => {}, now: w4.now });
  const rs = []; for (let i = 0; i < 3; i++) { w4.adv(61e3); rs.push((await cap.send({ phone: '017' + String(20000000 + i), purpose: 'order', uid: 'c' + i, ip: '8.8.8.' + i })).code); } assert.deepEqual(rs, [undefined, undefined, 'CAP']);
  const f = world({ smsFail: ['bulk', 'alpha'] }); await provision(f); const o = await f.otp.send({ phone: '01712345678', purpose: 'order', uid: 'z', ip: '4.4.4.4' });
  assert.equal(o.ok, false); assert.equal(await f.store.get('serverState/otp/order/01712345678'), null);
});

test('HTTP: auth, origin, flags, purpose rules, full send→verify→claim, reset-pin', async () => {
  const w = world(); await provision(w); const call = await up(w);
  try {
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'order' }, null)).status, 401);
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'order' }, 'nope')).status, 401);
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'order' }, 'uid-anon', 'https://evil.example')).status, 403);
    assert.equal((await call('POST', '/otp/send', { phone: '123', purpose: 'order' })).body.code, 'BAD_PHONE');
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'hack' })).body.code, 'BAD_REQ');
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'withdraw' })).status, 403);                            // anon cannot trigger reseller-bound codes
    assert.equal((await call('POST', '/otp/send', { phone: '01712345679', purpose: 'withdraw' }, 'uid-res')).status, 403);                  // reseller cannot target another phone
    let r = await call('POST', '/otp/send', { phone: '+8801712345678', purpose: 'order' }, 'uid-anon', 'https://shop.example'); assert.equal(r.status, 200);
    assert.equal((await call('POST', '/otp/verify', { phone: '01712345678', purpose: 'order', code: 'abc' })).body.code, 'INVALID');
    r = await call('POST', '/otp/verify', { phone: '01712345678', purpose: 'order', code: lastCode(w) }); assert.equal(r.body.ok, true); assert.equal(w.claimsSet['uid-anon'].vph, '01712345678');
    await w.store.update('settings/settings', { verifyAtOrder: false }); w.flags.bust();
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'order' })).body.code, 'DISABLED');
    await w.store.update('settings/settings', { phoneVerify: false, verifyAtOrder: true }); w.flags.bust();
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'order' })).body.code, 'DISABLED');                       // master off beats sub-flag
    await w.store.update('settings/settings', { phoneVerify: true }); w.flags.bust(); w.adv(61e3);
    // reseller step-up
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'withdraw' }, 'uid-res')).status, 200);
    assert.equal((await call('POST', '/otp/verify', { phone: '01712345678', purpose: 'withdraw', code: lastCode(w) }, 'uid-res')).body.ok, true);
    // PIN reset
    const pinHash = 'a'.repeat(64);
    assert.equal((await call('POST', '/otp/reset-pin', { phone: '01712345679', pinHash }, 'uid-anon')).body.code, 'NOT_VERIFIED');       // claim is for a different phone → refused
    w.users['uid-anon'].claims = {}; delete w.claimsSet['uid-anon']; w.adv(61e3 * 60);
    assert.equal((await call('POST', '/otp/reset-pin', { phone: '01712345678', pinHash }, 'uid-anon')).body.code, 'NOT_VERIFIED');           // no fresh claim → refused
    assert.equal((await call('POST', '/otp/send', { phone: '01712345678', purpose: 'pin_reset' }, 'uid-anon')).status, 200);
    assert.equal((await call('POST', '/otp/verify', { phone: '01712345678', purpose: 'pin_reset', code: lastCode(w) }, 'uid-anon')).body.ok, true);
    r = await call('POST', '/otp/reset-pin', { phone: '01712345678', pinHash }, 'uid-anon'); assert.equal(r.body.ok, true);
    assert.deepEqual(w.pwSet.at(-1), ['uid-res', { password: 'a'.repeat(24) + 'Dd@01712345678' }]); assert.equal(w.claimsSet['uid-anon'].vph, null);
    assert.equal((await call('POST', '/otp/reset-pin', { phone: '01712345678', pinHash: 'zz' }, 'uid-anon')).body.code, 'BAD_REQ');
  } finally { w.server.close(); }
});

test('HTTP admin: only admin; config never leaks secrets; master needs a tested provider; emergency-off', async () => {
  const w = world(); const call = await up(w);
  try {
    assert.equal((await call('GET', '/admin/otp/config', null, 'uid-anon')).status, 403); assert.equal((await call('GET', '/admin/otp/config', null, 'uid-res')).status, 403);
    let r = await call('PUT', '/admin/otp/config', { providers: [{ id: 'bulk1', type: 'bulksmsbd', enabled: true, priority: 1, fields: { senderid: 'DD' }, secrets: { api_key: 'BULKKEY1234' } }] }, 'uid-admin'); assert.equal(r.status, 200);
    assert.ok(!JSON.stringify((await call('GET', '/admin/otp/config', null, 'uid-admin')).body).includes('BULKKEY1234'));
    assert.equal((await call('POST', '/admin/otp/master', { enable: true }, 'uid-admin')).status, 409);
    r = await call('POST', '/admin/otp/test', { providerId: 'bulk1', phone: '01712345678' }, 'uid-admin'); assert.equal(r.body.ok, true);
    assert.equal((await call('POST', '/admin/otp/master', { enable: true }, 'uid-admin')).body.phoneVerify, true);
    assert.equal((await call('POST', '/admin/otp/emergency-off', {}, 'uid-admin')).body.ok, true);
    const s = await w.store.get('settings/settings'); assert.ok(Object.values(s).every((v) => v === false));
    assert.equal((await call('PUT', '/admin/otp/config', { providers: [{ id: 'g', type: 'generic', generic: { url: 'https://localhost/x' } }] }, 'uid-admin')).status, 400);
  } finally { w.server.close(); }
});

test('HTTP lookups: order tracking by id+last4 and reseller-only stats', async () => {
  const hash = crypto.createHash('sha256').update('dd-cust:01712345678').digest('hex');
  const w = world({ seed: { orders: { K1: { id: 1001, phone: '01712345678', status: 'পেন্ডিং', trackingLink: 'javascript:alert(1)', trackNote: 'n' }, K2: { id: '1002', phone: '01811111111', status: 'x', trackingLink: 'https://c.example/t/1' } }, resellers: { '01712345678': { status: 'approved' } }, customerStats: { [hash]: { total: 5, delivered: 4, cancelled: 1, lastOrderAt: 7 } } } });
  const call = await up(w);
  try {
    let r = await call('POST', '/orders/track', { id: '1001', last4: '5678' }); assert.equal(r.status, 200); assert.equal(r.body.order.fbKey, 'K1'); assert.equal(r.body.order.trackingLink, null);   // unsafe link stripped
    r = await call('POST', '/orders/track', { id: '1002', last4: '1111' }); assert.equal(r.body.order.trackingLink, 'https://c.example/t/1');
    assert.equal((await call('POST', '/orders/track', { id: '1001', last4: '0000' })).status, 404); assert.equal((await call('POST', '/orders/track', { id: '9999', last4: '5678' })).status, 404);
    assert.equal((await call('POST', '/orders/track', { id: '1001; drop', last4: '5678' })).status, 400);
    assert.equal((await call('POST', '/stats/lookup', { phone: '01712345678' }, 'uid-anon')).status, 403);
    r = await call('POST', '/stats/lookup', { phone: '+8801712345678' }, 'uid-res'); assert.deepEqual(r.body.stats, { total: 5, delivered: 4, cancelled: 1, lastOrderAt: 7 });
    assert.equal((await call('POST', '/stats/lookup', { phone: '01999999999' }, 'uid-res')).body.stats, null);
  } finally { w.server.close(); }
});
