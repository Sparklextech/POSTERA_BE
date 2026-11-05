const express = require('express');
const auth = require('../middleware/auth');
const { scrapeWebsite } = require('../services/scraperService');

const router = express.Router();

// Scrape a website and return extracted content
router.post('/scrape', auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const result = await scrapeWebsite(url);

    if (!result.success) {
      return res.status(400).json({ error: `Failed to scrape: ${result.error}` });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
