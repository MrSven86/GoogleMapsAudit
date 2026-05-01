// api/competitor-audit.js
// Top 5 SEO competitor audit + Lovable-ready blueprint
// Sequential execution. Requires Vercel Pro for maxDuration.

export const config = { maxDuration: 300 };

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_ACTOR = 'apify~google-search-scraper';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-4-5'; // override via body.model if needed

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      token,
      anthropicKey,
      url,
      keyword,
      city,
      googleDomain,
      language,
      model
    } = req.body || {};

    if (!token) return res.status(400).json({ error: 'Missing Apify token' });
    if (!anthropicKey) return res.status(400).json({ error: 'Missing Anthropic API key' });
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

    const query = city ? `${keyword} ${city}` : keyword;
    const llmModel = model || ANTHROPIC_MODEL;

    // 1. Google top 5
    const serp = await getGoogleTop(token, query, googleDomain || 'google.se', language || 'sv');
    const competitors = serp.slice(0, 5);
    if (!competitors.length) return res.status(500).json({ error: 'No organic results returned' });

    // 2. Audit your page
    const youAudit = await auditUrl(url, keyword, city);

    // 3. Audit competitors sequentially
    const competitorAudits = [];
    for (const c of competitors) {
      try {
        const audit = await auditUrl(c.url, keyword, city);
        competitorAudits.push({ ...c, audit });
      } catch (e) {
        competitorAudits.push({ ...c, audit: null, error: e.message });
      }
    }

    // 4. LLM structure analysis per competitor (sequential)
    const structureAnalyses = [];
    for (const c of competitorAudits) {
      if (!c.audit) { structureAnalyses.push(null); continue; }
      try {
        const analysis = await analyzeStructure(anthropicKey, llmModel, c, keyword, city, language);
        structureAnalyses.push(analysis);
      } catch (e) {
        structureAnalyses.push({ error: e.message });
      }
    }

    // 5. Synthesize final blueprint
    const blueprint = await synthesizeBlueprint(
      anthropicKey, llmModel,
      { youAudit, competitors: competitorAudits, structureAnalyses, keyword, city, language }
    );

    // 6. Score (kept from original)
    const score = scorePage(youAudit, competitorAudits.filter(c => c.audit));

    return res.status(200).json({
      query,
      score,
      you: { url, audit: youAudit },
      competitors: competitorAudits,
      structureAnalyses,
      blueprint
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audit failed' });
  }
}

/* ============================================================ */
/* GOOGLE SCRAPER                                                */
/* ============================================================ */

