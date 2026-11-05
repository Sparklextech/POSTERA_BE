// Short-form video for a post: 9:16, 1080x1920, 30 fps.
//   1. Script  — Sonnet writes a 60–80 word voice-over + 3 beat cards + CTA from the post (≈ $0.01)
//   2. Voice   — Edge neural TTS with word timings (free)
//   3. Hero    — the poster animated by an image-to-video model on fal.ai (Wan 2.2 5B, $0.15 flat) when FAL_KEY is
//                set; otherwise a local parallax/zoom of the poster (free)
//   4. Music   — a 30 s instrumental bed from Lyria via OpenRouter, generated once per mood and cached ($0.04 once)
//   5. Render  — every frame drawn on canvas (hero + word-synced captions → beat cards → CTA card) and piped raw
//                into ffmpeg with the voice + ducked music
// Typical cost: $0.16 with the AI hero clip, $0.01 without.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { chat, parseJSON, MOCK } = require('./aiService');
const { generatePosterImage } = require('./imageService');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const MUSIC_DIR = path.join(UPLOADS_DIR, 'music');
for (const d of [VIDEOS_DIR, MUSIC_DIR]) fs.mkdirSync(d, { recursive: true });
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
for (const w of ['Medium', 'SemiBold', 'Bold', 'ExtraBold']) { const f = path.join(FONT_DIR, `Poppins-${w}.ttf`); if (fs.existsSync(f)) GlobalFonts.registerFromPath(f, `Poppins ${w}`); }
const F = (weight, size) => `${size}px "Poppins ${weight}", "Segoe UI", Arial, sans-serif`;

const W = 1080, H = 1920, FPS = 30;
const { get: cfg } = require('./settingsService');
const HERO_SECONDS = 5;
const MOODS = {
  warm: 'Instrumental only, no vocals: warm modern corporate ambient bed, soft piano and synth pads, light percussion, uplifting, 100 BPM, background music under a voice-over',
  bold: 'Instrumental only, no vocals: confident modern electronic bed, punchy soft drums, bright synth plucks, energetic but not loud, 110 BPM, background music under a voice-over',
  calm: 'Instrumental only, no vocals: calm minimal ambient bed, gentle piano, airy pads, slow and reassuring, 80 BPM, background music under a voice-over',
};

const run = (cmd, args, { input, timeout = 300000 } = {}) => new Promise((resolve, reject) => {
  const p = execFile(cmd, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).split('\n').slice(-8).join('\n'))) : resolve({ stdout, stderr }));
  if (input) p.stdin.end(input);
});
const ease = { out: (t) => 1 - Math.pow(1 - t, 3), inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) };
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };

function capWords(text, max) {
  const w = text.split(/\s+/); if (w.length <= max) return text;
  const cut = w.slice(0, max).join(' '); const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (i > cut.length * 0.5 ? cut.slice(0, i + 1) : cut.replace(/[,;:]?\s*$/, '.')).trim();
}

// ---------- 1. script ----------
async function writeScript(post, brand = {}, company = '') {
  if (MOCK || !cfg('OPENROUTER_API_KEY')) {
    const first = post.content.split(/\n+/).filter(Boolean).slice(0, 2).join(' ');
    return { voiceover: `${first} ${post.cta || `Reach out to ${company || 'us'} to learn more.`}`.substring(0, 500), beats: [{ title: 'Start with the goal', line: 'Know what success looks like before you build.' }, { title: 'Keep it simple', line: 'One clear plan, one point of contact.' }, { title: 'Measure it', line: 'Review outcomes every month.' }], cta: post.cta || 'Message us to get started', mood: 'warm' };
  }
  const out = await chat([{
    role: 'user',
    content: `Turn this social post from ${company || 'a business'}${brand.businessType ? ` (${brand.businessType})` : ''} into a 14–18 second vertical video plan.
Return ONLY JSON:
{
  "voiceover": "38–50 words of natural spoken English (about 15 seconds). Hook in the first sentence, then the three points, then the call to action. No hashtags, no emojis, no stage directions, plain words that are easy to say.",
  "beats": [ { "title": "2–5 word heading", "line": "one short supporting sentence, max 12 words" }, { ... }, { ... } ],
  "cta": "max 7 words, imperative",
  "mood": "warm" | "bold" | "calm"
}
Use only facts that are in the post. POST:
${post.content.substring(0, 1200)}`,
  }], { temperature: 0.7, maxTokens: 600 });
  const j = parseJSON(out);
  const beats = (Array.isArray(j.beats) ? j.beats : []).slice(0, 3).map((b) => ({ title: String(b.title || '').trim(), line: String(b.line || '').trim() }));
  while (beats.length < 3) beats.push({ title: 'In short', line: post.title });
  return { voiceover: capWords(String(j.voiceover || '').trim(), 55), beats, cta: String(j.cta || post.cta || 'Get in touch').trim(), mood: MOODS[j.mood] ? j.mood : 'warm' };
}

