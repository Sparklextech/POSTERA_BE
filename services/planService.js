const path = require('path');
const Post = require('../models/Post');
const User = require('../models/User');
const Source = require('../models/Source');
const { generatePlanPosts } = require('./aiService');
const { generatePosterImage } = require('./imageService');
const { knowledgeFor } = require('./sourceService');

// ---- time helpers (IANA timezone aware, no deps) ----
function tzOffsetMs(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
    const g = (t) => Number(parts.find(p => p.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - date.getTime();
  } catch { return 0; }
}
// 'YYYY-MM-DD' + 'HH:mm' in tz → Date (UTC instant)
function zonedDate(ymd, hhmm, tz = 'UTC') {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = (hhmm || '09:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm || 0);
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}
// Date → 'YYYY-MM-DD' in tz
function ymdIn(date, tz = 'UTC') {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(date); // en-CA gives YYYY-MM-DD
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Weighted round-robin pillar sequence, starting after the pillars used most recently
function pillarSequence(weights = {}, count, recentPillars = []) {
  const w = { educate: 3, showcase: 2, proof: 1, story: 1, trend: 1, engage: 1, offer: 1, ...weights };
  const keys = Object.keys(w).filter(k => k !== 'festival' && w[k] > 0);
  if (!keys.length) return Array(count).fill('educate');
  // build one cycle by interleaving (largest weights spread out)
  const total = keys.reduce((s, k) => s + w[k], 0);
  const cycle = [];
  const acc = Object.fromEntries(keys.map(k => [k, 0]));
  for (let i = 0; i < total; i++) {
    for (const k of keys) acc[k] += w[k];
    const pick = keys.reduce((a, b) => (acc[a] >= acc[b] ? a : b));
    acc[pick] -= total;
    cycle.push(pick);
  }
  // rotate so we don't repeat what was just posted
  let start = 0;
  const last = recentPillars[0];
  if (last) { const idx = cycle.indexOf(last); if (idx >= 0) start = idx + 1; }
  return Array.from({ length: count }, (_, i) => cycle[(start + i) % cycle.length]);
}

// Pick `count` posting days in [startYmd, startYmd+days), spreading evenly and avoiding days that already have posts
function pickDays(startYmd, days, count, busyYmds = new Set()) {
  const all = Array.from({ length: days }, (_, i) => addDays(startYmd, i));
  const free = all.filter(d => !busyYmds.has(d));
  const pool = free.length >= Math.min(count, days) ? free : all;
  if (count >= pool.length) {
    // more posts than days: cycle through days
    return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
  }
  const picked = [];
  const step = pool.length / count;
  for (let i = 0; i < count; i++) picked.push(pool[Math.min(Math.floor((i + 0.5) * step), pool.length - 1)]);
  return picked;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Generate posts for a date window.
 * opts: { startDate 'YYYY-MM-DD', days (7|30), count, platforms[], requireApproval, postTime 'HH:mm', focus, generateImages, pillars{} }
 */
async function generatePlan(user, opts = {}) {
  const tz = user.timezone || 'UTC';
  const startDate = opts.startDate || ymdIn(new Date(), tz);
  const days = Number(opts.days) || 7;
  const count = Math.min(Math.max(Number(opts.count) || user.autopilot?.postsPerWeek || 5, 1), 60);
  const platforms = (opts.platforms && opts.platforms.length ? opts.platforms : (user.autopilot?.platforms?.length ? user.autopilot.platforms : user.platforms)) || ['linkedin'];
  const postTime = opts.postTime || user.autopilot?.postTime || '09:00';
  const requireApproval = opts.requireApproval !== undefined ? !!opts.requireApproval : (user.autopilot?.requireApproval !== false);
  const generateImages = opts.generateImages !== undefined ? !!opts.generateImages : (user.autopilot?.generateImages !== false);

  const windowStart = zonedDate(startDate, '00:00', tz);
  const windowEnd = zonedDate(addDays(startDate, days), '00:00', tz);
  const existing = await Post.find({ user: user._id, scheduledDate: { $gte: windowStart, $lt: windowEnd }, status: { $ne: 'skipped' } }).select('scheduledDate pillar title');
  const busy = new Set(existing.map(p => ymdIn(p.scheduledDate, tz)));
  const recent = await Post.find({ user: user._id }).sort({ scheduledDate: -1 }).limit(30).select('title pillar');

  const dates = pickDays(startDate, days, count, busy);
  const pillars = pillarSequence({ ...(user.brandProfile?.pillars || {}), ...(opts.pillars || {}) }, count, recent.map(r => r.pillar));
  const slots = dates.map((date, i) => ({ date: `${date} (${DOW[new Date(date + 'T00:00:00Z').getUTCDay()]})`, ymd: date, pillar: pillars[i] }));

  const knowledge = await knowledgeFor(user._id);
  const generated = await generatePlanPosts({
    brand: user.brandProfile || {}, company: user.company, slots,
    knowledge, recentTitles: recent.map(r => r.title), focus: opts.focus || '', tone: user.brandProfile?.tone,
  });

  // second post on the same day goes to an afternoon slot
  const perDay = {};
  const docs = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    perDay[s.ymd] = (perDay[s.ymd] || 0) + 1;
    const time = perDay[s.ymd] === 1 ? postTime : (perDay[s.ymd] === 2 ? '17:00' : '13:00');
    const g = generated[i];
    docs.push({
      user: user._id, postType: 'plan', pillar: g.pillar, title: g.title, content: g.content, variants: g.variants,
      hashtags: g.hashtags, cta: g.cta, imageHeadline: g.imageHeadline, posterHeadline: g.posterHeadline, posterKicker: g.posterKicker, imagePrompt: g.imagePrompt,
      scheduledDate: zonedDate(s.ymd, time, tz), status: requireApproval ? 'draft' : 'scheduled',
      approvedAt: requireApproval ? undefined : new Date(), platforms,
      imageStatus: generateImages ? 'pending' : 'none', dayNumber: i + 1,
    });
  }
  const posts = await Post.insertMany(docs);
  if (generateImages) renderImagesInBackground(posts.map(p => p._id), user._id);
  return posts;
}

// Sequential image rendering so we don't hammer the image API
async function renderImagesInBackground(postIds, userId) {
  try {
    const user = await User.findById(userId);
    const logoPath = user?.logo ? path.join(__dirname, '..', user.logo) : null;
    for (const id of postIds) {
      const post = await Post.findById(id);
      if (!post || post.imageStatus !== 'pending') continue;
      try {
        const r = await generatePosterImage(post.toObject(), post.dayNumber || 0, logoPath, user.brandColor, user.company, user.imageMode || 'designed', user.brandProfile);
        await Post.findByIdAndUpdate(id, { imageUrl: r.url, imagePath: r.filepath, imageStatus: 'done', ...(post.posterHeadline ? {} : { posterHeadline: r.posterHeadline, posterKicker: r.posterKicker }) });
      } catch (e) {
        console.error(`Image failed for ${id}:`, e.message);
        await Post.findByIdAndUpdate(id, { imageStatus: 'failed' });
      }
    }
  } catch (e) { console.error('renderImagesInBackground:', e.message); }
}

// Autopilot: keep the next 7 days topped up. Runs hourly; acts at most once per 20h per user.
async function runAutopilot() {
  const users = await User.find({ 'autopilot.enabled': true });
  for (const user of users) {
    try {
      const last = user.autopilot.lastRunAt ? Date.now() - new Date(user.autopilot.lastRunAt).getTime() : Infinity;
      if (last < 20 * 3600 * 1000) continue;
      const tz = user.timezone || 'UTC';
      const today = ymdIn(new Date(), tz);
      const start = zonedDate(today, '00:00', tz), end = zonedDate(addDays(today, 7), '00:00', tz);
      const have = await Post.countDocuments({ user: user._id, scheduledDate: { $gte: start, $lt: end }, status: { $in: ['draft', 'scheduled', 'posted'] } });
      const need = (user.autopilot.postsPerWeek || 5) - have;
      if (need > 0) {
        await generatePlan(user, { startDate: addDays(today, 1), days: 7, count: need });
        console.log(`Autopilot: generated ${need} posts for ${user.email}`);
      }
      await User.findByIdAndUpdate(user._id, { 'autopilot.lastRunAt': new Date(), 'autopilot.lastError': '' });
    } catch (e) {
      console.error(`Autopilot failed for ${user.email}:`, e.message);
      await User.findByIdAndUpdate(user._id, { 'autopilot.lastRunAt': new Date(), 'autopilot.lastError': e.message });
    }
  }
}

module.exports = { generatePlan, runAutopilot, renderImagesInBackground, zonedDate, ymdIn, addDays, pillarSequence, pickDays };

// ponytail: self-check — `node services/planService.js`
if (require.main === module) {
  const assert = require('assert');
  const seq = pillarSequence({}, 10);
  assert.strictEqual(seq.filter(p => p === 'educate').length, 3, 'educate x3 per 10');
  assert.strictEqual(new Set(seq).size, 7, 'all 7 pillars within 10');
  assert.ok(seq.every((p, i) => i === 0 || p !== seq[i - 1]), 'no back-to-back repeats');
  assert.deepStrictEqual(pickDays('2026-11-02', 7, 3, new Set()), ['2026-11-03', '2026-11-05', '2026-11-07']);
  assert.strictEqual(pickDays('2026-11-02', 7, 9).length, 9);
  const d = zonedDate('2026-11-04', '09:00', 'Asia/Kolkata');
  assert.strictEqual(d.toISOString(), '2026-11-04T03:30:00.000Z', 'IST 09:00 = 03:30Z');
  assert.strictEqual(ymdIn(d, 'Asia/Kolkata'), '2026-11-04');
  console.log('planService self-check OK');
}
