// CJdropshipping মূল লজিক: টোকেন ক্যাশ + থ্রটল, এক্সচেঞ্জ রেট, প্রাইসিং ইঞ্জিন, ইমপোর্ট, সিঙ্ক।
// সব ডেটা serverState/cj/* এ থাকে (সার্ভার-অনলি; ব্রাউজার কখনো পড়ে না — আপনার OTP ডেটার মতোই)।
import { N, clamp, str, safeKey, cleanText, HttpError } from './cj-safe.js';

export const ROOT = 'serverState/cj';
export const DEFAULT_SETTINGS = {
  pricing: { global: { mode: 'percent', value: 30 }, extraFixed: 0, extraPct: 0, includeShipping: false, rounding: 'integer', compareAtPct: 20 },
  fx: { mode: 'auto', manualRate: 0, currency: 'BDT' },
  delivery: { whatsapp: '', defaultMode: 'fixed', defaultFee: 0, byCountry: {}, byRegion: {}, byCategory: {}, methods: [] },
  sync: { autoStock: false, autoPrice: false, intervalHours: 12, defaultStockIfUnknown: 50 },
  categoryMap: {},
};
export const deepMerge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object' && !Array.isArray(a[k])) ? deepMerge(a[k], b[k]) : b[k]; return o; };
const round2 = (v) => Math.round(v * 100) / 100;
const clean = (o) => JSON.parse(JSON.stringify(o));                       // undefined বাদ (RTDB undefined নেয় না)

/* ───────────── প্রাইসিং ইঞ্জিন (খাঁটি ফাংশন) ───────────── */
export const validRule = (r) => !!r && (r.mode === 'percent' || r.mode === 'fixed') && Number.isFinite(Number(r.value)) && Number(r.value) >= 0 && Number(r.value) <= (r.mode === 'percent' ? 1000 : 1e7);
function roundPrice(v, mode) {
  if (mode === 'none') return Math.round(v * 100) / 100;
  if (mode === 'nearest5') return Math.round(v / 5) * 5;
  if (mode === 'nearest10') return Math.round(v / 10) * 10;
  return Math.round(v);
}
// অগ্রাধিকার: প্রোডাক্ট রুল → ক্যাটাগরি রুল → গ্লোবাল রুল। সব অঙ্ক সাইটের কারেন্সিতে (BDT)।
export function computePrice({ costUsd, shippingUsd = 0, fx, settings, rules, pid, categoryId, ruleOverride }) {
  const P = settings.pricing; let rule, source;
  if (validRule(ruleOverride)) { rule = ruleOverride; source = 'product'; }
  else if (pid && validRule(rules.products[safeKey(pid)])) { rule = rules.products[safeKey(pid)]; source = 'product'; }
  else if (categoryId && validRule(rules.categories[safeKey(categoryId)])) { rule = rules.categories[safeKey(categoryId)]; source = 'category'; }
  else { rule = P.global; source = 'global'; }
  const supplier = N(costUsd) * fx;
  const shipping = P.includeShipping ? N(shippingUsd) * fx : 0;
  const extra = N(P.extraFixed) + (supplier * N(P.extraPct)) / 100;
  const base = supplier + shipping + extra;
  const profit = rule.mode === 'fixed' ? N(rule.value) : (supplier * N(rule.value)) / 100;
  const price = roundPrice(base + profit, P.rounding);
  const oldPrice = N(P.compareAtPct) > 0 ? roundPrice(price * (1 + N(P.compareAtPct) / 100), 'integer') : 0;
  return { supplierPrice: round2(supplier), shipping: round2(shipping), extra: round2(extra), profit: round2(price - base), price, oldPrice, rule: { mode: rule.mode, value: N(rule.value) }, ruleSource: source };
}

