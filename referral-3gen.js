'use strict';
/**
 * referral-3gen.js — v4 "single level": রেফার কোড দিয়ে কেউ জয়েন করলেই রেফারার সাথে সাথে বোনাস (ডিফল্ট ৳৫০) পায়।
 *  - বোনাস মেইন ব্যালেন্সে নয়; আলাদা রেফারেল ওয়ালেটে (referralWallets) জমা হয়।
 *  - কোনো ২য়/৩য় জেনারেশন নেই, নতুন সদস্যের সাইন-আপ বোনাসও নেই।
 *  - ইউজার-ফেসিং API আগের মতোই (/join /dashboard /withdraw /config /health + /admin/*), তাই সাইট/অ্যাডমিন ভাঙে না।
 *  - এই ফাইল Express-এর res.status/res.json এর উপর নির্ভর করে না (সরাসরি Node res.end) — তাই
 *    "res.status is not a function" ধরনের সমস্যা আর হবে না।
 *
 * server.js:   import mountReferral from './referral-3gen.js';  mountReferral(app, { admin, adminEmail });
 * ENV: ADMIN_EMAIL (required) · SITE_URL · ALLOWED_ORIGINS · REF_REQUIRE_PHONE_VERIFY (default "true")
 */
import crypto from 'crypto';

