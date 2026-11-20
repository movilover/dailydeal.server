// Render ফ্রি প্ল্যানে ১৫ মিনিট ট্রাফিক না থাকলে সার্ভার ঘুমায়। জেগে থাকা অবস্থায় প্রতি ১০ মিনিটে নিজের /ping কল করে।
// RENDER_EXTERNAL_URL Render নিজেই দেয়। বন্ধ করতে Environment-এ KEEPALIVE_SELF=0।
export function startSelfPing(env = process.env) {
  const url = String(env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (env.KEEPALIVE_SELF === '0' || !/^https:\/\//.test(url)) return null;
  const t = setInterval(() => {
    const c = new AbortController(); const to = setTimeout(() => c.abort(), 10000);
    fetch(url + '/ping', { signal: c.signal, headers: { 'User-Agent': 'dd-keepalive' } }).catch(() => {}).finally(() => clearTimeout(to));
  }, 10 * 60 * 1000);
  t.unref(); return t;
}
