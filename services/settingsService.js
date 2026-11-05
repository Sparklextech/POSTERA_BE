// Integration keys and model choices live in MongoDB (encrypted), editable by a superadmin in the admin panel.
// Lookup order for every value: database → server environment (only used to seed on first start) → built-in default.
// Infrastructure values (MONGODB_URI, JWT_SECRET, BACKEND_URL, FRONTEND_URL, PORT) stay in the environment.
const crypto = require('crypto');
const mongoose = require('mongoose');

const KEYS = [
  { key: 'OPENROUTER_API_KEY', group: 'AI', label: 'OpenRouter API key', secret: true, help: 'Text, posters, voice and music. openrouter.ai/keys' },
  { key: 'AI_TEXT_MODEL', group: 'AI', label: 'Planning & writing model', def: 'anthropic/claude-sonnet-4.6' },
  { key: 'AI_FALLBACK_MODEL', group: 'AI', label: 'Fallback writing model', def: 'openai/gpt-4o-mini' },
  { key: 'AI_SMART_MODEL', group: 'AI', label: 'Knowledge summaries model', def: 'anthropic/claude-sonnet-4.6' },
  { key: 'AI_DESIGN_MODEL', group: 'Posters', label: 'Designed poster model', def: 'google/gemini-3.1-flash-image' },
  { key: 'AI_PREMIUM_MODEL', group: 'Posters', label: 'Premium poster model', def: 'google/gemini-3-pro-image' },
  { key: 'AI_IMAGE_MODEL', group: 'Posters', label: 'Photo model (text-free)', def: 'google/gemini-3.1-flash-image' },
  { key: 'AI_VISION_MODEL', group: 'Posters', label: 'Spelling-check model', def: 'google/gemini-2.5-flash' },
  { key: 'PEXELS_API_KEY', group: 'Posters', label: 'Pexels API key (stock photos)', secret: true, help: 'Optional. pexels.com/api' },
  { key: 'FAL_KEY', group: 'Video', label: 'fal.ai API key', secret: true, help: 'Animated hero clip in post videos, about $0.15 per video. fal.ai/dashboard/keys' },
  { key: 'VIDEO_HERO_MODEL', group: 'Video', label: 'Image-to-video model (fal.ai)', def: 'fal-ai/wan/v2.2-5b/image-to-video' },
  { key: 'AI_VOICE_MODEL', group: 'Video', label: 'OpenAI voice model (via OpenRouter)', def: 'openai/gpt-audio-mini' },
  { key: 'AI_MUSIC_MODEL', group: 'Video', label: 'Music model (via OpenRouter)', def: 'google/lyria-3-clip-preview' },
  { key: 'WEB_READER_URL', group: 'AI', label: 'Reader for JavaScript-only websites', def: 'https://r.jina.ai/', help: 'Used only when a website returns almost no text to a plain fetch. Type "off" to disable.' },
  { key: 'LINKEDIN_CLIENT_ID', group: 'LinkedIn', label: 'Client ID', help: 'linkedin.com/developers → your app → Auth' },
  { key: 'LINKEDIN_CLIENT_SECRET', group: 'LinkedIn', label: 'Client secret', secret: true },
  { key: 'META_APP_ID', group: 'Facebook & Instagram', label: 'Meta app ID', help: 'developers.facebook.com → your app → Settings → Basic' },
  { key: 'META_APP_SECRET', group: 'Facebook & Instagram', label: 'Meta app secret', secret: true },
  { key: 'X_CLIENT_ID', group: 'X', label: 'OAuth 2.0 client ID', help: 'developer.x.com → your app → Keys and tokens' },
  { key: 'X_CLIENT_SECRET', group: 'X', label: 'OAuth 2.0 client secret', secret: true },
];
const BY_KEY = Object.fromEntries(KEYS.map((k) => [k.key, k]));
const ENV_AT_BOOT = Object.fromEntries(KEYS.map((k) => [k.key, process.env[k.key] || '']));
const fromDb = new Map();   // key -> { value, updatedAt }

const schema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: String, required: true },                       // v1:<iv>:<tag>:<ciphertext>, base64
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
const AppSetting = mongoose.models.AppSetting || mongoose.model('AppSetting', schema);

