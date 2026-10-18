import { checkUrl } from './net.js';
const PH = /\{\{(to|text|sender|secret\.[A-Za-z0-9_]{1,40})\}\}/g;
const bad = (m) => { const e = new Error(m); e.validation = true; return e; };
const clean = (s) => String(s).replace(/[\r\n]/g, ' ');

/** Validate + normalise admin-supplied Generic-HTTP provider definition. Throws {validation:true}. */
export function validateGeneric(g) {
  if (!g || typeof g !== 'object') throw bad('generic কনফিগ দরকার');
  const method = String(g.method || 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw bad('method GET/POST হতে হবে');
  const url = String(g.url || '').trim();
  if (!url || url.length > 500) throw bad('url দরকার (সর্বোচ্চ ৫০০ অক্ষর)');
  const allowHttp = g.allowHttp === true;
  const probe = url.replace(PH, 'x');
  try { checkUrl(probe, { allowHttp }); } catch (e) { throw bad('url গ্রহণযোগ্য নয় (' + e.message + ')'); }
  if (/^\{\{/.test(url)) throw bad('url-এর শুরুতে প্লেসহোল্ডার চলবে না');
  const headers = {};
  const hs = g.headers && typeof g.headers === 'object' ? Object.entries(g.headers) : [];
  if (hs.length > 20) throw bad('হেডার সর্বোচ্চ ২০টা');
  for (const [k, v] of hs) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(k) || /^(host|content-length|transfer-encoding|connection)$/i.test(k)) throw bad('হেডার নাম গ্রহণযোগ্য নয়: ' + k);
    headers[k] = clean(v).slice(0, 500);
  }
  const bodyType = ['form', 'json', 'query', 'none'].includes(g.bodyType) ? g.bodyType : (method === 'GET' ? 'query' : 'form');
  const body = g.body && typeof g.body === 'object' ? g.body : {};
  if (JSON.stringify(body).length > 4000) throw bad('body অনেক বড়');
  const s = g.success && typeof g.success === 'object' ? g.success : { type: 'status', codes: [200] };
  let success;
  if (s.type === 'json') {
    if (!/^[A-Za-z0-9_.\[\]-]{1,100}$/.test(String(s.path || ''))) throw bad('success.path ভুল');
    success = { type: 'json', path: String(s.path), equals: String(s.equals ?? '') };
  } else if (s.type === 'text') {
    if (!String(s.contains || '')) throw bad('success.contains দরকার');
    success = { type: 'text', contains: String(s.contains).slice(0, 200) };
  } else {
    const codes = (Array.isArray(s.codes) ? s.codes : [200]).map(Number).filter((n) => n >= 100 && n <= 599).slice(0, 10);
    if (!codes.length) throw bad('success.codes ভুল');
    success = { type: 'status', codes };
  }
  return { method, url, allowHttp, headers, bodyType, body, success };
}

function fill(str, ctx, mode) {
  return String(str).replace(PH, (_, k) => {
    let v;
    if (k.startsWith('secret.')) { v = ctx.secrets[k.slice(7)]; if (v == null) throw bad('secret পাওয়া যায়নি: ' + k.slice(7)); }
    else v = ctx[k];
    v = String(v ?? '');
    return mode === 'url' ? encodeURIComponent(v) : mode === 'header' ? clean(v) : v;
  });
}
const fillDeep = (x, ctx) => typeof x === 'string' ? fill(x, ctx, 'raw') : Array.isArray(x) ? x.map((i) => fillDeep(i, ctx)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillDeep(v, ctx)])) : x;
const pick = (obj, path) => String(path).replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export async function sendGeneric({ to, text, sender, secrets, http, generic }) {
  const g = validateGeneric(generic);
  const ctx = { to, text, sender: sender || '', secrets: secrets || {} };
  let url = fill(g.url, ctx, 'url');
  checkUrl(url, { allowHttp: g.allowHttp });
  const headers = Object.fromEntries(Object.entries(g.headers).map(([k, v]) => [k, fill(v, ctx, 'header')]));
  const opts = { method: g.method, headers };
  const filled = fillDeep(g.body, ctx);
  if (g.bodyType === 'query') { const q = new URLSearchParams(Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, String(v)]))).toString(); if (q) url += (url.includes('?') ? '&' : '?') + q; }
  else if (g.bodyType === 'form') opts.form = Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, String(v)]));
  else if (g.bodyType === 'json') opts.json = filled;
  const r = await http(url, opts);
  let ok = false;
  if (g.success.type === 'status') ok = g.success.codes.includes(r.status);
  else if (g.success.type === 'json') ok = r.status < 400 && String(pick(r.json, g.success.path)) === g.success.equals;
  else ok = r.status < 400 && r.text.includes(g.success.contains);
  return ok ? { ok: true } : { ok: false, error: `generic:${r.status}:${String(r.text).slice(0, 120)}` };
}
