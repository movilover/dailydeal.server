'use strict';
/**
 * referral-3gen.js — Daily Deal 3-Generation Referral + Referral Wallet + bKash/Nagad payouts
 * ---------------------------------------------------------------------------------------------
 * Add to your Railway server.js (next to facebook-meta):
 *
 *     const mountReferral = require('./referral-3gen');
 *     mountReferral(app, { admin });
 *
 * ENV:  ADMIN_EMAIL (required, same as before) · SITE_URL (default https://dailydeal.world)
 *       ALLOWED_ORIGINS (optional) · REF_REQUIRE_PHONE_VERIFY (default "true" — strongly recommended)
 *
 * SECURITY MODEL
 *  - Every credit / debit happens ONLY here (firebase-admin). Browsers never write referral money.
 *  - A user "activates" referral by having a phone number verified by your existing OTP flow
 *    (Firebase custom claim `vph`). One phone = one referral identity, so fake/anonymous accounts
 *    cannot farm commissions.
 *  - Commission for a new member is written in ONE atomic multi-path update (profile + 3 wallets +
 *    3 ledger rows + team lists) guarded by a per-user lock and a one-phone-one-claim transaction.
 *
 * DATABASE (all new nodes; no existing node is touched):
 *  referralConfig                       { enabled, gen1, gen2, gen3, minWithdraw }   (defaults 50/30/15/500)
 *  referralProfiles/{cid}               { code, phone, p1, p2, p3, createdAt }       p1=direct referrer, p2/p3 = its referrers
 *  customerRefCodes/{CODE}              cid                                           (separate from reseller `referralCodes`)
 *  referralPhones/{phone}               cid                                           (one phone → one member)
 *  referralWallets/{cid}                { balance, totalEarned, totalWithdrawn, c1, c2, c3 }
 *  referralTx/{cid}/{id}                { type: commission|withdraw|refund, gen?, amount, label?, at, ... }
 *  referralTeam/{cid}/g1|g2|g3/{child}  { name(masked), phone(masked), at }
 *  referralPayouts/{id}                 admin payout history table
 *  referralMyPayouts/{cid}/{id}         { amount, method, number, status, at, processedAt?, trxId? }
 *  referralLocks/{cid}                  short lock timestamps
 *  `cid` = the customer id already used by customerWallets (value of uidMap/{authUid}).
 */
const crypto = require('crypto');
const express = require('express');

