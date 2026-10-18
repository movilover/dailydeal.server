import crypto from 'node:crypto';
import { dhakaDay } from './chain.js';

const TTL_MS = 5 * 60e3, MAX_TRIES = 5, LOCK_MS = 15 * 60e3;
const safeKey = (s) => String(s).replace(/[.#$\[\]\/:]/g, '_').slice(0, 60);

export function createOtpService({ store, cfg, chain, getOtpConfig, setClaims, now = Date.now, randomInt = crypto.randomInt }) {
  const hmac = (phone, purpose, code) => crypto.createHmac('sha256', cfg.hmac).update(`${phone}|${purpose}|${code}`).digest('hex');
  const recPath = (purpose, phone) => `serverState/otp/${purpose}/${phone}`;

  async function hit(path, windowMs, max) {
    const r = await store.transaction(path, (cur) => {
      const t = now();
      if (!cur || t - cur.s >= windowMs) return { s: t, n: 1 };
      if (cur.n >= max) return undefined;
      return { s: cur.s, n: cur.n + 1 };
    });
    return r.committed;
  }

  async function send({ phone, purpose, uid, ip }) {
    const rec = await store.get(recPath(purpose, phone));
    if (rec && rec.lockUntil > now()) return { ok: false, code: 'LOCKED' };
    const ipk = safeKey(ip || 'unknown');
    const checks = [
      [`serverState/rate/phone/${phone}/m`, 60e3, 1], [`serverState/rate/phone/${phone}/h`, 3600e3, 5], [`serverState/rate/phone/${phone}/d`, 86400e3, 10],
      [`serverState/rate/ip/${ipk}/h`, 3600e3, 20], [`serverState/rate/uid/${safeKey(uid)}/h`, 3600e3, 10],
    ];
    for (const [p, w, m] of checks) if (!(await hit(p, w, m))) return { ok: false, code: 'RATE' };
    if (!(await hit(`serverState/rate/global/day_${dhakaDay(now())}`, 86400e3, cfg.dailyCap))) return { ok: false, code: 'CAP' };

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const oc = await getOtpConfig();
    await store.set(recPath(purpose, phone), { h: hmac(phone, purpose, code), exp: now() + TTL_MS, tries: 0, uid, at: now() });
    const text = oc.smsTemplate.replace('{{code}}', code);
    const r = await chain.send({ to: '88' + phone, text });
    if (!r.ok) { await store.remove(recPath(purpose, phone)); return { ok: false, code: r.code || 'SMS_FAILED' }; }
    return { ok: true };
  }

  async function verify({ phone, purpose, code, uid }) {
    let outcome = null, snap = null;
    const r = await store.transaction(recPath(purpose, phone), (cur) => {
      const t = now();
      if (!cur || cur.exp < t) { outcome = 'EXPIRED'; return undefined; }
      if (cur.lockUntil > t) { outcome = 'LOCKED'; return undefined; }
      if (cur.tries >= MAX_TRIES) { outcome = 'LOCKED'; return { ...cur, lockUntil: t + LOCK_MS }; }
      snap = cur; return { ...cur, tries: cur.tries + 1 };                                           // attempt is counted BEFORE comparing
    });
    if (!r.committed && !snap) return { ok: false, code: outcome || 'EXPIRED' };
    if (outcome === 'LOCKED') return { ok: false, code: 'LOCKED' };
    const a = Buffer.from(hmac(phone, purpose, code), 'hex'), b = Buffer.from(snap.h, 'hex');
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) {
      const tries = snap.tries + 1;
      if (tries >= MAX_TRIES) await store.update(recPath(purpose, phone), { lockUntil: now() + LOCK_MS });
      return { ok: false, code: 'INVALID', left: Math.max(0, MAX_TRIES - tries) };
    }
    await store.remove(recPath(purpose, phone));                                                      // single use
    await setClaims(uid, { vph: phone, vat: Math.floor(now() / 1000) });
    return { ok: true };
  }

  async function cleanup() {
    const t = now(); let n = 0;
    const otp = (await store.get('serverState/otp')) || {};
    for (const [pu, phones] of Object.entries(otp)) for (const [ph, r] of Object.entries(phones || {})) if ((r.exp || 0) < t && !((r.lockUntil || 0) > t)) { await store.remove(`serverState/otp/${pu}/${ph}`); n++; }
    for (const scope of ['phone', 'ip', 'uid']) {
      const s = (await store.get(`serverState/rate/${scope}`)) || {};
      for (const [id, wins] of Object.entries(s)) for (const [w, v] of Object.entries(wins || {})) if (t - (v.s || 0) > 2 * 86400e3) { await store.remove(`serverState/rate/${scope}/${id}/${w}`); n++; }
    }
    return n;
  }
  return { send, verify, cleanup, hit };
}
