// Vercel Serverless Function: POST /api/lead-finder-start
// Starts an Apify run for one of three actors used by Mass Lead Finder:
//   - gmaps: compass/crawler-google-places (finds businesses)
//   - contact: vdrmota/contact-info-scraper (extracts emails from websites)
//   - facebook: apify/facebook-pages-scraper (extracts emails from FB About)
//
// Polling reuses /api/scrape-status. Dataset fetching is done client-side via /api/proxy.

const APIFY_BASE = 'https://api.apify.com/v2';

const ACTORS = {
  gmaps: {
    actor: 'compass~crawler-google-places',
    buildInput: ({ keyword, city, state, maxResults }) => ({
      searchStringsArray: [keyword],
      locationQuery: state ? `${city}, ${state}, United States` : `${city}, United States`,
      maxCrawledPlacesPerSearch: maxResults,
      language: 'en',
      countryCode: 'us',
      scrapeContacts: true,
      // We don't need reviews/images — keeps cost/time down
      maxReviews: 0,
      maxImages: 0,
      exportPlaceUrls: false,
    }),
  },
  contact: {
    actor: 'vdrmota~contact-info-scraper',
    buildInput: ({ startUrls, maxDepth = 2 }) => ({
      startUrls: startUrls.map(url => ({ url })),
      maxDepth,
      maxRequestsPerStartUrl: 5,
      sameDomain: true,
      considerChildFrames: true,
      proxyConfig: { useApifyProxy: true },
    }),
  },
  facebook: {
    actor: 'apify~facebook-pages-scraper',
    buildInput: ({ startUrls }) => ({
      startUrls: startUrls.map(url => ({ url })),
      resultsLimit: 1,
    }),
  },
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const token = String(body.apifyToken || '').trim();
  const actorKey = String(body.actor || '').trim().toLowerCase();
  if (!token) return json(res, 400, { error: 'Missing Apify token' });

  const config = ACTORS[actorKey];
  if (!config) {
    return json(res, 400, {
      error: `Unknown actor: ${actorKey}. Use one of: ${Object.keys(ACTORS).join(', ')}`
    });
  }

  // Build input per actor
  let input;
  try {
    if (actorKey === 'gmaps') {
      const keyword = String(body.keyword || '').trim();
      const city = String(body.city || '').trim();
      const state = String(body.state || '').trim();
      const maxResults = Math.min(500, Math.max(10, Number(body.maxResults || 100)));
      if (!keyword) return json(res, 400, { error: 'Missing keyword' });
      if (!city) return json(res, 400, { error: 'Missing city' });
      input = config.buildInput({ keyword, city, state, maxResults });
    } else if (actorKey === 'contact' || actorKey === 'facebook') {
      const startUrls = Array.isArray(body.startUrls) ? body.startUrls : [];
      if (startUrls.length === 0) return json(res, 400, { error: 'Missing startUrls' });
      input = config.buildInput({ startUrls });
    }
  } catch (e) {
    return json(res, 400, { error: `Input build failed: ${e.message}` });
  }

  const url = `${APIFY_BASE}/acts/${config.actor}/runs?token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || JSON.stringify(j); }
      catch { detail = await r.text().catch(() => ''); }
      return json(res, r.status, { error: `Apify HTTP ${r.status}: ${detail.slice(0, 300)}` });
    }
    const data = await r.json();
    const run = data?.data;
    if (!run?.id) return json(res, 502, { error: 'Apify did not return a run ID' });

    return json(res, 200, {
      ok: true,
      actor: actorKey,
      runId: run.id,
      status: run.status,
      startedAt: run.startedAt,
      actorId: config.actor,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
