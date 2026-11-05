require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { startScheduler } = require('./services/schedulerService');

// safety net: no outbound call may hang the publisher; calls that need longer set their own timeout
require('axios').defaults.timeout = 120000;
const app = express();
app.set('trust proxy', 1); // behind Traefik: req.secure reflects the original https
const PORT = process.env.PORT || 5000;

connectDB().then(() => require('./services/settingsService').init()).catch((e) => console.error('settings init failed:', e.message));

// CORS: allow configured frontends, any *.vercel.app preview, and localhost. ALLOW_ALL_ORIGINS=1 to disable the check.
const allowed = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || process.env.ALLOW_ALL_ORIGINS === '1') return cb(null, true);
    if (allowed.includes(origin) || /\.vercel\.app$/.test(new URL(origin).host) || /localhost|127\.0\.0\.1/.test(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/plan', require('./routes/plan'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/social', require('./routes/social'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/bridge', require('./routes/bridge'));
app.use('/api/linkedin', require('./routes/linkedin'));
app.use('/api/website', require('./routes/website'));
app.use('/api/festivals', require('./routes/festivals'));
app.use('/api/admin', require('./routes/admin'));

// Health + configuration flags (no secrets)
app.get('/api/health', (req, res) => {
  const { metaConfigured, xConfigured } = require('./services/socialService');
  const { get: cfg } = require('./services/settingsService');
  const li = require('./config/linkedin');
  res.json({
    status: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    config: {
      ai: !!cfg('OPENROUTER_API_KEY'),
      mockAi: process.env.MOCK_AI === '1',
      linkedin: li.isConfigured(),
      meta: metaConfigured(),
      x: xConfigured(),
      pexels: !!cfg('PEXELS_API_KEY'),
      videoAi: !!cfg('FAL_KEY'),
      publicUrl: process.env.BACKEND_URL || '',
    },
    timestamp: new Date().toISOString(),
  });
});

// Built web UI (single-container deploys): served from ./web with SPA fallback
const webDir = path.join(__dirname, 'web');
if (require('fs').existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

// Multer / JSON errors as JSON
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.message || 'Request failed' });
});

startScheduler();
app.listen(PORT, () => console.log(`API running on port ${PORT}${process.env.MOCK_AI === '1' ? ' (MOCK_AI on)' : ''}`));
