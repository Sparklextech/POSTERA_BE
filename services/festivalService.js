const axios = require('axios');
const mongoose = require('mongoose');
const { get: cfg } = require('./settingsService');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// MongoDB model for caching festivals
const festivalCacheSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'festivals' },
  data: { type: mongoose.Schema.Types.Mixed },
  expiresAt: { type: Date },
}, { timestamps: true });
const FestivalCache = mongoose.model('FestivalCache', festivalCacheSchema);

async function callOpenRouter(messages, temperature = 0.7, maxTokens = 2000) {
  const response = await axios.post(
    OPENROUTER_URL,
    {
      model: 'openai/gpt-4o-mini',
      messages,
      temperature,
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${cfg('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://autoposter.app',
        'X-Title': 'AutoPoster',
      },
      timeout: 60000,
    }
  );
  return response.data.choices[0].message.content.trim();
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days - festivals don't change often

async function getUpcomingFestivals(count = 20) {
  // Check DB cache first
  try {
    const cached = await FestivalCache.findOne({ key: 'festivals' });
    if (cached && cached.expiresAt > new Date() && cached.data?.length > 0) {
      console.log('Returning DB-cached festivals');
      return cached.data.map(f => ({ ...f, date: new Date(f.date) }));
    }
  } catch (e) { /* cache miss, proceed */ }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();

  try {
    const text = await callOpenRouter([{
      role: 'user',
      content: `List the next ${count} major festivals and holidays coming up after ${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}.

Include a mix of:
- Indian festivals (Diwali, Holi, Ugadi, Sankranti, Pongal, Ganesh Chaturthi, Navratri, Dussehra, Onam, Raksha Bandhan, Janmashtami, etc.)
- Global holidays (New Year, Christmas, Easter, Good Friday, Valentine's Day, Mother's Day, Father's Day, etc.)
- Professional days (Teachers' Day, Labour Day, Women's Day, etc.)
- Islamic festivals with correct ${currentYear} dates (Eid ul-Fitr, Eid ul-Adha, etc.)

Use the EXACT correct dates for ${currentYear}/${currentYear + 1}. For lunar calendar festivals, use the accurate Gregorian date.

Return ONLY a valid JSON array. Each object must have:
- "name": festival name
- "date": "YYYY-MM-DD" format with correct date
- "region": "India" or "Global"
- "emoji": one relevant emoji
- "colors": array of 2 hex color codes that represent this festival

Sort by date ascending. No markdown fences.`,
    }]);

    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const festivals = JSON.parse(cleaned).map(f => ({ ...f, date: new Date(f.date) }));

    // Save to DB cache
    await FestivalCache.findOneAndUpdate(
      { key: 'festivals' },
      { data: festivals, expiresAt: new Date(Date.now() + CACHE_TTL) },
      { upsert: true }
    );
    console.log(`Cached ${festivals.length} festivals in DB for 7 days`);
    return festivals;
  } catch (e) {
    console.error('Failed to fetch festivals via AI:', e.message);
    const fallback = getHardcodedFallback(currentYear, currentMonth);
    await FestivalCache.findOneAndUpdate(
      { key: 'festivals' },
      { data: fallback, expiresAt: new Date(Date.now() + CACHE_TTL) },
      { upsert: true }
    ).catch(() => {});
    return fallback;
  }
}

function getHardcodedFallback(year, afterMonth) {
  const all = [
    { name: 'New Year', date: `${year + 1}-01-01`, region: 'Global', emoji: '🎆', colors: ['#FFD700', '#1565C0'] },
    { name: 'Republic Day', date: `${year + 1}-01-26`, region: 'India', emoji: '🇮🇳', colors: ['#FF9933', '#138808'] },
    { name: 'Christmas', date: `${year}-12-25`, region: 'Global', emoji: '🎄', colors: ['#F44336', '#4CAF50'] },
    { name: 'Diwali', date: `${year}-11-01`, region: 'India', emoji: '🪔', colors: ['#FFD700', '#FF5722'] },
  ];
  return all
    .map(f => ({ ...f, date: new Date(f.date) }))
    .filter(f => f.date > new Date())
    .sort((a, b) => a.date - b.date);
}

async function generateFestivalGreeting(festivalName, company) {
  try {
    const text = await callOpenRouter([{
      role: 'user',
      content: `Write a professional LinkedIn festival greeting post for "${festivalName}" from "${company || 'our company'}".

Requirements:
- Warm, professional, inclusive tone
- 80-150 words
- Connect the festival's spirit to professional/business values
- Use 2-3 relevant emojis naturally
- End with a warm wish

Return ONLY valid JSON: {"content": "...", "hashtags": ["tag1", "tag2", "tag3"], "imageHeadline": "Happy ${festivalName}"}
imageHeadline must be max 4 words.
No markdown fences.`,
    }], 0.8, 500);

    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Festival greeting gen failed:', e.message);
    return {
      content: `Wishing everyone a very Happy ${festivalName}! May this special occasion bring joy and prosperity to you and your loved ones. From all of us at ${company || 'our team'}. 🎉`,
      hashtags: [festivalName.replace(/['\s]/g, ''), 'Festival', 'Celebration'],
      imageHeadline: `Happy ${festivalName}`,
    };
  }
}

module.exports = { getUpcomingFestivals, generateFestivalGreeting };
