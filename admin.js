import express from 'express';
import { normalizeBD } from '../otp/phone.js';
import { FLAG_KEYS } from '../flags.js';
import { dhakaDay } from '../otp/chain.js';
import { log } from '../log.js';

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
  return r;
}
