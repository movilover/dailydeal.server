import { encrypt, decrypt, mask } from './secrets.js';
import { PRESETS, presetList } from './otp-providers.js';
import { validateGeneric } from './otp-generic.js';

const PATH = 'serverConfig/otp';
const DEFAULT_TEMPLATE = 'Your DailyDeal code: {{code}}. Valid for 5 minutes. Do not share it with anyone.';
const bad = (m) => Object.assign(new Error(m), { validation: true });
const str = (v, max, name) => { v = String(v ?? '').trim(); if (v.length > max) throw bad(`${name} অনেক বড়`); if (/[\r\n\u0000]/.test(v)) throw bad(`${name}-এ অবৈধ অক্ষর`); return v; };

export function createOtpConfig({ store, encKey, now = Date.now, ttlMs = 20000 }) {
  let cache = null, cacheAt = 0;
  const invalidate = () => { cache = null; };
  const raw = async () => (await store.get(PATH)) || {};
  const dec = (blob) => { try { return decrypt(encKey, blob); } catch { return null; } };

  async function load() {
    if (cache && now() - cacheAt < ttlMs) return cache;
    const r = await raw(); const providers = [];
    for (const [id, p] of Object.entries(r.providers || {})) {
      const preset = PRESETS[p.type]; if (!preset) continue;
      const secrets = {}; for (const [k, b] of Object.entries(p.secrets || {})) { const d = dec(b); if (d != null) secrets[k] = d; }
      providers.push({ id, type: p.type, label: p.label || preset.label, enabled: p.enabled === true, priority: Number(p.priority) || 0, region: p.region || preset.region,
        v: { ...(p.fields || {}), ...secrets }, secrets, generic: p.generic || null, lastTestOkAt: p.lastTestOkAt || null });
    }
    providers.sort((a, b) => a.priority - b.priority);
    cache = { smsTemplate: r.smsTemplate || DEFAULT_TEMPLATE, useUnicode: r.useUnicode === true, bdFirst: r.routing?.bdFirst !== false,
      intlEnabled: r.intlEnabled === true, circuit: { threshold: r.circuit?.threshold || 3, openSec: r.circuit?.openSec || 300 }, providers };
    cacheAt = now(); return cache;
  }

  async function view() {
    const r = await raw(); const out = [];
    for (const [id, p] of Object.entries(r.providers || {})) {
      const preset = PRESETS[p.type]; if (!preset) continue;
      const secrets = {}; for (const [k, b] of Object.entries(p.secrets || {})) { const d = dec(b); secrets[k] = { set: d != null, mask: d != null ? mask(d) : '' }; }
      out.push({ id, type: p.type, label: p.label || preset.label, enabled: p.enabled === true, priority: Number(p.priority) || 0, region: p.region || preset.region,
        fields: p.fields || {}, secrets, generic: p.generic || null, lastTestOkAt: p.lastTestOkAt || null, verified: preset.verified });
    }
    out.sort((a, b) => a.priority - b.priority);
    return { smsTemplate: r.smsTemplate || DEFAULT_TEMPLATE, useUnicode: r.useUnicode === true, routing: { bdFirst: r.routing?.bdFirst !== false },
      intlEnabled: r.intlEnabled === true, providers: out, presets: presetList() };
  }

  async function save(input) {
    if (!input || typeof input !== 'object') throw bad('ভুল অনুরোধ');
    const old = await raw(); const next = {};
    const tpl = input.smsTemplate === undefined ? (old.smsTemplate || DEFAULT_TEMPLATE) : str(input.smsTemplate, 300, 'SMS টেমপ্লেট');
    if (!tpl.includes('{{code}}')) throw bad('টেমপ্লেটে {{code}} থাকতে হবে');
    next.smsTemplate = tpl;
    next.useUnicode = input.useUnicode === undefined ? old.useUnicode === true : input.useUnicode === true;
    next.intlEnabled = input.intlEnabled === undefined ? old.intlEnabled === true : input.intlEnabled === true;
    next.routing = { bdFirst: input.routing?.bdFirst === undefined ? old.routing?.bdFirst !== false : input.routing.bdFirst === true };
    next.circuit = old.circuit || { threshold: 3, openSec: 300 };
    const list = Array.isArray(input.providers) ? input.providers : null;
    if (!list || list.length > 12) throw bad('প্রোভাইডার তালিকা ভুল (সর্বোচ্চ ১২টা)');
    next.providers = {}; const seen = new Set();
    for (const p of list) {
      const id = String(p.id || '');
      if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(id) || seen.has(id)) throw bad('প্রোভাইডার আইডি ভুল/ডুপ্লিকেট: ' + id);
      seen.add(id);
      const preset = PRESETS[p.type]; if (!preset) throw bad('অজানা প্রোভাইডার টাইপ');
      const prev = old.providers?.[id]; const prevSame = prev && prev.type === p.type;
      const rec = { type: p.type, label: str(p.label || preset.label, 60, 'লেবেল'), enabled: p.enabled === true, priority: Math.max(0, Math.min(999, parseInt(p.priority, 10) || 0)),
        region: ['bd', 'intl', 'any'].includes(p.region) ? p.region : preset.region, fields: {}, secrets: {} };
      const plain = preset.fields.filter((f) => !f.secret).map((f) => f.name), sec = preset.fields.filter((f) => f.secret).map((f) => f.name);
      let changed = !prevSame;
      for (const n of plain) { const v = str(p.fields?.[n] ?? prev?.fields?.[n] ?? '', 200, n); if (v) rec.fields[n] = v; if (v !== (prev?.fields?.[n] ?? '')) changed = true; }
      const secretNames = p.type === 'generic' ? Object.keys({ ...(prevSame ? prev.secrets : {}), ...(p.secrets || {}) }) : sec;
      for (const n of secretNames) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(n)) throw bad('secret নাম ভুল: ' + n);
        const given = p.secrets?.[n];
        if (given === null) { changed = true; continue; }                                 // explicit delete
        if (typeof given === 'string' && given.trim()) { rec.secrets[n] = encrypt(encKey, str(given, 500, n)); changed = true; }
        else if (prevSame && prev.secrets?.[n]) rec.secrets[n] = prev.secrets[n];            // keep existing
      }
      if (p.type === 'generic') {
        if (Object.keys(rec.secrets).length > 8) throw bad('generic secret সর্বোচ্চ ৮টা');
        rec.generic = validateGeneric(p.generic);
        if (JSON.stringify(rec.generic) !== JSON.stringify(prev?.generic || null)) changed = true;
      } else {
        for (const f of preset.fields) if (f.required && !(f.secret ? rec.secrets[f.name] : rec.fields[f.name]) && rec.enabled) throw bad(`${rec.label}: "${f.label}" দরকার`);
        if (p.type === 'twilio' && !rec.fields.from && !rec.fields.messaging_service_sid && rec.enabled) throw bad('Twilio: From অথবা Messaging Service SID দিন');
      }
      if (!changed && prev?.lastTestOkAt) rec.lastTestOkAt = prev.lastTestOkAt;            // credentials changed → must re-test
      next.providers[id] = rec;
    }
    await store.set(PATH, next); invalidate(); return view();
  }
  const markTested = async (id) => { await store.set(`${PATH}/providers/${id}/lastTestOkAt`, now()); invalidate(); };
  const hasTestedProvider = async () => (await raw(), Object.values((await raw()).providers || {}).some((p) => p.enabled === true && p.lastTestOkAt));
  return { load, view, save, markTested, hasTestedProvider, invalidate };
}
