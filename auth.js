const bearer = (req) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };
export function createAuth({ adminAuth, appCheck, cfg }) {
  const requireUser = async (req, res, next) => {
    const tok = bearer(req); if (!tok) return res.status(401).json({ ok: false, code: 'NO_AUTH' });
    try { const d = await adminAuth.verifyIdToken(tok); req.user = { uid: d.uid, email: (d.email || '').toLowerCase(), claims: d }; next(); }
    catch { res.status(401).json({ ok: false, code: 'BAD_TOKEN' }); }
  };
  const requireAdmin = async (req, res, next) => requireUser(req, res, () => {
    if (req.user.email !== cfg.adminEmail) return res.status(403).json({ ok: false, code: 'FORBIDDEN' });
    next();
  });
  const requireAppCheck = async (req, res, next) => {
    if (!cfg.appCheckEnforce) return next();
    const t = req.headers['x-firebase-appcheck'];
    if (!t) return res.status(401).json({ ok: false, code: 'NO_APPCHECK' });
    try { await appCheck.verifyToken(String(t)); next(); } catch { res.status(401).json({ ok: false, code: 'BAD_APPCHECK' }); }
  };
  return { requireUser, requireAdmin, requireAppCheck };
}
