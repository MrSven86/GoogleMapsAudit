// Vercel Serverless Function: POST /api/gbp-start
// Starts an Apify Google Maps run for a batch of business names.
// Returns runId immediately; client polls /api/scrape-status, then /api/gbp-results.

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
  const businesses = Array.isArray(body.businesses) ? body.businesses : [];

  // Async architecture has no Vercel timeout pressure — allow much larger batches.
  // 100 search-strings is comfortable for the Maps actor (~3-8 minutes).
  const maxBatch = Math.min(100, Math.max(1, Number(body.maxBatch || 100)));

  if (!token) return json(res, 400, { error: 'Missing Apify token' });
  if (!city) return json(res, 400, { error: 'Missing city' });
  if (!businesses.length) return json(res, 400, { error: 'No businesses provided' });
  if (businesses.length > maxBatch) {
    return json(res, 400, { error: `Too many businesses (max ${maxBatch}). Split into batches.` });
  }

  const locationQuery = state ? `${city}, ${state}` : city;
  // CRITICAL FIX: search by NAME ONLY, let locationQuery do geo-filtering.
  // Previous "Vista Window Cleaning Spokane, WA" was being treated as one
  // long literal string by Maps, often returning unrelated results.
  // Just "Vista Window Cleaning" + locationQuery="Spokane, WA" is what
  // a real user would do in Google Maps.
  const searchStrings = businesses.map(b => String(b.name).trim());

  const input = {
    searchStringsArray: searchStrings,
    locationQuery,
    // CRITICAL FIX: was 3, now 15. Maps often returns the right business
    // at position #5-#10, especially for businesses with common names or
    // many lookalikes ("LeafFilter Gutter Protection" appears as multiple
    // franchise locations — we need to see all of them to find the right one).
    maxCrawledPlacesPerSearch: 15,
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
      // Echo input back so client can correlate businesses to results
      searchedFor: businesses.length,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
