import fs from 'node:fs/promises';
import path from 'node:path';

const UVA_ROOT = 'https://prosody.lib.virginia.edu';
const UVA_SITEMAP_URL = `${UVA_ROOT}/wp-sitemap-posts-prosody_poem-1.xml`;
const UVA_INDEX_URL = `${UVA_ROOT}/instructions/`;

const FOOT_PATTERN_TO_FAMILY = new Map([
  ['-+', 'iambic'],
  ['+-', 'trochaic'],
  ['--+', 'anapestic'],
  ['+--', 'dactylic'],
  ['++', 'spondaic'],
  ['--', 'pyrrhic']
]);

const FOOT_COUNT_TO_LABEL = new Map([
  ['1', 'monometer'],
  ['2', 'dimeter'],
  ['3', 'trimeter'],
  ['4', 'tetrameter'],
  ['5', 'pentameter'],
  ['6', 'hexameter']
]);

const NAMED_HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  nbsp: ' ',
  quot: '"',
  lt: '<',
  gt: '>',
  mdash: '-',
  ndash: '-',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: '...'
};

export async function fetchUvaCorpus({
  limit = Infinity,
  cacheDir = path.resolve(process.cwd(), '.cache', 'uva-prosody')
} = {}) {
  await fs.mkdir(cacheDir, { recursive: true });

  const sitemapXml = await fetchCachedText(UVA_SITEMAP_URL, path.join(cacheDir, 'sitemap.xml'));
  const poemUrls = extractSitemapUrls(sitemapXml).slice(0, limit);
  const indexHtml = await fetchCachedText(UVA_INDEX_URL, path.join(cacheDir, 'instructions.html'));
  const indexMaps = extractIndexMaps(indexHtml);

  const poems = [];
  for (const url of poemUrls) {
    const slug = url.replace(/\/$/, '').split('/').at(-1);
    const html = await fetchCachedText(url, path.join(cacheDir, `${slug}.html`));
    poems.push(extractPoemPage(html, url, indexMaps));
  }

  return {
    source: UVA_ROOT,
    index: UVA_INDEX_URL,
    sitemap: UVA_SITEMAP_URL,
    fetchedAt: new Date().toISOString(),
    count: poems.length,
    poems
  };
}