// ---------- 2. voice with word timings ----------
// Voice ids: Edge neural voices ("en-US-AriaNeural", exact word timings, free) or OpenAI voices via OpenRouter
// ("openai:coral", ~$0.0005 per voice-over, word timings estimated). OpenAI falls back to Edge if it fails.
async function textToSpeech(text, voice, outPath) {
  if (String(voice || '').startsWith('openai:')) {
    try { return await openaiSpeech(text, voice.slice(7), outPath); }
    catch (e) { console.error('OpenAI voice failed, using Edge voice:', e.message); voice = 'en-US-AriaNeural'; }
  }
  return edgeSpeech(text, voice, outPath);
}

async function openaiSpeech(text, voiceName, outPath) {
  const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: cfg('AI_VOICE_MODEL'), stream: true, modalities: ['text', 'audio'], audio: { voice: voiceName || 'coral', format: 'pcm16' },
    messages: [
      { role: 'system', content: 'You are a professional voice-over artist. Read the user\'s text aloud exactly as written, word for word, warm and confident, natural pace. Do not add, skip or change any words.' },
      { role: 'user', content: text },
    ],
  }, { headers: { Authorization: `Bearer ${cfg('OPENROUTER_API_KEY')}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://postera.app', 'X-Title': 'Postera' }, responseType: 'text', timeout: 180000 });
  const chunks = [];
  for (const line of String(res.data).split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try { const d = JSON.parse(line.slice(6)).choices?.[0]?.delta?.audio?.data; if (d) chunks.push(d); } catch { /* skip */ }
  }
  const pcm = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
  if (pcm.length < 24000) throw new Error('no audio returned');
  const raw = `${outPath}.pcm`; fs.writeFileSync(raw, pcm);
  await run(ffmpegPath, ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-c:a', 'libmp3lame', '-b:a', '96k', outPath]);
  fs.rmSync(raw, { force: true });
  let duration = await mediaDuration(outPath);
  if (!duration) duration = Math.max(3, text.split(/\s+/).length / 2.6);
  // estimate word timings: weight by length, add pauses after punctuation, small lead-in/out
  const toks = text.split(/\s+/).filter(Boolean);
  const weight = (t) => t.length + 2 + (/[.!?]$/.test(t) ? 6 : /[,;:]$/.test(t) ? 3 : 0);
  const totalW = toks.reduce((a, t) => a + weight(t), 0);
  const lead = Math.min(0.25, duration * 0.02), span = Math.max(0.1, duration - lead - 0.2);
  let acc = 0; const words = [];
  for (const t of toks) { const w = weight(t); const start = lead + (acc / totalW) * span; acc += w; words.push({ text: t, start, end: lead + ((acc - (/[.!?,;:]$/.test(t) ? 3 : 0)) / totalW) * span }); }
  return { duration, words };
}

async function edgeSpeech(text, voice, outPath) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice || 'en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  const { audioStream, metadataStream } = tts.toStream(text);
  const words = [];
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    metadataStream?.on('data', (d) => { try { for (const m of JSON.parse(d.toString()).Metadata || []) if (m.Type === 'WordBoundary') words.push({ text: m.Data.text.Text, start: m.Data.Offset / 1e7, end: (m.Data.Offset + m.Data.Duration) / 1e7 }); } catch { /* ignore */ } });
    audioStream.pipe(ws);
    audioStream.on('error', reject); ws.on('error', reject);
    ws.on('finish', () => setTimeout(resolve, 300));
    setTimeout(() => reject(new Error('TTS timed out')), 60000);
  });
  let duration = await mediaDuration(outPath);
  if (!duration) duration = Math.max(3, text.split(/\s+/).length / 2.6);
  if (!words.length) { // even spread fallback
    const toks = text.split(/\s+/).filter(Boolean); const per = duration / toks.length;
    toks.forEach((t, i) => words.push({ text: t, start: i * per, end: (i + 1) * per }));
  }
  return { duration, words };
}
async function mediaDuration(file) {
  const { stderr } = await run(ffmpegPath, ['-i', file, '-f', 'null', '-']).catch((e) => ({ stderr: e.message }));
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

// ---------- 3. hero clip (fal.ai) ----------
async function heroClip(posterPath, visual, workDir) {
  if (!cfg('FAL_KEY')) return null;
  const b64 = fs.readFileSync(posterPath).toString('base64');
  const body = {
    image_url: `data:image/png;base64,${b64}`,
    prompt: `${visual || 'The scene comes alive'}. Subtle cinematic motion: slow camera push-in, gentle parallax, soft light drifting. Keep every letter of the text perfectly static, sharp and legible. No new text, no people walking into frame, no flicker.`,
    num_frames: HERO_SECONDS * 24 + 1, frames_per_second: 24, resolution: '720p', aspect_ratio: 'auto', video_quality: 'high',
  };
  const H = { Authorization: `Key ${cfg('FAL_KEY')}`, 'Content-Type': 'application/json' };
  const sub = await axios.post(`https://queue.fal.run/${cfg('VIDEO_HERO_MODEL')}`, body, { headers: H, timeout: 60000 });
  const { status_url, response_url } = sub.data;
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await axios.get(status_url, { headers: H, timeout: 30000 });
    if (st.data.status === 'COMPLETED') break;
    if (st.data.status === 'FAILED') throw new Error('hero clip failed');
  }
  const res = await axios.get(response_url, { headers: H, timeout: 60000 });
  const url = res.data?.video?.url;
  if (!url) throw new Error('hero clip: no video url');
  const clip = path.join(workDir, 'hero.mp4');
  const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  fs.writeFileSync(clip, Buffer.from(dl.data));
  // frames at our fps, fitted to the poster's 4:5 box
  const fdir = path.join(workDir, 'hero'); fs.mkdirSync(fdir, { recursive: true });
  await run(ffmpegPath, ['-y', '-i', clip, '-vf', `fps=${FPS},scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350`, path.join(fdir, '%04d.png')]);
  const frames = fs.readdirSync(fdir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(fdir, f));
  return { frames, cost: 0.15 };
}

