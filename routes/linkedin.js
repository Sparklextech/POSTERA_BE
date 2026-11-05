const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const auth = require('../middleware/auth');
const linkedinService = require('../services/linkedinService');
const li = require('../config/linkedin');
const oauth = require('../services/oauthState');

const router = express.Router();
const isConfigured = li.isConfigured;
const signToken = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

// ---- Connect (existing, logged-in user) ----
router.get('/auth-url', auth, (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'LinkedIn is not set up yet. A superadmin can add the client ID and secret in Admin → Integrations.' });
  const state = oauth.issue(req, res, { userId: req.userId.toString(), purpose: 'linkedin-oauth' });
  res.json({ url: linkedinService.getAuthorizationUrl(state) });
});

// ---- One-click "Continue with LinkedIn": sign in / sign up AND connect posting in a single consent ----
// Top-level navigation (no auth). Frontend sends the user here: GET /api/linkedin/login?origin=<frontend origin>
router.get('/login', (req, res) => {
  const origin = oauth.requestOrigin(req);
  if (!isConfigured()) return res.redirect(`${origin}/login?linkedin=error&reason=${encodeURIComponent('LinkedIn sign-in is not set up on this server yet')}`);
  const state = oauth.issue(req, res, { purpose: 'linkedin-login' });
  res.redirect(linkedinService.getAuthorizationUrl(state, 'openid profile email w_member_social'));
});

// ---- Shared callback for both flows ----
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;
  let purpose = 'linkedin-oauth';
  try { purpose = JSON.parse(Buffer.from(String(state || '').split('.')[1] || '', 'base64url').toString()).purpose || purpose; } catch { /* verified below */ }
  const v = oauth.verify(req, res, state, purpose === 'linkedin-login' ? 'linkedin-login' : 'linkedin-oauth');
  const landing = `${v.origin}${purpose === 'linkedin-login' ? '/login' : '/settings'}`;

  if (oauthError) return res.redirect(`${landing}?linkedin=denied&reason=${encodeURIComponent(error_description || oauthError)}`);
  if (!v.ok) return res.redirect(`${landing}?linkedin=error&reason=${encodeURIComponent(v.reason)}`);
  if (!code) return res.redirect(`${landing}?linkedin=error&reason=missing_code`);
  const decoded = v.data;

  try {
    const tokenData = await linkedinService.getAccessToken(code);
    const profile = await linkedinService.getProfile(tokenData.access_token);
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 5184000) * 1000);
    const displayName = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || 'LinkedIn user';
    const linkedinFields = { 'linkedin.accessToken': tokenData.access_token, 'linkedin.linkedinId': profile.sub, 'linkedin.name': displayName, 'linkedin.expiresAt': expiresAt, 'linkedin.profileUrl': profile.picture || '', 'linkedin.mode': 'api' };

    if (decoded.purpose === 'linkedin-oauth') {
      await User.findByIdAndUpdate(decoded.userId, { ...linkedinFields, $addToSet: { platforms: 'linkedin' } });
      return res.redirect(`${v.origin}/settings?linkedin=success`);
    }

    // linkedin-login: find by LinkedIn id, then by a VERIFIED email, else create
    let user = await User.findOne({ 'linkedin.linkedinId': profile.sub });
    const email = profile.email ? profile.email.toLowerCase() : '';
    if (!user && email) {
      const existing = await User.findOne({ email });
      if (existing && profile.email_verified !== true) {
        return res.redirect(`${landing}?linkedin=error&reason=${encodeURIComponent('An account with this email already exists. Sign in with your password, then connect LinkedIn in Settings.')}`);
      }
      user = existing;
    }
    let created = false;
    if (!user) {
      if (!email) return res.redirect(`${landing}?linkedin=error&reason=${encodeURIComponent('LinkedIn did not share an email address. Register with email instead.')}`);
      user = new User({ name: displayName, email, password: crypto.randomBytes(24).toString('hex'), company: '', timezone: 'UTC' });
      await user.save();
      created = true;
    }
    await User.findByIdAndUpdate(user._id, { ...linkedinFields, $addToSet: { platforms: 'linkedin' } });
    // short-lived hand-off token in the URL fragment (never sent to servers or logged); the app swaps it for a session
    const handoff = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '2m' });
    return res.redirect(`${v.origin}/auth/callback?new=${created ? 1 : 0}#token=${encodeURIComponent(handoff)}`);
  } catch (error) {
    const detail = error.response?.data?.error_description || error.response?.data?.message || error.message;
    console.error('LinkedIn callback error:', detail);
    res.redirect(`${landing}?linkedin=error&reason=${encodeURIComponent(detail)}`);
  }
});

// Swap the 2-minute hand-off token for a normal 30-day session
router.post('/session', auth, (req, res) => res.json({ token: signToken(req.user), user: req.user.toPublic() }));

router.post('/disconnect', auth, async (req, res) => {
  await User.findByIdAndUpdate(req.userId, { 'linkedin.accessToken': '', 'linkedin.linkedinId': '', 'linkedin.name': '', 'linkedin.expiresAt': null });
  res.json({ message: 'LinkedIn disconnected' });
});

router.get('/status', auth, (req, res) => {
  const l = req.user.linkedin || {};
  const expired = l.expiresAt && new Date(l.expiresAt) < new Date();
  res.json({ connected: !!l.accessToken && !expired, name: l.name || '', expired: !!expired, expiresAt: l.expiresAt || null, configured: isConfigured(), mode: l.mode || 'api' });
});

router.post('/test-post', auth, async (req, res) => {
  const l = req.user.linkedin || {};
  if (!l.accessToken) return res.status(400).json({ error: 'LinkedIn not connected' });
  if (l.expiresAt && new Date(l.expiresAt) < new Date()) return res.status(400).json({ error: 'LinkedIn token expired — please reconnect' });
  const text = `Hello from ${req.user.company || req.user.name} — this is a test post sent from our content planner.`;
  try { const result = await linkedinService.createTextPost(l.accessToken, l.linkedinId, text); res.json({ message: 'Test post published to your LinkedIn feed!', postId: result.id }); }
  catch (error) { res.status(500).json({ error: error.response?.data?.message || error.response?.data?.error_description || error.message }); }
});

module.exports = router;
