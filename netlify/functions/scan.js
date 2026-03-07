import { dictionary as cmuDictionary } from 'cmu-pronouncing-dictionary';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
export const API_VERSION = 'v1';
const MAX_POEM_CHARS = 24000;
const MAX_BATCH_POEMS = 10;
const MAX_BATCH_CHARS = 120000;

const SCAN_PROFILES = {
  modern: {
    key: 'modern',
    label: 'Modern American',
    description: 'Default contemporary pronunciation assumptions.',
    extraReductions: {},
    contextualCostShift: 0,
    promoteCostShift: 0,
    poeticCostShift: 0,
    commonMeterBonus: 0,
    pentameterBonus: 0,
    tetrameterBonus: 0,
    syllabicEd: false
  },
  early_modern: {
    key: 'early_modern',
    label: 'Early Modern leaning',
    description: 'More permissive archaic contractions, syllabic endings, and Renaissance-era variants.',
    extraReductions: {
      consumed: [['u', 's']],
      nourishd: [['u', 's']],
      nourished: [['u', 's']],
      ruined: [['u', 's']],
      ruined: [['u', 's']],
      temperate: [['u', 's', 'u']],
      wandering: [['u', 's', 'u']]
    },
    contextualCostShift: -0.22,
    promoteCostShift: -0.24,
    poeticCostShift: -0.18,
    commonMeterBonus: 0,
    pentameterBonus: 0.4,
    tetrameterBonus: 0,
    syllabicEd: true
  },
  hymn: {
    key: 'hymn',
    label: 'Hymn / Common Meter',
    description: 'Biases hymnbook-style common meter and common poetic reductions used in sung verse.',
    extraReductions: {
      spirit: [['s', 'u']],
      over: [['s', 'u']],
      heaven: [['s']],
      every: [['s', 'u']],
      flower: [['s']],
      power: [['s']],
      toward: [['s']],
      towards: [['s']]
    },
    contextualCostShift: -0.28,
    promoteCostShift: -0.35,
    poeticCostShift: -0.28,
    commonMeterBonus: 10,
    pentameterBonus: 0,
    tetrameterBonus: 0.32,
    syllabicEd: false
  }
};

const METER_LIBRARY = [
  { key: 'iambic_monometer', label: 'iambic monometer', pattern: ['u', 's'], feet: 1, family: 'iambic' },
  { key: 'iambic_dimeter', label: 'iambic dimeter', pattern: ['u', 's'], feet: 2, family: 'iambic' },
  { key: 'iambic_trimeter', label: 'iambic trimeter', pattern: ['u', 's'], feet: 3, family: 'iambic' },
  { key: 'iambic_tetrameter', label: 'iambic tetrameter', pattern: ['u', 's'], feet: 4, family: 'iambic' },
  { key: 'iambic_pentameter', label: 'iambic pentameter', pattern: ['u', 's'], feet: 5, family: 'iambic' },
  { key: 'iambic_hexameter', label: 'iambic hexameter', pattern: ['u', 's'], feet: 6, family: 'iambic' },
  { key: 'trochaic_dimeter', label: 'trochaic dimeter', pattern: ['s', 'u'], feet: 2, family: 'trochaic' },
  { key: 'trochaic_trimeter', label: 'trochaic trimeter', pattern: ['s', 'u'], feet: 3, family: 'trochaic' },
  { key: 'trochaic_tetrameter', label: 'trochaic tetrameter', pattern: ['s', 'u'], feet: 4, family: 'trochaic' },
  { key: 'trochaic_pentameter', label: 'trochaic pentameter', pattern: ['s', 'u'], feet: 5, family: 'trochaic' },
  { key: 'anapestic_dimeter', label: 'anapestic dimeter', pattern: ['u', 'u', 's'], feet: 2, family: 'anapestic' },
  { key: 'anapestic_trimeter', label: 'anapestic trimeter', pattern: ['u', 'u', 's'], feet: 3, family: 'anapestic' },
  { key: 'anapestic_tetrameter', label: 'anapestic tetrameter', pattern: ['u', 'u', 's'], feet: 4, family: 'anapestic' },
  { key: 'dactylic_dimeter', label: 'dactylic dimeter', pattern: ['s', 'u', 'u'], feet: 2, family: 'dactylic' },
  { key: 'dactylic_trimeter', label: 'dactylic trimeter', pattern: ['s', 'u', 'u'], feet: 3, family: 'dactylic' },
  { key: 'dactylic_tetrameter', label: 'dactylic tetrameter', pattern: ['s', 'u', 'u'], feet: 4, family: 'dactylic' },
  { key: 'amphibrachic_dimeter', label: 'amphibrachic dimeter', pattern: ['u', 's', 'u'], feet: 2, family: 'amphibrachic' },
  { key: 'amphibrachic_trimeter', label: 'amphibrachic trimeter', pattern: ['u', 's', 'u'], feet: 3, family: 'amphibrachic' },
  { key: 'amphibrachic_tetrameter', label: 'amphibrachic tetrameter', pattern: ['u', 's', 'u'], feet: 4, family: 'amphibrachic' },
  { key: 'accentual_loose', label: 'accentual / mixed meter', pattern: [], feet: 0, family: 'accentual' }
];

const FUNCTION_WORDS = new Set([
  'a','an','and','as','at','be','but','by','can','could','do','dost','doth','ere','for','from','had','has','have','he','her','here','him','his','i','if','in','is','it','its','may','me','might','more','must','my','nor','not','of','on','or','our','ours','shall','she','should','since','so','such','than','that','the','thee','their','them','then','there','these','they','thine','this','those','thou','thy','tis','to','up','us','was','we','were','what','when','where','which','who','whom','why','will','with','would','you','your','yours'
]);

const CLITICS = new Map([
  ["o'er", 'over'],
  ["e'en", 'even'],
  ["heav'n", 'heaven'],
  ["ne'er", 'never'],
  ["ev'ry", 'every'],
  ["int'rest", 'interest'],
  ["pow'r", 'power'],
  ["flow'r", 'flower'],
  ["hour", 'hour']
]);

const OPTIONAL_POETIC_REDUCTIONS = new Map([
  ['every', [['s', 'u']]],
  ['even', [['s']]],
  ['fire', [['s']]],
  ['flower', [['s']]],
  ['heaven', [['s']]],
  ['hour', [['s']]],
  ['over', [['s', 'u']]],
  ['power', [['s']]],
  ['toward', [['s']]],
  ['towards', [['s']]]
]);

const STRESS_SHIFT_SUFFIXES = ['ary', 'ery', 'ory', 'ity'];

const STRESSABLE_FUNCTION_WORDS = new Set([
  'as', 'at', 'but', 'by', 'for', 'from', 'if', 'in', 'nor', 'of', 'on', 'or', 'than', 'through', 'to', 'under', 'with', 'within', 'without'
]);

const NOMINAL_CONTEXT_WORDS = new Set([
  'a', 'an', 'at', 'before', 'behind', 'beneath', 'beside', 'by', 'for', 'from', 'her', 'his', 'in', 'my', 'near', 'no', 'of', 'on', 'our', 'that', 'the', 'their', 'these', 'this', 'those', 'thy', 'under', 'your'
]);

const NOMINAL_FOLLOWER_WORDS = new Set([
  'after', 'around', 'as', 'at', 'before', 'beside', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'over', 'through', 'to', 'toward', 'towards', 'under', 'with', 'within'
]);

