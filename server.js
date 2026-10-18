import admin from 'firebase-admin';
import { loadConfig } from './config.js';
import { rtdbStore } from './store.js';
import { buildApp } from './app.js';
import { log } from './log.js';

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }

// FIREBASE_SERVICE_ACCOUNT_B64: base64 করা JSON অথবা সরাসরি JSON (দুটোই চলে)
let sa;
try {
  const raw = cfg.saB64.trim();
  sa = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch { console.error('FIREBASE_SERVICE_ACCOUNT_B64 পড়া যায়নি: সার্ভিস-অ্যাকাউন্ট JSON ফাইলের পুরো লেখা (অথবা তার base64) বসাতে হবে'); process.exit(1); }
for (const k of ['project_id', 'client_email', 'private_key']) {
  if (typeof sa[k] !== 'string' || !sa[k]) { console.error(`সার্ভিস-অ্যাকাউন্টে "${k}" নেই। Firebase Console থেকে নেওয়া আসল JSON ফাইলটি দিন`); process.exit(1); }
}
try { admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: cfg.dbUrl }); }
catch (e) { console.error('Firebase চালু করা যায়নি: ' + String(e.message).slice(0, 200)); process.exit(1); }

process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { err: String(e && e.message).slice(0, 200) }));
const { app, otp } = buildApp({ cfg, store: rtdbStore(admin.database()), adminAuth: admin.auth(), appCheck: admin.appCheck() });
const srv = app.listen(cfg.port, () => log('info', 'listening', { port: cfg.port }));
setInterval(() => otp.cleanup().catch((e) => log('error', 'cleanup', { err: e.message })), 10 * 60e3).unref();
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
