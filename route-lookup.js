import express from 'express';
import crypto from 'node:crypto';
import { RESELLER_DOMAIN } from './otp-phone.js';

const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : ''; } catch { return ''; } };
export function lookupRoutes({ auth, store, otp }) {
  const r = express.Router();
  r.use(auth.requireAppCheck, auth.requireUser);

  // Order status by public order id + last 4 digits of the phone (replaces the client-side orderByChild('id') query that rules deny).
  r.post('/orders/track', async (req, res) => {
    const id = String(req.body?.id ?? '').trim(), last4 = String(req.body?.last4 ?? '');
    if (!/^[A-Za-z0-9_#-]{1,40}$/.test(id) || !/^\d{4}$/.test(last4)) return res.status(400).json({ ok: false, code: 'BAD_REQ' });
    const k = (s) => String(s).replace(/[.#$\[\]\/:]/g, '_');
    if (!(await otp.hit(`serverState/rate/track/ip/${k(req.ip)}`, 3600e3, 40)) || !(await otp.hit(`serverState/rate/track/id/${k(id)}`, 3600e3, 10))) return res.status(429).json({ ok: false, code: 'RATE' });
    const cands = [id, ...(/^\d+$/.test(id) ? [Number(id)] : [])];
    let hit = null;
    for (const node of ['orders', 'orderArchive']) {
      for (const c of cands) { const rows = await store.queryEqual(node, 'id', c); hit = rows.find((o) => String(o.phone || '').slice(-4) === last4); if (hit) break; }
      if (hit) break;
    }
    if (!hit) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });                         // same answer for "no such id" and "wrong digits"
    res.json({ ok: true, order: { fbKey: hit.key, id: hit.id, status: hit.status, trackingLink: safeUrl(hit.trackingLink) || null, courier: hit.courier || null, trackId: hit.trackId || null,
      trackNote: hit.trackNote || null, trackLog: Array.isArray(hit.trackLog) ? hit.trackLog.slice(-30) : null, timestamp: hit.timestamp || null, userHidden: hit.userHidden === true } });
  });

  // Reseller-only customer reputation lookup (so customerStats can be closed to direct client reads).
  r.post('/stats/lookup', async (req, res) => {
    const m = /^(01[0-9]{9})@r\.dailydeal\.world$/.exec(req.user.email); const rp = m && m[1];
    if (!rp || (await store.get(`resellers/${rp}/status`)) !== 'approved') return res.status(403).json({ ok: false, code: 'FORBIDDEN' });
    const ph = String(req.body?.phone || '').replace(/\D/g, '').slice(-11);
    if (ph.length < 11) return res.status(400).json({ ok: false, code: 'BAD_REQ' });
    if (!(await otp.hit(`serverState/rate/stats/${rp}`, 3600e3, 120))) return res.status(429).json({ ok: false, code: 'RATE' });
    const hash = crypto.createHash('sha256').update('dd-cust:' + ph).digest('hex');                // identical to the site's _phoneHash
    const s = await store.get('customerStats/' + hash);
    res.json({ ok: true, stats: s ? { total: Number(s.total) || 0, delivered: Number(s.delivered) || 0, cancelled: Number(s.cancelled) || 0, lastOrderAt: Number(s.lastOrderAt) || 0 } : null });
  });
  return r;
}
