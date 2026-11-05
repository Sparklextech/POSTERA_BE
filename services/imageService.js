const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { chat, MOCK } = require('./aiService');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const POSTERS_DIR = path.join(UPLOADS_DIR, 'posters');
fs.mkdirSync(POSTERS_DIR, { recursive: true });

// Poppins for everything PostERA draws itself (strip, overlay, text-only posters)
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
for (const w of ['Medium', 'SemiBold', 'Bold', 'ExtraBold']) {
  const f = path.join(FONT_DIR, `Poppins-${w}.ttf`);
  if (fs.existsSync(f)) GlobalFonts.registerFromPath(f, `Poppins ${w}`);
}
const F = (weight, size) => `${size}px "Poppins ${weight}", "Segoe UI", Arial, sans-serif`;

// Models. "designed" = the model composes the whole poster incl. typography; "photo" = text-free image we caption.
const { get: cfg } = require('./settingsService');

// 4:5 portrait: the largest feed footprint on LinkedIn, Instagram and Facebook.
const W = 1080, H = 1350, STRIP = 132;

// Visual style recipes (after the community "awesome nano-banana" prompt cases), rotated by pillar.
const STYLES = {
  editorial: 'Editorial photograph for a premium magazine feature: a real environment of this industry, natural window or golden-hour light, 35mm lens, shallow depth of field, rich but true-to-life colour.',
  cinematic: 'Cinematic documentary still: anamorphic feel, dramatic directional light with soft haze, deep shadows and one warm highlight, the moment just before something happens.',
  isometric: 'Isometric 3D miniature diorama of a scene from this industry: clean geometry, tiny believable details and characters, soft studio lighting, rendered like a high-end Octane/C4D still on a seamless backdrop.',
  glass: 'Hero object render: the key object of this post sculpted in frosted and clear glass with brand-colour light refracting through it, floating over a gradient backdrop, specular highlights, product-photography rig.',
  burst: 'Dynamic burst: the central object with its components or related items flying outward in a frozen moment, crisp motion, bold backdrop, commercial advertising look.',
  miniature: 'Playful hyper-detailed miniature: a tiny version of the subject placed on an everyday surface or held between fingers, macro lens, soft daylight, charming scale contrast.',
  studio: 'Clean studio shot on a seamless backdrop: one soft key light and a rim light, premium catalogue feel, centred hero object with generous margin.',
  abstract: 'Abstract 3D composition that symbolises the idea: flowing glass ribbons, soft spheres and light trails, octane render, elegant and modern.',
};
const PILLAR_STYLES = {
  educate: ['isometric', 'miniature', 'editorial'], showcase: ['glass', 'isometric', 'studio'], proof: ['editorial', 'cinematic'],
  story: ['editorial', 'cinematic'], trend: ['abstract', 'isometric', 'cinematic'], engage: ['miniature', 'burst', 'isometric'],
  offer: ['studio', 'glass', 'burst'], festival: ['burst', 'studio', 'abstract'],
};
const KICKERS = {
  educate: 'Quick guide', showcase: 'What we do', proof: 'In practice', story: 'Behind the scenes', trend: 'Industry pulse',
  engage: 'Your take', offer: 'Now open', festival: "Season's greetings",
};
const LAYOUTS = [
  'The label and headline are stacked at the top-left with a generous margin; the visual occupies the middle and lower area.',
  'The headline is set very large and centred in the upper half; the main subject rises up just beneath the letters, close enough to feel layered but never covering any letter.',
  'A solid brand-colour panel with softly rounded lower corners covers the top 38% and holds the label and headline in white; the visual fills the rest and slightly overlaps the panel edge.',
  'The visual fills the top two thirds; the label and headline sit left-aligned in the lower third on a calm area of background, just above the plain bottom band.',
];
const THEMES = [
  'Deep midnight-navy background with soft coloured glows; headline in white.',
  'Clean warm-white background with soft natural shadows; headline in deep navy.',
  'Rich gradient from the brand colour into deep navy; headline in white.',
];
const pick = (arr, seed) => arr[Math.abs(seed || 0) % arr.length];
const pickStyle = (pillar, seed = 0) => pick(PILLAR_STYLES[pillar] || ['editorial'], seed);
const domainOf = (url = '') => { try { return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return ''; } };
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');

