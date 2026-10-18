import crypto from 'node:crypto';
// AES-256-GCM, random 12-byte IV per record. Format: v1.<iv>.<tag>.<ciphertext> (base64url)
export function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decrypt(key, blob) {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad-secret-format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
export const mask = (s) => { s = String(s || ''); return s.length <= 4 ? '••••' : '••••' + s.slice(-4); };
export const redact = (text, secrets) => {
  let t = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 4) t = t.split(String(s)).join('***');
  return t;
};
