import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createAuth } from './auth.js';
import { createFlags } from './flags.js';
import { createOtpConfig } from './otp-config.js';
import { createChain } from './otp-chain.js';
import { createOtpService } from './otp-service.js';
import { otpRoutes } from './route-otp.js';
import { adminRoutes } from './route-admin.js';
import { lookupRoutes } from './route-lookup.js';
import { makeHttp } from './net.js';
import { log } from './log.js';

// Express-এর res.status/res.json-এর উপর নির্ভর না করে সরাসরি JSON পাঠায় — এরর-হ্যান্ডলার নিজে আর কখনো ভাঙবে না
function sendJson(res, code, obj) {
  try {
    if (res.headersSent || res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  } catch { /* ignore */ }
}

export function buildApp({ cfg, store, adminAuth, appCheck, http = makeHttp(), now = Date.now, extra }) {
  const app = express();
  // Render/Railway-র সামনে যতগুলো প্রক্সি, ততটা বিশ্বাস করা হয় (ডিফল্ট ১)। Render-এ আইপি ভুল এলে Environment-এ TRUST_PROXY_HOPS=2 দিন
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  app.set('trust proxy', Number.isInteger(hops) && hops >= 0 && hops <= 5 ? hops : 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));   // পড়ার অনুমতি CORS ঠিক করে; এটি না দিলে ব্রাউজার ডায়াগনস্টিক আটকায়
  app.use(express.json({ limit: '32kb' }));
  const allowed = new Set(cfg.origins);
  // /healthz সবার জন্য খোলা এবং যেকোনো Origin-এ উত্তর দেয়; শুধু জানায় কলারের Origin অনুমোদিত কিনা। অ্যাডমিন প্যানেল এ থেকে CORS-ভুল ধরে।
  app.get('/healthz', (req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); const o = req.headers.origin; sendJson(res, 200, { ok: true, t: now(), originAllowed: o ? allowed.has(o) : null, ip: req.ip }); });
  app.use((req, res, next) => { const o = req.headers.origin; if (o && !allowed.has(o)) return sendJson(res, 403, { ok: false, code: 'ORIGIN' }); next(); });
  app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.has(o)), allowedHeaders: ['Authorization', 'Content-Type', 'X-Firebase-AppCheck'], methods: ['GET', 'POST', 'PUT', 'OPTIONS'], maxAge: 600 }));
  // coarse per-IP flood guard (in-memory; fine-grained limits live in the store)
  const flood = new Map();
  app.use((req, res, next) => { const t = now(), k = req.ip; const e = flood.get(k); if (!e || t - e.s > 60e3) flood.set(k, { s: t, n: 1 }); else if (++e.n > 120) return sendJson(res, 429, { ok: false, code: 'RATE' }); if (flood.size > 5000) flood.clear(); next(); });

  // অতিরিক্ত রুট (যেমন রেফারেল /api/referral/*) — সবসময় 404 হ্যান্ডলারের আগে বসে
  if (typeof extra === 'function') extra(app);

  const otpConfig = createOtpConfig({ store, encKey: cfg.encKey, now });
  const chain = createChain({ getConfig: otpConfig.load, store, now, http, log });
  const flags = createFlags({ store, now });
  const auth = createAuth({ adminAuth, appCheck, cfg });
  const setClaims = (uid, c) => adminAuth.setCustomUserClaims(uid, c);
  const otp = createOtpService({ store, cfg, chain, getOtpConfig: otpConfig.load, setClaims, now });

  app.use('/otp', otpRoutes({ auth, otp, flags, adminAuth, store }));
  app.use('/admin', adminRoutes({ auth, otpConfig, chain, store, flags, cfg, otp }));
  app.use('/', lookupRoutes({ auth, store, otp }));
  app.use((_q, res) => sendJson(res, 404, { ok: false, code: 'NOT_FOUND' }));
  // এরর-হ্যান্ডলার: আসল এরর + স্ট্যাকের প্রথম লাইনগুলো লগে আসে, ক্লায়েন্টকে নিরাপদ উত্তর যায়
  app.use((err, _q, res, _n) => {
    log('error', 'unhandled', { err: String(err && err.message).slice(0, 200), at: String(err && err.stack).split('\n').slice(1, 3).join(' | ').slice(0, 300) });
    sendJson(res, err && err.type === 'entity.parse.failed' ? 400 : 500, { ok: false, code: 'ERR' });
  });
  return { app, otp, chain, otpConfig, flags };
}
