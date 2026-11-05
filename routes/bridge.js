// Bridge for the Postera Chrome extension (LinkedIn without an API key).
// The extension runs in the user's own browser, polls for due LinkedIn posts, publishes them through the
// user's logged-in LinkedIn session, and reports back. Everything here is scoped to the authenticated user.
const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Post = require('../models/Post');

const router = express.Router();
router.use(auth);

// Extension says hello every minute → marks LinkedIn as "connected via extension"
router.post('/heartbeat', async (req, res) => {
  const { name, version } = req.body || {};
  const updates = { 'linkedin.mode': 'extension', 'linkedin.extensionSeenAt': new Date() };
  if (name && !req.user.linkedin?.name) updates['linkedin.name'] = name;
  await User.findByIdAndUpdate(req.userId, updates);
  res.json({ ok: true, version, serverTime: new Date().toISOString() });
});

// Due LinkedIn posts for this user that the extension should publish
router.get('/due', async (req, res) => {
  if (req.user.linkedin?.mode !== 'extension') return res.json({ posts: [] });
  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const posts = await Post.find({
    user: req.userId, status: 'scheduled', scheduledDate: { $lte: new Date() }, platforms: 'linkedin', skipPlatforms: { $ne: 'linkedin' },
    'postedTo.linkedin.postId': { $in: [null, ''] },
  }).populate('campaign', 'status').limit(5);
  const ready = posts.filter(p => !p.campaign || p.campaign.status === 'active');
  res.json({ posts: ready.map(p => ({ id: p._id, text: p.textFor('linkedin'), imageUrl: p.imageUrl ? `${base}${p.imageUrl}` : '', title: p.title, scheduledDate: p.scheduledDate })) });
});

// Extension result
router.post('/result/:id', async (req, res) => {
  const { ok, postId, error } = req.body || {};
  const post = await Post.findOne({ _id: req.params.id, user: req.userId });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  post.postedTo = post.postedTo || {};
  const otherErrors = String(post.error || '').replace(/^Waiting for the browser extension \(LinkedIn\)( — )?/, '');
  if (ok) {
    post.postedTo.linkedin = { postId: postId || 'extension', postedAt: new Date() };
    post.linkedinPostId = postId || '';
    // done once every platform is either posted or permanently skipped
    const remaining = (post.platforms || []).filter((p) => !post.postedTo[p]?.postId && !(post.skipPlatforms || []).includes(p));
    if (!remaining.length) { post.status = 'posted'; post.postedAt = post.postedAt || new Date(); post.error = otherErrors ? `Published, but ${otherErrors}` : ''; }
  } else {
    post.skipPlatforms = [...new Set([...(post.skipPlatforms || []), 'linkedin'])];
    const anyPosted = (post.platforms || []).some((p) => post.postedTo[p]?.postId);
    post.status = anyPosted ? 'posted' : 'failed';
    post.error = [`linkedin (extension): ${error || 'unknown error'}`, otherErrors].filter(Boolean).join(' | ');
  }
  post.markModified('postedTo');
  await post.save();
  res.json({ ok: true, status: post.status });
});

// Switch LinkedIn mode: 'api' (official OAuth) or 'extension'
router.put('/mode', async (req, res) => {
  const mode = req.body?.mode === 'extension' ? 'extension' : 'api';
  await User.findByIdAndUpdate(req.userId, { 'linkedin.mode': mode, ...(mode === 'api' ? {} : {}) });
  res.json({ mode });
});

// Token for the extension popup (user pastes it): just re-issues the current JWT so the popup doesn't need a password
router.get('/token', (req, res) => {
  const jwt = require('jsonwebtoken');
  res.json({ token: jwt.sign({ userId: req.userId, scope: 'extension' }, process.env.JWT_SECRET, { expiresIn: '180d' }) });
});

module.exports = router;
