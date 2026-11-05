const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const Post = require('../models/Post');
const linkedinService = require('./linkedinService');
const { runAutopilot } = require('./planService');
const { ensureTwitterToken } = require('./socialService');
const { syncAll } = require('./analyticsService');

let jobs = [];
let publishing = false;

// Temporary errors (network, rate limit, platform outage) are retried; everything else fails straight away.
const RETRY_MINUTES = [2, 10, 30];
const LOCK_MS = 15 * 60 * 1000;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ERR_NETWORK', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
const isTransient = (e) => e.transient === true || TRANSIENT_CODES.has(e.code)
  || (!!e.response && (e.response.status === 429 || e.response.status >= 500))
  || (e.isAxiosError === true && !e.response && !!e.request);
const httpGraph = axios.create({ timeout: 60000 });

function startScheduler() {
  jobs.push(cron.schedule('* * * * *', async () => {
    if (publishing) return; // don't overlap slow runs
    publishing = true;
    try {
      const now = new Date();
      const due = await Post.find({
        status: 'scheduled', scheduledDate: { $lte: now },
        $and: [
          { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
          { $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }, { lockedAt: { $lt: new Date(now - LOCK_MS) } }] },
        ],
      }).populate('user campaign').limit(25);
      for (const post of due) await publishPost(post);
    } catch (error) {
      console.error('Scheduler error:', error.message);
    } finally { publishing = false; }
  }));
  jobs.push(cron.schedule('17 * * * *', () => runAutopilot().catch(e => console.error('Autopilot error:', e.message))));
  jobs.push(cron.schedule('40 3 * * *', () => syncAll().catch(e => console.error('Metrics sync error:', e.message))));
  console.log('Scheduler started: publisher every minute (with retries), autopilot hourly, metrics sync nightly');
}

function publicUrl(rel) {
  if (!rel) return '';
  if (rel.startsWith('http')) return rel;
  const base = process.env.BACKEND_URL || process.env.PUBLIC_URL || '';
  return base ? `${base.replace(/\/$/, '')}${rel}` : '';
}