const VOWELS = /[aeiouy]+/g;
const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ'’-]+/g;

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders({
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      })
    });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.', apiVersion: API_VERSION }, 405);
  }

  try {
    const body = await request.json();
    const wantSummary = body?.includeSummary !== false;

    if (Array.isArray(body?.poems)) {
      const batch = await scanBatch({
        poems: body.poems,
        includeSummary: wantSummary,
        profile: body?.profile,
        overrides: body?.overrides
      });
      return json(batch);
    }

    const poem = String(body?.poem || '');
    const stream = body?.stream === true;
    const profileKey = body?.profile || 'modern';
    const overrides = normalizeOverrides(body?.overrides);

    validatePoemLength(poem);

    if (!poem.trim()) {
      return json({ error: 'Please paste a poem first.', apiVersion: API_VERSION }, 400);
    }

    if (stream) {
      return streamAnalysis({ poem, wantSummary, profileKey, overrides });
    }

    const analysis = scanPoem({
      poem,
      profileKey,
      overrides
    });
    const summary = wantSummary ? await generateSummary(analysis).catch(() => fallbackSummary(analysis)) : null;

    return json({
      apiVersion: API_VERSION,
      kind: 'single',
      ...analysis,
      summary
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return json({ error: error?.message || 'Unexpected error.', apiVersion: API_VERSION }, status);
  }
};

export function scanPoem({
  poem,
  profileKey = 'modern',
  overrides = {},
  id = '',
  title = ''
} = {}) {
  validatePoemLength(poem);
  const profile = resolveProfile(profileKey);
  const normalizedOverrides = normalizeOverrides(overrides);
  const analysis = analyzePoem(poem, { profile, overrides: normalizedOverrides });
  return {
    id,
    title,
    profile: {
      key: profile.key,
      label: profile.label,
      description: profile.description
    },
    ...analysis
  };
}

export async function scanBatch({
  poems,
  includeSummary = false,
  profile: defaultProfile = 'modern',
  overrides: defaultOverrides = {}
} = {}) {
  if (!Array.isArray(poems) || poems.length === 0) {
    const error = new Error('Batch requests must include at least one poem.');
    error.statusCode = 400;
    throw error;
  }

  if (poems.length > MAX_BATCH_POEMS) {
    const error = new Error(`Batch requests are limited to ${MAX_BATCH_POEMS} poems.`);
    error.statusCode = 413;
    throw error;
  }

  const totalChars = poems.reduce((sum, entry) => sum + String(entry?.poem || '').length, 0);
  if (totalChars > MAX_BATCH_CHARS) {
    const error = new Error(`Batch requests are limited to ${MAX_BATCH_CHARS} characters.`);
    error.statusCode = 413;
    throw error;
  }

  const analyses = [];
  for (const [index, entry] of poems.entries()) {
    const poem = String(entry?.poem || '');
    validatePoemLength(poem);

    if (!poem.trim()) {
      const error = new Error(`Batch poem ${index + 1} is empty.`);
      error.statusCode = 400;
      throw error;
    }

    const analysis = scanPoem({
      poem,
      profileKey: entry?.profile || defaultProfile,
      overrides: entry?.overrides || defaultOverrides,
      id: String(entry?.id || `poem-${index + 1}`),
      title: String(entry?.title || '')
    });

    analyses.push({
      ...analysis,
      summary: includeSummary ? await generateSummary(analysis).catch(() => fallbackSummary(analysis)) : null
    });
  }

  return {
    apiVersion: API_VERSION,
    kind: 'batch',
    count: analyses.length,
    analyses
  };
}

function analyzePoem(poem, context) {
  const structure = buildPoemStructure(poem);
  const analyzedLines = structure.lineObjects.map((line) => {
    return line.blank ? createBlankLineAnalysis(line) : analyzeLine(line.text, line.index, context);
  });

  return finalizeAnalysis(structure, analyzedLines, context);
}

function buildPoemStructure(poem) {
  const normalized = poem.replace(/\r\n/g, '\n').trimEnd();
  const rawLines = normalized.split('\n');

  const lineObjects = rawLines.map((text, index) => ({
    index,
    text,
    blank: text.trim().length === 0
  }));

  const stanzas = [];
  let current = [];
  for (const line of lineObjects) {
    if (line.blank) {
      if (current.length) stanzas.push(current), current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) stanzas.push(current);

  return {
    normalized,
    lineObjects,
    stanzas
  };
}

function createBlankLineAnalysis(line) {
  return {
    index: line.index,
    text: line.text,
    blank: true,
    tag: '',
    confidence: 0,
    scans: [],
    tokens: [],
    rhymeLetter: '',
    rhymeWord: '',
    rhymeMatchType: ''
  };
}

function hydrateLineMetadata(line) {
  const topVariants = line.scans?.[0]?.variants || [];
  return {
    ...line,
    tokens: (line.tokens || []).map((token, index) => ({
      ...token,
      activeVariant: topVariants[index] || null
    }))
  };
}

function finalizeAnalysis(structure, analyzedLines, context) {
  const { normalized, stanzas } = structure;
  const finalLines = [...analyzedLines];
  const stanzaResults = stanzas.map((stanzaLines, stanzaIndex) => {
    const members = stanzaLines.map((line) => analyzedLines[line.index]);
    const selection = selectStanzaReadings(members, context);

    stanzaLines.forEach((line, memberIndex) => {
      finalLines[line.index] = selection.lines[memberIndex];
    });

    return {
      stanzaIndex,
      lineIndexes: stanzaLines.map((line) => line.index),
      dominantMeterKey: selection.dominantMeterKey,
      dominantMeterLabel: selection.dominantMeterLabel,
      strength: selection.strength,
      patternLabel: selection.patternLabel
    };
  });

  const meterTally = new Map();
  finalLines.filter((l) => !l.blank).forEach((line) => {
    const top = line.scans[0];
    if (top) meterTally.set(top.meterKey, (meterTally.get(top.meterKey) || 0) + top.score);
  });

  const overall = inferOverallMeter(finalLines, stanzaResults, meterTally, context);
  const overallLabel = overall === 'common_meter'
    ? 'common meter'
    : (METER_LIBRARY.find((m) => m.key === overall) || METER_LIBRARY.at(-1)).label;
  const rhymeAnalysis = buildRhymeAnalysis(structure, finalLines, context);
  const form = detectPoeticForm(structure, rhymeAnalysis.annotatedLines, stanzaResults, rhymeAnalysis.rhyme, overallLabel, context);

  return {
    poem: normalized,
    overallMeter: overallLabel,
    stanzaResults,
    lines: rhymeAnalysis.annotatedLines,
    rhyme: rhymeAnalysis.rhyme,
    form,
    diagnostics: buildDiagnostics(rhymeAnalysis.annotatedLines, stanzaResults, form)
  };
}

function streamAnalysis({ poem, wantSummary, profileKey = 'modern', overrides = {} }) {
  const encoder = new TextEncoder();
  const structure = buildPoemStructure(poem);
  const context = {
    profile: resolveProfile(profileKey),
    overrides: normalizeOverrides(overrides)
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`${JSON.stringify({ apiVersion: API_VERSION, ...payload })}\n`));
      };

      try {
        const analyzedLines = Array.from({ length: structure.lineObjects.length });

        for (const line of structure.lineObjects) {
          const result = line.blank ? createBlankLineAnalysis(line) : analyzeLine(line.text, line.index, context);
          analyzedLines[line.index] = result;
          send({ type: 'line', line: result });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const analysis = finalizeAnalysis(structure, analyzedLines, context);
        send({
          type: 'complete',
          analysis: {
            ...analysis,
            profile: {
              key: context.profile.key,
              label: context.profile.label,
              description: context.profile.description
            },
            summary: null
          }
        });

        if (wantSummary) {
          const summary = await generateSummary(analysis).catch(() => fallbackSummary(analysis));
          send({ type: 'summary', summary });
        }
      } catch (error) {
        send({ type: 'error', error: error?.message || 'Unexpected error.' });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: corsHeaders({
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-scansion-api-version': API_VERSION
    })
  });
}

function analyzeLine(text, index, context) {
  const tokens = tokenize(text).map((token) => ({ ...token, lineIndex: index }));
  const candidates = expandTokenCandidates(tokens, context);
  const lineCandidates = composeLineCandidates(candidates.map((entry) => entry.active), 192, context?.profile);
  const ranked = rankMeters(lineCandidates, tokens, context);
  const scans = ranked.slice(0, 10).map((scan, i) => formatScan(scan, i === 0, tokens, text));
  const top = scans[0] || {
    meterLabel: 'accentual / mixed meter',
    confidence: 50
  };

  return hydrateLineMetadata({
    index,
    text,
    blank: false,
    tag: top.meterLabel,
    confidence: top.confidence,
    scans,
    tokens: tokens.map((token, i) => ({
      ...token,
      overrideApplied: Boolean(candidates[i].override),
      options: candidates[i].options.map((candidate) => ({
        source: candidate.source,
        syllables: candidate.syllables,
        stressPattern: candidate.stress.join(''),
        pronunciation: candidate.pronunciation
      }))
    }))
  });
}

function tokenize(text) {
  const parts = [];
  let match;
  let tokenIndex = 0;
  while ((match = WORD_RE.exec(text)) !== null) {
    const raw = match[0];
    const cleaned = normalizeWord(raw);
    if (!cleaned) continue;
    parts.push({
      index: tokenIndex,
      raw,
      normalized: cleaned,
      isFunctionWord: FUNCTION_WORDS.has(cleaned),
      start: match.index,
      end: match.index + raw.length
    });
    tokenIndex += 1;
  }
  return parts;
}

