const express = require('express');
const path = require('path');
const Post = require('../models/Post');
const auth = require('../middleware/auth');
const { regeneratePost } = require('../services/aiService');
const { generatePosterImage } = require('../services/imageService');
const { generateVideo } = require('../services/videoService');
const { publishPost } = require('../services/schedulerService');

const router = express.Router();

// List with filters
router.get('/', auth, async (req, res) => {
  try {
    const { status, campaign, startDate, endDate, limit } = req.query;
    const filter = { user: req.userId };
    if (status) filter.status = { $in: String(status).split(',') };
    if (campaign) filter.campaign = campaign;
    if (startDate || endDate) {
      filter.scheduledDate = {};
      if (startDate) filter.scheduledDate.$gte = new Date(startDate);
      if (endDate) filter.scheduledDate.$lte = new Date(endDate);
    }
    const posts = await Post.find(filter).populate('campaign', 'name globalPrompt status').sort({ scheduledDate: 1 }).limit(Number(limit) || 500);
    res.json(posts);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Bulk actions: approve | skip | delete | draft | reschedule
router.post('/bulk', auth, async (req, res) => {
  try {
    const { ids, action, scheduledDate, platforms } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const filter = { _id: { $in: ids }, user: req.userId };
    let result;
    if (action === 'approve') result = await Post.updateMany({ ...filter, status: { $in: ['draft', 'failed', 'skipped'] } }, { status: 'scheduled', approvedAt: new Date(), error: '', attempts: 0, nextAttemptAt: null, skipPlatforms: [], igContainerId: '' });
    else if (action === 'skip') result = await Post.updateMany({ ...filter, status: { $in: ['draft', 'scheduled', 'failed'] } }, { status: 'skipped' });
    else if (action === 'draft') result = await Post.updateMany({ ...filter, status: { $in: ['scheduled', 'skipped', 'failed'] } }, { status: 'draft' });
    else if (action === 'delete') result = await Post.deleteMany({ ...filter, status: { $ne: 'posted' } });
    else if (action === 'reschedule' && scheduledDate) result = await Post.updateMany({ ...filter, status: { $ne: 'posted' } }, { scheduledDate: new Date(scheduledDate) });
    else if (action === 'platforms' && Array.isArray(platforms)) result = await Post.updateMany({ ...filter, status: { $ne: 'posted' } }, { platforms });
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ affected: result.modifiedCount ?? result.deletedCount ?? 0 });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Calendar overview
router.get('/schedule/calendar', auth, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.userId }).populate('campaign', 'name').sort({ scheduledDate: 1 })
      .select('title scheduledDate status campaign imageUrl dayNumber pillar platforms postType error');
    res.json(posts);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, user: req.userId }).populate('campaign', 'name globalPrompt tone status');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Edit
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, content, hashtags, scheduledDate, variants, platforms, pillar, cta, imageHeadline, posterHeadline, posterKicker, status, mediaType } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (content) updates.content = content;
    if (Array.isArray(hashtags)) updates.hashtags = hashtags;
    if (scheduledDate) updates.scheduledDate = new Date(scheduledDate);
    if (variants && typeof variants === 'object') for (const k of ['linkedin', 'facebook', 'instagram', 'twitter']) if (variants[k] !== undefined) updates[`variants.${k}`] = String(variants[k]);
    if (Array.isArray(platforms)) updates.platforms = platforms;
    if (pillar) updates.pillar = pillar;
    if (cta !== undefined) updates.cta = cta;
    if (imageHeadline !== undefined) updates.imageHeadline = imageHeadline;
    if (mediaType === 'image' || mediaType === 'video') updates.mediaType = mediaType;
    if (posterHeadline !== undefined) updates.posterHeadline = String(posterHeadline).slice(0, 80);
    if (posterKicker !== undefined) updates.posterKicker = String(posterKicker).slice(0, 30);
    if (status && ['draft', 'scheduled', 'skipped'].includes(status)) { updates.status = status; if (status === 'scheduled') { updates.approvedAt = new Date(); updates.error = ''; updates.attempts = 0; updates.nextAttemptAt = null; updates.skipPlatforms = []; } }
    const post = await Post.findOneAndUpdate({ _id: req.params.id, user: req.userId }, updates, { new: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/:id/approve', auth, async (req, res) => {
  const post = await Post.findOneAndUpdate({ _id: req.params.id, user: req.userId, status: { $ne: 'posted' } }, { status: 'scheduled', approvedAt: new Date(), error: '', attempts: 0, nextAttemptAt: null, skipPlatforms: [], igContainerId: '' }, { new: true });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

router.put('/:id/skip', auth, async (req, res) => {
  const post = await Post.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { status: 'skipped' }, { new: true });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

// Publish right now (ignores schedule)
router.post('/:id/publish', auth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, user: req.userId }).populate('user campaign');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.status === 'posted') return res.status(400).json({ error: 'Already posted' });
    if (post.campaign && post.campaign.status !== 'active') post.campaign.status = 'active'; // one-off manual publish
    const claimed = await publishPost(post, { force: true });
    if (claimed === false) return res.status(409).json({ error: 'This post is already being published' });
    const fresh = await Post.findById(post._id);
    if (fresh.status === 'failed') return res.status(400).json({ error: fresh.error || 'Publish failed', post: fresh });
    res.json(fresh);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Regenerate text (+ image)
router.post('/:id/regenerate', auth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, user: req.userId }).populate('campaign');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const focus = req.body?.instructions || post.campaign?.globalPrompt || post.title;
    const tone = post.campaign?.tone || req.user.brandProfile?.tone || 'professional';
    const fresh = await regeneratePost(focus, tone, post.dayNumber || 1, post.campaign?.totalPosts || 7, req.user.brandProfile, req.user.company, req.body?.pillar || post.pillar);
    Object.assign(post, { title: fresh.title, content: fresh.content, variants: fresh.variants, hashtags: fresh.hashtags, cta: fresh.cta, imageHeadline: fresh.imageHeadline, posterHeadline: fresh.posterHeadline, posterKicker: fresh.posterKicker, imagePrompt: fresh.imagePrompt, pillar: fresh.pillar });
    if (req.body?.withImage !== false) {
      try {
        const logoPath = req.user.logo ? path.join(__dirname, '..', req.user.logo) : null;
        const r = await generatePosterImage(post.toObject(), post.dayNumber || 0, logoPath, req.user.brandColor, req.user.company, req.user.imageMode || 'designed', req.user.brandProfile);
        post.imageUrl = r.url; post.imagePath = r.filepath; post.imageStatus = 'done';
    if (!post.posterHeadline && r.posterHeadline) { post.posterHeadline = r.posterHeadline; post.posterKicker = r.posterKicker; }
      } catch (e) { console.error('Image regen failed:', e.message); }
    }
    await post.save();
    res.json(post);
  } catch (error) { res.status(error.status === 402 ? 402 : 500).json({ error: error.message }); }
});

