import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeBD } from '../src/otp/phone.js';
import { encrypt, decrypt, mask, redact } from '../src/secrets.js';
import { isPrivateIp, checkUrl, safeFetch } from '../src/net.js';
import { validateGeneric, sendGeneric } from '../src/otp/generic.js';
import { PRESETS } from '../src/otp/providers/index.js';
import { loadConfig } from '../src/config.js';
import { memoryStore } from '../src/store.js';

test('phone normalisation matches the site', () => {
  for (const [i, o] of [['01712345678', '01712345678'], ['+8801712345678', '01712345678'], ['8801712345678', '01712345678'], ['1712345678', '01712345678'], ['017-123 45678', '01712345678']]) assert.equal(normalizeBD(i), o);
  for (const bad of ['', '0171234567', '01212345678', '12345', null, '+9779812345678']) assert.equal(normalizeBD(bad), null);
});
test('AES-GCM roundtrip, random IV, tamper detection', () => {
  const k = Buffer.alloc(32, 7); const a = encrypt(k, 'sekret'), b = encrypt(k, 'sekret');
  assert.notEqual(a, b); assert.equal(decrypt(k, a), 'sekret');
  const parts = a.split('.'); parts[3] = Buffer.from('x' + Buffer.from(parts[3], 'base64url').toString('latin1').slice(1), 'latin1').toString('base64url');
  assert.throws(() => decrypt(k, parts.join('.'))); assert.throws(() => decrypt(Buffer.alloc(32, 1), a));
  assert.equal(mask('abcdef1234'), '••••1234'); assert.equal(redact('key=abcdef1234 x', ['abcdef1234']), 'key=*** x');
});
test('SSRF: private/loopback/metadata/IPv6 forms are rejected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', '224.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://localhost/x', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://169.254.169.254/latest', 'https://u:p@example.com/', 'https://example.com:22/', 'ftp://example.com', 'https://a.internal/', 'file:///etc/passwd']) assert.throws(() => checkUrl(u), u);
  assert.doesNotThrow(() => checkUrl('https://api.sms.net.bd/sendsms'));
});
test('safeFetch: blocks localhost by name at connect time, allows with test override, no redirects, size cap', async () => {
  await assert.rejects(safeFetch('https://localhost:8443/'), /url-private/);
  const srv = http.createServer((q, s) => { if (q.url === '/r') { s.writeHead(302, { location: 'http://169.254.169.254/' }); return s.end(); } if (q.url === '/big') return s.end('x'.repeat(200000)); s.end('{"ok":1}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(safeFetch(base + '/', { allowHttp: true }), /url-private/);
    assert.equal((await safeFetch(base + '/', { allowHttp: true, allowPrivate: true })).text, '{"ok":1}');
    assert.equal((await safeFetch(base + '/r', { allowHttp: true, allowPrivate: true })).status, 302);
    await assert.rejects(safeFetch(base + '/big', { allowHttp: true, allowPrivate: true, maxBytes: 1000 }), /too-large/);
  } finally { srv.close(); }
});
test('Generic HTTP: validation and templating (secrets only via placeholders, URL-encoded)', async () => {
  assert.throws(() => validateGeneric({ url: 'http://x.com/' }), /url/); assert.throws(() => validateGeneric({ url: 'https://127.0.0.1/' }), /url/);
  assert.throws(() => validateGeneric({ url: 'https://x.com/', headers: { 'Bad Name': 'x' } }), /হেডার/);
  assert.throws(() => validateGeneric({ url: 'https://x.com/', success: { type: 'json', path: 'a b' } }), /path/);
  let seen;
  const fake = async (url, o) => { seen = { url, o }; return { status: 200, text: '{"data":{"state":"OK"}}', json: { data: { state: 'OK' } } }; };
  const g = { method: 'POST', url: 'https://sms.example.com/send?k={{secret.KEY}}', headers: { 'X-Auth': 'Bearer {{secret.TOK}}' }, bodyType: 'json', body: { to: '{{to}}', msg: '{{text}}', from: '{{sender}}' }, success: { type: 'json', path: 'data.state', equals: 'OK' } };
  const r = await sendGeneric({ to: '8801712345678', text: 'কোড 123 & x', sender: 'DD', secrets: { KEY: 'a b&c', TOK: 't\r\nInjected: 1' }, http: fake, generic: g });
  assert.equal(r.ok, true); assert.equal(seen.url, 'https://sms.example.com/send?k=a%20b%26c');
  assert.equal(seen.o.headers['X-Auth'], 'Bearer t  Injected: 1'); assert.deepEqual(seen.o.json, { to: '8801712345678', msg: 'কোড 123 & x', from: 'DD' });
  const r2 = await sendGeneric({ to: '1', text: 't', secrets: {}, http: async () => ({ status: 500, text: 'boom', json: null }), generic: { url: 'https://x.com/a', success: { type: 'status', codes: [200] } } });
  assert.equal(r2.ok, false);
  await assert.rejects(sendGeneric({ to: '1', text: 't', secrets: {}, http: fake, generic: { url: 'https://x.com/{{secret.NOPE}}' } }), /secret/);
});
test('Provider adapters build the documented requests and judge replies', async () => {
  const run = async (type, v, reply, extra = {}) => { let seen; const h = async (url, o) => { seen = { url, o }; return { status: reply.status ?? 200, text: JSON.stringify(reply.json ?? {}), json: reply.json ?? null }; }; const r = await PRESETS[type].send({ to: '8801712345678', text: 'hi', v, http: h, ...extra }); return { r, seen }; };
  let x = await run('alphasms', { api_key: 'K', sender_id: 'S' }, { json: { error: 0, msg: 'Request successfully submitted' } });
  assert.equal(x.r.ok, true); assert.equal(x.seen.url, 'https://api.sms.net.bd/sendsms'); assert.deepEqual(x.seen.o.form, { api_key: 'K', msg: 'hi', to: '8801712345678', sender_id: 'S' });
  assert.equal((await run('alphasms', { api_key: 'K' }, { json: { error: 405, msg: 'bad' } })).r.ok, false);
  x = await run('bulksmsbd', { api_key: 'K', senderid: 'S' }, { json: { response_code: 202 } }); assert.equal(x.r.ok, true); assert.equal(x.seen.o.form.number, '8801712345678');
  assert.equal((await run('bulksmsbd', { api_key: 'K', senderid: 'S' }, { json: { response_code: 1001 } })).r.ok, false);
  const gw = async (reply) => { const h = async () => ({ status: 200, text: reply, json: null }); return PRESETS.greenweb.send({ to: '8801712345678', text: 'hi', v: { token: 'T' }, http: h }); };
  assert.equal((await gw('[{"to":"8801712345678","message":"hi","status":"SENT"}]')).ok, true); assert.equal((await gw('Error: Invalid token')).ok, false);
  x = await run('mimsms', { host: 'api.mimsms.com', UserName: 'u', Apikey: 'k', SenderName: 's' }, { json: { statusCode: '200' } }); assert.equal(x.r.ok, true); assert.equal(x.seen.url, 'https://api.mimsms.com/api/SmsSending/SMS');
  await assert.rejects(run('mimsms', { host: '169.254.169.254', UserName: 'u', Apikey: 'k', SenderName: 's' }, {}), /হোস্ট/);
  x = await run('twilio', { account_sid: 'AC' + 'a'.repeat(32), auth_token: 'T', from: '+1555' }, { status: 201, json: { sid: 'SM1' } }); assert.equal(x.r.ok, true); assert.equal(x.seen.o.form.To, '+8801712345678'); assert.deepEqual(x.seen.o.basic, ['AC' + 'a'.repeat(32), 'T']);
  assert.equal((await run('vonage', { api_key: 'k', api_secret: 's', from: 'DD' }, { json: { messages: [{ status: '0' }] } }, { unicode: true })).seen.o.form.type, 'unicode');
  assert.equal((await run('vonage', { api_key: 'k', api_secret: 's', from: 'DD' }, { json: { messages: [{ status: '4', 'error-text': 'bad' }] } })).r.ok, false);
  x = await run('infobip', { host: 'abc12.api.infobip.com', api_key: 'K', sender: 'DD' }, { json: { messages: [{ status: { groupId: 1 } }] } }); assert.equal(x.r.ok, true); assert.equal(x.seen.o.headers.authorization, 'App K');
  await assert.rejects(run('infobip', { host: 'evil.com', api_key: 'K', sender: 'DD' }, {}), /হোস্ট/);
  assert.equal((await run('plivo', { auth_id: 'MAABCDEFGHIJ', auth_token: 'T', src: 'DD' }, { status: 202, json: {} })).r.ok, true);
  assert.equal((await run('bird', { access_key: 'K', originator: 'DD' }, { status: 201, json: {} })).seen.o.headers.authorization, 'AccessKey K');
  assert.equal((await run('sslwireless', { api_token: 'T', sid: 'S' }, { json: { status: 'SUCCESS' } })).r.ok, true);
});
test('config validation', () => {
  const ok = { FIREBASE_SERVICE_ACCOUNT_B64: 'x', FIREBASE_DATABASE_URL: 'https://a.firebaseio.com', ADMIN_EMAIL: 'A@b.c', ALLOWED_ORIGINS: 'https://a.github.io/, https://b.com', CONFIG_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), OTP_HMAC_SECRET: 'x'.repeat(30) };
  const c = loadConfig(ok); assert.deepEqual(c.origins, ['https://a.github.io', 'https://b.com']); assert.equal(c.adminEmail, 'a@b.c');
  assert.throws(() => loadConfig({ ...ok, ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/); assert.throws(() => loadConfig({ ...ok, CONFIG_ENC_KEY: 'short' }), /CONFIG_ENC_KEY/); assert.throws(() => loadConfig({}), /সেট করা নেই/);
});
test('memory store transaction semantics', async () => {
  const s = memoryStore(); let r = await s.transaction('a/b', (c) => (c || 0) + 1); assert.equal(r.value, 1);
  r = await s.transaction('a/b', () => undefined); assert.equal(r.committed, false); assert.equal(await s.get('a/b'), 1);
  await s.remove('a/b'); assert.equal(await s.get('a'), null);
});