/* ───────────── CJ রেসপন্স নরমালাইজার ───────────── */
const priceRange = (v) => { const m = String(v == null ? '' : v).match(/[\d.]+/g) || []; const a = m.map(Number).filter(Number.isFinite); return a.length ? { min: Math.min(...a), max: Math.max(...a) } : { min: 0, max: 0 }; };
const asImages = (v) => { if (Array.isArray(v)) return v; if (typeof v !== 'string' || !v) return []; const t = v.trim(); if (t.startsWith('[')) { try { return JSON.parse(t); } catch { /* ignore */ } } return t.split(/[,;]/).map((s) => s.trim()).filter((s) => /^https?:/.test(s)); };
const htmlToText = (h) => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const httpsOnly = (u) => (/^https?:\/\//i.test(u) ? u.replace(/^http:\/\//i, 'https://') : '');
export function normListItem(x) {
  const pr = priceRange(x.sellPrice != null ? x.sellPrice : x.nowPrice);
  return { pid: str(x.pid || x.id, 80), name: str(x.productNameEn || x.nameEn || x.productName || x.name, 300), sku: str(x.productSku || x.sku, 80),
    image: httpsOnly(asImages(x.productImage || x.bigImage)[0] || ''), priceMin: pr.min, priceMax: pr.max, categoryId: str(x.categoryId, 80), categoryName: str(x.categoryName, 200),
    warehouseInventory: x.warehouseInventoryNum != null ? N(x.warehouseInventoryNum) : (x.totalVerifiedInventory != null ? N(x.totalVerifiedInventory) : null), productType: str(x.productType, 40) };
}
const normVariant = (v) => ({ vid: str(v.vid, 80), sku: str(v.variantSku || v.sku, 80), name: str(v.variantNameEn || v.variantName, 300), key: str(v.variantKey, 200),
  cost: N(v.variantSellPrice != null ? v.variantSellPrice : v.sellPrice), image: httpsOnly(v.variantImage || ''), weight: N(v.variantWeight), stock: null });
export function normDetail(d) {
  const imgs = [...new Set([...asImages(d.productImage), ...asImages(d.productImageSet)].map(httpsOnly).filter(Boolean))];
  const pr = priceRange(d.sellPrice);
  return { pid: str(d.pid, 80), name: str(d.productNameEn || d.productName, 300), sku: str(d.productSku, 80), description: htmlToText(d.description).slice(0, 8000),
    images: imgs.slice(0, 15), priceMin: pr.min, priceMax: pr.max, categoryId: str(d.categoryId, 80), categoryName: str(d.categoryName, 200), weight: N(d.productWeight),
    variants: (Array.isArray(d.variants) ? d.variants : []).slice(0, 200).map(normVariant), url: 'https://cjdropshipping.com/product/' + encodeURIComponent(str(d.pid, 80)) + '.html' };
}
export function flattenCategories(data) {
  const out = [];
  for (const l1 of (Array.isArray(data) ? data : [])) {
    const id1 = 'L1:' + (l1.categoryFirstName || '');
    out.push({ id: id1, name: str(l1.categoryFirstName, 200), parent: '', level: 1 });
    for (const l2 of (l1.categoryFirstList || [])) {
      const id2 = 'L2:' + (l1.categoryFirstName || '') + '>' + (l2.categorySecondName || '');
      out.push({ id: id2, name: str(l2.categorySecondName, 200), parent: id1, level: 2 });
      for (const l3 of (l2.categorySecondList || [])) out.push({ id: str(l3.categoryId, 80), name: str(l3.categoryName, 200), parent: id2, level: 3, image: httpsOnly(l3.categoryImage || '') });
    }
  }
  return out;
}
export const minCost = (d) => { const c = d.variants.map((v) => v.cost).filter((x) => x > 0); return c.length ? Math.min(...c) : d.priceMin; };
const deriveOptions = (variants) => {
  const keys = variants.map((v) => v.key.split('-').map((s) => s.trim()).filter(Boolean));
  if (keys.length && keys.every((k) => k.length === 2)) return { colors: [...new Set(keys.map((k) => k[0]))].slice(0, 40), sizes: [...new Set(keys.map((k) => k[1]))].slice(0, 40) };
  if (keys.length && keys.every((k) => k.length === 1)) return { colors: [], sizes: [...new Set(keys.map((k) => k[0]))].slice(0, 40) };
  return { colors: [], sizes: [] };
};
function resolveDelivery(item, settings, categoryId) {
  const d = item && item.delivery;
  if (d && ['fixed', 'free', 'confirm'].includes(d.mode)) return { mode: d.mode, fee: d.mode === 'fixed' ? Math.max(0, N(d.fee)) : 0, method: str(d.method, 40) };
  const cat = settings.delivery.byCategory[safeKey(categoryId || '')];
  if (cat && ['fixed', 'free', 'confirm'].includes(cat.mode)) return { mode: cat.mode, fee: cat.mode === 'fixed' ? Math.max(0, N(cat.fee)) : 0, method: '' };
  return { mode: 'default', fee: 0, method: '' };      // 'default' = সাইটের বিদ্যমান দেশ-ভিত্তিক ফি
}
// আপনার বিদ্যমান products স্কিমায় (intl:true, intlCat, intlSub, images, sizes, colors…) — সাথে source/pricing/delivery
export function buildProduct({ detail, stock, item, settings, rules, fx, productId }) {
  const costUsd = minCost(detail);
  if (!(costUsd > 0)) throw new HttpError(422, 'Supplier price missing for ' + detail.pid);
  const pr = computePrice({ costUsd, fx, settings, rules, pid: detail.pid, categoryId: detail.categoryId, ruleOverride: item.ruleOverride });
  const map = settings.categoryMap[safeKey(detail.categoryId)] || {};
  const intlCat = cleanText(item.intlCat || map.intlCat, 100), intlSub = cleanText(item.intlSub || map.intlSub, 100);
  const variants = detail.variants.map((v) => ({ ...v, stock: stock && stock.byVid && stock.byVid[v.vid] != null ? stock.byVid[v.vid] : null,
    price: computePrice({ costUsd: v.cost || costUsd, fx, settings, rules, pid: detail.pid, categoryId: detail.categoryId, ruleOverride: item.ruleOverride }).price }));
  const opts = deriveOptions(detail.variants), now = Date.now(), delivery = resolveDelivery(item, settings, detail.categoryId);
  return clean({
    name: detail.name.slice(0, 150), price: pr.price, oldPrice: pr.oldPrice, cat: intlCat, intl: true, intlCat, intlSub,
    images: detail.images, img: detail.images[0] || '', desc: detail.description, sizes: opts.sizes, colors: opts.colors, tags: [],
    stock: stock ? Math.max(0, Math.floor(stock.total)) : Math.max(0, N(settings.sync.defaultStockIfUnknown)), stockKnown: !!stock,
    resellEnabled: false, resellerPrice: 0, marketPrice: 0, gender: 'both', active: item.publish === true,
    productId, timestamp: now, createdAt: now, updatedAt: new Date().toISOString(),
    sku: detail.sku || (detail.variants[0] && detail.variants[0].sku) || '', variants, delivery, deliveryConfirm: delivery.mode === 'confirm',
    pricing: { costUsd, fx, finalPrice: pr.price, profit: pr.profit, extra: pr.extra, shipping: pr.shipping, ruleSource: pr.ruleSource, rule: pr.rule },
    source: { supplierId: 'cj', supplierProductId: detail.pid, sku: detail.sku, skus: detail.variants.map((v) => v.sku).filter(Boolean).slice(0, 200), categoryId: detail.categoryId, url: detail.url, importedAt: now },
  });
}

/* ───────────── CJ ক্লায়েন্ট + সার্ভিস ───────────── */
export function createCj({ store, newKey, env = process.env, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = String(env.CJ_BASE_URL || 'https://developers.cjdropshipping.com/api2.0/v1').replace(/\/$/, '');
  const apiKey = String(env.CJ_API_KEY || '').trim();
  const gap = Number(env.CJ_MIN_GAP_MS) || 1100;                           // CJ ফ্রি টিয়ার ≈ ১ রিকোয়েস্ট/সেকেন্ড
  let tokenMem = null, lastCall = 0, chain = Promise.resolve(), fxMem = null, syncing = false;
  const stats = { calls: 0, lastOkAt: 0, lastError: '' };
  const E = (p) => `${ROOT}/${p}`;

  const throttled = (fn) => { const run = chain.then(async () => { const w = lastCall + gap - Date.now(); if (w > 0) await sleep(w); try { return await fn(); } finally { lastCall = Date.now(); } }); chain = run.catch(() => {}); return run; };
  async function raw(method, path, { query, body, token } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = { 'Content-Type': 'application/json' }; if (token) headers['CJ-Access-Token'] = token;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000); let res, j;
    try { res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); j = await res.json().catch(() => null); } finally { clearTimeout(t); }
    stats.calls++; return { status: res.status, j };
  }
  const isoMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };

  async function getToken(force = false) {
    if (!apiKey) throw new HttpError(503, 'CJ_API_KEY is not set on the server (Render → Environment).');
    const now = Date.now();
    if (!tokenMem) tokenMem = (await store.get(E('token'))) || null;
    if (!force && tokenMem && tokenMem.access && tokenMem.accessExp - now > 3600e3) return tokenMem.access;
    return throttled(async () => {
      if (!force && tokenMem && tokenMem.access && tokenMem.accessExp - Date.now() > 3600e3) return tokenMem.access;
      if (tokenMem && tokenMem.access && tokenMem.accessExp > Date.now() && Date.now() - (tokenMem.fetchedAt || 0) < 300e3) return tokenMem.access;   // CJ: ৫ মিনিটে ১ বার টোকেন
      let r = null;
      if (tokenMem && tokenMem.refresh && tokenMem.refreshExp > Date.now()) { r = await raw('POST', '/authentication/refreshAccessToken', { body: { refreshToken: tokenMem.refresh } }); if (!(r.j && r.j.result)) r = null; }
      if (!r) r = await raw('POST', '/authentication/getAccessToken', { body: { apiKey } });
      if (!(r.j && r.j.result && r.j.data && r.j.data.accessToken)) { const msg = (r.j && r.j.message) || ('HTTP ' + r.status); stats.lastError = 'auth: ' + msg; throw new HttpError(502, 'CJ authentication failed: ' + msg); }
      const d = r.j.data;
      tokenMem = { access: d.accessToken, accessExp: isoMs(d.accessTokenExpiryDate) || Date.now() + 14 * 864e5, refresh: d.refreshToken || '', refreshExp: isoMs(d.refreshTokenExpiryDate) || Date.now() + 179 * 864e5, fetchedAt: Date.now() };
      await store.set(E('token'), tokenMem).catch(() => {});
      return tokenMem.access;
    });
  }
  /* ── রেট-লিমিট সেফগার্ড ──
     • isRL: কোড বা মেসেজ দেখে চিনে (একই-IP লিমিট "one ip limit 3 users" সহ)
     • ক্যাশ: একই GET (লিস্ট/ক্যাটাগরি/ডিটেইল/স্টক) অল্প সময়ে আবার CJ-তে যায় না; একই সময়ের একই রিকোয়েস্ট একটাই যায়
     • stale-on-error: CJ লিমিট দিলে পুরোনো (৬ ঘণ্টা পর্যন্ত) ক্যাশ ডাটা দেখায়, ব্যর্থ করে না
     • কুলডাউন: লিমিট ধরলে অল্প সময় CJ-তে নতুন কল বন্ধ, যাতে লিমিট আরও না বাড়ে */
  const cache = new Map(), inflight = new Map(); let rlUntil = 0;
  const COOL_MS = Number(env.CJ_COOLDOWN_MS) || 20000;
  const isRL = (status, code, msg) => status === 429 || code === 1600200 || code === 1600201 || /too many|rate.?limit|one ip limit|qps|frequen/i.test(String(msg || ''));
  const ttlFor = (m, path) => (m !== 'GET' ? 0 : /getCategory/.test(path) ? 600e3 : /product\/list/.test(path) ? 90e3 : /getInventoryByPid/.test(path) ? 60e3 : /product\/query/.test(path) ? 180e3 : 0);
  const rlError = () => { const e = new HttpError(429, 'CJ: Too Many Requests (CJ rate/IP limit) — ' + Math.max(1, Math.ceil((rlUntil - Date.now()) / 1000)) + 's পরে আবার চেষ্টা করুন'); e.rateLimited = true; return e; };

  async function cjCall(method, path, opts = {}, attempt = 0) {
    if (Date.now() < rlUntil) { if (opts.patient) await sleep(rlUntil - Date.now() + 500); else throw rlError(); }
    const token = await getToken();
    const r = await throttled(() => raw(method, path, { ...opts, token })); const code = r.j && r.j.code, msg = r.j && r.j.message;
    if ((r.status === 401 || code === 1600001) && attempt === 0) { if (tokenMem) tokenMem.access = ''; await getToken(true); return cjCall(method, path, opts, 1); }
    if (isRL(r.status, code, msg)) {
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); return cjCall(method, path, opts, attempt + 1); }      // ২s, ৪s, ৬s
      rlUntil = Date.now() + COOL_MS; stats.lastError = path + ': ' + (msg || 'rate limited');
      if (opts.patient && (opts.pRetries || 0) < 2) return cjCall(method, path, { ...opts, pRetries: (opts.pRetries || 0) + 1 }, 0);   // সিঙ্কের মতো ব্যাকগ্রাউন্ড কাজ: অপেক্ষা করে আবার
      const e = rlError(); e.message += ' | CJ: ' + String(msg || '').slice(0, 160); throw e;
    }
    if (!r.j || r.j.result === false || (code && code !== 200)) { const m2 = msg || ('HTTP ' + r.status); stats.lastError = path + ': ' + m2; throw new HttpError(502, 'CJ: ' + m2); }
    stats.lastOkAt = Date.now(); return r.j.data;
  }
  async function cj(method, path, opts = {}) {
    const m = String(method).toUpperCase(), ttl = ttlFor(m, path), cacheable = ttl > 0;
    const key = m + ' ' + path + ' ' + JSON.stringify(Object.entries(opts.query || {}).sort());
    if (cacheable && !opts.fresh) { const c = cache.get(key); if (c && Date.now() - c.at < ttl) return c.v; if (inflight.has(key)) return inflight.get(key); }
    const run = (async () => {
      try {
        const v = await cjCall(m, path, opts);
        if (cacheable) { cache.delete(key); cache.set(key, { at: Date.now(), v }); if (cache.size > 300) cache.delete(cache.keys().next().value); }
        return v;
      } catch (e) {
        if (cacheable && e.rateLimited) { const c = cache.get(key); if (c && Date.now() - c.at < 6 * 36e5) { stats.lastError = '(পুরোনো ক্যাশ দেখানো হয়েছে) ' + e.message; return c.v; } }
        throw e;
      }
    })();
    if (cacheable && !opts.fresh) { inflight.set(key, run); run.then(() => inflight.delete(key), () => inflight.delete(key)); }
    return run;
  }
  async function status() {
    const t = tokenMem || (await store.get(E('token')));
    return { keyConfigured: !!apiKey, tokenCached: !!(t && t.access && t.accessExp > Date.now()), tokenExpiresAt: t ? t.accessExp : 0, calls: stats.calls, lastOkAt: stats.lastOkAt, lastError: stats.lastError };
  }
  async function getFx(settings) {
    const f = (settings && settings.fx) || {}, manual = N(f.manualRate) > 0 ? N(f.manualRate) : 0;
    if (f.mode === 'manual' && manual) return { rate: manual, source: 'manual' };
    if (fxMem && Date.now() - fxMem.at < 12 * 36e5) return { rate: fxMem.rate, source: 'auto(cached)' };
    try {
      const target = str(f.currency || 'BDT', 5).toUpperCase(), c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
      const r = await fetchImpl('https://open.er-api.com/v6/latest/USD', { signal: c.signal }); clearTimeout(t); const j = await r.json(); const rate = N(j && j.rates && j.rates[target]);
      if (j.result === 'success' && rate > 0) { fxMem = { rate, at: Date.now() }; return { rate, source: 'auto' }; }
    } catch { /* fall through */ }
    if (fxMem) return { rate: fxMem.rate, source: 'auto(stale)' };
    if (manual) return { rate: manual, source: 'manual(fallback)' };
    throw new HttpError(503, 'Exchange rate unavailable. Set a manual USD→BDT rate in Profit & Pricing Settings.');
  }
  const loadSettings = async () => deepMerge(DEFAULT_SETTINGS, (await store.get(E('settings'))) || {});
  const loadRules = async () => { const r = (await store.get(E('rules'))) || {}; return { categories: r.categories || {}, products: r.products || {} }; };
  async function log(entry) { try { await store.set(E('log/' + newKey(E('log'))), clean({ at: Date.now(), ...entry })); } catch { /* লগ কখনো কাজ আটকায় না */ } }
  async function history(limit = 200) {
    const v = (await store.get(E('log'))) || {}; const all = Object.entries(v).map(([k, d]) => ({ key: k, ...d })).sort((a, b) => b.at - a.at);
    if (all.length > 1500) for (const o of all.slice(1000)) await store.remove(E('log/' + o.key)).catch(() => {});      // পুরোনো লগ ছাঁটা
    return all.slice(0, clamp(limit, 1, 500));
  }
  async function fetchStock(pid, o = {}) {      // CJ: getInventoryByPid। ভার্সনভেদে আকার ভিন্ন → সহনশীল পার্সিং; না পেলে null (আন্দাজ বসানো হয়, "estimated" চিহ্নিত)
    try {
      const d = await cj('GET', '/product/stock/getInventoryByPid', { query: { pid }, ...o });
      const rows = d && (d.variantInventories || d.inventories || (Array.isArray(d) ? d : null)); if (!rows) return null;
      const byVid = {}; let total = 0;
      for (const r of rows) { const inv = Array.isArray(r.inventory) ? r.inventory.reduce((s, i) => s + N(i.totalInventory != null ? i.totalInventory : i.storageNum), 0) : N(r.totalInventory != null ? r.totalInventory : r.storageNum); if (r.vid) byVid[r.vid] = (byVid[r.vid] || 0) + inv; total += inv; }
      return { byVid, total };
    } catch { return null; }
  }

  async function runImport(items, by) {
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new HttpError(400, 'items: 1–50 products per request');
    const s = await loadSettings(), rules = await loadRules(), fx = await getFx(s), all = (await store.get('products')) || {};
    const seenPid = new Set(), seenSku = new Set(); let maxId = 0;
    for (const p of Object.values(all)) { if (!p) continue; maxId = Math.max(maxId, N(p.productId)); if (p.source && p.source.supplierId === 'cj') { seenPid.add(p.source.supplierProductId); (p.source.skus || []).forEach((k) => seenSku.add(k)); if (p.source.sku) seenSku.add(p.source.sku); } }
    const out = { done: [], skipped: [], failed: [] };
    for (const raw0 of items) {
      const pid = str(raw0 && raw0.pid, 80); if (!pid) { out.failed.push({ pid: '', error: 'pid missing' }); continue; }
      try {
        if (seenPid.has(pid)) { out.skipped.push({ pid, reason: 'Already imported (supplier product ID)' }); continue; }
        const d = await cj('GET', '/product/query', { query: { pid } }); if (!d) throw new HttpError(404, 'Not found at CJ');
        const detail = normDetail(d);
        if ((detail.sku && seenSku.has(detail.sku)) || detail.variants.some((v) => v.sku && seenSku.has(v.sku))) { out.skipped.push({ pid, reason: 'Duplicate SKU already in products' }); continue; }
        const stock = await fetchStock(pid);
        const item = { publish: raw0.publish === true, intlCat: raw0.intlCat, intlSub: raw0.intlSub, ruleOverride: validRule(raw0.ruleOverride) ? raw0.ruleOverride : null, delivery: raw0.delivery };
        const prod = buildProduct({ detail, stock, item, settings: s, rules, fx: fx.rate, productId: ++maxId });
        if (!prod.intlCat) throw new HttpError(422, 'Choose a website category (or map the CJ category) before importing');
        const key = newKey('products'); await store.set('products/' + key, prod);
        seenPid.add(pid); (prod.source.skus || []).forEach((k) => seenSku.add(k));
        out.done.push({ pid, key, name: prod.name, price: prod.price, published: prod.active });
        await log({ type: 'import', pid, key, name: prod.name, price: prod.price, published: prod.active, by });
      } catch (e) { out.failed.push({ pid, error: e.message }); await log({ type: 'import-failed', pid, error: e.message, by }); }
    }
    return out;
  }

  // সিঙ্ক: নিজে হাতে বদলানো দাম কখনো নীরবে বদলায় না — অ্যাডমিনের অনুমোদনের অপেক্ষায় থাকে
  async function runSync(by) {
    if (syncing) throw new HttpError(409, 'Sync already running'); syncing = true;
    try {
      const s = await loadSettings(), rules = await loadRules(), fx = await getFx(s), all = (await store.get('products')) || {};
      const mine = Object.entries(all).filter(([, p]) => p && p.source && p.source.supplierId === 'cj').slice(0, 300);
      const pending = {}, alerts = {}; let stockUpdated = 0, priceApplied = 0, checked = 0;
      for (const [key, p] of mine) {
        try {
          const d = await cj('GET', '/product/query', { query: { pid: p.source.supplierProductId }, fresh: true, patient: true }); checked++;
          if (!d) { alerts[key] = { name: p.name, type: 'unavailable', at: Date.now() }; continue; }
          const detail = normDetail(d), st = await fetchStock(detail.pid, { fresh: true, patient: true }), newCost = minCost(detail);
          if (st && st.total <= 0) alerts[key] = { name: p.name, type: 'out_of_stock', at: Date.now() };
          if (st && s.sync.autoStock && N(p.stock) !== st.total) { await store.update('products/' + key, { stock: Math.floor(st.total), stockKnown: true, updatedAt: new Date().toISOString() }); stockUpdated++; }
          const oldCost = N(p.pricing && p.pricing.costUsd);
          if (newCost > 0 && Math.abs(newCost - oldCost) > 0.005) {
            const pr = computePrice({ costUsd: newCost, fx: fx.rate, settings: s, rules, pid: detail.pid, categoryId: p.source.categoryId });
            const custom = N(p.price) !== N(p.pricing && p.pricing.finalPrice);
            const entry = { name: p.name, oldCost, newCost, currentPrice: N(p.price), suggestedPrice: pr.price, custom, at: Date.now() };
            if (s.sync.autoPrice && !custom) { await store.update('products/' + key, clean({ price: pr.price, oldPrice: pr.oldPrice, pricing: { ...p.pricing, costUsd: newCost, fx: fx.rate, finalPrice: pr.price, profit: pr.profit, ruleSource: pr.ruleSource }, updatedAt: new Date().toISOString() })); priceApplied++; }
            else pending[key] = entry;
          }
        } catch (e) { alerts[key] = { name: p.name, type: 'error', error: String(e.message).slice(0, 200), at: Date.now() }; }
      }
      await store.set(E('sync/pending'), pending); await store.set(E('sync/alerts'), alerts);
      const last = { at: Date.now(), checked, stockUpdated, priceApplied, pending: Object.keys(pending).length, alerts: Object.keys(alerts).length };
      await store.set(E('sync/last'), last); await log({ type: 'sync', checked, stockUpdated, priceApplied, pending: last.pending, by });
      return last;
    } finally { syncing = false; }
  }
  const warm = () => { loadSettings().catch(() => {}); if (apiKey) getToken().catch(() => {}); };     // ঘুম থেকে উঠে প্রথম রিকোয়েস্ট দ্রুত করতে

  return { E, cj, getToken, status, getFx, loadSettings, loadRules, log, history, fetchStock, runImport, runSync, warm };
}
