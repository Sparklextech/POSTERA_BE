const axios = require('axios');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function extractAll(html) {
  let match;
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';

  // Meta
  const getMeta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]*(?:name|property)=["'](?:og:)?${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:)?${name}["']`, 'i'));
    return m ? m[1].trim() : '';
  };

  const description = getMeta('description');
  const ogTitle = getMeta('title');
  const ogImage = getMeta('image');

  // Headings
  const headings = [];
  const hRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  while ((match = hRegex.exec(clean)) !== null) {
    const h = stripTags(match[1]);
    if (h.length > 2 && h.length < 300 && !headings.includes(h)) headings.push(h);
  }

  // Paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(clean)) !== null) {
    const p = stripTags(match[1]);
    if (p.length > 20 && !paragraphs.includes(p)) paragraphs.push(p);
  }

  // List items
  const listItems = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((match = liRegex.exec(clean)) !== null) {
    const li = stripTags(match[1]);
    if (li.length > 5 && li.length < 300 && !listItems.includes(li)) listItems.push(li);
  }

  // Links with text (navigation = services/pages)
  const links = [];
  const aRegex = /<a[^>]*href=["']([^"'#]*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = aRegex.exec(clean)) !== null) {
    const text = stripTags(match[2]);
    if (text.length > 2 && text.length < 100) links.push({ href: match[1], text });
  }

  // Contact info (emails, phones)
  const emails = [...new Set((html.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi) || []).filter(e => !e.includes('example') && !e.includes('sentry')))];
  const phones = [...new Set((html.match(/(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g) || []).filter(p => p.replace(/\D/g, '').length >= 10))];

  // Addresses
  const addresses = [];
  const addrRegex = /<address[^>]*>([\s\S]*?)<\/address>/gi;
  while ((match = addrRegex.exec(html)) !== null) addresses.push(stripTags(match[1]));

  // Social links
  const socials = [];
  const socialPatterns = ['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'github.com'];
  const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (socialPatterns.some(s => match[1].includes(s))) socials.push(match[1]);
  }

  // Logo candidates: <img> with logo in src/alt/class, apple-touch-icon, og:image as last resort
  const logos = [];
  const imgRe = /<img[^>]*>/gi;
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0];
    const src = (tag.match(/\s(?:src|data-src)=["']([^"']+)["']/i) || [])[1];
    if (src && /logo|brand/i.test(tag) && !/\.svg\?|sprite/i.test(src)) logos.push(src);
  }
  const touch = (html.match(/<link[^>]*rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/i) || [])[1];
  if (touch) logos.push(touch);

  // JSON-LD
  const jsonLd = [];
  const ldRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = ldRegex.exec(html)) !== null) {
    try { jsonLd.push(JSON.parse(match[1])); } catch (e) { /* skip */ }
  }

  // All visible text
  const allText = stripTags(clean);

  return {
    title: ogTitle || title,
    description,
    ogImage,
    headings: headings.slice(0, 40),
    paragraphs: paragraphs.slice(0, 40),
    listItems: listItems.slice(0, 30),
    links: links.slice(0, 50),
    emails,
    phones,
    addresses,
    socials: [...new Set(socials)],
    jsonLd,
    logos,
    allText: allText.substring(0, 5000),
  };
}

async function fetchPage(url) {
  return axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    maxRedirects: 5,
  });
}

