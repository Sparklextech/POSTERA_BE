// Render posters for a user's recent posts without touching the DB. Usage:
//   node scripts/poster-test.js <email> <mode: designed|premium|ai|canvas> [count]
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Post');
const { generatePosterImage } = require('../services/imageService');

(async () => {
  const [email, mode = 'canvas', count = '2'] = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI_LOCAL || 'mongodb://127.0.0.1:27017/postera');
  const user = await User.findOne({ email });
  if (!user) { console.error('no user', email); process.exit(1); }
  const posts = await Post.find({ user: user._id }).sort({ scheduledDate: 1 }).limit(Number(count));
  const logoPath = user.logo ? path.join(__dirname, '..', user.logo) : null;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i].toObject();
    const t0 = Date.now();
    const r = await generatePosterImage(p, i, logoPath, user.brandColor, user.company, mode, user.brandProfile);
    console.log(`${mode} #${i} [${p.pillar}] "${p.posterHeadline || p.imageHeadline}" -> ${r.filepath} (${r.source}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
