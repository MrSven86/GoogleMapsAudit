// Vercel Serverless Function: POST /api/scrape-start
// THIS IS FOR DIRECTORY SCRAPING (BBB / Yelp / Yellow Pages).
// Do NOT confuse with /api/gbp-start which is for Google Maps lookups.

const APIFY_BASE = 'https://api.apify.com/v2';

const SOURCES = {
  bbb: {
    actor: 'crawlerbros~bbb-scraper',
    buildInput: ({ keyword, city, state, maxResults }) => ({
      keywords: keyword,
      maxRecordsGlobal: maxResults,
      minRating: 'any',
      accreditedOnly: false,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'US',
      },
      locations: state ? [`${city}, ${state}`] : [city],
      maxRecordsPerLocation: maxResults,
    }),
  },
  yelp: {
    // axlymxp/yelp-scraper — uses Yelp's official API, not HTML scraping.
    // Schema: term (singular) + location (singular).
    actor: 'axlymxp~yelp-scraper',
    buildInput: ({ keyword, city, state, maxResults }) => ({
      term: keyword,
      location: state ? `${city}, ${state}` : city,
      maxResults,
    }),
  },
  yellowpages: {
    actor: 'trudax~yellow-pages-us-scraper',
    buildInput: ({ keyword, city, state, maxResults }) => ({
      search: keyword,
      location: state ? `${city}, ${state}` : city,
      maxItems: maxResults,
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
  const source = String(body.source || '').trim().toLowerCase();
  const keyword = String(body.keyword || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || body.region || '').trim();
  const maxResults = Math.min(500, Math.max(10, Number(body.maxResults || 100)));

  if (!token) return json(res, 400, { error: 'Missing Apify token' });
  if (!keyword) return json(res, 400, { error: 'Missing keyword' });
  if (!city) return json(res, 400, { error: 'Missing city' });

  const config = SOURCES[source];
  if (!config) return json(res, 400, { error: `Unknown source: ${source}. Use bbb, yelp, or yellowpages.` });

  const input = config.buildInput({ keyword, city, state, maxResults });

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
      source,
      runId: run.id,
      status: run.status,
      startedAt: run.startedAt,
      actor: config.actor,
      inputSent: input,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
