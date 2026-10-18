const KEYS = ['phoneVerify', 'verifyAtSignup', 'verifyResellerSignup', 'verifyAtOrder', 'verifyWithdraw', 'verifyPinReset'];
export const FLAG_KEYS = KEYS;
export function createFlags({ store, now = Date.now, ttlMs = 15000 }) {
  let c = null, at = 0;
  const load = async () => {
    if (c && now() - at < ttlMs) return c;
    const out = {}; await Promise.all(KEYS.map(async (k) => { out[k] = (await store.get(`settings/settings/${k}`)) === true; }));
    c = out; at = now(); return out;
  };
  return { on: async (flag) => { const f = await load(); return f.phoneVerify === true && f[flag] === true; }, all: load, bust: () => { c = null; } };
}