function posterCopy(postData) {
  const kicker = clip(postData.posterKicker || KICKERS[postData.pillar] || 'Insight', 3).replace(/["“”]/g, '');
  const headline = clip(postData.posterHeadline || postData.imageHeadline || postData.title || '', 9).replace(/["“”]/g, '');
  return { kicker, headline };
}

// ---- Visual description: style recipe × business × post (no text, no layout) ----
async function buildImagePrompt(postData, brand = {}, company = '', opts = {}) {
  const style = STYLES[opts.style] || STYLES[pickStyle(postData.pillar, opts.seed ?? (postData.dayNumber || 0))];
  const colour = opts.brandColor && opts.brandColor !== '#1677ff' ? `Brand colour accent: ${opts.brandColor}.` : '';
  const topic = postData.posterHeadline || postData.imageHeadline || postData.title || 'business';
  const scene = postData.imagePrompt && postData.imagePrompt.length > 20 ? postData.imagePrompt : '';
  const noText = 'No text, letters, numbers, logos or readable screens in the scene. No close-up faces.';
  if (MOCK || !cfg('OPENROUTER_API_KEY')) return `${style} Subject: ${scene || topic}. ${colour} ${noText}`;
  try {
    const prompt = await chat([{
      role: 'user',
      content: `You art-direct images for social media posters. Combine the STYLE recipe with the SUBJECT into ONE vivid visual description of 50–90 words. Name concrete objects, materials, setting, camera and light. A viewer must recognise the industry and the idea instantly. Keep the style's medium (photo vs 3D render). Describe only the visual: no typography, no layout, no words.

BUSINESS: ${company || 'a business'}${brand.businessType ? ` (${brand.businessType})` : ''}${brand.location ? `, ${brand.location}` : ''}
POST IDEA: ${topic}
POST TEXT: ${(postData.content || '').substring(0, 350)}
${scene ? `SUGGESTED SUBJECT: ${scene}` : ''}
STYLE: ${style}
${colour}
${noText} Output only the description.`,
    }], { temperature: 0.9, maxTokens: 220, timeout: 40000 });
    return `${prompt.replace(/^["']|["']$/g, '').trim()} ${noText}`;
  } catch (e) {
    return `${style} Subject: ${scene || topic}. ${colour} ${noText}`;
  }
}

function designedPrompt(visual, postData, brand, company, brandColor, seed) {
  const { kicker, headline } = posterCopy(postData);
  return `Design a premium social media poster in portrait 4:5 format for ${company || 'a business'}${brand.businessType ? `, a ${brand.businessType}` : ''}.
VISUAL: ${visual}
COLOUR: ${pick(THEMES, seed)} Use ${brandColor && brandColor !== '#1677ff' ? brandColor : 'a confident electric blue'} as the signature accent colour.
TYPOGRAPHY — render exactly these words, perfectly spelled, and no other words anywhere in the image:
1) a small uppercase letter-spaced label: "${kicker.toUpperCase()}"
2) a bold modern geometric sans-serif headline: "${headline}"
LAYOUT: ${pick(LAYOUTS, seed)}
The bottom 10% of the canvas must be an empty, plain band in the background colour — nothing in it (a real logo is placed there afterwards).
Award-winning agency quality: generous margins, clear hierarchy, balanced negative space, crisp edges. No logos, no watermarks, no URLs, no phone numbers, no buttons, no fake UI text, no signatures.`;
}

// ---- OpenRouter image call ----
async function generateAIImage(prompt, { model = cfg('AI_IMAGE_MODEL'), aspect = '4:5', retry = false } = {}) {
  if (!cfg('OPENROUTER_API_KEY') || MOCK) return null;
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'], image_config: { aspect_ratio: aspect } },
      {
        headers: { Authorization: `Bearer ${cfg('OPENROUTER_API_KEY')}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://postera.app', 'X-Title': 'Postera' },
        timeout: 180000, maxContentLength: 60 * 1024 * 1024, maxBodyLength: 60 * 1024 * 1024,
      }
    );
    const msg = res.data?.choices?.[0]?.message || {};
    const imgUrl = msg.images?.[0]?.image_url?.url;
    if (imgUrl?.startsWith('data:image')) return Buffer.from(imgUrl.split(',')[1], 'base64');
    if (imgUrl?.startsWith('http')) { const r = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 }); return Buffer.from(r.data); }
    console.log(`Image model ${model} returned no image:`, String(msg.content || '').slice(0, 160));
    return retry ? null : generateAIImage(prompt, { model, aspect, retry: true });
  } catch (e) {
    console.error(`Image gen failed (${model}):`, e.response?.status, e.response?.data?.error?.message || e.message);
    return (!retry && (!e.response?.status || e.response.status >= 500)) ? generateAIImage(prompt, { model, aspect, retry: true }) : null;
  }
}

// ---- Spelling gate: a vision model transcribes the poster, we compare word by word ----
const words = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
async function posterTextOk(buffer, kicker, headline) {
  try {
    const out = await chat([{
      role: 'user',
      content: [
        { type: 'text', text: `You are a strict print proofreader. This poster is supposed to contain exactly two pieces of text:
LABEL: "${kicker.toUpperCase()}"
HEADLINE: "${headline}"
Look at every rendered letter at full zoom. Report a problem if ANY letter is malformed, doubled, merged, overlapping another letter, partly hidden behind an object, or if any word is misspelt, missing, or if any other words appear (ignore words on tiny screens or signs). Do not assume — judge what is actually drawn.
Return ONLY JSON {"transcript": "text exactly as drawn", "ok": true|false, "problems": ["..."]}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` } },
      ],
    }], { model: cfg('AI_VISION_MODEL'), temperature: 0, maxTokens: 400, timeout: 45000 });
    const j = JSON.parse(out.replace(/```(?:json)?/g, '').trim().replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
    const seen = words(j.transcript);
    const want = [...words(kicker), ...words(headline)];
    const missing = want.filter((w) => !seen.includes(w));
    if (process.env.DEBUG_POSTER_TEXT) console.log('poster text', { ok: j.ok, problems: j.problems, missing });
    return j.ok === true && missing.length === 0;
  } catch (e) {
    console.error('Poster text check unavailable:', e.message);
    return true; // never block publishing because the checker is down
  }
}

// ---- drawing helpers ----
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines;
}
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function avgColor(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, w, h).data; let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { if (d[i + 3] < 30) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s);
}
// Logo recoloured to a flat colour (keeps its alpha) — white on dark strips, navy on light ones.
function tinted(img, colour) {
  const c = createCanvas(img.width, img.height); const x = c.getContext('2d');
  x.drawImage(img, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = colour; x.fillRect(0, 0, img.width, img.height);
  return c;
}
async function loadLogo(logoPath) {
  if (!logoPath || !fs.existsSync(logoPath)) return null;
  try { return await loadImage(fs.readFileSync(logoPath)); } catch { return null; }
}

// Bottom brand strip: real logo (auto-contrast) + website, on the poster's own background tone.
async function drawBrandStrip(ctx, { logoPath, website, company, brandColor }) {
  const [r, g, b] = avgColor(ctx, 0, H - STRIP, W, STRIP);
  const dark = lum(r, g, b) < 0.55;
  const base = dark ? [r * 0.85, g * 0.85, b * 0.85] : [Math.min(255, r * 1.03 + 4), Math.min(255, g * 1.03 + 4), Math.min(255, b * 1.03 + 4)];
  const rgb = (a) => `rgba(${base.map(Math.round).join(',')},${a})`;
  const fade = ctx.createLinearGradient(0, H - STRIP - 70, 0, H - STRIP);
  fade.addColorStop(0, rgb(0)); fade.addColorStop(1, rgb(0.96));
  ctx.fillStyle = fade; ctx.fillRect(0, H - STRIP - 70, W, 70);
  ctx.fillStyle = rgb(0.96); ctx.fillRect(0, H - STRIP, W, STRIP);
  const fg = dark ? '#ffffff' : '#0b0d17';
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(11,13,23,0.10)'; ctx.fillRect(64, H - STRIP, W - 128, 1);

  let x = 64;
  const logo = await loadLogo(logoPath);
  if (logo) {
    const [lr, lg, lb] = (() => { const c = createCanvas(64, 64); const cx = c.getContext('2d'); cx.drawImage(logo, 0, 0, 64, 64); return avgColor(cx, 0, 0, 64, 64); })();
    const logoDark = lum(lr, lg, lb) < 0.5;
    const src = dark === logoDark ? tinted(logo, fg) : logo;     // dark-on-dark or light-on-light → recolour
    const h = 76, w = Math.min(h * (logo.width / logo.height), 340);
    const hh = w / (logo.width / logo.height);
    ctx.drawImage(src, x, H - STRIP / 2 - hh / 2, w, hh);
    x += w + 24;
  } else if (company) {
    ctx.fillStyle = fg; ctx.font = F('Bold', 30); ctx.textBaseline = 'middle'; ctx.fillText(company, x, H - STRIP / 2);
  }
  const right = domainOf(website) || (logo ? company : '');
  if (right) {
    ctx.font = F('SemiBold', 24); ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.82)' : 'rgba(11,13,23,0.75)';
    ctx.fillText(right, W - 64, H - STRIP / 2);
    const tw = ctx.measureText(right).width;
    ctx.fillStyle = brandColor || '#37d3ff'; ctx.beginPath(); ctx.arc(W - 64 - tw - 18, H - STRIP / 2, 6, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left';
  }
  // signature line along the bottom edge
  const line = ctx.createLinearGradient(0, 0, W, 0);
  line.addColorStop(0, brandColor || '#7c5cff'); line.addColorStop(1, dark ? '#37d3ff' : (brandColor || '#7c5cff'));
  ctx.fillStyle = line; ctx.fillRect(0, H - 6, W, 6);
}

// Designed poster from the model → add the real brand strip
async function finishDesigned(buffer, brandOpts) {
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  drawCover(ctx, await loadImage(buffer), 0, 0, W, H);
  await drawBrandStrip(ctx, brandOpts);
  return canvas.toBuffer('image/png');
}

// Text-free photo → PostERA typography + brand strip
async function overlayBranding(photo, postData, brandOpts) {
  const { kicker, headline } = posterCopy(postData);
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  drawCover(ctx, await loadImage(photo), 0, 0, W, H);
  const g = ctx.createLinearGradient(0, H * 0.42, 0, H);
  g.addColorStop(0, 'rgba(6,7,13,0)'); g.addColorStop(0.55, 'rgba(6,7,13,0.62)'); g.addColorStop(1, 'rgba(6,7,13,0.92)');
  ctx.fillStyle = g; ctx.fillRect(0, H * 0.42, W, H * 0.58);

  ctx.font = F('ExtraBold', 78); ctx.textBaseline = 'alphabetic';
  const lines = wrapText(ctx, headline, W - 150).slice(0, 3);
  let y = H - STRIP - 60 - (lines.length - 1) * 88;
  // kicker pill
  ctx.font = F('SemiBold', 22); const kt = kicker.toUpperCase().split('').join(String.fromCharCode(8202));
  const kw = ctx.measureText(kt).width + 36;
  ctx.fillStyle = 'rgba(255,255,255,0.14)'; roundRect(ctx, 64, y - 128, kw, 44, 22); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; roundRect(ctx, 64, y - 128, kw, 44, 22); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(kt, 82, y - 106);
  ctx.textBaseline = 'alphabetic'; ctx.font = F('ExtraBold', 78); ctx.fillStyle = '#ffffff';
  for (const l of lines) { ctx.fillText(l, 64, y); y += 88; }
  await drawBrandStrip(ctx, brandOpts);
  return canvas.toBuffer('image/png');
}

// No-AI poster: brand gradient, big type, brand strip
async function generateCanvasPoster(postData, seed, brandOpts) {
  const { kicker, headline } = posterCopy(postData);
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  const accent = brandOpts.brandColor && brandOpts.brandColor !== '#1677ff' ? brandOpts.brandColor : '#7c5cff';
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0b0d17'); bg.addColorStop(1, '#12152a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, c) => { const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); };
  glow(W * 0.85, H * 0.15, 620, `${accent}66`); glow(W * 0.1, H * 0.75, 520, 'rgba(55,211,255,0.25)');
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - STRIP); ctx.stroke(); }
  // measure the text block, then centre it vertically in the space above the strip
  ctx.font = F('ExtraBold', 104); const hl = wrapText(ctx, headline, W - 160).slice(0, 5);
  ctx.font = F('Medium', 32); const cl = postData.cta ? wrapText(ctx, postData.cta, W - 160).slice(0, 2) : [];
  const blockH = 60 + hl.length * 118 + (cl.length ? 30 + cl.length * 46 : 0);
  let y = Math.max(160, (H - STRIP - blockH) / 2 + 30);
  // oversized pillar glyph as a quiet backdrop element
  ctx.font = F('ExtraBold', 560); ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.textBaseline = 'alphabetic';
  ctx.fillText((kicker[0] || 'P').toUpperCase(), W - 470, H - STRIP - 40);
  ctx.font = F('SemiBold', 26); ctx.fillStyle = accent;
  ctx.fillText(kicker.toUpperCase().split('').join(String.fromCharCode(8202)), 80, y); y += 120;
  ctx.font = F('ExtraBold', 104); ctx.fillStyle = '#ffffff';
  for (const l of hl) { ctx.fillText(l, 80, y); y += 118; }
  ctx.fillStyle = accent; roundRect(ctx, 80, y - 70, 90, 8, 4); ctx.fill();
  if (cl.length) { ctx.font = F('Medium', 32); ctx.fillStyle = 'rgba(255,255,255,0.72)'; y += 10; for (const l of cl) { ctx.fillText(l, 80, y); y += 46; } }
  await drawBrandStrip(ctx, brandOpts);
  return canvas.toBuffer('image/png');
}

async function generatePexelsImage(topic) {
  if (!cfg('PEXELS_API_KEY')) return null;
  const { getPhotoForTopic, downloadPexelsImage } = require('./pexelsService');
  const photo = await getPhotoForTopic(topic);
  return photo ? downloadPexelsImage(photo.url) : null;
}

/**
 * Main entry. imageMode:
 *   'designed' (default) model composes the full poster with exact typography; PostERA adds the real logo strip
 *   'premium'            same with the Pro model (slower, richer detail)
 *   'ai'                 text-free photo/render + PostERA typography
 *   'pexels'             stock photo + PostERA typography
 *   'canvas'             no AI image at all
 * Fallback chain always ends in a branded canvas poster, so a post is never left without an image.
 */
async function ensurePosterCopy(postData, brand, company) {
  if (postData.posterHeadline || MOCK || !cfg('OPENROUTER_API_KEY') || !postData.content) return postData;
  try {
    const out = await chat([{ role: 'user', content: `Write poster copy for this social post from ${company || 'a business'}${brand.businessType ? ` (${brand.businessType})` : ''}.
Return ONLY JSON {"posterHeadline": "4–8 words, sharp and quotable, sentence case with natural punctuation, not the first line repeated", "posterKicker": "1–3 word label naming the service or theme"}.
POST:
${postData.content.substring(0, 900)}` }], { temperature: 0.7, maxTokens: 120, timeout: 30000 });
    const j = JSON.parse(out.replace(/\`\`\`(?:json)?/g, '').trim().replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
    return { ...postData, posterHeadline: String(j.posterHeadline || '').trim(), posterKicker: String(j.posterKicker || '').trim() };
  } catch { return postData; }
}

async function generatePosterImage(postData, templateIndex, logoPath, brandColor, company, imageMode = 'designed', brand = {}) {
  postData = await ensurePosterCopy(postData, brand, company);
  const seed = Number.isFinite(templateIndex) ? templateIndex : Math.floor(Math.random() * 12);
  const brandOpts = { logoPath, website: brand.website || '', company, brandColor };
  const mode = imageMode === 'mixed' || imageMode === 'deepai' ? 'designed' : (imageMode || 'designed');
  let buffer = null, source = 'canvas';

  if (!MOCK && cfg('OPENROUTER_API_KEY') && (mode === 'designed' || mode === 'premium')) {
    const visual = await buildImagePrompt(postData, brand, company, { brandColor, seed });
    const { kicker, headline } = posterCopy(postData);
    // attempt 1: the rotated layout; attempt 2: the safest layout (text block above the visual).
    // Every render is read back by a vision model — a misspelt headline never reaches a client.
    for (const s of [seed, 0]) {
      const img = await generateAIImage(designedPrompt(visual, postData, brand, company, brandColor, s), { model: mode === 'premium' ? cfg('AI_PREMIUM_MODEL') : cfg('AI_DESIGN_MODEL') });
      if (!img) continue;
      if (!(await posterTextOk(img, kicker, headline))) { console.log(`Poster text check failed for "${headline}" (layout ${s % LAYOUTS.length})`); continue; }
      buffer = await finishDesigned(img, brandOpts); source = mode; break;
    }
  }
  if (!buffer && mode !== 'canvas' && !MOCK) {
    const photo = mode === 'pexels'
      ? (await generatePexelsImage(postData.imageHeadline || postData.title).catch(() => null)) || await generateAIImage(await buildImagePrompt(postData, brand, company, { brandColor, seed }))
      : await generateAIImage(await buildImagePrompt(postData, brand, company, { brandColor, seed }));
    if (photo) { buffer = await overlayBranding(photo, postData, brandOpts); source = mode === 'pexels' ? 'pexels' : 'ai'; }
  }
  if (!buffer) buffer = await generateCanvasPoster(postData, seed, brandOpts);

  const filename = `poster_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
  const filepath = path.join(POSTERS_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return { filename, filepath, url: `/uploads/posters/${filename}`, source, posterHeadline: postData.posterHeadline || '', posterKicker: postData.posterKicker || '' };
}

module.exports = { generatePosterImage, buildImagePrompt, STYLES, W, H };