// Instagram has to process a video before it can be published: poll briefly, then resume on the next attempt
async function igContainerReady(id, token) {
  for (let i = 0; i < 8; i++) {
    const r = await httpGraph.get(`https://graph.facebook.com/v21.0/${id}`, { params: { fields: 'status_code,status', access_token: token } });
    if (r.data.status_code === 'FINISHED') return true;
    if (r.data.status_code === 'ERROR' || r.data.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video (${r.data.status || r.data.status_code})`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

// Atomically take the post so the minute timer, "Publish now" and double-clicks never publish it twice.
async function claim(post, force) {
  const now = new Date();
  const r = await Post.updateOne({
    _id: post._id,
    ...(force ? { status: { $ne: 'posted' } } : { status: 'scheduled' }),
    $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }, { lockedAt: { $lt: new Date(now - LOCK_MS) } }],
  }, { $set: { lockedAt: now } });
  return r.modifiedCount === 1;
}

async function publishPost(post, { force = false } = {}) {
  if (!(await claim(post, force))) return false;
  try {
    await doPublish(post);
    return true;
  } finally {
    await Post.updateOne({ _id: post._id }, { $set: { lockedAt: null } });
  }
}

async function doPublish(post) {
  const user = post.user;
  if (!user) { post.status = 'failed'; post.error = 'Owner not found'; return post.save(); }
  // Posts inside a campaign only go out while the campaign is active
  if (post.campaign && post.campaign.status !== 'active') return;

  post.postedTo = post.postedTo || {};
  const wanted = post.platforms?.length ? post.platforms : ['linkedin'];
  const skip = new Set(post.skipPlatforms || []);
  const connected = user.connectedPlatforms ? user.connectedPlatforms() : [];
  // In extension mode the browser extension is the only publisher for LinkedIn (never both)
  const linkedinViaExtension = wanted.includes('linkedin') && user.linkedin?.mode === 'extension' && !skip.has('linkedin');
  const done = (p) => !!post.postedTo[p]?.postId;
  const todo = wanted.filter((p) => !done(p) && !skip.has(p) && !(p === 'linkedin' && linkedinViaExtension));
  const notConnected = todo.filter((p) => !connected.includes(p));
  const targets = todo.filter((p) => connected.includes(p));
  const extensionPending = linkedinViaExtension && !done('linkedin');

  const errors = notConnected.map((p) => ({ platform: p, detail: 'account not connected (connect it in Settings and re-approve)', transient: false }));
  const hasImage = post.imagePath && fs.existsSync(post.imagePath);
  const asVideo = post.mediaType === 'video' && post.videoPath && fs.existsSync(post.videoPath);

  for (const platform of targets) {
    const text = post.textFor(platform);
    try {
      if (platform === 'linkedin') {
        const { accessToken: tok, linkedinId: who } = user.linkedin;
        let result;
        if (asVideo) result = await linkedinService.createVideoPost(tok, who, text, await linkedinService.uploadVideo(tok, who, fs.readFileSync(post.videoPath)), post.title);
        else if (hasImage) result = await linkedinService.createImagePost(tok, who, text, await linkedinService.uploadImage(tok, who, fs.readFileSync(post.imagePath)));
        else result = await linkedinService.createTextPost(tok, who, text);
        post.postedTo.linkedin = { postId: result.id || 'posted', postedAt: new Date() };
      } else if (platform === 'facebook') {
        const body = { access_token: user.facebook.accessToken };
        let res;
        if (asVideo) res = await httpGraph.post(`https://graph.facebook.com/v21.0/${user.facebook.pageId}/videos`, { ...body, file_url: publicUrl(post.videoUrl), description: text, title: post.title }, { timeout: 300000 });
        else if (publicUrl(post.imageUrl)) res = await httpGraph.post(`https://graph.facebook.com/v21.0/${user.facebook.pageId}/photos`, { ...body, message: text, url: publicUrl(post.imageUrl) });
        else res = await httpGraph.post(`https://graph.facebook.com/v21.0/${user.facebook.pageId}/feed`, { ...body, message: text });
        post.postedTo.facebook = { postId: res.data.post_id || res.data.id || 'posted', postedAt: new Date() };
      } else if (platform === 'instagram') {
        const ig = user.instagram;
        let containerId = asVideo ? post.igContainerId : '';
        if (!containerId) {
          const media = asVideo ? { media_type: 'REELS', video_url: publicUrl(post.videoUrl), share_to_feed: true } : { image_url: publicUrl(post.imageUrl) };
          if (!media.video_url && !media.image_url) throw new Error('Instagram needs a poster or a video that is publicly reachable (BACKEND_URL)');
          containerId = (await httpGraph.post(`https://graph.facebook.com/v21.0/${ig.userId}/media`, { ...media, caption: text, access_token: ig.accessToken })).data.id;
          if (asVideo) post.igContainerId = containerId;
        }
        if (asVideo && !(await igContainerReady(containerId, ig.accessToken))) {
          const e = new Error('Instagram is still processing the video'); e.transient = true; throw e;
        }
        const pub = await httpGraph.post(`https://graph.facebook.com/v21.0/${ig.userId}/media_publish`, { creation_id: containerId, access_token: ig.accessToken });
        post.postedTo.instagram = { postId: pub.data.id || 'posted', postedAt: new Date() };
        post.igContainerId = '';
      } else if (platform === 'twitter') {
        // X media upload needs the v1.1 chunked API with OAuth 1.0a user context; the text goes out on its own
        const token = await ensureTwitterToken(user);
        const res = await axios.post('https://api.twitter.com/2/tweets', { text: text.substring(0, 280) }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000 });
        post.postedTo.twitter = { postId: res.data?.data?.id || 'posted', postedAt: new Date() };
      }
      console.log(`Posted ${post._id} to ${platform}${asVideo ? ' (video)' : ''}`);
    } catch (e) {
      const detail = e.response?.data?.error?.message || e.response?.data?.message || e.response?.data?.error_description || e.message;
      errors.push({ platform, detail, transient: isTransient(e) });
      console.error(`${platform} post failed for ${post._id}:`, detail);
    }
  }

  post.markModified('postedTo');
  post.linkedinPostId = post.postedTo?.linkedin?.postId || '';
  const anyPosted = wanted.some(done);
  if (anyPosted && !post.postedAt) post.postedAt = new Date();

  // permanent failures are remembered so they are never retried (and don't block the other platforms)
  for (const x of errors.filter((x) => !x.transient)) if (!post.skipPlatforms.includes(x.platform)) post.skipPlatforms.push(x.platform);
  const summary = errors.map((x) => `${x.platform}: ${x.detail}`).join(' | ');
  const transient = errors.filter((x) => x.transient);

  if (transient.length) {
    const attempt = (post.attempts || 0) + 1;
    if (attempt <= RETRY_MINUTES.length) {
      post.attempts = attempt;
      post.nextAttemptAt = new Date(Date.now() + RETRY_MINUTES[attempt - 1] * 60000);
      post.error = `Temporary problem, retry ${attempt} of ${RETRY_MINUTES.length} at ${post.nextAttemptAt.toISOString().slice(11, 16)} UTC — ${summary}`;
      return post.save();
    }
    for (const x of transient) if (!post.skipPlatforms.includes(x.platform)) post.skipPlatforms.push(x.platform);
  }

  post.nextAttemptAt = null;
  if (extensionPending) {
    // LinkedIn still goes out via the browser extension; keep it scheduled for /api/bridge/due
    post.error = errors.length ? `Waiting for the browser extension (LinkedIn) — ${summary}` : 'Waiting for the browser extension (LinkedIn)';
    return post.save();
  }
  post.status = anyPosted ? 'posted' : 'failed';
  post.error = errors.length ? (anyPosted ? `Published, but ${summary}` : summary) : '';
  return post.save();
}

function stopScheduler() { jobs.forEach(j => j.stop()); jobs = []; }

module.exports = { startScheduler, stopScheduler, publishPost, isTransient };
