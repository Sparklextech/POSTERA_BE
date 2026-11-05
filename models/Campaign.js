const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  globalPrompt: { type: String, required: true },
  tone: { type: String, default: 'professional', enum: ['professional', 'casual', 'inspiring', 'educational', 'humorous'] },
  postFrequency: { type: String, default: 'daily', enum: ['daily', 'weekdays', 'weekly', 'custom'] },
  postTime: { type: String, default: '09:00' },
  timezone: { type: String, default: 'UTC' },
  totalPosts: { type: Number, default: 30 },
  platforms: { type: [String], default: ['linkedin'] },
  requireApproval: { type: Boolean, default: false },
  status: { type: String, default: 'draft', enum: ['draft', 'active', 'paused', 'completed'] },
  includeHashtags: { type: Boolean, default: true },
  includeEmoji: { type: Boolean, default: true },
  generateImages: { type: Boolean, default: true },
  websiteUrl: { type: String, default: '' },
  generationStatus: { type: String, default: 'pending', enum: ['pending', 'generating_content', 'generating_images', 'completed', 'failed'] },
  generationProgress: { type: Number, default: 0 },
  generationError: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Campaign', campaignSchema);