async function getGoogleTop(token, query, googleDomain, language) {
  const input = {
    queries: query,
    resultsPerPage: 10,
    maxPagesPerQuery: 1,
    searchDomain: googleDomain,
    countryCode: 'se',
    languageCode: language,
    mobileResults: false,
    includeUnfilteredResults: false,
    saveHtml: false
  };

  const runRes = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!runRes.ok) throw new Error('Could not start Google scraper');
  const run = (await runRes.json()).data;

  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const r = await fetch(`${APIFY_BASE}/actor-runs/${run.id}?token=${token}`);
    const d = (await r.json()).data;
    if (d.status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(d.status)) throw new Error(`Google scrape ${d.status}`);
  }

  const itemsRes = await fetch(`${APIFY_BASE}/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`);
  const items = await itemsRes.json();

  const organic = [];
  for (const page of items) {
    const arr = page.organicResults || page.results || [];
    for (const r of arr) {
      if (!r.url && !r.link) continue;
      if (isAd(r)) continue;
      organic.push({
        position: organic.length + 1,
        title: r.title || r.name || '(no title)',
        url: r.url || r.link,
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

/* ============================================================ */
/* PAGE AUDIT — DEEP STRUCTURE EXTRACTION                        */
/* ============================================================ */

async function auditUrl(url, keyword, city) {
  const html = await fetchHtml(url);
  const text = stripHtml(html);

  const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = getMeta(html, 'description');
  const h1 = matchOne(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map(m => clean(m[1])).filter(Boolean);
  const h3s = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map(m => clean(m[1])).filter(Boolean);

  const titleBlob = `${title} ${metaDescription} ${h1}`.toLowerCase();
  const keywordLower = String(keyword || '').toLowerCase();
  const cityLower = String(city || '').toLowerCase();

  // Sections — extract <section>, <main>, <article> blocks in order
  const sections = extractSections(html);

  // CTAs — buttons and prominent links with action verbs
  const ctas = extractCTAs(html);

  // FAQ detection
  const faq = extractFAQ(html);

  // Schema
  const schemaTypes = extractSchemaTypes(html);

  // Forms
  const forms = extractForms(html);

  // Images
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const imagesWithAlt = images.filter(m => /\salt=["'][^"']+["']/i.test(m[0])).length;

  // Phone numbers
  const phones = [...new Set([...text.matchAll(/(\+?\d[\d\s().-]{7,}\d)/g)].map(m => m[0].trim()))].slice(0, 5);

  // Colors — sniff from inline styles and style tags
  const colors = extractColors(html);

  return {
    url,
    title: clean(title),
    metaDescription: clean(metaDescription),
    h1: clean(h1),
    h2s: h2s.slice(0, 30),
    h3s: h3s.slice(0, 50),
    sections,
    ctas,
    faq,
    forms,
    schemaTypes,
    colors,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    hasH1: !!clean(h1),
    keywordInImportantPlaces: keywordLower ? titleBlob.includes(keywordLower) : false,
    cityInImportantPlaces: cityLower ? titleBlob.includes(cityLower) : false,
    keywordCount: countOccurrences(text.toLowerCase(), keywordLower),
    cityCount: countOccurrences(text.toLowerCase(), cityLower),
    hasPhone: phones.length > 0,
    phones,
    hasSchema: schemaTypes.length > 0,
    images: images.length,
    imagesWithAlt,
    internalLinks: countInternalLinks(html, url),
    externalLinks: countExternalLinks(html, url),
    hasCanonical: /rel=["']canonical["']/i.test(html),
    hasViewport: /name=["']viewport["']/i.test(html),
    bodyTextSample: text.slice(0, 4000) // cap for LLM context
  };
}

function extractSections(html) {
  // Find top-level structural blocks in order
  const re = /<(section|main|article|header|footer)[^>]*(?:id=["']([^"']*)["'])?[^>]*(?:class=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    const tag = m[1];
    const id = m[2] || '';
    const cls = m[3] || '';
    const inner = m[4];
    const innerH = matchOne(inner, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const sample = clean(stripHtml(inner)).slice(0, 240);
    out.push({
      tag,
      id,
      classes: cls,
      heading: clean(innerH),
      sample,
      wordCount: stripHtml(inner).split(/\s+/).filter(Boolean).length
    });
  }
  return out;
}

function extractCTAs(html) {
  const out = [];
  // <button>, <a class*=btn>, <a class*=cta>
  const btnRe = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  const ctaLinkRe = /<a[^>]*(?:class=["'][^"']*(?:btn|button|cta|knapp)[^"']*["'])[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const phoneLinkRe = /<a[^>]*href=["']tel:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const mailLinkRe = /<a[^>]*href=["']mailto:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = btnRe.exec(html)) !== null && out.length < 20) {
    const text = clean(m[1]);
    if (text) out.push({ kind: 'button', text, target: '' });
  }
  while ((m = ctaLinkRe.exec(html)) !== null && out.length < 30) {
    out.push({ kind: 'cta-link', text: clean(m[2]), target: m[1] });
  }
  while ((m = phoneLinkRe.exec(html)) !== null && out.length < 35) {
    out.push({ kind: 'phone', text: clean(m[2]), target: 'tel:' + m[1] });
  }
  while ((m = mailLinkRe.exec(html)) !== null && out.length < 40) {
    out.push({ kind: 'email', text: clean(m[2]), target: 'mailto:' + m[1] });
  }
  return out;
}

function extractFAQ(html) {
  // Detect <details><summary>, schema FAQPage, or "Vanliga frågor" sections
  const detailsBlocks = [...html.matchAll(/<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)]
    .map(m => ({ q: clean(m[1]), a: clean(m[2]).slice(0, 400) }));
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  return { detailsBlocks: detailsBlocks.slice(0, 20), hasFaqSchema };
}

function extractSchemaTypes(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const types = new Set();
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      collectTypes(parsed, types);
    } catch { /* malformed JSON-LD, skip */ }
  }
  return [...types];
}
function collectTypes(node, set) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectTypes(n, set)); return; }
  if (typeof node !== 'object') return;
  if (node['@type']) {
    if (Array.isArray(node['@type'])) node['@type'].forEach(t => set.add(t));
    else set.add(node['@type']);
  }
  Object.values(node).forEach(v => collectTypes(v, set));
}

function extractForms(html) {
  const forms = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/gi)];
  return forms.map(f => {
    const inner = f[1];
    const fields = [...inner.matchAll(/<(input|textarea|select)[^>]*(?:name=["']([^"']*)["'])?[^>]*(?:type=["']([^"']*)["'])?[^>]*>/gi)]
      .map(m => ({ tag: m[1], name: m[2] || '', type: m[3] || '' }))
      .filter(f => f.name || f.type);
    return { fieldCount: fields.length, fields: fields.slice(0, 15) };
  }).slice(0, 5);
}

