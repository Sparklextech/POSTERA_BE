// Render a video for a user's first post and dump contact-sheet frames. Usage: node scripts/video-test.js <email> [postIndex]
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const ffmpegPath = require('ffmpeg-static');
const User = require('../models/User');
const Post = require('../models/Post');
const { generateVideo } = require('../services/videoService');

(async () => {
  const [email, idx = '0'] = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI_LOCAL || 'mongodb://127.0.0.1:27017/postera');
  const user = await User.findOne({ email });
  const posts = await Post.find({ user: user._id }).sort({ scheduledDate: 1 });
  const post = posts[Number(idx)];
  console.log('post:', post.title, '| poster:', post.imagePath ? 'yes' : 'no', '| FAL_KEY:', process.env.FAL_KEY ? 'set' : 'not set');
  const t0 = Date.now();
  const r = await generateVideo(post, user);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, r.videoPath);
  console.log('plan:', JSON.stringify(r.plan));
  console.log('voiceover:', r.script);
  const sheet = r.videoPath.replace(/\.mp4$/, '-sheet.png');
  execFileSync(ffmpegPath, ['-y', '-i', r.videoPath, '-vf', `fps=1/${Math.max(1, Math.round(r.plan.seconds / 8))},scale=270:-1,tile=8x1`, '-frames:v', '1', sheet]);
  console.log('contact sheet ->', sheet);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
