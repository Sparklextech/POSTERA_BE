const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const PLATFORMS = ['linkedin', 'facebook', 'instagram', 'twitter'];

// Content pillar weights per ~10 posts. Rotated by planService to keep a balanced mix.
const defaultPillars = () => ({ educate: 3, showcase: 2, proof: 1, story: 1, trend: 1, engage: 1, offer: 1 });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  company: { type: String, default: '' },
  logo: { type: String, default: '' },
  brandColor: { type: String, default: '#1677ff' },
  imageMode: { type: String, default: 'designed', enum: ['designed', 'premium', 'ai', 'pexels', 'canvas', 'deepai', 'mixed'] },
  role: { type: String, default: 'user', enum: ['user', 'admin', 'superadmin'] },
  timezone: { type: String, default: 'UTC' },

  // Who the business is — drives every prompt
  brandProfile: {
    businessType: { type: String, default: '' },      // e.g. "Real estate agency", "SaaS", "Dental clinic"
    description: { type: String, default: '' },
    audience: { type: String, default: '' },
    services: { type: [String], default: [] },
    usp: { type: String, default: '' },
    location: { type: String, default: '' },
    tone: { type: String, default: 'professional' },
    language: { type: String, default: 'English' },
    website: { type: String, default: '' },
    hashtags: { type: [String], default: [] },
    pillars: { type: mongoose.Schema.Types.Mixed, default: defaultPillars },
    voice: { type: String, default: 'en-US-AriaNeural' },   // TTS voice for video narration
  },

  // Autopilot ("YOLO"): keeps the next 7 days topped up with posts automatically
  autopilot: {
    enabled: { type: Boolean, default: false },
    postsPerWeek: { type: Number, default: 5 },
    postTime: { type: String, default: '09:00' },
    platforms: { type: [String], default: ['linkedin'] },
    requireApproval: { type: Boolean, default: true },
    generateImages: { type: Boolean, default: true },
    lastRunAt: { type: Date },
    lastError: { type: String, default: '' },
  },

  instagram: {
    accessToken: { type: String, default: '' },
    userId: { type: String, default: '' },
    username: { type: String, default: '' },
  },
  facebook: {
    accessToken: { type: String, default: '' },
    pageId: { type: String, default: '' },
    pageName: { type: String, default: '' },
    pages: { type: [{ id: String, name: String, access_token: String }], default: [] },
    expiresAt: { type: Date },
  },
  twitter: {
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    accessSecret: { type: String, default: '' },
    userId: { type: String, default: '' },
    username: { type: String, default: '' },
    expiresAt: { type: Date },
  },
  platforms: { type: [String], default: ['linkedin'], enum: PLATFORMS },
  linkedin: {
    accessToken: { type: String, default: '' },
    linkedinId: { type: String, default: '' },
    name: { type: String, default: '' },
    profileUrl: { type: String, default: '' },
    expiresAt: { type: Date },
    mode: { type: String, default: 'api', enum: ['api', 'extension'] },   // extension = Postera Chrome extension posts from the user's own browser session
    extensionSeenAt: { type: Date },
  },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Which platforms currently have a usable token
userSchema.methods.connectedPlatforms = function () {
  const now = Date.now();
  const ok = [];
  if (this.linkedin?.accessToken && (!this.linkedin.expiresAt || new Date(this.linkedin.expiresAt) > now)) ok.push('linkedin');
  else if (this.linkedin?.mode === 'extension' && this.linkedin.extensionSeenAt && now - new Date(this.linkedin.extensionSeenAt).getTime() < 15 * 60 * 1000) ok.push('linkedin');
  if (this.facebook?.accessToken && this.facebook.pageId) ok.push('facebook');
  if (this.instagram?.accessToken && this.instagram.userId) ok.push('instagram');
  if (this.twitter?.accessToken) ok.push('twitter');
  return ok;
};

// Safe shape for the frontend (never leaks tokens)
userSchema.methods.toPublic = function () {
  const now = Date.now();
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    company: this.company,
    logo: this.logo,
    brandColor: this.brandColor,
    imageMode: this.imageMode || 'designed',
    role: this.role || 'user',
    timezone: this.timezone || 'UTC',
    platforms: this.platforms,
    brandProfile: this.brandProfile || {},
    autopilot: this.autopilot || {},
    connections: {
      linkedin: { connected: !!this.linkedin?.accessToken || (this.linkedin?.mode === 'extension' && !!this.linkedin?.extensionSeenAt), name: this.linkedin?.name || '', expired: !!(this.linkedin?.expiresAt && new Date(this.linkedin.expiresAt) < now), expiresAt: this.linkedin?.expiresAt || null, mode: this.linkedin?.mode || 'api', extensionOnline: !!(this.linkedin?.extensionSeenAt && now - new Date(this.linkedin.extensionSeenAt).getTime() < 15 * 60 * 1000), extensionSeenAt: this.linkedin?.extensionSeenAt || null },
      facebook: { connected: !!(this.facebook?.accessToken && this.facebook?.pageId), name: this.facebook?.pageName || '', pages: (this.facebook?.pages || []).map(p => ({ id: p.id, name: p.name })) },
      instagram: { connected: !!(this.instagram?.accessToken && this.instagram?.userId), name: this.instagram?.username || '' },
      twitter: { connected: !!this.twitter?.accessToken, name: this.twitter?.username || '' },
    },
    // kept for older frontend code paths
    linkedinConnected: !!this.linkedin?.accessToken,
    linkedinName: this.linkedin?.name || '',
    instagramConnected: !!this.instagram?.accessToken,
    facebookConnected: !!this.facebook?.accessToken,
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.PLATFORMS = PLATFORMS;
module.exports.defaultPillars = defaultPillars;