function extractColors(html) {
  // Pull hex/rgb from inline style + first <style> block
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join(' ');
  const inlineStyles = [...html.matchAll(/style=["']([^"']*)["']/gi)].map(m => m[1]).join(' ');
  const blob = (styleBlocks + ' ' + inlineStyles).slice(0, 50000);
  const hexes = [...blob.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase());
  const rgbs = [...blob.matchAll(/rgba?\([^)]+\)/gi)].map(m => m[0].toLowerCase());
  // Frequency
  const counts = {};
  [...hexes, ...rgbs].forEach(c => { counts[c] = (counts[c] || 0) + 1; });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([color, count]) => ({ color, count }));
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)' },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`Could not crawl ${url} (${r.status})`);
  return await r.text();
}

/* ============================================================ */
/* LLM — STRUCTURE ANALYSIS                                      */
/* ============================================================ */

async function analyzeStructure(apiKey, model, competitor, keyword, city, language) {
  const a = competitor.audit;
  const compactAudit = {
    url: competitor.url,
    serp_title: competitor.title,
    serp_description: competitor.description,
    page_title: a.title,
    meta_description: a.metaDescription,
    h1: a.h1,
    h2s: a.h2s,
    h3s: a.h3s,
    word_count: a.wordCount,
    sections: a.sections.map(s => ({
      tag: s.tag, id: s.id, classes: s.classes,
      heading: s.heading, sample: s.sample, words: s.wordCount
    })),
    ctas: a.ctas,
    faq: a.faq,
    forms: a.forms,
    schema_types: a.schemaTypes,
    colors: a.colors,
    phones: a.phones,
    images: a.images,
    images_with_alt: a.imagesWithAlt,
    body_sample: a.bodyTextSample
  };

  const prompt = `Du analyserar en konkurrent-sida som rankar för "${keyword}${city ? ' ' + city : ''}" på Google. Returnera strikt JSON.

Sida: ${competitor.url}

Strukturerad data:
${JSON.stringify(compactAudit, null, 2)}

Returnera JSON med exakt detta schema:
{
  "section_order": [
    { "name": "string (t.ex. Hero, Tjänster, Om oss, Recensioner, FAQ, Kontakt, Footer)",
      "purpose": "string — varför denna sektion finns",
      "heading": "string — exakt rubrik om finns",
      "key_content": "string — vad sektionen innehåller (1-2 meningar)",
      "cta_present": boolean }
  ],
  "value_proposition": "string — sidans huvudbudskap i en mening",
  "tonality": "string — t.ex. formell/varm/teknisk/lokalt-folklig",
  "copy_style": "string — kort beskrivning av språkstil och meningsbyggnad",
  "primary_ctas": ["string — exakt CTA-text"],
  "trust_signals": ["string — recensioner, certifieringar, antal kunder, år i branschen, etc."],
  "local_signals": ["string — hur lokal anknytning uttrycks"],
  "technical_seo": {
    "schema_used": ["string"],
    "has_faq": boolean,
    "has_local_business": boolean,
    "headings_use_keyword": boolean,
    "headings_use_city": boolean
  },
  "design_pattern": {
    "layout": "string — t.ex. hero med formulär, stort bildhero, split layout",
    "color_palette_guess": ["string — hex eller färgnamn, dominerande"],
    "imagery_type": "string — t.ex. teamfoton, jobbfoton, stockbilder, illustrationer"
  },
  "what_this_page_does_well": ["string"],
  "what_this_page_does_poorly": ["string"]
}

Endast JSON. Ingen markdown-kodblock, inga förklaringar utanför JSON.`;

  const response = await callAnthropic(apiKey, model, prompt, 4000);
  return safeParseJSON(response);
}

