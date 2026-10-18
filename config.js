import crypto from 'node:crypto';
// Environment validation. Missing/invalid values stop the server with a clear message (no secrets printed).
export function loadConfig(env = process.env) {
  const errs = [];
  const need = (k) => { const v = String(env[k] ?? '').trim(); if (!v) errs.push(`${k} সেট করা নেই`); return v; };
  const saB64 = need('FIREBASE_SERVICE_ACCOUNT_B64');
  const dbUrl = need('FIREBASE_DATABASE_URL');
  const adminEmail = need('ADMIN_EMAIL').toLowerCase();
  const origins = need('ALLOWED_ORIGINS').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const encRaw = need('CONFIG_ENC_KEY');
  const hmac = need('OTP_HMAC_SECRET');
  let encKey = null;
  if (encRaw) {
    const b = /^[A-Za-z0-9+/]+={0,2}$/.test(encRaw) ? Buffer.from(encRaw, 'base64') : null;
    if (b && b.length === 32) encKey = b;                                                   // ৩২ বাইটের base64 হলে সরাসরি
    else if (encRaw.length >= 32) encKey = crypto.createHash('sha256').update(encRaw).digest(); // নইলে যেকোনো ৩২+ অক্ষরের এলোমেলো লেখা থেকে কী বানানো হয়
    else errs.push('CONFIG_ENC_KEY কমপক্ষে ৩২ অক্ষরের এলোমেলো লেখা হতে হবে');
  }
  if (hmac && hmac.length < 24) errs.push('OTP_HMAC_SECRET কমপক্ষে ২৪ অক্ষরের হতে হবে');
  for (const o of origins) if (!/^https?:\/\/[^\s*]+$/.test(o)) errs.push(`ALLOWED_ORIGINS-এ ভুল মান: ${o}`);
  if (dbUrl && !/^https:\/\//.test(dbUrl)) errs.push('FIREBASE_DATABASE_URL https:// দিয়ে শুরু হতে হবে');
  const cap = Number(env.DAILY_SMS_CAP ?? 300);
  if (!Number.isInteger(cap) || cap < 1) errs.push('DAILY_SMS_CAP ধনাত্মক পূর্ণসংখ্যা হতে হবে');
  if (errs.length) { const e = new Error('Config error: ' + errs.join('; ')); e.config = true; throw e; }
  return {
    port: Number(env.PORT) || 3000, saB64, dbUrl, adminEmail, origins, encKey, hmac,
    dailyCap: cap, appCheckEnforce: String(env.APPCHECK_ENFORCE || '').toLowerCase() === 'true',
    prod: env.NODE_ENV === 'production',
  };
}
