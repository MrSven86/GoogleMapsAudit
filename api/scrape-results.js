// Vercel Serverless Function: GET /api/scrape-results?datasetId=xxx&apifyToken=yyy&source=bbb
// Fetches dataset items from a completed Apify run and normalizes them
// into a uniform business shape regardless of source.

const APIFY_BASE = 'https://api.apify.com/v2';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function flattenAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a.trim();
  if (typeof a !== 'object') return String(a);
  const parts = [
    a.street || a.streetAddress || a.line1 || a.address1 || a.address,
    a.city || a.locality || a.addressLocality,
    a.state || a.region || a.addressRegion,
    a.postalCode || a.zip || a.postal,
  ].filter(Boolean).map(s => String(s).trim());
  return [...new Set(parts)].join(', ');
}

// Per-source normalizer. All return the same flat shape.
const NORMALIZERS = {
  bbb(x) {
    const name = x.name || x.businessName || x.title || '';
    const profileUrl = x.profileUrl || x.url || x.bbbUrl || '';
    const phone = x.phone || x.phoneNumber || x.telephone || '';
    const website = x.website || x.websiteUrl || '';
    const address = flattenAddress(x.address || x.fullAddress || x.location);
    const rating = x.rating || x.bbbRating || x.grade || '';
    const accredited = x.accredited === true || x.isAccredited === true || /accredited/i.test(String(x.accreditation || ''));
    const yearsInBusiness = x.yearsInBusiness || x.years || null;
    const categories = Array.isArray(x.categories) ? x.categories : (x.category ? [x.category] : []);
    const ownerName = x.ownerName || x.principal || x.contactName || '';
    return {
      name: String(name).trim(),
      phone: String(phone).trim(),
      website: String(website).trim(),
      websiteHost: website ? host(website) : '',
      address,
      bbbRating: String(rating).trim(),
      accredited,
      yearsInBusiness,
      categories: categories.filter(Boolean).map(c => typeof c === 'string' ? c : (c?.name || c?.title || String(c))),
      ownerName: String(ownerName).trim(),
      profileUrl: String(profileUrl).trim(),
      source: 'bbb',
    };
  },
  yelp(x) {
    const name = x.name || x.businessName || x.title || '';
    const profileUrl = x.url || x.directUrl || x.bizUrl || '';
    const phone = x.phone || x.phoneNumber || x.telephone || '';
    const website = x.website || x.websiteUrl || '';
    const address = flattenAddress(x.address || x.fullAddress || x.location);
    const rating = Number(x.aggregatedRating || x.rating || x.stars || 0) || null;
    const reviews = Number(x.reviewCount || x.reviewsCount || x.numberOfReviews || 0) || null;
    const categories = Array.isArray(x.categories) ? x.categories : (x.category ? [x.category] : []);
    return {
      name: String(name).trim(),
      phone: String(phone).trim(),
      website: String(website).trim(),
      websiteHost: website ? host(website) : '',
      address,
      rating,
      reviews,
      categories: categories.map(c => typeof c === 'string' ? c : (c?.title || c?.name || '')).filter(Boolean),
      profileUrl: String(profileUrl).trim(),
      source: 'yelp',
    };
  },
  yellowpages(x) {
    const name = x.name || x.businessName || x.title || '';
    const profileUrl = x.url || x.listingUrl || x.profileUrl || '';
    const phone = x.phone || x.phoneNumber || x.telephone || '';
    const website = x.website || x.websiteUrl || x.businessWebsite || '';
    const address = flattenAddress(x.address || x.fullAddress || x.streetAddress);
    const rating = Number(x.rating || x.stars || 0) || null;
    const reviews = Number(x.reviewCount || x.reviewsCount || x.numberOfReviews || 0) || null;
    const categories = Array.isArray(x.categories) ? x.categories : (x.category ? [x.category] : []);
    const yearsInBusiness = x.yearsInBusiness || x.years || null;
    return {
      name: String(name).trim(),
      phone: String(phone).trim(),
      website: String(website).trim(),
      websiteHost: website ? host(website) : '',
      address,
      rating,
      reviews,
      categories: categories.map(c => typeof c === 'string' ? c : (c?.title || c?.name || '')).filter(Boolean),
      yearsInBusiness,
      profileUrl: String(profileUrl).trim(),
      source: 'yellowpages',
    };
  },
};

async function handler(req, res) {
  let datasetId, token, source;
  if (req.method === 'GET') {
    const u = new URL(req.url, `http://${req.headers.host}`);
    datasetId = u.searchParams.get('datasetId');
    token = u.searchParams.get('apifyToken');
    source = u.searchParams.get('source');
  } else if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (e) {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
    datasetId = body.datasetId;
    token = body.apifyToken;
    source = body.source;
  } else {
    return json(res, 405, { error: 'GET or POST only' });
  }

  if (!datasetId) return json(res, 400, { error: 'Missing datasetId' });
  if (!token) return json(res, 400, { error: 'Missing apifyToken' });
  if (!source || !NORMALIZERS[source]) {
    return json(res, 400, { error: `Missing or invalid source. Must be one of: ${Object.keys(NORMALIZERS).join(', ')}` });
  }

  // Fetch up to 1000 dataset items
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
    const normalize = NORMALIZERS[source];
    const businesses = (items || []).map(normalize).filter(b => b.name);

    return json(res, 200, {
      ok: true,
      source,
      datasetId,
      rawItemCount: (items || []).length,
      total: businesses.length,
      businesses,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
