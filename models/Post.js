const mongoose = require('mongoose');

const PILLARS = ['educate', 'showcase', 'proof', 'story', 'trend', 'engage', 'offer', 'festival'];

const postSchema = new mongoose.Schema({
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
  postType: { type: String, default: 'campaign', enum: ['campaign', 'festival', 'plan'] },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dayNumber: { type: Number, default: 0 },
  pillar: { type: String, default: 'educate', enum: PILLARS },
  title: { type: String, required: true },
  content: { type: String, required: true },           // primary (LinkedIn / long-form) text
  variants: {                                          // platform-native rewrites; falls back to content
    linkedin: { type: String, default: '' },
    facebook: { type: String, default: '' },
    instagram: { type: String, default: '' },
    twitter: { type: String, default: '' },
  },
  hashtags: [{ type: String }],
  cta: { type: String, default: '' },
  imagePrompt: { type: String, default: '' },
  imageHeadline: { type: String, default: '' },
  posterHeadline: { type: String, default: '' },   // big line on the poster
  posterKicker: { type: String, default: '' },     // small label above it
  imageUrl: { type: String, default: '' },
  imagePath: { type: String, default: '' },
  imageStatus: { type: String, default: 'none', enum: ['none', 'pending', 'done', 'failed'] },
  videoUrl: { type: String, default: '' },
  videoPath: { type: String, default: '' },
  videoStatus: { type: String, default: 'none', enum: ['none', 'pending', 'done', 'failed'] },
  videoScript: { type: String, default: '' },
  videoPlan: { type: mongoose.Schema.Types.Mixed, default: null },   // { beats, cta, mood, hero, cost }
  scheduledDate: { type: Date, required: true },
  // draft = waiting for approval; scheduled = approved, will auto-publish
  status: { type: String, default: 'scheduled', enum: ['draft', 'scheduled', 'posted', 'failed', 'skipped'] },
  approvedAt: { type: Date },
  platforms: { type: [String], default: ['linkedin'] },
  postedTo: {
    linkedin: { postId: String, postedAt: Date },
    instagram: { postId: String, postedAt: Date },
    facebook: { postId: String, postedAt: Date },
    twitter: { postId: String, postedAt: Date },
  },
  error: { type: String, default: '' },                // last publish error, surfaced in UI
  attempts: { type: Number, default: 0 },              // publish attempts that hit a temporary error
  nextAttemptAt: { type: Date, default: null },        // retry time after a temporary error
  mediaType: { type: String, enum: ['image', 'video'], default: 'image' },   // what to attach when publishing
  skipPlatforms: { type: [String], default: [] },      // platforms that failed permanently on this post; not retried
  igContainerId: { type: String, default: '' },        // Instagram video container still processing
  lockedAt: { type: Date, default: null },             // publish in progress (claim lock against double posting)
  linkedinPostId: { type: String, default: '' },
  postedAt: { type: Date },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },   // per-platform { likes, comments, shares, impressions }
  metricsSyncedAt: { type: Date },
  engagement: {
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
  },
}, { timestamps: true });

postSchema.index({ scheduledDate: 1, status: 1 });
postSchema.index({ user: 1, scheduledDate: 1 });
postSchema.index({ campaign: 1, dayNumber: 1 });

// Text to publish on a given platform
postSchema.methods.textFor = function (platform) {
  const v = this.variants?.[platform];
  if (v && v.trim()) return v.trim();
  const tags = (this.hashtags || []).length ? '\n\n' + this.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ') : '';
  const text = this.content + tags;
  return platform === 'twitter' ? text.substring(0, 280) : text;
};

module.exports = mongoose.model('Post', postSchema);
module.exports.PILLARS = PILLARS;
