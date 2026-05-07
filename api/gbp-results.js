// Vercel Serverless Function: POST /api/gbp-results
// NEW STRATEGY: keyword-rank.
//
// Receives:
//   - datasetId from a completed keyword-rank Apify run (top 100 ranking
//     businesses for keyword + city)
//   - businesses array (the YP listings the user wants to qualify)
//
// For each business, find a match in the top 100 via:
//   1. Phone digit match (last 7 digits)         — strongest
//   2. Website host match                         — strongest
//   3. Strong name similarity (≥0.85) + addr in city  — fallback
//
// Returns three useful states per business:
//   - gbpFound=true, rank ≤ 20:   has GBP, ranks well (NOT a lead for SEO)
//   - gbpFound=true, rank 21+:    has GBP but invisible (STRONG SEO lead)
//   - gbpFound=false:             not in top 100 (probably no GBP — verify before pitching)

const APIFY_BASE = 'https://api.apify.com/v2';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function digits(s) { return String(s || '').replace(/\D/g, ''); }

function phoneMatches(a, b) {
  const da = digits(a), db = digits(b);
  return da.length >= 7 && db.length >= 7 && da.slice(-7) === db.slice(-7);
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

function mapsRow(x, rankPosition) {
  return {
    rankPosition,
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

// Match an input business against the rankings. Returns the ranked profile
// + match metadata, or null if not found in top 100.
function matchInRanking(business, rankings, city, state) {
  const businessHost = business.website ? host(business.website) : '';

  // Pass 1: hard signals — phone or website host. These are unambiguous.
  for (const m of rankings) {
    if (business.phone && m.phone && phoneMatches(business.phone, m.phone)) {
      return { profile: m, matchType: 'phone' };
    }
    if (businessHost && m.websiteHost && businessHost === m.websiteHost) {
      return { profile: m, matchType: 'website' };
    }
  }

  // Pass 2: strong name similarity + address confirms locality.
  // Threshold raised to 0.85 (vs. 0.65 in the old per-name search) because
  // here we're choosing among 100 different real businesses — false matches
  // are easier and we want to be conservative.
  const c = String(city || '').toLowerCase();
  const s = String(state || '').toLowerCase();
  let best = null;
  for (const m of rankings) {
    const score = similarity(business.name, m.name);
    if (score < 0.85) continue;
    const addr = String(m.address || '').toLowerCase();
    const localityOk = !c || addr.includes(c) || (s && addr.includes(s));
    if (!localityOk) continue;
    if (!best || score > best.score) best = { score, profile: m };
  }
  if (best) return { profile: best.profile, matchType: 'name+address' };

  return null;
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

  const url = `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&clean=true&limit=200&format=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || JSON.stringify(j); }
      catch { detail = await r.text().catch(() => ''); }
      return json(res, r.status, { error: `Apify HTTP ${r.status}: ${detail.slice(0, 300)}` });
    }
    const items = await r.json();
    // Apify preserves order from the search — first item = rank #1.
    // Ghost listings (no phone/website/address) get their rank skipped because
    // they don't represent real ranking positions in the local pack.
    const rankings = (items || [])
      .map((x, i) => mapsRow(x, i + 1))
      .filter(p => p.name && (p.phone || p.website || p.address));

    const results = businesses.map(b => {
      const match = matchInRanking(b, rankings, city, state);
      if (match) {
        const gbp = match.profile;
        return {
          ...b,
          gbpFound: true,
          gbpRankPosition: gbp.rankPosition,
          gbpMatchType: match.matchType,
          gbpName: gbp.name,
          gbpRating: gbp.rating,
          gbpReviews: gbp.reviews,
          gbpPrimaryCategory: gbp.primaryCategory,
          gbpCategories: gbp.categories,
          gbpAddress: gbp.address,
          gbpPhone: gbp.phone,
          gbpWebsite: gbp.website,
          gbpMapsUrl: gbp.mapsUrl,
        };
      }
      return {
        ...b,
        gbpFound: false,
        gbpRankPosition: null,
        gbpMatchType: null,
        gbpName: '',
        gbpRating: null,
        gbpReviews: null,
        gbpPrimaryCategory: '',
        gbpCategories: [],
        gbpAddress: '',
        gbpPhone: '',
        gbpWebsite: '',
        gbpMapsUrl: '',
      };
    });

    const found = results.filter(r => r.gbpFound);
    return json(res, 200, {
      ok: true,
      strategy: 'keyword-rank',
      datasetId,
      rankingsReturned: rankings.length,
      checked: businesses.length,
      gbpFoundCount: found.length,
      gbpInTop10: found.filter(r => r.gbpRankPosition <= 10).length,
      gbpInTop20: found.filter(r => r.gbpRankPosition <= 20).length,
      gbpRanksPoorly: found.filter(r => r.gbpRankPosition > 20).length,
      notFoundInTop100: results.length - found.length,
      results,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
