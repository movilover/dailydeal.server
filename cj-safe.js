// CJ মডিউলের নিরাপত্তা/ভ্যালিডেশন সহায়ক — কোনো বাইরের প্যাকেজ লাগে না
export const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const str = (v, max = 500) => String(v == null ? '' : v).slice(0, max);
export const safeKey = (s) => String(s).replace(/[.#$\[\]\/]/g, '_');                      // Firebase-key নিরাপদ
// সংরক্ষণের জন্য সাধারণ টেক্সট: কন্ট্রোল ক্যারেক্টার ও < > বাদ, তাই কখনো HTML হয়ে যাবে না
export const cleanText = (v, max = 500) => str(v, max * 2).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanPhone = (v) => str(v, 30).replace(/[^\d+]/g, '').slice(0, 20);
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ইন-মেমোরি রেট লিমিটার (প্রতি IP)
export function makeLimiter(windowMs, limit) {
  const m = new Map();
  return (req, res, next) => {
    const t = Date.now(), k = req.ip || 'x'; let e = m.get(k);
    if (!e || t - e.s > windowMs) { e = { s: t, n: 0 }; m.set(k, e); }
    if (++e.n > limit) { res.setHeader('Retry-After', String(Math.ceil((e.s + windowMs - t) / 1000))); return res.status(429).json({ ok: false, message: 'Too many requests, slow down' }); }
    if (m.size > 5000) for (const [kk, v] of m) if (t - v.s > windowMs) m.delete(kk);
    next();
  };
}
// বডি থাকলে Content-Type: application/json বাধ্যতামূলক (ব্রাউজারকে CORS preflight করতে বাধ্য করে → সহজ cross-site POST আটকায়)
export const jsonOnly = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (hasBody && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return res.status(415).json({ ok: false, message: 'Content-Type must be application/json' });
  }
  next();
};
