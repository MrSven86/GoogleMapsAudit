// Vercel Serverless Function: POST /api/gbp-start
// NEW STRATEGY: keyword-rank.
//
// Old approach (broken): searched Maps once per business name, missed cases
// where YP name and Google name differed (e.g. "Cline's Air Conditioning Service"
// on YP vs "Cline's Heating and Air" on Google → never returned, marked as no-GBP
// when the business actually has 263 reviews and ranks #1).
//
// New approach: ONE Maps search for keyword + city, get top 100 ranking
// businesses. Then in /api/gbp-results, match each input business against
// those 100 by phone/website/strong-name. This gives us:
//   - Whether the business has a GBP at all
//   - WHERE they rank for their primary keyword (the actual SEO question)
// Both signals from a single Apify run.

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
  if (!keyword) {
    return json(res, 400, {
      error: 'Missing keyword. New keyword-rank architecture requires keyword (the industry/category that was used in the YP scrape, e.g. "hvac" or "roofing").',
    });
  }

  const locationQuery = state ? `${city}, ${state}` : city;

  // ONE search, top 100 places. Cost: ~$0.70 per scan (vs many $ before).
  // 100 is enough depth — if a business doesn't crack top 100 for its primary
  // keyword in its own city, it's effectively invisible.
  const input = {
    searchStringsArray: [keyword],
    locationQuery,
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
      locationQuery,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