// ---- encryption (key derived from JWT_SECRET, which must stay stable) ----
const cryptoKey = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'dev-secret'}:app-settings:v1`).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---- read ----
// Fallback uses the environment as it was at boot (not the live process.env, which apply() overwrites) so
// clearing a key in the admin panel really falls back instead of keeping the old value alive.
function get(key) {
  if (fromDb.has(key)) return fromDb.get(key).value;
  if (BY_KEY[key]) return ENV_AT_BOOT[key] || BY_KEY[key].def || '';
  return process.env[key] || '';
}
const apply = (key) => { const v = get(key); if (v) process.env[key] = v; else delete process.env[key]; };

// ---- startup: seed missing keys from the environment, then load everything ----
async function init() {
  const docs = await AppSetting.find({});
  const have = new Set(docs.map((d) => d.key));
  for (const k of KEYS) {
    if (!have.has(k.key) && ENV_AT_BOOT[k.key]) {
      await AppSetting.create({ key: k.key, value: encrypt(ENV_AT_BOOT[k.key]) });
      console.log(`settings: seeded ${k.key} from environment`);
    }
  }
  await reload();
}
async function reload() {
  fromDb.clear();
  for (const d of await AppSetting.find({})) {
    try { fromDb.set(d.key, { value: decrypt(d.value), updatedAt: d.updatedAt }); }
    catch (e) { console.error(`settings: cannot decrypt ${d.key} (JWT_SECRET changed?)`); }
  }
  for (const k of KEYS) apply(k.key);
}

// ---- admin ----
const mask = (v) => (v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`);
function list() {
  return KEYS.map((k) => {
    const v = get(k.key);
    const source = fromDb.has(k.key) ? 'database' : ENV_AT_BOOT[k.key] ? 'environment' : k.def ? 'default' : 'not set';
    return { ...k, set: !!v, source, value: k.secret ? (v ? mask(v) : '') : v, updatedAt: fromDb.get(k.key)?.updatedAt || null };
  });
}
async function set(values, userId) {
  const changed = [];
  for (const [key, raw] of Object.entries(values || {})) {
    if (!BY_KEY[key]) continue;
    const value = String(raw ?? '').trim();
    if (value === '') { await AppSetting.deleteOne({ key }); fromDb.delete(key); }
    else {
      await AppSetting.findOneAndUpdate({ key }, { value: encrypt(value), updatedBy: userId }, { upsert: true, new: true, setDefaultsOnInsert: true });
      fromDb.set(key, { value, updatedAt: new Date() });
    }
    apply(key); changed.push(key);
  }
  return changed;
}

// Live checks so an admin knows a key works before relying on it
async function test(key) {
  const axios = require('axios');
  const v = get(key);
  if (!v) return { ok: false, message: 'Not set' };
  try {
    if (key === 'OPENROUTER_API_KEY') {
      const r = await axios.get('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${v}` }, timeout: 15000 });
      const d = r.data?.data || {};
      const left = d.limit_remaining ?? (d.limit != null ? d.limit - d.usage : null);
      return { ok: true, message: `Valid. Used $${Number(d.usage || 0).toFixed(2)}${left != null ? `, $${Number(left).toFixed(2)} left` : ' (no limit set)'}` };
    }
    if (key === 'FAL_KEY') {
      const r = await axios.get('https://api.fal.ai/v1/models?limit=1', { headers: { Authorization: `Key ${v}` }, timeout: 15000, validateStatus: () => true });
      return r.status < 400 ? { ok: true, message: 'Valid' } : { ok: false, message: `Rejected (${r.status})` };
    }
    if (key === 'PEXELS_API_KEY') {
      const r = await axios.get('https://api.pexels.com/v1/search?query=office&per_page=1', { headers: { Authorization: v }, timeout: 15000, validateStatus: () => true });
      return r.status < 400 ? { ok: true, message: 'Valid' } : { ok: false, message: `Rejected (${r.status})` };
    }
    if (key === 'LINKEDIN_CLIENT_ID') {
      // LinkedIn answers a bad client or callback with a 200 error page, and a good pair with a 303 to its sign-in page
      const cb = `${(process.env.BACKEND_URL || '').replace(/\/$/, '')}/api/linkedin/callback`;
      const r = await axios.get(`https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(v)}&redirect_uri=${encodeURIComponent(cb)}&scope=openid&state=check`, { maxRedirects: 0, timeout: 15000, validateStatus: () => true, responseType: 'text' });
      const body = String(r.data || '');
      if (/redirect_uri does not match/i.test(body)) return { ok: false, message: `Client ID is valid, but the LinkedIn app does not list this callback URL yet: ${cb}` };
      if (/invalid.{0,20}client|client.{0,20}(not found|invalid)|unauthorized_client/i.test(body + (r.headers.location || ''))) return { ok: false, message: 'LinkedIn does not recognise this client ID' };
      if ((r.status >= 300 && r.status < 400) || /<title>\s*(Authorize|Sign In|LinkedIn Login)/i.test(body)) return { ok: true, message: 'Client ID and callback URL accepted by LinkedIn' };
      return { ok: false, message: `Unexpected LinkedIn response (${r.status})` };
    }
    return { ok: true, message: 'Saved (no live check for this key)' };
  } catch (e) { return { ok: false, message: e.response?.data?.error?.message || e.message }; }
}

module.exports = { KEYS, init, reload, get, list, set, test };
