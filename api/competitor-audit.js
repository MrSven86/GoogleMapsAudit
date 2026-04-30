const BASE = 'https://api.apify.com/v2';
const ACTOR = 'apify~google-search-scraper';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, url, keyword, city, googleDomain, language } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing Apify token' });
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

    const query = city ? `${keyword} ${city}` : keyword;

    const serp = await getGoogleTop(token, query, googleDomain || 'google.se', language || 'sv');
    const competitors = serp.slice(0, 3);

    const youAudit = await auditUrl(url, keyword, city);

    const competitorAudits = [];
    for (const c of competitors) {
      const audit = await auditUrl(c.url, keyword, city).catch(() => null);
      if (audit) competitorAudits.push({ ...c, audit });
    }

    const recommendations = buildRecommendations(youAudit, competitorAudits, keyword, city);
    const score = scorePage(youAudit, competitorAudits);

    return res.status(200).json({
      query,
      score,
      you: { url, audit: youAudit },
      competitors: competitorAudits,
      recommendations
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audit failed' });
  }
}

async function getGoogleTop(token, query, googleDomain, language) {
  const input = {
    queries: query,
    resultsPerPage: 10,
    maxPagesPerQuery: 1,
    searchDomain: googleDomain,
    countryCode: 'se',
    languageCode: language,
    mobileResults: false,
    includeUnfilteredResults: false,
    saveHtml: false
  };

  const runRes = await fetch(`${BASE}/acts/${ACTOR}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });

  if (!runRes.ok) throw new Error('Could not start Google scraper');
  const run = (await runRes.json()).data;

  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/actor-runs/${run.id}?token=${token}`);
    const d = (await r.json()).data;
    if (d.status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(d.status)) throw new Error(`Google scrape ${d.status}`);
  }

  const itemsRes = await fetch(`${BASE}/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`);
  const items = await itemsRes.json();

  const organic = [];
  for (const page of items) {
    const arr = page.organicResults || page.results || [];
    for (const r of arr) {
      if (!r.url && !r.link) continue;
      if (isAd(r)) continue;
      organic.push({
        position: organic.length + 1,
        title: r.title || r.name || '(no title)',
        url: r.url || r.link,
        description: r.description || ''
      });
    }
  }

  return organic.slice(0, 3);
}

function isAd(r) {
  const text = [r.title, r.description, r.type, r.resultType].join(' ').toLowerCase();
  return r.isAd || r.ad || r.sponsored || text.includes('sponsored') || text.includes('annons') || text.includes('reklam');
}

async function auditUrl(url, keyword, city) {
  const html = await fetchHtml(url);
  const text = stripHtml(html);

  const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = getMeta(html, 'description');
  const h1 = matchOne(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map(m => clean(m[1]));

  const titleBlob = `${title} ${metaDescription} ${h1}`.toLowerCase();
  const keywordLower = String(keyword || '').toLowerCase();
  const cityLower = String(city || '').toLowerCase();

  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const imagesWithAlt = images.filter(m => /\salt=["'][^"']+["']/i.test(m[0])).length;

  return {
    url,
    title: clean(title),
    metaDescription: clean(metaDescription),
    h1: clean(h1),
    h2s,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    hasH1: !!clean(h1),
    keywordInImportantPlaces: keywordLower ? titleBlob.includes(keywordLower) : false,
    cityInImportantPlaces: cityLower ? titleBlob.includes(cityLower) : false,
    keywordCount: countOccurrences(text.toLowerCase(), keywordLower),
    cityCount: countOccurrences(text.toLowerCase(), cityLower),
    hasPhone: /(\+?\d[\d\s().-]{7,}\d)/.test(text),
    hasSchema: /application\/ld\+json|schema\.org/i.test(html),
    images: images.length,
    imagesWithAlt,
    internalLinks: countInternalLinks(html, url),
    externalLinks: countExternalLinks(html, url),
    hasCanonical: /rel=["']canonical["']/i.test(html),
    hasViewport: /name=["']viewport["']/i.test(html)
  };
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 SEO Audit Bot'
    },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`Could not crawl ${url}`);
  return await r.text();
}

function buildRecommendations(you, comps, keyword, city) {
  const recs = [];

  const avgWords = avg(comps.map(c => c.audit.wordCount));
  const topTitles = comps.map(c => c.audit.title).filter(Boolean);

  if (!you.keywordInImportantPlaces) {
    recs.push(`Your page does not clearly use "${keyword}" in title, meta description or H1. Add the main keyword to the title and H1.`);
  }

  if (city && !you.cityInImportantPlaces) {
    recs.push(`Competitors are locally relevant for "${city}". Add "${city}" to the title, H1, intro text and service sections.`);
  }

  if (you.wordCount < avgWords * 0.7) {
    recs.push(`Your page has ${you.wordCount} words. Top competitors average around ${Math.round(avgWords)} words. Add more useful content, FAQs, service explanations and local proof.`);
  }

  if (!you.hasSchema) {
    recs.push(`No schema markup found. Add LocalBusiness / Organization schema with name, address, phone, opening hours and URL.`);
  }

  if (!you.hasPhone) {
    recs.push(`No phone number detected. Add a visible phone number near the top and bottom of the page.`);
  }

  if (you.images > 0 && you.imagesWithAlt < you.images) {
    recs.push(`Some images are missing alt text. Add descriptive alt text using service + location where natural.`);
  }

  if (!you.hasH1) {
    recs.push(`No H1 detected. Add one clear H1 describing the service and location.`);
  }

  if (topTitles.length) {
    recs.push(`Competitor title examples: ${topTitles.slice(0,3).join(' | ')}. Use these as inspiration, but make yours more specific and conversion-focused.`);
  }

  if (!recs.length) {
    recs.push(`Your page is technically competitive. Next step is stronger content, internal links, reviews, local landing pages and backlinks.`);
  }

  return recs;
}

function scorePage(you, comps) {
  let score = 50;
  if (you.hasH1) score += 8;
  if (you.keywordInImportantPlaces) score += 12;
  if (you.cityInImportantPlaces) score += 10;
  if (you.hasPhone) score += 6;
  if (you.hasSchema) score += 8;
  if (you.hasCanonical) score += 3;
  if (you.hasViewport) score += 3;

  const avgWords = avg(comps.map(c => c.audit.wordCount));
  if (avgWords && you.wordCount >= avgWords * 0.8) score += 10;
  if (you.images && you.imagesWithAlt / you.images > 0.7) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getMeta(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
  return matchOne(html, re);
}

function matchOne(str, re) {
  const m = String(str || '').match(re);
  return m ? m[1] : '';
}

function clean(s) {
  return stripHtml(String(s || '')).replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return (text.match(new RegExp(escapeRegExp(needle), 'g')) || []).length;
}

function countInternalLinks(html, url) {
  const host = safeHost(url);
  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .filter(m => {
      const href = m[1];
      return href.startsWith('/') || href.includes(host);
    }).length;
}

function countExternalLinks(html, url) {
  const host = safeHost(url);
  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .filter(m => /^https?:\/\//i.test(m[1]) && !m[1].includes(host)).length;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function avg(arr) {
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (!nums.length) return 0;
  return nums.reduce((a,b) => a+b, 0) / nums.length;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