router.post('/:id/regenerate-image', auth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, user: req.userId });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (req.body?.imagePrompt) post.imagePrompt = req.body.imagePrompt;
    const logoPath = req.user.logo ? path.join(__dirname, '..', req.user.logo) : null;
    const mode = req.body?.mode || req.user.imageMode || 'designed';
    const r = await generatePosterImage(post.toObject(), Math.floor(Math.random() * 6), logoPath, req.user.brandColor, req.user.company, mode, req.user.brandProfile);
    post.imageUrl = r.url; post.imagePath = r.filepath; post.imageStatus = 'done';
    if (!post.posterHeadline && r.posterHeadline) { post.posterHeadline = r.posterHeadline; post.posterKicker = r.posterKicker; }
    await post.save();
    res.json(post);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Video + voice-over
router.post('/:id/video', auth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, user: req.userId });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (req.body?.script) post.videoScript = req.body.script;
    if (req.body?.replan) { post.videoScript = ''; post.videoPlan = null; }
    post.videoStatus = 'pending'; await post.save();
    const r = await generateVideo(post, req.user);
    post.videoUrl = r.videoUrl; post.videoPath = r.videoPath; post.videoScript = r.script; post.videoPlan = r.plan; post.videoStatus = 'done';
    await post.save();
    res.json(post);
  } catch (error) {
    await Post.findByIdAndUpdate(req.params.id, { videoStatus: 'failed' }).catch(() => {});
    res.status(500).json({ error: `Video failed: ${error.message}` });
  }
});

router.delete('/:id', auth, async (req, res) => {
  const post = await Post.findOneAndDelete({ _id: req.params.id, user: req.userId, status: { $ne: 'posted' } });
  if (!post) return res.status(404).json({ error: 'Post not found or already posted' });
  res.json({ message: 'Deleted' });
});

// ---- Manual posts ----
router.post('/', auth, async (req, res) => {
  try {
    const { title, content, pillar, platforms, scheduledDate, status, imagePrompt, hashtags, variants } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: 'Post text is required' });
    const post = await Post.create({
      user: req.userId, postType: 'plan', dayNumber: 0, pillar: pillar || 'showcase', title: (title || content.split('\n')[0]).slice(0, 120), content: content.trim(),
      hashtags: Array.isArray(hashtags) ? hashtags : [], variants: variants || {}, imagePrompt: imagePrompt || '', imageHeadline: '',
      platforms: Array.isArray(platforms) && platforms.length ? platforms : req.user.platforms, scheduledDate: scheduledDate ? new Date(scheduledDate) : new Date(),
      status: status === 'scheduled' ? 'scheduled' : 'draft', approvedAt: status === 'scheduled' ? new Date() : undefined,
    });
    res.status(201).json(post);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// AI assist for the composer: write | improve | shorter | hook | hashtags
router.post('/assist', auth, async (req, res) => {
  try {
    const { assist } = require('../services/aiService');
    const { knowledgeFor } = require('../services/sourceService');
    const knowledge = await knowledgeFor(req.userId, 3000);
    const out = await assist({ ...req.body, brand: req.user.brandProfile, company: req.user.company, knowledge });
    res.json(out);
  } catch (error) { res.status(error.status === 402 ? 402 : 500).json({ error: error.message }); }
});

// Attach an uploaded image as the poster
const multer = require('multer');
const fs = require('fs');
const postersDir = path.join(__dirname, '..', 'uploads', 'posters');
fs.mkdirSync(postersDir, { recursive: true });
const imgUpload = multer({ storage: multer.diskStorage({ destination: (q, f, cb) => cb(null, postersDir), filename: (q, f, cb) => cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${path.extname(f.originalname || '.png')}`) }), limits: { fileSize: 12 * 1024 * 1024 }, fileFilter: (q, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
router.post('/:id/image', auth, imgUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const post = await Post.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { imageUrl: `/uploads/posters/${req.file.filename}`, imagePath: req.file.path, imageStatus: 'done' }, { new: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
