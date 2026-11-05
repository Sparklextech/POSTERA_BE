// Offline self-checks for the logic that is easy to break: `npm test`.
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'selfcheck';

// publishing: transient vs permanent errors
const { isTransient } = require('../services/schedulerService');
assert.strictEqual(isTransient({ code: 'ECONNRESET' }), true, 'network reset retries');
assert.strictEqual(isTransient({ response: { status: 503 } }), true, '5xx retries');
assert.strictEqual(isTransient({ response: { status: 429 } }), true, 'rate limit retries');
assert.strictEqual(isTransient({ response: { status: 401 } }), false, 'auth errors do not retry');
assert.strictEqual(isTransient({ response: { status: 400 } }), false, 'bad requests do not retry');
assert.strictEqual(isTransient(new Error('Instagram needs a poster')), false, 'our own validation errors do not retry');
assert.strictEqual(isTransient({ isAxiosError: true, request: {}, code: 'ERR_BAD_RESPONSE' }), true, 'no response from the platform retries');

// OAuth state: allowlisted redirect origins only
process.env.FRONTEND_URL = 'https://app.example.com'; process.env.BACKEND_URL = 'https://app.example.com'; process.env.NODE_ENV = 'production';
const { safeOrigin } = require('../services/oauthState');
assert.strictEqual(safeOrigin('https://app.example.com/settings'), 'https://app.example.com');
assert.strictEqual(safeOrigin('https://evil.example.net'), 'https://app.example.com', 'foreign origins fall back');
assert.strictEqual(safeOrigin('javascript:alert(1)'), 'https://app.example.com');

// AI JSON parsing tolerates fences and prose
const { parseJSON } = require('../services/aiService');
assert.deepStrictEqual(parseJSON('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
assert.deepStrictEqual(parseJSON('Here you go: {"ok":true} thanks'), { ok: true });

// settings: encryption round trip and defaults
const settings = require('../services/settingsService');
assert.ok(settings.get('AI_TEXT_MODEL').includes('/'), 'model default present');
assert.ok(settings.KEYS.every((k) => k.key && k.group && k.label), 'every key documented');
process.env.AI_TEXT_MODEL = 'stale/value-from-an-old-db-overlay';
assert.notStrictEqual(settings.get('AI_TEXT_MODEL'), 'stale/value-from-an-old-db-overlay', 'cleared keys fall back to boot env/default, not the live overlay');

// video: voice-over cap keeps whole sentences
const { capWords } = require('../services/videoService');
const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} has six words.`).join(' ');
const capped = capWords(long, 55);
assert.ok(capped.split(/\s+/).length <= 55 && /\.$/.test(capped), 'cap ends on a sentence');

console.log('selfcheck OK');
