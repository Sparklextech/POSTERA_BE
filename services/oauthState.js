// OAuth "state" for LinkedIn / Meta / X flows.
//  - redirect origins come from an allowlist (FRONTEND_URL, BACKEND_URL, localhost in dev), never straight from the request
//  - state is signed with a key separate from login tokens, so it can never be used to authenticate
//  - each flow is bound to the browser that started it with a one-time nonce in an HttpOnly cookie
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const li = require('../config/linkedin');

const COOKIE = 'oauth_nonce';
const stateKey = () => `${process.env.JWT_SECRET || 'dev-secret'}:oauth-state:v1`;

function allowed() {
  return new Set([...String(process.env.FRONTEND_URL || '').split(','), process.env.BACKEND_URL || '']
    .map((s) => s.trim()).filter(Boolean)
    .map((o) => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean));
}
function safeOrigin(candidate) {
  try {
    const o = new URL(candidate).origin;
    if (allowed().has(o)) return o;
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return o;
  } catch { /* not a URL */ }
  return li.frontendFallback();
}
const requestOrigin = (req) => safeOrigin(req.query.origin || req.get('Origin') || req.get('Referer') || '');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function issue(req, res, payload) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const https = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie(COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: https, maxAge: 15 * 60 * 1000, path: '/api' });
  return jwt.sign({ ...payload, origin: requestOrigin(req), nonce }, stateKey(), { expiresIn: '15m' });
}

// → { ok, data, origin, reason }
function verify(req, res, state, purpose) {
  let d;
  try { d = jwt.verify(String(state || ''), stateKey()); } catch { return { ok: false, origin: li.frontendFallback(), reason: 'This sign-in link expired. Please start again.' }; }
  const origin = safeOrigin(d.origin);
  if (d.purpose !== purpose) return { ok: false, origin, reason: 'Invalid sign-in state. Please start again.' };
  const cookie = readCookie(req, COOKIE);
  res.clearCookie(COOKIE, { path: '/api' });
  if (!cookie || cookie !== d.nonce) return { ok: false, origin, reason: 'This connection was started in a different browser. Please start it again here.' };
  return { ok: true, data: d, origin };
}

module.exports = { issue, verify, safeOrigin, requestOrigin, readCookie };
