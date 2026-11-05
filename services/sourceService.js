const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Source = require('../models/Source');
const { scrapeWebsite } = require('./scraperService');
const { summarizeSource } = require('./aiService');

const MAX_CHARS = 60000;

function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decode(m[1]));
  return out;
}
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/<[^>]+>/g, '');

async function extractText(filePath, ext) {
  const buf = fs.readFileSync(filePath);
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buf);
    return data.text || '';
  }
  if (ext === 'pptx') {
    const zip = new AdmZip(buf);
    const slides = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => parseInt(a.entryName.match(/\d+/)[0]) - parseInt(b.entryName.match(/\d+/)[0]));
    return slides.map((s, i) => {
      const xml = s.getData().toString('utf8');
      // group runs per paragraph so bullet points stay on one line
      const paras = xmlText(xml, 'a:p').map(p => p.trim()).filter(Boolean);
      return `--- Slide ${i + 1} ---\n${paras.join('\n')}`;
    }).join('\n\n');
  }
  if (ext === 'docx') {
    const zip = new AdmZip(buf);
    const doc = zip.getEntry('word/document.xml');
    if (!doc) return '';
    const xml = doc.getData().toString('utf8');
    return xmlText(xml, 'w:p').map(p => p.trim()).filter(Boolean).join('\n');
  }
  return buf.toString('utf8'); // txt / md
}

function extOf(filename, mimetype = '') {
  const e = path.extname(filename || '').toLowerCase().replace('.', '');
  if (['pdf', 'pptx', 'docx', 'txt', 'md'].includes(e)) return e === 'md' ? 'txt' : e;
  if (mimetype.includes('pdf')) return 'pdf';
  if (mimetype.includes('presentation')) return 'pptx';
  if (mimetype.includes('wordprocessingml')) return 'docx';
  if (mimetype.startsWith('text/')) return 'txt';
  return null;
}

// Creates the Source, then enriches it with an AI summary (sync — a few seconds).
async function ingestFile(user, file) {
  const ext = extOf(file.originalname, file.mimetype);
  if (!ext) throw new Error('Unsupported file type. Upload PDF, PPTX, DOCX, TXT or MD.');
  let text = '';
  try { text = (await extractText(file.path, ext)).replace(/\s+\n/g, '\n').trim(); }
  finally { fs.unlink(file.path, () => {}); }
  if (!text || text.length < 40) throw new Error('Could not extract readable text from this file (scanned PDFs are not supported yet).');
  return finishSource(user, { type: ext === 'txt' ? 'text' : ext, name: file.originalname, text });
}

async function ingestText(user, name, text) {
  if (!text || text.trim().length < 40) throw new Error('Please paste at least a few sentences.');
  return finishSource(user, { type: 'text', name: name || 'Pasted notes', text: text.trim() });
}

async function ingestWebsite(user, url) {
  const result = await scrapeWebsite(url);
  if (!result.success) throw new Error(`Could not read ${url}: ${result.error}`);
  const out = await finishSource(user, { type: 'website', name: result.title || url, url: result.url, text: result.content });
  if (result.logoUrl && !user.logo) {
    try {
      const axios = require('axios');
      const r = await axios.get(result.logoUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = String(r.headers['content-type'] || '');
      if (/image\/(png|jpeg|jpg|webp|svg)/.test(ct) && r.data.length > 500) {
        const ext = ct.includes('svg') ? 'svg' : ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const file = `logo_${user._id}_${Date.now()}.${ext}`;
        const dest = path.join(__dirname, '..', 'uploads', file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(r.data));
        const User = require('../models/User');
        await User.findByIdAndUpdate(user._id, { logo: `/uploads/${file}`, 'brandProfile.website': result.url });
        out.logo = `/uploads/${file}`;
      }
    } catch (e) { /* logo is a nice-to-have */ }
  }
  return out;
}

async function finishSource(user, data) {
  const text = data.text.substring(0, MAX_CHARS);
  const src = await Source.create({ user: user._id, ...data, text, chars: text.length, status: 'processing' });
  try {
    const ai = await summarizeSource(data.name, text, user.brandProfile, user.company);
    src.summary = ai.summary || text.substring(0, 1500);
    src.topics = Array.isArray(ai.topics) ? ai.topics.slice(0, 15) : [];
    src.status = 'ready';
    await src.save();
    return { source: src, suggestions: { businessType: ai.businessType || '', services: ai.services || [], audience: ai.audience || '', usp: ai.usp || '' } };
  } catch (e) {
    src.summary = text.substring(0, 1500);
    src.status = 'ready';
    src.error = `AI summary skipped: ${e.message}`;
    await src.save();
    return { source: src, suggestions: {}, warning: src.error };
  }
}

// Combined knowledge text for prompts (most recent first, capped)
async function knowledgeFor(userId, cap = 7000) {
  const sources = await Source.find({ user: userId, status: 'ready' }).sort({ updatedAt: -1 }).limit(8).select('name type summary topics');
  let out = '';
  for (const s of sources) {
    const block = `[${s.type.toUpperCase()}: ${s.name}]\n${s.summary}\n${s.topics?.length ? 'Ideas: ' + s.topics.join(' | ') : ''}\n\n`;
    if (out.length + block.length > cap) break;
    out += block;
  }
  return out.trim();
}

module.exports = { ingestFile, ingestText, ingestWebsite, knowledgeFor, extractText };
