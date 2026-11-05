const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Post = require('../models/Post');
const { generatePlan, zonedDate, ymdIn, addDays } = require('../services/planService');

const router = express.Router();

// Posts in a date range (default: this week in the user's timezone)
router.get('/', auth, async (req, res) => {
  try {
    const tz = req.user.timezone || 'UTC';
    const start = req.query.start || ymdIn(new Date(), tz);
    const days = Math.min(Number(req.query.days) || 7, 62);
    const from = zonedDate(start, '00:00', tz);
    const to = zonedDate(addDays(start, days), '00:00', tz);
    const posts = await Post.find({ user: req.userId, scheduledDate: { $gte: from, $lt: to } })
      .populate('campaign', 'name status').sort({ scheduledDate: 1 });
    const counts = posts.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
    res.json({ start, days, timezone: tz, posts, counts });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Generate a week (or month) of posts
router.post('/generate', auth, async (req, res) => {
  try {
    const { startDate, days, count, platforms, requireApproval, postTime, focus, generateImages, pillars } = req.body || {};
    const posts = await generatePlan(req.user, { startDate, days, count, platforms, requireApproval, postTime, focus, generateImages, pillars });
    res.status(201).json({ posts, total: posts.length });
  } catch (error) {
    console.error('Plan generation failed:', error.message);
    res.status(error.status === 402 ? 402 : 500).json({ error: error.message });
  }
});

router.get('/autopilot', auth, (req, res) => res.json(req.user.autopilot || {}));

router.put('/autopilot', auth, async (req, res) => {
  try {
    const allowed = ['enabled', 'postsPerWeek', 'postTime', 'platforms', 'requireApproval', 'generateImages'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[`autopilot.${k}`] = req.body[k];
    if (updates['autopilot.postsPerWeek'] !== undefined) updates['autopilot.postsPerWeek'] = Math.min(Math.max(Number(updates['autopilot.postsPerWeek']) || 1, 1), 21);
    if (req.body.enabled) updates['autopilot.lastRunAt'] = null; // run on next tick
    const user = await User.findByIdAndUpdate(req.userId, updates, { new: true });
    res.json(user.autopilot);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Kick autopilot now (fills the next 7 days immediately)
router.post('/autopilot/run', auth, async (req, res) => {
  try {
    const user = req.user;
    const tz = user.timezone || 'UTC';
    const today = ymdIn(new Date(), tz);
    const have = await Post.countDocuments({ user: user._id, scheduledDate: { $gte: zonedDate(today, '00:00', tz), $lt: zonedDate(addDays(today, 7), '00:00', tz) }, status: { $in: ['draft', 'scheduled', 'posted'] } });
    const need = (user.autopilot?.postsPerWeek || 5) - have;
    if (need <= 0) return res.json({ posts: [], total: 0, message: 'Next 7 days already full' });
    const posts = await generatePlan(user, { startDate: today, days: 7, count: need });
    await User.findByIdAndUpdate(user._id, { 'autopilot.lastRunAt': new Date(), 'autopilot.lastError': '' });
    res.status(201).json({ posts, total: posts.length });
  } catch (error) { res.status(error.status === 402 ? 402 : 500).json({ error: error.message }); }
});

module.exports = router;
