// api/competitor-audit.js
// Top 5 SEO competitor audit + Lovable blueprint
// Pure regex/heuristic. No LLM. Sequential execution.

export const config = { maxDuration: 60 };

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_ACTOR = 'apify~google-search-scraper';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, url, keyword, city, googleDomain, language } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing Apify token' });
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

    const lang = language || 'sv';
    const query = city ? `${keyword} ${city}` : keyword;

    const serp = await getGoogleTop(token, query, googleDomain || 'google.se', lang);
    const competitors = serp.slice(0, 5);
    if (!competitors.length) return res.status(500).json({ error: 'No organic results returned' });

    const youAudit = await auditUrl(url, keyword, city, lang);

    const competitorAudits = [];
    for (const c of competitors) {
      try {
        const audit = await auditUrl(c.url, keyword, city, lang);
        competitorAudits.push({ ...c, audit });
      } catch (e) {
        competitorAudits.push({ ...c, audit: null, error: e.message });
      }
    }

    const summary = buildSummary(competitorAudits, lang);
    const blueprint = buildBlueprint(summary, youAudit, keyword, city, lang);
    const lovablePrompt = buildLovablePrompt(blueprint, summary, keyword, city, lang);
    const score = scorePage(youAudit, competitorAudits.filter(c => c.audit));

    return res.status(200).json({
      query,
      score,
      you: { url, audit: youAudit },
      competitors: competitorAudits,
      summary,
      blueprint,
      lovablePrompt
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Audit failed' });
  }
}

