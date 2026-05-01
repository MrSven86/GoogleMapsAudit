const BASE = 'https://api.apify.com/v2';
const ACTOR = 'apify~google-search-scraper';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      token,
      url,
      keyword,
      city,
      mode,
      googleDomain,
      language,
      countryCode,
      business = {}
    } = req.body || {};

    if (!token) return res.status(400).json({ error: 'Missing Apify token' });
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });
    if (!mode) return res.status(400).json({ error: 'Missing mode' });

    if (!['new', 'compare'].includes(mode)) {
      return res.status(400).json({ error: `Invalid mode: ${mode}` });
    }

    if (mode === 'compare' && !url) {
      return res.status(400).json({ error: 'Missing URL for compare mode' });
    }

    const query = city ? `${keyword} ${city}` : keyword;

    const serp = await getGoogleTop({
      token,
      query,
      googleDomain: googleDomain || 'google.com',
      language: language || 'en',
      countryCode: countryCode || 'us'
    });

    const competitorsRaw = serp.slice(0, 5);

    const competitors = [];
    for (const c of competitorsRaw) {
      const audit = await auditUrl(c.url, keyword, city).catch(err => null);
      if (audit) competitors.push({ ...c, audit });
    }

    if (mode === 'new') {
      const output = buildClaudeContentBrief({
        query,
        keyword,
        city,
        business,
        competitors
      });

      return res.status(200).json({
        mode,
        query,
        competitors,
        output
      });
    }

    const youAudit = await auditUrl(url, keyword, city);

    const output = buildLovableSeoPatch({
      query,
      keyword,
      city,
      business,
      url,
      youAudit,
      competitors
    });

    return res.status(200).json({
      mode,
      query,
      you: { url, audit: youAudit },
      competitors,
      output
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audit failed' });
  }
}

async function getGoogleTop({ token, query, googleDomain, language, countryCode }) {
  const input = {
    queries: query,
    resultsPerPage: 10,
    maxPagesPerQuery: 1,
    searchDomain: googleDomain,
    countryCode,
    languageCode: language,
    mobileResults: false,
    includeUnfilteredResults: false,
    saveHtml: false
  };

  const runRes = await fetch(`${BASE}/acts/${ACTOR}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });

  if (!runRes.ok) {
    throw new Error('Could not start Google scraper');
  }

  const runJson = await runRes.json();
  const run = runJson.data;

  let finished = false;

  for (let i = 0; i < 60; i++) {
    await sleep(3000);

    const statusRes = await fetch(`${BASE}/actor-runs/${run.id}?token=${token}`);
    const statusJson = await statusRes.json();
    const status = statusJson.data?.status;

    if (status === 'SUCCEEDED') {
      finished = true;
      break;
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Google scrape ${status}`);
    }
  }

  if (!finished) throw new Error('Google scrape timed out');

  const itemsRes = await fetch(`${BASE}/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`);
  const items = await itemsRes.json();

  const organic = [];

  for (const page of items) {
    const arr = page.organicResults || page.results || [];

    for (const r of arr) {
      const resultUrl = r.url || r.link;
      if (!resultUrl) continue;
      if (isAd(r)) continue;
      if (isBadResult(resultUrl)) continue;

      organic.push({
        position: organic.length + 1,
        title: r.title || r.name || '(no title)',
        url: resultUrl,
        description: r.description || ''
      });
    }
  }

  return organic.slice(0, 5);
}

function isAd(r) {
  const text = [r.title, r.description, r.type, r.resultType].join(' ').toLowerCase();
  return r.isAd || r.ad || r.sponsored || text.includes('sponsored') || text.includes('annons') || text.includes('reklam');
}

function isBadResult(url) {
  const bad = [
    'yelp.com',
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'angi.com',
    'homeadvisor.com',
    'bbb.org',
    'mapquest.com',
    'yellowpages.com',
    'invaluable.com'
  ];

  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return bad.some(domain => host.includes(domain));
  } catch {
    return true;
  }
}

