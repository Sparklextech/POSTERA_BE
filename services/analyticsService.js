// Engagement sync + analytics overview.
// Sync pulls public metrics for posts published in the last 30 days, per platform, with whatever each API allows:
//   Facebook  → likes/comments/shares (pages_read_engagement)
//   Instagram → like_count/comments_count (instagram_basic)
//   X         → public_metrics (tweet.read)
//   LinkedIn  → socialActions likes/comments (works for the member's own posts on most apps; fails silently otherwise)
const axios = require('axios');
const Post = require('../models/Post');
const User = require('../models/User');
const { ensureTwitterToken } = require('./socialService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function syncPostMetrics(post, user) {
  const m = post.metrics || {};
  const pt = post.postedTo || {};
  if (pt.facebook?.postId && user.facebook?.accessToken) {
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${pt.facebook.postId}`, { params: { fields: 'likes.summary(true),comments.summary(true),shares', access_token: user.facebook.accessToken }, timeout: 15000 });
      m.facebook = { likes: num(r.data.likes?.summary?.total_count), comments: num(r.data.comments?.summary?.total_count), shares: num(r.data.shares?.count), impressions: m.facebook?.impressions || 0 };
    } catch (e) { /* keep old */ }
  }
  if (pt.instagram?.postId && user.instagram?.accessToken) {
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${pt.instagram.postId}`, { params: { fields: 'like_count,comments_count', access_token: user.instagram.accessToken }, timeout: 15000 });
      m.instagram = { likes: num(r.data.like_count), comments: num(r.data.comments_count), shares: 0, impressions: m.instagram?.impressions || 0 };
    } catch (e) { /* keep old */ }
  }
  if (pt.twitter?.postId && user.twitter?.accessToken) {
    try {
      const token = await ensureTwitterToken(user);
      const r = await axios.get(`https://api.twitter.com/2/tweets/${pt.twitter.postId}`, { params: { 'tweet.fields': 'public_metrics' }, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      const pm = r.data.data?.public_metrics || {};
      m.twitter = { likes: num(pm.like_count), comments: num(pm.reply_count), shares: num(pm.retweet_count) + num(pm.quote_count), impressions: num(pm.impression_count) };
    } catch (e) { /* keep old */ }
  }
  if (pt.linkedin?.postId && user.linkedin?.accessToken) {
    try {
      const urn = encodeURIComponent(pt.linkedin.postId);
      const r = await axios.get(`https://api.linkedin.com/v2/socialActions/${urn}`, { headers: { Authorization: `Bearer ${user.linkedin.accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' }, timeout: 15000 });
      m.linkedin = { likes: num(r.data.likesSummary?.totalLikes), comments: num(r.data.commentsSummary?.totalFirstLevelComments || r.data.commentsSummary?.aggregatedTotalComments), shares: m.linkedin?.shares || 0, impressions: m.linkedin?.impressions || 0 };
    } catch (e) { /* LinkedIn restricts this for most apps — leave empty */ }
  }
  const total = Object.values(m).reduce((a, x) => ({ likes: a.likes + num(x?.likes), comments: a.comments + num(x?.comments), shares: a.shares + num(x?.shares) }), { likes: 0, comments: 0, shares: 0 });
  await Post.findByIdAndUpdate(post._id, { metrics: m, engagement: total, metricsSyncedAt: new Date() });
  return m;
}

async function syncUser(userId, days = 30) {
  const user = await User.findById(userId);
  if (!user) return 0;
  const since = new Date(Date.now() - days * 86400000);
  const posts = await Post.find({ user: userId, status: 'posted', postedAt: { $gte: since } });
  for (const p of posts) await syncPostMetrics(p, user);
  return posts.length;
}

async function syncAll() {
  const ids = await Post.distinct('user', { status: 'posted', postedAt: { $gte: new Date(Date.now() - 30 * 86400000) } });
  for (const id of ids) { try { await syncUser(id); } catch (e) { console.error('metrics sync failed', id, e.message); } }
}

// ---- Overview numbers for the Analytics page ----
async function overview(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const prevSince = new Date(since.getTime() - days * 86400000);
  const all = await Post.find({ user: userId, scheduledDate: { $gte: prevSince } }).select('status pillar platforms postedTo postedAt scheduledDate metrics engagement title imageUrl postType createdAt approvedAt error').lean();
  const cur = all.filter(p => new Date(p.scheduledDate) >= since);
  const prev = all.filter(p => new Date(p.scheduledDate) < since);

  const count = (arr, f) => arr.filter(f).length;
  const sum = (arr, f) => arr.reduce((a, p) => a + (f(p) || 0), 0);
  const eng = (p) => (p.engagement?.likes || 0) + (p.engagement?.comments || 0) + (p.engagement?.shares || 0);

  const kpi = (name, c, pv, fmt) => ({ name, value: c, prev: pv, delta: pv ? Math.round(((c - pv) / pv) * 100) : null, fmt });
  const posted = cur.filter(p => p.status === 'posted');
  const prevPosted = prev.filter(p => p.status === 'posted');
  const kpis = [
    kpi('Published', posted.length, prevPosted.length),
    kpi('Scheduled', count(cur, p => p.status === 'scheduled'), count(prev, p => p.status === 'scheduled')),
    kpi('Awaiting approval', count(cur, p => p.status === 'draft'), count(prev, p => p.status === 'draft')),
    kpi('Engagement', sum(posted, eng), sum(prevPosted, eng)),
    kpi('Publish success', posted.length + count(cur, p => p.status === 'failed') ? Math.round(posted.length / (posted.length + count(cur, p => p.status === 'failed')) * 100) : null, null, '%'),
    kpi('Avg engagement / post', posted.length ? Math.round(sum(posted, eng) / posted.length * 10) / 10 : 0, prevPosted.length ? Math.round(sum(prevPosted, eng) / prevPosted.length * 10) / 10 : 0),
  ];

  // time series by day (posted, engagement)
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); byDay[d] = { date: d, published: 0, scheduled: 0, engagement: 0 }; }
  for (const p of cur) {
    const d = new Date(p.status === 'posted' && p.postedAt ? p.postedAt : p.scheduledDate).toISOString().slice(0, 10);
    if (!byDay[d]) continue;
    if (p.status === 'posted') { byDay[d].published++; byDay[d].engagement += eng(p); } else if (p.status === 'scheduled' || p.status === 'draft') byDay[d].scheduled++;
  }

  // by platform
  const platforms = ['linkedin', 'facebook', 'instagram', 'twitter'].map(k => {
    const ps = posted.filter(p => p.postedTo?.[k]?.postId);
    const m = (f) => ps.reduce((a, p) => a + (p.metrics?.[k]?.[f] || 0), 0);
    return { platform: k, published: ps.length, likes: m('likes'), comments: m('comments'), shares: m('shares'), impressions: m('impressions'), planned: count(cur, p => (p.platforms || []).includes(k) && p.status !== 'posted') };
  });

  // by pillar
  const pillarKeys = ['educate', 'showcase', 'proof', 'story', 'trend', 'engage', 'offer', 'festival'];
  const pillars = pillarKeys.map(k => {
    const ps = cur.filter(p => p.pillar === k);
    const pp = ps.filter(p => p.status === 'posted');
    return { pillar: k, posts: ps.length, published: pp.length, engagement: sum(pp, eng), avg: pp.length ? Math.round(sum(pp, eng) / pp.length * 10) / 10 : 0 };
  }).filter(x => x.posts > 0);

  // best hours / weekdays (by engagement per published post)
  const slots = {};
  for (const p of posted) {
    const d = new Date(p.postedAt || p.scheduledDate);
    const k = `${d.getUTCDay()}-${d.getUTCHours()}`;
    slots[k] = slots[k] || { day: d.getUTCDay(), hour: d.getUTCHours(), posts: 0, engagement: 0 };
    slots[k].posts++; slots[k].engagement += eng(p);
  }
  const heat = Object.values(slots);

  const top = posted.map(p => ({ _id: p._id, title: p.title, pillar: p.pillar, imageUrl: p.imageUrl, postedAt: p.postedAt, engagement: eng(p), platforms: Object.keys(p.postedTo || {}).filter(k => p.postedTo[k]?.postId), metrics: p.metrics || {} }))
    .sort((a, b) => b.engagement - a.engagement).slice(0, 8);
  const failures = cur.filter(p => p.status === 'failed').map(p => ({ _id: p._id, title: p.title, error: p.error, scheduledDate: p.scheduledDate }));

  const approvalLag = cur.filter(p => p.approvedAt && p.createdAt).map(p => (new Date(p.approvedAt) - new Date(p.createdAt)) / 3600000);
  const funnel = {
    generated: cur.length,
    approved: count(cur, p => ['scheduled', 'posted', 'failed'].includes(p.status)),
    published: posted.length,
    skipped: count(cur, p => p.status === 'skipped'),
    medianApprovalHours: approvalLag.length ? Math.round(approvalLag.sort((a, b) => a - b)[Math.floor(approvalLag.length / 2)] * 10) / 10 : null,
  };

  const lastSync = await Post.findOne({ user: userId, metricsSyncedAt: { $exists: true } }).sort({ metricsSyncedAt: -1 }).select('metricsSyncedAt');
  return { days, kpis, series: Object.values(byDay), platforms, pillars, heat, top, failures, funnel, lastSync: lastSync?.metricsSyncedAt || null };
}

module.exports = { syncUser, syncAll, overview };
