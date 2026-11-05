const express = require('express');
const path = require('path');
const Campaign = require('../models/Campaign');
const Post = require('../models/Post');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { generatePostsContent } = require('../services/aiService');
const { generatePosterImage } = require('../services/imageService');
const { scrapeWebsite } = require('../services/scraperService');
const { knowledgeFor } = require('../services/sourceService');
const { zonedDate, ymdIn, addDays } = require('../services/planService');

const router = express.Router();

// Background job: generate posts + images for a campaign
async function generateCampaignInBackground(campaignId, userId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    const user = await User.findById(userId);
    if (!campaign || !user) return;
    const tz = campaign.timezone || user.timezone || 'UTC';

    let knowledge = await knowledgeFor(user._id);
    if (campaign.websiteUrl) {
      const scraped = await scrapeWebsite(campaign.websiteUrl);
      if (scraped.success) knowledge = `${scraped.content}\n\n${knowledge}`;
    }

    await Campaign.findByIdAndUpdate(campaignId, { generationStatus: 'generating_content', generationProgress: 5 });
    let postsContent;
    try {
      postsContent = await generatePostsContent(campaign.globalPrompt, campaign.totalPosts, campaign.tone, campaign.includeHashtags, campaign.includeEmoji, knowledge, user.brandProfile, user.company);
    } catch (err) {
      await Campaign.findByIdAndUpdate(campaignId, { generationStatus: 'failed', generationError: err.message });
      return;
    }
    if (!postsContent?.length) {
      await Campaign.findByIdAndUpdate(campaignId, { generationStatus: 'failed', generationError: 'No posts were generated' });
      return;
    }
    await Campaign.findByIdAndUpdate(campaignId, { generationProgress: 30, generationStatus: 'generating_images' });

    // schedule
    let ymd = ymdIn(new Date(), tz);
    const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
    const logoPath = user.logo ? path.join(__dirname, '..', user.logo) : null;
    for (let i = 0; i < postsContent.length; i++) {
      if (i > 0) {
        if (campaign.postFrequency === 'weekly') ymd = addDays(ymd, 7);
        else ymd = addDays(ymd, 1);
      }
      if (campaign.postFrequency === 'weekdays') while (dow(ymd) === 0 || dow(ymd) === 6) ymd = addDays(ymd, 1);
      const g = postsContent[i];
      let imageData = {};
      if (campaign.generateImages) {
        try {
          const r = await generatePosterImage({ ...g, dayNumber: i + 1 }, i, logoPath, user.brandColor, user.company, user.imageMode || 'designed', user.brandProfile);
          imageData = { imageUrl: r.url, imagePath: r.filepath, imageStatus: 'done' };
        } catch (e) { imageData = { imageStatus: 'failed' }; console.error(`Image gen failed for post ${i + 1}:`, e.message); }
      }
      await Post.create({
        campaign: campaignId, user: userId, dayNumber: i + 1, postType: 'campaign', pillar: g.pillar,
        title: g.title, content: g.content, variants: g.variants, hashtags: g.hashtags || [], cta: g.cta,
        imageHeadline: g.imageHeadline, posterHeadline: g.posterHeadline, posterKicker: g.posterKicker, imagePrompt: g.imagePrompt,
        scheduledDate: zonedDate(ymd, campaign.postTime || '09:00', tz),
        status: campaign.requireApproval ? 'draft' : 'scheduled',
        platforms: campaign.platforms?.length ? campaign.platforms : user.platforms,
        ...imageData,
      });
      await Campaign.findByIdAndUpdate(campaignId, { generationProgress: 30 + Math.round(((i + 1) / postsContent.length) * 70) });
    }
    await Campaign.findByIdAndUpdate(campaignId, { generationStatus: 'completed', generationProgress: 100 });
  } catch (error) {
    console.error(`Campaign ${campaignId} generation failed:`, error.message);
    await Campaign.findByIdAndUpdate(campaignId, { generationStatus: 'failed', generationError: error.message }).catch(() => {});
  }
}

router.post('/', auth, async (req, res) => {
  try {
    const { name, globalPrompt, tone, postFrequency, postTime, timezone, totalPosts, includeHashtags, includeEmoji, generateImages, websiteUrl, platforms, requireApproval } = req.body;
    if (!name || !globalPrompt) return res.status(400).json({ error: 'Name and idea are required' });
    const campaign = await Campaign.create({
      user: req.userId, name, globalPrompt, tone: tone || 'professional', postFrequency: postFrequency || 'daily',
      postTime: postTime || '09:00', timezone: timezone || req.user.timezone || 'UTC', totalPosts: Math.min(Number(totalPosts) || 30, 90),
      includeHashtags: includeHashtags !== false, includeEmoji: includeEmoji !== false, generateImages: generateImages !== false,
      websiteUrl: websiteUrl || '', platforms: Array.isArray(platforms) && platforms.length ? platforms : req.user.platforms,
      requireApproval: !!requireApproval, generationStatus: 'pending', generationProgress: 0,
    });
    generateCampaignInBackground(campaign._id, req.userId);
    res.status(201).json({ campaign });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/:id/progress', auth, async (req, res) => {
  const campaign = await Campaign.findOne({ _id: req.params.id, user: req.userId }).select('generationStatus generationProgress generationError');
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

router.get('/', auth, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ user: req.userId }).sort({ createdAt: -1 });
    const stats = await Post.aggregate([{ $match: { user: req.userId, campaign: { $ne: null } } }, { $group: { _id: { c: '$campaign', s: '$status' }, n: { $sum: 1 } } }]);
    const byCamp = {};
    for (const s of stats) { const k = String(s._id.c); byCamp[k] = byCamp[k] || { total: 0 }; byCamp[k][s._id.s] = s.n; byCamp[k].total += s.n; }
    res.json(campaigns.map(c => ({ ...c.toObject(), stats: { total: 0, posted: 0, scheduled: 0, draft: 0, failed: 0, ...(byCamp[String(c._id)] || {}) } })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/:id', auth, async (req, res) => {
  const campaign = await Campaign.findOne({ _id: req.params.id, user: req.userId });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const posts = await Post.find({ campaign: campaign._id }).sort({ dayNumber: 1 });
  res.json({ campaign, posts });
});

const setStatus = (status) => async (req, res) => {
  const campaign = await Campaign.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { status }, { new: true });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
};
router.put('/:id/activate', auth, setStatus('active'));
router.put('/:id/pause', auth, setStatus('paused'));

router.delete('/:id', auth, async (req, res) => {
  const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, user: req.userId });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  await Post.deleteMany({ campaign: campaign._id, status: { $ne: 'posted' } });
  res.json({ message: 'Campaign deleted' });
});

module.exports = router;