export function extractSitemapUrls(xml) {
  return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

export function canonicalizeRhymeScheme(scheme) {
  const map = new Map();
  let nextCode = 65;
  return String(scheme || '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .split('')
    .map((letter) => {
      if (!map.has(letter)) {
        map.set(letter, String.fromCharCode(nextCode));
        nextCode += 1;
      }
      return map.get(letter);
    })
    .join('');
}

export function normalizeStressPattern(pattern) {
  return String(pattern || '')
    .replace(/[()\s]/g, '')
    .replace(/\u222A/g, '-')
    .replace(/\+/g, 's')
    .replace(/-/g, 'u')
    .replace(/[^su]/g, '');
}

export function extractPoemPage(html, url, indexMaps = null) {
  const slug = url.replace(/\/$/, '').split('/').at(-1);
  const rhymeBlock = html.match(/<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" id="rhyme"[\s\S]*?<\/form><\/div>/);
  const rhymeFormName = html.match(/<form name="([a-z]+)" id="rhymeform"/i)?.[1] || '';
  const stanzaLineCounts = extractStanzaLineCounts(rhymeBlock?.[0] || '');
  const stanzaSchemes = sliceSchemeByCounts(rhymeFormName, stanzaLineCounts);

  const poemTitleBlock = html.match(/<div id="poemtitle"><h2>([\s\S]*?)<\/h2><h4>([\s\S]*?)<\/h4><\/div>/);
  const titleHtml = poemTitleBlock?.[1] || '';
  const authorHtml = poemTitleBlock?.[2] || '';
  const yearLabel = decodeHtmlEntities(titleHtml.match(/<small class="date">\(([^<]+)\)<\/small>/)?.[1] || '');
  const title = normalizeWhitespace(stripTags(titleHtml.replace(/<small class="date">[\s\S]*?<\/small>/, '')));
  const author = normalizeWhitespace(stripTags(authorHtml));
  const year = parseYear(yearLabel);

  const lines = [];
  const lineRegex = /<div class="TEI-l" id="prosody-real-(\d+)"([^>]*)>([\s\S]*?)<\/div><div class="buttons">([\s\S]*?)<\/div>/g;
  for (const match of html.matchAll(lineRegex)) {
    const lineIndex = Number(match[1]) - 1;
    const tagAttrs = match[2] || '';
    const bodyHtml = match[3] || '';
    const buttonsHtml = match[4] || '';
    const lineId = `prosody-real-${match[1]}`;
    const lineNumber = Number(attributeValue(tagAttrs, 'data-n') || match[1]);
    const part = decodeHtmlEntities(attributeValue(tagAttrs, 'data-part') || '');
    const templateStressRaw = attributeValue(tagAttrs, 'data-met') || '';
    const rawFeet = decodeHtmlEntities(attributeValue(tagAttrs, 'data-feet') || '');
    const rawStress = attributeValue(tagAttrs, 'data-real') || '';
    const answer = decodeHtmlEntities(bodyHtml.match(/answer="([^"]+)"/)?.[1] || '');
    const lineGroupIndex = Number(bodyHtml.match(/linegroupindex="(\d+)"/)?.[1] || '1');
    const meterKey = parseMeterKey(answer, lineGroupIndex);
    const noteHtml = buttonsHtml.match(/<p class="prosody-note" id="hintfor\d+"><span>[\s\S]*?<\/span>([\s\S]*?)<\/p>/)?.[1] || '';
    const note = normalizeWhitespace(stripTags(noteHtml));
    const lineStressRawPatterns = unique(
      rawStress
        .split('|')
        .map((entry) => decodeHtmlEntities(entry).trim())
        .filter(Boolean)
    );
    const canonicalStressSource = lineStressRawPatterns[0]
      ? 'data-real'
      : (templateStressRaw ? 'data-met-fallback' : '');
    const canonicalStressRaw = lineStressRawPatterns[0] || templateStressRaw || '';
    const canonicalStressPattern = normalizeStressPattern(canonicalStressRaw);
    const studentStressRawPatterns = lineStressRawPatterns;
    const studentStressPatterns = unique(
      lineStressRawPatterns
        .map((entry) => normalizeStressPattern(entry))
        .filter(Boolean)
    );
    const templateStressPattern = normalizeStressPattern(templateStressRaw);
    const acceptedStressPatterns = unique([
      ...studentStressPatterns,
      ...(studentStressPatterns.length ? [] : [canonicalStressPattern])
    ].filter(Boolean));
    const footTexts = rawFeet
      .split('|')
      .map((entry) => normalizeWhitespace(entry))
      .filter(Boolean);
    const syllables = extractLineSyllables(bodyHtml, canonicalStressRaw, canonicalStressPattern);

    lines.push({
      index: lineIndex,
      lineNumber,
      lineId,
      part,
      text: reconstructLineText(bodyHtml) || normalizeWhitespace(rawFeet.replace(/\|/g, '')),
      feetText: normalizeWhitespace(rawFeet),
      footTexts,
      canonicalStressSource,
      canonicalStressRaw,
      canonicalStressPattern,
      templateStressSource: templateStressRaw ? 'data-met' : '',
      templateStressRaw,
      templateStressPattern,
      studentStressRawPatterns,
      studentStressPatterns,
      acceptedStressPatterns,
      primaryStressPattern: canonicalStressPattern || acceptedStressPatterns[0] || '',
      syllableCount: syllables.length || canonicalStressPattern.length || 0,
      meterKey,
      meterLabel: meterKey ? meterKey.replaceAll('_', ' ') : '',
      lineGroupIndex,
      answer,
      note,
      syllables,
      rawAttributes: {
        dataN: String(lineNumber),
        dataPart: part,
        dataMet: templateStressRaw,
        dataReal: rawStress,
        dataFeet: rawFeet
      },
      sourceHtml: {
        bodyHtml,
        buttonsHtml
      }
    });
  }

  const poem = buildPoemText(lines, stanzaLineCounts);
  const audioUrl = html.match(/<audio[\s\S]*?<source[^>]*src="([^"]+)"/i)?.[1] || '';
  const grouping = indexMaps?.bySlug instanceof Map ? (indexMaps.bySlug.get(slug) || {}) : (indexMaps?.bySlug?.[slug] || {});

  return {
    slug,
    sourceUrl: url,
    title,
    author,
    yearLabel,
    year,
    profileHint: inferProfileHint({ author, year }),
    difficulty: grouping.difficulty || '',
    type: grouping.type || '',
    authorGroup: grouping.authorGroup || '',
    rhymeSchemeRaw: rhymeFormName.toUpperCase(),
    rhymeSchemeCanonical: canonicalizeRhymeScheme(rhymeFormName),
    stanzaLineCounts,
    stanzaSchemes,
    poem,
    audioUrl,
    lines
  };
}

export function extractIndexMaps(html) {
  const sections = {
    byDifficulty: captureSortSection(html, 'By Difficulty'),
    byType: captureSortSection(html, 'By Type'),
    byAuthor: captureSortSection(html, 'By Author')
  };

  const bySlug = new Map();
  for (const [key, sectionHtml] of Object.entries(sections)) {
    for (const entry of extractGroupedLinks(sectionHtml)) {
      if (!bySlug.has(entry.slug)) {
        bySlug.set(entry.slug, {});
      }
      const target = bySlug.get(entry.slug);
      if (key === 'byDifficulty') target.difficulty = entry.group;
      if (key === 'byType') target.type = entry.group;
      if (key === 'byAuthor') target.authorGroup = entry.group;
    }
  }

  return { bySlug };
}

function captureSortSection(html, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<h3 class="poem-sort-method">${escaped}<\\/h3>[\\s\\S]*?<div class="poem-results">([\\s\\S]*?)<\\/div>\\s*(?:<h3 class="poem-sort-method">|<\\/div><!-- close poem-sorting -->)`, 'i');
  return html.match(pattern)?.[1] || '';
}

function extractGroupedLinks(sectionHtml) {
  const entries = [];
  const regex = /<h4>\s*([^<]+?)\s*<\/h4><ul class='titles'>([\s\S]*?)<\/ul>/g;
  for (const match of sectionHtml.matchAll(regex)) {
    const group = normalizeWhitespace(decodeHtmlEntities(match[1]));
    const linksHtml = match[2] || '';
    for (const linkMatch of linksHtml.matchAll(/<li><a href="([^"]+)">([\s\S]*?)<\/a><\/li>/g)) {
      const url = linkMatch[1];
      const slug = url.replace(/\/$/, '').split('/').at(-1);
      entries.push({
        group,
        slug,
        title: normalizeWhitespace(decodeHtmlEntities(stripTags(linkMatch[2])))
      });
    }
  }
  return entries;
}

function extractStanzaLineCounts(rhymeHtml) {
  const chunks = String(rhymeHtml || '')
    .split(/<p><br\/?><\/p>/i)
    .map((chunk) => countMatches(chunk, /name="lrhyme-\d+-\d+"/g))
    .filter((count) => count > 0);

  return chunks.length ? chunks : [];
}

function sliceSchemeByCounts(scheme, counts) {
  if (!counts.length) {
    return scheme ? [canonicalizeRhymeScheme(scheme)] : [];
  }

  const letters = String(scheme || '').split('');
  let cursor = 0;
  return counts.map((count) => {
    const slice = letters.slice(cursor, cursor + count).join('');
    cursor += count;
    return canonicalizeRhymeScheme(slice);
  });
}

function buildPoemText(lines, stanzaLineCounts) {
  const nonBlankLines = lines.map((line) => line.text);
  if (!stanzaLineCounts.length) {
    return nonBlankLines.join('\n');
  }

  const stanzas = [];
  let cursor = 0;
  for (const count of stanzaLineCounts) {
    stanzas.push(nonBlankLines.slice(cursor, cursor + count).join('\n'));
    cursor += count;
  }

  if (cursor < nonBlankLines.length) {
    stanzas.push(nonBlankLines.slice(cursor).join('\n'));
  }

  return stanzas.filter(Boolean).join('\n\n');
}

export function extractLineSyllables(bodyHtml, canonicalStressRaw = '', canonicalStressPattern = '') {
  const source = String(bodyHtml || '');
  const matches = extractBalancedSyllableSpans(source);
  const syllables = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const attrs = match.attrs || '';
    const innerHtml = match.innerHtml || '';
    const nextStart = matches[index + 1]?.index ?? source.length;
    const trailingHtml = source.slice(match.end, nextStart);
    const id = attributeValue(attrs, 'id') || '';
    const rawText = extractSyllableText(innerHtml);
    const rawStressMark = decodeHtmlEntities(attributeValue(attrs, 'data-stress') || '');

    syllables.push({
      index,
      id,
      text: rawText.trim(),
      rawText,
      normalizedText: normalizeWhitespace(rawText),
      canonicalStress: canonicalStressPattern[index] || '',
      canonicalStressRaw: canonicalStressRaw[index] || '',
      rawStressMark,
      footBoundaryAfter: /prosody-footmarker/i.test(innerHtml),
      caesuraAfter: /class="caesura"/i.test(trailingHtml),
      discrepant: hasBooleanAttribute(attrs, 'discrepant'),
      rawAttributes: {
        real: decodeHtmlEntities(attributeValue(attrs, 'real') || ''),
        dataStress: rawStressMark,
        onclick: attributeValue(attrs, 'onclick') || ''
      },
      address: parseSyllableAddress(id)
    });
  }

  return syllables;
}

function extractBalancedSyllableSpans(source) {
  const spans = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('<span class="prosody-syllable"', cursor);
    if (start < 0) break;

    const openEnd = source.indexOf('>', start);
    if (openEnd < 0) break;

    let depth = 1;
    let scan = openEnd + 1;
    while (depth > 0 && scan < source.length) {
      const nextOpen = source.indexOf('<span', scan);
      const nextClose = source.indexOf('</span>', scan);
      if (nextClose < 0) break;

      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        scan = nextOpen + 5;
      } else {
        depth -= 1;
        scan = nextClose + 7;
      }
    }

    if (depth !== 0) break;

    const openTag = source.slice(start, openEnd + 1);
    spans.push({
      index: start,
      end: scan,
      attrs: openTag.match(/^<span class="prosody-syllable"([^>]*)>/i)?.[1] || '',
      innerHtml: source.slice(openEnd + 1, scan - 7)
    });
    cursor = scan;
  }

  return spans;
}

function parseSyllableAddress(syllableId) {
  const match = String(syllableId || '').match(/prosody-real-\d+-(\d+)-(\d+)-(\d+)/);
  if (!match) return null;
  return {
    footIndex: Number(match[1]),
    groupIndex: Number(match[2]),
    positionIndex: Number(match[3])
  };
}

function extractSyllableText(innerHtml) {
  return decodeHtmlEntities(
    stripTags(
      String(innerHtml || '')
        .replace(/<span class="prosody-footmarker"[\s\S]*?<\/span>/gi, '')
    )
  ).replace(/\u00a0/g, ' ');
}

function reconstructLineText(bodyHtml) {
  const cleaned = String(bodyHtml || '')
    .replace(/<span[^>]*style="display:none;"[\s\S]*?<\/span>/gi, '')
    .replace(/<span class="caesura"[\s\S]*?<\/span>/gi, '')
    .replace(/<button[\s\S]*?<\/button>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/\s*<\/?div[^>]*>\s*/gi, '')
    .replace(/\s*<\/?p[^>]*>\s*/gi, '');

  const text = decodeHtmlEntities(stripTags(cleaned))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function parseMeterKey(answer, lineGroupIndex) {
  if (!answer) return '';
  const footPattern = answer.split('(')[0];
  const footCounts = answer.match(/\d+/g) || [];
  const count = footCounts[Math.max(0, lineGroupIndex - 1)] || footCounts[0] || '';
  const family = FOOT_PATTERN_TO_FAMILY.get(footPattern) || '';
  const size = FOOT_COUNT_TO_LABEL.get(String(count)) || '';
  return family && size ? `${family}_${size}` : '';
}

function inferProfileHint({ author, year }) {
  if (/Shakespeare|Sidney|Spenser|Drayton|Milton|Donne|Herbert|Vaughan|Marvell|Wyatt|Surrey/i.test(author || '')) {
    return 'early_modern';
  }

  if (/Newton|Watts|Wesley/i.test(author || '')) {
    return 'hymn';
  }

  if (typeof year === 'number' && year <= 1700) {
    return 'early_modern';
  }

  if (/Dickinson|Hopkins|Hardy|Yeats|Frost|Blake|Browning/i.test(author || '')) {
    return 'modern';
  }

  return 'modern';
}

function parseYear(value) {
  const match = String(value || '').match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

function attributeValue(attrs, name) {
  return attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '';
}

function hasBooleanAttribute(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|$)`, 'i').test(String(attrs || ''));
}

async function fetchCachedText(url, filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const text = await response.text();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf8');
    return text;
  }
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value) {
  const decoded = String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_, name) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? `&${name};`);
  return repairMojibake(decoded);
}

function normalizeWhitespace(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(value, regex) {
  return [...String(value || '').matchAll(regex)].length;
}

function unique(values) {
  return [...new Set(values)];
}

function repairMojibake(value) {
  const source = String(value || '');
  if (!/[Ãâ€]/.test(source)) {
    return source;
  }

  try {
    const repaired = Buffer.from(source, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') ? source : repaired;
  } catch {
    return source;
  }
}
