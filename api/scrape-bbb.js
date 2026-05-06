// Vercel Serverless Function: /api/scrape-bbb
// Single-source BBB scraper. Returns business listings for keyword+location.
// Designed to complete inside a 60s Vercel Pro timeout.

const APIFY_BASE = 'https://api.apify.com/v2';
const BBB_ACTOR = 'crawlerbros~bbb-scraper';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Run the actor synchronously and get items in one HTTP call.
// run-sync-get-dataset-items waits up to 5 min by default — but since our
// Vercel function has a 60s ceiling, we use a shorter timeout via ?timeout=
async function runActorSync(token, actor, input, timeoutSeconds = 50) {
  const url = `${APIFY_BASE}/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutSeconds}&format=json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j?.error?.message || JSON.stringify(j); }
    catch { detail = await r.text().catch(() => ''); }
    throw new Error(`Apify ${actor} HTTP ${r.status}: ${detail.slice(0, 300)}`);
  }
  return r.json();
}

// Address may come back as a string OR an object like {street, city, state, postalCode}.
// Convert any object form into a flat readable string.
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

// The BBB actor's output shape varies slightly. Normalize defensively —
// fall back through several candidate field names so we don't lose data
// if the actor ever changes its schema.
function normalizeBbbItem(x) {
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
    address: address,
    bbbRating: String(rating).trim(),
    accredited,
    yearsInBusiness,
    categories: categories.filter(Boolean).map(c => typeof c === 'string' ? c : (c?.name || c?.title || String(c))),
    ownerName: String(ownerName).trim(),
    profileUrl: String(profileUrl).trim(),
    source: 'bbb',
  };
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
  const keyword = String(body.keyword || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || body.region || '').trim();
  const country = String(body.country || 'USA').trim().toUpperCase();
  const maxResults = Math.min(500, Math.max(10, Number(body.maxResults || 100)));

  if (!token) return json(res, 400, { error: 'Missing Apify token' });
  if (!keyword) return json(res, 400, { error: 'Missing keyword' });
  if (!city) return json(res, 400, { error: 'Missing city' });

  const startedAt = Date.now();

  // BBB's crawlerbros actor is URL-driven, not keyword-driven.
  // Build BOTH the category URL and the search URL — category URLs typically
  // return many more results (~115 vs ~3), but they only exist for the
  // canonical category names BBB recognizes. We pass both as startUrls so the
  // actor scrapes whichever resolves to a valid page.
  const stateLower = state.toLowerCase().replace(/\s+/g, '-');
  const cityLower = city.toLowerCase().replace(/\s+/g, '-');
  const keywordSlug = keyword.toLowerCase().replace(/\s+/g, '-');

  const categoryUrl = state
    ? `https://www.bbb.org/us/${stateLower}/${cityLower}/category/${keywordSlug}`
    : null;
  const searchUrl = `https://www.bbb.org/search?find_text=${encodeURIComponent(keyword)}&find_loc=${encodeURIComponent(state ? `${city}, ${state}` : city)}&find_country=USA`;

  // crawlerbros/bbb-scraper accepts startUrls. We send both — the actor will
  // attempt both and return businesses from whichever yields data.
  const startUrls = [];
  if (categoryUrl) startUrls.push({ url: categoryUrl });
  startUrls.push({ url: searchUrl });

  const input = {
    startUrls,
    maxItems: maxResults,
    maxResults,
    maxConcurrency: 5,
    proxyConfiguration: { useApifyProxy: true },
  };

  try {
    const items = await runActorSync(token, BBB_ACTOR, input, 50);
    const businesses = (items || []).map(normalizeBbbItem).filter(b => b.name);
    const elapsedMs = Date.now() - startedAt;
    return json(res, 200, {
      ok: true,
      source: 'bbb',
      keyword,
      city,
      state,
      country,
      requestedMax: maxResults,
      total: businesses.length,
      elapsedMs,
      // Diagnostic so we can see which URLs the actor tried
      urlsTried: startUrls.map(u => u.url),
      rawItemCount: (items || []).length,
      businesses,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    return json(res, 500, { error: e.message || String(e), elapsedMs, source: 'bbb' });
  }
}

module.exports = handler;
