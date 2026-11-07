'use strict';
/**
 * facebook-meta.js  —  Daily Deal × Meta (Facebook) integration module
 * ---------------------------------------------------------------------------
 * Drop this file next to your Railway server.js and add TWO lines:
 *
 *     const mountMeta = require('./facebook-meta');
 *     mountMeta(app, { admin });          // `admin` = your initialised firebase-admin
 *
 * Needs Node 18+ (global fetch) and `express` (already used by your server).
 * It only ADDS routes under /api/facebook/*. It never touches users, wallets,
 * resellers, orders or any existing route/table.
 *
 * ENV VARS
 *   ADMIN_EMAIL        required  – the one admin allowed to change settings / post
 *   SITE_URL           optional  – default https://dailydeal.world
 *   META_ENC_KEY       required to save tokens from the panel
 *                      (32 random bytes, base64:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 *   ALLOWED_ORIGINS    optional  – comma list (same var your server already uses)
 *   META_GRAPH_VERSION optional  – default v25.0
 *   Optional overrides (if set, they win over the panel and cannot be edited there):
 *   META_PIXEL_ID, META_CAPI_TOKEN, META_PAGE_ID, META_PAGE_TOKEN, META_TEST_EVENT_CODE, META_FEED_KEY
 *
 * STORAGE
 *   Panel values are saved ONLY on the server in Realtime DB path  _serverPrivate/meta
 *   (tokens AES-256-GCM encrypted). Add this to your database rules so no browser can read it:
 *     "_serverPrivate": { ".read": false, ".write": false }
 *   (firebase-admin ignores rules, so the server can still use it.)
 */
const crypto = require('crypto');
const express = require('express');