/* GOOGLE SCRAPER */
async function getGoogleTop(token, query, googleDomain, language) {
  const input = {
    queries: query, resultsPerPage: 10, maxPagesPerQuery: 1,
    searchDomain: googleDomain, countryCode: 'se', languageCode: language,
    mobileResults: false, includeUnfilteredResults: false, saveHtml: false
  };
  const runRes = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
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

/* PAGE AUDIT */
async function auditUrl(url, keyword, city, language) {
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
  const sections = extractSections(html, language);
  const ctas = extractCTAs(html);
  const faq = extractFAQ(html);
  const schemaTypes = extractSchemaTypes(html);
  const forms = extractForms(html);
  const colors = extractColors(html);
  const trustSignals = extractTrustSignals(text, language);
  const localSignals = city ? extractLocalSignals(text, city) : [];
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const imagesWithAlt = images.filter(m => /\salt=["'][^"']+["']/i.test(m[0])).length;
  const phones = [...new Set([...text.matchAll(/(\+?\d[\d\s().-]{7,}\d)/g)].map(m => m[0].trim()))].slice(0, 5);
  return {
    url, title, metaDescription, h1,
    h2s: h2s.slice(0, 30), h3s: h3s.slice(0, 50),
    sections, ctas, faq, forms, schemaTypes, colors, trustSignals, localSignals,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    hasH1: !!h1,
    keywordInImportantPlaces: keywordLower ? titleBlob.includes(keywordLower) : false,
    cityInImportantPlaces: cityLower ? titleBlob.includes(cityLower) : false,
    keywordCount: countOccurrences(text.toLowerCase(), keywordLower),
    cityCount: countOccurrences(text.toLowerCase(), cityLower),
    hasPhone: phones.length > 0, phones,
    hasSchema: schemaTypes.length > 0,
    images: images.length, imagesWithAlt,
    internalLinks: countInternalLinks(html, url),
    externalLinks: countExternalLinks(html, url),
    hasCanonical: /rel=["']canonical["']/i.test(html),
    hasViewport: /name=["']viewport["']/i.test(html)
  };
}

function extractSections(html, language) {
  const re = /<(section|main|article|header|footer|aside)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    const tag = m[1];
    const tagOpen = html.slice(m.index).match(/<[^>]+>/)?.[0] || '';
    const id = matchOne(tagOpen, /id=["']([^"']*)["']/i);
    const cls = matchOne(tagOpen, /class=["']([^"']*)["']/i);
    const inner = m[2];
    const innerH = clean(matchOne(inner, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i));
    const allHeads = [...inner.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map(x => clean(x[1])).filter(Boolean);
    const sample = clean(stripHtml(inner)).slice(0, 240);
    const wc = stripHtml(inner).split(/\s+/).filter(Boolean).length;
    const sectionType = classifySection(tag, id, cls, innerH, sample, language);
    out.push({ tag, id, classes: cls, heading: innerH, allHeadings: allHeads.slice(0, 8), sample, wordCount: wc, type: sectionType });
  }
  return dedupeSections(out);
}
function dedupeSections(arr) {
  const seen = new Set();
  return arr.filter(s => {
    const key = `${s.type}::${s.heading}::${s.sample.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function classifySection(tag, id, cls, heading, sample, language) {
  const blob = `${tag} ${id} ${cls} ${heading} ${sample.slice(0, 200)}`.toLowerCase();
  const rules = [
    { type: 'hero', re: /\b(hero|banner|jumbotron|masthead|main-banner|topp-?banner)\b/ },
    { type: 'navigation', re: /\b(nav|navbar|menu|navigation|topbar|header-menu)\b/ },
    { type: 'footer', re: /^footer$|\bfooter\b/ },
    { type: 'header', re: /^header$|\bsite-header\b/ },
    { type: 'reviews', re: /\b(reviews?|testimonials?|recensioner|omdömen|kundberättelser|reseñas|testimonios)\b/ },
    { type: 'faq', re: /\b(faq|vanliga frågor|frågor och svar|preguntas frecuentes)\b/ },
    { type: 'pricing', re: /\b(pricing|prices?|priser|prislista|precios|paket|planes?)\b/ },
    { type: 'services', re: /\b(services?|tjänster|våra tjänster|servicios|nuestros servicios|behandlingar|sortiment)\b/ },
    { type: 'process', re: /\b(process|så här|so funkar|hur det fungerar|cómo funciona|steg|stages?)\b/ },
    { type: 'about', re: /\b(about|om oss|om|nosotros|sobre|quienes somos|vår historia)\b/ },
    { type: 'team', re: /\b(team|teamet|vårt team|equipo|nuestro equipo|personal|personalen|medarbetare)\b/ },
    { type: 'contact', re: /\b(contact|kontakt|kontakta oss|contacto|contáctanos|hitta hit|öppettider|horarios)\b/ },
    { type: 'cta', re: /\b(cta|call-to-action|book|boka|kontakta|contact-cta|reservar)\b/ },
    { type: 'gallery', re: /\b(gallery|galleri|portfolio|våra arbeten|trabajos|antes y despues|före och efter)\b/ },
    { type: 'features', re: /\b(features?|fördelar|vad du får|por qué|why-us|why us|varför)\b/ },
    { type: 'locations', re: /\b(locations?|våra orter|bes(ö|o)k oss|sucursales|var hittar du oss|kliniker|salonger)\b/ }
  ];
  for (const r of rules) if (r.re.test(blob)) return r.type;
  return 'content';
}

function extractCTAs(html) {
  const out = [];
  const seenText = new Set();
  const phoneLinkRe = /<a[^>]*href=["']tel:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const mailLinkRe = /<a[^>]*href=["']mailto:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const ctaLinkRe = /<a[^>]*class=["'][^"']*(?:btn|button|cta|knapp|primary|action)[^"']*["'][^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const ctaLinkRe2 = /<a[^>]*href=["']([^"']*)["'][^>]*class=["'][^"']*(?:btn|button|cta|knapp|primary|action)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const btnRe = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = phoneLinkRe.exec(html)) !== null && out.length < 40) {
    const t = clean(m[2]); if (t) out.push({ kind: 'phone', text: t, target: 'tel:' + m[1] });
  }
  while ((m = mailLinkRe.exec(html)) !== null && out.length < 40) {
    const t = clean(m[2]); if (t) out.push({ kind: 'email', text: t, target: 'mailto:' + m[1] });
  }
  while ((m = ctaLinkRe.exec(html)) !== null && out.length < 40) {
    const t = clean(m[2]); if (t && !seenText.has(t)) { seenText.add(t); out.push({ kind: 'cta-link', text: t, target: m[1] }); }
  }
  while ((m = ctaLinkRe2.exec(html)) !== null && out.length < 40) {
    const t = clean(m[2]); if (t && !seenText.has(t)) { seenText.add(t); out.push({ kind: 'cta-link', text: t, target: m[1] }); }
  }
  while ((m = btnRe.exec(html)) !== null && out.length < 50) {
    const t = clean(m[1]); if (t && t.length < 80 && !seenText.has(t)) { seenText.add(t); out.push({ kind: 'button', text: t, target: '' }); }
  }
  return out;
}

function extractFAQ(html) {
  const detailsBlocks = [...html.matchAll(/<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)]
    .map(m => ({ q: clean(m[1]), a: clean(m[2]).slice(0, 400) }));
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  const jsonLdQuestions = [];
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try { const parsed = JSON.parse(b[1].trim()); collectFAQQuestions(parsed, jsonLdQuestions); } catch {}
  }
  return { detailsBlocks: detailsBlocks.slice(0, 20), hasFaqSchema, jsonLdQuestions: jsonLdQuestions.slice(0, 20) };
}
function collectFAQQuestions(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectFAQQuestions(n, out)); return; }
  if (node['@type'] === 'Question' && node.name) {
    out.push({ q: clean(String(node.name)), a: clean(String(node.acceptedAnswer?.text || '')).slice(0, 300) });
  }
  Object.values(node).forEach(v => collectFAQQuestions(v, out));
}

function extractSchemaTypes(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const types = new Set();
  for (const b of blocks) {
    try { const parsed = JSON.parse(b[1].trim()); collectTypes(parsed, types); } catch {}
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
    const fields = [...inner.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
      .map(m => ({
        tag: m[1],
        name: matchOne(m[2], /name=["']([^"']*)["']/i),
        type: matchOne(m[2], /type=["']([^"']*)["']/i),
        placeholder: matchOne(m[2], /placeholder=["']([^"']*)["']/i)
      }))
      .filter(f => f.name || f.type || f.placeholder);
    return { fieldCount: fields.length, fields: fields.slice(0, 15) };
  }).slice(0, 5);
}

function extractColors(html) {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join(' ');
  const inlineStyles = [...html.matchAll(/style=["']([^"']*)["']/gi)].map(m => m[1]).join(' ');
  const blob = (styleBlocks + ' ' + inlineStyles).slice(0, 80000);
  const hexes = [...blob.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase());
  const rgbs = [...blob.matchAll(/rgba?\([^)]+\)/gi)].map(m => m[0].toLowerCase().replace(/\s+/g, ''));
  const counts = {};
  [...hexes, ...rgbs].forEach(c => { counts[c] = (counts[c] || 0) + 1; });
  return Object.entries(counts)
    .filter(([c]) => !/^(#000|#fff|#000000|#ffffff)$/.test(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([color, count]) => ({ color, count }));
}

function extractTrustSignals(text, language) {
  const signals = [];
  const t = text.toLowerCase();
  const yearMatch = t.match(/(?:sedan|since|desde)\s+(\d{4})/);
  if (yearMatch) signals.push(`Sedan ${yearMatch[1]}`);
  const yearsMatch = t.match(/(\d{1,3})\s*(?:års? erfarenhet|years? of experience|años de experiencia)/);
  if (yearsMatch) signals.push(`${yearsMatch[1]} års erfarenhet`);
  const starMatch = t.match(/([0-9],[0-9]|[0-9]\.[0-9])\s*(?:av|out of|de)\s*5/);
  if (starMatch) signals.push(`Betyg ${starMatch[1]}/5`);
  const custMatch = t.match(/(\d{2,5})\s*\+?\s*(?:nöjda kunder|happy customers|clientes satisfechos|kunder)/);
  if (custMatch) signals.push(`${custMatch[1]}+ kunder`);
  const revMatch = t.match(/(\d{2,5})\s*\+?\s*(?:recensioner|reviews|reseñas|omdömen)/);
  if (revMatch) signals.push(`${revMatch[1]}+ recensioner`);
  if (/auktoriserad|certifierad|certified|certificado|godkänd/.test(t)) signals.push('Auktoriserad/certifierad');
  if (/försäkrad|insured|asegurado/.test(t)) signals.push('Försäkrad');
  if (/garanti|guarantee|garantía/.test(t)) signals.push('Garanti');
  if (/f-skatt/.test(t)) signals.push('F-skatt');
  return [...new Set(signals)];
}

function extractLocalSignals(text, city) {
  if (!city) return [];
  const out = [];
  const t = text.toLowerCase();
  const c = city.toLowerCase();
  const count = countOccurrences(t, c);
  if (count > 0) out.push(`Nämner "${city}" ${count}x`);
  const addr = text.match(/[A-ZÅÄÖ][\wåäö]+(?:vägen|gatan|torget|platsen)\s+\d+/);
  if (addr) out.push(`Adress: ${addr[0]}`);
  return out;
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)' },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`Could not crawl ${url} (${r.status})`);
  return await r.text();
}

/* SUMMARY */
function buildSummary(competitorAudits, language) {
  const valid = competitorAudits.filter(c => c.audit);
  if (!valid.length) return null;

  const sectionFreq = {};
  const sectionHeadings = {};
  for (const c of valid) {
    const seen = new Set();
    for (const s of c.audit.sections) {
      if (seen.has(s.type)) continue;
      seen.add(s.type);
      sectionFreq[s.type] = (sectionFreq[s.type] || 0) + 1;
      if (s.heading) {
        sectionHeadings[s.type] = sectionHeadings[s.type] || [];
        sectionHeadings[s.type].push(s.heading);
      }
    }
  }

  const orderSums = {};
  const orderCounts = {};
  for (const c of valid) {
    const seen = new Set();
    let pos = 0;
    for (const s of c.audit.sections) {
      if (seen.has(s.type)) continue;
      seen.add(s.type);
      pos++;
      orderSums[s.type] = (orderSums[s.type] || 0) + pos;
      orderCounts[s.type] = (orderCounts[s.type] || 0) + 1;
    }
  }

  const commonSectionOrder = Object.keys(sectionFreq)
    .filter(t => sectionFreq[t] >= Math.ceil(valid.length / 2))
    .sort((a, b) => (orderSums[a] / orderCounts[a]) - (orderSums[b] / orderCounts[b]));

  const ctaTextFreq = {};
  for (const c of valid) {
    for (const cta of c.audit.ctas) {
      if (!cta.text || cta.text.length > 40) continue;
      const k = cta.text.toLowerCase();
      ctaTextFreq[k] = ctaTextFreq[k] || { text: cta.text, count: 0, kinds: new Set() };
      ctaTextFreq[k].count++;
      ctaTextFreq[k].kinds.add(cta.kind);
    }
  }
  const topCtas = Object.values(ctaTextFreq)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(x => ({ text: x.text, count: x.count, kinds: [...x.kinds] }));

  const schemaFreq = {};
  for (const c of valid) for (const t of c.audit.schemaTypes) schemaFreq[t] = (schemaFreq[t] || 0) + 1;
  const commonSchema = Object.entries(schemaFreq)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => ({ type: t, count: n }));

  const trustFreq = {};
  for (const c of valid) for (const s of c.audit.trustSignals) trustFreq[s] = (trustFreq[s] || 0) + 1;
  const commonTrust = Object.entries(trustFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => ({ signal: s, count: n }));

  const colorFreq = {};
  for (const c of valid) for (const cc of c.audit.colors) colorFreq[cc.color] = (colorFreq[cc.color] || 0) + cc.count;
  const topColors = Object.entries(colorFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([color, count]) => ({ color, count }));

  const faqQs = [];
  for (const c of valid) {
    for (const q of (c.audit.faq.detailsBlocks || [])) faqQs.push(q.q);
    for (const q of (c.audit.faq.jsonLdQuestions || [])) faqQs.push(q.q);
  }
  const faqFreq = {};
  faqQs.forEach(q => { if (q) faqFreq[q] = (faqFreq[q] || 0) + 1; });
  const topFAQ = Object.entries(faqFreq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([q]) => q);

  const avgWords = Math.round(avg(valid.map(c => c.audit.wordCount)));

  const headingExamples = {};
  for (const [type, headings] of Object.entries(sectionHeadings)) {
    const freq = {};
    headings.forEach(h => { freq[h] = (freq[h] || 0) + 1; });
    headingExamples[type] = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
  }

  const allTypes = ['hero', 'services', 'process', 'about', 'team', 'reviews', 'faq', 'pricing', 'gallery', 'locations', 'contact', 'features'];
  const gaps = allTypes.filter(t => !sectionFreq[t]);

  return {
    competitorCount: valid.length,
    avgWords,
    sectionFrequency: sectionFreq,
    commonSectionOrder,
    sectionHeadingExamples: headingExamples,
    topCtas, commonSchema, commonTrust, topColors, topFAQ, gaps
  };
}

/* BLUEPRINT */
function buildBlueprint(summary, you, keyword, city, language) {
  if (!summary) return null;
  const lang = language || 'sv';
  const cityPart = city ? ` ${city}` : '';
  const standardOrder = ['hero', 'services', 'features', 'process', 'reviews', 'about', 'team', 'gallery', 'pricing', 'faq', 'locations', 'contact'];
  const finalOrder = [...new Set([...summary.commonSectionOrder, ...standardOrder])]
    .filter(t => !['navigation', 'footer', 'header', 'cta', 'content'].includes(t));

  const sections = finalOrder.map((type, i) => buildSectionPlan(type, i + 1, summary, keyword, city, lang));

  const titleStr = `${capitalize(keyword)}${cityPart} – ${pickPrimaryCtaWord(summary, lang)}`;
  const title = titleStr.length > 60 ? titleStr.slice(0, 57) + '...' : titleStr;

  const meta = lang === 'sv'
    ? `Letar du efter ${keyword.toLowerCase()}${cityPart ? ' i' + cityPart : ''}? ✓ Snabb service ✓ Lokalt ✓ ${summary.commonTrust[0]?.signal || 'Erfaren'}. Kontakta oss idag.`
    : lang === 'es'
      ? `¿Buscas ${keyword.toLowerCase()}${cityPart ? ' en' + cityPart : ''}? ✓ Rápido ✓ Local ✓ ${summary.commonTrust[0]?.signal || 'Profesional'}. Contáctanos.`
      : `Looking for ${keyword.toLowerCase()}${cityPart ? ' in' + cityPart : ''}? ✓ Fast ✓ Local ✓ ${summary.commonTrust[0]?.signal || 'Experienced'}. Contact us today.`;

  const h1 = `${capitalize(keyword)}${cityPart}`;
  const targetWords = Math.max(800, Math.round(summary.avgWords * 1.15));
  const primaryCta = summary.topCtas[0]?.text || (lang === 'sv' ? 'Kontakta oss' : lang === 'es' ? 'Contáctanos' : 'Contact us');
  const secondaryCta = summary.topCtas[1]?.text || (lang === 'sv' ? 'Boka tid' : lang === 'es' ? 'Reservar' : 'Book now');

  return {
    page_title: title,
    meta_description: meta.slice(0, 155),
    h1,
    target_word_count: targetWords,
    primary_cta: primaryCta,
    secondary_cta: secondaryCta,
    schema_to_implement: pickSchemaForBlueprint(summary, keyword),
    color_palette: summary.topColors.slice(0, 6).map(c => c.color),
    trust_signals_to_include: summary.commonTrust.slice(0, 6).map(t => t.signal),
    faq_questions: summary.topFAQ.slice(0, 8),
    sections
  };
}

function buildSectionPlan(type, order, summary, keyword, city, lang) {
  const cityPart = city ? ` ${city}` : '';
  const headingExamples = summary.sectionHeadingExamples[type] || [];
  const competitorsHaveIt = summary.sectionFrequency[type] || 0;

  const plans = {
    hero: {
      name: 'Hero',
      purpose: 'Etablera tydligt vad sidan handlar om, för vem, var. Skapa första micro-yes (jag är på rätt sida).',
      heading: `${capitalize(keyword)}${cityPart} – som faktiskt levererar`,
      subheadings: [],
      content_outline: 'Stor rubrik med keyword + stad. Underrubrik (1-2 meningar) som besvarar "vad gör ni, för vem, varför mig". Två CTA:er — primär (telefon eller boka) + sekundär (offert eller mer info). Visa minst en trust-marker direkt (★ betyg / antal kunder / år i branschen).',
      copy_starter: lang === 'sv'
        ? `Behöver du ${keyword.toLowerCase()}${cityPart ? ' i' + cityPart : ''}? Vi är på plats samma dag, ger fast pris innan vi börjar och garanterar arbetet.`
        : `Need ${keyword.toLowerCase()}${cityPart ? ' in' + cityPart : ''}? Same-day service, fixed price upfront, work guaranteed.`,
      cta: { present: true, text: summary.topCtas[0]?.text || 'Ring oss nu', target: 'tel:' },
      design_notes: 'Stort hero med bakgrundsbild eller video. Trust-strip direkt under (logos / ★ rating / antal jobb). På mobil: synlig telefon-CTA i header.'
    },
    services: {
      name: 'Tjänster',
      purpose: 'Visa vad som faktiskt erbjuds. Gör det skannbart. Varje tjänst ska kännas relevant.',
      heading: headingExamples[0] || `Våra ${keyword.toLowerCase()}-tjänster`,
      subheadings: [],
      content_outline: '4–6 tjänstekort i grid. Varje kort: ikon + tjänstenamn + 1–2 mening beskrivning + "Läs mer"-länk till egen undersida. Fokus på vad kunden får, inte vad vi gör.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Grid 2x3 eller 3x2 på desktop, stack på mobil. Använd ikoner från asset-biblioteket (inga Lucide / inga emojis). Hover-effekt med liten translate-Y och accent-border.'
    },
    features: {
      name: 'Varför oss',
      purpose: 'Differentiera. Foster slutsatsen att vi är annorlunda — visa istället för att deklarera.',
      heading: lang === 'sv' ? 'Därför väljer kunder oss istället' : 'Why customers choose us',
      subheadings: [],
      content_outline: '3–4 punkter med ikon + kort rubrik + 1 mening förklaring. Punkter ska vara konkreta (ej "kvalitet", "passion"). Ex: "Fast pris innan jobbet börjar", "Alltid F-skatt", "10 års garanti".',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Horisontell rad på desktop, stackad på mobil. Stor accentfärgad ikon ovanför varje punkt.'
    },
    process: {
      name: 'Så funkar det',
      purpose: 'Reducera friktion genom att visa hur enkelt det är att komma igång.',
      heading: lang === 'sv' ? 'Så går det till' : 'How it works',
      subheadings: [],
      content_outline: '3–4 steg numrerade. Varje steg: kort titel + 1 mening. Slutsteget ska leda till en CTA.',
      copy_starter: lang === 'sv' ? '1. Du ringer oss eller skickar formulär. 2. Vi bokar ett besök inom 24h. 3. Du får fast pris. 4. Vi utför jobbet och du betalar efter.' : '',
      cta: { present: true, text: summary.topCtas[0]?.text || 'Kom igång', target: '#kontakt' },
      design_notes: 'Horisontell tidslinje på desktop med stora siffror i accentfärg. Stack på mobil med vertikal linje mellan stegen.'
    },
    reviews: {
      name: 'Recensioner',
      purpose: 'Social proof. Foster slutsatsen "andra litar på dem, då kan jag göra det också".',
      heading: lang === 'sv' ? 'Vad våra kunder säger' : 'What our customers say',
      subheadings: [],
      content_outline: '3–6 recensioner med namn, plats, datum och stjärnor. Ska vara konkreta (nämna specifika problem och lösningar). Inkludera Google-logotyp om recensionerna kommer därifrån. Visa total ★-genomsnitt och antal recensioner ovanför.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Använd Velocity review-widget från CarpenterCloneRepoClaude/widgets/review-widget/ — pipa in från Apify scraper + Vercel KV. Inte statiska kort.'
    },
    about: {
      name: 'Om oss',
      purpose: 'Bygg förtroende genom historia och människor bakom företaget.',
      heading: lang === 'sv' ? 'Vilka vi är' : 'About us',
      subheadings: [],
      content_outline: '2–3 stycken. Sedan när finns ni, vad ni gjort, vad ni står för. Inkludera siffra (år, antal jobb, antal kunder). Bild på faktisk person eller team — ej stockbild.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Split layout — text vänster, bild höger. På mobil stack med bild först.'
    },
    team: {
      name: 'Teamet',
      purpose: 'Människor litar på människor. Visa ansikten.',
      heading: lang === 'sv' ? 'Möt teamet' : 'Meet the team',
      subheadings: [],
      content_outline: 'Foton av 3–6 personer. Varje med namn, roll, kort beskrivning. Riktiga foton, inte stock.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Grid med kvadratiska bilder. Hover visar mer info eller LinkedIn-länk.'
    },
    gallery: {
      name: 'Galleri / före-efter',
      purpose: 'Visuellt bevis på arbete. Foster slutsatsen "de kan utföra".',
      heading: lang === 'sv' ? 'Våra arbeten' : 'Our work',
      subheadings: [],
      content_outline: '6–12 bilder från riktiga jobb. Före-efter slider om relevant. Lightbox vid klick. Filter per tjänstetyp om det finns många.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Masonry eller jämn grid. Lazy-load. Optimera bilder.'
    },
    pricing: {
      name: 'Priser',
      purpose: 'Reducera prisångest. Transparens skapar förtroende.',
      heading: lang === 'sv' ? 'Priser' : 'Pricing',
      subheadings: [],
      content_outline: '2–3 paket eller startprisindikation. Inkludera "från X kr" om fast pris ej går. Lista vad som ingår. Markera populäraste paketet.',
      copy_starter: '',
      cta: { present: true, text: summary.topCtas[1]?.text || 'Få offert', target: '#kontakt' },
      design_notes: 'Tre kolumner med mittersta kolumnen i accentfärg. På mobil: stack med populäraste högst.'
    },
    faq: {
      name: 'Vanliga frågor',
      purpose: 'Besvara invändningar innan de blir invändningar. Plus: ranking-bonus från long-tail keywords.',
      heading: lang === 'sv' ? 'Vanliga frågor' : 'FAQ',
      subheadings: summary.topFAQ.slice(0, 8),
      content_outline: '8–12 frågor i accordion. Använd <details>/<summary> för att kunna implementera FAQPage-schema. Frågor ska vara faktiska kundinvändningar, ej PR-frågor.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Accordion. Ikon roterar vid öppning. Implementera FAQPage JSON-LD schema.'
    },
    locations: {
      name: 'Områden vi täcker',
      purpose: 'Lokal SEO. Foster slutsatsen "de jobbar i mitt område".',
      heading: city ? `Vi tar uppdrag i hela ${city}` : (lang === 'sv' ? 'Områden vi täcker' : 'Areas we serve'),
      subheadings: [],
      content_outline: 'Lista stadsdelar eller närliggande orter. Varje ska länka till egen landningssida (/zonas/[stadsdel]/ eller /omraden/[stadsdel]/). Detta är hela barrio-SEO-strategin.',
      copy_starter: '',
      cta: { present: false, text: '', target: '' },
      design_notes: 'Grid med stadsdelsnamn som länkar. Ev karta som visuell anchor.'
    },
    contact: {
      name: 'Kontakt',
      purpose: 'Sista konverteringspunkten. Gör det maximalt enkelt.',
      heading: lang === 'sv' ? 'Kontakta oss' : 'Contact us',
      subheadings: [],
      content_outline: 'Telefon (stor, klickbar tel:-länk), e-mail, adress, öppettider. Kontaktformulär med få fält (namn, telefon, kort meddelande). WhatsApp-knapp med pre-fylld text. Karta med kontorsplats.',
      copy_starter: '',
      cta: { present: true, text: summary.topCtas.find(c => c.kinds.includes('phone'))?.text || 'Ring nu', target: 'tel:' },
      design_notes: 'Split layout — formulär vänster, kontaktinfo + karta höger. WhatsApp-knapp med pre-skriven text för minimal friktion (en tap öppnar WhatsApp med meddelandet redo).'
    }
  };

  const plan = plans[type] || {
    name: capitalize(type),
    purpose: '', heading: headingExamples[0] || capitalize(type),
    subheadings: [], content_outline: '', copy_starter: '',
    cta: { present: false, text: '', target: '' }, design_notes: ''
  };

  return { order, type, competitors_have_this: competitorsHaveIt, competitor_heading_examples: headingExamples, ...plan };
}

function pickSchemaForBlueprint(summary, keyword) {
  const out = new Set();
  for (const s of summary.commonSchema) out.add(s.type);
  out.add('LocalBusiness');
  out.add('Organization');
  if (summary.topFAQ.length >= 4) out.add('FAQPage');
  if (summary.commonSchema.find(s => /Review|Rating/.test(s.type))) out.add('AggregateRating');
  return [...out];
}
function pickPrimaryCtaWord(summary, lang) {
  const first = summary.topCtas[0]?.text;
  if (first && first.length < 30) return first;
  return lang === 'sv' ? 'Kontakta oss idag' : lang === 'es' ? 'Contáctanos hoy' : 'Contact us today';
}

/* LOVABLE PROMPT */
function buildLovablePrompt(blueprint, summary, keyword, city, language) {
  if (!blueprint || !summary) return '';
  const cityPart = city ? ` i ${city}` : '';
  const lines = [];
  lines.push(`Bygg en konverterings-fokuserad landningssida för "${keyword}${cityPart}" baserat på analys av top 5 Google-rankande sidor.`);
  lines.push('');
  lines.push(`## Sida & SEO`);
  lines.push(`- <title>: ${blueprint.page_title}`);
  lines.push(`- meta description: ${blueprint.meta_description}`);
  lines.push(`- H1: ${blueprint.h1}`);
  lines.push(`- Mål-ordmängd: ~${blueprint.target_word_count} ord (top 5 ligger i snitt på ${summary.avgWords})`);
  lines.push(`- Schema att implementera: ${blueprint.schema_to_implement.join(', ')}`);
  lines.push('');
  lines.push(`## Färgpalett (från konkurrenter)`);
  if (blueprint.color_palette.length) {
    lines.push(`Dominerande färger på top 5: ${blueprint.color_palette.join(', ')}`);
    lines.push(`Använd dessa som referens men välj en stark accentfärg som differentierar — INTE samma palett som mest frekvent vinnare.`);
  } else {
    lines.push(`Ingen tydlig palett kunde extraheras — välj en distinkt accentfärg.`);
  }
  lines.push('');
  lines.push(`## Trust-signaler att inkludera`);
  if (blueprint.trust_signals_to_include.length) {
    blueprint.trust_signals_to_include.forEach(s => lines.push(`- ${s}`));
  } else {
    lines.push(`(Top 5 visade få explicita trust-signaler — gap att exploatera. Inkludera: år i branschen, antal jobb, ★-betyg, certifieringar, försäkringsstatus.)`);
  }
  lines.push('');
  lines.push(`## CTA-strategi`);
  lines.push(`- Primär CTA: "${blueprint.primary_cta}"`);
  lines.push(`- Sekundär CTA: "${blueprint.secondary_cta}"`);
  if (summary.topCtas.length) {
    lines.push(`- CTA-text som top-konkurrenter använder: ${summary.topCtas.slice(0, 5).map(c => `"${c.text}" (${c.count}x)`).join(', ')}`);
  }
  lines.push(`- Mobil: synlig telefon-CTA i header (klickbar tel:-länk).`);
  lines.push(`- WhatsApp-knapp på kontakt med pre-fylld text — en tap öppnar WhatsApp med meddelande redo.`);
  lines.push('');
  lines.push(`## Sektionsordning`);
  blueprint.sections.forEach(s => {
    const validated = s.competitors_have_this >= Math.ceil(summary.competitorCount / 2) ? '✓ validerad' : '○ tillagd för konvertering';
    lines.push('');
    lines.push(`### ${s.order}. ${s.name} [${s.type}] — ${validated} (${s.competitors_have_this}/${summary.competitorCount} top-sidor)`);
    lines.push(`Syfte: ${s.purpose}`);
    lines.push(`H2: ${s.heading}`);
    if (s.competitor_heading_examples?.length) {
      lines.push(`Konkurrenter-rubriker: ${s.competitor_heading_examples.map(h => `"${h}"`).join(' / ')}`);
    }
    if (s.subheadings?.length) {
      lines.push(`H3:er: ${s.subheadings.map(h => `"${h}"`).join(' / ')}`);
    }
    lines.push(`Innehåll: ${s.content_outline}`);
    if (s.copy_starter) lines.push(`Copy-start: "${s.copy_starter}"`);
    if (s.cta?.present) lines.push(`CTA: "${s.cta.text}" → ${s.cta.target}`);
    lines.push(`Design: ${s.design_notes}`);
  });
  if (blueprint.faq_questions.length) {
    lines.push('');
    lines.push(`## FAQ-frågor (från konkurrenter)`);
    blueprint.faq_questions.forEach(q => lines.push(`- ${q}`));
  }
  if (summary.gaps.length) {
    lines.push('');
    lines.push(`## Gap att exploatera`);
    lines.push(`Sektionstyper INGEN av top 5 har: ${summary.gaps.join(', ')}. Inkludering = potentiell differentiering.`);
  }
  lines.push('');
  lines.push(`## Build-regler (Velocity)`);
  lines.push(`- React + Vite. Inga Lucide-ikoner. Inga emojis. Endast ikoner från CarpenterCloneRepoClaude/assets/icons/.`);
  lines.push(`- Recensions-sektion: använd widgets/review-widget/ — inte statiska kort.`);
  lines.push(`- TopBar mobil: dölj kontaktdetaljer, visa endast en clean primär-färgad telefon-CTA-knapp.`);
  lines.push(`- Scroll-triggered reveal-animationer, staggered entrances, hover-transitions.`);
  lines.push(`- MECLABS micro-yes-sekvens: varje sektion ska föda nästa beslut. Foster slutsatser, deklarera inte.`);
  lines.push(`- WHERE → WHAT → WHY → HOW page-struktur.`);
  return lines.join('\n');
}

/* SCORE */
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

/* UTILS */
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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
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
function safeHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function avg(arr) {
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function capitalize(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
