const BASE = 'https://api.apify.com/v2';
const ACTOR = 'apify~google-search-scraper';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, url, keyword, city, mode } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing Apify token' });
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

    const query = city ? `${keyword} ${city}` : keyword;

    const serp = await getGoogleTop(token, query);
    const competitors = serp.slice(0, 3);

    const competitorAudits = [];
    for (const c of competitors) {
      const audit = await auditUrl(c.url, keyword, city).catch(() => null);
      if (audit) competitorAudits.push({ ...c, audit });
    }

    // 🔥 MODE SWITCH
    if (mode === 'new') {
      const blueprint = buildBlueprint(competitorAudits, keyword, city);
      return res.status(200).json({
        mode: 'new',
        query,
        blueprint
      });
    }

    if (mode === 'compare') {
      if (!url) return res.status(400).json({ error: 'Missing URL for compare mode' });

      const youAudit = await auditUrl(url, keyword, city);
      const patch = buildSeoPatch(youAudit, competitorAudits, keyword, city);

      return res.status(200).json({
        mode: 'compare',
        query,
        patch
      });
    }

    return res.status(400).json({ error: 'Invalid mode' });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audit failed' });
  }
}

// ----------------------
// GOOGLE SCRAPER
// ----------------------

async function getGoogleTop(token, query) {
  const input = {
    queries: query,
    resultsPerPage: 10,
    maxPagesPerQuery: 1
  };

  const runRes = await fetch(`${BASE}/acts/${ACTOR}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });

  const run = (await runRes.json()).data;

  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const r = await fetch(`${BASE}/actor-runs/${run.id}?token=${token}`);
    const d = (await r.json()).data;
    if (d.status === 'SUCCEEDED') break;
  }

  const itemsRes = await fetch(`${BASE}/datasets/${run.defaultDatasetId}/items?token=${token}`);
  const items = await itemsRes.json();

  const results = [];
  for (const page of items) {
    const arr = page.organicResults || [];
    for (const r of arr) {
      if (!r.url) continue;
      results.push({
        title: r.title,
        url: r.url
      });
    }
  }

  return results;
}

// ----------------------
// AUDIT
// ----------------------

async function auditUrl(url, keyword, city) {
  const html = await fetchHtml(url);
  const text = stripHtml(html);

  const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = matchOne(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  return {
    url,
    title: clean(title),
    h1: clean(h1),
    wordCount: text.split(/\s+/).length,
    hasSchema: /ld\+json/.test(html),
    hasPhone: /\d{3}[-.\s]?\d{3}/.test(text),
    hasH1: !!h1
  };
}

// ----------------------
// MODE 1: NEW PAGE
// ----------------------

function buildBlueprint(comps, keyword, city) {
  return {
    title: `${keyword} ${city} | Free Estimate`,
    h1: `${keyword} in ${city}`,
    sections: [
      "Hero (keyword + city + CTA)",
      "Services",
      "Reviews",
      "Process",
      "FAQ",
      "Contact"
    ],
    keywords: extractKeywords(comps),
    note: "Use this as Claude content brief"
  };
}

// ----------------------
// MODE 2: PATCH
// ----------------------

function buildSeoPatch(you, comps, keyword, city) {
  const patch = [];

  if (!you.hasH1) {
    patch.push(`Add H1: "${keyword} in ${city}"`);
  }

  if (!you.hasSchema) {
    patch.push(`Add LocalBusiness schema JSON-LD`);
  }

  if (!you.hasPhone) {
    patch.push(`Add phone number with tel: link`);
  }

  return patch;
}

// ----------------------
// HELPERS
// ----------------------

async function fetchHtml(url) {
  const r = await fetch(url);
  return await r.text();
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ');
}

function matchOne(str, re) {
  const m = str.match(re);
  return m ? m[1] : '';
}

function clean(s) {
  return (s || '').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractKeywords(comps) {
  return ["painter near me", "local painter", "house painting"];
}
