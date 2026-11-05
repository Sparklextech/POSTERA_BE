const axios = require('axios');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Replicate DeepAI's tryit key generation from their client-side JS
function generateTryItApiKey() {
  const myrandomstr = Math.round(Math.random() * 100000000000) + '';

  // Their exact custom MD5 implementation (minified from source) with reversed output
  function myhashfunction(c) {
    var a = [], b;
    for (b = 0; 64 > b;) a[b] = 0 | 4294967296 * Math.sin(++b % Math.PI);
    var d, e, f, g = [d = 1732584193, e = 4023233417, ~d, ~e], h = [], l;
    var input = unescape(encodeURI(c)) + '\u0080', k = input.length;
    c = --k / 4 + 2 | 15;
    for (h[--c] = 8 * k; ~k;) h[k >> 2] |= input.charCodeAt(k) << 8 * k--;
    for (b = l = 0; b < c; b += 16) {
      for (k = g; 64 > l; k = [f = k[3], d + ((f = k[0] + [d & e | ~d & f, f & d | ~f & e, d ^ e ^ f, e ^ (d | ~f)][k = l >> 4] + a[l] + ~~h[b | [l, 5 * l + 1, 3 * l + 5, 7 * l][k] & 15]) << (k = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21][4 * k + l++ % 4]) | f >>> -k), d, e])
        d = k[1] | 0, e = k[2];
      for (l = 4; l;) g[--l] += k[l];
    }
    for (c = ''; 32 > l;) c += (g[l >> 3] >> 4 * (1 ^ l++) & 15).toString(16);
    return c.split('').reverse().join('');
  }

  const key = 'tryit-' + myrandomstr + '-' + myhashfunction(
    UA + myhashfunction(
      UA + myhashfunction(
        UA + myrandomstr + 'hackers_become_a_little_stinkier_every_time_they_hack'
      )
    )
  );

  return key;
}

// Generate image using DeepAI's free text2img
async function generateDeepAIImage(prompt) {
  const apiKey = generateTryItApiKey();

  try {
    console.log('DeepAI: Generating image with tryit key...');

    const FormData = require('form-data');
    const form = new FormData();
    form.append('text', prompt);
    form.append('width', '640');
    form.append('height', '640');
    form.append('image_generator_version', 'hd');
    form.append('use_new_model', 'true');
    form.append('use_old_model', 'false');
    form.append('quality', 'true');
    form.append('generation_source', 'img');

    const res = await axios.post('https://api.deepai.org/api/text2img', form, {
      headers: {
        ...form.getHeaders(),
        'api-key': apiKey,
        'Origin': 'https://deepai.org',
        'Referer': 'https://deepai.org/machine-learning-model/text2img',
        'User-Agent': UA,
      },
      timeout: 30000,
    });

    const outputUrl = res.data?.output_url || res.data?.share_url;
    if (outputUrl) {
      console.log('DeepAI: Image URL:', outputUrl);
      // Download the image
      const imgRes = await axios.get(outputUrl, { responseType: 'arraybuffer', timeout: 20000 });
      return Buffer.from(imgRes.data);
    }

    console.log('DeepAI: No output URL in response:', JSON.stringify(res.data).substring(0, 200));
    return null;
  } catch (e) {
    console.error('DeepAI failed:', e.response?.data || e.message);
    return null;
  }
}

module.exports = { generateDeepAIImage, generateTryItApiKey };
