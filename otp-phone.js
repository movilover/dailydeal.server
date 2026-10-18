// Same normalisation as the site (otpNormPhone) so that claim `vph` always equals the phone the site writes.
export function normalizeBD(raw) {
  let d = String(raw ?? '').replace(/[^\d]/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  if (d.length === 10 && d[0] === '1') d = '0' + d;
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}
export const toIntl = (bd) => '88' + bd;           // 8801XXXXXXXXX
export const isBdIntl = (to) => /^8801[3-9]\d{8}$/.test(String(to));
export const needsUnicode = (t) => /[^\x00-\x7F]/.test(t);
export const PURPOSES = {
  signup:         { flag: 'verifyAtSignup' },
  reseller_signup:{ flag: 'verifyResellerSignup', reseller: true },
  order:          { flag: 'verifyAtOrder' },
  withdraw:       { flag: 'verifyWithdraw', reseller: true },
  recharge:       { flag: 'verifyWithdraw', reseller: true },
  service:        { flag: 'verifyWithdraw', reseller: true },
  pin_reset:      { flag: 'verifyPinReset' },
};
export const RESELLER_DOMAIN = '@r.dailydeal.world';
