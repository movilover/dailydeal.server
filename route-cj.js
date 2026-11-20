// CJdropshipping রুট। বিদ্যমান app.js-এর 'extra' হুক দিয়ে বসে (server.js দেখুন)।
//   অ্যাডমিন:  /api/admin/cj/*   → Firebase ID-টোকেন + ADMIN_EMAIL (বিদ্যমান auth.requireAdmin)
//   পাবলিক:    /api/public/*     → শুধু WhatsApp নম্বর ও ডেলিভারি-কোট রিকোয়েস্ট (রেট-লিমিটেড, ভ্যালিডেটেড)
import express from 'express';
import { N, clamp, str, safeKey, cleanText, cleanPhone, HttpError, wrap, makeLimiter, jsonOnly } from './cj-safe.js';
import { createCj, computePrice, flattenCategories, normListItem, normDetail, minCost, validRule, deepMerge } from './cj-core.js';
import { log as slog } from './log.js';

const errHandler = (err, req, res, next) => {            // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) slog('error', 'cj-route', { path: req.path, err: String(err.message).slice(0, 200) });
  if (res.headersSent) return;
  res.status(status).json({ ok: false, message: status >= 500 && !(err instanceof HttpError) ? 'Server error' : err.message });
};

export function mountCj(app, { auth, store, newKey, env = process.env, fetchImpl }) {
  const core = createCj({ store, newKey, env, ...(fetchImpl ? { fetchImpl } : {}) });
  const E = core.E;
  const A = express.Router();
  // অ্যাডমিন: শুধু Firebase ID-টোকেন + ADMIN_EMAIL। (App Check বাদ: অ্যাডমিন CJ প্যানেল টোকেন পাঠায় না; ID-টোকেনই যথেষ্ট কড়া)
  A.use(jsonOnly, auth.requireAdmin);
  const writeLimit = makeLimiter(60e3, 90);
  A.use((req, res, next) => (req.method === 'GET' ? next() : writeLimit(req, res, next)));

  /* ----- স্ট্যাটাস / টেস্ট ----- */
  A.get('/status', wrap(async (_q, res) => res.json({ ok: true, ...(await core.status()) })));
  A.post('/test', wrap(async (_q, res) => { const d = await core.cj('GET', '/setting/get'); res.json({ ok: true, account: d || null }); }));

  /* ----- সেটিংস / রুল ----- */
  A.get('/settings', wrap(async (_q, res) => res.json({ ok: true, settings: await core.loadSettings(), rules: await core.loadRules() })));
  A.put('/settings', wrap(async (req, res) => {
    const b = req.body || {}, cur = await core.loadSettings(), o = {};
    if (b.pricing) {
      const p = b.pricing; if (p.global && !validRule(p.global)) throw new HttpError(400, 'Invalid global profit rule');
      o.pricing = { ...(p.global ? { global: { mode: p.global.mode, value: N(p.global.value) } } : {}), ...(p.extraFixed != null ? { extraFixed: clamp(N(p.extraFixed), 0, 1e7) } : {}), ...(p.extraPct != null ? { extraPct: clamp(N(p.extraPct), 0, 1000) } : {}),
        ...(p.includeShipping != null ? { includeShipping: !!p.includeShipping } : {}), ...(['none', 'integer', 'nearest5', 'nearest10'].includes(p.rounding) ? { rounding: p.rounding } : {}), ...(p.compareAtPct != null ? { compareAtPct: clamp(N(p.compareAtPct), 0, 500) } : {}) };
    }
    if (b.fx) o.fx = { mode: b.fx.mode === 'manual' ? 'manual' : 'auto', manualRate: Math.max(0, N(b.fx.manualRate)), currency: str(b.fx.currency || 'BDT', 5).toUpperCase() };
    if (b.delivery) {
      const d = b.delivery, wa = String(d.whatsapp || '').replace(/[^\d]/g, '');
      if (d.whatsapp != null && wa && (wa.length < 8 || wa.length > 15)) throw new HttpError(400, 'WhatsApp number must be 8–15 digits with country code');
      const fees = (m) => Object.fromEntries(Object.entries(m || {}).slice(0, 500).map(([k, v]) => [safeKey(k), { mode: ['fixed', 'free', 'confirm'].includes(v && v.mode) ? v.mode : 'fixed', fee: Math.max(0, N(v && v.fee)) }]));
      o.delivery = { ...(d.whatsapp != null ? { whatsapp: wa } : {}), ...(['fixed', 'confirm'].includes(d.defaultMode) ? { defaultMode: d.defaultMode } : {}), ...(d.defaultFee != null ? { defaultFee: Math.max(0, N(d.defaultFee)) } : {}),
        ...(d.byCountry ? { byCountry: fees(d.byCountry) } : {}), ...(d.byRegion ? { byRegion: fees(d.byRegion) } : {}), ...(d.byCategory ? { byCategory: fees(d.byCategory) } : {}),
        ...(Array.isArray(d.methods) ? { methods: d.methods.slice(0, 20).map((m) => ({ id: safeKey(str(m.id || m.name, 30)), name: cleanText(m.name, 60), fee: Math.max(0, N(m.fee)) })) } : {}) };
    }
    if (b.sync) o.sync = { autoStock: !!b.sync.autoStock, autoPrice: !!b.sync.autoPrice, intervalHours: clamp(N(b.sync.intervalHours) || 12, 1, 168), defaultStockIfUnknown: clamp(N(b.sync.defaultStockIfUnknown), 0, 100000) };
    if (b.categoryMap) o.categoryMap = Object.fromEntries(Object.entries(b.categoryMap).slice(0, 3000).map(([k, v]) => [safeKey(k), { intlCat: cleanText(v && v.intlCat, 100), intlSub: cleanText(v && v.intlSub, 100) }]));
    const next = deepMerge(cur, o);
    if (o.categoryMap) next.categoryMap = o.categoryMap;
    if (o.delivery) for (const k of ['byCountry', 'byRegion', 'byCategory']) if (o.delivery[k]) next.delivery[k] = o.delivery[k];
    await store.set(E('settings'), next); res.json({ ok: true, settings: next });
  }));
  A.put('/rules/:scope/:id', wrap(async (req, res) => {
    const { scope, id } = req.params; if (!['categories', 'products'].includes(scope)) throw new HttpError(400, 'scope');
    const r = req.body && req.body.rule;
    if (r === null) { await store.remove(E(`rules/${scope}/${safeKey(id)}`)); return res.json({ ok: true, removed: true }); }
    if (!validRule(r)) throw new HttpError(400, 'Invalid rule');
    await store.set(E(`rules/${scope}/${safeKey(id)}`), { mode: r.mode, value: N(r.value) }); res.json({ ok: true });
  }));
  A.post('/rules/bulk', wrap(async (req, res) => {
    const { pids, rule } = req.body || {};
    if (!Array.isArray(pids) || !pids.length || pids.length > 200) throw new HttpError(400, 'pids: 1–200 items');
    if (rule !== null && !validRule(rule)) throw new HttpError(400, 'Invalid rule');
    for (const pid of pids) rule === null ? await store.remove(E('rules/products/' + safeKey(pid))) : await store.set(E('rules/products/' + safeKey(pid)), { mode: rule.mode, value: N(rule.value) });
    res.json({ ok: true, count: pids.length });
  }));
  A.get('/fx', wrap(async (_q, res) => res.json({ ok: true, ...(await core.getFx(await core.loadSettings())) })));
  A.post('/pricing/preview', wrap(async (req, res) => {
    const { costUsd, shippingUsd, categoryId, pid, ruleOverride } = req.body || {}; const s = await core.loadSettings(), fx = await core.getFx(s);
    res.json({ ok: true, fx, ...computePrice({ costUsd: N(costUsd), shippingUsd: N(shippingUsd), fx: fx.rate, settings: s, rules: await core.loadRules(), pid, categoryId, ruleOverride }) });
  }));

  /* ----- ক্যাটাগরি ----- */
  A.post('/categories/sync', wrap(async (req, res) => {
    const list = flattenCategories(await core.cj('GET', '/product/getCategory'));
    if (!list.length) throw new HttpError(502, 'CJ returned no categories');
    await store.set(E('sync/categories'), { at: Date.now(), count: list.length, list });
    await core.log({ type: 'category-sync', count: list.length, by: req.user.email }); res.json({ ok: true, count: list.length, at: Date.now() });
  }));
  A.get('/categories', wrap(async (_q, res) => { const c = await store.get(E('sync/categories')); res.json({ ok: true, at: c ? c.at : 0, list: c ? c.list || [] : [] }); }));
  A.get('/categories/:id/count', wrap(async (req, res) => {      // CJ-তে বাল্ক কাউন্ট নেই → দরকারমতো প্রতি ক্যাটাগরিতে ১টা কল
    const d = await core.cj('GET', '/product/list', { query: { categoryId: req.params.id, pageNum: 1, pageSize: 10 } });
    res.json({ ok: true, total: N(d && (d.total != null ? d.total : (d.content && d.content[0] && d.content[0].totalRecords))) });
  }));

  /* ----- প্রোডাক্ট ----- */
  A.get('/products', wrap(async (req, res) => {
    const q = req.query, page = clamp(parseInt(q.page) || 1, 1, 10000), size = clamp(parseInt(q.size) || 20, 1, 100);
    const query = { pageNum: page, pageSize: size, categoryId: str(q.categoryId, 80), productNameEn: str(q.q, 100) };
    if (q.minPrice) query.minPrice = N(q.minPrice); if (q.maxPrice) query.maxPrice = N(q.maxPrice); if (q.inStock === '1') query.startWarehouseInventory = 1;
    const d = await core.cj('GET', '/product/list', { query });
    const rows = Array.isArray(d && d.list) ? d.list : (d && d.content && d.content[0] && d.content[0].productList) || [];
    const total = N(d && (d.total != null ? d.total : (d.content && d.content[0] && d.content[0].totalRecords)));
    const s = await core.loadSettings(), rules = await core.loadRules(), fx = await core.getFx(s);
    const have = new Set(Object.values((await store.get('products')) || {}).map((p) => (p && p.source && p.source.supplierId === 'cj' ? p.source.supplierProductId : null)).filter(Boolean));
    const list = rows.map(normListItem).map((p) => ({ ...p, pricing: computePrice({ costUsd: p.priceMin, fx: fx.rate, settings: s, rules, pid: p.pid, categoryId: p.categoryId }), imported: have.has(p.pid) }));
    res.json({ ok: true, page, size, total, fx, list });
  }));
  A.get('/products/:pid', wrap(async (req, res) => {
    const d = await core.cj('GET', '/product/query', { query: { pid: req.params.pid } }); if (!d) throw new HttpError(404, 'Product not found at CJ');
    const detail = normDetail(d), stock = await core.fetchStock(detail.pid);
    detail.variants.forEach((v) => { if (stock && stock.byVid[v.vid] != null) v.stock = stock.byVid[v.vid]; });
    const s = await core.loadSettings(), fx = await core.getFx(s);
    res.json({ ok: true, product: detail, stockTotal: stock ? stock.total : null, stockKnown: !!stock, fx, pricing: computePrice({ costUsd: minCost(detail), fx: fx.rate, settings: s, rules: await core.loadRules(), pid: detail.pid, categoryId: detail.categoryId }) });
  }));
  A.post('/shipping/estimate', wrap(async (req, res) => {
    const { vid, quantity, country } = req.body || {};
    if (!vid || !/^[A-Z]{2}$/.test(String(country || ''))) throw new HttpError(400, 'vid and 2-letter country code required');
    const d = await core.cj('POST', '/logistic/freightCalculate', { body: { startCountryCode: 'CN', endCountryCode: country, products: [{ quantity: clamp(parseInt(quantity) || 1, 1, 1000), vid: str(vid, 80) }] } });
    res.json({ ok: true, options: (Array.isArray(d) ? d : []).map((o) => ({ name: str(o.logisticName, 80), priceUsd: N(o.logisticPrice), aging: str(o.logisticAging, 40) })) });
  }));

  /* ----- ইমপোর্ট / হিস্ট্রি ----- */
  A.post('/import', wrap(async (req, res) => res.json({ ok: true, ...(await core.runImport(req.body && req.body.items, req.user.email)) })));
  A.get('/history', wrap(async (req, res) => res.json({ ok: true, list: await core.history(parseInt(req.query.limit) || 200) })));

  /* ----- সিঙ্ক ----- */
  A.post('/sync/run', wrap(async (req, res) => res.json({ ok: true, ...(await core.runSync(req.user.email)) })));
  A.get('/sync', wrap(async (_q, res) => res.json({ ok: true, last: (await store.get(E('sync/last'))) || null, pending: (await store.get(E('sync/pending'))) || {}, alerts: (await store.get(E('sync/alerts'))) || {} })));
  A.post('/sync/apply', wrap(async (req, res) => {
    const keys = (req.body && req.body.keys) || []; if (!Array.isArray(keys) || !keys.length || keys.length > 200) throw new HttpError(400, 'keys: 1–200');
    const pend = (await store.get(E('sync/pending'))) || {}; let applied = 0;
    for (const k of keys) {
      const e = pend[k], p = await store.get('products/' + safeKey(k)); if (!e || !p) continue;
      if (req.body.useSuggested !== false) await store.update('products/' + safeKey(k), { price: e.suggestedPrice, pricing: { ...(p.pricing || {}), costUsd: e.newCost, finalPrice: e.suggestedPrice }, updatedAt: new Date().toISOString() });
      else await store.update('products/' + safeKey(k), { pricing: { ...(p.pricing || {}), costUsd: e.newCost } });      // নিজের দাম রাখো, শুধু নতুন কস্ট রেকর্ড
      await store.remove(E('sync/pending/' + safeKey(k))); applied++;
    }
    await core.log({ type: 'sync-apply', count: applied, by: req.user.email }); res.json({ ok: true, applied });
  }));
  A.post('/sync/dismiss', wrap(async (req, res) => { for (const k of ((req.body && req.body.keys) || []).slice(0, 500)) { await store.remove(E('sync/pending/' + safeKey(k))); await store.remove(E('sync/alerts/' + safeKey(k))); } res.json({ ok: true }); }));

  /* ----- কাস্টমারের ডেলিভারি-কোট রিকোয়েস্ট (অ্যাডমিন দেখে/স্ট্যাটাস বদলায়) ----- */
  A.get('/delivery-requests', wrap(async (_q, res) => {
    const v = (await store.get(E('deliveryRequests'))) || {};
    res.json({ ok: true, list: Object.values(v).filter(Boolean).sort((a, b) => N(b.createdAt) - N(a.createdAt)).slice(0, 200) });
  }));
  A.patch('/delivery-requests/:ref', wrap(async (req, res) => {
    const ref = String(req.params.ref), st = str(req.body && req.body.status, 30);
    if (!/^DDW-[A-Z0-9-]{3,40}$/.test(ref)) throw new HttpError(400, 'Bad reference');
    if (!['awaiting_delivery_quote', 'quoted', 'confirmed', 'cancelled'].includes(st)) throw new HttpError(400, 'Bad status');
    if (!(await store.get(E('deliveryRequests/' + ref)))) throw new HttpError(404, 'Request not found');
    await store.update(E('deliveryRequests/' + ref), { status: st, updatedAt: Date.now(), updatedBy: req.user.email }); res.json({ ok: true });
  }));
  A.use(errHandler);

  /* ----- পাবলিক (কাস্টমার সাইট) ----- */
  const P = express.Router(); P.use(jsonOnly);
  P.get('/config', makeLimiter(60e3, 60), wrap(async (_q, res) => { const s = await core.loadSettings(); res.set('Cache-Control', 'public, max-age=60'); res.json({ ok: true, whatsapp: s.delivery.whatsapp || '' }); }));
  P.post('/delivery-request', makeLimiter(10 * 60e3, 10), wrap(async (req, res) => {
    const b = req.body || {}, name = cleanText(b.name, 80), phone = cleanPhone(b.phone), country = cleanText(b.country, 60), loc = cleanText(b.location, 300), addr = cleanText(b.address, 400);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((i) => ({ productKey: safeKey(str(i.productKey, 60)), name: cleanText(i.name, 150), qty: clamp(parseInt(i.qty) || 1, 1, 999), price: Math.max(0, N(i.price)) }));
    if (!name || phone.length < 6 || !country || !addr || !items.length) throw new HttpError(400, 'name, phone, country, address and at least one item are required');
    const ref = 'DDW-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    await store.set(E('deliveryRequests/' + ref), { ref, name, phone, country, location: loc, address: addr, items, status: 'awaiting_delivery_quote', createdAt: Date.now() });
    res.json({ ok: true, ref });
  }));
  P.use(errHandler);

  app.use('/api/admin/cj', A);
  app.use('/api/public', P);
  setImmediate(() => core.warm());
  return core;
}
