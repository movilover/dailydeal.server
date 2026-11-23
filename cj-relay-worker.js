// Cloudflare Worker: CJ API-র রিলে। Render-এর শেয়ার্ড IP CJ ব্লক করলে কলগুলো এই Worker দিয়ে যায় (আলাদা IP)।
// Cloudflare → Workers → Create → এই কোড পেস্ট → Settings → Variables-এ RELAY_KEY (একটা লম্বা গোপন পাসওয়ার্ড) দিন।
export default {
  async fetch(req, env) {
    if (!env.RELAY_KEY || req.headers.get('X-Relay-Key') !== env.RELAY_KEY) return new Response('forbidden', { status: 403 });
    const u = new URL(req.url);
    if (!u.pathname.startsWith('/api2.0/')) return new Response('not found', { status: 404 });
    const h = new Headers();
    for (const k of ['content-type', 'cj-access-token']) { const v = req.headers.get(k); if (v) h.set(k, v); }
    const r = await fetch('https://developers.cjdropshipping.com' + u.pathname + u.search, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text() });
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' } });
  },
};
