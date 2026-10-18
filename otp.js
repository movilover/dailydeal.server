import express from 'express';
import crypto from 'node:crypto';
import { normalizeBD, PURPOSES, RESELLER_DOMAIN } from '../otp/phone.js';
import { log } from '../log.js';

const MSG = {
  DISABLED: 'এই যাচাই এখন চালু নেই।', RATE: 'অনেকবার চেষ্টা হয়েছে, কিছুক্ষণ পরে আবার চেষ্টা করুন।', LOCKED: 'অনেকবার ভুল কোড দেওয়া হয়েছে, ১৫ মিনিট পরে চেষ্টা করুন।',
  CAP: 'সার্ভিস এখন ব্যস্ত, একটু পরে চেষ্টা করুন।', SMS_FAILED: 'এসএমএস পাঠানো যায়নি, একটু পরে চেষ্টা করুন।', NO_PROVIDER: 'এসএমএস সার্ভিস এখন প্রস্তুত নয়।',
  INVALID: 'কোডটি সঠিক নয়।', EXPIRED: 'কোডের মেয়াদ শেষ বা পাওয়া যায়নি, নতুন কোড নিন।', BAD_PHONE: 'সঠিক মোবাইল নম্বর দিন।', BAD_REQ: 'অনুরোধ সঠিক নয়।',
  FORBIDDEN: 'অনুমতি নেই।', NO_ACCOUNT: 'এই নম্বরে কোনো রিসেলার অ্যাকাউন্ট নেই।', NOT_VERIFIED: 'আগে ফোন যাচাই করুন।',
};
const fail = (res, status, code, extra = {}) => res.status(status).json({ ok: false, code, message: MSG[code] || '', ...extra });

export function otpRoutes({ auth, otp, flags, adminAuth, store, rl }) {
  const r = express.Router();
  r.use(auth.requireAppCheck, auth.requireUser);

  const ctx = async (req, res) => {
    const { phone: raw, purpose } = req.body || {};
    const phone = normalizeBD(raw);
    if (!phone) { fail(res, 400, 'BAD_PHONE'); return null; }
    const P = PURPOSES[purpose]; if (!P) { fail(res, 400, 'BAD_REQ'); return null; }
    if (!(await flags.on(P.flag))) { fail(res, 403, 'DISABLED'); return null; }
    if (P.reseller && req.user.email !== phone + RESELLER_DOMAIN) { fail(res, 403, 'FORBIDDEN'); return null; }
    return { phone, purpose };
  };

  r.post('/send', async (req, res) => {
    try {
      const c = await ctx(req, res); if (!c) return;
      const out = await otp.send({ ...c, uid: req.user.uid, ip: req.ip });
      log('info', 'otp-send', { phone: c.phone, purpose: c.purpose, ok: out.ok, code: out.code });
      if (!out.ok) return fail(res, out.code === 'RATE' || out.code === 'LOCKED' ? 429 : 503, out.code);
      res.json({ ok: true, ttl: 300 });                                                              // same reply whether or not an account exists
    } catch (e) { log('error', 'otp-send-error', { err: e.message }); fail(res, 500, 'SMS_FAILED'); }
  });

  r.post('/verify', async (req, res) => {
    try {
      const c = await ctx(req, res); if (!c) return;
      const code = String(req.body?.code ?? ''); if (!/^\d{6}$/.test(code)) return fail(res, 400, 'INVALID', { left: null });
      const out = await otp.verify({ ...c, code, uid: req.user.uid });
      log('info', 'otp-verify', { phone: c.phone, purpose: c.purpose, ok: out.ok, code: out.code });
      if (!out.ok) return fail(res, out.code === 'LOCKED' ? 429 : 400, out.code, out.left != null ? { left: out.left } : {});
      res.json({ ok: true });
    } catch (e) { log('error', 'otp-verify-error', { err: e.message }); fail(res, 500, 'SMS_FAILED'); }
  });

  // PIN reset: caller must hold a fresh `vph` claim for this phone (from purpose=pin_reset). Replaces the Auth password of the reseller account.
  r.post('/reset-pin', async (req, res) => {
    try {
      const phone = normalizeBD(req.body?.phone); const pinHash = String(req.body?.pinHash || '');
      if (!phone || !/^[0-9a-f]{64}$/.test(pinHash)) return fail(res, 400, 'BAD_REQ');
      if (!(await flags.on('verifyPinReset'))) return fail(res, 403, 'DISABLED');
      const c = req.user.claims;
      if (c.vph !== phone || !(Number(c.vat) * 1000 > Date.now() - 10 * 60e3)) return fail(res, 403, 'NOT_VERIFIED');
      if (!(await otp.hit(`serverState/rate/reset/${phone}`, 3600e3, 3))) return fail(res, 429, 'RATE');
      let u; try { u = await adminAuth.getUserByEmail(phone + RESELLER_DOMAIN); } catch { return fail(res, 404, 'NO_ACCOUNT'); }
      await adminAuth.updateUser(u.uid, { password: pinHash.slice(0, 24) + 'Dd@' + phone });        // same derivation as the site (derivePw)
      await adminAuth.revokeRefreshTokens(u.uid);
      await adminAuth.setCustomUserClaims(req.user.uid, { vph: null, vat: null }); // one reset per verification
      log('info', 'pin-reset', { phone });
      res.json({ ok: true });
    } catch (e) { log('error', 'reset-pin-error', { err: e.message }); fail(res, 500, 'SMS_FAILED'); }
  });
  return r;
}
