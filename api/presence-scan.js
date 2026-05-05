// Vercel Serverless Function: /api/presence-scan
// Real Business Presence Scanner
// Sources -> master list -> Google Maps GBP check -> keyword rank check -> lead scoring

const APIFY_BASE = 'https://api.apify.com/v2';
const GOOGLE_SEARCH_ACTOR = 'apify~google-search-scraper';
const GOOGLE_MAPS_ACTOR = 'compass~crawler-google-places';

const SOURCE_DEFS = {
  google: {
    label: 'Google Organic',
    queries: ({ keyword, city, region }) => [
      `${keyword} ${city} ${region}`,
      `${keyword} company ${city} ${region}`,
      `${keyword} contractor ${city} ${region}`,
      `${keyword} near ${city} ${region}`,
      `best ${keyword} ${city} ${region}`,
    ],
  },
  yelp: {
    label: 'Yelp',
    domains: ['yelp.com'],
    queries: ({ keyword, city, region }) => [
      `site:yelp.com/biz ${keyword} ${city} ${region}`,
      `site:yelp.com/search ${keyword} ${city} ${region}`,
      `yelp ${keyword} ${city} ${region}`,
    ],
  },
  bbb: {
    label: 'BBB',
    domains: ['bbb.org'],
    queries: ({ keyword, city, region }) => [
      `site:bbb.org/us ${keyword} ${city} ${region}`,
      `site:bbb.org ${keyword} ${city} ${region}`,
      `BBB ${keyword} ${city} ${region}`,
    ],
  },
  yellowpages: {
    label: 'Yellow Pages',
    domains: ['yellowpages.com'],
    queries: ({ keyword, city, region }) => [
      `site:yellowpages.com ${keyword} ${city} ${region}`,
      `yellow pages ${keyword} ${city} ${region}`,
    ],
  },
  angi: {
    label: 'Angi',
    domains: ['angi.com'],
    queries: ({ keyword, city, region }) => [
      `site:angi.com ${keyword} ${city} ${region}`,
      `Angi ${keyword} ${city} ${region}`,
    ],
  },
  facebook: {
    label: 'Facebook',
    domains: ['facebook.com'],
    queries: ({ keyword, city, region }) => [
      `site:facebook.com ${keyword} ${city} ${region}`,
      `facebook ${keyword} ${city} ${region}`,
    ],
  },
  nextdoor: {
    label: 'Nextdoor',
    domains: ['nextdoor.com'],
    queries: ({ keyword, city, region }) => [
      `site:nextdoor.com ${keyword} ${city} ${region}`,
      `nextdoor ${keyword} ${city} ${region}`,
    ],
  },
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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
function cleanName(name, keyword, city) {
  let s = String(name || '')
    .replace(/\s+[|-]\s+.*$/g, '')
    .replace(/\b(best|top|near me|reviews|ratings|quote|free estimate)\b/gi, ' ')
    .replace(new RegExp(`\\b${escapeReg(keyword)}s?\\b`, 'ig'), match => match)
    .replace(new RegExp(`\\b${escapeReg(city)}\\b`, 'ig'), m => m)
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(Yelp|BBB|Better Business Bureau|Angi|Yellow Pages|Facebook)\s*[:\-]\s*/i, '').trim();
  if (s.length > 90) s = s.slice(0, 90).replace(/\s+\S*$/, '');
  return s;
}
function escapeReg(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function words(s) { return norm(s).split(' ').filter(w => w.length > 2); }
function similarity(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.94;
  const wa = new Set(words(A));
  const wb = new Set(words(B));
  if (!wa.size || !wb.size) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some(x => x.includes(w) || w.includes(x))) hits++;
  return hits / Math.max(wa.size, wb.size);
}
function dedupeCompanies(rows) {
  const out = [];
  for (const c of rows) {
    const name = cleanName(c.name || c.title || '', c.keyword || '', c.city || '');
    if (!name || name.length < 3) continue;
    if (/^(home|more|website|directions|call|reviews|photos|menu|contact|login|sign up)$/i.test(name)) continue;
    let existing = out.find(x => similarity(x.name, name) >= 0.88 || (x.website && c.website && host(x.website) === host(c.website)));
    if (existing) {
      existing.sources = [...new Set([...(existing.sources || []), ...(c.sources || [c.source].filter(Boolean))])];
      existing.sourceUrls = [...new Set([...(existing.sourceUrls || []), ...(c.sourceUrls || [c.url].filter(Boolean))])].slice(0, 8);
      existing.website ||= c.website || '';
      existing.phone ||= c.phone || '';
    } else {
      out.push({
        name,
        website: c.website || '',
        phone: c.phone || '',
        sources: [...new Set(c.sources || [c.source || 'unknown'])],
        sourceUrls: [...new Set(c.sourceUrls || [c.url].filter(Boolean))].slice(0, 8),
      });
    }
  }
  return out;
}
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
async function apifyStart(token, actorId, input) {
  const r = await fetch(`${APIFY_BASE}/acts/${actorId}/runs?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Apify ${actorId} HTTP ${r.status}`);
  return j.data;
}
async function apifyPoll(token, runId, maxPolls = 90) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(4000);
    const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const s = j.data?.status;
    if (s === 'SUCCEEDED') return j.data.defaultDatasetId;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(s)) throw new Error(`Apify run ${s}`);
  }
  throw new Error('Apify run timed out');
}
async function apifyDataset(token, datasetId, limit = 1000) {
  const r = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true&limit=${limit}`);
  if (!r.ok) throw new Error(`Dataset HTTP ${r.status}`);
  return await r.json();
}
async function runActor(token, actorId, input, limit = 1000) {
  const run = await apifyStart(token, actorId, input);
  const ds = await apifyPoll(token, run.id);
  return await apifyDataset(token, ds, limit);
}
function googleSearchInput(queries, country, language, resultsPerPage = 10, maxPages = 1) {
  return {
    queries: queries.join('\n'),
    resultsPerPage,
    maxPagesPerQuery: maxPages,
    countryCode: country || 'us',
    languageCode: language || 'en',
    searchDomain: 'google.com',
    mobileResults: false,
    includeUnfilteredResults: false,
    saveHtml: false,
    saveHtmlToKeyValueStore: false,
  };
}
function mapsInput(searchStringsArray, city, language, max) {
  return {
    searchStringsArray,
    locationQuery: city,
    maxCrawledPlacesPerSearch: max,
    language: language || 'en',
    maxReviews: 0,
    maxImages: 0,
    scrapeReviewerInfo: false,
    scrapeContacts: false,
    scrapeDirections: false,
    additionalInfo: false,
    exportPlaceUrls: true,
  };
}
function flattenSearchResults(items) {
  const out = [];
  for (const item of items || []) {
    const groups = [item.organicResults, item.results, item.paidResults, item.peopleAlsoAsk].filter(Array.isArray);
    for (const group of groups) {
      for (const r of group) {
        out.push({
          title: r.title || r.name || '',
          url: r.url || r.link || '',
          description: r.description || r.snippet || r.text || '',
        });
      }
    }
  }
  return out;
}
function companyFromSearchResult(r, source, keyword, city) {
  const url = r.url || '';
  const title = String(r.title || '').trim();
  if (!title) return null;
  const bad = /(top |best |nearby|near me|list of|directory|search results|category|login|sign up|reviews for|find a|compare|request a quote)/i;
  let name = title;
  if (source === 'yelp') name = title.replace(/\s+-\s+.*Yelp.*$/i, '').replace(/\s+Reviews?.*$/i, '');
  if (source === 'bbb') name = title.replace(/\s+Business Profile.*$/i, '').replace(/\s+BBB.*$/i, '');
  if (source === 'yellowpages') name = title.replace(/\s+-\s+Yellow Pages.*$/i, '');
  if (source === 'angi') name = title.replace(/\s+-\s+Angi.*$/i, '');
  if (source === 'facebook') name = title.replace(/\s+\|\s+Facebook.*$/i, '').replace(/\s+-\s+Home\s*$/i, '');
  name = cleanName(name, keyword, city);
  if (!name || name.length < 3 || bad.test(name)) return null;
  return { name, source, sources: [source], url, sourceUrls: [url] };
}
async function fetchHtml(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 BusinessPresenceScanner/1.0', 'Accept': 'text/html,application/xhtml+xml' },
    });
    clearTimeout(t);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return '';
    return await r.text();
  } catch { return ''; }
}
function extractNamesFromHtml(html, source, url, keyword, city) {
  const names = [];
  const push = s => {
    const n = cleanName(String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), keyword, city);
    if (n && n.length > 2 && n.length < 100) names.push(n);
  };
  const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const block of jsonLd) {
    try {
      const parsed = JSON.parse(block.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const walk = obj => {
        if (!obj || typeof obj !== 'object') return;
        const type = Array.isArray(obj['@type']) ? obj['@type'].join(' ') : String(obj['@type'] || '');
        if (/LocalBusiness|Organization|RoofingContractor|Contractor|HomeAndConstructionBusiness/i.test(type) && obj.name) push(obj.name);
        if (Array.isArray(obj.itemListElement)) obj.itemListElement.forEach(walk);
        if (obj.item) walk(obj.item);
      };
      arr.forEach(walk);
    } catch {}
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) push(title);
  // Yelp / YP / BBB commonly expose business names in aria-labels, h3s, link text.
  for (const m of html.matchAll(/<(h1|h2|h3)[^>]*>([\s\S]{2,160}?)<\/\1>/gi)) {
    push(m[2].replace(/<[^>]+>/g, ' '));
  }
  return [...new Set(names)].slice(0, 25).map(name => ({ name, source, sources: [source], url, sourceUrls: [url] }));
}
async function discoverSource({ token, source, keyword, city, region, country, language, deep, pagesPerQuery }) {
  const def = SOURCE_DEFS[source];
  if (!def) return { source, companies: [], rawCount: 0, deepCount: 0 };
  const queries = def.queries({ keyword, city, region: region || '' });
  const searchItems = await runActor(token, GOOGLE_SEARCH_ACTOR, googleSearchInput(queries, country, language, 10, pagesPerQuery || 1), 500);
  const flat = flattenSearchResults(searchItems);
  let companies = flat.map(r => companyFromSearchResult(r, source, keyword, city)).filter(Boolean);
  let deepCount = 0;
  if (deep) {
    const urls = [...new Set(flat.map(r => r.url).filter(Boolean))]
      .filter(u => !def.domains || def.domains.some(d => host(u).includes(d)))
      .slice(0, 20);
    for (const url of urls) {
      const html = await fetchHtml(url);
      if (!html) continue;
      const extracted = extractNamesFromHtml(html, source, url, keyword, city);
      deepCount += extracted.length;
      companies.push(...extracted);
    }
  }
  return { source, label: def.label, companies: dedupeCompanies(companies), rawCount: flat.length, deepCount };
}
function getTitle(x) { return x.title || x.name || x.placeName || ''; }
function getPlaceId(x) { return x.placeId || x.place_id || x.cid || x.googlePlaceId || ''; }
function getRank(x, i) { return x.rank || x.position || x._pos || x.searchPageRank || i + 1; }
function getRating(x) { return Number(x.totalScore || x.rating || x.stars || 0) || 0; }
function getReviews(x) { return Number(x.reviewsCount || x.reviews || x.reviewCount || 0) || 0; }
function getWebsite(x) { return x.website || x.websiteUrl || ''; }
function getPhone(x) { return x.phone || x.phoneUnformatted || x.phoneNumber || ''; }
function getAddress(x) { return x.address || x.street || x.fullAddress || ''; }
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
function primaryCategory(x) { return x.categoryName || x.category || categories(x)[0] || ''; }
function mapsRow(x, i) {
  return {
    raw: x,
    name: getTitle(x),
    placeId: getPlaceId(x),
    rank: Number(getRank(x, i)) || i + 1,
    rating: getRating(x),
    reviews: getReviews(x),
    website: getWebsite(x),
    phone: getPhone(x),
    address: getAddress(x),
    primaryCategory: primaryCategory(x),
    categories: categories(x),
    url: x.url || x.placeUrl || x.googleMapsUrl || '',
  };
}
function bestMatch(company, mapsRows, threshold = 0.72) {
  let best = null;
  for (const m of mapsRows) {
    let score = similarity(company.name, m.name);
    if (company.website && m.website && host(company.website) && host(company.website) === host(m.website)) score = Math.max(score, 0.98);
    if (score > (best?.score || 0)) best = { score, item: m };
  }
  return best && best.score >= threshold ? best : null;
}
function categoryMatches(primary, keyword) {
  const p = norm(primary), k = norm(keyword);
  if (!p || !k) return false;
  // Each key is the user's keyword (normalized) -> array of substrings that must appear in the GBP primary category
  const aliases = {
    // Roofing
    roofer: ['roof'], roofing: ['roof'], 'roof repair': ['roof'], 'roof installation': ['roof'],
    // Plumbing
    plumber: ['plumb'], plumbing: ['plumb'], 'water heater': ['plumb', 'heater'], 'drain cleaning': ['plumb', 'drain'],
    // HVAC
    hvac: ['hvac', 'heating', 'air conditioning', 'cooling'], 'air conditioning': ['hvac', 'air conditioning', 'cooling'],
    heating: ['hvac', 'heating'], furnace: ['hvac', 'heating', 'furnace'],
    // Painting
    painter: ['paint'], painting: ['paint'], 'house painter': ['paint'],
    // Electrical
    electrician: ['electric'], electrical: ['electric'],
    // Mental health / medical
    psychologist: ['psycholog', 'therapist', 'counselor', 'mental health'],
    psicologo: ['psicolog', 'terapeuta'], psicóloga: ['psicolog', 'terapeuta'], psykolog: ['psykolog', 'terapeut'],
    therapist: ['therap', 'counselor', 'psycholog'], counselor: ['counsel', 'therap', 'psycholog'],
    dentist: ['dent'], dentista: ['dent'], tandlakare: ['tand', 'dent'], chiropractor: ['chiropract'],
    // Legal
    attorney: ['law', 'attorney', 'lawyer', 'legal'], lawyer: ['law', 'attorney', 'lawyer', 'legal'],
    abogado: ['abogad', 'lawyer', 'attorney', 'legal'], advokat: ['advokat', 'lawyer', 'attorney', 'legal'],
    // Outdoor / cleaning
    landscaping: ['landscap', 'lawn'], landscaper: ['landscap', 'lawn'], 'lawn care': ['lawn', 'landscap'],
    'tree service': ['tree', 'arborist'], 'tree removal': ['tree', 'arborist'], arborist: ['arborist', 'tree'],
    'pressure washing': ['pressure wash', 'power wash'], 'power washing': ['pressure wash', 'power wash'],
    'window cleaning': ['window clean'], 'gutter cleaning': ['gutter'], 'gutter installation': ['gutter'],
    'junk removal': ['junk', 'rubbish', 'hauling', 'removal', 'garbage'], 'rubbish removal': ['junk', 'rubbish', 'hauling', 'garbage'],
    'chimney sweep': ['chimney'], 'chimney cleaning': ['chimney'],
    'pest control': ['pest'], exterminator: ['pest', 'extermin'],
    // Restoration
    'water damage': ['water damage', 'restoration'], 'fire damage': ['fire damage', 'restoration'],
    'mold remediation': ['mold', 'remediation'], 'water damage restoration': ['water damage', 'restoration'],
    // Auto / mobile
    mechanic: ['mechan', 'auto repair', 'car repair'], 'auto repair': ['auto', 'car repair', 'mechan'],
    'mobile mechanic': ['mechan', 'auto repair'], 'auto detailing': ['detail', 'car wash'],
    'car detailing': ['detail', 'car wash'], 'mobile detailing': ['detail', 'car wash'],
    // Construction-adjacent
    contractor: ['contract'], 'general contractor': ['contract', 'general contract'],
    handyman: ['handyman', 'handy'], carpenter: ['carpent'],
    flooring: ['floor'], tiling: ['tile', 'floor'], 'tile installation': ['tile'],
    drywall: ['drywall'], insulation: ['insulation'],
    // Locksmith / garage
    locksmith: ['locksmith', 'lock'], 'garage door': ['garage door'],
    // Cleaning services
    'house cleaning': ['clean', 'maid'], 'maid service': ['maid', 'clean'],
    'carpet cleaning': ['carpet'], 'commercial cleaning': ['clean', 'janitor'], janitorial: ['janitor', 'clean'],
    // Movers
    mover: ['mov', 'moving'], movers: ['mov', 'moving'], 'moving company': ['mov', 'moving'],
    // Septic / waste
    septic: ['septic'], 'septic service': ['septic'], 'dumpster rental': ['dumpster', 'waste'],
    // Holiday / seasonal
    'christmas lights': ['christmas', 'holiday lighting'], 'holiday lights': ['christmas', 'holiday lighting'],
    'snow removal': ['snow'],
    // Solar / EV
    solar: ['solar'], 'solar panel': ['solar'], 'ev charger': ['ev charg', 'electric vehicle'],
    // Appliance / pool
    'appliance repair': ['appliance'], 'pool service': ['pool'], 'pool cleaning': ['pool'],
  };
  // Build the set of substrings to match. If the keyword has a direct alias, use it.
  // Otherwise fall back to splitting the keyword into >2-char words.
  const fallback = words(k).filter(w => w.length > 3);
  const keys = aliases[k] || fallback;
  if (!keys.length) return false;
  return keys.some(w => p.includes(w));
}
function classify(row, ctx) {
  if (!row.hasGbp) return 'NO_GBP';
  if (!row.ranks) return 'HAS_GBP_NOT_RANKING';
  if (!row.primaryMatches) return 'CATEGORY_MISMATCH';
  // Adaptive WEAK_PROFILE — uses market context if provided, falls back to fixed thresholds.
  // ctx.weakReviewsThreshold is the cutoff below which a profile counts as weak relative to this market.
  const reviewsCutoff = (ctx && Number.isFinite(ctx.weakReviewsThreshold)) ? ctx.weakReviewsThreshold : 12;
  const ratingCutoff = (ctx && Number.isFinite(ctx.weakRatingThreshold)) ? ctx.weakRatingThreshold : 4.2;
  if (row.reviews < reviewsCutoff || !row.website || row.rating < ratingCutoff) return 'WEAK_PROFILE';
  return 'LOW_PRIORITY';
}

// Compute adaptive thresholds from the actual market ranking results.
// Idea: WEAK is defined relative to this market, not in absolute numbers.
//   - reviewsCutoff = max(5, median_reviews_top10 / 2)  -> being half the median means you're notably under-resourced
//   - ratingCutoff stays at 4.2 (a real signal across all markets)
function computeMarketContext(rankingRows) {
  if (!rankingRows || !rankingRows.length) {
    return { weakReviewsThreshold: 12, weakRatingThreshold: 4.2, marketMedianReviews: null, marketTop1Reviews: null };
  }
  const top10 = rankingRows.slice(0, 10);
  const reviewCounts = top10.map(r => r.reviews || 0).sort((a, b) => a - b);
  const median = reviewCounts.length
    ? (reviewCounts.length % 2
        ? reviewCounts[(reviewCounts.length - 1) / 2]
        : (reviewCounts[reviewCounts.length / 2 - 1] + reviewCounts[reviewCounts.length / 2]) / 2)
    : 0;
  const top1 = rankingRows[0]?.reviews || 0;
  // Half the median, clamped to [5, 50]. Ensures even very dense markets don't make us call a 60-review business "weak"
  const weakReviewsThreshold = Math.min(50, Math.max(5, Math.round(median / 2)));
  return {
    weakReviewsThreshold,
    weakRatingThreshold: 4.2,
    marketMedianReviews: Math.round(median),
    marketTop1Reviews: top1,
  };
}
function leadScore(row) {
  let s = 0;
  if (row.status === 'NO_GBP') s += 100;
  if (row.status === 'HAS_GBP_NOT_RANKING') s += 85;
  if (row.status === 'CATEGORY_MISMATCH') s += 70;
  if (row.status === 'WEAK_PROFILE') s += 55;
  if (!row.website) s += 12;
  if (row.reviews < 5) s += 12;
  else if (row.reviews < 15) s += 7;
  if (row.ranks && row.rank <= 3) s -= 30;
  if (row.sources?.length > 1) s += 8;
  return Math.max(0, Math.min(100, Math.round(s)));
}
function pitch(row, keyword, city, ctx) {
  const benchTop = ctx?.marketTop1Reviews;
  const benchMed = ctx?.marketMedianReviews;
  if (row.status === 'NO_GBP') return `Your business shows up in directories like Yelp/BBB but I can't find a Google Business Profile for "${keyword} ${city}". You're invisible on Google Maps — that's where 70%+ of local searches happen.`;
  if (row.status === 'HAS_GBP_NOT_RANKING') return `Your Google profile exists but doesn't rank in the top results for "${keyword} ${city}". You're getting found by people who search your name, not people searching for your service.`;
  if (row.status === 'CATEGORY_MISMATCH') {
    const note = benchTop ? ` The top 3 are all categorized correctly; the leader has ${benchTop} reviews.` : '';
    return `Your Google profile is categorized as "${row.primaryCategory}" instead of something matching "${keyword}". This single setting is likely why you rank #${row.rank || '?'} instead of top 5.${note}`;
  }
  if (row.status === 'WEAK_PROFILE') {
    const noteParts = [];
    if (benchMed) noteParts.push(`market median is ${benchMed} reviews`);
    if (benchTop) noteParts.push(`leader has ${benchTop}`);
    const note = noteParts.length ? ` (${noteParts.join(', ')})` : '';
    return `You rank #${row.rank || '?'} with ${row.reviews} reviews${note}. Closing the review gap and fixing profile completeness should move you up notably.`;
  }
  return 'Already visible in top results — lower-priority sales target.';
}
function parseManualList(text) {
  return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split('|').map(x => x.trim());
    return { name: parts[0], website: parts.find(p => /^https?:\/\//i.test(p)) || '', phone: parts.find(p => /\d{3}/.test(p) && !/^https?:\/\//i.test(p)) || '', source: 'manual', sources: ['manual'] };
  });
}
async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const token = String(body.apifyToken || '').trim();
    const keyword = String(body.keyword || '').trim();
    const city = String(body.city || '').trim();
    const region = String(body.region || '').trim();
    const country = String(body.country || 'us').trim().toLowerCase();
    const language = String(body.language || 'en').trim().toLowerCase();
    const maxCompanies = Math.min(200, Math.max(5, Number(body.maxCompanies || 50)));
    const rankDepth = Math.min(120, Math.max(20, Number(body.rankDepth || 80)));
    const profileBatchSize = Math.min(20, Math.max(1, Number(body.profileBatchSize || 10)));
    const deepDiscovery = body.deepDiscovery !== false;
    const sources = Array.isArray(body.sources) && body.sources.length ? body.sources : ['google', 'yelp', 'bbb', 'yellowpages', 'angi', 'facebook'];
    if (!token) return json(res, 400, { error: 'Missing Apify token' });
    if (!keyword || !city) return json(res, 400, { error: 'Missing keyword or city' });

    const manual = parseManualList(body.manualList);
    let sourceReports = [];
    let discovered = [];
    for (const source of sources) {
      try {
        const report = await discoverSource({ token, source, keyword, city, region, country, language, deep: deepDiscovery, pagesPerQuery: Number(body.pagesPerQuery || 1) });
        sourceReports.push({ source, label: report.label, companies: report.companies.length, rawCount: report.rawCount, deepCount: report.deepCount });
        discovered.push(...report.companies.map(c => ({ ...c, keyword, city })));
      } catch (e) {
        sourceReports.push({ source, error: e.message, companies: 0, rawCount: 0, deepCount: 0 });
      }
    }
    let master = dedupeCompanies([...manual, ...discovered]).slice(0, maxCompanies);

    const mapsRankingRaw = await runActor(token, GOOGLE_MAPS_ACTOR, mapsInput([`${keyword} ${city} ${region}`.trim()], `${city} ${region}`.trim(), language, rankDepth), rankDepth + 20);
    const ranking = mapsRankingRaw.map(mapsRow).filter(x => x.name);
    // Compute adaptive market thresholds for WEAK_PROFILE classification
    const marketCtx = computeMarketContext(ranking);
    // Add ranking companies to master as fallback visibility list, but mark Maps source.
    master = dedupeCompanies([...master, ...ranking.map(r => ({ name: r.name, website: r.website, phone: r.phone, source: 'maps-ranking', sources: ['maps-ranking'], sourceUrls: [r.url] }))]).slice(0, maxCompanies);

    const rows = [];
    for (let i = 0; i < master.length; i += profileBatchSize) {
      const batch = master.slice(i, i + profileBatchSize);
      const searchStringsArray = batch.map(c => `${c.name} ${city} ${region}`.trim());
      let profiles = [];
      try {
        const raw = await runActor(token, GOOGLE_MAPS_ACTOR, mapsInput(searchStringsArray, `${city} ${region}`.trim(), language, 5), batch.length * 8);
        profiles = raw.map(mapsRow).filter(x => x.name);
      } catch { profiles = []; }
      for (const c of batch) {
        // Tighter match threshold so we don't accidentally match a company name to a wrong GBP.
        // 0.78 means we need a strong textual match OR a website-host match (the latter forces score to 0.98).
        // This addresses the "0 NO GBP" problem where loose matching was finding false GBPs for everyone.
        const pm = bestMatch(c, profiles, 0.78);
        const rm = bestMatch(c, ranking, 0.78);
        const m = pm?.item || rm?.item || null;
        const hasGbp = !!m;
        const row = {
          name: c.name,
          sources: c.sources || [],
          sourceUrls: c.sourceUrls || [],
          hasGbp,
          gbpName: m?.name || '',
          matchScore: Math.round(((pm?.score || rm?.score || 0)) * 100),
          ranks: !!rm,
          rank: rm?.item?.rank || null,
          primaryCategory: m?.primaryCategory || '',
          primaryMatches: m ? categoryMatches(m.primaryCategory, keyword) : false,
          rating: m?.rating || 0,
          reviews: m?.reviews || 0,
          website: m?.website || c.website || '',
          phone: m?.phone || c.phone || '',
          address: m?.address || '',
          mapsUrl: m?.url || '',
        };
        row.status = classify(row, marketCtx);
        row.leadScore = leadScore(row);
        row.pitch = pitch(row, keyword, city, marketCtx);
        rows.push(row);
      }
    }
    rows.sort((a, b) => b.leadScore - a.leadScore || String(a.name).localeCompare(String(b.name)));
    const summary = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    return json(res, 200, { ok: true, keyword, city, region, sourceReports, summary, total: rows.length, mapsRankingCount: ranking.length, marketContext: marketCtx, rows, ranking });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