// ---------- 4. music bed (cached per mood) ----------
async function musicBed(mood) {
  const file = path.join(MUSIC_DIR, `${mood}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 100000) return file;
  if (!cfg('OPENROUTER_API_KEY') || MOCK) return null;
  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions',
      { model: cfg('AI_MUSIC_MODEL'), stream: true, modalities: ['text', 'audio'], messages: [{ role: 'user', content: MOODS[mood] || MOODS.warm }] },
      { headers: { Authorization: `Bearer ${cfg('OPENROUTER_API_KEY')}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://postera.app', 'X-Title': 'Postera' }, responseType: 'text', timeout: 300000 });
    const chunks = [];
    for (const line of String(res.data).split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try { const d = JSON.parse(line.slice(6)).choices?.[0]?.delta?.audio?.data; if (d) chunks.push(d); } catch { /* skip */ }
    }
    if (!chunks.length) return null;
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))));
    // only cache a file ffmpeg can actually decode and that is long enough to loop under a video
    if ((await mediaDuration(tmp)) < 5) { fs.rmSync(tmp, { force: true }); return null; }
    fs.renameSync(tmp, file);
    return file;
  } catch (e) { console.error('music bed failed:', e.message); return null; }
}

// ---------- 5. renderer ----------
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.closePath(); }
function wrap(ctx, text, maxW) { const out = []; let cur = ''; for (const w of String(text).split(/\s+/)) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out; }
function drawCover(ctx, img, x, y, w, h) { const s = Math.max(w / img.width, h / img.height); ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s); }

