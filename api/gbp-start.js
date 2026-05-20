// Vercel Serverless Function: POST /api/gbp-start
// THIS IS FOR GOOGLE MAPS LOOKUPS, NOT directory scraping.
// Do NOT confuse with /api/scrape-start which is for BBB/Yelp/YP.
//
// Triggered when user clicks "Check GBP for selected" in the UI.
// Starts a Google Maps Apify run searching for each input business by name.
// Returns runId immediately; client polls /api/scrape-status, then calls
// /api/gbp-results to fetch + match the dataset.
//
// STRATEGY: One targeted search per business. Query format:
//   "{business name} {city} {state}"
// This forces Google Maps to return the SPECIFIC business, not popular-
// places fallback. No locationQuery — that triggers fallback behavior
// where Apify returns generic nearby businesses (CVS, Costco, etc.) when
// it can't find an exact match.

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
  const maxBatch = Math.min(100, Math.max(1, Number(body.maxBatch || 100)));

  if (!token) return json(res, 400, { error: 'Missing Apify token' });
  if (!city) return json(res, 400, { error: 'Missing city' });
  if (!businesses.length) return json(res, 400, { error: 'No businesses provided' });
  if (businesses.length > maxBatch) {
    return json(res, 400, { error: `Too many businesses (max ${maxBatch}). Split into batches.` });
  }

  // Build one targeted query per business: "{name} {city} {state}".
  // Apify treats each string as a separate Maps search. Google's own
  // ranking returns the matching business as #1 result in almost every case.
  const geoSuffix = state ? `${city} ${state}` : city;
  const searchStrings = businesses
    .map(b => String(b.name || '').trim())
    .filter(Boolean)
    .map(name => `${name} ${geoSuffix}`.trim());

  if (!searchStrings.length) {
    return json(res, 400, { error: 'No valid business names to search' });
  }

  const input = {
    searchStringsArray: searchStrings,
    // NO locationQuery — it triggers the fallback-to-popular-places
    // behavior that returns CVS, Costco, Wingstop, etc. when Apify
    // can't find an exact match. The geo terms in the search string
    // itself give us location targeting without that fallback.
    maxCrawledPlacesPerSearch: 3, // Top 3 is plenty — we only need #1 in most cases
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
      strategy: 'per-business-name-with-geo',
      searchedFor: searchStrings.length,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
