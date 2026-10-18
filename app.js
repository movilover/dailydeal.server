import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createAuth } from './auth.js';
import { createFlags } from './flags.js';
import { createOtpConfig } from './otp/config.js';
import { createChain } from './otp/chain.js';
import { createOtpService } from './otp/service.js';
import { otpRoutes } from './routes/otp.js';
import { adminRoutes } from './routes/admin.js';
import { lookupRoutes } from './routes/lookup.js';
import { makeHttp } from './net.js';
import { log } from './log.js';

export function buildApp({ cfg, store, adminAuth, appCheck, http = makeHttp(), now = Date.now }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));
  const allowed = new Set(cfg.origins);
  app.use((req, res, next) => { const o = req.headers.origin; if (o && !allowed.has(o)) return res.status(403).json({ ok: false, code: 'ORIGIN' }); next(); });
  app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.has(o)), allowedHeaders: ['Authorization', 'Content-Type', 'X-Firebase-AppCheck'], methods: ['GET', 'POST', 'PUT', 'OPTIONS'], maxAge: 600 }));
  // coarse per-IP flood guard (in-memory; fine-grained limits live in the store)
  const flood = new Map();
  app.use((req, res, next) => { const t = now(), k = req.ip; const e = flood.get(k); if (!e || t - e.s > 60e3) flood.set(k, { s: t, n: 1 }); else if (++e.n > 120) return res.status(429).json({ ok: false, code: 'RATE' }); if (flood.size > 5000) flood.clear(); next(); });

  const otpConfig = createOtpConfig({ store, encKey: cfg.encKey, now });
  const chain = createChain({ getConfig: otpConfig.load, store, now, http, log });
  const flags = createFlags({ store, now });
  const auth = createAuth({ adminAuth, appCheck, cfg });
  const setClaims = (uid, c) => adminAuth.setCustomUserClaims(uid, c);
  const otp = createOtpService({ store, cfg, chain, getOtpConfig: otpConfig.load, setClaims, now });

  app.get('/healthz', (_q, res) => res.json({ ok: true, t: now() }));
  app.use('/otp', otpRoutes({ auth, otp, flags, adminAuth, store }));
  app.use('/admin', adminRoutes({ auth, otpConfig, chain, store, flags, cfg, otp }));
  app.use('/', lookupRoutes({ auth, store, otp }));
  app.use((_q, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND' }));
  app.use((err, _q, res, _n) => { log('error', 'unhandled', { err: err.message }); res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ ok: false, code: 'ERR' }); });
  return { app, otp, chain, otpConfig, flags };
}
