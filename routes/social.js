const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const social = require('../services/socialService');
const li = require('../config/linkedin');
const oauth = require('../services/oauthState');

const router = express.Router();

// Overview of every platform: configured (app creds present) + connected (user token present)
router.get('/status', auth, (req, res) => {
  const u = req.user.toPublic();
  const liConfigured = li.isConfigured();
  res.json({
    linkedin: { configured: liConfigured, ...u.connections.linkedin },
    facebook: { configured: social.metaConfigured(), ...u.connections.facebook },
    instagram: { configured: social.metaConfigured(), ...u.connections.instagram },
    twitter: { configured: social.xConfigured(), ...u.connections.twitter },
    platforms: req.user.platforms,
  });
});

// ---- Meta ----
router.get('/meta/auth-url', auth, (req, res) => {
  if (!social.metaConfigured()) return res.status(400).json({ error: 'Facebook & Instagram are not set up yet. A superadmin can add the Meta app ID and secret in Admin → Integrations.' });
  res.json({ url: social.metaAuthUrl(oauth.issue(req, res, { userId: req.userId.toString(), purpose: 'meta-oauth' })) });
});

router.get('/meta/callback', async (req, res) => {
  const v = oauth.verify(req, res, req.query.state, 'meta-oauth');
  const front = v.origin; const d = v.data;
  if (req.query.error) return res.redirect(`${front}/settings?meta=denied&reason=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  if (!v.ok || !req.query.code) return res.redirect(`${front}/settings?meta=error&reason=${encodeURIComponent(v.reason || 'missing_code')}`);
  try {
    const { pages, expiresIn } = await social.metaExchange(req.query.code);
    const user = await User.findById(d.userId);
    user.facebook.pages = pages.map(p => ({ id: p.id, name: p.name, access_token: p.access_token }));
    user.facebook.expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined;
    await user.save();
    if (pages.length === 1) await social.metaSelectPage(user, pages[0].id);
    res.redirect(`${front}/settings?meta=${pages.length === 1 ? 'success' : pages.length === 0 ? 'nopages' : 'choose'}`);
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    res.redirect(`${front}/settings?meta=error&reason=${encodeURIComponent(detail)}`);
  }
});

router.put('/meta/page', auth, async (req, res) => {
  try { const user = await social.metaSelectPage(req.user, req.body.pageId); res.json(user.toPublic().connections); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/meta/disconnect', auth, async (req, res) => { await social.metaDisconnect(req.user); res.json({ message: 'Facebook & Instagram disconnected' }); });

// ---- X ----
router.get('/x/auth-url', auth, (req, res) => {
  if (!social.xConfigured()) return res.status(400).json({ error: 'X is not set up yet. A superadmin can add the X client ID and secret in Admin → Integrations.' });
  res.json({ url: social.xAuthUrl(oauth.issue(req, res, { userId: req.userId.toString(), purpose: 'x-oauth' })) });
});

router.get('/x/callback', async (req, res) => {
  const v = oauth.verify(req, res, req.query.state, 'x-oauth');
  const front = v.origin; const d = v.data;
  if (req.query.error) return res.redirect(`${front}/settings?x=denied&reason=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  if (!v.ok || !req.query.code) return res.redirect(`${front}/settings?x=error&reason=${encodeURIComponent(v.reason || 'missing_code')}`);
  try {
    const t = await social.xExchange(req.query.code, req.query.state);
    const user = await User.findById(d.userId);
    user.twitter = { accessToken: t.access_token, refreshToken: t.refresh_token || '', accessSecret: '', userId: t.user?.id || '', username: t.user?.username || '', expiresAt: new Date(Date.now() + (t.expires_in || 7200) * 1000) };
    if (!user.platforms.includes('twitter')) user.platforms.push('twitter');
    await user.save();
    res.redirect(`${front}/settings?x=success`);
  } catch (e) {
    const detail = e.response?.data?.error_description || e.response?.data?.error || e.message;
    res.redirect(`${front}/settings?x=error&reason=${encodeURIComponent(detail)}`);
  }
});

router.post('/x/disconnect', auth, async (req, res) => { await social.xDisconnect(req.user); res.json({ message: 'X disconnected' }); });

module.exports = router;