export default function mountReferral(app, opts) {
  opts = opts || {};
  const admin = opts.admin;
  if (!admin) throw new Error('referral: pass { admin }');
  const db = admin.database();
  const inc = admin.database.ServerValue.increment;
  const adminEmail = String(opts.adminEmail || process.env.ADMIN_EMAIL || '').toLowerCase();
  const siteUrl = String(opts.siteUrl || process.env.SITE_URL || 'https://dailydeal.world').replace(/\/+$/, '');
  const REQUIRE_VERIFY = String(process.env.REF_REQUIRE_PHONE_VERIFY || 'true').toLowerCase() !== 'false';
  const METHODS = ['bkash', 'nagad'];
  const log = (...a) => console.log('[referral]', ...a);
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const errTxt = (e) => String((e && (e.code || e.message)) || e).slice(0, 160);

  const normPhone = (raw) => {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('880')) d = '0' + d.slice(3);
    else if (/^1\d{9}$/.test(d)) d = '0' + d;
    return /^01[3-9]\d{8}$/.test(d) ? d : '';
  };
  const maskPhone = (p) => (p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(-3) : '***');
  const maskName = (n) => { n = String(n || '').trim(); if (!n) return 'নতুন সদস্য'; const f = n.split(/\s+/)[0]; return f.slice(0, 10) + (f.length > 10 || n.includes(' ') ? '…' : ''); };
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const genCode = () => 'DD' + Array.from(crypto.randomBytes(6)).map((b) => ALPHA[b % ALPHA.length]).join('');
  const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

  /* ───────── config (শুধু: enabled, gen1 = রেফার বোনাস, minWithdraw) ───────── */
  let cfgCache = null, cfgAt = 0;
  async function getConfig(force) {
    if (!force && cfgCache && Date.now() - cfgAt < 15000) return cfgCache;
    const v = (await db.ref('referralConfig').once('value')).val() || {};
    cfgCache = {
      enabled: v.enabled !== false,
      gen1: num(v.gen1, 50, 0, 100000),
      gen2: 0, gen3: 0, signupBonus: 0,            // আর ব্যবহার হয় না (সাইট/অ্যাডমিন সামঞ্জস্যের জন্য ০)
      minWithdraw: Math.floor(num(v.minWithdraw, 500, 1, 10000000)),
    };
    cfgAt = Date.now();
    return cfgCache;
  }

  /* ───────── Express-নিরপেক্ষ হেল্পার ───────── */
  const allowed = new Set([siteUrl].concat(String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)));
  function send(res, code, obj, extra) {
    if (res.headersSent || res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', (extra && extra.cache) || 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }
  const fail = (res, code, message, c) => send(res, code, { ok: false, code: c, message });
  function readBody(req) {
    return new Promise((resolve) => {
      if (req.body && typeof req.body === 'object') return resolve(req.body);     // app.js এর express.json আগেই পড়ে ফেললে
      if (req.method !== 'POST') return resolve({});
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 20000) { req.destroy(); resolve({}); } });
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }
  const bearer = (req) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : ''; };

  async function authUser(req, res) {
    try {
      const t = bearer(req);
      if (!t) { fail(res, 401, 'লগইন দরকার', 'NOAUTH'); return null; }
      const d = await admin.auth().verifyIdToken(t);
      const cid = (await db.ref('uidMap/' + d.uid).once('value')).val();
      if (!cid) { fail(res, 400, 'অ্যাকাউন্ট প্রস্তুত নয়, পেজ রিফ্রেশ করুন', 'NOUID'); return null; }
      return { uid: d.uid, cid: String(cid), vph: d.vph ? String(d.vph) : '' };
    } catch (e) { log('authUser', errTxt(e)); fail(res, 401, 'সেশন শেষ, আবার চেষ্টা করুন', 'BADTOKEN'); return null; }
  }
  async function authAdmin(req, res) {
    try {
      const t = bearer(req);
      if (!adminEmail) { fail(res, 500, 'সার্ভারে ADMIN_EMAIL সেট করা নেই (Railway → Variables)'); return false; }
      if (!t) { fail(res, 401, 'অ্যাডমিন লগইন দরকার'); return false; }
      const d = await admin.auth().verifyIdToken(t);
      if (String(d.email || '').toLowerCase() !== adminEmail || d.email_verified === false) { fail(res, 403, 'শুধু মূল অ্যাডমিন পারবেন (ADMIN_EMAIL মিলছে না)'); return false; }
      return true;
    } catch (e) { log('authAdmin', errTxt(e)); fail(res, 401, 'টোকেন সঠিক নয়: ' + errTxt(e)); return false; }
  }
  const withLock = async (cid, ms) => {
    const r = await db.ref('referralLocks/' + cid).transaction((cur) => (cur && Date.now() - cur < (ms || 20000) ? undefined : Date.now()));
    return r.committed;
  };
  const unlock = (cid) => db.ref('referralLocks/' + cid).remove().catch(() => {});

  /* ───────── routes ───────── */
  const R = {};

  /* ব্রাউজারে খুলে দেখুন: https://YOUR-RAILWAY-URL/api/referral/health */
  R['GET /health'] = async (req, res) => {
    const out = { ok: true, mounted: true, build: 'v4-single-level', adminEmailSet: !!adminEmail, allowedOrigins: Array.from(allowed), requestOrigin: req.headers.origin || null };
    try { await db.ref('referralConfig').once('value'); out.db = 'ok'; } catch (e) { out.ok = false; out.db = errTxt(e); }
    send(res, 200, out);
  };

  R['GET /config'] = async (req, res) => {
    const c = await getConfig();
    send(res, 200, { ok: true, ...c, methods: METHODS }, { cache: 'public, max-age=30' });
  };

  /* JOIN: নতুন সদস্য রেফার কোড দিয়ে জয়েন করলে রেফারার সাথে সাথে gen1 টাকা পায় (শুধু সরাসরি রেফারার) */
  R['POST /join'] = async (req, res) => {
    const u = await authUser(req, res); if (!u) return;
    const { cid, vph } = u;
    const body = await readBody(req);
    let phoneClaimed = false, phone = '', locked = false;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return fail(res, 403, 'রেফারেল সিস্টেম এখন বন্ধ আছে', 'OFF');
      const existing = (await db.ref('referralProfiles/' + cid).once('value')).val();
      if (existing) return send(res, 200, { ok: true, joined: true, already: true, code: existing.code });

      phone = REQUIRE_VERIFY ? normPhone(vph) : normPhone(body.phone || vph);
      if (!phone) return fail(res, 403, 'রেফারেল চালু করতে আগে মোবাইল নম্বর OTP দিয়ে যাচাই করুন', 'NEEDVERIFY');

      locked = await withLock(cid, 60000);
      if (!locked) return fail(res, 429, 'একটু অপেক্ষা করে আবার চেষ্টা করুন', 'BUSY');

      const pc = await db.ref('referralPhones/' + phone).transaction((c) => (c ? undefined : cid));
      if (!pc.committed && pc.snapshot.val() !== cid) return fail(res, 409, 'এই মোবাইল নম্বর আগেই রেফারেলে যুক্ত আছে', 'PHONE_USED');
      phoneClaimed = pc.committed;

      const raw = clip(body.code || '', 20).trim().toUpperCase();
      let p1 = null;
      if (/^[A-Z0-9]{4,14}$/.test(raw)) {
        const pcid = (await db.ref('customerRefCodes/' + raw).once('value')).val();
        if (pcid && String(pcid) !== cid) {
          const pp = (await db.ref('referralProfiles/' + pcid).once('value')).val();
          if (pp && pp.phone !== phone) p1 = String(pcid);
        }
      }

      let code = '';
      for (let i = 0; i < 8 && !code; i++) {
        const c = genCode();
        const r = await db.ref('customerRefCodes/' + c).transaction((x) => (x ? undefined : cid));
        if (r.committed) code = c;
      }
      if (!code) throw new Error('code generation failed');

      let nm = '';
      try { nm = ((await db.ref('users/' + phone).once('value')).val() || {}).name || ''; } catch (e) {}
      const now = Date.now(), up = {};
      const prof = { code, phone, createdAt: now };
      if (p1) prof.p1 = p1;
      up['referralProfiles/' + cid] = prof;

      let credited = 0;
      if (p1) {
        const amt = cfg.gen1, w = 'referralWallets/' + p1 + '/';
        up[w + 'c1'] = inc(1);
        if (amt > 0) {
          up[w + 'balance'] = inc(amt);
          up[w + 'totalEarned'] = inc(amt);
          up['referralTx/' + p1 + '/' + db.ref('referralTx/' + p1).push().key] = { type: 'commission', gen: 1, from: cid, label: maskName(nm), amount: amt, at: now };
          credited = amt;
        }
        up['referralTeam/' + p1 + '/g1/' + cid] = { name: maskName(nm), phone: maskPhone(phone), at: now };
      }
      await db.ref().update(up);
      send(res, 200, { ok: true, joined: true, code, credited: p1 ? 1 : 0, bonus: 0, referrerBonus: credited });
    } catch (e) {
      log('join error', errTxt(e));
      if (phoneClaimed && phone) db.ref('referralPhones/' + phone).remove().catch(() => {});
      fail(res, 500, 'কিছু সমস্যা হয়েছে, আবার চেষ্টা করুন');
    } finally { if (locked) unlock(cid); }
  };

  R['GET /dashboard'] = async (req, res) => {
    const u = await authUser(req, res); if (!u) return;
    try {
      const { cid, vph } = u;
      const cfg = await getConfig();
      const prof = (await db.ref('referralProfiles/' + cid).once('value')).val();
      const base = { ok: true, config: { ...cfg, methods: METHODS }, phoneVerified: !!normPhone(vph) };
      if (!prof) return send(res, 200, { ...base, joined: false });
      const [w, team, tx, pay] = await Promise.all([
        db.ref('referralWallets/' + cid).once('value'),
        db.ref('referralTeam/' + cid + '/g1').once('value'),
        db.ref('referralTx/' + cid).orderByKey().limitToLast(30).once('value'),
        db.ref('referralMyPayouts/' + cid).orderByKey().limitToLast(20).once('value'),
      ]);
      const W = w.val() || {};
      const arr = (o) => Object.entries(o || {}).map(([k, v]) => ({ id: k, name: v.name, phone: v.phone, at: v.at })).sort((a, b) => b.at - a.at).slice(0, 300);
      const list = (o) => Object.entries(o || {}).map(([k, v]) => ({ id: k, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0));
      const g1 = arr(team.val());
      const c1 = Math.max(Number(W.c1) || 0, g1.length);
      send(res, 200, {
        ...base, joined: true, code: prof.code, link: siteUrl + '/?inv=' + prof.code,
        wallet: { balance: Number(W.balance) || 0, totalEarned: Number(W.totalEarned) || 0, totalWithdrawn: Number(W.totalWithdrawn) || 0 },
        counts: { g1: c1, g2: 0, g3: 0, total: c1 },
        team: { g1, g2: [], g3: [] },
        tx: list(tx.val()), payouts: list(pay.val()),
      });
    } catch (e) { log('dashboard', errTxt(e)); fail(res, 500, 'ডেটা লোড হয়নি'); }
  };

  R['POST /withdraw'] = async (req, res) => {
    const u = await authUser(req, res); if (!u) return;
    const { cid } = u;
    const b = await readBody(req);
    let locked = false, deducted = 0;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return fail(res, 403, 'রেফারেল সিস্টেম এখন বন্ধ আছে');
      const prof = (await db.ref('referralProfiles/' + cid).once('value')).val();
      if (!prof) return fail(res, 403, 'আগে রেফারেল চালু করুন');
      const amount = Math.floor(Number(b.amount));
      const method = String(b.method || '').toLowerCase();
      const number = normPhone(b.number);
      if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'সঠিক পরিমাণ দিন');
      if (amount < cfg.minWithdraw) return fail(res, 400, 'সর্বনিম্ন উইথড্র ৳' + cfg.minWithdraw);
      if (!METHODS.includes(method)) return fail(res, 400, 'bKash বা Nagad বেছে নিন');
      if (!number) return fail(res, 400, 'সঠিক bKash/Nagad নম্বর দিন (০১XXXXXXXXX)');

      locked = await withLock(cid, 20000);
      if (!locked) return fail(res, 429, 'একটু অপেক্ষা করে আবার চেষ্টা করুন');
      const mine = (await db.ref('referralMyPayouts/' + cid).once('value')).val() || {};
      if (Object.values(mine).some((x) => x && x.status === 'pending')) return fail(res, 409, 'আগের উইথড্র অনুরোধ এখনো পেন্ডিং আছে');

      const tr = await db.ref('referralWallets/' + cid + '/balance').transaction((cur) => { cur = Number(cur) || 0; return cur < amount ? undefined : cur - amount; });
      if (!tr.committed) return fail(res, 400, 'রেফারেল ব্যালেন্স যথেষ্ট নয়');
      deducted = amount;

      let nm = ''; try { nm = ((await db.ref('users/' + prof.phone).once('value')).val() || {}).name || ''; } catch (e) {}
      const id = db.ref('referralPayouts').push().key, now = Date.now(), up = {};
      up['referralPayouts/' + id] = { cid, name: clip(nm, 100), phone: prof.phone, amount, method, number, status: 'pending', requestedAt: now };
      up['referralMyPayouts/' + cid + '/' + id] = { amount, method, number, status: 'pending', at: now };
      up['referralTx/' + cid + '/' + db.ref('referralTx/' + cid).push().key] = { type: 'withdraw', amount: -amount, payoutId: id, at: now };
      try { await db.ref().update(up); deducted = 0; }
      catch (e) { await db.ref('referralWallets/' + cid + '/balance').set(inc(deducted)); deducted = 0; throw e; }
      send(res, 200, { ok: true, id, balance: tr.snapshot.val() });
    } catch (e) {
      log('withdraw error', errTxt(e));
      if (deducted) db.ref('referralWallets/' + cid + '/balance').set(inc(deducted)).catch(() => {});
      fail(res, 500, 'অনুরোধ জমা হয়নি, আবার চেষ্টা করুন');
    } finally { if (locked) unlock(cid); }
  };

  /* ADMIN */
  R['GET /admin/payouts'] = async (req, res) => {
    if (!(await authAdmin(req, res))) return;
    try {
      const st = String(new URL(req.url, 'http://x').searchParams.get('status') || 'pending');
      const snap = await db.ref('referralPayouts').orderByKey().limitToLast(400).once('value');
      const all = Object.entries(snap.val() || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
      const sum = (s) => all.filter((x) => x.status === s).reduce((t, x) => t + (Number(x.amount) || 0), 0);
      send(res, 200, {
        ok: true,
        totals: { pendingCount: all.filter((x) => x.status === 'pending').length, pendingSum: sum('pending'), paidSum: sum('paid'), rejectedSum: sum('rejected') },
        list: (st === 'all' ? all : all.filter((x) => x.status === st)).slice(0, 200),
      });
    } catch (e) { log('admin/payouts', errTxt(e)); fail(res, 500, 'লোড ব্যর্থ — সার্ভার ত্রুটি: ' + errTxt(e)); }
  };

  R['POST /admin/payout'] = async (req, res) => {
    if (!(await authAdmin(req, res))) return;
    const b = await readBody(req);
    const id = String(b.id || ''), action = String(b.action || '');
    if (!/^[-\w]{10,40}$/.test(id) || !['paid', 'rejected'].includes(action)) return fail(res, 400, 'ভুল অনুরোধ');
    const sref = db.ref('referralPayouts/' + id + '/status');
    let claimed = false;
    try {
      const tr = await sref.transaction((c) => (c === 'pending' ? '__processing' : undefined));
      if (!tr.committed) return fail(res, 409, 'এই অনুরোধ আগেই প্রসেস হয়েছে');
      claimed = true;
      const p = (await db.ref('referralPayouts/' + id).once('value')).val();
      const now = Date.now(), up = {}, trx = clip(b.trxId, 40), note = clip(b.note, 200);
      up['referralPayouts/' + id + '/status'] = action;
      up['referralPayouts/' + id + '/processedAt'] = now;
      if (trx) up['referralPayouts/' + id + '/trxId'] = trx;
      if (note) up['referralPayouts/' + id + '/note'] = note;
      up['referralMyPayouts/' + p.cid + '/' + id + '/status'] = action;
      up['referralMyPayouts/' + p.cid + '/' + id + '/processedAt'] = now;
      if (trx) up['referralMyPayouts/' + p.cid + '/' + id + '/trxId'] = trx;
      if (action === 'paid') up['referralWallets/' + p.cid + '/totalWithdrawn'] = inc(Number(p.amount) || 0);
      else {
        up['referralWallets/' + p.cid + '/balance'] = inc(Number(p.amount) || 0);
        up['referralTx/' + p.cid + '/' + db.ref('referralTx/' + p.cid).push().key] = { type: 'refund', amount: Number(p.amount) || 0, payoutId: id, at: now };
      }
      await db.ref().update(up);
      claimed = false;
      send(res, 200, { ok: true });
    } catch (e) {
      log('admin/payout', errTxt(e));
      if (claimed) sref.set('pending').catch(() => {});
      fail(res, 500, 'আপডেট ব্যর্থ: ' + errTxt(e));
    }
  };

  R['GET /admin/config'] = async (req, res) => {
    if (!(await authAdmin(req, res))) return;
    try { send(res, 200, { ok: true, ...(await getConfig(true)) }); }
    catch (e) { log('admin/config GET', errTxt(e)); fail(res, 500, 'কনফিগ লোড ব্যর্থ: ' + errTxt(e)); }
  };

  R['POST /admin/config'] = async (req, res) => {
    if (!(await authAdmin(req, res))) return;
    try {
      const b = await readBody(req);
      await db.ref('referralConfig').set({
        enabled: b.enabled !== false,
        gen1: num(b.gen1, 50, 0, 100000),
        minWithdraw: Math.floor(num(b.minWithdraw, 500, 1, 10000000)),
      });
      cfgCache = null;
      send(res, 200, { ok: true });
    } catch (e) { log('admin/config POST', errTxt(e)); fail(res, 500, 'সেভ ব্যর্থ: ' + errTxt(e)); }
  };

  /* ───────── dispatcher (app.use('/api/referral', …) — req.url থেকে মাউন্ট পাথ কাটা থাকে) ───────── */
  const handler = (req, res) => {
    try {
      const o = req.headers.origin;
      if (o) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Firebase-AppCheck');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const path = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
      const fn = R[req.method + ' ' + path];
      if (!fn) return fail(res, 404, 'রুট নেই: ' + path, 'NOT_FOUND');
      Promise.resolve(fn(req, res)).catch((e) => { log('route error', req.method, path, errTxt(e)); fail(res, 500, 'সার্ভার ত্রুটি'); });
    } catch (e) { log('handler error', errTxt(e)); fail(res, 500, 'সার্ভার ত্রুটি'); }
  };

  app.use('/api/referral', handler);
  log('v4-single-level mounted /api/referral/* (phone verification ' + (REQUIRE_VERIFY ? 'REQUIRED' : 'OFF — not recommended') + ')');
}
