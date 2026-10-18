import admin from 'firebase-admin';
import { loadConfig } from '../config.js';
import { rtdbStore } from './store.js';
import { buildApp } from './app.js';
import { log } from './log.js';

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
let sa;
try { sa = JSON.parse(Buffer.from(cfg.saB64, 'base64').toString('utf8')); } catch { console.error('FIREBASE_SERVICE_ACCOUNT_B64 পড়া যায়নি (base64 করা JSON হতে হবে)'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: cfg.dbUrl });
const { app, otp } = buildApp({ cfg, store: rtdbStore(admin.database()), adminAuth: admin.auth(), appCheck: admin.appCheck() });
const srv = app.listen(cfg.port, () => log('info', 'listening', { port: cfg.port }));
setInterval(() => otp.cleanup().catch((e) => log('error', 'cleanup', { err: e.message })), 10 * 60e3).unref();
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
