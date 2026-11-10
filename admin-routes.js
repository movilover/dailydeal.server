import express from 'express';
import admin from 'firebase-admin';               // ← আপনার সার্ভারে যদি আলাদা admin-হেল্পার থাকে, সেটাই ব্যবহার করুন
import { normalizeBD } from './otp-phone.js';
import { FLAG_KEYS } from './flags.js';
import { dhakaDay } from './otp-chain.js';
import { log } from './log.js';

/* ═══ রিসেলার পাসওয়ার্ড সেটের জন্য — ২টা জায়গা আপনার বর্তমান রিসেলার লগইন কোডের সাথে মেলাতে হবে ═══ */

// (১) রিসেলারের Firebase Auth ইমেইল কীভাবে বানানো হয় — লগইন কোডে যেটা আছে হুবহু সেটা বসান
const resellerAuthEmail = (phone) => `${phone}@reseller.dailydeal.world`;

// (২) পুরনো (এখনো মাইগ্রেট না হওয়া) রিসেলারের PIN যেভাবে হ্যাশ হয় — লগইন কোডের হ্যাশ ফাংশনটাই এখানে ডাকুন।
//     না জানলে এটা এভাবেই রাখুন; তখন ওই রিসেলারদের জন্য পরিষ্কার বার্তা যাবে।
async function legacyHashPin(_phone, _pin) { const e = new Error('legacy'); e.legacy = true; throw e; }

export function adminRoutes({ auth, otpConfig, chain, store, flags, cfg, otp }) {
  const r = express.Router();
  r.use(auth.requireAppCheck, auth.requireAdmin);
  const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e.validation) return res.status(400).json({ ok: false, message: e.message }); log('error', 'admin-error', { err: e.message }); res.status(500).json({ ok: false, message: 'সার্ভার ত্রুটি' }); } };

  r.get('/otp/config', guard(async (_q, res) => res.json({ ok: true, ...(await otpConfig.view()) })));
  r.put('/otp/config', guard(async (req, res) => res.json({ ok: true, ...(await otpConfig.save(req.body)) })));
  r.post('/otp/test', guard(async (req, res) => {
    const phone = normalizeBD(req.body?.phone); const id = String(req.body?.providerId || '');
    if (!phone || !id) return res.status(400).json({ ok: false, message: 'প্রোভাইডার ও নম্বর দিন' });
    if (!(await otp.hit('serverState/rate/admintest', 3600e3, 10))) return res.status(429).json({ ok: false, message: 'টেস্ট সীমা শেষ (ঘণ্টায় ১০)' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const oc = await otpConfig.load();
    const r2 = await chain.sendVia(id, '88' + phone, oc.smsTemplate.replace('{{code}}', code));
    if (r2.ok) await otpConfig.markTested(id);
    res.json({ ok: r2.ok, message: r2.ok ? 'টেস্ট এসএমএস পাঠানো হয়েছে' : (r2.error || 'ব্যর্থ') });
  }));
  r.get('/otp/stats', guard(async (_q, res) => {
    const days = []; for (let i = 0; i < 7; i++) days.push(dhakaDay(Date.now() - i * 86400e3));
    const stats = {}; for (const d of days) stats[d] = (await store.get(`serverState/stats/${d}`)) || {};
    const used = (await store.get(`serverState/rate/global/day_${dhakaDay(Date.now())}`))?.n || 0;
    res.json({ ok: true, stats, today: { used, cap: cfg.dailyCap }, flags: await flags.all() });
  }));
  // Master switch. Enabling requires at least one enabled provider with a successful test (a client-side guard alone could be bypassed).
  r.post('/otp/master', guard(async (req, res) => {
    const on = req.body?.enable === true;
    if (on && !(await otpConfig.hasTestedProvider())) return res.status(409).json({ ok: false, message: 'আগে অন্তত একটা চালু প্রোভাইডার দিয়ে টেস্ট এসএমএস সফল করুন।' });
    await store.update('settings/settings', { phoneVerify: on }); flags.bust(); log('info', 'otp-master', { on });
    res.json({ ok: true, phoneVerify: on });
  }));
  r.post('/otp/emergency-off', guard(async (_q, res) => {
    const off = {}; for (const k of FLAG_KEYS) off[k] = false;
    await store.update('settings/settings', off); flags.bust(); log('warn', 'otp-emergency-off');
    res.json({ ok: true });
  }));

  // ══ অ্যাডমিন: রিসেলারের নতুন পাসওয়ার্ড/PIN সেট ══  (POST /admin/reseller/set-pin)
  r.post('/reseller/set-pin', guard(async (req, res) => {
    const bad = (m) => { const e = new Error(m); e.validation = true; return e; };
    const phone = normalizeBD(req.body?.phone);
    const pin = String(req.body?.pin ?? '');
    if (!phone) throw bad('ফোন নম্বর ঠিক নয়');
    const minLen = Number(await store.get('settings/settings/minPinLength')) === 8 ? 8 : 6;
    if (!/^\d+$/.test(pin) || pin.length < minLen || pin.length > 12) throw bad(`PIN শুধু সংখ্যা ও কমপক্ষে ${minLen} ডিজিট হতে হবে`);
    if (!(await otp.hit('serverState/rate/adminsetpin', 60e3, 20))) return res.status(429).json({ ok: false, message: 'একটু পরে চেষ্টা করুন' });

    const rec = await store.get(`resellers/${phone}`);
    if (!rec) return res.status(404).json({ ok: false, message: 'রিসেলার পাওয়া যায়নি' });

    try {
      if (rec.authMigrated === true) {
        const u = await admin.auth().getUserByEmail(resellerAuthEmail(phone));
        await admin.auth().updateUser(u.uid, { password: pin });
        await admin.auth().revokeRefreshTokens(u.uid);      // চালু থাকা সব সেশন বের হয়ে যাবে
      } else {
        await store.update(`resellers/${phone}`, { pin: await legacyHashPin(phone, pin) });
      }
    } catch (e) {
      if (e.legacy) return res.status(409).json({ ok: false, message: 'এই রিসেলার এখনো পুরনো লগইনে আছে। সে একবার লগইন করে নতুন সিস্টেমে গেলে তারপর পাসওয়ার্ড সেট করুন।' });
      if (e.code === 'auth/user-not-found') return res.status(404).json({ ok: false, message: 'এই রিসেলারের লগইন অ্যাকাউন্ট পাওয়া যায়নি (ইমেইল ফরম্যাট মিলিয়ে দেখুন)' });
      throw e;
    }

    // অডিট লগ — PIN কখনো লেখা হয় না
    await store.update('adminAuditLog', { [`${Date.now()}_${phone}`]: { action: 'reseller_pin_set', resellerPhone: phone, by: req.admin?.email || req.user?.email || 'admin', at: Date.now() } });
    log('info', 'reseller-pin-set', { phone });
    res.json({ ok: true, message: 'পাসওয়ার্ড বদলানো হয়েছে' });
  }));

  return r;
}