/* ============================================================ */
/* LLM — FINAL BLUEPRINT SYNTHESIS                               */
/* ============================================================ */

async function synthesizeBlueprint(apiKey, model, ctx) {
  const { youAudit, competitors, structureAnalyses, keyword, city, language } = ctx;

  // Compact summary of competitors for synthesis
  const compactCompetitors = competitors.map((c, i) => ({
    position: c.position,
    url: c.url,
    title: c.title,
    audit_summary: c.audit ? {
      h1: c.audit.h1,
      word_count: c.audit.wordCount,
      schema: c.audit.schemaTypes,
      cta_count: c.audit.ctas?.length || 0
    } : null,
    structure: structureAnalyses[i]
  }));

  const compactYou = {
    url: youAudit.url,
    title: youAudit.title,
    h1: youAudit.h1,
    h2s: youAudit.h2s,
    word_count: youAudit.wordCount,
    sections: youAudit.sections.map(s => ({ heading: s.heading, sample: s.sample.slice(0, 120) })),
    ctas: youAudit.ctas?.slice(0, 8),
    schema: youAudit.schemaTypes,
    has_phone: youAudit.hasPhone,
    keyword_in_important_places: youAudit.keywordInImportantPlaces,
    city_in_important_places: youAudit.cityInImportantPlaces
  };

  const prompt = `Du är en SEO- och konverterings-strateg. Baserat på de 5 sidor som rankar topp på Google för "${keyword}${city ? ' ' + city : ''}", producera en blueprint som kan användas för att bygga en ny sida som har bättre chans att ranka och konvertera än alla 5.

## Sökord
"${keyword}${city ? ' ' + city : ''}"

## Min nuvarande sida
${JSON.stringify(compactYou, null, 2)}

## Top 5 konkurrenter (med strukturanalys)
${JSON.stringify(compactCompetitors, null, 2)}

## Din uppgift
Returnera JSON med exakt detta schema. Ingen markdown, inga kodblock, bara rå JSON:

{
  "summary": {
    "what_top_pages_have_in_common": ["string"],
    "common_section_order": ["string — sektionsnamn i den ordning som flest top-sidor använder"],
    "average_word_count": number,
    "common_schema_types": ["string"],
    "common_value_propositions": ["string"],
    "common_trust_signals": ["string"],
    "common_local_signals": ["string"],
    "what_no_one_is_doing": ["string — gap som vi kan exploatera"]
  },
  "blueprint": {
    "page_title": "string — föreslagen <title>, max 60 tecken",
    "meta_description": "string — max 155 tecken",
    "h1": "string — föreslagen H1",
    "target_word_count": number,
    "sections": [
      {
        "order": number,
        "name": "string — sektionsnamn (Hero, Tjänster, Process, Recensioner, FAQ, Kontakt, etc.)",
        "purpose": "string — varför sektionen finns, vilken micro-yes den ska skapa",
        "heading": "string — föreslagen H2",
        "subheadings": ["string — föreslagna H3"],
        "content_outline": "string — vad sektionen ska innehålla, 2-4 meningar",
        "copy_starter": "string — exempel-copy på 2-4 meningar i samma ton som vinnarna",
        "cta": {
          "present": boolean,
          "text": "string",
          "target": "string — t.ex. tel:, #kontakt, /boka"
        },
        "design_notes": "string — layouttyp, bildtyp, accentfärg-användning"
      }
    ],
    "ctas": {
      "primary": "string",
      "secondary": "string",
      "phone_format": "string"
    },
    "schema_to_implement": ["string — schema.org-typer"],
    "internal_link_targets": ["string — vilka andra sidor på samma site bör länkas till härifrån"],
    "trust_signals_to_include": ["string"],
    "local_signals_to_include": ["string"],
    "faq_questions": ["string — föreslagna FAQ-frågor på språket ${language || 'sv'}"]
  },
  "lovable_prompt": "string — en KOMPLETT prompt på svenska som kan klistras direkt in i Lovable för att bygga sidan. Ska vara 400-800 ord, mycket konkret, lista varje sektion i ordning, ange copy-tonalitet, beskriv hero-layout, ange CTA:er, ange färgpaletten i hex om möjligt. Skriv den som en build-instruktion, inte som en sammanfattning."
}`;

  const response = await callAnthropic(apiKey, model, prompt, 8000);
  return safeParseJSON(response);
}

