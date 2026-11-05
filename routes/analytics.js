const express = require('express');
const auth = require('../middleware/auth');
const { overview, syncUser } = require('../services/analyticsService');

const router = express.Router();

router.get('/overview', auth, async (req, res) => {
  try { res.json(await overview(req.userId, Math.min(Number(req.query.days) || 30, 180))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync', auth, async (req, res) => {
  try { const n = await syncUser(req.userId); res.json({ synced: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
