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

  const wa = A.split(' ').filter(w => w.length > 2);
  const wb = B.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;

  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  let totalScore = 0;
  for (const w of shorter) {
    let bestWordScore = 0;
    for (const x of longer) {
      if (w === x) { bestWordScore = 1; break; }
      if (x.includes(w) || w.includes(x)) bestWordScore = Math.max(bestWordScore, 0.7);
    }
    totalScore += bestWordScore;
  }
  return totalScore / shorter.length;
}

function addressContainsCity(address, city, state) {
  const a = String(address || '').toLowerCase();
  if (!a) return false;
  const c = String(city || '').toLowerCase().trim();
  const s = String(state || '').toLowerCase().trim();
  return (c && a.includes(c)) || (s && a.includes(s));
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

// Generic words that don't add identity to a business name. If a GBP name is
// ONLY made of these + the search keyword, it's a category listing, not a
// real distinct business. ("Roofing Company", "Plumbing Services", etc.)
const GENERIC_WORDS = new Set([
  'company', 'service', 'services', 'contractor', 'contractors',
  'pros', 'pro', 'expert', 'experts', 'shop', 'group', 'solutions',
  'specialist', 'specialists', 'professional', 'professionals',
]);

function isGenericName(name) {
  const words = norm(name).split(' ').filter(w => w.length > 2);
  const meaningful = words.filter(w => !GENERIC_WORDS.has(w));
  return meaningful.length <= 1;
}

// bestMatch — now with hard-reject rules to prevent false positives:
//   1. Phone mismatch (both have phones, they don't match) → reject
//      unless website host matches (strong override).
//   2. Generic GBP names ("roofing company", "plumbing service") require
//      a phone or website confirmation to be trusted.
function bestMatch(business, mapsResults, city, state) {
  let best = null;
  for (const m of mapsResults) {
    let score = similarity(business.name, m.name);
    let phoneMatch = null;     // null = no info, true = match, false = mismatch
    let websiteMatch = false;

    // Website host = strong signal
    if (business.websiteHost && m.websiteHost && business.websiteHost === m.websiteHost) {
      score = Math.max(score, 0.98);
      websiteMatch = true;
    }

    // Phone digit match — both directions
    if (business.phone && m.phone) {
      const digits = s => String(s).replace(/\D/g, '');
      const a = digits(business.phone);
      const b = digits(m.phone);
      if (a.length >= 7 && b.length >= 7) {
        if (a.slice(-7) === b.slice(-7)) {
          score = Math.max(score, 0.95);
          phoneMatch = true;
        } else {
          phoneMatch = false;
        }
      }
    }

    // HARD REJECT 1: Phones disagree and no website match → not the same business.
    // This kills the "every roofer matched to 'roofing company' (253) 216-6559" bug.
    if (phoneMatch === false && !websiteMatch) continue;

    // HARD REJECT 2: GBP name is generic (e.g. "roofing company") and we have
    // no hard signal to confirm. Word-overlap alone isn't enough — every business
    // with the keyword in its name would falsely match.
    if (isGenericName(m.name) && phoneMatch !== true && !websiteMatch) continue;

    // Soft boost: address confirms expected city/state
    if (addressContainsCity(m.address, city, state)) {
      score = Math.min(0.99, score + 0.10);
    }

    if (!best || score > best.score) best = { score, item: m };
  }
  return best && best.score >= 0.65 ? best : null;
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
  const city = String(body.city || '').trim();
  const state = String(body.state || body.region || '').trim();
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
      const match = bestMatch(b, profiles, city, state);
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
