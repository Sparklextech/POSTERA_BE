const axios = require('axios');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const { get: cfg } = require('./settingsService');
// MOCK_AI=1 → deterministic content, no API calls. Lets the whole pipeline run with zero credits.
const MOCK = process.env.MOCK_AI === '1' || process.env.MOCK_AI === 'true';

const PILLARS = {
  educate: 'EDUCATE — a practical tip, how-to, checklist or myth-buster the audience can use today',
  showcase: 'SHOWCASE — one specific service, product, listing or offering, explained through a concrete customer benefit',
  proof: 'PROOF — a client story, testimonial, before/after, number or case study (anonymised if needed)',
  story: 'STORY — behind the scenes, team, values, a day in the life, a lesson learned',
  trend: 'TREND — an industry/local market insight, seasonal angle or news item with the business\'s point of view',
  engage: 'ENGAGE — a question, poll, this-or-that or mild opinion that invites comments',
  offer: 'OFFER — a clear call to action: consultation, demo, site visit, booking, limited promotion',
  festival: 'FESTIVAL — a warm greeting tied to the occasion, connected lightly to the business',
};

class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function chat(messages, { temperature = 0.8, maxTokens = 4000, model = cfg('AI_TEXT_MODEL'), timeout = 120000, _retry = 0 } = {}) {
  if (!cfg('OPENROUTER_API_KEY')) throw new AIError('OPENROUTER_API_KEY is not set', 500);
  try {
    return await chatOnce(messages, { temperature, maxTokens, model, timeout });
  } catch (e) {
    // transient network / upstream hiccups → retry twice with backoff
    if (!e.status || e.status >= 500 || e.status === 429) {
      if (_retry < 2) { await new Promise(r => setTimeout(r, 1500 * (_retry + 1))); return chat(messages, { temperature, maxTokens, model, timeout, _retry: _retry + 1 }); }
    }
    throw e;
  }
}
async function chatOnce(messages, { temperature, maxTokens, model, timeout }) {
  try {
    const response = await axios.post(
      OPENROUTER_URL,
      { model, messages, temperature, max_tokens: maxTokens },
      {
        headers: {
          Authorization: `Bearer ${cfg('OPENROUTER_API_KEY')}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://postera.app',
          'X-Title': 'Postera',
        },
        timeout,
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 402) throw new AIError('OpenRouter has no credits left. Top up at openrouter.ai/settings/credits or set MOCK_AI=1 for demo content.', 402);
    if (status === 401) throw new AIError('OpenRouter API key rejected (401). Check OPENROUTER_API_KEY.', 401);
    throw new AIError(`AI request failed: ${msg}`, status || 500);
  }
}

// Tolerant JSON extraction: strips fences, finds the first [ or {.
function parseJSON(text) {
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const start = Math.min(...['[', '{'].map(c => t.indexOf(c)).filter(i => i >= 0));
  if (Number.isFinite(start) && start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (end > 0) t = t.slice(0, end + 1);
  return JSON.parse(t);
}

function brandBlock(brand = {}, company = '') {
  const lines = [
    `Business: ${company || 'our company'}${brand.businessType ? ` (${brand.businessType})` : ''}`,
    brand.description && `What we do: ${brand.description}`,
    brand.services?.length && `Services / products: ${brand.services.join('; ')}`,
    brand.audience && `Target audience: ${brand.audience}`,
    brand.usp && `What makes us different: ${brand.usp}`,
    brand.location && `Location / market: ${brand.location}`,
    brand.language && brand.language !== 'English' && `Write in: ${brand.language}`,
  ].filter(Boolean);
  return lines.join('\n');
}

const toneGuide = {
  professional: 'professional, warm and confident — no corporate jargon',
  casual: 'friendly, conversational, like talking to a neighbour',
  inspiring: 'uplifting and motivational, grounded in real examples',
  educational: 'clear teacher voice, break things down simply',
  humorous: 'light, witty, never sarcastic about customers',
};

const RULES = `WRITING RULES
- Speak as the business, to its customers. Plain language. Specific over generic. No clichés ("in today's fast-paced world", "unlock your potential", "take your business to the next level").
- Every post must be about THIS business and its customers' problems — never about AI tools, LinkedIn, or "content" itself.
- Each post must include at least ONE concrete, true detail from the knowledge/brand block (a named service, a city, a team fact, a process step, an offer, a real number). Never invent clients, statistics, awards, regulations, prices, product features or results. Never write "a client came to us" / "we recently helped a firm" stories unless that exact case is in the knowledge. If no real proof exists, PROOF posts describe how the work is done and what the customer sees at each step — qualitative, honest, no made-up percentages.
- Hooks: the first line must stop the scroll. Across the batch use DIFFERENT hook types and never the same type twice in a row: a bold claim, a surprising specific, a mini-story opener drawn from something the knowledge actually describes, a contrarian opinion, a number, a direct question. At most ONE post in the batch may open with a question.
- Vary structure: some posts are short paragraphs, some are a 3–5 step list, one can be a single punchy paragraph. Lists use "1." "2." or "→", never asterisks.
- PLAIN TEXT ONLY. No markdown: no **bold**, no # headings, no backticks, no [links](). Emojis allowed only if enabled, max 3, never as bullet markers.
- Today's date is given below. Never mention a year unless it is the current or next year.
- End with a soft or clear call to action matching the pillar (not always "Let's talk" — vary it).
- Hashtags: 3–5, relevant to the industry and location, no spaces, no # prefix in the JSON.
- posterHeadline: 4–8 words printed big on the poster. A sharp, quotable line (a claim, a promise, a contrast), not the title repeated. Sentence case with natural punctuation (e.g. "Build for scale, not launch day."). No emojis, hashtags or quote marks.
- posterKicker: 1–3 words shown as a small label above the headline (the service or theme, e.g. "Mobile apps", "Home loans", "Kids dentistry").
- imagePrompt: one sentence describing the poster's visual subject that someone in this industry would instantly recognise (places, objects, environments, people from behind/at a distance/hands). Vary settings across the batch (not always an office). No text, logos or close-up faces.
Return ONLY valid JSON. No markdown fences, no commentary.`;

const SCHEMA = `Each object has:
- "title": catchy headline (max 8 words)
- "pillar": the pillar key given for the slot
- "content": the main post (LinkedIn / long form), 80–200 words, line breaks between short paragraphs, 1–3 emojis if allowed
- "variants": { "facebook": 60–120 words conversational, "instagram": caption ≤ 120 words ending with a hashtag line, "twitter": ≤ 260 characters, punchy }
- "hashtags": array of 3–5 strings
- "cta": one sentence call to action
- "posterHeadline": 4–8 words for the poster
- "posterKicker": 1–3 word label
- "imagePrompt": one sentence visual subject`;

function pillarLabel(key) { return PILLARS[key] || PILLARS.educate; }

// ---------- Weekly plan ----------
// slots: [{ date: 'YYYY-MM-DD', pillar }] ; returns array aligned with slots
async function generatePlanPosts(opts) {
  const { brand = {}, company = '', slots, knowledge = '', recentTitles = [], focus = '', tone, includeEmoji = true, includeHashtags = true } = opts;
  if (MOCK) return slots.map((s, i) => mockPost(s.pillar, brand, company, i));

  const out = [];
  for (let i = 0; i < slots.length; i += 7) {
    const batch = slots.slice(i, i + 7);
    const slotLines = batch.map((s, j) => `${j + 1}. date ${s.date} — pillar "${s.pillar}": ${pillarLabel(s.pillar)}`).join('\n');
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are the in-house content marketer for the business below. Today is ${today}. Plan exactly ${batch.length} social media posts.

${brandBlock(brand, company)}
Tone: ${toneGuide[tone || brand.tone] || toneGuide.professional}
${knowledge ? `\nKNOWLEDGE ABOUT THE BUSINESS (from its website/documents — use real details from here):\n${knowledge.substring(0, 6000)}\n` : ''}
${focus ? `\nTHIS WEEK'S FOCUS: ${focus}\n` : ''}
${recentTitles.length ? `\nALREADY PUBLISHED RECENTLY (do not repeat these angles):\n- ${recentTitles.slice(0, 30).join('\n- ')}\n` : ''}
SLOTS TO FILL (one post each, in order):
${slotLines}

${RULES}
${includeHashtags ? '' : '- Do NOT include hashtags (return empty array).'}
${includeEmoji ? '' : '- Do NOT use emojis.'}

Return a JSON array of EXACTLY ${batch.length} objects in slot order (one per slot, no more, no fewer). ${SCHEMA}`;

    let text;
    try { text = await chat([{ role: 'user', content: prompt }], { temperature: 0.85, maxTokens: 7000 }); }
    catch (e) { if (e.status === 402 || e.status === 401) throw e; text = await chat([{ role: 'user', content: prompt }], { temperature: 0.85, maxTokens: 6000, model: cfg('AI_FALLBACK_MODEL') }); }
    let posts = parseJSON(text);
    if (!Array.isArray(posts) || posts.length === 0) throw new AIError('AI returned no posts', 502);
    posts = posts.map((p, j) => normalizePost(p, batch[j]?.pillar || batch[batch.length - 1].pillar));
    // quality gate: drop duplicates / weak ones, then fill the gaps with one targeted call
    const seen = new Set(out.map(o => o.title.toLowerCase()));
    const good = [];
    for (const p of posts) {
      const key = p.title.toLowerCase();
      if (seen.has(key) || !passesQuality(p)) continue;
      seen.add(key); good.push(p);
    }
    const missing = batch.length - good.length;
    if (missing > 0 && !opts.noRefill) {
      const refill = await generatePlanPosts({ ...opts, slots: batch.slice(good.length), recentTitles: [...recentTitles, ...good.map(g => g.title), ...out.map(o => o.title)], noRefill: true });
      good.push(...refill.slice(0, missing));
    }
    while (good.length < batch.length) good.push(good[good.length - 1] || mockPost(batch[0].pillar, brand, company));
    out.push(...good.slice(0, batch.length));
  }
  return out;
}

// ---------- Legacy campaign generator (kept for the campaign wizard; now industry-aware) ----------
async function generatePostsContent(globalPrompt, totalPosts, tone, includeHashtags, includeEmoji, websiteContent = '', brand = {}, company = '') {
  const keys = Object.keys(PILLARS).filter(k => k !== 'festival');
  const slots = Array.from({ length: totalPosts }, (_, i) => ({ date: `post ${i + 1}`, pillar: keys[i % keys.length] }));
  return generatePlanPosts({
    brand, company, slots, knowledge: websiteContent, focus: globalPrompt, tone, includeEmoji, includeHashtags,
  });
}

async function regeneratePost(globalPrompt, tone, dayNumber, totalPosts, brand = {}, company = '', pillar = 'educate') {
  const [post] = await generatePlanPosts({
    brand, company, tone, focus: globalPrompt, slots: [{ date: `post ${dayNumber} of ${totalPosts}`, pillar }],
  });
  return post;
}

// ---------- Video narration ----------
async function generateVideoScript(post, brand = {}, company = '') {
  if (MOCK) {
    const first = post.content.split(/\n+/).filter(Boolean).slice(0, 2).join(' ');
    return `${first} ${post.cta || `Reach out to ${company || 'us'} to learn more.`}`.substring(0, 600);
  }
  const text = await chat([{
    role: 'user',
    content: `Turn this social post into a 35–45 second spoken voice-over script (70–100 words) for a short vertical/square video from ${company || 'the business'}${brand.businessType ? ` (${brand.businessType})` : ''}.
Warm, natural spoken English, short sentences, no hashtags, no emojis, no stage directions. Start with a hook, end with a clear call to action.

POST:
${post.content}

Return ONLY the script text.`,
  }], { temperature: 0.7, maxTokens: 400 });
  return text.replace(/^["']|["']$/g, '').trim();
}

// ---------- Knowledge summarisation ----------
async function summarizeSource(name, text, brand = {}, company = '') {
  if (MOCK) {
    return {
      summary: text.substring(0, 1200),
      topics: ['Our most popular service and who it is for', 'A common customer question answered', 'A recent success story', 'How to choose the right provider', 'What a first consultation looks like'],
      businessType: brand.businessType || '',
      services: brand.services || [],
      audience: brand.audience || '',
    };
  }
  const out = await chat([{
    role: 'user',
    content: `You are a marketing strategist. Read this material from ${company || 'a business'} ("${name}") and extract what a social media manager needs.
STRICT: use only facts stated in the MATERIAL. Do not add services, clients, numbers, locations, regulations or claims that are not written there, even if they seem likely. If the material is thin, keep the brief short and say which facts are missing.

MATERIAL:
${text.substring(0, 14000)}

Return ONLY JSON:
{
  "summary": "factual brief of up to 450 words, only from the material: what the business does, services/products with specifics, audience, differentiators, locations, numbers, proof points, offers, tone. End with a line 'Not stated: …' listing important facts the material does not give.",
  "businessType": "short label e.g. 'Real estate brokerage', 'Dental clinic', 'B2B SaaS'",
  "services": ["up to 10 specific services/products/listings"],
  "audience": "one sentence",
  "usp": "one sentence",
  "topics": ["12 specific post ideas grounded in this material, each ≤ 12 words"]
}`,
  }], { temperature: 0.4, maxTokens: 1800, model: cfg('AI_SMART_MODEL') }).catch(() => chat([{ role: 'user', content: `Summarise for social media planning (return JSON with summary, businessType, services[], audience, usp, topics[]):\n${text.substring(0, 10000)}` }], { temperature: 0.4, maxTokens: 1500 }));
  return parseJSON(out);
}

// ---------- quality ----------
const CLICHES = /unlock your (business )?potential|fast-paced world|take your business to the next level|game.?changer|in today's digital (age|world)/i;
function passesQuality(p) {
  if (!p.content || p.content.split(/\s+/).length < 35) return false;
  if (CLICHES.test(p.title) || CLICHES.test(p.content.split('\n')[0])) return false;
  const y = new Date().getFullYear();
  if (new RegExp('\\b(' + (y - 2) + '|' + (y - 1) + ')\\b').test(p.content)) return false; // stale year
  return true;
}
function scrub(t) {
  return String(t || '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/^#+\s*/gm, '').replace(/`/g, '')
    .replace(/^\s*[\*\-]\s+/gm, '→ ').replace(/\[(.*?)\]\((.*?)\)/g, '$1').replace(/[ \t]+\n/g, '\n').trim();
}

// ---------- helpers ----------
function normalizePost(p, pillar) {
  const str = (v) => (typeof v === 'string' ? scrub(v) : '');
  return {
    title: str(p.title) || 'Untitled post',
    pillar: PILLARS[p.pillar] ? p.pillar : pillar,
    content: str(p.content) || str(p.variants?.facebook) || 'Post content',
    variants: {
      linkedin: '',
      facebook: str(p.variants?.facebook),
      instagram: str(p.variants?.instagram),
      twitter: str(p.variants?.twitter).substring(0, 280),
    },
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(h => String(h).replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean).slice(0, 6) : [],
    cta: str(p.cta),
    posterHeadline: str(p.posterHeadline || p.imageHeadline).split(/\s+/).slice(0, 9).join(' ') || str(p.title),
    posterKicker: str(p.posterKicker).split(/\s+/).slice(0, 3).join(' '),
    imageHeadline: str(p.posterHeadline || p.imageHeadline) || str(p.title).split(' ').slice(0, 4).join(' '),
    imagePrompt: str(p.imagePrompt),
  };
}

const MOCK_LIB = {
  educate: (b, s) => ({ title: `3 things to check before choosing ${s}`, content: `Choosing ${s} should not feel like a gamble.\n\nHere is the 3-point check we walk every client through:\n\n1️⃣ Ask what is included — and what is not.\n2️⃣ Ask for one recent example with a result.\n3️⃣ Ask how problems get handled after you sign.\n\nIf the answers come easily, you are in good hands.\n\nSave this for your next conversation.`, image: 'Clipboard checklist on a desk', scene: 'a clean wooden desk with a clipboard, pen and coffee, soft morning window light' }),
  showcase: (b, s) => ({ title: `Inside our ${s}`, content: `Most people only see the finished result. Here is what actually happens behind our ${s}.\n\nWe start with a 20-minute conversation about what you need. Then a clear plan, a fixed timeline and one point of contact until it is done.\n\nNo surprises. No chasing. Just the outcome you asked for.\n\nWant to see if it fits your situation? Send us a message.`, image: 'See it in action', scene: 'a professional workspace of this industry, tools of the trade neatly arranged, warm natural light' }),
  proof: (b, s) => ({ title: `From stuck to sorted in 3 weeks`, content: `A client came to us after two false starts elsewhere.\n\nThe problem: unclear scope, missed dates, zero updates.\n\nWhat we changed: one plan, weekly check-ins, honest timelines.\n\nThe result: delivered in 3 weeks, and a referral the same month.\n\nThat is the standard we hold for every ${s} project. ✅`, image: 'Real results, real people', scene: 'a handshake over a table with documents, viewed from the side, bright office' }),
  story: (b) => ({ title: `Why we started ${b.company || 'this business'}`, content: `We did not start ${b.company || 'this business'} to be the biggest.\n\nWe started because too many people were paying for a service and getting an excuse.\n\nSo we built a small team that picks up the phone, says what it will do, and does it.\n\nStill the same promise today. 🙌`, image: 'Our story', scene: 'a small team working together around a table, seen from behind, warm evening light' }),
  trend: (b) => ({ title: `What is changing in ${b.businessType || 'our industry'} this year`, content: `Three shifts we are seeing in ${b.businessType || 'our industry'} right now:\n\n→ Customers compare more before they call.\n→ Speed of reply matters more than price.\n→ Trust is built in public, through reviews and clear information.\n\nOur take: the businesses that explain things simply will win.\n\nWhich of these are you noticing too?`, image: 'What is changing', scene: 'a city street or market relevant to the industry at golden hour, people in motion, no readable signs' }),
  engage: (b) => ({ title: `Quick question for you`, content: `When you pick a ${b.businessType || 'service provider'}, what matters most?\n\nA) Price\nB) Speed\nC) Reviews\nD) A real person to talk to\n\nDrop a letter below — we read every reply. 👇`, image: 'Your opinion matters', scene: 'four coloured doors in a row on a bright wall, playful composition' }),
  offer: (b, s) => ({ title: `Book a free 20-minute consultation`, content: `Thinking about ${s}, but not sure where to start?\n\nThis month we are offering a free 20-minute consultation: no sales pitch, just clear answers to your questions and a simple next step.\n\nSpots are limited each week. Message us "CONSULT" to grab yours.`, image: 'Free consultation', scene: 'a calendar on a bright desk with a cup of tea and a pen, soft daylight' }),
  festival: (b) => ({ title: `Warm wishes from ${b.company || 'our team'}`, content: `Wishing you and your loved ones a joyful celebration from all of us at ${b.company || 'our team'}.\n\nMay this season bring you light, rest and good company. 🎉`, image: 'Happy celebrations', scene: 'festive lights and decorations, warm bokeh, celebratory colours' }),
};

function mockPost(pillar, brand = {}, company = '', i = 0) {
  const service = brand.services?.[i % Math.max(1, (brand.services || []).length)] || brand.businessType || 'our service';
  const gen = MOCK_LIB[pillar] || MOCK_LIB.educate;
  const m = gen({ ...brand, company }, service);
  const tags = [company, brand.businessType, brand.location, 'SmallBusiness', 'Tips'].filter(Boolean).map(t => t.replace(/[^A-Za-z0-9]/g, '')).slice(0, 5);
  return normalizePost({
    ...m,
    pillar,
    variants: {
      facebook: m.content.split('\n\n').slice(0, 3).join('\n\n'),
      instagram: m.content.split('\n\n').slice(0, 2).join('\n\n') + '\n\n' + tags.map(t => '#' + t).join(' '),
      twitter: m.content.split('\n')[0].substring(0, 200) + ' ' + tags.slice(0, 2).map(t => '#' + t).join(' '),
    },
    hashtags: tags,
    cta: 'Message us to learn more.',
    imageHeadline: m.image,
    imagePrompt: m.scene,
  }, pillar);
}

module.exports = {
  chat, parseJSON, AIError, PILLARS, MOCK,
  generatePlanPosts, generatePostsContent, regeneratePost, generateVideoScript, summarizeSource,
  brandBlock,
};

// ---------- Composer assist ----------
async function assist({ action, text = '', idea = '', pillar = 'showcase', platforms = ['linkedin'], brand = {}, company = '', knowledge = '' }) {
  const platformNote = platforms.includes('twitter') && platforms.length === 1 ? 'Target: X — max 270 characters.' : `Target platforms: ${platforms.join(', ')}. Length 60–180 words.`;
  const base = `${brandBlock(brand, company)}\n${knowledge ? `KNOWLEDGE:\n${knowledge.substring(0, 2500)}\n` : ''}Pillar: ${pillarLabel(pillar)}\n${platformNote}\nPLAIN TEXT ONLY, no markdown. Keep the business's voice (${toneGuide[brand.tone] || toneGuide.professional}).`;
  const tasks = {
    write: `Write one social media post from this idea: "${idea}".\n${base}\nReturn JSON {"text": "...", "imagePrompt": "one sentence photo-realistic scene for the poster, no text/logos/faces"}.`,
    improve: `Improve this post: sharper hook, tighter sentences, one concrete detail from the knowledge if relevant, clear call to action. Keep the meaning and length.\n${base}\nPOST:\n${text}\nReturn JSON {"text": "..."}.`,
    shorter: `Cut this post to roughly half its length without losing the point or the call to action.\n${base}\nPOST:\n${text}\nReturn JSON {"text": "..."}.`,
    hook: `Rewrite only the first line so it stops the scroll (a bold claim, a number, a mini-story opener or a contrarian take). Keep the rest.\n${base}\nPOST:\n${text}\nReturn JSON {"text": "..."}.`,
    hashtags: `Append 3–5 relevant hashtags (industry + location) as a final line. Remove any existing hashtag line first.\n${base}\nPOST:\n${text}\nReturn JSON {"text": "..."}.`,
  };
  const prompt = tasks[action] || tasks.improve;
  if (MOCK) return { text: action === 'write' ? `${idea}\n\nHere is what that means for you: a clear plan, a fixed timeline and one person who answers your questions.\n\nMessage ${company || 'us'} to know more.` : text + '\n\n#SmallBusiness' };
  const out = await chat([{ role: 'user', content: prompt }], { temperature: 0.8, maxTokens: 900 });
  const j = parseJSON(out);
  return { text: String(j.text || '').replace(/\*\*(.*?)\*\*/g, '$1').trim(), imagePrompt: j.imagePrompt || '' };
}
module.exports.assist = assist;