async function scrapeWebsite(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const baseUrl = url.replace(/\/$/, '');

    // Scrape main page
    console.log('Scraping:', url);
    const mainPage = await fetchPage(url);
    const main = extractAll(mainPage.data);

    // Auto-discover and scrape important subpages
    const importantPaths = ['/about', '/services', '/solutions', '/products', '/features', '/contact', '/team', '/pricing', '/industries', '/portfolio', '/case-studies', '/about-us', '/our-services', '/what-we-do'];

    // Also find subpages from nav links
    const discoveredPaths = main.links
      .map(l => l.href)
      .filter(h => h.startsWith('/') && h.length > 1 && h.length < 50 && !h.includes('#') && !h.includes('?') && !h.match(/\.(jpg|png|css|js|pdf|svg)/i))
      .slice(0, 10);

    const allPaths = [...new Set([...importantPaths, ...discoveredPaths])];
    console.log(`Found ${allPaths.length} subpages to check`);

    // Scrape subpages in parallel (max 5 at a time)
    const subResults = await Promise.allSettled(
      allPaths.slice(0, 8).map(async (p) => {
        try {
          const subUrl = p.startsWith('http') ? p : baseUrl + p;
          const res = await fetchPage(subUrl);
          return { path: p, data: extractAll(res.data) };
        } catch (e) { return null; }
      })
    );

    // Merge all content
    for (const r of subResults) {
      if (r.status === 'fulfilled' && r.value) {
        const sub = r.value.data;
        main.headings.push(...sub.headings);
        main.paragraphs.push(...sub.paragraphs);
        main.listItems.push(...sub.listItems);
        if (sub.emails.length) main.emails.push(...sub.emails);
        if (sub.phones.length) main.phones.push(...sub.phones);
        if (sub.addresses.length) main.addresses.push(...sub.addresses);
      }
    }

    // Deduplicate
    main.headings = [...new Set(main.headings)].slice(0, 50);
    main.paragraphs = [...new Set(main.paragraphs)].slice(0, 50);
    main.listItems = [...new Set(main.listItems)].slice(0, 40);
    main.emails = [...new Set(main.emails)];
    main.phones = [...new Set(main.phones)];

    // Build raw content
    const rawParts = [];
    if (main.title) rawParts.push(`Company: ${main.title}`);
    if (main.description) rawParts.push(`About: ${main.description}`);
    if (main.emails.length) rawParts.push(`Email: ${main.emails.join(', ')}`);
    if (main.phones.length) rawParts.push(`Phone: ${main.phones.join(', ')}`);
    if (main.addresses.length) rawParts.push(`Address: ${main.addresses.join('; ')}`);
    if (main.socials.length) rawParts.push(`Socials: ${main.socials.join(', ')}`);
    if (main.headings.length) rawParts.push(`Topics:\n${main.headings.map(h => `- ${h}`).join('\n')}`);
    if (main.paragraphs.length) rawParts.push(`Content:\n${main.paragraphs.slice(0, 20).join('\n')}`);
    if (main.listItems.length) rawParts.push(`Points:\n${main.listItems.slice(0, 20).map(i => `- ${i}`).join('\n')}`);

    let rawContent = rawParts.join('\n\n').substring(0, 5000);

    // JavaScript-rendered sites return almost nothing to a plain fetch: ask the rendering reader instead
    let fullContent = rawContent;
    const visible = [...main.headings, ...main.paragraphs, ...main.listItems].join(' ').length;
    if (visible < 800) {
      const rendered = await readRendered(url);
      if (rendered.length > visible + 200) { fullContent = `Company: ${main.title || url}\n\n${rendered}`.substring(0, 8000); console.log(`Used rendering reader for ${url} (${rendered.length} chars)`); }
    }

    const logoUrl = (main.logos || []).map(l => { try { return new URL(l, baseUrl + '/').href; } catch { return null; } }).filter(Boolean)[0] || (main.ogImage ? (() => { try { return new URL(main.ogImage, baseUrl + '/').href; } catch { return ''; } })() : '');
    return {
      success: true,
      logoUrl,
      title: main.title || url,
      description: main.description,
      content: fullContent.substring(0, 6000),
      headings: main.headings,
      emails: main.emails,
      phones: main.phones,
      socials: main.socials,
      url,
    };
  } catch (error) {
    console.error('Scrape failed:', error.message);
    // Blocked or unreachable for a plain fetch? The rendering reader often still gets the page text.
    const rendered = await readRendered(url);
    if (rendered.length > 300) {
      return { success: true, logoUrl: '', title: url.replace(/https?:\/\//, '').replace(/\/$/, ''), description: '', content: rendered.substring(0, 8000), headings: [], emails: [], phones: [], socials: [], url };
    }
    // Never substitute an AI-"researched" profile: invented facts end up in published posts.
    return { success: false, error: error.message, content: '', url };
  }
}

// Text of a page after JavaScript runs, via a reader service (default r.jina.ai). Set WEB_READER_URL to "off" to disable.
async function readRendered(url) {
  const { get } = require('./settingsService');
  const reader = get('WEB_READER_URL');
  if (!reader || reader === 'off') return '';
  try {
    const r = await axios.get(`${reader.replace(/\/?$/, '/')}${url}`, { timeout: 45000, headers: { 'X-Return-Format': 'text', Accept: 'text/plain' }, responseType: 'text' });
    return String(r.data || '')
      .split('\n').map((l) => l.trim())
      .filter((l) => l.length > 2 && !/^(we value your privacy|we use cookies|customi[sz]e|reject all|accept all|cookie)/i.test(l))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) { console.error('Rendering reader failed:', e.message); return ''; }
}

module.exports = { scrapeWebsite };