/* ============================================================ */
/* ANTHROPIC API HELPER                                          */
/* ============================================================ */

async function callAnthropic(apiKey, model, prompt, maxTokens) {
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`Anthropic API error ${r.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text;
}

function safeParseJSON(text) {
  if (!text) return { error: 'Empty LLM response' };
  // Strip markdown code fences if model added them despite instructions
  let cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find first { and last }
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(cleaned.slice(first, last + 1)); }
      catch { /* fallthrough */ }
    }
    return { error: 'Could not parse LLM JSON', raw: cleaned.slice(0, 1500) };
  }
}

/* ============================================================ */
/* SCORE — kept compatible with original                         */
/* ============================================================ */

function scorePage(you, comps) {
  let score = 50;
  if (you.hasH1) score += 8;
  if (you.keywordInImportantPlaces) score += 12;
  if (you.cityInImportantPlaces) score += 10;
  if (you.hasPhone) score += 6;
  if (you.hasSchema) score += 8;
  if (you.hasCanonical) score += 3;
  if (you.hasViewport) score += 3;
  const avgWords = avg(comps.map(c => c.audit.wordCount));
  if (avgWords && you.wordCount >= avgWords * 0.8) score += 10;
  if (you.images && you.imagesWithAlt / you.images > 0.7) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ============================================================ */
/* UTILS                                                         */
/* ============================================================ */

function getMeta(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
  return matchOne(html, re);
}
function matchOne(str, re) { const m = String(str || '').match(re); return m ? m[1] : ''; }
function clean(s) { return stripHtml(String(s || '')).replace(/\s+/g, ' ').trim(); }
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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
    .filter(m => { const h = m[1]; return h.startsWith('/') || h.includes(host); }).length;
}
function countExternalLinks(html, url) {
  const host = safeHost(url);
  return [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
    .filter(m => /^https?:\/\//i.test(m[1]) && !m[1].includes(host)).length;
}
function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function avg(arr) {
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
