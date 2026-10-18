// Structured logs. Phones are masked; never pass OTP codes, keys or tokens here.
export const maskPhone = (p) => { p = String(p || ''); return p.length < 7 ? '***' : p.slice(0, 2) + '*'.repeat(p.length - 5) + p.slice(-3); };
export const log = (level, msg, extra = {}) => {
  const o = { t: new Date().toISOString(), level, msg, ...extra };
  if (o.phone) o.phone = maskPhone(o.phone);
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(o));
};
