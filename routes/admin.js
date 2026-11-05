const express = require('express');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const Post = require('../models/Post');

const router = express.Router();

// All admin routes require auth + admin role
router.use(auth, admin);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, totalCampaigns, totalPosts, postedCount, scheduledCount] = await Promise.all([
      User.countDocuments(),
      Campaign.countDocuments(),
      Post.countDocuments(),
      Post.countDocuments({ status: 'posted' }),
      Post.countDocuments({ status: 'scheduled' }),
    ]);

    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email company createdAt role');

    const activeCampaigns = await Campaign.countDocuments({ status: 'active' });

    res.json({
      totalUsers,
      totalCampaigns,
      activeCampaigns,
      totalPosts,
      postedCount,
      scheduledCount,
      recentUsers,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Never send credentials or social tokens to the browser
const SAFE_FIELDS = '-password -linkedin.accessToken -instagram.accessToken -facebook.accessToken -facebook.pages -twitter.accessToken -twitter.refreshToken -twitter.accessSecret';
const RANK = { user: 0, admin: 1, superadmin: 2 };

// List all users
router.get('/users', async (req, res) => {
  try {
    const users = await User.find()
      .sort({ createdAt: -1 })
      .select(SAFE_FIELDS);

    const usersWithStats = await Promise.all(
      users.map(async (u) => {
        const campaigns = await Campaign.countDocuments({ user: u._id });
        const posts = await Post.countDocuments({ user: u._id });
        const posted = await Post.countDocuments({ user: u._id, status: 'posted' });
        const obj = u.toObject();
        return {
          ...obj,
          stats: { campaigns, posts, posted },
          connections: {
            linkedin: !!u.linkedin?.name || u.linkedin?.mode === 'extension',
            instagram: !!u.instagram?.username,
            facebook: !!u.facebook?.pageId,
            twitter: !!u.twitter?.username,
          },
        };
      })
    );

    res.json(usersWithStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user role
router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    // Prevent self-demotion — superadmin can't lock themselves out
    if (req.params.id === req.userId.toString()) {
      return res.status(400).json({ error: "You can't change your own role" });
    }
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Admins manage users; only a superadmin can grant superadmin or touch an admin/superadmin account
    if (req.user.role !== 'superadmin' && (role === 'superadmin' || RANK[target.role] >= RANK.admin)) {
      return res.status(403).json({ error: 'Only a superadmin can change admin or superadmin accounts' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select(SAFE_FIELDS);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.userId.toString()) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (req.user.role !== 'superadmin' && RANK[target.role] >= RANK.admin) {
      return res.status(403).json({ error: 'Only a superadmin can delete admin or superadmin accounts' });
    }
    await User.findByIdAndDelete(req.params.id);
    await Campaign.deleteMany({ user: req.params.id });
    await Post.deleteMany({ user: req.params.id });
    await require('../models/Source').deleteMany({ user: req.params.id });
    res.json({ message: 'User and all their data deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all campaigns across users
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await Campaign.find()
      .populate('user', 'name email company')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Integrations & keys (superadmin only). Secret values never leave the server: the list returns masks. ----
const settings = require('../services/settingsService');
const superadmin = (req, res, next) => (req.user.role === 'superadmin' ? next() : res.status(403).json({ error: 'Only a superadmin can view or change integration keys' }));

router.get('/settings', superadmin, (req, res) => {
  const base = (process.env.BACKEND_URL || '').replace(/\/$/, '');
  res.json({
    keys: settings.list(),
    callbacks: {
      linkedin: `${base}/api/linkedin/callback`,
      meta: `${base}/api/social/meta/callback`,
      x: `${base}/api/social/x/callback`,
    },
  });
});

router.put('/settings', superadmin, async (req, res) => {
  try {
    const changed = await settings.set(req.body?.values || {}, req.userId);
    res.json({ changed, keys: settings.list() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/settings/test', superadmin, async (req, res) => {
  res.json(await settings.test(String(req.body?.key || '')));
});

// System health
router.get('/health', async (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    status: 'ok',
    dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
