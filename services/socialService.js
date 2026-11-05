// Meta (Facebook Page + Instagram Business) and X (OAuth 2.0 PKCE) connections.
// Everything is env-gated: without app credentials the UI shows "not configured".
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');
const { get: cfg } = require('./settingsService');

const BACKEND_URL = () => process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
const META = () => ({ id: cfg('META_APP_ID'), secret: cfg('META_APP_SECRET'), redirect: `${BACKEND_URL()}/api/social/meta/callback` });
const X = () => ({ id: cfg('X_CLIENT_ID'), secret: cfg('X_CLIENT_SECRET'), redirect: `${BACKEND_URL()}/api/social/x/callback` });

const metaConfigured = () => !!(META().id && META().secret);
const xConfigured = () => !!X().id;

// ---------- Meta ----------
const META_SCOPES = 'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,business_management';

function metaAuthUrl(state) {
  const { id, redirect } = META();
  const p = new URLSearchParams({ client_id: id, redirect_uri: redirect, state, scope: META_SCOPES, response_type: 'code' });
  return `https://www.facebook.com/v21.0/dialog/oauth?${p}`;
}

async function metaExchange(code) {
  const { id, secret, redirect } = META();
  const short = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', { params: { client_id: id, client_secret: secret, redirect_uri: redirect, code } });
  const long = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: short.data.access_token } });
  const token = long.data.access_token;
  const pages = await axios.get('https://graph.facebook.com/v21.0/me/accounts', { params: { access_token: token, fields: 'id,name,access_token' } });
  return { userToken: token, expiresIn: long.data.expires_in, pages: pages.data.data || [] };
}

// Select a page (and its linked Instagram business account) as the publish target
async function metaSelectPage(user, pageId) {
  const page = (user.facebook.pages || []).find(p => p.id === pageId);
  if (!page) throw new Error('Page not found in your connected pages');
  user.facebook.pageId = page.id; user.facebook.pageName = page.name; user.facebook.accessToken = page.access_token;
  try {
    const ig = await axios.get(`https://graph.facebook.com/v21.0/${page.id}`, { params: { fields: 'instagram_business_account{id,username}', access_token: page.access_token } });
    const acct = ig.data.instagram_business_account;
    if (acct) { user.instagram.userId = acct.id; user.instagram.username = acct.username || ''; user.instagram.accessToken = page.access_token; }
    else { user.instagram.userId = ''; user.instagram.username = ''; user.instagram.accessToken = ''; }
  } catch (e) { /* page has no IG */ }
  const set = new Set(user.platforms || []); set.add('facebook'); if (user.instagram.userId) set.add('instagram');
  user.platforms = [...set];
  await user.save();
  return user;
}

async function metaDisconnect(user) {
  user.facebook = { accessToken: '', pageId: '', pageName: '', pages: [] };
  user.instagram = { accessToken: '', userId: '', username: '' };
  user.platforms = (user.platforms || []).filter(p => !['facebook', 'instagram'].includes(p));
  await user.save();
}

// ---------- X (Twitter) OAuth 2.0 with PKCE ----------
const verifiers = new Map(); // state nonce -> { verifier, exp }  (single-instance; fine for now)
const X_SCOPES = 'tweet.read tweet.write users.read offline.access';

function xAuthUrl(state) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  verifiers.set(state, { verifier, exp: Date.now() + 15 * 60 * 1000 });
  for (const [k, v] of verifiers) if (v.exp < Date.now()) verifiers.delete(k);
  const p = new URLSearchParams({ response_type: 'code', client_id: X().id, redirect_uri: X().redirect, scope: X_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `https://twitter.com/i/oauth2/authorize?${p}`;
}

function xBasicAuth() {
  const { id, secret } = X();
  return secret ? { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') } : {};
}

async function xExchange(code, state) {
  const entry = verifiers.get(state);
  if (!entry) throw new Error('OAuth session expired, please try again');
  verifiers.delete(state);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: X().redirect, client_id: X().id, code_verifier: entry.verifier });
  const res = await axios.post('https://api.twitter.com/2/oauth2/token', body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...xBasicAuth() } });
  const me = await axios.get('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${res.data.access_token}` } });
  return { ...res.data, user: me.data.data };
}

async function ensureTwitterToken(user) {
  const tw = user.twitter || {};
  if (!tw.accessToken) throw new Error('X not connected');
  if (!tw.expiresAt || new Date(tw.expiresAt).getTime() - Date.now() > 60 * 1000) return tw.accessToken;
  if (!tw.refreshToken) throw new Error('X token expired — reconnect in Settings');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tw.refreshToken, client_id: X().id });
  const res = await axios.post('https://api.twitter.com/2/oauth2/token', body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...xBasicAuth() } });
  await User.findByIdAndUpdate(user._id, {
    'twitter.accessToken': res.data.access_token,
    'twitter.refreshToken': res.data.refresh_token || tw.refreshToken,
    'twitter.expiresAt': new Date(Date.now() + (res.data.expires_in || 7200) * 1000),
  });
  return res.data.access_token;
}

async function xDisconnect(user) {
  user.twitter = { accessToken: '', refreshToken: '', accessSecret: '', userId: '', username: '', expiresAt: null };
  user.platforms = (user.platforms || []).filter(p => p !== 'twitter');
  await user.save();
}

module.exports = { metaConfigured, xConfigured, metaAuthUrl, metaExchange, metaSelectPage, metaDisconnect, xAuthUrl, xExchange, ensureTwitterToken, xDisconnect };
