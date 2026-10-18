import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

function v6bytes(ip) {
  let s = ip.toLowerCase().split('%')[0];
  let tail = null;
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const p = m[1].split('.').map(Number); if (p.some((n) => n > 255)) return null; tail = p; s = s.slice(0, -m[1].length) + '0:0'; }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const a = halves[0] ? halves[0].split(':') : [];
  const b = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - a.length - b.length : 0;
  if (fill < 0 || (halves.length === 1 && a.length !== 8)) return null;
  const groups = [...a, ...Array(fill).fill('0'), ...b];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
  if (tail) { out[12] = tail[0]; out[13] = tail[1]; out[14] = tail[2]; out[15] = tail[3]; }
  return out;
}
function v4private(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 88);
}
export function isPrivateIp(ip) {
  const k = net.isIP(ip);
  if (k === 4) { const [a, b] = ip.split('.').map(Number); return v4private(a, b); }
  if (k === 6) {
    const x = v6bytes(ip); if (!x) return true;
    if (x.slice(0, 15).every((n) => n === 0) && (x[15] === 0 || x[15] === 1)) return true;
    if (x.slice(0, 10).every((n) => n === 0) && x[10] === 255 && x[11] === 255) return v4private(x[12], x[13]);
    if (x.slice(0, 12).every((n) => n === 0)) return true;
    if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return true;
    if ((x[0] & 0xfe) === 0xfc) return true;
    if (x[0] === 0xfe && (x[1] & 0xc0) === 0x80) return true;
    if (x[0] === 0xff) return true;
    if (x[0] === 0x20 && x[1] === 0x02) return v4private(x[2], x[3]);
    return false;
  }
  return true;
}
const PORTS = new Set([80, 443, 8080, 8443]);
/** Parse + statically validate an outbound URL. Throws on anything unsafe. */
export function checkUrl(urlStr, { allowHttp = false, allowPrivate = false, anyPort = false } = {}) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('url-invalid'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('url-scheme');
  if (u.username || u.password) throw new Error('url-credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateIp(host)) throw new Error('url-private');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('url-private');
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!anyPort && !PORTS.has(port)) throw new Error('url-port');
  return u;
}
/** HTTP(S) request that re-validates resolved IPs at connect time (blocks DNS rebinding), no redirects, size/time capped. */
export function safeFetch(urlStr, { method = 'GET', headers = {}, body, timeoutMs = 8000, maxBytes = 65536, allowHttp = false, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = checkUrl(urlStr, { allowHttp, allowPrivate, anyPort: allowPrivate }); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const lookup = (hostname, opts, cb) => {
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) return cb(err);
        if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('url-private'));
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    };
    const req = lib.request(u, { method, headers, lookup, timeout: timeoutMs }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(new Error('response-too-large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
/** Adapter-facing helper: builds form/json bodies, parses JSON, never throws on HTTP status. */
export function makeHttp(opts = {}) {
  return async function http_(url, { method = 'POST', headers = {}, form, json, basic } = {}) {
    const h = { 'user-agent': 'dailydeal-otp/1', accept: 'application/json, text/plain, */*', ...headers };
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    if (basic) h.authorization = 'Basic ' + Buffer.from(`${basic[0]}:${basic[1]}`).toString('base64');
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const r = await (opts.fetch || safeFetch)(url, { method, headers: h, body, ...opts.fetchOpts });
    let parsed = null; try { parsed = JSON.parse(r.text); } catch { /* not json */ }
    return { status: r.status, text: r.text, json: parsed };
  };
}
