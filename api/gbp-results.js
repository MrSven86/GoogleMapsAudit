// Vercel Serverless Function: POST /api/gbp-results
// Fetches Maps actor results from a completed Apify run, matches each input
// business against the returned profiles, returns merged result rows.
//
// Called by the client AFTER /api/scrape-status reports SUCCEEDED.
// POST so we can pass the original businesses array (for name matching).

const APIFY_BASE = 'https://api.apify.com/v2';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|ltd|co|company|corp|corporation|pllc|lp|llp|ab|gmbh|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.94;
  const wa = new Set(A.split(' ').filter(w => w.length > 2));
  const wb = new Set(B.split(' ').filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some(x => x.includes(w) || w.includes(x))) hits++;
  return hits / Math.max(wa.size, wb.size);
}

function categories(x) {
  const out = [];
  const add = v => {
    if (!v) return;
    if (typeof v === 'string') out.push(v.trim());
    else if (typeof v === 'object') out.push(String(v.name || v.title || v.categoryName || v.label || '').trim());
  };
  add(x.categoryName); add(x.category);
  if (Array.isArray(x.categories)) x.categories.forEach(add);
  if (Array.isArray(x.additionalCategories)) x.additionalCategories.forEach(add);
  return [...new Set(out.filter(Boolean))];
}

function mapsRow(x) {
  return {
    name: x.title || x.name || '',
    placeId: x.placeId || x.cid || '',
    rating: Number(x.totalScore || x.rating || 0) || null,
    reviews: Number(x.reviewsCount || x.reviewCount || 0) || null,
    website: x.website || x.websiteUrl || '',
    websiteHost: x.website ? host(x.website) : '',
    phone: x.phone || x.phoneUnformatted || '',
    address: x.address || '',
    primaryCategory: x.categoryName || x.category || categories(x)[0] || '',
    categories: categories(x),
    mapsUrl: x.url || x.placeUrl || x.googleMapsUrl || '',
  };
}

function bestMatch(business, mapsResults) {
  let best = null;
  for (const m of mapsResults) {
    let score = similarity(business.name, m.name);
    if (business.websiteHost && m.websiteHost && business.websiteHost === m.websiteHost) {
      score = Math.max(score, 0.98);
    }
    if (business.phone && m.phone) {
      const digits = s => String(s).replace(/\D/g, '');
      if (digits(business.phone).length >= 7 && digits(business.phone).slice(-7) === digits(m.phone).slice(-7)) {
        score = Math.max(score, 0.95);
      }
    }
    if (!best || score > best.score) best = { score, item: m };
  }
  return best && best.score >= 0.78 ? best : null;
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
  const datasetId = String(body.datasetId || '').trim();
  const businesses = Array.isArray(body.businesses) ? body.businesses : [];

  if (!token) return json(res, 400, { error: 'Missing apifyToken' });
  if (!datasetId) return json(res, 400, { error: 'Missing datasetId' });
  if (!businesses.length) return json(res, 400, { error: 'Missing businesses for matching' });

  const url = `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&clean=true&limit=1000&format=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || JSON.stringify(j); }
      catch { detail = await r.text().catch(() => ''); }
      return json(res, r.status, { error: `Apify HTTP ${r.status}: ${detail.slice(0, 300)}` });
    }
    const items = await r.json();
    const profiles = (items || []).map(mapsRow).filter(p => p.name);

    const results = businesses.map(b => {
      const match = bestMatch(b, profiles);
      const gbp = match?.item || null;
      return {
        ...b,
        gbpFound: !!gbp,
        gbpMatchScore: match ? Math.round(match.score * 100) : 0,
        gbpName: gbp?.name || '',
        gbpRating: gbp?.rating || null,
        gbpReviews: gbp?.reviews || null,
        gbpPrimaryCategory: gbp?.primaryCategory || '',
        gbpCategories: gbp?.categories || [],
        gbpAddress: gbp?.address || '',
        gbpPhone: gbp?.phone || '',
        gbpWebsite: gbp?.website || '',
        gbpMapsUrl: gbp?.mapsUrl || '',
      };
    });

    return json(res, 200, {
      ok: true,
      datasetId,
      checked: businesses.length,
      profilesReturned: profiles.length,
      gbpFoundCount: results.filter(r => r.gbpFound).length,
      noGbpCount: results.filter(r => !r.gbpFound).length,
      results,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