module.exports = function mountMeta(app, opts) {
  opts = opts || {};
  const admin = opts.admin;
  if (!admin) throw new Error('facebook-meta: pass { admin } (firebase-admin)');
  const adminEmail = String(opts.adminEmail || process.env.ADMIN_EMAIL || '').toLowerCase();
  const siteUrl = String(opts.siteUrl || process.env.SITE_URL || 'https://dailydeal.world').replace(/\/+$/, '');
  const GV = opts.graphVersion || process.env.META_GRAPH_VERSION || 'v25.0';
  const GRAPH = 'https://graph.facebook.com/' + GV;
  const db = admin.database();
  const PRIV = '_serverPrivate/meta';
  const encKey = process.env.META_ENC_KEY ? Buffer.from(process.env.META_ENC_KEY, 'base64') : null;
  const encReady = !!(encKey && encKey.length === 32);

  /* ───────────── helpers ───────────── */
  const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
  const enc = (txt) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const d = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), d].map((b) => b.toString('base64')).join('.');
  };
  const dec = (s) => {
    try {
      const [iv, tag, d] = String(s).split('.').map((x) => Buffer.from(x, 'base64'));
      const c = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
      c.setAuthTag(tag);
      return Buffer.concat([c.update(d), c.final()]).toString('utf8');
    } catch (e) { return ''; }
  };
  const hint = (t) => (t ? '…' + String(t).slice(-4) : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const log = (...a) => console.log('[meta]', ...a);
  const scrub = (m) => String(m || '').replace(/access_token=[^&\s"']+/gi, 'access_token=***').replace(/EA[A-Za-z0-9]{20,}/g, '***').slice(0, 300);

  async function timedFetch(url, init, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || 10000);
    try { return await fetch(url, Object.assign({}, init, { signal: ac.signal })); }
    finally { clearTimeout(t); }
  }

  /* ───────────── config (env wins, else encrypted DB record) ───────────── */
  let cfgCache = null, cfgAt = 0;
  async function rawRec() { const s = await db.ref(PRIV).once('value'); return s.val() || {}; }
  async function getCfg(force) {
    if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
    const r = await rawRec();
    const E = process.env;
    const cfg = {
      pixelId: E.META_PIXEL_ID || r.pixelId || '',
      testCode: E.META_TEST_EVENT_CODE != null && E.META_TEST_EVENT_CODE !== '' ? E.META_TEST_EVENT_CODE : (r.testEventCode || ''),
      pageId: E.META_PAGE_ID || r.pageId || '',
      capiToken: E.META_CAPI_TOKEN || (r.capiTokenEnc && encReady ? dec(r.capiTokenEnc) : ''),
      pageToken: E.META_PAGE_TOKEN || (r.pageTokenEnc && encReady ? dec(r.pageTokenEnc) : ''),
      feedKey: E.META_FEED_KEY || r.feedKey || '',
      env: { pixelId: !!E.META_PIXEL_ID, capiToken: !!E.META_CAPI_TOKEN, pageId: !!E.META_PAGE_ID, pageToken: !!E.META_PAGE_TOKEN },
    };
    if (!cfg.feedKey) {
      cfg.feedKey = crypto.randomBytes(18).toString('hex');
      await db.ref(PRIV + '/feedKey').set(cfg.feedKey);
    }
    cfgCache = cfg; cfgAt = Date.now();
    return cfg;
  }
  const bust = () => { cfgCache = null; feedCache = null; };

  /* ───────────── router + CORS + auth ───────────── */
  const router = express.Router();
  const allowed = new Set([siteUrl].concat(String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)));
  router.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && allowed.has(o.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Firebase-AppCheck');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(express.json({ limit: '40kb' }));

  async function requireAdmin(req, res, next) {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !adminEmail) return res.status(401).json({ ok: false, message: 'অ্যাডমিন লগইন দরকার' });
      const d = await admin.auth().verifyIdToken(m[1]);
      if (String(d.email || '').toLowerCase() !== adminEmail || d.email_verified === false) return res.status(403).json({ ok: false, message: 'শুধু মূল অ্যাডমিন পারবেন' });
      next();
    } catch (e) { res.status(401).json({ ok: false, message: 'টোকেন সঠিক নয়' }); }
  }
  const baseOf = (req) => (String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0] + '://' + req.get('host'));

  /* ───────────── 1) Catalog feed ───────────── */
  let feedCache = null;
  async function buildItems() {
    if (feedCache && Date.now() - feedCache.at < 300000) return feedCache.items;
    const snap = await db.ref('products').once('value');
    const all = snap.val() || {};
    const items = [];
    for (const k of Object.keys(all)) {
      const p = all[k] || {};
      const id = String(p.productId || k);
      const price = Number(p.price) || 0, old = Number(p.oldPrice) || 0;
      const imgs = (Array.isArray(p.images) && p.images.length ? p.images : [p.img]).filter((u) => /^https?:\/\//.test(String(u || '')));
      const title = strip(p.name).slice(0, 200);
      if (!title || price <= 0 || !imgs.length) continue;
      const it = {
        id,
        title,
        description: (strip(p.desc) || title).slice(0, 5000),
        availability: p.active === false ? 'out of stock' : 'in stock',
        condition: 'new',
        price: (old > price ? old : price).toFixed(2) + ' BDT',
        link: siteUrl + '/?p=' + encodeURIComponent(id),
        image_link: imgs[0],
        brand: 'Daily Deal',
      };
      if (old > price) it.sale_price = price.toFixed(2) + ' BDT';
      if (imgs.length > 1) it.additional_image_link = imgs.slice(1, 11);
      if (p.cat) it.product_type = strip(p.cat).slice(0, 750);
      items.push(it);
    }
    feedCache = { at: Date.now(), items };
    return items;
  }
  async function feedGuard(req, res) {
    const cfg = await getCfg();
    if (!safeEq(String(req.query.key || ''), cfg.feedKey)) { res.status(403).type('text/plain').send('Forbidden'); return false; }
    return true;
  }
  router.get('/catalog-feed.xml', async (req, res) => {
    try {
      if (!(await feedGuard(req, res))) return;
      const items = await buildItems();
      let x = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>\n<title>Daily Deal</title><link>' + esc(siteUrl) + '</link><description>Daily Deal product catalog</description>\n';
      for (const it of items) {
        x += '<item>';
        for (const f of ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'sale_price', 'product_type']) {
          if (it[f] != null) x += '<g:' + f + '>' + esc(it[f]) + '</g:' + f + '>';
        }
        (it.additional_image_link || []).forEach((u) => { x += '<g:additional_image_link>' + esc(u) + '</g:additional_image_link>'; });
        x += '</item>\n';
      }
      res.set('Cache-Control', 'public, max-age=300').type('application/xml').send(x + '</channel></rss>');
    } catch (e) { log('feed xml error', scrub(e.message)); res.status(500).type('text/plain').send('Feed error'); }
  });
  router.get('/catalog-feed.json', async (req, res) => {
    try {
      if (!(await feedGuard(req, res))) return;
      res.set('Cache-Control', 'public, max-age=300').json({ data: await buildItems() });
    } catch (e) { log('feed json error', scrub(e.message)); res.status(500).json({ ok: false }); }
  });

  /* ───────────── 2) Admin settings ───────────── */
  router.get('/settings', requireAdmin, async (req, res) => {
    try {
      const c = await getCfg(true);
      res.json({
        ok: true,
        pixelId: c.pixelId, testEventCode: c.testCode, pageId: c.pageId,
        hasCapiToken: !!c.capiToken, capiTokenHint: hint(c.capiToken),
        hasPageToken: !!c.pageToken, pageTokenHint: hint(c.pageToken),
        encReady, env: c.env,
        feedUrl: baseOf(req) + '/api/facebook/catalog-feed.xml?key=' + c.feedKey,
      });
    } catch (e) { res.status(500).json({ ok: false, message: 'সেটিংস পড়া যায়নি' }); }
  });
  router.post('/settings', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}, upd = {};
      const pid = String(b.pixelId || '').trim(), pg = String(b.pageId || '').trim(), tc = String(b.testEventCode || '').trim();
      if (pid && !/^\d{5,20}$/.test(pid)) return res.status(400).json({ ok: false, message: 'Pixel ID শুধু সংখ্যা হতে হবে' });
      if (pg && !/^\d{5,25}$/.test(pg)) return res.status(400).json({ ok: false, message: 'Page ID শুধু সংখ্যা হতে হবে' });
      if (!/^[A-Za-z0-9_-]{0,30}$/.test(tc)) return res.status(400).json({ ok: false, message: 'Test Event Code সঠিক নয়' });
      upd.pixelId = pid || null; upd.pageId = pg || null; upd.testEventCode = tc || null;
      const ct = String(b.capiToken || '').trim(), pt = String(b.pageToken || '').trim();
      if (ct || pt) {
        if (!encReady) return res.status(400).json({ ok: false, message: 'সার্ভারে META_ENC_KEY সেট করা নেই — টোকেন নিরাপদে সেভ করা যাচ্ছে না' });
        if (ct) upd.capiTokenEnc = enc(ct);
        if (pt) upd.pageTokenEnc = enc(pt);
      }
      if (b.clearCapiToken) upd.capiTokenEnc = null;
      if (b.clearPageToken) upd.pageTokenEnc = null;
      await db.ref(PRIV).update(upd);
      bust();
      res.json({ ok: true });
    } catch (e) { log('settings save', scrub(e.message)); res.status(500).json({ ok: false, message: 'সেভ ব্যর্থ' }); }
  });
  router.post('/rotate-feed-key', requireAdmin, async (req, res) => {
    try { await db.ref(PRIV + '/feedKey').set(crypto.randomBytes(18).toString('hex')); bust(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });

  /* public: only the Pixel ID (it is public by design – it appears in every site's HTML) */
  router.get('/public-config', async (req, res) => {
    try { const c = await getCfg(); res.set('Cache-Control', 'public, max-age=60').json({ ok: true, pixelId: c.pixelId || '' }); }
    catch (e) { res.json({ ok: true, pixelId: '' }); }
  });

  /* ───────────── 3) Conversions API ───────────── */
  const EVENTS = new Set(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase']);
  const hits = new Map();
  setInterval(() => hits.clear(), 60000).unref();
  const normPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (/^01\d{9}$/.test(d)) d = '880' + d.slice(1); return d; };
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

  function buildEvent(req, b) {
    const u = b.user || {};
    const ud = { client_user_agent: clip(req.headers['user-agent'], 400) };
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (ip) ud.client_ip_address = ip;
    if (u.fbp) ud.fbp = clip(u.fbp, 120);
    if (u.fbc) ud.fbc = clip(u.fbc, 160);
    const ph = normPhone(u.phone); if (ph.length >= 10) ud.ph = [sha(ph)];
    if (u.email && /@/.test(u.email)) ud.em = [sha(u.email)];
    if (u.name) { const parts = clip(u.name, 100).trim().split(/\s+/); ud.fn = [sha(parts[0])]; if (parts.length > 1) ud.ln = [sha(parts.slice(1).join(' '))]; }
    if (u.city) ud.ct = [sha(String(u.city).replace(/\s+/g, ''))];
    if (u.external_id) ud.external_id = [sha(clip(u.external_id, 100))];
    ud.country = [sha('bd')];
    const cd = b.custom_data || {}, out = {};
    if (cd.value != null && isFinite(Number(cd.value))) out.value = Number(cd.value);
    out.currency = 'BDT';
    if (Array.isArray(cd.content_ids)) out.content_ids = cd.content_ids.slice(0, 50).map((x) => clip(x, 60));
    if (cd.content_type) out.content_type = 'product';
    if (cd.content_name) out.content_name = clip(cd.content_name, 200);
    if (cd.content_category) out.content_category = clip(cd.content_category, 200);
    if (cd.num_items != null && isFinite(Number(cd.num_items))) out.num_items = Math.min(999, Number(cd.num_items));
    if (Array.isArray(cd.contents)) out.contents = cd.contents.slice(0, 50).map((x) => ({ id: clip(x.id, 60), quantity: Math.max(1, Number(x.quantity) || 1), item_price: Number(x.item_price) || 0 }));
    return {
      event_name: b.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: clip(b.event_id, 80),
      event_source_url: clip(b.event_source_url, 500),
      action_source: 'website',
      user_data: ud,
      custom_data: out,
    };
  }
  async function sendCapi(cfg, evt, withTest) {
    const body = { data: [evt] };
    if (withTest !== false && cfg.testCode) body.test_event_code = cfg.testCode;
    const r = await timedFetch(GRAPH + '/' + cfg.pixelId + '/events?access_token=' + encodeURIComponent(cfg.capiToken), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 8000);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  }
  router.post('/event', async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 80) return res.status(429).json({ ok: false });
    const b = req.body || {};
    if (!EVENTS.has(b.event_name) || !b.event_id) return res.status(400).json({ ok: false });
    res.status(202).json({ ok: true });                   // answer first – never slow the shop down
    try {
      const cfg = await getCfg();
      if (!cfg.pixelId || !cfg.capiToken) return;
      const r = await sendCapi(cfg, buildEvent(req, b));
      if (r.status >= 400) log('capi rejected', r.status, scrub(JSON.stringify(r.body && r.body.error)));
    } catch (e) { log('capi error', scrub(e.message)); }
  });
  router.post('/test-event', requireAdmin, async (req, res) => {
    try {
      const cfg = await getCfg(true);
      if (!cfg.pixelId || !cfg.capiToken) return res.status(400).json({ ok: false, message: 'Pixel ID ও Conversions API Token আগে সেভ করুন' });
      const evt = buildEvent({ headers: { 'user-agent': 'DailyDeal-Admin-Test' }, socket: {} }, {
        event_name: 'PageView', event_id: 'test_' + Date.now(), event_source_url: siteUrl + '/', user: {}, custom_data: {},
      });
      const r = await sendCapi(cfg, evt);
      if (r.status >= 400) return res.status(502).json({ ok: false, message: 'Meta বলছে: ' + scrub((r.body && r.body.error && r.body.error.message) || r.status) });
      res.json({ ok: true, message: cfg.testCode ? 'পাঠানো হয়েছে — Events Manager → Test Events-এ দেখুন' : 'পাঠানো হয়েছে (Test Event Code নেই, তাই লাইভ ইভেন্ট হিসেবে গেছে)' });
    } catch (e) { res.status(502).json({ ok: false, message: 'সংযোগ ব্যর্থ: ' + scrub(e.message) }); }
  });

  /* ───────────── 4) Auto-post to the Facebook Page ───────────── */
  async function graphPost(path, params) {
    const r = await timedFetch(GRAPH + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }, 20000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return j;
  }
  router.post('/post-product', requireAdmin, async (req, res) => {
    try {
      const key = String((req.body && req.body.productKey) || '');
      if (!/^[-\w]{3,80}$/.test(key)) return res.status(400).json({ ok: false, message: 'পণ্যের কী সঠিক নয়' });
      const cfg = await getCfg(true);
      if (!cfg.pageId || !cfg.pageToken) return res.status(400).json({ ok: false, message: 'Facebook Page ID ও Page Access Token সেট করা নেই' });
      const p = (await db.ref('products/' + key).once('value')).val();
      if (!p) return res.status(404).json({ ok: false, message: 'পণ্য পাওয়া যায়নি' });
      const id = String(p.productId || key);
      const link = siteUrl + '/?p=' + encodeURIComponent(id);
      const price = Number(p.price) || 0, old = Number(p.oldPrice) || 0;
      const message = strip(p.name) + '\n\n💰 মূল্য: ৳' + price + (old > price ? ' (আগের দাম ৳' + old + ')' : '') + '\n🛒 অর্ডার করুন: ' + link;
      const img = (Array.isArray(p.images) && p.images[0]) || p.img || '';
      let post;
      try {
        if (!/^https?:\/\//.test(img)) throw new Error('no image');
        const ph = await graphPost('/' + cfg.pageId + '/photos', { url: img, published: 'false', access_token: cfg.pageToken });
        post = await graphPost('/' + cfg.pageId + '/feed', { message, attached_media: JSON.stringify([{ media_fbid: ph.id }]), access_token: cfg.pageToken });
      } catch (imgErr) {
        post = await graphPost('/' + cfg.pageId + '/feed', { message, link, access_token: cfg.pageToken });   // fallback: link preview
      }
      db.ref('_serverPrivate/metaPosts/' + key).set({ postId: post.id || '', at: Date.now() }).catch(() => {});
      res.json({ ok: true, postId: post.id || '' });
    } catch (e) { log('post error', scrub(e.message)); res.status(502).json({ ok: false, message: scrub(e.message) }); }
  });

  app.use('/api/facebook', router);
  log('mounted /api/facebook/* (graph ' + GV + ', encryption ' + (encReady ? 'ready' : 'NOT configured') + ')');
};
