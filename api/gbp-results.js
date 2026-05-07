// Vercel Serverless Function: POST /api/gbp-results
// STRATEGY: keyword-rank — match each input business against top-100
// ranking GBPs for keyword + city.

const APIFY_BASE = 'https://api.apify.com/v2';

// Hosts that are shared by millions of unrelated businesses — matching on
// these as a "website" signal is meaningless. e.g. two HVAC companies could
// both have facebook.com/<theirpage> URLs without being the same business.
// Match-by-website only counts when the host is genuinely first-party.
const SHARED_HOSTS = new Set([
  // Social
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'tiktok.com', 'youtube.com', 'pinterest.com',
  // Directories / aggregators
  'yelp.com', 'yellowpages.com', 'bbb.org', 'localsearch.com',
  'mapquest.com', 'foursquare.com', 'manta.com', 'usaircon.com',
  'superpages.com', 'whitepages.com', 'merchantcircle.com', 'nextdoor.com',
  'angi.com', 'angieslist.com', 'thumbtack.com', 'homeadvisor.com',
  'houzz.com', 'citysearch.com', 'kudzu.com', 'hotfrog.com',
  'cylex.us.com', 'bizapedia.com', 'dexknows.com',
  // Review/booking
  'tripadvisor.com', 'opentable.com', 'booking.com', 'expedia.com',
  // Generic
  'google.com', 'sites.google.com', 'goo.gl',
]);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isFirstPartyHost(h) {
  if (!h) return false;
  // Match host or any subdomain of a shared host
  for (const shared of SHARED_HOSTS) {
    if (h === shared || h.endsWith('.' + shared)) return false;
  }
  return true;
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
  let total = 0;
  for (const w of shorter) {
    let best = 0;
    for (const x of longer) {
      if (w === x) { best = 1; break; }
      if (x.includes(w) || w.includes(x)) best = Math.max(best, 0.7);
    }
    total += best;
  }
  return total / shorter.length;
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
  const w = x.website || x.websiteUrl || '';
  return {
    rankPosition,
    name: x.title || x.name || '',
    placeId: x.placeId || x.cid || '',
    rating: Number(x.totalScore || x.rating || 0) || null,
    reviews: Number(x.reviewsCount || x.reviewCount || 0) || null,
    website: w,
    websiteHost: w ? host(w) : '',
    phone: x.phone || x.phoneUnformatted || '',
    address: x.address || '',
    primaryCategory: x.categoryName || x.category || categories(x)[0] || '',
    categories: categories(x),
    mapsUrl: x.url || x.placeUrl || x.googleMapsUrl || '',
  };
}

function matchInRanking(business, rankings, city, state) {
  const businessHost = business.website ? host(business.website) : '';
  // Only count host-match if BOTH sides are first-party domains.
  // Two facebook.com URLs are not a match. Two real-domain URLs are.
  const businessHostUseful = isFirstPartyHost(businessHost);

  // Pass 1: hard signals
  for (const m of rankings) {
    if (business.phone && m.phone && phoneMatches(business.phone, m.phone)) {
      return { profile: m, matchType: 'phone' };
    }
    if (businessHostUseful && m.websiteHost && businessHost === m.websiteHost && isFirstPartyHost(m.websiteHost)) {
      return { profile: m, matchType: 'website' };
    }
  }

  // Pass 2: strong name similarity + locality
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
      rankingsReturned: rankings.length,   // <-- check this field. If <20, the search was too weak.
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