// caption groups of 2–4 words, highlighted word by word
function captionGroups(words) {
  const groups = []; let g = [];
  for (const w of words) { g.push(w); const text = g.map((x) => x.text).join(' '); if (g.length >= 4 || text.length > 22 || /[.!?,]$/.test(w.text)) { groups.push(g); g = []; } }
  if (g.length) groups.push(g);
  return groups.map((ws) => ({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end + 0.25 }));
}
function drawCaptions(ctx, groups, t, accent, baselineY) {
  const g = groups.find((x) => t >= x.start - 0.05 && t < x.end);
  if (!g) return;
  ctx.font = F('ExtraBold', 60); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const gap = 18; const widths = g.words.map((w) => ctx.measureText(w.text.toUpperCase()).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (g.words.length - 1);
  let x = (W - total) / 2;
  const pop = clamp01((t - g.start) / 0.12);
  ctx.save(); ctx.translate(W / 2, baselineY); ctx.scale(0.9 + 0.1 * ease.out(pop), 0.9 + 0.1 * ease.out(pop)); ctx.translate(-W / 2, -baselineY);
  ctx.fillStyle = 'rgba(6,7,13,0.55)'; roundRect(ctx, x - 28, baselineY - 50, total + 56, 100, 22); ctx.fill();
  g.words.forEach((w, i) => {
    const active = t >= w.start - 0.02;
    ctx.fillStyle = active ? accent : 'rgba(255,255,255,0.92)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 12;
    ctx.fillText(w.text.toUpperCase(), x, baselineY);
    ctx.shadowBlur = 0; x += widths[i] + gap;
  });
  ctx.restore();
}

function drawBackdrop(ctx, poster, accent, t) {
  ctx.fillStyle = '#06070d'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.filter = 'blur(40px)'; ctx.globalAlpha = 0.55; drawCover(ctx, poster, -60, -60, W + 120, H + 120); ctx.restore();
  ctx.fillStyle = 'rgba(6,7,13,0.55)'; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.8, H * 0.1 + Math.sin(t * 0.6) * 40, 0, W * 0.8, H * 0.1, 900);
  g.addColorStop(0, `${accent}55`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function drawBrandBar(ctx, logo, company, website, dark = true) {
  const y = H - 150;
  if (logo) {
    const h = 56, w = Math.min(h * (logo.width / logo.height), 300), hh = w / (logo.width / logo.height);
    if (dark && lum('#000000') < 0.5) { ctx.fillStyle = 'rgba(255,255,255,0.92)'; roundRect(ctx, 60 - 14, y - hh / 2 - 12, w + 28, hh + 24, 14); ctx.fill(); }
    ctx.drawImage(logo, 60, y - hh / 2, w, hh);
  } else if (company) { ctx.font = F('Bold', 30); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(company, 60, y); }
  if (website) { ctx.font = F('SemiBold', 26); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(website, W - 60, y); ctx.textAlign = 'left'; }
}

async function renderVideo({ poster, heroFrames, plan, words, voiceDuration, accent, logo, company, website, outPath, voicePath, musicPath }) {
  const heroDur = heroFrames ? heroFrames.length / FPS : Math.max(4, Math.min(6, voiceDuration * 0.3));
  const ctaDur = 3.2;
  const beatsDur = Math.max(6, voiceDuration + 1.0 - heroDur - ctaDur);
  const beatDur = beatsDur / 3;
  const total = heroDur + beatsDur + ctaDur;
  const groups = captionGroups(words);
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  const frames = Math.ceil(total * FPS);

  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0', '-i', voicePath];
  if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);
  const filter = musicPath
    ? `[1:a]aresample=48000,apad=pad_dur=${Math.max(0.2, total - voiceDuration + 0.3).toFixed(2)}[v];[2:a]aresample=48000,volume=0.16,afade=t=in:st=0:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5,atrim=0:${total.toFixed(2)}[m];[v][m]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[a]`
    : `[1:a]aresample=48000,apad=pad_dur=${Math.max(0.2, total - voiceDuration + 0.3).toFixed(2)}[a]`;
  args.push('-filter_complex', filter, '-map', '0:v', '-map', '[a]', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', outPath);
  const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = ''; ff.stderr.on('data', (d) => { ffErr += d; if (ffErr.length > 20000) ffErr = ffErr.slice(-10000); });
  ff.stdin.on('error', () => { /* ffmpeg exited; the close handler reports why */ });
  const done = new Promise((resolve, reject) => { ff.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg: ' + ffErr.split('\n').slice(-6).join('\n')))); ff.on('error', reject); });
  done.catch(() => {}); // observed below; prevents an unhandled rejection if ffmpeg dies mid-render
  let dead = false; ff.on('close', () => { dead = true; });
  const ffError = () => new Error('ffmpeg: ' + ffErr.split('\n').filter(Boolean).slice(-6).join('\n'));
  const write = (buf) => new Promise((resolve, reject) => {
    if (dead || ff.stdin.destroyed) return reject(ffError());
    if (ff.stdin.write(buf)) return resolve();
    const onClose = () => reject(ffError());
    ff.once('close', onClose);
    ff.stdin.once('drain', () => { ff.off('close', onClose); resolve(); });
  });

  const heroCount = heroFrames ? heroFrames.length : 0;
  for (let i = 0; i < frames; i++) {
    const t = i / FPS;
    drawBackdrop(ctx, poster, accent, t);
    if (t < heroDur) {
      // ---- hero: poster (or AI clip) in a rounded 4:5 frame with a slow push-in, captions under it
      const p = clamp01(t / heroDur);
      const box = { w: 980, h: 1225 }; const scale = heroCount ? 1 : 1 + 0.06 * p;
      const x = (W - box.w) / 2, y = 150 + 10 * Math.sin(t * 0.8);
      const intro = ease.out(clamp01(t / 0.6));
      ctx.save(); ctx.globalAlpha = intro; ctx.translate(0, (1 - intro) * 40);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 24;
      roundRect(ctx, x, y, box.w, box.h, 36); ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.save(); roundRect(ctx, x, y, box.w, box.h, 36); ctx.clip();
      const img = heroCount ? await loadImage(fs.readFileSync(heroFrames[Math.min(heroCount - 1, i)])) : poster;
      const s = Math.max(box.w / img.width, box.h / img.height) * scale;
      ctx.drawImage(img, x + (box.w - img.width * s) / 2, y + (box.h - img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2; roundRect(ctx, x, y, box.w, box.h, 36); ctx.stroke();
      ctx.restore();
      drawCaptions(ctx, groups, t, accent, 1560);
    } else if (t < heroDur + beatsDur) {
      // ---- beat cards
      const bt = t - heroDur; const idx = Math.min(2, Math.floor(bt / beatDur)); const lt = bt - idx * beatDur;
      const inA = ease.out(clamp01(lt / 0.45)); const outA = 1 - ease.inOut(clamp01((lt - (beatDur - 0.35)) / 0.35));
      const a = Math.min(inA, idx === 2 ? 1 : outA);
      ctx.font = F('SemiBold', 30); ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${idx + 1} / 3`, 90, 230);
      ctx.fillStyle = 'rgba(255,255,255,0.14)'; roundRect(ctx, 90, 252, W - 180, 6, 3); ctx.fill();
      ctx.fillStyle = accent; roundRect(ctx, 90, 252, (W - 180) * ((idx + clamp01(lt / beatDur)) / 3), 6, 3); ctx.fill();
      ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - inA) * 60);
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; roundRect(ctx, 70, 420, W - 140, 760, 40); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 2; roundRect(ctx, 70, 420, W - 140, 760, 40); ctx.stroke();
      ctx.fillStyle = accent; roundRect(ctx, 130, 500, 90, 10, 5); ctx.fill();
      const b = plan.beats[idx];
      ctx.fillStyle = '#fff'; ctx.font = F('ExtraBold', 92); let y = 640;
      for (const line of wrap(ctx, b.title, W - 260).slice(0, 3)) { ctx.fillText(line, 130, y); y += 104; }
      ctx.fillStyle = 'rgba(255,255,255,0.78)'; ctx.font = F('Medium', 44); y += 30;
      for (const line of wrap(ctx, b.line, W - 260).slice(0, 3)) { ctx.fillText(line, 130, y); y += 60; }
      ctx.restore();
      drawCaptions(ctx, groups, t, accent, 1380);
    } else {
      // ---- CTA card
      const ct = t - heroDur - beatsDur; const a = ease.out(clamp01(ct / 0.5));
      ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 40);
      if (logo) { const h = 170, w = Math.min(h * (logo.width / logo.height), 760), hh = w / (logo.width / logo.height); ctx.fillStyle = 'rgba(255,255,255,0.95)'; roundRect(ctx, (W - w) / 2 - 36, 560 - hh / 2 - 30, w + 72, hh + 60, 32); ctx.fill(); ctx.drawImage(logo, (W - w) / 2, 560 - hh / 2, w, hh); }
      else { ctx.font = F('ExtraBold', 84); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(company || '', W / 2, 560); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff'; ctx.font = F('ExtraBold', 88); let y = 900;
      for (const line of wrap(ctx, plan.cta, W - 200).slice(0, 3)) { ctx.fillText(line, W / 2, y); y += 100; }
      if (website) { ctx.font = F('SemiBold', 40); ctx.fillStyle = accent; ctx.fillText(website, W / 2, y + 40); }
      const pulse = 1 + 0.03 * Math.sin(ct * 4);
      ctx.save(); ctx.translate(W / 2, 1340); ctx.scale(pulse, pulse); ctx.fillStyle = accent; roundRect(ctx, -230, -48, 460, 96, 48); ctx.fill();
      ctx.fillStyle = lum(accent) > 0.6 ? '#0b0d17' : '#fff'; ctx.font = F('Bold', 38); ctx.textBaseline = 'middle'; ctx.fillText('Follow for more', 0, 2); ctx.restore();
      ctx.restore();
      drawCaptions(ctx, groups, t, accent, 1560);
    }
    if (t < heroDur + beatsDur) drawBrandBar(ctx, logo, company, website);
    await write(Buffer.from(canvas.data()));
  }
  ff.stdin.end();
  await done;
  return { total, heroDur };
}

// ---------- entry ----------
async function generateVideo(post, user) {
  const brand = user.brandProfile || {};
  const accent = user.brandColor && user.brandColor !== '#1677ff' ? user.brandColor : '#7c5cff';
  const logoPath = user.logo ? path.join(__dirname, '..', user.logo) : null;
  const website = (brand.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

  // poster (render one if the post has none)
  let imagePath = post.imagePath && fs.existsSync(post.imagePath) ? post.imagePath : null;
  if (!imagePath) {
    const img = await generatePosterImage({ ...post.toObject?.() || post, imageHeadline: post.imageHeadline || post.title }, 0, logoPath, user.brandColor, user.company, user.imageMode || 'designed', brand);
    imagePath = img.filepath; post.imageUrl = img.url; post.imagePath = img.filepath; post.imageStatus = 'done';
  }
  const base = `video_${post._id}_${Date.now()}`;
  const work = path.join(VIDEOS_DIR, `.${base}`); fs.mkdirSync(work, { recursive: true });
  try {
    const plan = post.videoPlan?.beats?.length === 3 && post.videoScript ? { ...post.videoPlan, voiceover: post.videoScript } : await writeScript(post, brand, user.company);
    const voicePath = path.join(work, 'voice.mp3');
    const [voice, hero, music] = await Promise.all([
      textToSpeech(plan.voiceover, brand.voice, voicePath),
      heroClip(imagePath, post.imagePrompt, work).catch((e) => { console.error('hero clip skipped:', e.message); return null; }),
      musicBed(plan.mood),
    ]);
    const poster = await loadImage(fs.readFileSync(imagePath));
    const logo = logoPath && fs.existsSync(logoPath) ? await loadImage(fs.readFileSync(logoPath)).catch(() => null) : null;
    const outPath = path.join(VIDEOS_DIR, `${base}.mp4`);
    const args = { poster, heroFrames: hero?.frames || null, plan, words: voice.words, voiceDuration: voice.duration, accent, logo, company: user.company, website, outPath, voicePath, musicPath: music };
    let r;
    try { r = await renderVideo(args); }
    catch (e) {
      if (!music) throw e;
      console.error('render failed with music, retrying without:', e.message);
      fs.rmSync(music, { force: true });
      r = await renderVideo({ ...args, musicPath: null });
    }
    const audioOut = path.join(VIDEOS_DIR, `${base}.mp3`); fs.copyFileSync(voicePath, audioOut);
    return {
      videoPath: outPath, videoUrl: `/uploads/videos/${base}.mp4`, audioUrl: `/uploads/videos/${base}.mp3`, script: plan.voiceover,
      plan: { beats: plan.beats, cta: plan.cta, mood: plan.mood, hero: hero ? 'ai' : 'poster', seconds: +r.total.toFixed(1), cost: +((hero?.cost || 0) + 0.01).toFixed(3) },
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { generateVideo, textToSpeech, writeScript, capWords };