async function auditUrl(url, keyword, city) {
  const html = await fetchHtml(url);
  const text = stripHtml(html);

  const title = clean(matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const metaDescription = clean(getMeta(html, 'description'));
  const h1 = clean(matchOne(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));

  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map(m => clean(m[1])).filter(Boolean);
  const h3s = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map(m => clean(m[1])).filter(Boolean);

  const titleBlob = `${title} ${metaDescription} ${h1}`.toLowerCase();
  const keywordLower = String(keyword || '').toLowerCase();
  const cityLower = String(city || '').toLowerCase();

  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const imagesWithAlt = images.filter(m => /\salt=["'][^"']+["']/i.test(m[0])).length;

  const schemaTypes = extractSchemaTypes(html);
  const phones = extractPhones(text);
  const ctas = extractCtas(html);

  return {
    url,
    title,
    metaDescription,
    h1,
    h2s,
    h3s,
    wordCount: text.split(/\s+/).filter(Boolean).length,

    hasH1: !!h1,
    keywordInImportantPlaces: keywordLower ? titleBlob.includes(keywordLower) : false,
    cityInImportantPlaces: cityLower ? titleBlob.includes(cityLower) : false,
    keywordCount: countOccurrences(text.toLowerCase(), keywordLower),
    cityCount: countOccurrences(text.toLowerCase(), cityLower),

    hasPhone: phones.length > 0,
    phones,

    hasSchema: schemaTypes.length > 0,
    schemaTypes,

    images: images.length,
    imagesWithAlt,

    internalLinks: countInternalLinks(html, url),
    externalLinks: countExternalLinks(html, url),

    hasCanonical: /rel=["']canonical["']/i.test(html),
    hasViewport: /name=["']viewport["']/i.test(html),
    hasFaqSchema: /FAQPage/i.test(html),
    hasLocalBusinessSchema: /LocalBusiness|HousePainter|PaintingContractor/i.test(html),

    ctas
  };
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 SEO Audit Bot'
    },
    redirect: 'follow'
  });

  if (!r.ok) throw new Error(`Could not crawl ${url} (${r.status})`);
  return await r.text();
}

function buildClaudeContentBrief({ query, keyword, city, business, competitors }) {
  const avgWords = Math.round(avg(competitors.map(c => c.audit.wordCount))) || 800;
  const competitorTitles = competitors.map(c => c.audit.title).filter(Boolean);
  const competitorH1s = competitors.map(c => c.audit.h1).filter(Boolean);
  const commonH2s = topItems(competitors.flatMap(c => c.audit.h2s || []), 12);

  const pageTitle = `${capitalize(keyword)} in ${city} | ${business.name || 'Local Painting Company'}`;
  const h1 = `${capitalize(keyword)} in ${city}`;

  return `
CLAUDE CONTENT SEO BRIEF

Target query:
${query}

Business:
${business.name || '[Business name]'}
Phone: ${business.phone || '[Phone]'}
Location: ${city || '[City]'}, ${business.region || '[State]'}
Service area: ${business.serviceArea || '[Service area]'}

Goal:
Create SEO content for a new local service landing page. This is NOT for Lovable implementation. This is for Claude/Figma content planning.

Recommended URL:
/${slugify(keyword)}-${slugify(city)}

Title tag:
${pageTitle}

Meta description:
Need a reliable ${keyword} in ${city}? Contact ${business.name || 'our local team'} for professional painting services, clear communication, and a free estimate.

H1:
${h1}

Target word count:
${Math.max(800, Math.round(avgWords * 1.2))} words

Competitor title patterns:
${competitorTitles.map(t => `- ${t}`).join('\n') || '- No usable competitor titles found'}

Competitor H1 patterns:
${competitorH1s.map(h => `- ${h}`).join('\n') || '- No usable competitor H1s found'}

Common competitor headings:
${commonH2s.map(h => `- ${h}`).join('\n') || '- No strong repeated H2 patterns found'}

Recommended page structure:

1. Hero
H1: ${h1}
Purpose: Instantly show service + location + trust.
Include: short intro, phone CTA, estimate CTA, local trust signal.

2. Services
H2: Commercial Painting Services in ${city}
Include: interior commercial painting, exterior commercial painting, office painting, retail painting, industrial/light commercial painting if relevant.

3. Why Choose ${business.name || 'Us'}
H2: Why Businesses in ${city} Choose ${business.name || 'Our Team'}
Include: licensed/insured, scheduling reliability, clean job sites, clear estimates, regional experience.

4. Local Proof
H2: Serving ${city} and the Surrounding Area
Include: local references, nearby towns, Pacific Northwest / Oregon-Washington-Idaho service context if true.

5. Process
H2: Our Commercial Painting Process
Include: estimate, prep, painting, walkthrough.

6. Reviews / Trust
H2: Trusted by Local Property Owners and Businesses
Include real reviews only. Do not invent reviews.

7. FAQ
H2: Commercial Painting FAQ
Questions to answer:
- How much does commercial painting cost in ${city}?
- Do you paint offices, retail spaces, and commercial buildings?
- Are you licensed and insured?
- Can you work around business hours?
- Do you serve areas outside ${city}?
- How do I request an estimate?

8. Contact
H2: Request a Free Commercial Painting Estimate
Include phone, short form, service area, business name.

Content rules:
- Do not stuff keywords.
- Mention "${keyword}" and "${city}" naturally in title, H1, intro, one H2, FAQ, and final CTA.
- Do not invent licenses, awards, reviews, years in business, or client names.
- Use ${business.name || 'the company'} as a real business, not a generic brand.
- Since the business serves multiple states, do not make the homepage carry all local SEO. This page should be specifically for ${city}.
`.trim();
}

