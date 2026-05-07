// Vercel Serverless Function: POST /api/gbp-start
// STRATEGY: keyword-rank.
// ONE Maps search for keyword in city, get top 100 ranking businesses.

const APIFY_BASE = 'https://api.apify.com/v2';
const MAPS_ACTOR = 'compass~crawler-google-places';

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
  const city = String(body.city || '').trim();
  const state = String(body.state || body.region || '').trim();
  const language = String(body.language || 'en').trim();
  const keyword = String(body.keyword || '').trim();

  if (!token) return json(res, 400, { error: 'Missing Apify token' });
  if (!city) return json(res, 400, { error: 'Missing city' });
  if (!keyword) return json(res, 400, { error: 'Missing keyword' });

  const locationQuery = state ? `${city}, ${state}` : city;

  // CRITICAL: combine keyword + location into ONE search phrase, like a real
  // Google Maps user types. The actor's behavior with short generic keywords
  // (e.g. "hvac") + separate locationQuery is unreliable — sometimes returns
  // 1-5 results instead of 100. Combined phrase is robust.
  const combinedSearch = `${keyword} ${locationQuery}`;

  const input = {
    searchStringsArray: [combinedSearch],
    locationQuery,                       // kept as secondary geo signal
    maxCrawledPlacesPerSearch: 100,
    language,
    maxReviews: 0,
    maxImages: 0,
    scrapeReviewerInfo: false,
    scrapeContacts: false,
    scrapeDirections: false,
    additionalInfo: false,
    exportPlaceUrls: true,
  };

  const url = `${APIFY_BASE}/acts/${MAPS_ACTOR}/runs?token=${encodeURIComponent(token)}`;
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
      runId: run.id,
      status: run.status,
      startedAt: run.startedAt,
      actor: MAPS_ACTOR,
      strategy: 'keyword-rank',
      keyword,
      combinedSearch,
      locationQuery,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