module.exports = function mountReferral(app, opts) {
  opts = opts || {};
  const admin = opts.admin;
  if (!admin) throw new Error('referral-3gen: pass { admin }');
  const db = admin.database();
  const inc = admin.database.ServerValue.increment;
  const adminEmail = String(opts.adminEmail || process.env.ADMIN_EMAIL || '').toLowerCase();
  const siteUrl = String(opts.siteUrl || process.env.SITE_URL || 'https://dailydeal.world').replace(/\/+$/, '');
  const REQUIRE_VERIFY = String(process.env.REF_REQUIRE_PHONE_VERIFY || 'true').toLowerCase() !== 'false';
  const METHODS = ['bkash', 'nagad'];
  const log = (...a) => console.log('[referral]', ...a);
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

  /* ───────── helpers ───────── */
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

  let cfgCache = null, cfgAt = 0;
  async function getConfig(force) {
    if (!force && cfgCache && Date.now() - cfgAt < 15000) return cfgCache;
    const v = (await db.ref('referralConfig').once('value')).val() || {};
    cfgCache = {
      enabled: v.enabled !== false,
      gen1: num(v.gen1, 50, 0, 100000), gen2: num(v.gen2, 30, 0, 100000), gen3: num(v.gen3, 15, 0, 100000),
      minWithdraw: Math.floor(num(v.minWithdraw, 500, 1, 10000000)),
    };
    cfgAt = Date.now();
    return cfgCache;
  }

  /* ───────── router, CORS, auth ───────── */
  const router = express.Router();
  const allowed = new Set([siteUrl].concat(String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)));
  router.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && allowed.has(o.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Firebase-AppCheck');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '20kb' }));

  const bearer = (req) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : ''; };
  async function requireUser(req, res, next) {
    try {
      const t = bearer(req);
      if (!t) return res.status(401).json({ ok: false, code: 'NOAUTH', message: 'লগইন দরকার' });
      const d = await admin.auth().verifyIdToken(t);
      const cid = (await db.ref('uidMap/' + d.uid).once('value')).val();
      if (!cid) return res.status(400).json({ ok: false, code: 'NOUID', message: 'অ্যাকাউন্ট প্রস্তুত নয়, পেজ রিফ্রেশ করুন' });
      req.u = { uid: d.uid, cid: String(cid), vph: d.vph ? String(d.vph) : '' };
      next();
    } catch (e) { res.status(401).json({ ok: false, code: 'BADTOKEN', message: 'সেশন শেষ, আবার চেষ্টা করুন' }); }
  }
  async function requireAdmin(req, res, next) {
    try {
      const t = bearer(req);
      if (!t || !adminEmail) return res.status(401).json({ ok: false, message: 'অ্যাডমিন লগইন দরকার' });
      const d = await admin.auth().verifyIdToken(t);
      if (String(d.email || '').toLowerCase() !== adminEmail || d.email_verified === false) return res.status(403).json({ ok: false, message: 'শুধু মূল অ্যাডমিন পারবেন' });
      next();
    } catch (e) { res.status(401).json({ ok: false, message: 'টোকেন সঠিক নয়' }); }
  }
  const withLock = async (cid, ms) => {
    const r = await db.ref('referralLocks/' + cid).transaction((cur) => (cur && Date.now() - cur < (ms || 20000) ? undefined : Date.now()));
    return r.committed;
  };
  const unlock = (cid) => db.ref('referralLocks/' + cid).remove().catch(() => {});

  /* ───────── public config ───────── */
  router.get('/config', async (req, res) => {
    try { const c = await getConfig(); res.set('Cache-Control', 'public, max-age=30').json({ ok: true, ...c, methods: METHODS }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });

  /* ───────── JOIN / ACTIVATE  (registration → 3-generation commission) ───────── */
  router.post('/join', requireUser, async (req, res) => {
    const { cid, vph } = req.u;
    let phoneClaimed = false, phone = '';
    let locked = false;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return res.status(403).json({ ok: false, code: 'OFF', message: 'রেফারেল সিস্টেম এখন বন্ধ আছে' });
      const existing = (await db.ref('referralProfiles/' + cid).once('value')).val();
      if (existing) return res.json({ ok: true, joined: true, already: true, code: existing.code });

      phone = REQUIRE_VERIFY ? normPhone(vph) : normPhone((req.body && req.body.phone) || vph);
      if (!phone) return res.status(403).json({ ok: false, code: 'NEEDVERIFY', message: 'রেফারেল চালু করতে আগে মোবাইল নম্বর OTP দিয়ে যাচাই করুন' });

      locked = await withLock(cid, 60000);
      if (!locked) return res.status(429).json({ ok: false, code: 'BUSY', message: 'একটু অপেক্ষা করে আবার চেষ্টা করুন' });

      // one phone → one member (blocks multi-account farming)
      const pc = await db.ref('referralPhones/' + phone).transaction((c) => (c ? undefined : cid));
      if (!pc.committed && pc.snapshot.val() !== cid) return res.status(409).json({ ok: false, code: 'PHONE_USED', message: 'এই মোবাইল নম্বর আগেই রেফারেলে যুক্ত আছে' });
      phoneClaimed = pc.committed;

      // resolve referrer chain
      const raw = clip((req.body && req.body.code) || '', 20).trim().toUpperCase();
      let p1 = null, p2 = null, p3 = null;
      if (/^[A-Z0-9]{4,14}$/.test(raw)) {
        const pcid = (await db.ref('customerRefCodes/' + raw).once('value')).val();
        if (pcid && pcid !== cid) {
          const pp = (await db.ref('referralProfiles/' + pcid).once('value')).val();
          if (pp && pp.phone !== phone) {
            p1 = String(pcid);
            p2 = pp.p1 && pp.p1 !== cid ? String(pp.p1) : null;
            p3 = pp.p2 && pp.p2 !== cid && pp.p2 !== p1 ? String(pp.p2) : null;
          }
        }
      }

      // own unique code
      let code = '';
      for (let i = 0; i < 8 && !code; i++) {
        const c = genCode();
        const r = await db.ref('customerRefCodes/' + c).transaction((x) => (x ? undefined : cid));
        if (r.committed) code = c;
      }
      if (!code) throw new Error('code generation failed');

      // masked identity for upline team lists
      let nm = '';
      try { nm = ((await db.ref('users/' + phone).once('value')).val() || {}).name || ''; } catch (e) {}
      const now = Date.now(), up = {};
      const prof = { code, phone, createdAt: now };
      if (p1) prof.p1 = p1; if (p2) prof.p2 = p2; if (p3) prof.p3 = p3;
      up['referralProfiles/' + cid] = prof;
      [p1, p2, p3].forEach((pid, i) => {
        if (!pid) return;
        const g = i + 1, amt = cfg['gen' + g];
        const w = 'referralWallets/' + pid + '/';
        up[w + 'c' + g] = inc(1);
        if (amt > 0) {
          up[w + 'balance'] = inc(amt);
          up[w + 'totalEarned'] = inc(amt);
          up['referralTx/' + pid + '/' + db.ref('referralTx/' + pid).push().key] = { type: 'commission', gen: g, from: cid, label: maskName(nm), amount: amt, at: now };
        }
        up['referralTeam/' + pid + '/g' + g + '/' + cid] = { name: maskName(nm), phone: maskPhone(phone), at: now };
      });
      await db.ref().update(up);                         // ← single atomic write
      res.json({ ok: true, joined: true, code, credited: [p1, p2, p3].filter(Boolean).length });
    } catch (e) {
      log('join error', String(e.message).slice(0, 200));
      if (phoneClaimed && phone) db.ref('referralPhones/' + phone).remove().catch(() => {});
      res.status(500).json({ ok: false, message: 'কিছু সমস্যা হয়েছে, আবার চেষ্টা করুন' });
    } finally { if (locked) unlock(cid); }
  });

  /* ───────── DASHBOARD ───────── */
  router.get('/dashboard', requireUser, async (req, res) => {
    try {
      const { cid, vph } = req.u;
      const cfg = await getConfig();
      const prof = (await db.ref('referralProfiles/' + cid).once('value')).val();
      const base = { ok: true, config: { ...cfg, methods: METHODS }, phoneVerified: !!normPhone(vph) };
      if (!prof) return res.json({ ...base, joined: false });
      const [w, team, tx, pay] = await Promise.all([
        db.ref('referralWallets/' + cid).once('value'),
        db.ref('referralTeam/' + cid).once('value'),
        db.ref('referralTx/' + cid).orderByKey().limitToLast(30).once('value'),
        db.ref('referralMyPayouts/' + cid).orderByKey().limitToLast(20).once('value'),
      ]);
      const W = w.val() || {}, T = team.val() || {};
      const arr = (o) => Object.entries(o || {}).map(([k, v]) => ({ id: k, name: v.name, phone: v.phone, at: v.at })).sort((a, b) => b.at - a.at).slice(0, 300);
      const list = (o) => Object.entries(o || {}).map(([k, v]) => ({ id: k, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0));
      const c1 = Number(W.c1) || 0, c2 = Number(W.c2) || 0, c3 = Number(W.c3) || 0;
      res.json({
        ...base, joined: true, code: prof.code, link: siteUrl + '/?inv=' + prof.code,
        wallet: { balance: Number(W.balance) || 0, totalEarned: Number(W.totalEarned) || 0, totalWithdrawn: Number(W.totalWithdrawn) || 0 },
        counts: { g1: c1, g2: c2, g3: c3, total: c1 + c2 + c3 },
        team: { g1: arr(T.g1), g2: arr(T.g2), g3: arr(T.g3) },
        tx: list(tx.val()), payouts: list(pay.val()),
      });
    } catch (e) { log('dashboard', String(e.message).slice(0, 200)); res.status(500).json({ ok: false, message: 'ডেটা লোড হয়নি' }); }
  });

  /* ───────── WITHDRAW REQUEST ───────── */
  router.post('/withdraw', requireUser, async (req, res) => {
    const { cid } = req.u;
    let locked = false, deducted = 0;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return res.status(403).json({ ok: false, message: 'রেফারেল সিস্টেম এখন বন্ধ আছে' });
      const prof = (await db.ref('referralProfiles/' + cid).once('value')).val();
      if (!prof) return res.status(403).json({ ok: false, message: 'আগে রেফারেল চালু করুন' });
      const b = req.body || {};
      const amount = Math.floor(Number(b.amount));
      const method = String(b.method || '').toLowerCase();
      const number = normPhone(b.number);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, message: 'সঠিক পরিমাণ দিন' });
      if (amount < cfg.minWithdraw) return res.status(400).json({ ok: false, message: 'সর্বনিম্ন উইথড্র ৳' + cfg.minWithdraw });
      if (!METHODS.includes(method)) return res.status(400).json({ ok: false, message: 'bKash বা Nagad বেছে নিন' });
      if (!number) return res.status(400).json({ ok: false, message: 'সঠিক bKash/Nagad নম্বর দিন (০১XXXXXXXXX)' });

      locked = await withLock(cid, 20000);
      if (!locked) return res.status(429).json({ ok: false, message: 'একটু অপেক্ষা করে আবার চেষ্টা করুন' });
      const mine = (await db.ref('referralMyPayouts/' + cid).once('value')).val() || {};
      if (Object.values(mine).some((x) => x && x.status === 'pending')) return res.status(409).json({ ok: false, message: 'আগের উইথড্র অনুরোধ এখনো পেন্ডিং আছে' });

      const tr = await db.ref('referralWallets/' + cid + '/balance').transaction((cur) => { cur = Number(cur) || 0; return cur < amount ? undefined : cur - amount; });
      if (!tr.committed) return res.status(400).json({ ok: false, message: 'রেফারেল ব্যালেন্স যথেষ্ট নয়' });
      deducted = amount;

      let nm = ''; try { nm = ((await db.ref('users/' + prof.phone).once('value')).val() || {}).name || ''; } catch (e) {}
      const id = db.ref('referralPayouts').push().key, now = Date.now(), up = {};
      up['referralPayouts/' + id] = { cid, name: clip(nm, 100), phone: prof.phone, amount, method, number, status: 'pending', requestedAt: now };
      up['referralMyPayouts/' + cid + '/' + id] = { amount, method, number, status: 'pending', at: now };
      up['referralTx/' + cid + '/' + db.ref('referralTx/' + cid).push().key] = { type: 'withdraw', amount: -amount, payoutId: id, at: now };
      try { await db.ref().update(up); deducted = 0; }
      catch (e) { await db.ref('referralWallets/' + cid + '/balance').set(inc(deducted)); deducted = 0; throw e; }
      res.json({ ok: true, id, balance: tr.snapshot.val() });
    } catch (e) {
      log('withdraw error', String(e.message).slice(0, 200));
      if (deducted) db.ref('referralWallets/' + cid + '/balance').set(inc(deducted)).catch(() => {});
      res.status(500).json({ ok: false, message: 'অনুরোধ জমা হয়নি, আবার চেষ্টা করুন' });
    } finally { if (locked) unlock(cid); }
  });

  /* ───────── ADMIN: payouts, config ───────── */
  router.get('/admin/payouts', requireAdmin, async (req, res) => {
    try {
      const st = String(req.query.status || 'pending');
      const snap = await db.ref('referralPayouts').orderByKey().limitToLast(400).once('value');
      const all = Object.entries(snap.val() || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
      const sum = (s) => all.filter((x) => x.status === s).reduce((t, x) => t + (Number(x.amount) || 0), 0);
      res.json({
        ok: true,
        totals: { pendingCount: all.filter((x) => x.status === 'pending').length, pendingSum: sum('pending'), paidSum: sum('paid'), rejectedSum: sum('rejected') },
        list: (st === 'all' ? all : all.filter((x) => x.status === st)).slice(0, 200),
      });
    } catch (e) { res.status(500).json({ ok: false, message: 'লোড ব্যর্থ' }); }
  });
  router.post('/admin/payout', requireAdmin, async (req, res) => {
    const id = String((req.body && req.body.id) || ''), action = String((req.body && req.body.action) || '');
    if (!/^[-\w]{10,40}$/.test(id) || !['paid', 'rejected'].includes(action)) return res.status(400).json({ ok: false, message: 'ভুল অনুরোধ' });
    const sref = db.ref('referralPayouts/' + id + '/status');
    let claimed = false;
    try {
      const tr = await sref.transaction((c) => (c === 'pending' ? '__processing' : undefined));
      if (!tr.committed) return res.status(409).json({ ok: false, message: 'এই অনুরোধ আগেই প্রসেস হয়েছে' });
      claimed = true;
      const p = (await db.ref('referralPayouts/' + id).once('value')).val();
      const now = Date.now(), up = {}, trx = clip(req.body.trxId, 40), note = clip(req.body.note, 200);
      up['referralPayouts/' + id + '/status'] = action;
      up['referralPayouts/' + id + '/processedAt'] = now;
      if (trx) up['referralPayouts/' + id + '/trxId'] = trx;
      if (note) up['referralPayouts/' + id + '/note'] = note;
      up['referralMyPayouts/' + p.cid + '/' + id + '/status'] = action;
      up['referralMyPayouts/' + p.cid + '/' + id + '/processedAt'] = now;
      if (trx) up['referralMyPayouts/' + p.cid + '/' + id + '/trxId'] = trx;
      if (action === 'paid') up['referralWallets/' + p.cid + '/totalWithdrawn'] = inc(Number(p.amount) || 0);
      else {
        up['referralWallets/' + p.cid + '/balance'] = inc(Number(p.amount) || 0);          // refund
        up['referralTx/' + p.cid + '/' + db.ref('referralTx/' + p.cid).push().key] = { type: 'refund', amount: Number(p.amount) || 0, payoutId: id, at: now };
      }
      await db.ref().update(up);
      claimed = false;
      res.json({ ok: true });
    } catch (e) {
      log('payout update', String(e.message).slice(0, 200));
      if (claimed) sref.set('pending').catch(() => {});
      res.status(500).json({ ok: false, message: 'আপডেট ব্যর্থ' });
    }
  });
  router.get('/admin/config', requireAdmin, async (req, res) => { try { res.json({ ok: true, ...(await getConfig(true)) }); } catch (e) { res.status(500).json({ ok: false }); } });
  router.post('/admin/config', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      await db.ref('referralConfig').set({
        enabled: b.enabled !== false,
        gen1: num(b.gen1, 50, 0, 100000), gen2: num(b.gen2, 30, 0, 100000), gen3: num(b.gen3, 15, 0, 100000),
        minWithdraw: Math.floor(num(b.minWithdraw, 500, 1, 10000000)),
      });
      cfgCache = null;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, message: 'সেভ ব্যর্থ' }); }
  });

  app.use('/api/referral', router);
  log('mounted /api/referral/* (phone verification ' + (REQUIRE_VERIFY ? 'REQUIRED' : 'OFF — not recommended') + ')');
};
