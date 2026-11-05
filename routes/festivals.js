const express = require('express');
const auth = require('../middleware/auth');
const Post = require('../models/Post');
const { getUpcomingFestivals, generateFestivalGreeting } = require('../services/festivalService');
const { generatePosterImage } = require('../services/imageService');
const path = require('path');

const router = express.Router();

// Get upcoming festivals
router.get('/', auth, async (req, res) => {
  try {
    const festivals = await getUpcomingFestivals(30);
    res.json(festivals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate a festival post (greeting + poster image)
router.post('/generate', auth, async (req, res) => {
  try {
    const { festivalName, festivalDate, festivalEmoji, festivalColors } = req.body;

    if (!festivalName) {
      return res.status(400).json({ error: 'Festival name is required' });
    }

    // Generate AI greeting
    const greeting = await generateFestivalGreeting(festivalName, req.user.company);

    // Generate festival poster image
    const logoPath = req.user.logo ? path.join(__dirname, '..', req.user.logo) : null;
    const festiveColor = festivalColors?.[0] || '#FFD700';

    const imageResult = await generatePosterImage(
      {
        imageHeadline: greeting.imageHeadline || `Happy ${festivalName}`, posterHeadline: greeting.imageHeadline || `Happy ${festivalName}`, posterKicker: "Season's greetings", pillar: 'festival',
        title: festivalName,
        hashtags: greeting.hashtags,
      },
      Math.floor(Math.random() * 6),
      logoPath,
      festiveColor,
      req.user.company,
      req.user.imageMode || 'designed',
      req.user.brandProfile
    );

    // Create a scheduled post for this festival
    const scheduledDate = festivalDate ? new Date(festivalDate) : new Date();
    scheduledDate.setHours(9, 0, 0, 0); // Post at 9 AM

    const post = new Post({
      user: req.userId,
      title: `${festivalEmoji || '🎉'} Happy ${festivalName}`,
      content: greeting.content,
      hashtags: greeting.hashtags || [],
      imageUrl: imageResult.url,
      imagePath: imageResult.filepath,
      scheduledDate,
      dayNumber: 0,
      status: 'scheduled',
      postType: 'festival',
      pillar: 'festival',
      platforms: req.user.platforms,
    });

    await post.save();

    res.status(201).json({
      post,
      greeting,
      image: imageResult,
    });
  } catch (error) {
    console.error('Festival post generation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-generate festival posts for all upcoming festivals
router.post('/auto-generate', auth, async (req, res) => {
  try {
    const festivals = await getUpcomingFestivals(10);
    const results = [];

    for (const festival of festivals) {
      // Check if we already have a post for this festival
      const existingPost = await Post.findOne({
        user: req.userId,
        title: { $regex: festival.name, $options: 'i' },
        scheduledDate: {
          $gte: new Date(festival.date.getTime() - 24 * 60 * 60 * 1000),
          $lte: new Date(festival.date.getTime() + 24 * 60 * 60 * 1000),
        },
      });

      if (existingPost) {
        results.push({ festival: festival.name, status: 'exists', post: existingPost });
        continue;
      }

      // Generate greeting
      const greeting = await generateFestivalGreeting(festival.name, req.user.company);

      // Generate poster
      const logoPath = req.user.logo ? path.join(__dirname, '..', req.user.logo) : null;
      const imageResult = await generatePosterImage(
        {
          imageHeadline: greeting.imageHeadline || `Happy ${festival.name}`, posterHeadline: greeting.imageHeadline || `Happy ${festival.name}`, posterKicker: "Season's greetings", pillar: 'festival',
          title: festival.name,
          hashtags: greeting.hashtags,
        },
        Math.floor(Math.random() * 6),
        logoPath,
        festival.colors?.[0] || '#FFD700',
        req.user.company,
        req.user.imageMode || 'designed',
        req.user.brandProfile
      );

      const scheduledDate = new Date(festival.date);
      scheduledDate.setHours(9, 0, 0, 0);

      const post = new Post({
        user: req.userId,
        title: `${festival.emoji || '🎉'} Happy ${festival.name}`,
        content: greeting.content,
        hashtags: greeting.hashtags || [],
        imageUrl: imageResult.url,
        imagePath: imageResult.filepath,
        scheduledDate,
        dayNumber: 0,
        status: 'scheduled',
        campaign: null,
        postType: 'festival',
        pillar: 'festival',
        platforms: req.user.platforms,
      });

      await post.save();
      results.push({ festival: festival.name, status: 'created', post });
    }

    res.status(201).json({ results, total: results.length });
  } catch (error) {
    console.error('Auto-generate festivals failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all festival posts for the user
router.get('/posts', auth, async (req, res) => {
  try {
    const posts = await Post.find({
      user: req.userId,
      postType: 'festival',
      pillar: 'festival',
      platforms: req.user.platforms,
    }).sort({ scheduledDate: 1 });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