function normalizeWord(word) {
  const normalized = word
    .toLowerCase()
    .replace(/[\u2019]/g, "'")
    .replace(/[’]/g, "'")
    .replace(/^[-']+|[-']+$/g, '')
    .replace(/[^a-z'\-]/g, '');

  return /[a-z]/.test(normalized) ? normalized : '';
}

function resolveProfile(profileKey) {
  return SCAN_PROFILES[profileKey] || SCAN_PROFILES.modern;
}

function normalizeOverrides(overrides) {
  const normalized = {
    tokens: {},
    words: {}
  };

  const tokenEntries = overrides?.tokens && typeof overrides.tokens === 'object' ? Object.entries(overrides.tokens) : [];
  for (const [key, value] of tokenEntries) {
    const override = normalizeOverrideValue(value);
    if (!override) continue;
    normalized.tokens[key] = override;
  }

  const wordEntries = overrides?.words && typeof overrides.words === 'object' ? Object.entries(overrides.words) : [];
  for (const [key, value] of wordEntries) {
    const override = normalizeOverrideValue(value);
    if (!override) continue;
    normalized.words[String(key).toLowerCase()] = override;
  }

  return normalized;
}

function normalizeOverrideValue(value) {
  const stressPattern = String(value?.stressPattern || '').toLowerCase().replace(/[^su]/g, '');
  if (!stressPattern) return null;
  return {
    stressPattern,
    pronunciation: String(value?.pronunciation || value?.label || 'user override'),
    label: String(value?.label || 'user override')
  };
}

function getOverrideCandidate(token, overrides) {
  if (!token || !overrides) return null;
  const tokenKey = `${token.lineIndex ?? token.line ?? ''}:${token.index}`;
  const override = overrides.tokens?.[tokenKey] || overrides.words?.[token.normalized];
  if (!override) return null;

  return {
    pronunciation: override.pronunciation || `override:${token.raw}`,
    syllables: override.stressPattern.length,
    stress: override.stressPattern.split(''),
    source: 'user-override'
  };
}

function validatePoemLength(poem) {
  if (String(poem || '').length > MAX_POEM_CHARS) {
    const error = new Error(`Poems are limited to ${MAX_POEM_CHARS} characters.`);
    error.statusCode = 413;
    throw error;
  }
}

function expandTokenCandidates(tokens, context) {
  return tokens.map((token, index) => {
    const base = lookupPronunciations(token.normalized, token.raw, token.isFunctionWord, context?.profile);
    const contextual = buildContextualCandidates(token, base, tokens[index - 1], tokens[index + 1], context?.profile);
    const ranked = rankPronunciationCandidates(dedupeCandidates([...base, ...contextual]), context?.profile).slice(0, 8);
    const override = getOverrideCandidate(token, context?.overrides);

    if (!override) {
      return {
        options: ranked,
        active: ranked
      };
    }

    const merged = rankPronunciationCandidates(dedupeCandidates([override, ...ranked]), context?.profile).slice(0, 8);
    return {
      override,
      options: merged,
      active: [override]
    };
  });
}

function lookupPronunciations(normalized, raw, isFunctionWord, profile) {
  const variants = new Set([normalized]);
  if (CLITICS.has(normalized)) variants.add(CLITICS.get(normalized));
  if (normalized.endsWith("'d")) variants.add(normalized.replace(/'d$/, 'ed'));
  if (normalized.endsWith("'st")) variants.add(normalized.replace(/'st$/, 'est'));
  if (normalized.endsWith("in'")) variants.add(normalized.replace(/in'$/, 'ing'));
  if (normalized.includes('-')) variants.add(normalized.replace(/-/g, ''));
  let found = collectDictionaryPronunciations(variants, normalized);

  if (!found.length) {
    expandArchaicSpellings(normalized).forEach((variant) => variants.add(variant));
    found = collectDictionaryPronunciations(variants, normalized);
  }

  found.push(...buildConstructedArchaicCandidates(normalized));

  if (found.length) {
    found.push(...found.flatMap((entry) => {
      return buildCompressedStressVariants(entry.stress).map((stress, index) => ({
        ...entry,
        syllables: stress.length,
        stress,
        source: `${entry.source}-compressed-${index + 1}`
      }));
    }));
    found.push(...found.flatMap((entry) => {
      return buildPoeticStressVariants(normalized, entry.stress, profile).map((stress, index) => ({
        ...entry,
        syllables: stress.length,
        stress,
        source: `${entry.source}-poetic-${index + 1}`
      }));
    }));
    found.push(...buildSyllabicEdCandidates(normalized, found, profile));
    found.push(...buildHistoricAteCandidates(normalized, found, profile));

    if (isFunctionWord) {
      found.push(...found.map((entry) => ({
        ...entry,
        stress: entry.stress.map((v, i) => (i === 0 ? 'u' : v)),
        source: `${entry.source}-demoted`
      })));
    }
    return found;
  }

  return heuristicPronunciations(normalized, raw, isFunctionWord, profile);
}

function collectDictionaryPronunciations(variants, normalized) {
  const found = [];
  for (const variant of variants) {
    const direct = findDictionaryPronunciations(variant);
    if (!direct.length) continue;
    found.push(...direct.map((entry) => ({
      ...entry,
      source: variant === normalized ? 'cmu' : 'normalized-cmu'
    })));
  }
  return found;
}

function expandArchaicSpellings(normalized) {
  const variants = new Set();

  if (normalized.endsWith("'st")) {
    variants.add(normalized.replace(/'st$/, ''));
    variants.add(normalized.replace(/'st$/, 'e'));
  }

  if (normalized.endsWith('st') && normalized.length > 4) {
    variants.add(normalized.replace(/st$/, ''));
    variants.add(normalized.replace(/st$/, 'e'));
  }

  if (normalized.endsWith('eth') && normalized.length > 4) {
    variants.add(normalized.replace(/eth$/, ''));
    variants.add(normalized.replace(/eth$/, 'e'));
    variants.add(normalized.replace(/eth$/, 'es'));
  }

  return [...variants].filter(Boolean);
}

function buildConstructedArchaicCandidates(normalized) {
  if (!normalized.endsWith('eth') || normalized.length <= 4) return [];

  const bases = [
    normalized.replace(/eth$/, ''),
    normalized.replace(/eth$/, 'e')
  ];

  const candidates = [];
  for (const base of bases) {
    for (const entry of findDictionaryPronunciations(base)) {
      candidates.push({
        pronunciation: `constructed:${normalized}<-${base}`,
        syllables: entry.stress.length + 1,
        stress: [...entry.stress, 'u'],
        source: 'constructed-cmu'
      });
    }
  }

  return candidates;
}

function findDictionaryPronunciations(word) {
  const arpabet = cmuDictionary[word];
  if (!arpabet) return [];
  const entries = Array.isArray(arpabet) ? arpabet : [arpabet];
  return entries.flatMap((pronunciation) => {
    return extractStressVariants(pronunciation).map(({ stress, variantType }) => ({
      pronunciation,
      syllables: stress.length,
      stress,
      variantType
    }));
  });
}

function extractStressVariants(pronunciation) {
  const levels = pronunciation
    .split(/\s+/)
    .filter(Boolean)
    .map((phoneme) => {
      const m = phoneme.match(/[012]$/);
      if (!m) return null;
      return m[0];
    })
    .filter(Boolean);

  const primary = levels.map((level) => (level === '1' ? 's' : 'u'));
  const variants = [{ stress: primary, variantType: 'primary' }];

  if (levels.includes('2')) {
    const secondaryStrong = levels.map((level) => (level === '0' ? 'u' : 's'));
    if (secondaryStrong.join('') !== primary.join('')) {
      variants.push({ stress: secondaryStrong, variantType: 'secondary-strong' });
    }
  }

  return variants;
}

function buildCompressedStressVariants(stress) {
  if (stress.length < 3 || (stress.length === 3 && stress[0] === 's')) return [];

  const variants = new Map();
  const seen = new Set([stress.join('')]);
  const queue = [{ pattern: stress, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= 2) continue;

    for (let i = 0; i < current.pattern.length - 1; i += 1) {
      if (current.pattern[i] !== 'u' || current.pattern[i + 1] !== 'u') continue;
      const collapsed = [...current.pattern.slice(0, i), 'u', ...current.pattern.slice(i + 2)];
      const key = collapsed.join('');
      if (seen.has(key) || collapsed.length < 2) continue;
      seen.add(key);
      variants.set(key, collapsed);
      queue.push({ pattern: collapsed, depth: current.depth + 1 });
    }
  }

  return [...variants.values()];
}

function buildPoeticStressVariants(normalized, stress, profile) {
  const variants = new Map();

  for (const reduced of OPTIONAL_POETIC_REDUCTIONS.get(normalized) || []) {
    variants.set(reduced.join(''), reduced);
  }

  for (const reduced of profile?.extraReductions?.[normalized] || []) {
    variants.set(reduced.join(''), reduced);
  }

  if (
    stress.length >= 4 &&
    STRESS_SHIFT_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) &&
    stress[stress.length - 2] === 'u' &&
    stress[stress.length - 1] === 'u'
  ) {
    const shifted = [...stress.slice(0, -1), 's'];
    variants.set(shifted.join(''), shifted);
  }

  return [...variants.values()].filter((variant) => variant.join('') !== stress.join(''));
}

function buildSyllabicEdCandidates(normalized, entries, profile) {
  if (!profile?.syllabicEd) return [];
  if (!normalized.endsWith('ed') || normalized.length <= 4) return [];

  const variants = [];
  for (const entry of entries) {
    if (!entry.source.includes('cmu') || entry.syllables < 1 || entry.stress.at(-1) === 'u') continue;
    const expanded = [...entry.stress, 'u'];
    variants.push({
      ...entry,
      syllables: expanded.length,
      stress: expanded,
      source: `${entry.source}-syllabic-ed`
    });
  }

  return variants;
}

function buildHistoricAteCandidates(normalized, entries, profile) {
  if (profile?.key !== 'early_modern') return [];
  if (!normalized.endsWith('ate') || normalized.length <= 5) return [];

  const variants = [];
  for (const entry of entries) {
    if (!entry.source.includes('cmu') || entry.syllables !== 2) continue;
    const expanded = ['s', 'u', 's'];
    variants.push({
      ...entry,
      pronunciation: `historical:${normalized}`,
      syllables: expanded.length,
      stress: expanded,
      source: `${entry.source}-historic-ate`
    });
  }

  return variants;
}

function heuristicPronunciations(normalized, raw, isFunctionWord, profile) {
  const syllableCount = estimateSyllables(normalized);
  const primary = [];

  if (syllableCount === 1) {
    primary.push(isFunctionWord ? ['u'] : ['s']);
    primary.push(['s']);
    primary.push(['u']);
  } else if (syllableCount === 2) {
    primary.push(['u', 's']);
    primary.push(['s', 'u']);
  } else {
    const rise = Array.from({ length: syllableCount }, (_, i) => (i === syllableCount - 1 ? 's' : 'u'));
    const lead = Array.from({ length: syllableCount }, (_, i) => (i === 0 ? 's' : 'u'));
    const penult = Array.from({ length: syllableCount }, (_, i) => (i === syllableCount - 2 ? 's' : 'u'));
    primary.push(rise, lead, penult);
  }

  return primary.map((stress, idx) => ({
    pronunciation: `heuristic:${raw}`,
    syllables: syllableCount,
    stress,
    source: `${idx === 0 ? 'heuristic-primary' : 'heuristic-alt'}${profile?.key === 'early_modern' && normalized.endsWith('ed') ? '-historic' : ''}`
  }));
}

function buildContextualCandidates(token, candidates, prevToken, nextToken, profile) {
  const contextual = [];

  if (token.isFunctionWord) {
    for (const candidate of candidates) {
      if (candidate.syllables !== 1 || candidate.stress[0] !== 'u') continue;
      contextual.push({
        ...candidate,
        stress: ['s'],
        source: `${candidate.source}-${STRESSABLE_FUNCTION_WORDS.has(token.normalized) ? 'promoted' : 'promoted-rare'}${profile?.key === 'hymn' ? '-profile' : ''}`
      });
    }
  }

  if (shouldConsiderNominalStress(token, prevToken, nextToken)) {
    for (const candidate of candidates) {
      if (
        candidate.syllables !== 2 ||
        candidate.stress.join('') !== 'us' ||
        !candidate.source.includes('cmu') ||
        candidate.source.includes('compressed') ||
        candidate.source.includes('poetic') ||
        candidate.source.includes('demoted')
      ) {
        continue;
      }

      contextual.push({
        ...candidate,
        stress: ['s', 'u'],
        source: `${candidate.source}-contextual-nominal`
      });
    }
  }

  if (!token.isFunctionWord) {
    for (const candidate of candidates) {
      if (
        candidate.syllables !== 1 ||
        candidate.stress[0] !== 's' ||
        !candidate.source.includes('cmu') ||
        candidate.source.includes('demoted') ||
        candidate.source.includes('poetic') ||
        candidate.source.includes('compressed')
      ) {
        continue;
      }

      contextual.push({
        ...candidate,
        stress: ['u'],
        source: `${candidate.source}-flex-weak`
      });
    }
  }

  if (token.raw.includes('-')) {
    for (const candidate of candidates) {
      if (
        candidate.syllables !== 2 ||
        candidate.stress.join('') === 'us' ||
        !candidate.source.includes('cmu')
      ) {
        continue;
      }

      contextual.push({
        ...candidate,
        stress: ['u', 's'],
        source: `${candidate.source}-compound-shift`
      });
    }
  }

  return contextual;
}

function shouldConsiderNominalStress(token, prevToken, nextToken) {
  if (token.isFunctionWord) return false;
  const prev = prevToken?.normalized || '';
  const next = nextToken?.normalized || '';
  return NOMINAL_CONTEXT_WORDS.has(prev) || NOMINAL_FOLLOWER_WORDS.has(next);
}

function rankPronunciationCandidates(candidates, profile) {
  return [...candidates].sort((a, b) => pronunciationCandidateCost(a, profile) - pronunciationCandidateCost(b, profile));
}

function pronunciationCandidateCost(candidate, profile) {
  const source = candidate.source;
  let cost = 0;

  if (source.startsWith('heuristic-alt')) cost += 5;
  else if (source.startsWith('heuristic-primary')) cost += 4;

  if (source.includes('normalized-cmu')) cost += 0.2;
  if (source.includes('constructed-cmu')) cost += 0.4;
  if (source.includes('demoted')) cost += 0.3;
  if (source.includes('poetic')) cost += 0.6;
  if (source.includes('contextual')) cost += 0.9;
  if (source.includes('promoted')) cost += 1.1;
  if (source.includes('promoted-rare')) cost += 0.8;
  if (source.includes('compressed')) cost += 1.2;
  if (source.includes('flex-weak')) cost += 1.35;
  if (source.includes('compound-shift')) cost += 1.1;
  if (source.includes('syllabic-ed')) cost += 0.5;
  if (source.includes('historic')) cost += 0.15;

  if (source.includes('poetic')) cost += profile?.poeticCostShift || 0;
  if (source.includes('contextual')) cost += profile?.contextualCostShift || 0;
  if (source.includes('promoted')) cost += profile?.promoteCostShift || 0;

  return cost + candidate.syllables * 0.01;
}

function estimateSyllables(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return 1;
  if (cleaned.length <= 3) return 1;
  const matches = cleaned.match(VOWELS) || [];
  let count = matches.length;
  const hasSyllabicLe = /[^aeiouy]le$/.test(cleaned) && !/([b-df-hj-np-tv-z])\1le$/.test(cleaned);
  if (cleaned.endsWith('e') && (!cleaned.endsWith('le') || !hasSyllabicLe) && count > 1) count -= 1;
  if (cleaned.endsWith('es') && count > 1) count -= 1;
  if (cleaned.endsWith('ed') && count > 1 && !/[td]ed$/.test(cleaned)) count -= 1;
  return Math.max(1, count);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = `${candidate.syllables}:${candidate.stress.join('')}:${candidate.pronunciation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function composeLineCandidates(tokenCandidates, limit = 128, profile) {
  if (!tokenCandidates.length) return [];
  let states = [{ pieces: [], stress: [], syllables: 0, sources: [] }];

  for (const options of tokenCandidates) {
    const next = [];
    for (const state of states) {
      for (const option of options) {
        next.push({
          pieces: [...state.pieces, option],
          stress: [...state.stress, ...option.stress],
          syllables: state.syllables + option.syllables,
          sources: [...state.sources, option.source]
        });
      }
    }
    next.sort((a, b) => scoreCandidateSimplicity(a, profile) - scoreCandidateSimplicity(b, profile));
    states = next.slice(0, limit);
  }

  return states;
}

function scoreCandidateSimplicity(candidate, profile) {
  return candidate.sources.reduce((sum, source) => {
    let cost = 0;
    if (source.startsWith('heuristic')) cost += 3;
    if (source.includes('compressed')) cost += 0.8;
    if (source.includes('constructed-cmu')) cost += 0.35;
    if (source.includes('poetic')) cost += 0.5;
    if (source.includes('contextual')) cost += 0.7;
    if (source.includes('promoted')) cost += 0.9;
    if (source.includes('promoted-rare')) cost += 0.7;
    if (source.includes('flex-weak')) cost += 1.1;
    if (source.includes('compound-shift')) cost += 0.8;
    if (source.includes('syllabic-ed')) cost += 0.45;
    if (source.includes('historic')) cost += 0.12;
    if (source.includes('poetic')) cost += profile?.poeticCostShift || 0;
    if (source.includes('contextual')) cost += profile?.contextualCostShift || 0;
    if (source.includes('promoted')) cost += profile?.promoteCostShift || 0;
    return sum + cost;
  }, 0) + candidate.syllables * 0.01;
}

function rankMeters(lineCandidates, tokens, context) {
  const results = [];

  for (const candidate of lineCandidates) {
    for (const meter of METER_LIBRARY) {
      if (meter.key === 'accentual_loose') continue;
      const scored = scoreAgainstMeter(candidate, meter, tokens, context);
      results.push(scored);
    }

    results.push(scoreAccentual(candidate, tokens, context));
  }

  results.sort((a, b) => a.penalty - b.penalty || b.confidence - a.confidence);
  return dedupeScans(results).slice(0, 8);
}

function scoreAgainstMeter(candidate, meter, tokens, context) {
  const profile = context?.profile;
  const target = Array.from({ length: meter.feet }).flatMap(() => meter.pattern);
  const actual = candidate.stress;
  const observations = [];
  let penalty = 0;
  const lengthDelta = actual.length - target.length;

  if (lengthDelta === 1 && actual[actual.length - 1] === 'u') {
    penalty += 0.8;
    observations.push('feminine ending');
  } else if (lengthDelta === 1) {
    penalty += 1.5;
    observations.push('extra syllable');
  } else if (lengthDelta === -1) {
    penalty += 1.35;
    observations.push('catalectic ending');
  } else if (Math.abs(lengthDelta) > 1) {
    penalty += Math.abs(lengthDelta) * 2.2;
    observations.push('syllable count drift');
  }

  const compareLength = Math.min(actual.length, target.length);
  for (let i = 0; i < compareLength; i += 1) {
    if (actual[i] !== target[i]) {
      penalty += 1.15;
    }
  }

  if (meter.family === 'iambic' && actual.length >= 2 && actual[0] === 's' && actual[1] === 'u') {
    penalty -= 0.45;
    observations.push('initial inversion');
  }

  if (profile?.key === 'hymn' && meter.family === 'iambic' && (meter.feet === 3 || meter.feet === 4)) {
    penalty -= profile.tetrameterBonus;
  }

  if (profile?.key === 'early_modern' && meter.key === 'iambic_pentameter') {
    penalty -= profile.pentameterBonus;
  }

  const heuristicCount = candidate.sources.filter((source) => source.startsWith('heuristic')).length;
  penalty += heuristicCount * 0.5;

  const footBreaks = inferFootBreaks(actual, meter.pattern.length);
  const stressString = actual.join('');
  const targetString = target.join('');
  const exactness = similarityScore(stressString, targetString);
  const confidence = clamp(Math.round(98 - penalty * 8 + exactness * 6), 50, 100);

  return {
    meterKey: meter.key,
    meterLabel: meter.label,
    candidate,
    penalty,
    confidence,
    target,
    observations,
    footBreaks,
    stressString,
    targetString,
    exactness
  };
}

function scoreAccentual(candidate, tokens, context) {
  const stresses = candidate.stress.filter((x) => x === 's').length;
  const heuristicCount = candidate.sources.filter((source) => source.startsWith('heuristic')).length;
  const irregularity = Math.abs(candidate.stress.length - stresses * 2);
  const penalty = 3 + irregularity * 0.6 + heuristicCount * 0.4 + (context?.profile?.key === 'hymn' ? 0.4 : 0);
  return {
    meterKey: 'accentual_loose',
    meterLabel: 'accentual / mixed meter',
    candidate,
    penalty,
    confidence: clamp(Math.round(72 - penalty * 4), 50, 84),
    target: [],
    observations: ['irregular line or mixed rhythm'],
    footBreaks: [],
    stressString: candidate.stress.join(''),
    targetString: '',
    exactness: 0.4
  };
}

function inferFootBreaks(stress, footSize) {
  const breaks = [];
  for (let i = footSize; i < stress.length; i += footSize) breaks.push(i);
  return breaks;
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < len; i += 1) if (a[i] === b[i]) matches += 1;
  return matches / Math.max(a.length, b.length);
}

function dedupeScans(scans) {
  const seen = new Set();
  const out = [];
  for (const scan of scans) {
    const key = `${scan.meterKey}:${scan.stressString}:${scan.candidate.sources.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scan);
  }
  return out;
}

function formatScan(scan, isPrimary, tokens, text) {
  return {
    meterKey: scan.meterKey,
    meterLabel: scan.meterLabel,
    confidence: scan.confidence,
    stressPattern: scan.candidate.stress.join(' '),
    targetPattern: scan.target.join(' '),
    syllableCount: scan.candidate.syllables,
    score: Math.max(0, 100 - scan.penalty * 10),
    observations: scan.observations,
    footBreaks: scan.footBreaks,
    displayGuide: buildDisplayGuide(text, tokens, scan.candidate, scan.footBreaks),
    variants: scan.candidate.pieces.map((piece) => ({
      source: piece.source,
      pronunciation: piece.pronunciation,
      stress: piece.stress.join('')
    })),
    isPrimary
  };
}


function buildDisplayGuide(text, tokens, candidate, footBreaks) {
  const markerChars = Array.from({ length: text.length }, () => ' ');
  const syllableCenters = [];

  tokens.forEach((token, idx) => {
    const piece = candidate.pieces[idx];
    if (!piece) return;
    const localCenters = estimateSyllableCenters(token.raw, piece.syllables);
    localCenters.forEach((center, localIdx) => {
      const globalIndex = clamp(center + token.start, 0, Math.max(0, text.length - 1));
      syllableCenters.push(globalIndex);
      markerChars[globalIndex] = piece.stress[localIdx] === 's' ? '/' : 'u';
    });
  });

  for (const breakIdx of footBreaks || []) {
    const left = syllableCenters[breakIdx - 1];
    const right = syllableCenters[breakIdx];
    if (left == null || right == null) continue;
    let pos = Math.round((left + right) / 2);
    pos = findNearestWritable(markerChars, pos, text.length);
    markerChars[pos] = '|';
  }

  return markerChars.join('').replace(/\s+$/,'');
}

function estimateSyllableCenters(raw, syllableCount) {
  const chars = [...raw];
  const letterIndexes = chars
    .map((ch, i) => /[A-Za-z]/.test(ch) ? i : -1)
    .filter((i) => i >= 0);

  if (!letterIndexes.length) return [Math.max(0, Math.floor(raw.length / 2))];

  const groups = [];
  let i = 0;
  while (i < chars.length) {
    if (!/[AEIOUYaeiouy]/.test(chars[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < chars.length && /[AEIOUYaeiouy]/.test(chars[j])) j += 1;
    groups.push([i, j - 1]);
    i = j;
  }

  const nuclei = groups.map(([a, b]) => Math.floor((a + b) / 2));
  if (nuclei.length === syllableCount) return nuclei;
  if (nuclei.length > syllableCount && syllableCount > 0) {
    const out = [];
    for (let k = 0; k < syllableCount; k += 1) {
      const pick = Math.round((k + 0.5) * nuclei.length / syllableCount - 0.5);
      out.push(nuclei[clamp(pick, 0, nuclei.length - 1)]);
    }
    return out;
  }

  const minPos = letterIndexes[0];
  const maxPos = letterIndexes[letterIndexes.length - 1];
  if (syllableCount === 1) return [Math.floor((minPos + maxPos) / 2)];

  const out = [];
  for (let k = 0; k < syllableCount; k += 1) {
    const target = minPos + ((maxPos - minPos) * (k + 0.5) / syllableCount);
    let best = letterIndexes[0];
    let bestDist = Math.abs(best - target);
    for (const idx of letterIndexes) {
      const dist = Math.abs(idx - target);
      if (dist < bestDist) {
        best = idx;
        bestDist = dist;
      }
    }
    out.push(best);
  }
  return out;
}

function findNearestWritable(chars, pos, limit) {
  if (chars[pos] === ' ') return pos;
  for (let radius = 1; radius < limit; radius += 1) {
    const left = pos - radius;
    const right = pos + radius;
    if (left >= 0 && chars[left] === ' ') return left;
    if (right < limit && chars[right] === ' ') return right;
  }
  return clamp(pos, 0, Math.max(0, limit - 1));
}

function selectStanzaReadings(lines, context) {
  if (lines.length === 4) {
    return selectQuatrainReadings(lines, context);
  }

  const choice = chooseStanzaDominant(lines);
  return {
    dominantMeterKey: choice.key,
    dominantMeterLabel: choice.label,
    strength: choice.score,
    patternLabel: 'loose stanza',
    lines: lines.map((line) => adjustLineWithStanzaContext(line, choice))
  };
}

function selectQuatrainReadings(lines, context) {
  const options = lines.map((line) => line.scans.slice(0, 8));
  let best = null;

  for (const first of options[0]) {
    for (const second of options[1]) {
        for (const third of options[2]) {
          for (const fourth of options[3]) {
            const combo = [first, second, third, fourth];
            const evaluation = scoreQuatrainCombo(combo, context);
            const score = combo.reduce((sum, scan) => sum + scan.confidence, 0) + evaluation.bonus;
            if (!best || score > best.score) {
              best = { ...evaluation, combo, score };
          }
        }
      }
    }
  }

  if (!best) {
    const choice = chooseStanzaDominant(lines);
    return {
      dominantMeterKey: choice.key,
      dominantMeterLabel: choice.label,
      strength: choice.score,
      patternLabel: 'quatrain',
      lines: lines.map((line) => adjustLineWithStanzaContext(line, choice))
    };
  }

  const contextBoost = clamp(Math.round(best.bonus / 8), 2, 10);
  const selectedLines = lines.map((line, index) => applySelectedScan(line, best.combo[index], contextBoost));
  const dominant = chooseStanzaDominant(selectedLines);

  return {
    dominantMeterKey: dominant.key,
    dominantMeterLabel: dominant.label,
    strength: Math.round(best.score),
    patternLabel: best.patternLabel,
    lines: selectedLines
  };
}

function scoreQuatrainCombo(combo, context) {
  const defs = combo.map((scan) => getMeterDefinition(scan.meterKey));
  const families = defs.map((def) => def.family);
  const feet = defs.map((def) => def.feet);
  const familyMode = modeCount(families.filter((family) => family !== 'accentual'));

  let bonus = familyMode.count * 3;
  let patternLabel = 'mixed quatrain';

  const sameFamily = families.every((family) => family === families[0] && family !== 'accentual');
  const alternating = combo[0].meterKey === combo[2].meterKey && combo[1].meterKey === combo[3].meterKey;
  const invertedAlternating = combo[0].meterKey === combo[3].meterKey && combo[1].meterKey === combo[2].meterKey;
  const monometric = combo.every((scan) => scan.meterKey === combo[0].meterKey);
  const footGap = Math.abs(feet[0] - feet[1]);

  if (sameFamily) bonus += 12;

  if (monometric) {
    bonus += 24;
    patternLabel = 'monometric quatrain';
  } else if (sameFamily && alternating && footGap === 1) {
    bonus += 24;
    bonus += 12;
    bonus += 12;
    patternLabel = 'alternating quatrain';
  } else if (sameFamily && invertedAlternating && footGap === 1) {
    bonus += 24;
    bonus += 12;
    bonus += 12;
    patternLabel = 'inverted alternating quatrain';
  } else if (sameFamily && alternating) {
    bonus += 18;
    patternLabel = 'paired quatrain';
  } else if (sameFamily && invertedAlternating) {
    bonus += 16;
    patternLabel = 'ring quatrain';
  } else {
    if (combo[0].meterKey === combo[2].meterKey) bonus += 10;
    if (combo[1].meterKey === combo[3].meterKey) bonus += 10;
    if (combo[0].meterKey === combo[3].meterKey) bonus += 10;
    if (combo[1].meterKey === combo[2].meterKey) bonus += 10;
  }

  const accentualCount = families.filter((family) => family === 'accentual').length;
  const footRange = Math.max(...feet) - Math.min(...feet);
  const weakFits = combo.reduce((sum, scan) => sum + Math.max(0, 82 - scan.score) * 0.8, 0);
  bonus -= accentualCount * 10;
  bonus -= Math.max(0, new Set(families).size - 1) * 6;
  bonus += footRange <= 1 ? 4 : -(footRange - 1) * 8;
  bonus -= weakFits;

  if (context?.profile?.key === 'hymn' && sameFamily && footGap === 1) {
    if (alternating || invertedAlternating) {
      bonus += context.profile.commonMeterBonus;
    }
  }

  return { bonus, patternLabel };
}

function applySelectedScan(line, selectedScan, boost) {
  const selectedKey = scanIdentity(selectedScan);
  const chosen = line.scans.find((scan) => scanIdentity(scan) === selectedKey) || selectedScan;
  const others = line.scans.filter((scan) => scanIdentity(scan) !== selectedKey);
  const rescored = [
    {
      ...chosen,
      confidence: clamp(chosen.confidence + boost, 50, 100),
      isPrimary: true
    },
    ...others.map((scan) => ({
      ...scan,
      confidence: clamp(scan.confidence - 2, 50, 100),
      isPrimary: false
    }))
  ];

  return hydrateLineMetadata({
    ...line,
    tag: rescored[0].meterLabel,
    confidence: rescored[0].confidence,
    scans: rescored
  });
}

function scanIdentity(scan) {
  return `${scan.meterKey}:${scan.stressPattern}:${scan.targetPattern}:${scan.variants.map((variant) => variant.source).join('|')}`;
}

function getMeterDefinition(meterKey) {
  return METER_LIBRARY.find((meter) => meter.key === meterKey) || METER_LIBRARY.at(-1);
}

function modeCount(values) {
  const tally = new Map();
  let best = { value: '', count: 0 };
  for (const value of values) {
    const count = (tally.get(value) || 0) + 1;
    tally.set(value, count);
    if (count > best.count) best = { value, count };
  }
  return best;
}

function inferOverallMeter(lines, stanzaResults, meterTally, context) {
  const nonBlank = lines.filter((line) => !line.blank);
  const topKeys = nonBlank.map((line) => line.scans[0]?.meterKey).filter(Boolean);
  const iambicCommonCount = topKeys.filter((key) => key === 'iambic_tetrameter' || key === 'iambic_trimeter').length;
  const commonStanzaCount = stanzaResults.filter((stanza) => {
    return stanza.patternLabel === 'alternating quatrain' || stanza.patternLabel === 'inverted alternating quatrain';
  }).length;

  if (
    nonBlank.length >= 4 &&
    iambicCommonCount / nonBlank.length >= 0.8 &&
    commonStanzaCount >= Math.max(1, Math.ceil(stanzaResults.length * 0.6))
  ) {
    return 'common_meter';
  }

  if (
    context?.profile?.key === 'hymn' &&
    nonBlank.length >= 4 &&
    iambicCommonCount / nonBlank.length >= 0.65 &&
    commonStanzaCount >= 1
  ) {
    return 'common_meter';
  }

  return [...meterTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'accentual_loose';
}

function buildRhymeAnalysis(structure, lines, context) {
  const groups = [];
  const stanzaAnalyses = structure.stanzas.map((stanzaLines, stanzaIndex) => {
    return analyzeStanzaRhyme(stanzaLines, lines, stanzaIndex, groups, context);
  });

  const groupQualityByLetter = new Map(groups.map((group) => [group.letter, summarizeRhymeGroupQuality(group)]));
  const lineDetails = stanzaAnalyses.flatMap((stanza) => stanza.lines).map((detail) => ({
    ...detail,
    groupQuality: groupQualityByLetter.get(detail.letter) || detail.groupQuality || ''
  }));
  const detailByIndex = new Map(lineDetails.map((detail) => [detail.index, detail]));
  const annotatedLines = lines.map((line) => {
    if (line.blank) return line;
    const detail = detailByIndex.get(line.index);
    return {
      ...line,
      rhymeLetter: detail?.letter || '',
      rhymeWord: detail?.word || '',
      rhymeMatchType: detail?.matchType || '',
      rhymeExplanation: detail?.explanation || '',
      rhymeGroupQuality: detail?.groupQuality || ''
    };
  });

  return {
    annotatedLines,
    rhyme: {
      overallScheme: stanzaAnalyses.map((stanza) => stanza.scheme).join(' / '),
      globalScheme: lineDetails.map((detail) => detail.letter).join(''),
      stanzas: stanzaAnalyses,
      lines: lineDetails,
      groups: groups.map((group) => ({
        letter: group.letter,
        quality: summarizeRhymeGroupQuality(group),
        lines: group.members.map((member) => ({
          index: member.index,
          text: member.text,
          word: member.word,
          matchType: member.matchType,
          explanation: member.explanation
        }))
      }))
    }
  };
}

function analyzeStanzaRhyme(stanzaLines, lines, stanzaIndex, groups, context) {
  const details = stanzaLines.map((stanzaLine) => {
    const line = lines[stanzaLine.index];
    const profile = buildLineRhymeProfile(line, context?.profile);
    const match = findRhymeGroup(profile, groups);

    if (match) {
      match.group.perfectKeys.add(profile.perfectKey);
      match.group.tailKeys.add(profile.tailKey);
      match.group.vowelKeys.add(profile.vowelKey);
      match.group.codaKeys.add(profile.codaKey);
      match.group.orthographicTails.add(profile.orthographicTail);
      match.group.words.add(profile.normalizedWord);
    } else {
      groups.push({
        letter: indexToSchemeLabel(groups.length),
        perfectKeys: new Set(profile.perfectKey ? [profile.perfectKey] : []),
        tailKeys: new Set(profile.tailKey ? [profile.tailKey] : []),
        vowelKeys: new Set(profile.vowelKey ? [profile.vowelKey] : []),
        codaKeys: new Set(profile.codaKey ? [profile.codaKey] : []),
        orthographicTails: new Set(profile.orthographicTail ? [profile.orthographicTail] : []),
        words: new Set(profile.normalizedWord ? [profile.normalizedWord] : []),
        members: []
      });
    }

    const group = match?.group || groups.at(-1);
    const matchType = match?.type || 'unique';
    const explanation = match?.explanation || 'Opens a new rhyme sound.';
    group.members.push({
      index: line.index,
      text: line.text,
      word: profile.word,
      matchType,
      explanation
    });
    return {
      index: line.index,
      letter: group.letter,
      word: profile.word,
      matchType,
      explanation,
      groupQuality: summarizeRhymeGroupQuality(group),
      pronunciation: profile.pronunciation,
      perfectKey: profile.perfectKey,
      tailKey: profile.tailKey
    };
  });

  return {
    stanzaIndex,
    lineIndexes: stanzaLines.map((line) => line.index),
    scheme: details.map((detail) => detail.letter).join(''),
    lines: details,
    quality: summarizeStanzaRhymeQuality(details)
  };
}

function buildLineRhymeProfile(line, profile) {
  const token = line.tokens?.at(-1);
  const variant = line.scans?.[0]?.variants?.[line.tokens.length - 1];
  const word = token?.raw || '';
  const pronunciation = variant?.pronunciation || '';
  const phonemes = buildRhymePhonemes(variant);

  return {
    word,
    normalizedWord: token?.normalized || '',
    pronunciation,
    perfectKey: extractPerfectRhymeKey(phonemes),
    tailKey: extractTailRhymeKey(phonemes),
    vowelKey: extractLastVowelKey(phonemes),
    codaKey: extractCodaKey(phonemes),
    orthographicTail: extractOrthographicTail(token?.normalized || '', profile)
  };
}

function buildRhymePhonemes(variant) {
  const pronunciation = variant?.pronunciation || '';
  if (!pronunciation || pronunciation.startsWith('heuristic:')) return [];

  const phonemes = pronunciation.split(/\s+/).filter(Boolean);
  const targetSyllables = countStressSymbols(variant?.stress || '');
  if (!targetSyllables) return phonemes;

  const adjusted = [...phonemes];
  let syllables = countPronunciationSyllables(adjusted);

  while (syllables > targetSyllables) {
    const vowelIndex = findLastUnstressedVowelIndex(adjusted);
    if (vowelIndex < 0) break;

    const phoneme = adjusted[vowelIndex];
    if (phoneme === 'ER0') {
      adjusted[vowelIndex] = 'R';
    } else {
      adjusted.splice(vowelIndex, 1);
    }

    syllables -= 1;
  }

  return adjusted;
}

function countStressSymbols(stressPattern) {
  return String(stressPattern).replace(/[^su]/g, '').length;
}

function countPronunciationSyllables(phonemes) {
  return phonemes.filter((phoneme) => /\d$/.test(phoneme)).length;
}

function findLastUnstressedVowelIndex(phonemes) {
  for (let i = phonemes.length - 1; i >= 0; i -= 1) {
    if (/0$/.test(phonemes[i])) return i;
  }
  return -1;
}

function extractPerfectRhymeKey(phonemes) {
  if (!phonemes.length) return '';
  let startIndex = -1;
  for (let i = phonemes.length - 1; i >= 0; i -= 1) {
    if (/[12]$/.test(phonemes[i])) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    return extractTailRhymeKey(phonemes);
  }
  return phonemes.slice(startIndex).map(stripStress).join(' ');
}

function extractTailRhymeKey(phonemes) {
  if (!phonemes.length) return '';
  let startIndex = -1;
  for (let i = phonemes.length - 1; i >= 0; i -= 1) {
    if (/\d$/.test(phonemes[i])) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return '';
  return phonemes.slice(startIndex).map(stripStress).join(' ');
}

function extractLastVowelKey(phonemes) {
  for (let i = phonemes.length - 1; i >= 0; i -= 1) {
    if (/\d$/.test(phonemes[i])) {
      return stripStress(phonemes[i]);
    }
  }
  return '';
}

function extractCodaKey(phonemes) {
  const lastVowel = findLastPronouncedVowelIndex(phonemes);
  if (lastVowel < 0) return '';
  return phonemes.slice(lastVowel + 1).map(stripStress).join(' ');
}

function findLastPronouncedVowelIndex(phonemes) {
  for (let i = phonemes.length - 1; i >= 0; i -= 1) {
    if (/\d$/.test(phonemes[i])) return i;
  }
  return -1;
}

function extractOrthographicTail(word, profile) {
  if (!word) return '';
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return '';
  if (profile?.key === 'early_modern') {
    if (/(er|or|ur)ate$/.test(cleaned)) {
      return 'ate';
    }
    if (/ere$/.test(cleaned) || /eer$/.test(cleaned)) {
      return 'eer';
    }
  }
  let effectiveEnd = cleaned.length;
  const hasSilentTrailingE = /[^aeiouy]e$/.test(cleaned) && !/le$/.test(cleaned);
  if (hasSilentTrailingE) {
    effectiveEnd -= 1;
  }
  let vowelIndex = -1;
  for (let index = effectiveEnd - 1; index >= 0; index -= 1) {
    if (/[aeiouy]/.test(cleaned[index])) {
      vowelIndex = index;
      break;
    }
  }
  const tail = vowelIndex >= 0
    ? `${cleaned.slice(vowelIndex, effectiveEnd)}${hasSilentTrailingE ? 'e' : ''}`
    : cleaned.slice(Math.max(0, effectiveEnd - 3), effectiveEnd);
  return tail || cleaned.slice(-3);
}

function findRhymeGroup(profile, groups) {
  if (!profile.perfectKey && !profile.tailKey && !profile.orthographicTail) return null;

  let best = null;

  for (const group of groups) {
    const match = classifyRhymeGroupMatch(profile, group);
    if (!match) continue;
    if (!best || match.score > best.score) {
      best = match;
    }
  }

  return best && best.score >= 56 ? best : null;
}

function classifyRhymeGroupMatch(profile, group) {
  if (profile.perfectKey && group.perfectKeys.has(profile.perfectKey)) {
    return {
      group,
      type: 'perfect',
      score: 100,
      explanation: 'Matches the stressed vowel and the full closing sound.'
    };
  }

  if (profile.tailKey && group.tailKeys.has(profile.tailKey)) {
    return {
      group,
      type: 'perfect',
      score: 96,
      explanation: 'Matches the closing vowel-to-end tail exactly.'
    };
  }

  const sameVowel = Boolean(profile.vowelKey && group.vowelKeys.has(profile.vowelKey));
  const sameCoda = Boolean(profile.codaKey && group.codaKeys.has(profile.codaKey));
  const sameSpelling = Boolean(profile.orthographicTail && group.orthographicTails.has(profile.orthographicTail));
  const orthographicSimilarity = suffixSimilarity(profile.orthographicTail, [...group.orthographicTails].filter(Boolean));

  if (sameVowel && sameCoda) {
    return {
      group,
      type: 'slant',
      score: 86,
      explanation: 'Shares the same vowel and closing consonant frame, but not the exact stressed rhyme key.'
    };
  }

  if ((sameVowel && orthographicSimilarity >= 0.7) || (sameCoda && orthographicSimilarity >= 0.82)) {
    return {
      group,
      type: sameVowel ? 'slant' : 'consonance',
      score: sameVowel ? 74 : 64,
      explanation: sameVowel
        ? 'Leans on a shared vowel sound with some supporting spelling similarity.'
        : 'Leans on a shared consonant closure more than a shared vowel sound.'
    };
  }

  if (sameSpelling) {
    return {
      group,
      type: 'eye',
      score: 66,
      explanation: 'Matches by spelling more strongly than by pronunciation.'
    };
  }

  if (orthographicSimilarity >= 0.7) {
    return {
      group,
      type: 'weak',
      score: 58,
      explanation: 'Shows a loose spelling resemblance, but the sound match is weak.'
    };
  }

  return null;
}

function suffixSimilarity(value, candidates) {
  if (!value || !candidates.length) return 0;
  let best = 0;
  for (const candidate of candidates) {
    const shared = sharedSuffixLength(value, candidate);
    best = Math.max(best, shared / Math.max(value.length, candidate.length, 1));
  }
  return best;
}

function sharedSuffixLength(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function summarizeRhymeGroupQuality(group) {
  const priority = ['perfect', 'slant', 'consonance', 'eye', 'weak', 'unique'];
  const types = [...new Set(group.members.map((member) => member.matchType))];
  return priority.find((type) => types.includes(type)) || 'unique';
}

function summarizeStanzaRhymeQuality(details) {
  const priority = ['weak', 'eye', 'consonance', 'slant', 'perfect'];
  return priority.find((type) => details.some((detail) => detail.matchType === type)) || 'perfect';
}

function stripStress(phoneme) {
  return phoneme.replace(/[012]$/, '');
}

function indexToSchemeLabel(index) {
  let value = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function chooseStanzaDominant(lines) {
  const tally = new Map();
  for (const line of lines) {
    const topTwo = line.scans.slice(0, 2);
    for (const scan of topTwo) {
      tally.set(scan.meterKey, (tally.get(scan.meterKey) || 0) + scan.confidence * (scan.isPrimary ? 1 : 0.45));
    }
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || ['accentual_loose', 0];
  const def = METER_LIBRARY.find((m) => m.key === top[0]) || METER_LIBRARY.at(-1);
  return { key: def.key, label: def.label, score: top[1] };
}

function adjustLineWithStanzaContext(line, stanza) {
  if (!stanza) return line;
  const rescored = line.scans.map((scan) => {
    const boosted = scan.meterKey === stanza.dominantMeterKey
      ? clamp(scan.confidence + 6, 50, 100)
      : clamp(scan.confidence - 4, 50, 100);
    return { ...scan, confidence: boosted };
  }).sort((a, b) => b.confidence - a.confidence);

  const top = rescored[0];
  return hydrateLineMetadata({
    ...line,
    tag: top.meterLabel,
    confidence: top.confidence,
    scans: rescored
  });
}

function detectPoeticForm(structure, lines, stanzaResults, rhyme, overallMeter, context) {
  const nonBlank = lines.filter((line) => !line.blank);
  const schemes = rhyme.stanzas.map((stanza) => stanza.scheme);
  const flatScheme = rhyme.globalScheme || schemes.join('');
  const pentameterRatio = ratioOfMeter(nonBlank, 'iambic_pentameter');
  const tetrameterRatio = ratioOfMeter(nonBlank, 'iambic_tetrameter');
  const trimeterRatio = ratioOfMeter(nonBlank, 'iambic_trimeter');

  const candidates = [];

  if (
    nonBlank.length === 14 &&
    pentameterRatio >= 0.75 &&
    flatScheme === 'ABABCDCDEFEFGG'
  ) {
    candidates.push({
      key: 'shakespearean_sonnet',
      label: 'Shakespearean sonnet',
      confidence: 98,
      explanation: 'Fourteen mostly iambic pentameter lines lock into the classic ABABCDCDEFEFGG rhyme pattern.',
      signals: ['14 lines', 'iambic pentameter', 'ABABCDCDEFEFGG']
    });
  }

  if (
    overallMeter === 'common meter' &&
    structure.stanzas.every((stanza) => stanza.length === 4)
  ) {
    const mostlyAlternating = stanzaResults.filter((stanza) => {
      return stanza.patternLabel === 'alternating quatrain' || stanza.patternLabel === 'inverted alternating quatrain';
    }).length >= Math.max(1, Math.ceil(stanzaResults.length * 0.5));
    if (mostlyAlternating) {
      candidates.push({
        key: context?.profile?.key === 'hymn' ? 'hymn_common_meter' : 'common_meter_ballad',
        label: context?.profile?.key === 'hymn' ? 'Hymn in common meter' : 'Ballad / common meter quatrains',
        confidence: context?.profile?.key === 'hymn' ? 95 : 92,
        explanation: 'Alternating iambic tetrameter and trimeter lines create a recognizable common-meter quatrain pattern.',
        signals: ['quatrains', 'common meter', 'alternating 8/6 line lengths']
      });
    }
  }

  if (
    pentameterRatio >= 0.8 &&
    isCoupletScheme(flatScheme)
  ) {
    candidates.push({
      key: 'heroic_couplets',
      label: 'Heroic couplets',
      confidence: 90,
      explanation: 'The poem leans on iambic pentameter and closes its rhyme in consecutive paired couplets.',
      signals: ['iambic pentameter', 'paired rhyme']
    });
  }

  if (
    pentameterRatio >= 0.85 &&
    isMostlyUnrhymed(rhyme)
  ) {
    candidates.push({
      key: 'blank_verse',
      label: 'Blank verse',
      confidence: 84,
      explanation: 'The poem is dominated by iambic pentameter while avoiding a strong repeated rhyme scheme.',
      signals: ['iambic pentameter', 'low rhyme recurrence']
    });
  }

  if (
    tetrameterRatio >= 0.85 &&
    structure.stanzas.length >= 2 &&
    structure.stanzas.every((stanza) => stanza.length === 4) &&
    isRubaiyatChain(schemes)
  ) {
    candidates.push({
      key: 'rubaiyat_chain',
      label: 'Rubaiyat-style chain quatrains',
      confidence: 93,
      explanation: 'The quatrains chain their rhyme forward in the AABA / BBCB / CCDC pattern while holding steady iambic tetrameter.',
      signals: ['quatrains', 'iambic tetrameter', 'AABA / BBCB chain rhyme']
    });
  }

  if (
    pentameterRatio >= 0.72 &&
    isTerzaRimaChain(schemes)
  ) {
    candidates.push({
      key: 'terza_rima',
      label: 'Terza rima',
      confidence: 90,
      explanation: 'The poem chains its tercet rhymes forward in the characteristic ABA / BCB / CDC pattern while sustaining a predominantly iambic pentameter line.',
      signals: ['chain-linked tercets', 'iambic pentameter', 'ABA / BCB / CDC']
    });
  }

  if (looksLikeVillanelle(structure, flatScheme)) {
    candidates.push({
      key: 'villanelle_components',
      label: 'Villanelle components',
      confidence: 88,
      explanation: 'The poem matches the villanelle stanza scaffold of five tercets followed by a quatrain, with the expected ABA ... ABAA rhyme frame and repeating line endings.',
      signals: ['19 lines', 'five tercets and a quatrain', 'ABA ... ABAA']
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return {
    primary: candidates[0] || null,
    candidates
  };
}

function ratioOfMeter(lines, meterKey) {
  if (!lines.length) return 0;
  return lines.filter((line) => line.scans[0]?.meterKey === meterKey).length / lines.length;
}

function isCoupletScheme(flatScheme) {
  if (!flatScheme || flatScheme.length < 4 || flatScheme.length % 2 !== 0) return false;
  for (let index = 0; index < flatScheme.length; index += 2) {
    if (flatScheme[index] !== flatScheme[index + 1]) return false;
  }
  return true;
}

function isMostlyUnrhymed(rhyme) {
  const repeated = new Map();
  for (const detail of rhyme.lines || []) {
    repeated.set(detail.letter, (repeated.get(detail.letter) || 0) + 1);
  }
  const repeatedGroups = [...repeated.values()].filter((value) => value > 1).length;
  return repeatedGroups <= Math.max(1, Math.floor(repeated.size / 4));
}

function isRubaiyatChain(schemes) {
  if (!schemes.length || schemes.some((scheme) => scheme.length !== 4)) return false;
  for (let index = 0; index < schemes.length; index += 1) {
    const scheme = schemes[index];
    if (index === schemes.length - 1) {
      if (scheme[0] !== scheme[1] || scheme[1] !== scheme[2] || scheme[2] !== scheme[3]) return false;
      continue;
    }

    if (!(scheme[0] === scheme[1] && scheme[1] === scheme[3] && scheme[2] !== scheme[0])) {
      return false;
    }

    if (index < schemes.length - 1 && schemes[index + 1][0] !== scheme[2]) {
      return false;
    }
  }
  return true;
}

function isTerzaRimaChain(schemes) {
  if (!schemes.length || schemes.some((scheme, index) => {
    if (index === schemes.length - 1) {
      return !(scheme.length === 3 || scheme.length === 1);
    }
    return scheme.length !== 3;
  })) {
    return false;
  }

  for (let index = 0; index < schemes.length; index += 1) {
    const scheme = schemes[index];
    if (scheme.length === 3) {
      if (scheme[0] !== scheme[2] || scheme[0] === scheme[1]) {
        return false;
      }
      if (index < schemes.length - 1) {
        const next = schemes[index + 1];
        if (next.length >= 2 && next[0] !== scheme[1]) {
          return false;
        }
      }
    }
  }

  return true;
}

function looksLikeVillanelle(structure, flatScheme) {
  const stanzaLengths = structure.stanzas.map((stanza) => stanza.length);
  if (stanzaLengths.join(',') !== '3,3,3,3,3,4') return false;
  if (flatScheme !== 'ABAABACABAABACABAA') return false;

  const nonBlank = structure.lineObjects.filter((line) => !line.blank);
  const firstRefrain = normalizeLineEnding(nonBlank[0]?.text || '');
  const secondRefrain = normalizeLineEnding(nonBlank[2]?.text || '');
  const repeatedFirst = [5, 11, 17].every((index) => normalizeLineEnding(nonBlank[index]?.text || '') === firstRefrain);
  const repeatedSecond = [8, 14, 18].every((index) => normalizeLineEnding(nonBlank[index]?.text || '') === secondRefrain);
  return repeatedFirst && repeatedSecond;
}

function normalizeLineEnding(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(-3)
    .join(' ');
}

function buildDiagnostics(lines, stanzaResults, form) {
  const nonBlank = lines.filter((line) => !line.blank);
  const avgConfidence = nonBlank.length
    ? Math.round(nonBlank.reduce((sum, line) => sum + line.confidence, 0) / nonBlank.length)
    : 0;
  const fallbackWords = nonBlank.flatMap((line) => line.tokens).filter((token) => token.options.some((o) => o.source.startsWith('heuristic'))).map((t) => t.raw);
  const feminineEndingLines = nonBlank
    .filter((line) => line.scans[0]?.observations?.includes('feminine ending'))
    .map((line) => line.index + 1);
  return {
    averageLineConfidence: avgConfidence,
    stanzaCount: stanzaResults.length,
    lineCount: nonBlank.length,
    heuristicWords: [...new Set(fallbackWords)],
    feminineEndingCount: feminineEndingLines.length,
    feminineEndingLines,
    benchmarkReady: true,
    detectedForm: form?.primary?.label || ''
  };
}

async function generateSummary(analysis) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackSummary(analysis);

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You are a concise poetry-prosody analyst. Summarize the meter and rhyme of the poem in 90 words or fewer. Mention the dominant meter, important variations, the rhyme scheme when clear, whether the stanza pattern reinforces the reading, and any notable uncertainty. Do not use bullets. Sound confident but honest.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              overallMeter: analysis.overallMeter,
              rhyme: analysis.rhyme,
              diagnostics: analysis.diagnostics,
              stanzaResults: analysis.stanzaResults,
              lines: analysis.lines.filter((line) => !line.blank).map((line) => ({
                text: line.text,
                tag: line.tag,
                confidence: line.confidence,
                alternates: line.scans.slice(1, 3).map((scan) => ({ meter: scan.meterLabel, confidence: scan.confidence, notes: scan.observations }))
              }))
            })
          }
        ]
      }
    ]
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const data = await response.json();
  const text = data.output_text || extractText(data) || fallbackSummary(analysis);
  return text.trim();
}

function extractText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const outputs = data?.output || [];
  for (const item of outputs) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  return '';
}

function fallbackSummary(analysis) {
  const uncertain = analysis.diagnostics.heuristicWords.length
    ? ` A few words required fallback pronunciation guesses: ${analysis.diagnostics.heuristicWords.slice(0, 6).join(', ')}${analysis.diagnostics.heuristicWords.length > 6 ? ', …' : ''}.`
    : '';
  const rhyme = analysis.rhyme?.overallScheme ? ` The rhyme scheme reads ${analysis.rhyme.overallScheme}.` : '';
  const feminineEndings = analysis.diagnostics.feminineEndingCount
    ? ` Feminine endings appear on ${analysis.diagnostics.feminineEndingCount} line${analysis.diagnostics.feminineEndingCount === 1 ? '' : 's'}.`
    : '';
  return `${capitalize(analysis.overallMeter)} appears to govern the poem overall, with stanza-level agreement pushing the reading above line-by-line noise.${rhyme}${feminineEndings} The scan is strongest where multiple lines converge on the same stress architecture and weaker where lexical variants or extra unstressed syllables open alternate parses.${uncertain}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'x-scansion-api-version': API_VERSION,
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({
      'content-type': 'application/json; charset=utf-8'
    })
  });
}
