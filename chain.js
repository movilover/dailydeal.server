import { redact } from '../secrets.js';
import { isBdIntl, needsUnicode } from './phone.js';
import { PRESETS } from './providers/index.js';
import { makeHttp } from '../net.js';

const dayKey = (t) => new Date(t + 6 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');   // Asia/Dhaka day
export const dhakaDay = dayKey;

export function createChain({ getConfig, store, now = Date.now, http = makeHttp(), log = () => {} }) {
  const breaker = new Map();                                                                      // id → {fails, openUntil}
  const open = (id) => (breaker.get(id)?.openUntil || 0) > now();
  async function stat(id, ok) {
    try { await store.transaction(`serverState/stats/${dayKey(now())}/${id}`, (c) => { c = c || { sent: 0, ok: 0, fail: 0 }; c.sent++; ok ? c.ok++ : c.fail++; return c; }); } catch { /* stats must never break sending */ }
  }
  function order(cfg, to) {
    const enabled = cfg.providers.filter((p) => p.enabled);
    const bd = isBdIntl(to);
    let list;
    if (bd) list = cfg.bdFirst ? [...enabled.filter((p) => p.region === 'bd'), ...enabled.filter((p) => p.region === 'any'), ...enabled.filter((p) => p.region === 'intl')] : enabled.slice();
    else list = enabled.filter((p) => p.region !== 'bd');
    const live = list.filter((p) => !open(p.id));
    return live.length ? live : list;                                                               // all tripped → try anyway rather than total outage
  }
  async function attempt(p, to, text) {
    const preset = PRESETS[p.type]; const secrets = Object.values(p.secrets || {});
    try {
      const r = await preset.send({ to, text, v: p.v, secrets: p.secrets, http, generic: p.generic, unicode: needsUnicode(text) });
      return r.ok ? { ok: true } : { ok: false, error: redact(r.error || 'failed', secrets) };
    } catch (e) { return { ok: false, error: redact(`${p.type}:${e.validation ? 'config' : 'error'}:${e.message}`, secrets) }; }
  }
  async function send({ to, text }) {
    const cfg = await getConfig(); const errors = [];
    const cand = order(cfg, to);
    if (!cand.length) return { ok: false, code: 'NO_PROVIDER', errors };
    for (const p of cand) {                                                                         // sequential: one SMS at a time, never duplicates
      const r = await attempt(p, to, text);
      await stat(p.id, r.ok);
      if (r.ok) { breaker.delete(p.id); return { ok: true, providerId: p.id }; }
      const b = breaker.get(p.id) || { fails: 0, openUntil: 0 }; b.fails++;
      if (b.fails >= cfg.circuit.threshold) { b.openUntil = now() + cfg.circuit.openSec * 1000; b.fails = 0; }
      breaker.set(p.id, b); errors.push({ id: p.id, error: r.error }); log('warn', 'sms-provider-failed', { providerId: p.id });
    }
    return { ok: false, code: 'SMS_FAILED', errors };
  }
  /** Admin test: one named provider only (ignores enabled flag and breaker). */
  async function sendVia(providerId, to, text) {
    const cfg = await getConfig(); const p = cfg.providers.find((x) => x.id === providerId);
    if (!p) return { ok: false, error: 'প্রোভাইডার পাওয়া যায়নি' };
    return attempt(p, to, text);
  }
  return { send, sendVia, _breaker: breaker };
}
