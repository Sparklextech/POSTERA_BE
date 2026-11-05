const axios = require('axios');
const { get: cfg } = require('./settingsService');

const PEXELS_API = 'https://api.pexels.com/v1';

async function searchPhotos(query, perPage = 5, page = 1) {
  const res = await axios.get(`${PEXELS_API}/search`, {
    params: { query, per_page: perPage, page, orientation: 'square' },
    headers: { Authorization: cfg('PEXELS_API_KEY') },
    timeout: 15000,
  });
  return res.data.photos.map(p => ({
    id: p.id,
    alt: p.alt,
    photographer: p.photographer,
    url: p.src.large2x || p.src.large || p.src.original,
    original: p.src.original,
  }));
}

// Get a relevant photo for a post topic
async function getPhotoForTopic(topic) {
  // Try specific topic first, then broader terms
  const queries = [
    topic,
    topic.split(' ').slice(0, 3).join(' '),
    'business technology',
  ];

  for (const query of queries) {
    try {
      const photos = await searchPhotos(query, 10);
      if (photos.length > 0) {
        // Pick a random one for variety
        return photos[Math.floor(Math.random() * photos.length)];
      }
    } catch (e) {
      console.log(`Pexels search failed for "${query}":`, e.message);
    }
  }
  return null;
}

// Download a Pexels image as buffer
async function downloadPexelsImage(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data);
}

module.exports = { searchPhotos, getPhotoForTopic, downloadPexelsImage };