function buildLovableSeoPatch({ query, keyword, city, business, url, youAudit, competitors }) {
  const avgWords = Math.round(avg(competitors.map(c => c.audit.wordCount))) || 800;

  const recommendedTitle = `${capitalize(keyword)} in ${city} | ${business.name || 'Local Painting Company'}`;
  const recommendedMeta = `Need a reliable ${keyword} in ${city}? Contact ${business.name || 'our local team'} for professional painting services and a free estimate.`;
  const recommendedH1 = `${capitalize(keyword)} in ${city}`;

  const localBusinessSchema = buildLocalBusinessSchema({ business, url, keyword, city });
  const faqSchema = buildFaqSchema({ keyword, city });

  const patchItems = [];

  if (youAudit.title !== recommendedTitle) {
    patchItems.push(`Set the page <title> to:\n${recommendedTitle}`);
  }

  if (!youAudit.metaDescription || !youAudit.metaDescription.toLowerCase().includes(city.toLowerCase())) {
    patchItems.push(`Set the meta description to:\n${recommendedMeta}`);
  }

  if (!youAudit.hasH1 || !youAudit.h1.toLowerCase().includes(city.toLowerCase())) {
    patchItems.push(`Set exactly one H1 on the page:\n${recommendedH1}`);
  }

  if (!youAudit.keywordInImportantPlaces) {
    patchItems.push(`Make sure "${keyword}" appears naturally in the title, H1, intro paragraph, one H2, and final CTA section.`);
  }

  if (!youAudit.cityInImportantPlaces) {
    patchItems.push(`Make sure "${city}" appears naturally in the title, H1, intro paragraph, local service area section, and FAQ.`);
  }

  if (!youAudit.hasPhone) {
    patchItems.push(`Add a visible clickable phone CTA in the header and final contact section:\n<a href="tel:${toTel(business.phone)}">${business.phone || '[phone]'}</a>`);
  }

  if (!youAudit.hasCanonical) {
    patchItems.push(`Add canonical tag:\n<link rel="canonical" href="${url}">`);
  }

  if (!youAudit.hasLocalBusinessSchema) {
    patchItems.push(`Add this LocalBusiness JSON-LD schema to the page head:\n\n${JSON.stringify(localBusinessSchema, null, 2)}`);
  }

  if (!youAudit.hasFaqSchema) {
    patchItems.push(`Add FAQPage JSON-LD schema:\n\n${JSON.stringify(faqSchema, null, 2)}`);
  }

  if (youAudit.images > 0 && youAudit.imagesWithAlt < youAudit.images) {
    patchItems.push(`Add descriptive alt text to all images. Pattern:\n"${business.name || 'Commercial painting'} project in ${city}"\n"${keyword} work by ${business.name || 'local painting contractor'} in ${city}"`);
  }

  if (youAudit.wordCount < avgWords * 0.7) {
    patchItems.push(`Current page has ${youAudit.wordCount} words. Competitors average around ${avgWords}. Add useful local content, service explanations, FAQ, process, and service area sections.`);
  }

  patchItems.push(`Because this business serves multiple states, do not try to rank the homepage for every city. Create local landing pages such as:\n/${slugify(keyword)}-${slugify(city)}\nThen link to it from the homepage and service area section.`);

  return `
LOVABLE TECHNICAL SEO PATCH

Target query:
${query}

Page audited:
${url}

Current page summary:
Title: ${youAudit.title || '[missing]'}
Meta description: ${youAudit.metaDescription || '[missing]'}
H1: ${youAudit.h1 || '[missing]'}
Word count: ${youAudit.wordCount}
Schema found: ${youAudit.schemaTypes.length ? youAudit.schemaTypes.join(', ') : 'No schema found'}
Phone found: ${youAudit.hasPhone ? 'Yes' : 'No'}
Canonical: ${youAudit.hasCanonical ? 'Yes' : 'No'}
Images with alt: ${youAudit.imagesWithAlt}/${youAudit.images}

Instructions for Lovable:
Implement the following SEO patches. Do not redesign the page unless required. Do not invent reviews, awards, licenses, or years in business.

${patchItems.map((p, i) => `${i + 1}. ${p}`).join('\n\n')}

Competitor reference:
${competitors.map(c => `- ${c.title} — ${c.url}`).join('\n')}

Final implementation checklist:
- One title tag only
- One meta description
- One H1 only
- Clickable phone links use tel:
- LocalBusiness JSON-LD added
- FAQPage JSON-LD added if FAQ exists visually
- Canonical tag added
- Images have alt text
- Page clearly targets ${keyword} in ${city}
`.trim();
}

