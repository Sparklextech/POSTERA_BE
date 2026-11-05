const mongoose = require('mongoose');

// A piece of business knowledge the AI plans from: website, PDF, deck, doc or pasted text.
const sourceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true, enum: ['website', 'pdf', 'pptx', 'docx', 'text'] },
  name: { type: String, required: true },
  url: { type: String, default: '' },
  text: { type: String, default: '' },        // extracted raw text (capped)
  summary: { type: String, default: '' },     // AI summary used in prompts
  topics: { type: [String], default: [] },    // AI-suggested post ideas
  status: { type: String, default: 'ready', enum: ['processing', 'ready', 'failed'] },
  error: { type: String, default: '' },
  chars: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Source', sourceSchema);