function buildLocalBusinessSchema({ business, url, keyword, city }) {
  return {
    "@context": "https://schema.org",
    "@type": "HousePainter",
    "name": business.name || "",
    "url": url || "",
    "telephone": business.phone || "",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": business.address || "",
      "addressLocality": city || business.city || "",
      "addressRegion": business.region || "",
      "postalCode": business.postalCode || "",
      "addressCountry": "US"
    },
    "areaServed": business.serviceArea || city || "",
    "description": `${business.name || "Local painting company"} provides ${keyword || "painting services"} in ${city || "the local area"}.`
  };
}

function buildFaqSchema({ keyword, city }) {
  const questions = [
    {
      q: `Do you offer ${keyword} services in ${city}?`,
      a: `Yes. We provide ${keyword} services in ${city} and nearby areas.`
    },
    {
      q: `How do I request a commercial painting estimate?`,
      a: `You can call the business directly or use the contact form on the website to request an estimate.`
    },
    {
      q: `Can you work around business hours?`,
      a: `Many commercial painting projects can be scheduled to reduce disruption. Confirm availability during the estimate process.`
    },
    {
      q: `Are you licensed and insured?`,
      a: `Add the company’s verified licensing and insurance details here. Do not publish unverified claims.`
    }
  ];

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": questions.map(item => ({
      "@type": "Question",
      "name": item.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": item.a
      }
    }))
  };
}

function extractSchemaTypes(html) {
  const types = new Set();

  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      collectTypes(parsed, types);
    } catch {}
  }

  const schemaMatches = [...html.matchAll(/schema\.org\/([A-Za-z]+)/gi)];
  for (const m of schemaMatches) types.add(m[1]);

  return [...types];
}

function collectTypes(obj, types) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach(item => collectTypes(item, types));
    return;
  }

  if (obj['@type']) {
    if (Array.isArray(obj['@type'])) obj['@type'].forEach(t => types.add(t));
    else types.add(obj['@type']);
  }

  Object.values(obj).forEach(v => collectTypes(v, types));
}

function extractPhones(text) {
  const matches = text.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g) || [];
  return [...new Set(matches.map(clean))];
}

function extractCtas(html) {
  const ctas = [];

  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];

  for (const m of links) {
    const href = m[1];
    const text = clean(m[2]);
    if (!text) continue;

    if (/tel:/i.test(href)) {
      ctas.push({ kind: 'phone', text, target: href });
    } else if (/contact|quote|estimate|call|book|get started/i.test(text)) {
      ctas.push({ kind: 'cta', text, target: href });
    }
  }

  return ctas.slice(0, 20);
}

function getMeta(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
  return matchOne(html, re);
}

function matchOne(str, re) {
  const m = String(str || '').match(re);
  return m ? m[1] : '';
}

function clean(s) {
  return stripHtml(String(s || ''))
    .replace(/\s+/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return (text.match(new RegExp(escapeRegExp(needle), 'g')) || []).length;
}

function countInternalLinks(html, url) {
  const host = safeHost(url);

  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .filter(m => {
      const href = m[1];
      return href.startsWith('/') || href.includes(host);
    }).length;
}

function countExternalLinks(html, url) {
  const host = safeHost(url);

  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .filter(m => /^https?:\/\//i.test(m[1]) && !m[1].includes(host)).length;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function avg(arr) {
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function topItems(arr, limit = 10) {
  const map = new Map();

  for (const item of arr) {
    const key = clean(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function capitalize(s) {
  return String(s || '')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function toTel(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
