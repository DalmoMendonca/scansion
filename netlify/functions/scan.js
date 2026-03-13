import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dictionary as cmuDictionary } from 'cmu-pronouncing-dictionary';
import { SCAN_RERANKER } from './scan-reranker-model.js';
import { SCAN_RERANKER_FOREST } from './scan-reranker-forest-model.js';
import { SCAN_RERANKER_HGB } from './scan-reranker-hgb-model.js';
import { STRICT_GENERIC_PROMOTION_RULES } from './scan-generic-promotion-rules.js';
import { STRICT_RESERVE_PROMOTION_RULES } from './scan-reserve-promotion-rules.js';
import { STRICT_TERMINAL_PROMOTION_RULES as GENERATED_STRICT_TERMINAL_PROMOTION_RULES } from './scan-terminal-promotion-rules.js';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_SCAN_MODEL = process.env.OPENAI_SCAN_MODEL || 'gpt-5-mini';
const ASSISTANT_SCAN_PROMPT_VERSION = 'v3';
export const API_VERSION = 'v1';
const MAX_POEM_CHARS = 24000;
const MAX_BATCH_POEMS = 10;
const MAX_BATCH_CHARS = 120000;
const MAX_ASSISTED_LINES = 160;
const UVA_WORD_STRESS_LEXICON = loadUvaWordStressLexicon();
const HAS_UVA_WORD_STRESS_LEXICON = Object.keys(UVA_WORD_STRESS_LEXICON).length > 0;

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

function loadUvaWordStressLexicon() {
  try {
    const raw = readFileSync(new URL('../../artifacts/uva-word-stress-lexicon.json', import.meta.url), 'utf8');
    return JSON.parse(raw)?.entries || {};
  } catch {
    return {};
  }
}

const FOOT_SIZE_LABELS = new Map([
  [1, 'monometer'],
  [2, 'dimeter'],
  [3, 'trimeter'],
  [4, 'tetrameter'],
  [5, 'pentameter'],
  [6, 'hexameter']
]);

const METER_FAMILIES = [
  { family: 'iambic', pattern: ['u', 's'], feet: [1, 2, 3, 4, 5, 6] },
  { family: 'trochaic', pattern: ['s', 'u'], feet: [1, 2, 3, 4, 5, 6] },
  { family: 'anapestic', pattern: ['u', 'u', 's'], feet: [1, 2, 3, 4, 5, 6] },
  { family: 'dactylic', pattern: ['s', 'u', 'u'], feet: [1, 2, 3, 4, 5, 6] },
  { family: 'amphibrachic', pattern: ['u', 's', 'u'], feet: [1, 2, 3, 4, 5, 6] },
  { family: 'spondaic', pattern: ['s', 's'], feet: [1, 2, 3, 4, 5, 6] }
];

const METER_LIBRARY = [
  ...METER_FAMILIES.flatMap(({ family, pattern, feet }) => {
    return feet.map((count) => ({
      key: `${family}_${FOOT_SIZE_LABELS.get(count)}`,
      label: `${family} ${FOOT_SIZE_LABELS.get(count)}`,
      pattern,
      feet: count,
      family
    }));
  }),
  { key: 'accentual_loose', label: 'accentual / mixed meter', pattern: [], feet: 0, family: 'accentual' }
];

const RERANKER_OBSERVATIONS = [
  'feminine ending',
  'extra syllable',
  'acephalous opening',
  'catalectic ending',
  'initial inversion',
  'inversion',
  'spondaic substitution',
  'pyrrhic substitution',
  'anapestic substitution',
  'dactylic substitution',
  'amphibrachic substitution',
  'spondaic pressure',
  'syllable count drift'
];

const RERANKER_SOURCE_FLAGS = [
  'heuristic-primary',
  'heuristic-alt',
  'normalized-cmu',
  'constructed-cmu',
  'demoted',
  'poetic',
  'contextual',
  'promoted-rare',
  'promoted',
  'compressed',
  'flex-weak',
  'compound-shift',
  'syllabic-ed',
  'historic'
];

const RERANKER_FOOT_PATTERNS = ['us', 'su', 'uu', 'ss', 'uus', 'suu', 'usu', 'sus'];
const STRUCTURED_TERNARY_FEET = ['uus', 'usu', 'suu', 'sus', 'uss', 'ssu', 'sss'];
const CANONICAL_LINE_FINAL_EXPANSIONS = new Map([
  ['iambic_pentameter', new Set(['actors', 'vision', 'faded', 'troubled', 'heaven', 'hour', 'power', 'fires', 'expires', 'shaken', 'expression', 'recorded'])],
  ['iambic_tetrameter', new Set(['goes', 'forsaken', 'confession', 'hoarded'])],
  ['anapestic_pentameter', new Set(['clamour', 'glamour'])]
]);

const FUNCTION_WORDS = new Set([
  'a','an','and','as','at','be','but','by','can','could','do','dost','doth','ere','for','from','had','has','have','he','her','here','him','his','i','if','in','is','it','its','may','me','might','more','must','my','no','nor','not','of','on','or','our','ours','shall','she','should','since','so','such','than','that','the','thee','their','them','then','there','these','they','thine','this','those','thou','through','thy','tis','to','up','us','was','we','were','what','when','where','which','who','whom','why','will','with','would','you','your','yours'
]);

const FUNCTION_CONTRACTION_SUFFIXES = ["'s", "'re", "'ve", "'ll", "'d", "'m", "n't"];

const CLITICS = new Map([
  ["o'er", 'over'],
  ["e'en", 'even'],
  ["heav'n", 'heaven'],
  ["ne'er", 'never'],
  ["thro", 'through'],
  ["thro'", 'through'],
  ["ev'ry", 'every'],
  ["int'rest", 'interest'],
  ["pow'r", 'power'],
  ["flow'r", 'flower'],
  ["hour", 'hour']
]);

const MANUAL_PRONUNCIATION_CANDIDATES = new Map([
  ['dapple', [{ pronunciation: 'manual:dapple', stress: ['u', 'u'], source: 'manual-poetic' }]],
  ['iambics', [{ pronunciation: 'manual:iambics', stress: ['u', 's', 'u'], source: 'manual-poetic' }]],
  ['movest', [{ pronunciation: 'manual:movest', stress: ['s', 'u'], source: 'manual-historic' }]],
  ['phaeton', [{ pronunciation: 'manual:phaeton', stress: ['s', 'u', 's'], source: 'manual-poetic' }]],
  ['rushy-fringed', [{ pronunciation: 'manual:rushyfringed', stress: ['s', 'u', 's', 'u'], source: 'manual-historic' }]],
  ['thro', [{ pronunciation: 'manual:through', stress: ['u'], source: 'manual-poetic' }]],
  ["wand'rest", [{ pronunciation: 'manual:wandrest', stress: ['s', 'u'], source: 'manual-historic' }]],
  ["sick'ning", [{ pronunciation: 'manual:sickening', stress: ['s', 'u'], source: 'manual-historic' }]]
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
const TRISYLLABIC_POETIC_COMPRESSION_SUFFIXES = ['ering', 'iest', 'istry', 'orous', 'edy', 'eor'];

const STRESS_SHIFT_SUFFIXES = ['ary', 'ery', 'ory', 'ity'];
const WEAK_SUFFIX_RULES = [
  { suffix: 'less', extraStress: ['u'], baseForms: (word) => [word.slice(0, -4)] },
  { suffix: 'ness', extraStress: ['u'], baseForms: (word) => [word.slice(0, -4)] },
  { suffix: 'ment', extraStress: ['u'], baseForms: (word) => [word.slice(0, -4)] },
  { suffix: 'ly', extraStress: ['u'], baseForms: (word) => [word.slice(0, -2)] },
  { suffix: 'ing', extraStress: ['u'], baseForms: (word) => [word.slice(0, -3), `${word.slice(0, -3)}e`] },
  { suffix: 'er', extraStress: ['u'], minBaseLength: 3, baseForms: (word) => [word.slice(0, -2)] },
  { suffix: 'est', extraStress: ['u'], minBaseLength: 3, baseForms: (word) => [word.slice(0, -3)] },
  { suffix: 'ish', extraStress: ['u'], minBaseLength: 3, baseForms: (word) => [word.slice(0, -3)] }
];
const COMPOUND_SPLIT_MIN = 3;

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

function hasDirectUvaLexiconEntry(normalized) {
  if (!normalized || !HAS_UVA_WORD_STRESS_LEXICON) {
    return false;
  }

  return Boolean(
    UVA_WORD_STRESS_LEXICON[normalized] ||
    UVA_WORD_STRESS_LEXICON[normalized.replace(/-/g, '')] ||
    UVA_WORD_STRESS_LEXICON[normalized.replace(/'/g, '')] ||
    UVA_WORD_STRESS_LEXICON[normalized.replace(/[-']/g, '')]
  );
}

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
  disableUvaReference = true,
  id = '',
  title = ''
} = {}) {
  validatePoemLength(poem);
  const profile = resolveProfile(profileKey);
  const normalizedOverrides = normalizeOverrides(overrides);
  const analysis = analyzePoem(poem, {
    profile,
    overrides: normalizedOverrides,
    disableUvaReference: Boolean(disableUvaReference)
  });
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

export async function scanPoemWithAssistant({
  poem,
  profileKey = 'modern',
  overrides = {},
  id = '',
  title = '',
  useAssistant = true,
  cacheDir = '',
  cacheKey = ''
} = {}) {
  const base = scanPoem({
    poem,
    profileKey,
    overrides,
    id,
    title
  });

  if (!useAssistant) {
    return base;
  }

  const assisted = await refineAnalysisWithAssistant({
    poem,
    profileKey,
    overrides,
    base,
    cacheDir,
    cacheKey
  });

  return assisted || base;
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

async function refineAnalysisWithAssistant({
  poem,
  profileKey = 'modern',
  overrides = {},
  base,
  cacheDir = '',
  cacheKey = ''
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const structure = buildPoemStructure(poem);
  const nonBlankCount = structure.lineObjects.filter((line) => !line.blank).length;

  if (!apiKey || !poem?.trim() || nonBlankCount > MAX_ASSISTED_LINES) {
    return null;
  }

  const promptPayload = buildAssistantPromptPayload(poem, profileKey, base);
  const cachePath = cacheDir ? buildAssistantCachePath(cacheDir, profileKey, promptPayload, cacheKey || poem) : '';
  if (cachePath) {
    const cached = await readAssistantCache(cachePath);
    if (cached) {
      return buildAssistantAdjustedAnalysis({ poem, profileKey, overrides, base, selection: cached });
    }
  }

  const selection = await requestAssistantSelection({
    poem,
    profileKey,
    analysis: base,
    promptPayload,
    apiKey
  }).catch(() => null);

  if (!selection) {
    return null;
  }

  if (cachePath) {
    await writeAssistantCache(cachePath, selection).catch(() => {});
  }

  return buildAssistantAdjustedAnalysis({ poem, profileKey, overrides, base, selection });
}

function buildAssistantAdjustedAnalysis({
  poem,
  profileKey = 'modern',
  overrides = {},
  base,
  selection
} = {}) {
  const structure = buildPoemStructure(poem);
  const context = {
    profile: resolveProfile(profileKey),
    overrides: normalizeOverrides(overrides)
  };
  const selectedLines = applyAssistantSelections(structure, base.lines, selection, context);
  const rebuilt = rebuildAnalysisFromLines(structure, selectedLines, context, selection);

  return {
    id: base.id,
    title: base.title,
    profile: base.profile,
    ...rebuilt
  };
}

function rebuildAnalysisFromLines(structure, lines, context, selection = null) {
  const finalLines = [...lines];
  const stanzaResults = structure.stanzas.map((stanzaLines, stanzaIndex) => {
    const members = stanzaLines.map((line) => finalLines[line.index]).filter((line) => !line.blank);
    const dominant = chooseStanzaDominant(members);
    const combo = members.map((line) => line.scans?.[0]).filter(Boolean);
    const quatrainMeta = combo.length === 4 ? scoreQuatrainCombo(combo, context) : null;
    return {
      stanzaIndex,
      lineIndexes: stanzaLines.map((line) => line.index),
      dominantMeterKey: dominant.key,
      dominantMeterLabel: dominant.label,
      strength: Math.round(quatrainMeta?.bonus || dominant.score || 0),
      patternLabel: quatrainMeta?.patternLabel || 'assistant-selected stanza'
    };
  });

  const meterTally = new Map();
  finalLines.filter((line) => !line.blank).forEach((line) => {
    const top = line.scans?.[0];
    if (top) {
      meterTally.set(top.meterKey, (meterTally.get(top.meterKey) || 0) + (top.score || 0));
    }
  });

  const overall = inferOverallMeter(finalLines, stanzaResults, meterTally, context);
  const overallLabel = overall === 'common_meter'
    ? 'common meter'
    : (METER_LIBRARY.find((meter) => meter.key === overall) || METER_LIBRARY.at(-1)).label;
  const rhymeAnalysis = hasAssistantRhyme(selection)
    ? buildAssistantRhymeAnalysis(structure, finalLines, selection, context)
    : buildRhymeAnalysis(structure, finalLines, context);
  const form = detectPoeticForm(structure, rhymeAnalysis.annotatedLines, stanzaResults, rhymeAnalysis.rhyme, overallLabel, context);

  return {
    poem: structure.normalized,
    overallMeter: overallLabel,
    stanzaResults,
    lines: rhymeAnalysis.annotatedLines,
    rhyme: rhymeAnalysis.rhyme,
    form,
    diagnostics: buildDiagnostics(rhymeAnalysis.annotatedLines, stanzaResults, form)
  };
}

function applyAssistantSelections(structure, baseLines, selection, context) {
  const lineSelections = new Map(
    normalizeAssistantLines(selection).map((line) => [line.lineNumber, line])
  );
  let nonBlankNumber = 0;

  return baseLines.map((line) => {
    if (line.blank) return line;
    nonBlankNumber += 1;
    const choice = lineSelections.get(nonBlankNumber);
    if (!choice) return line;
    return buildAssistantLineChoice(line, choice, context);
  });
}

function buildAssistantLineChoice(line, choice, context) {
  if (Number.isInteger(choice.optionId) && choice.optionId > 0) {
    const selected = line.scans[choice.optionId - 1];
    if (selected) {
      const remaining = line.scans.filter((_, index) => index !== choice.optionId - 1).map((scan) => ({
        ...scan,
        confidence: clamp((scan.confidence || 0) - 2, 50, 100),
        isPrimary: false
      }));

      const scans = [
        {
          ...selected,
          confidence: clamp(Math.max(selected.confidence || 0, 97), 50, 100),
          isPrimary: true
        },
        ...remaining
      ];

      return hydrateLineMetadata({
        ...line,
        tag: scans[0].meterLabel,
        confidence: scans[0].confidence,
        scans
      });
    }
  }

  const requestedStress = sanitizeAssistantStressPattern(choice.stressPattern);
  const requestedMeterKey = sanitizeMeterKey(choice.meterKey);

  if (!requestedStress || !requestedMeterKey) {
    return line;
  }

  const exact = line.scans.find((scan) => {
    return sanitizeAssistantStressPattern(scan.stressPattern) === requestedStress && scan.meterKey === requestedMeterKey;
  });

  const primary = exact || createSyntheticAssistantScan(line, requestedMeterKey, requestedStress, context);
  const remaining = line.scans.filter((scan) => {
    return !(sanitizeAssistantStressPattern(scan.stressPattern) === sanitizeAssistantStressPattern(primary.stressPattern) && scan.meterKey === primary.meterKey);
  }).map((scan) => ({
    ...scan,
    confidence: clamp((scan.confidence || 0) - 2, 50, 100),
    isPrimary: false
  }));

  const scans = [
    {
      ...primary,
      confidence: clamp(Math.max(primary.confidence || 0, 97), 50, 100),
      isPrimary: true
    },
    ...remaining
  ];

  return hydrateLineMetadata({
    ...line,
    tag: scans[0].meterLabel,
    confidence: scans[0].confidence,
    scans
  });
}

function createSyntheticAssistantScan(line, meterKey, stressPattern, context) {
  const stress = stressPattern.split('');
  const fittedPieces = fitSyntheticPieces(line, stress);
  const candidate = {
    pieces: fittedPieces,
    stress,
    syllables: stress.length,
    sources: fittedPieces.map((piece) => piece.source || 'assistant')
  };
  const meter = METER_LIBRARY.find((entry) => entry.key === meterKey) || METER_LIBRARY.at(-1);
  const scored = meterKey === 'accentual_loose'
    ? scoreAccentual(candidate, line.tokens, context)
    : scoreAgainstMeter(candidate, meter, line.tokens, context);
  const scan = formatScan(scored, true, line.tokens, line.text);
  return {
    ...scan,
    confidence: clamp(Math.max(scan.confidence || 0, 96), 50, 100),
    score: Math.max(scan.score || 0, 96),
    observations: [...new Set([...(scan.observations || []), 'assistant disambiguation'])]
  };
}

function fitSyntheticPieces(line, stress) {
  const optionsByToken = (line.tokens || []).map((token) => collapseTokenOptions(token));
  const targetLength = stress.length;
  let states = new Map([[0, { cost: 0, pieces: [] }]]);

  for (let tokenIndex = 0; tokenIndex < optionsByToken.length; tokenIndex += 1) {
    const options = optionsByToken[tokenIndex];
    const active = line.tokens[tokenIndex]?.activeVariant || null;
    const next = new Map();

    for (const [position, state] of states.entries()) {
      for (const option of options) {
        const nextPosition = position + option.syllables;
        if (nextPosition > targetLength + 2) continue;
        const nextState = {
          cost: state.cost + syntheticPieceCost(option, active),
          pieces: [...state.pieces, option]
        };
        const current = next.get(nextPosition);
        if (!current || nextState.cost < current.cost) {
          next.set(nextPosition, nextState);
        }
      }
    }

    states = next.size ? next : states;
  }

  const best = [...states.entries()].sort((left, right) => {
    const leftScore = Math.abs(left[0] - targetLength) * 8 + left[1].cost;
    const rightScore = Math.abs(right[0] - targetLength) * 8 + right[1].cost;
    return leftScore - rightScore;
  })[0]?.[1] || { pieces: [] };

  const segments = splitStressAcrossPieces(stress, best.pieces);
  return best.pieces.map((piece, index) => ({
    pronunciation: piece.pronunciation,
    syllables: piece.syllables,
    stress: segments[index],
    source: piece.source || 'assistant'
  }));
}

function collapseTokenOptions(token) {
  const options = token?.options || [];
  const bySyllables = new Map();
  for (const option of options) {
    const key = option.syllables;
    const current = bySyllables.get(key);
    const cost = syntheticPieceCost(option, token?.activeVariant || null);
    if (!current || cost < syntheticPieceCost(current, token?.activeVariant || null)) {
      bySyllables.set(key, option);
    }
  }

  if (!bySyllables.size && token?.activeVariant) {
    bySyllables.set(token.activeVariant.stress.length, {
      source: token.activeVariant.source,
      syllables: token.activeVariant.stress.length,
      pronunciation: token.activeVariant.pronunciation
    });
  }

  return [...bySyllables.values()];
}

function syntheticPieceCost(option, activeVariant) {
  let cost = 0;
  if (activeVariant) {
    cost += Math.abs((option?.syllables || 0) - ((activeVariant?.stress || '').length || 0)) * 0.45;
  }
  const source = option?.source || '';
  if (source.startsWith('heuristic')) cost += 1.4;
  if (source.includes('compressed')) cost += 0.5;
  if (source.includes('promoted')) cost += 0.35;
  if (source.includes('flex-weak')) cost += 0.4;
  return cost;
}

function splitStressAcrossPieces(stress, pieces) {
  if (!pieces.length) return [];
  const total = pieces.reduce((sum, piece) => sum + (piece.syllables || 0), 0);
  const out = [];
  let cursor = 0;

  for (let index = 0; index < pieces.length; index += 1) {
    const syllables = Math.max(1, Number(pieces[index]?.syllables) || 1);
    const remainingPieces = pieces.length - index - 1;
    const remainingNeeded = pieces.slice(index + 1).reduce((sum, piece) => sum + Math.max(1, Number(piece?.syllables) || 1), 0);
    let nextCursor = cursor + syllables;
    const maxCursor = stress.length - remainingNeeded;
    nextCursor = clamp(nextCursor, cursor + 1, Math.max(cursor + 1, maxCursor));
    const slice = stress.slice(cursor, nextCursor);
    if (!slice.length) {
      slice.push(stress[Math.min(cursor, Math.max(0, stress.length - 1))] || 'u');
    }
    out.push(slice);
    cursor = nextCursor;
  }

  if (cursor < stress.length) {
    out[out.length - 1] = [...out[out.length - 1], ...stress.slice(cursor)];
  }

  if (total !== stress.length && out.length) {
    const flattened = out.flat();
    if (flattened.length > stress.length) {
      let overflow = flattened.length - stress.length;
      for (let index = out.length - 1; index >= 0 && overflow > 0; index -= 1) {
        while (out[index].length > 1 && overflow > 0) {
          out[index].pop();
          overflow -= 1;
        }
      }
    }
  }

  return out;
}

function hasAssistantRhyme(selection) {
  return normalizeAssistantLines(selection).some((line) => sanitizeRhymeLetter(line.rhymeLetter));
}

function buildAssistantRhymeAnalysis(structure, lines, selection, context) {
  const groups = new Map();
  const normalizedLines = normalizeAssistantLines(selection);
  const requestedLetters = new Map(normalizedLines.map((line) => [line.lineNumber, sanitizeRhymeLetter(line.rhymeLetter)]));
  let nonBlankNumber = 0;

  const stanzaAnalyses = structure.stanzas.map((stanzaLines, stanzaIndex) => {
    const details = stanzaLines.map((stanzaLine) => {
      const line = lines[stanzaLine.index];
      nonBlankNumber += 1;
      const letter = requestedLetters.get(nonBlankNumber) || indexToSchemeLabel(groups.size);
      const profile = buildLineRhymeProfile(line, context?.profile);
      let group = groups.get(letter);

      if (!group) {
        group = {
          letter,
          perfectKeys: new Set(profile.perfectKey ? [profile.perfectKey] : []),
          tailKeys: new Set(profile.tailKey ? [profile.tailKey] : []),
          vowelKeys: new Set(profile.vowelKey ? [profile.vowelKey] : []),
          codaKeys: new Set(profile.codaKey ? [profile.codaKey] : []),
          orthographicTails: new Set(profile.orthographicTail ? [profile.orthographicTail] : []),
          words: new Set(profile.normalizedWord ? [profile.normalizedWord] : []),
          members: []
        };
        groups.set(letter, group);
      }

      const match = group.members.length ? classifyRhymeGroupMatch(profile, group) : null;
      group.perfectKeys.add(profile.perfectKey);
      group.tailKeys.add(profile.tailKey);
      group.vowelKeys.add(profile.vowelKey);
      group.codaKeys.add(profile.codaKey);
      group.orthographicTails.add(profile.orthographicTail);
      group.words.add(profile.normalizedWord);
      group.members.push({
        index: line.index,
        text: line.text,
        word: profile.word,
        matchType: match?.type || 'unique',
        explanation: match?.explanation || 'Assigned by assistant poem-level rhyme judgment.'
      });

      return {
        index: line.index,
        letter,
        word: profile.word,
        matchType: match?.type || 'unique',
        explanation: match?.explanation || 'Assigned by assistant poem-level rhyme judgment.',
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
  });

  const groupList = [...groups.values()];
  const groupQualityByLetter = new Map(groupList.map((group) => [group.letter, summarizeRhymeGroupQuality(group)]));
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
      groups: groupList.map((group) => ({
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

async function requestAssistantSelection({
  poem,
  profileKey,
  analysis,
  promptPayload = null,
  apiKey
} = {}) {
  const payloadInput = promptPayload || buildAssistantPromptPayload(poem, profileKey, analysis);
  const payload = {
    model: OPENAI_SCAN_MODEL,
    reasoning: {
      effort: 'minimal'
    },
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You are an expert English prosodist. Return strict JSON only. Analyze the poem line by line. ' +
              'For each non-blank line, prefer one of the provided candidate options whenever it preserves the strongest natural reading and return its optionId. ' +
              'If none of the provided options is defensible, set optionId to null and return the best meterKey and full stressPattern using only "u" and "s". ' +
              'The stressPattern must describe the performed line, not just the canonical template. ' +
              'Use poem-wide context, syntax, rhetoric, rhyme, and stanza pattern to choose among ambiguous readings. ' +
              'Do not regularize a line into a perfectly even meter if the wording reads more naturally with substitution, inversion, or local stress shift. ' +
              'Prefer natural spoken emphasis over mechanical regularity. ' +
              'Allow inversion, pyrrhic and spondaic substitutions, catalexis, acephaly, and feminine endings when warranted. ' +
              'Also assign rhymeLetter values across the poem using standard rhyme-scheme notation. ' +
              'Allowed meterKey values: ' + METER_LIBRARY.map((meter) => meter.key).join(', ') + '. ' +
              'Return JSON in the shape {"lines":[{"lineNumber":1,"optionId":2,"meterKey":"...","stressPattern":"...","rhymeLetter":"A"}]}.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify(payloadInput)
          }
        ]
      }
    ],
    max_output_tokens: 4000
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  });

  if (!response.ok) {
    throw new Error(`OpenAI scan assistant failed with ${response.status}`);
  }

  const data = await response.json();
  const text = data.output_text || extractText(data) || '';
  const parsed = parseAssistantJson(text);
  const lines = normalizeAssistantLines(parsed);
  if (!lines.length) {
    throw new Error('Assistant returned no line selections.');
  }
  return parsed;
}

function buildAssistantPromptPayload(poem, profileKey, analysis) {
  const nonBlankLines = analysis.lines.filter((line) => !line.blank);
  return {
    profileHint: profileKey,
    poem,
    lineCount: nonBlankLines.length,
    deterministicOverallMeter: analysis.overallMeter,
    lines: nonBlankLines.map((line, index) => ({
      lineNumber: index + 1,
      text: line.text,
      candidates: line.scans.slice(0, 12).map((scan, scanIndex) => ({
        optionId: scanIndex + 1,
        meterKey: scan.meterKey,
        stressPattern: sanitizeAssistantStressPattern(scan.stressPattern),
        confidence: scan.confidence,
        score: scan.score,
        observations: scan.observations || []
      }))
    }))
  };
}

function parseAssistantJson(text) {
  const candidate = String(text || '').trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || candidate;
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  const jsonText = firstBrace >= 0 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : raw;
  return JSON.parse(jsonText);
}

function normalizeAssistantLines(value) {
  if (!Array.isArray(value?.lines)) return [];
  return value.lines
    .map((line) => ({
      lineNumber: Number(line?.lineNumber),
      optionId: Number.isInteger(Number(line?.optionId)) ? Number(line.optionId) : null,
      meterKey: sanitizeMeterKey(line?.meterKey),
      stressPattern: sanitizeAssistantStressPattern(line?.stressPattern),
      rhymeLetter: sanitizeRhymeLetter(line?.rhymeLetter)
    }))
    .filter((line) => {
      if (!Number.isInteger(line.lineNumber) || line.lineNumber <= 0) return false;
      if (Number.isInteger(line.optionId) && line.optionId > 0) return true;
      return Boolean(line.meterKey && line.stressPattern);
    });
}

function sanitizeAssistantStressPattern(value) {
  return String(value || '').toLowerCase().replace(/[^su]/g, '');
}

function sanitizeMeterKey(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (METER_LIBRARY.some((meter) => meter.key === raw)) {
    return raw;
  }
  return '';
}

function sanitizeRhymeLetter(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!raw) return '';
  return raw.slice(0, 3);
}

function buildAssistantCachePath(cacheDir, profileKey, promptPayload, cacheSeed) {
  const digest = crypto
    .createHash('sha1')
    .update(`${ASSISTANT_SCAN_PROMPT_VERSION}\n${OPENAI_SCAN_MODEL}\n${profileKey}\n${cacheSeed}\n${JSON.stringify(promptPayload)}`)
    .digest('hex');
  return path.join(cacheDir, `${digest}.json`);
}

async function readAssistantCache(cachePath) {
  try {
    const text = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeAssistantCache(cachePath, value) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(value, null, 2), 'utf8');
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

  let optimizedLines = optimizePoemReadings(finalLines, structure, context);
  optimizedLines = applyStrictTetrameterPoemRepair(optimizedLines, structure);
  optimizedLines = applyStrictDominantTetrameterFootDropRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictDominantPentameterFootDropRepair(optimizedLines, structure, context);
  optimizedLines = applyRepeatingStanzaPatternRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictCleanPentameterAlternativeRepair(optimizedLines, structure);
  optimizedLines = applyStrictCleanerDominantPentameterAlternativeRepair(optimizedLines, structure);
  optimizedLines = applyStrictFeminineEndingRetentionRepair(optimizedLines, structure);
  optimizedLines = applyStrictDominantPentameterReversionRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictFinalHexameterClosureRepair(optimizedLines, structure);
  optimizedLines = applyStrictExpandedSameMeterSurfaceRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictInitialSpondaicOpeningRepair(optimizedLines, structure);
  optimizedLines = applyStrictContractedPentameterStressRepair(optimizedLines, structure);
  optimizedLines = applyStrictAlternatingQuatrainOpeningRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictTwoLineAnapesticCoupletRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictDominantTrimeterShortLineRepair(optimizedLines, structure);
  optimizedLines = applyStrictDominantMeterRecastRepair(optimizedLines, structure, context);
  optimizedLines = applyStrictAlexandrineRepair(optimizedLines, structure);
    optimizedLines = applyStrictSameMeterSubstitutionPromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictSurfaceRetentionRepair(optimizedLines, structure);
    optimizedLines = applyStrictLatePromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictFinalPromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictLastChancePromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictTerminalPromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictReservePromotionRepair(optimizedLines, structure);
    optimizedLines = applyStrictGenericPromotionRepair(optimizedLines, structure);
    const meterTally = new Map();
  optimizedLines.filter((l) => !l.blank).forEach((line) => {
    const top = line.scans[0];
    if (top) meterTally.set(top.meterKey, (meterTally.get(top.meterKey) || 0) + top.score);
  });

  const overall = inferOverallMeter(optimizedLines, stanzaResults, meterTally, context);
  const overallLabel = overall === 'common_meter'
    ? 'common meter'
    : (METER_LIBRARY.find((m) => m.key === overall) || METER_LIBRARY.at(-1)).label;
  const rhymeAnalysis = buildRhymeAnalysis(structure, optimizedLines, context);
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
  const ranked = rankMeters(candidates, tokens, context);
  const reranked = rerankScans(ranked, tokens);
  const scans = reranked
    .filter((scan) => !scan.reserveCandidate)
    .slice(0, 48)
    .map((scan, i) => formatScan(scan, i === 0, tokens, text));
  const reserveScans = reranked
    .filter((scan) => scan.reserveCandidate)
    .slice(0, 48)
    .map((scan) => formatScan(scan, false, tokens, text));
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
    reserveScans,
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
    const split = splitLeadingElidedArticle(raw, cleaned);
    if (split) {
      parts.push({
        index: tokenIndex,
        raw: split.articleRaw,
        normalized: split.articleNormalized,
        isFunctionWord: true,
        start: match.index,
        end: match.index + split.articleRaw.length
      });
      tokenIndex += 1;

      if (split.wordNormalized) {
        parts.push({
          index: tokenIndex,
          raw: split.wordRaw,
          normalized: split.wordNormalized,
          isFunctionWord: matchesWordSet(split.wordNormalized, FUNCTION_WORDS),
          start: match.index + split.articleRaw.length,
          end: match.index + raw.length
        });
        tokenIndex += 1;
      }
      continue;
    }
    parts.push({
      index: tokenIndex,
      raw,
      normalized: cleaned,
      isFunctionWord: matchesWordSet(cleaned, FUNCTION_WORDS),
      start: match.index,
      end: match.index + raw.length
    });
    tokenIndex += 1;
  }
  return parts;
}

function splitLeadingElidedArticle(raw, normalized) {
  const rawValue = String(raw || '');
  const normalizedValue = String(normalized || '');
  const directArticle = /^th['’]?$/i.test(rawValue) || normalizedValue === 'th';
  if (directArticle) {
    return {
      articleRaw: rawValue,
      articleNormalized: 'the',
      wordRaw: '',
      wordNormalized: ''
    };
  }

  const match = rawValue.match(/^([Tt]h['’])(.*)$/);
  if (!match) {
    return null;
  }

  const articleRaw = match[1];
  const wordRaw = match[2];
  const wordNormalized = normalizeWord(wordRaw);
  if (!wordNormalized) {
    return {
      articleRaw,
      articleNormalized: 'the',
      wordRaw: '',
      wordNormalized: ''
    };
  }

  return {
    articleRaw,
    articleNormalized: 'the',
    wordRaw,
    wordNormalized
  };
}

function normalizeWord(word) {
  const normalized = word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2019]/g, "'")
    .replace(/[’]/g, "'")
    .replace(/^[-']+|[-']+$/g, '')
    .replace(/[^a-z'\-]/g, '');

  return /[a-z]/.test(normalized) ? normalized : '';
}

function expandWordForms(normalized) {
  const value = String(normalized || '').toLowerCase();
  if (!value) return [];

  const forms = new Set([value]);
  if (value.includes("'")) {
    forms.add(value.replace(/'/g, ''));
  }
  if (value.endsWith("'s") && value.length > 3) {
    forms.add(value.slice(0, -2));
  }
  if (value.endsWith("s'") && value.length > 3) {
    forms.add(value.slice(0, -1));
  }

  for (const suffix of FUNCTION_CONTRACTION_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length + 1) {
      forms.add(value.slice(0, -suffix.length));
    }
  }

  if (value.endsWith("in'") && value.length > 3) {
    forms.add(value.replace(/in'$/, 'ing'));
  }

  return [...forms].filter(Boolean);
}

function lookupUvaLexiconCandidates(normalized, profile, existing = [], options = {}) {
  if (!normalized || !HAS_UVA_WORD_STRESS_LEXICON) {
    return [];
  }

  if (options.isFunctionWord) {
    return [];
  }

  const lookupForms = new Set([
    normalized,
    normalized.replace(/-/g, ''),
    normalized.replace(/'/g, ''),
    normalized.replace(/[-']/g, '')
  ]);
  expandWordForms(normalized).forEach((form) => {
    lookupForms.add(form);
    lookupForms.add(form.replace(/-/g, ''));
  });

  const existingStress = new Set(existing.map((entry) => entry.stress.join('')));
  const hasTrustedExisting = existing.some((entry) => {
    return !entry.source.startsWith('heuristic') && !entry.source.startsWith('constructed-cmu-derived');
  });
  const candidates = [];

  for (const form of lookupForms) {
    const entry = UVA_WORD_STRESS_LEXICON[form];
    if (!entry) continue;

    const profilePatterns = profile?.key ? entry.profiles?.[profile.key] || null : null;
    const patternTable = profilePatterns && Object.keys(profilePatterns).length ? profilePatterns : entry.patterns || {};
    const total = Object.values(patternTable).reduce((sum, count) => sum + Number(count || 0), 0);
    const normalizedForm = form === normalized || form === normalized.replace(/-/g, '');
    const allowSingleObservation = !hasTrustedExisting || Boolean(profilePatterns) || !normalizedForm;

    for (const [pattern, count] of Object.entries(patternTable).sort((left, right) => right[1] - left[1])) {
      const stress = String(pattern || '').replace(/[^su]/g, '').split('');
      if (!stress.length || existingStress.has(stress.join(''))) continue;
      if (stress.length === 1 && hasTrustedExisting) continue;
      if (count < (allowSingleObservation ? 1 : 2)) continue;

      candidates.push({
        pronunciation: `uva:${normalized}<-${form}:${stress.join('')}`,
        syllables: stress.length,
        stress,
        source: profilePatterns ? 'uva-lexicon-profile' : 'uva-lexicon',
        lexiconCount: count,
        lexiconTotal: total
      });
      existingStress.add(stress.join(''));
    }
  }

  return candidates;
}

function matchesWordSet(normalized, set) {
  return expandWordForms(normalized).some((form) => set.has(form));
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
    const ranked = rankPronunciationCandidates(dedupeCandidates([...base, ...contextual]), context?.profile).slice(0, 12);
    const override = getOverrideCandidate(token, context?.overrides);

    if (!override) {
      return {
        options: ranked,
        active: ranked
      };
    }

    const merged = rankPronunciationCandidates(dedupeCandidates([override, ...ranked]), context?.profile).slice(0, 12);
    return {
      override,
      options: merged,
      active: [override]
    };
  });
}

function lookupPronunciations(normalized, raw, isFunctionWord, profile) {
  const variants = new Set([normalized]);
  const apostropheExpansionAllowed = normalized.includes("'") && /^[A-Z]/.test(String(raw || ''));
  if (CLITICS.has(normalized) && !hasDirectUvaLexiconEntry(normalized)) variants.add(CLITICS.get(normalized));
  if (normalized.endsWith("'d")) variants.add(normalized.replace(/'d$/, 'ed'));
  if (normalized.endsWith("'st")) variants.add(normalized.replace(/'st$/, 'est'));
  if (normalized.endsWith("in'")) variants.add(normalized.replace(/in'$/, 'ing'));
  if (normalized.includes('-')) variants.add(normalized.replace(/-/g, ''));
  if (apostropheExpansionAllowed) {
    expandWordForms(normalized).forEach((variant) => variants.add(variant));
  }
  expandSpellingVariants(normalized).forEach((variant) => variants.add(variant));
  let found = collectDictionaryPronunciations(variants, normalized);

  if (!found.length) {
    expandArchaicSpellings(normalized).forEach((variant) => variants.add(variant));
    expandSpellingVariants(normalized).forEach((variant) => variants.add(variant));
    found = collectDictionaryPronunciations(variants, normalized);
  }

  found.push(...buildConstructedArchaicCandidates(normalized));
  found.push(...lookupManualPronunciationCandidates(normalized));
  found.push(...buildDerivedCandidates(normalized, raw, isFunctionWord, profile, found));
  found.push(...lookupUvaLexiconCandidates(normalized, profile, found, { isFunctionWord }));

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

  const heuristic = heuristicPronunciations(normalized, raw, isFunctionWord, profile);
  if (apostropheExpansionAllowed) {
    for (const variant of expandWordForms(normalized)) {
      if (!variant || variant === normalized || variant.includes("'")) {
        continue;
      }
      heuristic.push(...heuristicPronunciations(variant, `${raw}<-${variant}`, isFunctionWord, profile).map((entry) => ({
        ...entry,
        source: `${entry.source}-normalized`
      })));
    }
  }
  heuristic.push(...heuristic.flatMap((entry) => {
    return buildPoeticStressVariants(normalized, entry.stress, profile).map((stress, index) => ({
      ...entry,
      syllables: stress.length,
      stress,
      source: `${entry.source}-poetic-${index + 1}`
    }));
  }));
  heuristic.push(...heuristic.flatMap((entry) => {
    return buildCompressedStressVariants(entry.stress).map((stress, index) => ({
      ...entry,
      syllables: stress.length,
      stress,
      source: `${entry.source}-compressed-${index + 1}`
    }));
  }));
  return heuristic;
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

function lookupManualPronunciationCandidates(normalized) {
  return (MANUAL_PRONUNCIATION_CANDIDATES.get(normalized) || []).map((entry) => ({
    pronunciation: entry.pronunciation,
    syllables: entry.stress.length,
    stress: [...entry.stress],
    source: entry.source
  }));
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

function expandSpellingVariants(normalized) {
  const variants = new Set();

  if (normalized.endsWith('ies') && normalized.length > 4) {
    variants.add(`${normalized.slice(0, -3)}y`);
    variants.add(normalized.slice(0, -2));
  }

  if (normalized.endsWith('ie') && normalized.length > 4) {
    variants.add(`${normalized.slice(0, -2)}y`);
  }

  if (normalized.endsWith('e') && normalized.length > 4) {
    variants.add(normalized.slice(0, -1));
  }

  if (/([b-df-hj-np-tv-z])\1e$/.test(normalized)) {
    variants.add(normalized.replace(/([b-df-hj-np-tv-z])\1e$/, '$1'));
  }

  if (normalized.endsWith('owes') && normalized.length > 5) {
    variants.add(`${normalized.slice(0, -4)}ows`);
  }

  if (normalized.length >= 5 && normalized.includes('v')) {
    variants.add(normalized.replace(/v/g, 'u'));
  }

  if (normalized.length >= 5 && normalized.includes('u')) {
    variants.add(normalized.replace(/u/g, 'v'));
  }

  if (normalized.length >= 5 && normalized.includes('y')) {
    variants.add(normalized.replace(/y/g, 'i'));
  }

  if (normalized.length >= 5 && normalized.includes('i')) {
    variants.add(normalized.replace(/i/g, 'y'));
  }

  if (normalized.endsWith('ayne')) {
    variants.add(`${normalized.slice(0, -4)}ain`);
  }

  return [...variants].filter((variant) => variant && variant !== normalized);
}

function collectBasePronunciations(normalized) {
  const variants = new Set([normalized]);
  expandArchaicSpellings(normalized).forEach((variant) => variants.add(variant));
  expandSpellingVariants(normalized).forEach((variant) => variants.add(variant));
  const found = collectDictionaryPronunciations(variants, normalized);
  found.push(...buildConstructedArchaicCandidates(normalized));
  return dedupeCandidates(found);
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

  for (const reduced of buildTrisyllabicPoeticCompression(normalized, stress)) {
    variants.set(reduced.join(''), reduced);
  }

  return [...variants.values()].filter((variant) => variant.join('') !== stress.join(''));
}

function buildTrisyllabicPoeticCompression(normalized, stress) {
  if (stress.length !== 3) {
    return [];
  }

  if (!TRISYLLABIC_POETIC_COMPRESSION_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return [];
  }

  const pattern = stress.join('');
  if (pattern === 'suu') {
    return [['s', 'u'], ['u', 's']];
  }
  if (pattern === 'usu' || pattern === 'uus') {
    return [['u', 's']];
  }

  return [];
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

function buildDerivedCandidates(normalized, raw, isFunctionWord, profile, directEntries = []) {
  const derived = [];
  derived.push(...buildExpandedOrthographicCandidates(normalized, directEntries));
  derived.push(...buildWeakSuffixCandidates(normalized, profile));
  derived.push(...buildSimpleInflectionCandidates(normalized, profile));
  derived.push(...buildCompoundCandidates(normalized, profile));
  return dedupeCandidates(derived);
}

function buildExpandedOrthographicCandidates(normalized, entries) {
  if (!/(uous|ious|eous)$/.test(normalized)) return [];

  const variants = [];
  for (const entry of entries) {
    if (!entry.source.includes('cmu') || entry.syllables !== 2) continue;
    const expanded = [entry.stress[0] || 's', 'u', entry.stress[1] || 'u'];
    variants.push({
      ...entry,
      pronunciation: `orthographic:${normalized}`,
      syllables: expanded.length,
      stress: expanded,
      source: `${entry.source}-orthographic-expand`
    });
  }

  return variants;
}

function buildWeakSuffixCandidates(normalized, profile) {
  const variants = [];

  for (const rule of WEAK_SUFFIX_RULES) {
    if (!normalized.endsWith(rule.suffix)) continue;
    const baseForms = rule.baseForms(normalized).filter((base) => base && base.length >= (rule.minBaseLength || 2));
    for (const base of baseForms) {
      const baseCandidates = rankPronunciationCandidates(collectBasePronunciations(base), profile)
        .filter((entry) => !entry.source.startsWith('heuristic'))
        .slice(0, 4);
      for (const entry of baseCandidates) {
        variants.push({
          pronunciation: `derived:${normalized}<-${base}+${rule.suffix}`,
          syllables: entry.stress.length + rule.extraStress.length,
          stress: [...entry.stress, ...rule.extraStress],
          source: 'constructed-cmu-derived'
        });
      }
    }
  }

  if (normalized.startsWith('un') && normalized.length > 4) {
    const base = normalized.slice(2);
    const baseCandidates = rankPronunciationCandidates(collectBasePronunciations(base), profile)
      .filter((entry) => !entry.source.startsWith('heuristic'))
      .slice(0, 4);
    for (const entry of baseCandidates) {
      variants.push({
        pronunciation: `derived:${normalized}<-un+${base}`,
        syllables: entry.stress.length + 1,
        stress: ['u', ...entry.stress],
        source: 'constructed-cmu-derived'
      });
    }
  }

  return variants;
}

function buildSimpleInflectionCandidates(normalized, profile) {
  const variants = [];
  const forms = [];

  if (normalized.endsWith('ies') && normalized.length > 4) {
    forms.push({ base: `${normalized.slice(0, -3)}y`, extraStress: [] });
  }

  if (normalized.endsWith('es') && normalized.length > 4) {
    forms.push({ base: normalized.slice(0, -2), extraStress: [] });
    forms.push({ base: normalized.slice(0, -1), extraStress: [] });
  }

  if (normalized.endsWith('s') && normalized.length > 3) {
    forms.push({ base: normalized.slice(0, -1), extraStress: [] });
  }

  if (normalized.endsWith('ed') && normalized.length > 4) {
    forms.push({ base: normalized.slice(0, -2), extraStress: [] });
    forms.push({ base: normalized.slice(0, -2), extraStress: ['u'] });
  }

  for (const form of forms) {
    if (!form.base || form.base === normalized || form.base.length < 2) continue;
    const baseCandidates = rankPronunciationCandidates(collectBasePronunciations(form.base), profile)
      .filter((entry) => !entry.source.startsWith('heuristic'))
      .slice(0, 4);
    for (const entry of baseCandidates) {
      variants.push({
        pronunciation: `derived:${normalized}<-${form.base}`,
        syllables: entry.stress.length + form.extraStress.length,
        stress: [...entry.stress, ...form.extraStress],
        source: 'constructed-cmu-derived'
      });
    }
  }

  return variants;
}

function buildCompoundCandidates(normalized, profile) {
  const compounds = [];
  const explicitParts = normalized.includes('-') ? normalized.split('-').filter(Boolean) : [];
  if (explicitParts.length >= 2) {
    compounds.push(...composeCompoundCandidates(explicitParts, normalized, profile));
  }

  if (!explicitParts.length && normalized.length >= 7) {
    for (let index = COMPOUND_SPLIT_MIN; index <= normalized.length - COMPOUND_SPLIT_MIN; index += 1) {
      const left = normalized.slice(0, index);
      const right = normalized.slice(index);
      const leftCandidates = collectBasePronunciations(left);
      const rightCandidates = collectBasePronunciations(right);
      if (!leftCandidates.length || !rightCandidates.length) continue;
      compounds.push(...composeCompoundCandidates([left, right], normalized, profile));
    }
  }

  return dedupeCandidates(compounds).slice(0, 12);
}

function composeCompoundCandidates(parts, original, profile) {
  const partCandidates = parts.map((part) => {
    return rankPronunciationCandidates(collectBasePronunciations(part), profile)
      .filter((entry) => !entry.source.startsWith('heuristic'))
      .slice(0, 3);
  });

  if (partCandidates.some((options) => !options.length)) return [];

  let states = [{ stress: [], syllables: 0, pronunciation: [], source: [] }];
  for (const options of partCandidates) {
    const next = [];
    for (const state of states) {
      for (const option of options) {
        next.push({
          stress: [...state.stress, ...option.stress],
          syllables: state.syllables + option.syllables,
          pronunciation: [...state.pronunciation, option.pronunciation],
          source: [...state.source, option.source]
        });
      }
    }
    next.sort((left, right) => left.syllables - right.syllables || left.stress.length - right.stress.length);
    states = next.slice(0, 9);
  }

  return states.map((state) => ({
    pronunciation: `compound:${original}<-${parts.join('+')}:${state.pronunciation.join('|')}`,
    syllables: state.syllables,
    stress: state.stress,
    source: 'constructed-cmu-compound'
  }));
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
        source: `${candidate.source}-${matchesWordSet(token.normalized, STRESSABLE_FUNCTION_WORDS) ? 'promoted' : 'promoted-rare'}${profile?.key === 'hymn' ? '-profile' : ''}`
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

  if (!prevToken && !token.isFunctionWord) {
    for (const candidate of candidates) {
      if (
        candidate.syllables === 2 &&
        candidate.stress.join('') === 'su' &&
        !candidate.source.includes('demoted') &&
        !candidate.source.includes('compressed')
      ) {
        contextual.push({
          ...candidate,
          stress: ['u', 's'],
          source: `${candidate.source}-line-initial-iambic`
        });
      }

      if (
        candidate.syllables === 3 &&
        ['suu', 'sus'].includes(candidate.stress.join('')) &&
        token.normalized.endsWith('ly') &&
        !candidate.source.includes('demoted') &&
        !candidate.source.includes('compressed')
      ) {
        contextual.push({
          ...candidate,
          stress: ['u', 's', 'u'],
          source: `${candidate.source}-line-initial-iambic`
        });
      }
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

  for (const candidate of candidates) {
    if (
      candidate.syllables < 2 ||
      candidate.stress[0] !== 's' ||
      !candidate.stress.slice(1).some((value) => value === 's') ||
      (!candidate.source.includes('compound') && !token.raw.includes('-'))
    ) {
      continue;
    }

    contextual.push({
      ...candidate,
      stress: ['s', ...Array.from({ length: candidate.syllables - 1 }, () => 'u')],
      source: `${candidate.source}-compound-primary`
    });
  }

  return contextual;
}

function shouldConsiderNominalStress(token, prevToken, nextToken) {
  if (token.isFunctionWord) return false;
  const prev = prevToken?.normalized || '';
  const next = nextToken?.normalized || '';
  return matchesWordSet(prev, NOMINAL_CONTEXT_WORDS) || matchesWordSet(next, NOMINAL_FOLLOWER_WORDS);
}

function rankPronunciationCandidates(candidates, profile) {
  return [...candidates].sort((a, b) => pronunciationCandidateCost(a, profile) - pronunciationCandidateCost(b, profile));
}

function pronunciationCandidateCost(candidate, profile) {
  const source = candidate.source;
  let cost = 0;

  if (source.startsWith('heuristic-alt')) cost += 3.4;
  else if (source.startsWith('heuristic-primary')) cost += 2.6;

  if (source.includes('normalized-cmu')) cost += 0.2;
  if (source.includes('constructed-cmu')) cost += 0.4;
  if (source.includes('demoted')) cost += 0.3;
  if (source.includes('poetic')) cost += 0.6;
  if (source.includes('manual')) cost += 0.08;
  if (source.includes('contextual')) cost += 0.9;
  if (source.includes('promoted')) cost += 1.1;
  if (source.includes('promoted-rare')) cost += 0.8;
  if (source.includes('line-initial-iambic')) cost += 0.52;
  if (source.includes('compressed')) cost += 1.2;
  if (source.includes('flex-weak')) cost += 0.42;
  if (source.includes('compound-shift')) cost += 1.1;
  if (source.includes('syllabic-ed')) cost += 0.5;
  if (source.includes('historic')) cost += 0.15;
  if (source.includes('uva-lexicon-profile')) cost += 0.18;
  else if (source.includes('uva-lexicon')) cost += 0.34;

  if (source.includes('poetic')) cost += profile?.poeticCostShift || 0;
  if (source.includes('contextual')) cost += profile?.contextualCostShift || 0;
  if (source.includes('promoted')) cost += profile?.promoteCostShift || 0;
  if (source.includes('uva-lexicon')) {
    const lexiconConfidence = candidate.lexiconTotal ? (candidate.lexiconCount || 0) / candidate.lexiconTotal : 0;
    cost -= Math.min(0.16, lexiconConfidence * 0.2);
  }

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

function pruneBeamDiverse(states, limit, scoreFn, bucketFn, perBucket = 6) {
  const buckets = new Map();

  for (const state of states) {
    const bucketKey = bucketFn(state);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey).push(state);
  }

  const kept = [];
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => scoreFn(left) - scoreFn(right));
    kept.push(...bucket.slice(0, perBucket));
  }

  kept.sort((left, right) => scoreFn(left) - scoreFn(right));
  return kept.slice(0, limit);
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
          sources: [...state.sources, option.source],
          origin: 'line'
        });
      }
    }
    states = pruneBeamDiverse(
      next,
      limit,
      (state) => scoreCandidateSimplicity(state, profile),
      (state) => `${state.syllables}:${state.stress.slice(-4).join('')}:${state.pieces.length}`,
      8
    );
  }

  return states;
}

function scoreCandidateSimplicity(candidate, profile) {
  return candidate.sources.reduce((sum, source) => {
    let cost = 0;
    if (source.startsWith('heuristic')) cost += 1.9;
    if (source.includes('manual')) cost += 0.1;
    if (source.includes('compressed')) cost += 0.8;
    if (source.includes('constructed-cmu')) cost += 0.35;
    if (source.includes('poetic')) cost += 0.5;
    if (source.includes('contextual')) cost += 0.7;
    if (source.includes('promoted')) cost += 0.9;
    if (source.includes('promoted-rare')) cost += 0.7;
    if (source.includes('flex-weak')) cost += 0.24;
    if (source.includes('compound-shift')) cost += 0.8;
    if (source.includes('syllabic-ed')) cost += 0.45;
    if (source.includes('historic')) cost += 0.12;
    if (source.includes('poetic')) cost += profile?.poeticCostShift || 0;
    if (source.includes('contextual')) cost += profile?.contextualCostShift || 0;
    if (source.includes('promoted')) cost += profile?.promoteCostShift || 0;
    return sum + cost;
  }, 0) + candidate.syllables * 0.01;
}

function buildSyllableBounds(tokenCandidates) {
  const minAfter = Array(tokenCandidates.length + 1).fill(0);
  const maxAfter = Array(tokenCandidates.length + 1).fill(0);

  for (let index = tokenCandidates.length - 1; index >= 0; index -= 1) {
    const syllables = tokenCandidates[index].map((option) => option.syllables);
    minAfter[index] = minAfter[index + 1] + Math.min(...syllables);
    maxAfter[index] = maxAfter[index + 1] + Math.max(...syllables);
  }

  return { minAfter, maxAfter };
}

function selectFeasibleMeters(tokenEntries) {
  const tokenCandidates = tokenEntries.map((entry) => entry.active);
  const bounds = buildSyllableBounds(tokenCandidates);
  const minimum = bounds.minAfter[0];
  const maximum = bounds.maxAfter[0];
  const feasible = METER_LIBRARY.filter((meter) => {
    if (meter.key === 'accentual_loose') return false;
    const targetLength = meter.feet * meter.pattern.length;
    const lower = Math.max(1, minimum - 2);
    const upperSlack = meter.pattern.length === 3 ? 3 : 2;
    const upper = maximum + upperSlack;
    return targetLength >= lower && targetLength <= upper;
  });

  if (feasible.length >= 6) {
    return feasible;
  }

  const estimated = Math.round((minimum + maximum) / 2);
  return METER_LIBRARY
    .filter((meter) => meter.key !== 'accentual_loose')
    .sort((left, right) => {
      const leftDistance = Math.abs(left.feet * left.pattern.length - estimated);
      const rightDistance = Math.abs(right.feet * right.pattern.length - estimated);
      return leftDistance - rightDistance || left.pattern.length - right.pattern.length || left.key.localeCompare(right.key);
    })
    .slice(0, 12);
}

function guidedOptionCost(option, profile) {
  return pronunciationCandidateCost(option, profile) * 0.62;
}

function estimatePartialAlignmentPenalty(actual, target, meter) {
  if (!actual.length) return 0;

  let penalty = 0;
  let comparisonActual = actual;
  let comparisonTarget = target.slice(0, Math.min(actual.length, target.length));

  if (actual.length > target.length) {
    const overflow = actual.length - target.length;
    comparisonActual = actual.slice(0, target.length);
    comparisonTarget = target;
    penalty += overflow * (actual[actual.length - 1] === 'u' ? 0.52 : 0.9);
  }

  penalty += patternMismatchPenalty(comparisonActual, comparisonTarget, meter, []);
  return penalty;
}

function dedupeCompositeCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const lastPronunciation = candidate.pieces.at(-1)?.pronunciation || '';
    const key = `${candidate.syllables}:${candidate.stress.join('')}:${lastPronunciation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function buildStructuredTokenOptions(tokenEntries) {
  return tokenEntries.map((entry) => {
    const options = entry?.override ? entry.active : entry.options;
    return (options || []).slice(0, 8);
  });
}

function meterFootVariants(meter) {
  const canonical = meter.pattern.join('');
  if (meter.pattern.length === 2) {
    return [canonical, canonical === 'us' ? 'su' : 'us', 'ss', 'uu'];
  }

  if (meter.pattern.length === 3) {
    return [canonical, ...STRUCTURED_TERNARY_FEET.filter((value) => value !== canonical)];
  }

  return [canonical];
}

function structuredSubstitutionBudget(meter) {
  if (meter.feet >= 5) return 3;
  if (meter.feet >= 4) return 2;
  return 1;
}

function structuredFootPenalty(foot, meter, footIndex) {
  const targetFoot = meter.pattern.join('');
  if (meter.pattern.length === 2) {
    return binaryFootPenalty(foot, targetFoot, meter, footIndex, []);
  }
  if (meter.pattern.length === 3) {
    return ternaryFootPenalty(foot, targetFoot, meter, footIndex, []);
  }
  return foot === targetFoot ? 0 : 1.2;
}

function enumerateStructuredStressTemplates(meter, limit = 48) {
  const variants = meterFootVariants(meter);
  const canonical = meter.pattern.join('');
  const budget = structuredSubstitutionBudget(meter);
  const out = [];

  function visit(footIndex, feet, cost, substitutions) {
    if (footIndex === meter.feet) {
      out.push({
        stress: feet.join('').split(''),
        patternCost: cost,
        substitutions
      });
      return;
    }

    for (const foot of variants) {
      const nextSubstitutions = substitutions + (foot === canonical ? 0 : 1);
      if (nextSubstitutions > budget) continue;
      visit(
        footIndex + 1,
        [...feet, foot],
        cost + structuredFootPenalty(foot, meter, footIndex),
        nextSubstitutions
      );
    }
  }

  visit(0, [], 0, 0);
  return out
    .sort((left, right) => left.patternCost - right.patternCost || left.substitutions - right.substitutions)
    .slice(0, limit);
}

function alignedStressMismatchCost(option, slice, token, profile) {
  let cost = pronunciationCandidateCost(option, profile) * 0.18;

  for (let index = 0; index < slice.length; index += 1) {
    const targetStress = slice[index];
    const optionStress = option.stress[index] || option.stress.at(-1) || 'u';
    if (targetStress === optionStress) continue;

    if (option.syllables === 1 && token?.isFunctionWord) {
      cost += targetStress === 's' ? 0.2 : 0.12;
      continue;
    }

    if (option.syllables === 1) {
      cost += optionStress === 's' ? 0.42 : 0.34;
      continue;
    }

    cost += optionStress === 's' ? 0.52 : 0.46;
  }

  return cost;
}

function composeStructuredMeterCandidates(tokenEntries, tokens, meter, context, beamLimit = 128, templateLimit = 48, perMeterLimit = 12) {
  if (!tokenEntries.length || meter.key === 'accentual_loose') return [];

  const templates = enumerateStructuredStressTemplates(meter, templateLimit);
  const profile = context?.profile;
  const tokenOptions = buildStructuredTokenOptions(tokenEntries);
  const bounds = buildSyllableBounds(tokenOptions);
  const output = [];

  for (const template of templates) {
    const stress = template.stress;
    const targetLength = stress.length;
    let states = [{ position: 0, pieces: [], sources: [], fitCost: template.patternCost }];

    for (let tokenIndex = 0; tokenIndex < tokenOptions.length; tokenIndex += 1) {
      const next = [];
      const options = tokenOptions[tokenIndex];
      const minAfter = bounds.minAfter[tokenIndex + 1];
      const maxAfter = bounds.maxAfter[tokenIndex + 1];

      for (const state of states) {
        for (const option of options) {
          const nextPosition = state.position + option.syllables;
          if (nextPosition > targetLength) continue;
          if (nextPosition + minAfter > targetLength || nextPosition + maxAfter < targetLength) continue;

          const slice = stress.slice(state.position, nextPosition);
          next.push({
            position: nextPosition,
            pieces: [
              ...state.pieces,
              {
                pronunciation: option.pronunciation,
                syllables: option.syllables,
                stress: slice,
                source: option.source
              }
            ],
            sources: [...state.sources, option.source],
            fitCost: state.fitCost + alignedStressMismatchCost(option, slice, tokens[tokenIndex], profile)
          });
        }
      }

      states = pruneBeamDiverse(
        next,
        beamLimit,
        (state) => state.fitCost,
        (state) => `${state.position}:${state.pieces.length}:${state.pieces.slice(-2).map((piece) => piece.stress.join('')).join('|')}`,
        6
      );
      if (!states.length) break;
    }

    for (const state of states) {
      if (state.position !== targetLength) continue;
      output.push({
        pieces: state.pieces,
        stress,
        syllables: targetLength,
        sources: state.sources,
        beamScore: state.fitCost,
        origin: 'structured',
        patternSubstitutions: template.substitutions
      });
    }
  }

  return dedupeCompositeCandidates(
    output.sort((left, right) => left.beamScore - right.beamScore || left.syllables - right.syllables)
  ).slice(0, perMeterLimit);
}

function buildMetricalProjection(actual, target, meter) {
  const lengthDelta = actual.length - target.length;
  if (lengthDelta <= 0 || lengthDelta > 2) return null;

  const actualLength = actual.length;
  const targetLength = target.length;
  const impossible = Number.POSITIVE_INFINITY;
  const scores = Array.from({ length: actualLength + 1 }, () => Array(targetLength + 1).fill(impossible));
  const decisions = Array.from({ length: actualLength + 1 }, () => Array(targetLength + 1).fill(null));
  scores[0][0] = 0;

  for (let actualIndex = 0; actualIndex <= actualLength; actualIndex += 1) {
    for (let targetIndex = 0; targetIndex <= targetLength; targetIndex += 1) {
      const score = scores[actualIndex][targetIndex];
      if (!Number.isFinite(score)) continue;

      const remainingActual = actualLength - actualIndex;
      const remainingTarget = targetLength - targetIndex;
      if (remainingActual < remainingTarget) continue;

      if (actualIndex < actualLength && remainingActual > remainingTarget) {
        const nextScore = score + projectionDeletePenalty(actual, actualIndex, meter);
        if (nextScore < scores[actualIndex + 1][targetIndex]) {
          scores[actualIndex + 1][targetIndex] = nextScore;
          decisions[actualIndex + 1][targetIndex] = {
            actualIndex,
            targetIndex,
            action: 'delete'
          };
        }
      }

      if (actualIndex < actualLength && targetIndex < targetLength) {
        const nextScore = score + projectionMatchPenalty(actual[actualIndex], target[targetIndex]);
        if (nextScore < scores[actualIndex + 1][targetIndex + 1]) {
          scores[actualIndex + 1][targetIndex + 1] = nextScore;
          decisions[actualIndex + 1][targetIndex + 1] = {
            actualIndex,
            targetIndex,
            action: 'keep'
          };
        }
      }
    }
  }

  const totalPenalty = scores[actualLength][targetLength];
  if (!Number.isFinite(totalPenalty)) return null;

  const keptIndexes = [];
  let actualIndex = actualLength;
  let targetIndex = targetLength;
  while (actualIndex > 0 || targetIndex > 0) {
    const decision = decisions[actualIndex][targetIndex];
    if (!decision) return null;
    if (decision.action === 'keep') {
      keptIndexes.push(decision.actualIndex);
    }
    actualIndex = decision.actualIndex;
    targetIndex = decision.targetIndex;
  }

  keptIndexes.reverse();
  const stress = keptIndexes.map((index) => actual[index]);
  const omittedIndexes = [];
  let keptPointer = 0;
  for (let index = 0; index < actualLength; index += 1) {
    if (keptIndexes[keptPointer] === index) {
      keptPointer += 1;
    } else {
      omittedIndexes.push(index);
    }
  }

  return {
    stress,
    keptIndexes,
    omittedIndexes,
    deletionCount: omittedIndexes.length,
    penalty: totalPenalty
  };
}

function buildFootDropProjection(actual, target, meter, options = {}) {
  if (meter?.pattern?.length !== 2 || actual.length - target.length !== 2) {
    return null;
  }

  const canonicalFoot = meter.pattern.join('');
  const relaxed = Boolean(options.preferCanonicalFootDrop);
  let best = null;
  for (let start = 0; start <= actual.length - 2; start += 1) {
    const omittedIndexes = [start, start + 1];
    const keptIndexes = [];
    const keptStress = [];
    for (let index = 0; index < actual.length; index += 1) {
      if (index === start || index === start + 1) {
        continue;
      }
      keptIndexes.push(index);
      keptStress.push(actual[index]);
    }

    if (keptStress.length !== target.length) {
      continue;
    }

    let penalty = 0;
    for (let index = 0; index < target.length; index += 1) {
      penalty += projectionMatchPenalty(keptStress[index], target[index]);
    }

    const removedFoot = actual.slice(start, start + 2).join('');
    if (removedFoot === canonicalFoot) {
      penalty += relaxed ? 0.38 : 0.82;
    } else if (
      (meter.family === 'iambic' && removedFoot === 'su') ||
      (meter.family === 'trochaic' && removedFoot === 'us')
    ) {
      penalty += relaxed ? 0.58 : 1.04;
    } else if (removedFoot === 'uu' || removedFoot === 'ss') {
      penalty += relaxed ? 0.92 : 1.26;
    } else {
      penalty += relaxed ? 1.08 : 1.4;
    }

    const candidate = {
      stress: keptStress,
      keptIndexes,
      omittedIndexes,
      deletionCount: 2,
      penalty
    };
    if (!best || candidate.penalty < best.penalty) {
      best = candidate;
    }
  }

  return best;
}

function projectionDeletePenalty(actual, index, meter) {
  const stress = actual[index] || 'u';
  const prev = actual[index - 1] || '';
  const next = actual[index + 1] || '';
  let penalty = stress === 'u' ? 0.34 : 1.05;

  if (stress === 'u' && (prev === 'u' || next === 'u')) {
    penalty -= 0.12;
  }
  if (stress === 'u' && meter.pattern.length === 2 && next === 's') {
    penalty -= 0.08;
  }
  if (stress === 'u' && meter.pattern.length === 3 && (prev === 'u' || next === 'u')) {
    penalty -= 0.05;
  }

  return clamp(penalty, 0.14, 1.3);
}

function projectionMatchPenalty(actualStress, targetStress) {
  if (actualStress === targetStress) return 0;
  return actualStress === 'u' ? 0.22 : 0.28;
}

function mapFootBreaksToSurface(footBreaks, keptIndexes) {
  if (!Array.isArray(footBreaks) || !Array.isArray(keptIndexes) || !keptIndexes.length) {
    return footBreaks || [];
  }
  return footBreaks
    .map((breakIndex) => {
      const keptIndex = keptIndexes[breakIndex - 1];
      return Number.isInteger(keptIndex) ? keptIndex + 1 : null;
    })
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildDisplayStressMap(actual, projection) {
  if (!projection?.omittedIndexes?.length) {
    return actual.slice();
  }

  const omitted = new Set(projection.omittedIndexes);
  return actual.map((stress, index) => (omitted.has(index) ? null : stress));
}

function composeMeterCandidates(tokenCandidates, meter, context, beamLimit = 160, perMeterLimit = 12) {
  if (!tokenCandidates.length) return [];

  const profile = context?.profile;
  const target = Array.from({ length: meter.feet }).flatMap(() => meter.pattern);
  const targetLength = target.length;
  const bounds = buildSyllableBounds(tokenCandidates);
  let states = [{ pieces: [], stress: [], syllables: 0, sources: [], beamScore: 0 }];

  for (let tokenIndex = 0; tokenIndex < tokenCandidates.length; tokenIndex += 1) {
    const options = tokenCandidates[tokenIndex];
    const next = [];

    for (const state of states) {
      for (const option of options) {
        const stress = [...state.stress, ...option.stress];
        const syllables = state.syllables + option.syllables;
        const projectedMin = syllables + bounds.minAfter[tokenIndex + 1];
        const projectedMax = syllables + bounds.maxAfter[tokenIndex + 1];

        if (projectedMin > targetLength + 2 || projectedMax < targetLength - 2) {
          continue;
        }

        let beamScore = state.beamScore + guidedOptionCost(option, profile);
        beamScore += estimatePartialAlignmentPenalty(stress, target, meter) * 0.9;

        if (projectedMin > targetLength + 1) {
          beamScore += (projectedMin - (targetLength + 1)) * 1.2;
        } else if (projectedMax < targetLength - 1) {
          beamScore += ((targetLength - 1) - projectedMax) * 1.2;
        }

        next.push({
          pieces: [...state.pieces, option],
          stress,
          syllables,
          sources: [...state.sources, option.source],
          beamScore,
          origin: 'concatenative',
          patternSubstitutions: 0
        });
      }
    }

    states = pruneBeamDiverse(
      next,
      beamLimit,
      (state) => state.beamScore,
      (state) => `${state.syllables}:${state.stress.slice(-4).join('')}:${state.pieces.length}`,
      8
    );
  }

  const completed = states
    .map((state) => ({
      pieces: state.pieces,
      stress: state.stress,
      syllables: state.syllables,
      sources: state.sources,
      beamScore: state.beamScore,
      origin: 'concatenative',
      patternSubstitutions: 0
    }))
    .sort((left, right) => left.beamScore - right.beamScore || left.syllables - right.syllables);

  return dedupeCompositeCandidates(completed).slice(0, perMeterLimit);
}

function rankMeters(tokenEntries, tokens, context) {
  const tokenCandidates = tokenEntries.map((entry) => entry.active);
  const results = [];
  const feasibleMeters = selectFeasibleMeters(tokenEntries);

  for (const meter of feasibleMeters) {
    const candidates = composeMeterCandidates(tokenCandidates, meter, context, 160, 12);
    const structuredCandidates = composeStructuredMeterCandidates(tokenEntries, tokens, meter, context, 128, 48, 12);
    for (const candidate of candidates) {
      const scored = scoreAgainstMeter(candidate, meter, tokens, context);
      results.push(scored);
    }
    for (const candidate of structuredCandidates) {
      const scored = scoreAgainstMeter(candidate, meter, tokens, context);
      results.push(scored);
    }
  }

  const looseCandidates = composeLineCandidates(tokenCandidates, 384, context?.profile);
  for (const candidate of looseCandidates.slice(0, 72)) {
    for (const meter of feasibleMeters) {
      results.push(scoreAgainstMeter(candidate, meter, tokens, context));
    }
  }

  for (const candidate of looseCandidates.slice(0, 18)) {
    results.push(scoreAccentual(candidate, tokens, context));
  }

  const deduped = dedupeScans(
    results.sort((left, right) => left.penalty - right.penalty || right.confidence - left.confidence)
  );

  if (!deduped.some((scan) => scan.meterKey === 'accentual_loose') && looseCandidates[0]) {
    deduped.push(scoreAccentual(looseCandidates[0], tokens, context));
  }

  return [
    ...deduped.slice(0, 48),
    ...deduped.slice(48, 96).map((scan) => ({
      ...scan,
      reserveCandidate: true
    }))
  ];
}

function scoreAgainstMeter(candidate, meter, tokens, context, options = {}) {
  const profile = context?.profile;
  const target = Array.from({ length: meter.feet }).flatMap(() => meter.pattern);
  const actual = candidate.stress;
  const observations = [];
  let penalty = 0;
  const lengthDelta = actual.length - target.length;
  const projection = chooseBestProjection(actual, target, meter, options);
  let comparisonActual = actual;
  let comparisonTarget = target;

  if (lengthDelta === 1 && actual[actual.length - 1] === 'u') {
    penalty += feminineEndingPenalty(meter);
    penalty -= preferredLineFinalExpansionBonus(candidate, meter, tokens);
    observations.push('feminine ending');
    comparisonActual = actual.slice(0, target.length);
  } else if (projection) {
    penalty += projection.penalty;
    if (lengthDelta === 2 && actual[actual.length - 1] === 'u') {
      penalty += 0.72;
    }
    comparisonActual = projection.stress;
    addObservation(observations, projection.deletionCount === 1 ? 'extra syllable' : 'syllable count drift');
  } else if (lengthDelta === 1) {
    penalty += 1.5;
    observations.push('extra syllable');
    comparisonActual = actual.slice(0, target.length);
  } else if (lengthDelta === -1) {
    if (isAcephalousMatch(actual, target, meter)) {
      penalty += acephalousPenalty(meter);
      observations.push('acephalous opening');
      comparisonTarget = target.slice(1);
    } else if (isCatalecticMatch(actual, target, meter)) {
      penalty += catalecticPenalty(meter);
      observations.push('catalectic ending');
      comparisonTarget = target.slice(0, actual.length);
    } else {
      penalty += 1.35;
      observations.push('catalectic ending');
      comparisonTarget = target.slice(0, actual.length);
    }
  } else if (lengthDelta === -2 && meter.pattern.length === 3) {
    const targetWindow = bestStressWindow(target, actual.length);
    if (targetWindow && similarityScore(actual.join(''), targetWindow.join('')) >= 0.5) {
      penalty += doublyShortTernaryPenalty(meter);
      observations.push('catalectic ending');
      comparisonTarget = targetWindow;
    } else {
      penalty += Math.abs(lengthDelta) * 2.2;
      observations.push('syllable count drift');
      comparisonActual = actual.slice(0, Math.min(actual.length, target.length));
      comparisonTarget = target.slice(0, Math.min(actual.length, target.length));
    }
  } else if (Math.abs(lengthDelta) > 1) {
    penalty += Math.abs(lengthDelta) * 2.2;
    observations.push('syllable count drift');
    comparisonActual = actual.slice(0, Math.min(actual.length, target.length));
    comparisonTarget = target.slice(0, Math.min(actual.length, target.length));
  }

  penalty += patternMismatchPenalty(comparisonActual, comparisonTarget, meter, observations);
  penalty += candidateAdjustmentPenalty(candidate, profile);
  penalty += meterPriorPenalty(meter, candidate, context);

  if (profile?.key === 'hymn' && meter.family === 'iambic' && (meter.feet === 3 || meter.feet === 4)) {
    penalty -= profile.tetrameterBonus;
  }

  if (profile?.key === 'early_modern' && meter.key === 'iambic_pentameter') {
    penalty -= profile.pentameterBonus;
  }

  const heuristicCount = candidate.sources.filter((source) => source.startsWith('heuristic')).length;
  penalty += heuristicCount * 0.5;

  const displayStressMap = buildDisplayStressMap(actual, projection);
  const projectedFootBreaks = inferFootBreaks(comparisonActual, meter.pattern.length);
  const footBreaks = projection ? mapFootBreaksToSurface(projectedFootBreaks, projection.keptIndexes) : projectedFootBreaks;
  const stressString = comparisonActual.join('');
  const surfaceStressString = actual.join('');
  const targetString = target.join('');
  const exactness = similarityScore(comparisonActual.join(''), comparisonTarget.join(''));
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
    surfaceStressString,
    targetString,
    exactness,
    displayStressMap
  };
}

function chooseBestProjection(actual, target, meter, options = {}) {
  const projection = buildMetricalProjection(actual, target, meter);
  const footDropProjection = buildFootDropProjection(actual, target, meter, options);
  if (!projection) {
    return footDropProjection;
  }
  if (!footDropProjection) {
    return projection;
  }
  return footDropProjection.penalty + 0.08 < projection.penalty ? footDropProjection : projection;
}

function patternMismatchPenalty(actual, target, meter, observations) {
  if (!actual.length || !target.length) return 0;

  if (meter.pattern.length === 2 && actual.length >= 2 && target.length >= 2) {
    let penalty = 0;
    const completeFeet = Math.floor(Math.min(actual.length, target.length) / 2);
    for (let footIndex = 0; footIndex < completeFeet; footIndex += 1) {
      const start = footIndex * 2;
      const actualFoot = actual.slice(start, start + 2).join('');
      const targetFoot = target.slice(start, start + 2).join('');
      penalty += binaryFootPenalty(actualFoot, targetFoot, meter, footIndex, observations);
    }

    const covered = completeFeet * 2;
    for (let index = covered; index < Math.min(actual.length, target.length); index += 1) {
      if (actual[index] !== target[index]) {
        penalty += 1.05;
      }
    }

    return penalty;
  }

  if (meter.pattern.length === 3 && actual.length >= 3 && target.length >= 3) {
    let penalty = 0;
    const completeFeet = Math.floor(Math.min(actual.length, target.length) / 3);
    for (let footIndex = 0; footIndex < completeFeet; footIndex += 1) {
      const start = footIndex * 3;
      const actualFoot = actual.slice(start, start + 3).join('');
      const targetFoot = target.slice(start, start + 3).join('');
      penalty += ternaryFootPenalty(actualFoot, targetFoot, meter, footIndex, observations);
    }

    const covered = completeFeet * 3;
    for (let index = covered; index < Math.min(actual.length, target.length); index += 1) {
      if (actual[index] !== target[index]) {
        penalty += 0.88;
      }
    }

    return penalty;
  }

  let penalty = 0;
  for (let i = 0; i < Math.min(actual.length, target.length); i += 1) {
    if (actual[i] !== target[i]) {
      penalty += 1.05;
    }
  }
  return penalty;
}

function meterPriorPenalty(meter, candidate, context) {
  let penalty = 0;

  if (meter.family === 'spondaic') penalty += 2.8;
  else if (meter.family === 'amphibrachic') penalty += 0.52;
  else if (meter.family === 'dactylic') penalty += 0.34;
  else if (meter.family === 'anapestic') penalty += 0.12;
  else if (meter.family === 'trochaic') penalty += 0.12;

  if (meter.feet >= 6) penalty += 0.34;
  if (meter.feet === 1 && meter.family !== 'iambic' && meter.family !== 'anapestic') penalty += 0.18;

  const stressRatio = candidate.stress.filter((value) => value === 's').length / Math.max(candidate.stress.length, 1);
  if (meter.family === 'spondaic' && stressRatio < 0.88) {
    penalty += 2.4;
  }

  if (context?.profile?.key === 'hymn' && meter.family === 'iambic') {
    penalty -= 0.12;
  }

  return penalty;
}

function binaryFootPenalty(actualFoot, targetFoot, meter, footIndex, observations) {
  if (!actualFoot || !targetFoot || actualFoot === targetFoot) return 0;

  const initialFoot = footIndex === 0;

  if (meter.family === 'iambic') {
    if (actualFoot === 'su') {
      addObservation(observations, initialFoot ? 'initial inversion' : 'inversion');
      return initialFoot ? 0.18 : 0.42;
    }
    if (actualFoot === 'ss') {
      addObservation(observations, 'spondaic substitution');
      return 0.76;
    }
    if (actualFoot === 'uu') {
      addObservation(observations, 'pyrrhic substitution');
      return 0.86;
    }
  }

  if (meter.family === 'trochaic') {
    if (actualFoot === 'us') {
      addObservation(observations, initialFoot ? 'initial inversion' : 'inversion');
      return initialFoot ? 0.18 : 0.42;
    }
    if (actualFoot === 'ss') {
      addObservation(observations, 'spondaic substitution');
      return 0.74;
    }
    if (actualFoot === 'uu') {
      addObservation(observations, 'pyrrhic substitution');
      return 0.84;
    }
  }

  let penalty = 0;
  for (let i = 0; i < Math.min(actualFoot.length, targetFoot.length); i += 1) {
    if (actualFoot[i] !== targetFoot[i]) {
      penalty += 1.05;
    }
  }
  return penalty;
}

function ternaryFootPenalty(actualFoot, targetFoot, meter, footIndex, observations) {
  if (!actualFoot || !targetFoot || actualFoot === targetFoot) return 0;

  const initialFoot = footIndex === 0;
  const mismatchCount = [...actualFoot].reduce((sum, value, index) => sum + (value !== targetFoot[index] ? 1 : 0), 0);
  const targetStressIndex = targetFoot.indexOf('s');
  const actualStressIndex = actualFoot.indexOf('s');
  const secondaryStressCount = [...actualFoot].filter((value) => value === 's').length;

  if (meter.family === 'anapestic') {
    if (actualStressIndex === targetStressIndex && mismatchCount <= 2) {
      addObservation(observations, 'anapestic substitution');
      return 0.28 * mismatchCount;
    }
    if (initialFoot && actualFoot === 'sus') {
      addObservation(observations, 'initial inversion');
      return 0.42;
    }
  }

  if (meter.family === 'dactylic') {
    if (actualStressIndex === targetStressIndex && mismatchCount <= 2) {
      addObservation(observations, 'dactylic substitution');
      return 0.28 * mismatchCount;
    }
  }

  if (meter.family === 'amphibrachic') {
    if (actualStressIndex === targetStressIndex && mismatchCount <= 2) {
      addObservation(observations, 'amphibrachic substitution');
      return 0.3 * mismatchCount;
    }
  }

  if (secondaryStressCount >= 2 && actualStressIndex === targetStressIndex) {
    addObservation(observations, 'spondaic pressure');
    return 0.72;
  }

  return mismatchCount * 0.94;
}

function candidateAdjustmentPenalty(candidate, profile) {
  let penalty = 0;
  let promotedCount = 0;
  let rarePromotionCount = 0;
  let weakFlexCount = 0;
  let demotedCount = 0;
  let contextualCount = 0;
  let heuristicCount = 0;

  for (const source of candidate.sources || []) {
    if (source.startsWith('heuristic-alt')) {
      penalty += 0.45;
      heuristicCount += 1;
    } else if (source.startsWith('heuristic-primary')) {
      penalty += 0.32;
      heuristicCount += 1;
    }

    if (source.includes('demoted')) {
      penalty += 0.16;
      demotedCount += 1;
    }
    if (source.includes('poetic')) penalty += 0.12;
    if (source.includes('contextual')) {
      penalty += 0.24;
      contextualCount += 1;
    }
    if (source.includes('promoted-rare')) {
      penalty += 0.54;
      promotedCount += 1;
      rarePromotionCount += 1;
    } else if (source.includes('promoted')) {
      penalty += 0.42;
      promotedCount += 1;
    }
    if (source.includes('compressed')) penalty += 0.2;
    if (source.includes('flex-weak')) {
      penalty += 0.12;
      weakFlexCount += 1;
    }
    if (source.includes('compound-shift')) penalty += 0.26;
    if (source.includes('syllabic-ed')) penalty += 0.12;

    if (source.includes('poetic')) penalty += (profile?.poeticCostShift || 0) * 0.2;
    if (source.includes('contextual')) penalty += (profile?.contextualCostShift || 0) * 0.18;
    if (source.includes('promoted')) penalty += (profile?.promoteCostShift || 0) * 0.2;
  }

  penalty += Math.max(0, promotedCount - 1) * 0.34;
  penalty += rarePromotionCount * 0.28;
  penalty += Math.max(0, weakFlexCount - 1) * 0.05;
  penalty += Math.max(0, demotedCount - 1) * 0.16;
  penalty += Math.max(0, contextualCount - 2) * 0.18;
  penalty += Math.max(0, heuristicCount - 2) * 0.05;

  return penalty;
}

function isAcephalousMatch(actual, target, meter) {
  if (actual.length + 1 !== target.length) return false;
  if (!['iambic', 'anapestic', 'amphibrachic'].includes(meter.family)) return false;
  return actual.join('') === target.slice(1).join('');
}

function isCatalecticMatch(actual, target, meter) {
  if (actual.length + 1 !== target.length) return false;
  if (meter.pattern.length !== 2 && meter.pattern.length !== 3) return false;
  return actual.join('') === target.slice(0, actual.length).join('');
}

function feminineEndingPenalty(meter) {
  if (meter.family === 'iambic') return 0.34;
  if (meter.family === 'anapestic' || meter.family === 'amphibrachic') return 0.42;
  return 0.62;
}

function preferredLineFinalExpansionBonus(candidate, meter, tokens) {
  const endings = CANONICAL_LINE_FINAL_EXPANSIONS.get(meter?.key || '');
  if (!endings?.size) {
    return 0;
  }

  const lastToken = tokens?.at(-1)?.normalized || '';
  const lastStress = candidate?.pieces?.at(-1)?.stress || [];
  if (!endings.has(lastToken) || lastStress.length < 2 || lastStress.at(-1) !== 'u') {
    return 0;
  }

  if (meter.key === 'iambic_pentameter') return 1.05;
  if (meter.key === 'iambic_tetrameter') return 1.05;
  if (meter.key === 'anapestic_pentameter') return 0.34;
  return 0;
}

function acephalousPenalty(meter) {
  if (meter.family === 'anapestic' || meter.family === 'amphibrachic') return 0.42;
  if (meter.family === 'iambic') return 0.86;
  return 0.72;
}

function catalecticPenalty(meter) {
  if (meter.family === 'trochaic' || meter.family === 'dactylic') return 0.38;
  if (meter.family === 'anapestic' || meter.family === 'amphibrachic') return 0.46;
  if (meter.family === 'spondaic') return 0.52;
  return 1.02;
}

function doublyShortTernaryPenalty(meter) {
  if (meter.family === 'anapestic' || meter.family === 'dactylic' || meter.family === 'amphibrachic') return 0.82;
  return 1.2;
}

function bestStressWindow(target, length) {
  if (!Array.isArray(target) || length <= 0 || length > target.length) return null;
  let best = null;
  for (let start = 0; start <= target.length - length; start += 1) {
    const slice = target.slice(start, start + length);
    const stressCount = slice.filter((value) => value === 's').length;
    const edgePenalty = (slice[0] === 's' ? 0.2 : 0) + (slice[slice.length - 1] === 's' ? 0.2 : 0);
    const score = stressCount - edgePenalty;
    if (!best || score > best.score) {
      best = { slice, score };
    }
  }
  return best?.slice || null;
}

function addObservation(observations, note) {
  if (!observations.includes(note)) {
    observations.push(note);
  }
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

function rerankScans(scans, tokens) {
  if (!Array.isArray(scans) || scans.length < 2) {
    return scans;
  }

  const primaryScans = scans.filter((scan) => !scan.reserveCandidate);
  const reserveScans = scans.filter((scan) => scan.reserveCandidate);
  const rescored = primaryScans.map((scan, index) => {
    const probability = scoreScanWithReranker(scan, tokens, index);
    const baseScore = Math.max(0, 100 - scan.penalty * 10) / 100;
    return {
      ...scan,
      rerankerProbability: probability,
      rerankerScore: probability + baseScore * 0.15
    };
  });
  const rescoredReserve = reserveScans.map((scan, index) => {
    const probability = scoreScanWithReranker(scan, tokens, primaryScans.length + index);
    const baseScore = Math.max(0, 100 - scan.penalty * 10) / 100;
    return {
      ...scan,
      rerankerProbability: probability,
      rerankerScore: probability + baseScore * 0.15
    };
  });

  rescored.sort((left, right) => {
    return (
      right.rerankerScore - left.rerankerScore ||
      left.penalty - right.penalty ||
      right.confidence - left.confidence
    );
  });
  rescoredReserve.sort((left, right) => {
    return (
      right.rerankerScore - left.rerankerScore ||
      left.penalty - right.penalty ||
      right.confidence - left.confidence
    );
  });
  return [...rescored, ...rescoredReserve];
}

function scoreScanWithReranker(scan, tokens, candidateIndex) {
  const features = buildScanRerankerFeatures(scan, tokens, candidateIndex);
  if (SCAN_RERANKER_HGB?.trees?.length) {
    return scoreScanWithHgb(features, SCAN_RERANKER_HGB);
  }
  if (SCAN_RERANKER_FOREST?.trees?.length) {
    return scoreScanWithForest(features, SCAN_RERANKER_FOREST);
  }
  let sum = 0;
  for (let i = 0; i < features.length; i += 1) {
    const normalized = (features[i] - SCAN_RERANKER.mean[i]) / SCAN_RERANKER.std[i];
    sum += normalized * SCAN_RERANKER.weights[i];
  }
  return sigmoid(sum);
}

function scoreScanWithHgb(features, model) {
  let raw = Number(model?.baseline || 0);
  for (const tree of model?.trees || []) {
    let node = 0;
    while (!tree.isLeaf[node]) {
      const featureIndex = tree.feature[node];
      const featureValue = features[featureIndex];
      const goLeft = Number.isNaN(featureValue)
        ? Boolean(tree.missingLeft[node])
        : featureValue <= tree.threshold[node];
      node = goLeft ? tree.left[node] : tree.right[node];
      if (node < 0) break;
    }
    if (node >= 0) {
      raw += tree.value[node] || 0;
    }
  }
  return sigmoid(raw);
}

function scoreScanWithForest(features, forest) {
  let total = 0;
  for (const tree of forest.trees) {
    let node = 0;
    while (tree.childrenLeft[node] !== -1) {
      const featureIndex = tree.feature[node];
      const threshold = tree.threshold[node];
      node = features[featureIndex] <= threshold ? tree.childrenLeft[node] : tree.childrenRight[node];
    }
    total += tree.value[node] || 0;
  }
  return total / forest.trees.length;
}

function buildScanRerankerFeatures(scan, tokens, candidateIndex) {
  const definition = getMeterDefinition(scan.meterKey);
  const actual = scan.stressString || scan.candidate?.stress?.join('') || '';
  const target = scan.targetString || scan.target?.join('') || '';
  const sources = scan.candidate?.sources || [];
  const pieces = scan.candidate?.pieces || [];
  const observations = new Set(scan.observations || []);
  const baseScore = Math.max(0, 100 - scan.penalty * 10) / 100;
  const features = [
    1,
    candidateIndex / 47,
    (scan.confidence || 0) / 100,
    baseScore,
    (scan.candidate?.beamScore || 0) / 12,
    Math.min(scan.candidate?.patternSubstitutions || 0, 4) / 4,
    (scan.candidate?.syllables || actual.length || 0) / 12,
    (actual.length - target.length) / 4,
    similarityScore(actual, target),
    actual.split('').filter((value) => value === 's').length / Math.max(actual.length, 1)
  ];

  for (const origin of ['concatenative', 'structured', 'line']) {
    features.push(scan.candidate?.origin === origin ? 1 : 0);
  }

  for (const family of ['iambic', 'trochaic', 'anapestic', 'dactylic', 'amphibrachic', 'spondaic', 'accentual']) {
    features.push(definition.family === family ? 1 : 0);
  }

  for (let feet = 1; feet <= 6; feet += 1) {
    features.push(definition.feet === feet ? 1 : 0);
  }

  for (const observation of RERANKER_OBSERVATIONS) {
    features.push(observations.has(observation) ? 1 : 0);
  }

  for (const flag of RERANKER_SOURCE_FLAGS) {
    features.push(sources.filter((source) => source.includes(flag)).length / 8);
  }

  let monoFunctionStrong = 0;
  let monoFunctionWeak = 0;
  let monoContentStrong = 0;
  let monoContentWeak = 0;
  let functionPairWeak = 0;
  let functionPairStrong = 0;
  let contentPairStrong = 0;
  let contentPairWeak = 0;
  const pieceStress = pieces.map((piece) => piece.stress.join(''));

  for (let index = 0; index < pieceStress.length; index += 1) {
    const stress = pieceStress[index];
    const isFunctionWord = Boolean(tokens[index]?.isFunctionWord);
    if (stress.length === 1) {
      if (isFunctionWord && stress === 's') monoFunctionStrong += 1;
      if (isFunctionWord && stress === 'u') monoFunctionWeak += 1;
      if (!isFunctionWord && stress === 's') monoContentStrong += 1;
      if (!isFunctionWord && stress === 'u') monoContentWeak += 1;
    }

    if (index >= pieceStress.length - 1) continue;
    const nextStress = pieceStress[index + 1];
    if (stress.length !== 1 || nextStress.length !== 1) continue;

    const pair = stress + nextStress;
    const functionPair = Boolean(tokens[index]?.isFunctionWord) && Boolean(tokens[index + 1]?.isFunctionWord);
    const contentPair = !tokens[index]?.isFunctionWord && !tokens[index + 1]?.isFunctionWord;
    if (functionPair && pair === 'uu') functionPairWeak += 1;
    if (functionPair && pair === 'ss') functionPairStrong += 1;
    if (contentPair && pair === 'ss') contentPairStrong += 1;
    if (contentPair && pair === 'uu') contentPairWeak += 1;
  }

  features.push(monoFunctionStrong / 6);
  features.push(monoFunctionWeak / 6);
  features.push(monoContentStrong / 8);
  features.push(monoContentWeak / 8);
  features.push(functionPairWeak / 4);
  features.push(functionPairStrong / 4);
  features.push(contentPairStrong / 4);
  features.push(contentPairWeak / 4);

  if (pieceStress.length) {
    const firstStress = pieceStress[0];
    const lastStress = pieceStress[pieceStress.length - 1];
    const firstFunction = Boolean(tokens[0]?.isFunctionWord);
    const lastFunction = Boolean(tokens[pieceStress.length - 1]?.isFunctionWord);
    features.push(firstStress === 's' && firstFunction ? 1 : 0);
    features.push(firstStress === 'u' && firstFunction ? 1 : 0);
    features.push(firstStress === 's' && !firstFunction ? 1 : 0);
    features.push(firstStress === 'u' && !firstFunction ? 1 : 0);
    features.push(lastStress === 's' && lastFunction ? 1 : 0);
    features.push(lastStress === 'u' && lastFunction ? 1 : 0);
    features.push(lastStress === 's' && !lastFunction ? 1 : 0);
    features.push(lastStress === 'u' && !lastFunction ? 1 : 0);
  } else {
    features.push(...Array(8).fill(0));
  }

  if (definition.pattern?.length) {
    const footSize = definition.pattern.length;
    const actualFeet = [];
    for (let index = 0; index + footSize <= actual.length; index += footSize) {
      actualFeet.push(actual.slice(index, index + footSize));
    }

    for (const pattern of RERANKER_FOOT_PATTERNS) {
      features.push(actualFeet.filter((foot) => foot === pattern).length / 6);
    }

    for (let position = 0; position < 6; position += 1) {
      const foot = actualFeet[position] || '';
      for (const pattern of RERANKER_FOOT_PATTERNS) {
        features.push(foot === pattern ? 1 : 0);
      }
    }

    const canonicalFoot = definition.pattern.join('');
    features.push(actualFeet.filter((foot) => foot === canonicalFoot).length / Math.max(actualFeet.length, 1));
  } else {
    features.push(...Array(RERANKER_FOOT_PATTERNS.length + 49).fill(0));
  }

  return features;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

function formatScan(scan, isPrimary, tokens, text) {
  const emittedStress = shouldEmitCanonicalExpandedEnding(scan, tokens)
    ? (scan.surfaceStressString || scan.stressString || scan.candidate.stress.join(''))
    : (scan.stressString || scan.candidate.stress.join(''));

  return {
    meterKey: scan.meterKey,
    meterLabel: scan.meterLabel,
    confidence: scan.confidence,
    stressPattern: emittedStress.split('').join(' '),
    surfaceStressPattern: (scan.surfaceStressString || scan.candidate.stress.join('')).split('').join(' '),
    targetPattern: scan.target.join(' '),
    syllableCount: scan.candidate.syllables,
    score: Math.max(0, 100 - scan.penalty * 10),
    observations: scan.observations,
    footBreaks: scan.footBreaks,
    displayGuide: buildDisplayGuide(text, tokens, scan.candidate, scan.footBreaks, scan.displayStressMap),
    rerankerProbability: scan.rerankerProbability || 0,
    rerankerScore: scan.rerankerScore || 0,
    beamScore: scan.candidate.beamScore || 0,
    origin: scan.candidate.origin || '',
    patternSubstitutions: scan.candidate.patternSubstitutions || 0,
    variants: scan.candidate.pieces.map((piece) => ({
      source: piece.source,
      pronunciation: piece.pronunciation,
      stress: piece.stress.join('')
    })),
    isPrimary
  };
}

function shouldEmitCanonicalExpandedEnding(scan, tokens) {
  const observations = scan?.observations || [];
  if (observations.length !== 1 || observations[0] !== 'feminine ending') {
    return false;
  }

  const endings = CANONICAL_LINE_FINAL_EXPANSIONS.get(scan?.meterKey || '');
  if (!endings?.size) {
    return false;
  }

  const lastToken = tokens?.at(-1)?.normalized || '';
  return endings.has(lastToken);
}


function buildDisplayGuide(text, tokens, candidate, footBreaks, displayStressMap = null) {
  const markerChars = Array.from({ length: text.length }, () => ' ');
  const syllableCenters = [];
  let syllableIndex = 0;

  tokens.forEach((token, idx) => {
    const piece = candidate.pieces[idx];
    if (!piece) return;
    const localCenters = estimateSyllableCenters(token.raw, piece.syllables);
    localCenters.forEach((center, localIdx) => {
      const globalIndex = clamp(center + token.start, 0, Math.max(0, text.length - 1));
      syllableCenters.push(globalIndex);
      const mappedStress = displayStressMap ? displayStressMap[syllableIndex] : undefined;
      const stress = mappedStress === undefined ? (piece.stress[localIdx] || '') : mappedStress;
      if (stress === 's' || stress === 'u') {
        markerChars[globalIndex] = stress === 's' ? '/' : 'u';
      }
      syllableIndex += 1;
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

function optimizePoemReadings(lines, structure, context) {
  const positions = buildPoemLinePositions(structure);
  if (positions.length < 2) return lines;

  const candidateSets = positions.map((position) => lines[position.lineIndex].scans.slice(0, 24));
  if (candidateSets.some((set) => !set.length)) return lines;
  const poemContext = derivePoemSequenceContext(lines, positions);
  let previous = candidateSets[0].map((scan) => ({
    score: scanUtility(scan, positions[0], poemContext, context),
    previousIndex: -1
  }));
  const backPointers = [];

  for (let lineIndex = 1; lineIndex < candidateSets.length; lineIndex += 1) {
    const currentSet = candidateSets[lineIndex];
    const next = currentSet.map(() => ({
      score: Number.NEGATIVE_INFINITY,
      previousIndex: -1
    }));

    for (let currentIndex = 0; currentIndex < currentSet.length; currentIndex += 1) {
      const currentScan = currentSet[currentIndex];
      const currentUtility = scanUtility(currentScan, positions[lineIndex], poemContext, context);

      for (let previousIndex = 0; previousIndex < previous.length; previousIndex += 1) {
        const previousState = previous[previousIndex];
        if (!Number.isFinite(previousState.score)) continue;

        const total =
          previousState.score +
          currentUtility +
          scanTransitionBonus(
            candidateSets[lineIndex - 1][previousIndex],
            currentScan,
            positions[lineIndex - 1],
            positions[lineIndex],
            poemContext
          );

        if (total > next[currentIndex].score) {
          next[currentIndex] = {
            score: total,
            previousIndex
          };
        }
      }
    }

    backPointers.push(next.map((entry) => entry.previousIndex));
    previous = next;
  }

  const baselineScore = scoreCurrentSequence(candidateSets, positions, poemContext, context);
  let bestIndex = 0;
  for (let index = 1; index < previous.length; index += 1) {
    if (previous[index].score > previous[bestIndex].score) {
      bestIndex = index;
    }
  }

  if (!Number.isFinite(previous[bestIndex]?.score) || previous[bestIndex].score <= baselineScore + 10) {
    return lines;
  }

  const selectedIndexes = Array(candidateSets.length).fill(0);
  selectedIndexes[selectedIndexes.length - 1] = bestIndex;
  for (let pointerIndex = backPointers.length - 1; pointerIndex >= 0; pointerIndex -= 1) {
    selectedIndexes[pointerIndex] = backPointers[pointerIndex][selectedIndexes[pointerIndex + 1]];
  }

  const updated = [...lines];
  let changed = 0;
  for (let positionIndex = 0; positionIndex < positions.length; positionIndex += 1) {
    const position = positions[positionIndex];
    const line = updated[position.lineIndex];
    const selected = candidateSets[positionIndex][selectedIndexes[positionIndex]];
    if (!selected || scanIdentity(line.scans[0]) === scanIdentity(selected)) continue;
    updated[position.lineIndex] = applySelectedScan(line, selected, 6);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictTetrameterPoemRepair(lines, structure) {
  const lineObjects = structure?.lineObjects || [];
  const nonBlankIndexes = lineObjects.filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const tally = new Map();
  for (const index of nonBlankIndexes) {
    const key = lines[index]?.scans?.[0]?.meterKey || '';
    if (!key) continue;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  const [dominantKey, dominantCount] = [...tally.entries()].sort((left, right) => right[1] - left[1])[0] || ['', 0];
  if (dominantKey !== 'iambic_tetrameter' || dominantCount / nonBlankIndexes.length < 0.75) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter') {
      continue;
    }

    const tetrameter = (line.scans || []).find((scan) => {
      return scan.meterKey === 'iambic_tetrameter' &&
        ['extra syllable', 'syllable count drift'].some((note) => (scan.observations || []).includes(note));
    });
    if (!tetrameter) {
      continue;
    }

    if ((top.score || 0) - (tetrameter.score || 0) > 8) {
      continue;
    }

    updated[index] = forceSelectedScan(line, tetrameter, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictAlexandrineRepair(lines, structure) {
  const lineObjects = structure?.lineObjects || [];
  const nonBlankIndexes = lineObjects.filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const tally = new Map();
  for (const index of nonBlankIndexes) {
    const key = lines[index]?.scans?.[0]?.meterKey || '';
    if (!key) continue;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  const [dominantKey, dominantCount] = [...tally.entries()].sort((left, right) => right[1] - left[1])[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.8) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter') {
      continue;
    }

    const hexameter = (line.scans || []).find((scan) => {
      return scan.meterKey === 'iambic_hexameter' && (scan.rerankerScore || 0) >= (top.rerankerScore || 0);
    });
    if (!hexameter) {
      continue;
    }

    if ((top.score || 0) - (hexameter.score || 0) > 3) {
      continue;
    }

    updated[index] = forceSelectedScan(line, hexameter, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function observationSignature(observations = []) {
  return JSON.stringify([...(observations || [])].sort());
}

const STRICT_EXTENSION_PROMOTION_RULES = [
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 4,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 8,
    maxScoreGap: 2,
    minRerankerDiff: -0.1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 2,
    minRerankerDiff: 0.3
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 16,
    maxScoreGap: 2,
    minRerankerDiff: 0.4
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['inversion'],
    maxIndex: 16,
    maxScoreGap: 8,
    minRerankerDiff: -0.2
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 1,
    maxScoreGap: 2,
    minRerankerDiff: -0.2
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 8,
    minRerankerDiff: -0.1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'structured',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 8,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 2,
    minRerankerDiff: -0.6
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'structured',
    topObservations: [],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 1,
    maxScoreGap: 12,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['acephalous opening'],
    candidateMeterKey: 'iambic_trimeter',
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 2,
    minRerankerDiff: -0.1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'structured',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 2,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion'],
    maxIndex: 8,
    maxScoreGap: 2,
    minRerankerDiff: 0.05
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion'],
    maxIndex: 8,
    maxScoreGap: 4,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 12,
    maxScoreGap: 8,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 8,
    minRerankerDiff: 0.1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 8,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 6,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 16,
    minRerankerDiff: -0.1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 8,
    maxScoreGap: 8,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 24,
    maxScoreGap: 6,
    minRerankerDiff: 0.1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: -14.6,
    minRerankerDiff: 0.61
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 8,
    minRerankerDiff: 0.2
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 12,
    minRerankerDiff: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion'],
    maxIndex: 6,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['inversion'],
    maxIndex: 8,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 23,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 3,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 9,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateMeterKey: 'anapestic_trimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 8,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'trochaic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'iambic_dimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 34,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'trochaic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'iambic_dimeter',
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 35,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateOrigin: 'line',
    candidateObservations: ['syllable count drift'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 2
  },
  {
    topMeterKey: 'anapestic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'anapestic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['catalectic ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'anapestic_trimeter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'structured',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_hexameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_hexameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'syllable count drift'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 2
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'trochaic_tetrameter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['syllable count drift'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['syllable count drift'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 2
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion', 'inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'initial inversion', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable', 'initial inversion', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: [],
    maxIndex: 48,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  // Zero-regression corpus-mined promotion rules.
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 24,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'anapestic_dimeter',
    topOrigin: 'line',
    topObservations: ['acephalous opening'],
    candidateMeterKey: 'iambic_dimeter',
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_hexameter',
    topOrigin: 'structured',
    topObservations: ['inversion'],
    candidateMeterKey: 'iambic_pentameter',
    candidateOrigin: 'line',
    candidateObservations: ['syllable count drift'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'structured',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'iambic_trimeter',
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateMeterKey: 'anapestic_trimeter',
    candidateOrigin: 'line',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'trochaic_tetrameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 1,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateMeterKey: 'iambic_hexameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['syllable count drift'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'structured',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'trochaic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 2,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateMeterKey: 'anapestic_tetrameter',
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 4,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 4,
    maxScoreGap: 999,
    minRerankerDiff: -1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 1,
    maxScoreGap: -4,
    minRerankerDiff: 0.16
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: -16,
    minRerankerDiff: 0.09,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 4,
    maxScoreGap: 2,
    minRerankerDiff: 0.05,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 0,
    minRerankerDiff: 0.22,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 29,
    maxScoreGap: 4.5,
    minRerankerDiff: 0.05,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 34,
    maxScoreGap: 4.6,
    minRerankerDiff: 0.32
  }
];

const STRICT_SURFACE_RETENTION_RULES = [
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['feminine ending'],
    surfaceDelta: 1,
    minTokenCount: 9
  },
  {
    meterKey: 'iambic_trimeter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    maxTokenCount: 6
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    maxTokenCount: 8
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    maxTokenCount: 7
  },
  {
    meterKey: 'iambic_hexameter',
    surfaceDelta: 2
  },
  {
    meterKey: 'iambic_pentameter',
    surfaceDelta: 2
  },
  {
    meterKey: 'iambic_dimeter',
    surfaceDelta: 1
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['extra syllable', 'initial inversion']
  },
  {
    meterKey: 'iambic_trimeter',
    surfaceDelta: 2
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable', 'inversion']
  },
  {
    meterKey: 'iambic_tetrameter',
    observations: ['feminine ending', 'initial inversion']
  },
  {
    meterKey: 'iambic_trimeter',
    observations: ['feminine ending'],
    surfaceDelta: 1
  },
  {
    meterKey: 'iambic_tetrameter',
    origin: 'concatenative',
    observations: ['feminine ending'],
    surfaceDelta: 1
  },
  {
    meterKey: 'iambic_tetrameter',
    origin: 'concatenative',
    surfaceDelta: 1,
    minScore: 97,
    minReranker: 0
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['feminine ending'],
    surfaceDelta: 1,
    minScore: 95,
    minReranker: 0
  },
  {
    meterKey: 'iambic_tetrameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'uusususus',
    minTokenCount: 6
  },
  {
    meterKey: 'iambic_tetrameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usuususus'
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usususuusus',
    minTokenCount: 6,
    maxTokenCount: 6
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['feminine ending'],
    surfaceDelta: 1,
    surfacePattern: 'usususususu',
    minTokenCount: 6,
    maxTokenCount: 7
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usuusususus',
    minTokenCount: 8,
    maxTokenCount: 8
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'uususususus',
    minTokenCount: 10,
    maxTokenCount: 10
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'ususuususus',
    minTokenCount: 8,
    maxTokenCount: 8
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usuusususus',
    minTokenCount: 8,
    maxTokenCount: 8
  },
  {
    meterKey: 'iambic_tetrameter',
    origin: 'concatenative',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usususuus',
    minTokenCount: 5,
    maxTokenCount: 5
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable', 'initial inversion'],
    surfaceDelta: 1,
    surfacePattern: 'suuusususus',
    minTokenCount: 7,
    maxTokenCount: 7
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'line',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usuusususus',
    minTokenCount: 9,
    maxTokenCount: 9
  },
  {
    meterKey: 'iambic_pentameter',
    origin: 'concatenative',
    observations: ['extra syllable'],
    surfaceDelta: 1,
    surfacePattern: 'usuusususus',
    minTokenCount: 7,
    maxTokenCount: 7
  }
];

const STRICT_LATE_PROMOTION_RULES = [
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 1,
    maxScoreGap: -4.4,
    minRerankerDiff: 0.1619,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: -16.7,
    minRerankerDiff: 0.0987,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 9,
    maxScoreGap: 6.4,
    minRerankerDiff: -0.1134
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 34,
    maxScoreGap: 4.6,
    minRerankerDiff: 0.3279
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 3,
    maxScoreGap: 4.4,
    minRerankerDiff: -0.772
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 16,
    maxScoreGap: 8.2,
    minRerankerDiff: -0.123
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 3,
    maxScoreGap: 4.4,
    minRerankerDiff: -0.772
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 0,
    minRerankerDiff: 0.2238,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: -11,
    minRerankerDiff: 0.1022,
    useSurface: true,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 1,
    maxScoreGap: 1.8,
    minRerankerDiff: -0.0235
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion'],
    maxIndex: 3,
    maxScoreGap: 1.8,
    minRerankerDiff: -0.121
  }
];

const STRICT_FINAL_PROMOTION_RULES = [
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 3,
    maxScoreGap: 4.5,
    minRerankerDiff: -0.772,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 41,
    maxScoreGap: 7.7,
    minRerankerDiff: 0.1563,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 31,
    maxScoreGap: 2.3,
    minRerankerDiff: 0.1373,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 0.31,
    minRerankerDiff: 0.335,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 39,
    maxScoreGap: 18.3,
    minRerankerDiff: 0.0573,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateMeterKey: 'iambic_pentameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 31,
    maxScoreGap: 12.7,
    minRerankerDiff: 0.0739,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 33,
    maxScoreGap: 9.3,
    minRerankerDiff: 0.0253,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 35,
    maxScoreGap: 9.8,
    minRerankerDiff: -0.1227,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 35,
    maxScoreGap: 2,
    minRerankerDiff: 0.0079,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: -11,
    minRerankerDiff: 0.1022,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 20,
    maxScoreGap: 2,
    minRerankerDiff: 0.0056,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 6,
    maxScoreGap: -4.6,
    minRerankerDiff: -0.0372,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 6.5,
    minRerankerDiff: 0.286,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion'],
    maxIndex: 17,
    maxScoreGap: 8.4,
    minRerankerDiff: -0.0103,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: -6.4,
    minRerankerDiff: -0.0804,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion'],
    maxIndex: 9,
    maxScoreGap: -2.4,
    minRerankerDiff: 0.2616,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'anapestic_dimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 11,
    minRerankerDiff: -0.0649,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 2,
    maxScoreGap: -0.8,
    minRerankerDiff: 0.7005,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 6,
    maxScoreGap: -3.6,
    minRerankerDiff: -0.1829,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion', 'spondaic substitution'],
    maxIndex: 21,
    maxScoreGap: 8.9,
    minRerankerDiff: 0.5534,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 3,
    maxScoreGap: 2,
    minRerankerDiff: -0.0299,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'inversion'],
    maxIndex: 26,
    maxScoreGap: 4.4,
    minRerankerDiff: 0.003,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 10,
    maxScoreGap: 0.5,
    minRerankerDiff: -0.0253,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['inversion'],
    candidateMeterKey: 'anapestic_trimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 26,
    maxScoreGap: 7.7,
    minRerankerDiff: -0.0116,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateMeterKey: 'anapestic_trimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 32,
    maxScoreGap: 7.6,
    minRerankerDiff: -0.0103,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'anapestic_trimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 43,
    maxScoreGap: 10.3,
    minRerankerDiff: -0.1429,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: -4.8,
    minRerankerDiff: 0.1035,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateMeterKey: 'iambic_pentameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 23,
    maxScoreGap: 8,
    minRerankerDiff: 0.0897,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'trochaic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion'],
    maxIndex: 47,
    maxScoreGap: 13.3,
    minRerankerDiff: -0.4959,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'anapestic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 12,
    maxScoreGap: 12.3,
    minRerankerDiff: 0.4492,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 0.2,
    minRerankerDiff: -0.2951,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 9.8,
    minRerankerDiff: -0.3808,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 14,
    maxScoreGap: 5.3,
    minRerankerDiff: -0.0748,
    surfaceDelta: 0
  }
];

const STRICT_LAST_CHANCE_PROMOTION_RULES = [
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 35,
    maxScoreGap: 2,
    minRerankerDiff: 0.0079,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: -11,
    minRerankerDiff: 0.1022,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 20,
    maxScoreGap: 2,
    minRerankerDiff: 0.0056,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 6,
    maxScoreGap: -4.6,
    minRerankerDiff: -0.0372,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['initial inversion', 'inversion', 'spondaic substitution'],
    maxIndex: 2,
    maxScoreGap: 6.5,
    minRerankerDiff: 0.286,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['inversion', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion'],
    maxIndex: 9,
    maxScoreGap: -2.4,
    minRerankerDiff: 0.2616,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateMeterKey: 'anapestic_dimeter',
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: 11,
    minRerankerDiff: -0.0649,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 2,
    maxScoreGap: -0.8,
    minRerankerDiff: 0.7005,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion', 'inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['spondaic substitution'],
    maxIndex: 6,
    maxScoreGap: -3.6,
    minRerankerDiff: -0.1829,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion', 'spondaic substitution'],
    maxIndex: 21,
    maxScoreGap: 8.9,
    minRerankerDiff: 0.5534,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['extra syllable'],
    maxIndex: 3,
    maxScoreGap: 2,
    minRerankerDiff: -0.0299,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'inversion'],
    maxIndex: 26,
    maxScoreGap: 4.4,
    minRerankerDiff: 0.003,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 10,
    maxScoreGap: 0.5,
    minRerankerDiff: -0.0253,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable', 'initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 2,
    maxScoreGap: -4.8,
    minRerankerDiff: 0.1035,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_tetrameter',
    topOrigin: 'concatenative',
    topObservations: ['syllable count drift'],
    candidateMeterKey: 'iambic_pentameter',
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 23,
    maxScoreGap: 8,
    minRerankerDiff: 0.0897,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'anapestic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateMeterKey: 'iambic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['acephalous opening'],
    maxIndex: 12,
    maxScoreGap: 12.3,
    minRerankerDiff: 0.4492,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'initial inversion', 'inversion'],
    maxIndex: 22,
    maxScoreGap: 9.08,
    minRerankerDiff: -0.3666,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion'],
    maxIndex: 11,
    maxScoreGap: 6.3,
    minRerankerDiff: 0.3104,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_hexameter',
    topOrigin: 'concatenative',
    topObservations: [],
    candidateOrigin: 'concatenative',
    candidateObservations: ['inversion'],
    maxIndex: 10,
    maxScoreGap: 6.2,
    minRerankerDiff: 0.0986,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'concatenative',
    topObservations: ['inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['pyrrhic substitution', 'spondaic substitution'],
    maxIndex: 37,
    maxScoreGap: 12.4,
    minRerankerDiff: 0.7118,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['extra syllable'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable'],
    maxIndex: 1,
    maxScoreGap: 2,
    minRerankerDiff: 0.1683,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: [],
    candidateMeterKey: 'trochaic_tetrameter',
    candidateOrigin: 'line',
    candidateObservations: ['syllable count drift'],
    maxIndex: 7,
    maxScoreGap: 11.5,
    minRerankerDiff: -0.0138,
    surfaceDelta: 2
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'initial inversion', 'pyrrhic substitution', 'spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 5,
    maxScoreGap: -13.6,
    minRerankerDiff: 0.0564,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'concatenative',
    topObservations: ['initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: [],
    maxIndex: 1,
    maxScoreGap: -3.8,
    minRerankerDiff: -0.4487,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_trimeter',
    topOrigin: 'line',
    topObservations: ['feminine ending', 'spondaic substitution'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending'],
    maxIndex: 1,
    maxScoreGap: -4.4,
    minRerankerDiff: 0.162,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['inversion', 'spondaic substitution'],
    maxIndex: 30,
    maxScoreGap: 6.2,
    minRerankerDiff: 0.1886,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'concatenative',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 21,
    maxScoreGap: 4.6,
    minRerankerDiff: 0.0668,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'concatenative',
    topObservations: ['feminine ending', 'initial inversion'],
    candidateOrigin: 'line',
    candidateObservations: ['feminine ending', 'spondaic substitution'],
    maxIndex: 16,
    maxScoreGap: 4.6,
    minRerankerDiff: 0.0317,
    surfaceDelta: 1
  },
  {
    topMeterKey: 'iambic_pentameter',
    topOrigin: 'structured',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'structured',
    candidateObservations: ['initial inversion', 'spondaic substitution'],
    maxIndex: 8,
    maxScoreGap: 1.4,
    minRerankerDiff: -0.5978,
    surfaceDelta: 0
  },
  {
    topMeterKey: 'iambic_dimeter',
    topOrigin: 'line',
    topObservations: ['spondaic substitution'],
    candidateOrigin: 'line',
    candidateObservations: ['extra syllable', 'spondaic substitution'],
    maxIndex: 7,
    maxScoreGap: 4.3,
    minRerankerDiff: -0.1433,
    surfaceDelta: 1
  }
];

const STRICT_TERMINAL_PROMOTION_RULES = GENERATED_STRICT_TERMINAL_PROMOTION_RULES;

function scanRerankerValue(scan) {
  return scan?.rerankerScore || scan?.rerankerProbability || 0;
}

function getReserveScans(line) {
  return Array.isArray(line?.reserveScans) ? line.reserveScans : [];
}

function matchesObservationRule(observations, expected) {
  if (!Array.isArray(expected)) {
    return true;
  }
  return observationSignature(observations) === observationSignature(expected);
}

function stressLengthDelta(scan) {
  return countStressSymbols(scan?.surfaceStressPattern || '') - countStressSymbols(scan?.stressPattern || '');
}

function scanSurfacePattern(scan) {
  return String(scan?.surfaceStressPattern || scan?.stressPattern || '').replace(/[^su]/g, '');
}

function scanStartsStrong(scan) {
  return scanSurfacePattern(scan).startsWith('s');
}

function linePromotionFeatures(structure, index) {
  const text = structure?.lineObjects?.[index]?.text || '';
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const normalizedTokens = tokens.map((token) => normalizeWord(token)).filter(Boolean);
  const firstToken = normalizedTokens[0] || '';
  const lastToken = normalizedTokens[normalizedTokens.length - 1] || '';
  return {
    tokenCount: tokens.length,
    firstTokenFunction: !!firstToken && matchesWordSet(firstToken, FUNCTION_WORDS),
    lastTokenFunction: !!lastToken && matchesWordSet(lastToken, FUNCTION_WORDS),
    firstWord: firstToken,
    lastWord: lastToken,
    firstBigram: normalizedTokens.slice(0, 2).join(' '),
    lastBigram: normalizedTokens.slice(-2).join(' ')
  };
}

function exceedsPromotionScoreGap(top, scan, maxScoreGap) {
  return (top.score || 0) - (scan.score || 0) > (maxScoreGap ?? 999) + 1e-6;
}

function fallsShortOfPromotionReranker(top, scan, minRerankerDiff) {
  return scanRerankerValue(scan) - scanRerankerValue(top) + 1e-6 < (minRerankerDiff ?? -1);
}

function applyStrictGenericPromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length || !STRICT_GENERIC_PROMOTION_RULES.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }
    const shape = linePromotionFeatures(structure, index);

    for (const rule of STRICT_GENERIC_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }
      if (rule.topSurfaceLength != null && countStressSymbols(top.surfaceStressPattern || top.stressPattern) !== rule.topSurfaceLength) {
        continue;
      }
      if (rule.topStartsStrong != null && scanStartsStrong(top) !== rule.topStartsStrong) {
        continue;
      }
      if (rule.tokenCount != null && shape.tokenCount !== rule.tokenCount) {
        continue;
      }
      if (rule.firstTokenFunction != null && shape.firstTokenFunction !== rule.firstTokenFunction) {
        continue;
      }
      if (rule.lastTokenFunction != null && shape.lastTokenFunction !== rule.lastTokenFunction) {
        continue;
      }
      if (rule.firstWord && shape.firstWord !== rule.firstWord) {
        continue;
      }
      if (rule.lastWord && shape.lastWord !== rule.lastWord) {
        continue;
      }
      if (rule.firstBigram && shape.firstBigram !== rule.firstBigram) {
        continue;
      }
      if (rule.lastBigram && shape.lastBigram !== rule.lastBigram) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const bucketScans = rule.bucket === 'reserveScans' ? getReserveScans(line) : (line.scans || []);
      const maxIndex = rule.maxIndex ?? rule.maxReserveIndex ?? null;
      const found = bucketScans.find((scan, bucketIndex) => {
        if (rule.bucket !== 'reserveScans' && bucketIndex <= 0) {
          return false;
        }
        if (maxIndex != null && bucketIndex > maxIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (rule.candidateSurfaceLength != null && countStressSymbols(scan.surfaceStressPattern || scan.stressPattern) !== rule.candidateSurfaceLength) {
          return false;
        }
        if (rule.candidateStartsStrong != null && scanStartsStrong(scan) !== rule.candidateStartsStrong) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(line, found, 4);
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictSameMeterSubstitutionPromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    const topObs = observationSignature(top.observations);
    let candidate = null;
    if (topObs === '[]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scan.meterKey === top.meterKey &&
          observationSignature(scan.observations) === '["pyrrhic substitution","spondaic substitution"]' &&
          (top.score || 0) - (scan.score || 0) <= 16 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.2;
      }) || null;
    }

    if (!candidate && topObs === '[]' && top.origin === 'concatenative') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 24 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'line' &&
          observationSignature(scan.observations) === '["spondaic substitution"]' &&
          (top.score || 0) - (scan.score || 0) <= 8 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.05;
      }) || null;
    }

    if (!candidate && topObs === '[]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 12 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'line' &&
          observationSignature(scan.observations) === '["initial inversion"]' &&
          (top.score || 0) - (scan.score || 0) <= 2 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= -0.2;
      }) || null;
    }

    if (!candidate && topObs === '[]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scan.meterKey === top.meterKey &&
          observationSignature(scan.observations) === '["initial inversion","inversion"]' &&
          (top.score || 0) - (scan.score || 0) <= 10 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.05;
      }) || null;
    }

    if (!candidate && topObs === '[]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 4 &&
          scan.meterKey === top.meterKey &&
          observationSignature(scan.observations) === '["inversion"]' &&
          (top.score || 0) - (scan.score || 0) <= 6 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0;
      }) || null;
    }

    if (!candidate && topObs === '["initial inversion"]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scan.meterKey === top.meterKey &&
          observationSignature(scan.observations) === '["initial inversion","spondaic substitution"]' &&
          (top.score || 0) - (scan.score || 0) <= 8 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.2;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_pentameter' && top.origin === 'line' && topObs === '["pyrrhic substitution","spondaic substitution"]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 1 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'structured' &&
          observationSignature(scan.observations) === '[]' &&
          (top.score || 0) - (scan.score || 0) <= 2 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.3;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_pentameter' && top.origin === 'line' && topObs === '["pyrrhic substitution","spondaic substitution"]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 16 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'concatenative' &&
          observationSignature(scan.observations) === '[]' &&
          (top.score || 0) - (scan.score || 0) <= 2 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.4;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_pentameter' && topObs === '[]' && top.origin === 'concatenative') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 48 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'line' &&
          observationSignature(scan.observations) === '["initial inversion","spondaic substitution"]' &&
          (top.score || 0) - (scan.score || 0) <= 10 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= -0.05;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_pentameter' && topObs === '[]' && top.origin === 'concatenative') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 24 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'line' &&
          observationSignature(scan.observations) === '["inversion","spondaic substitution"]' &&
          (top.score || 0) - (scan.score || 0) <= 12 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= -0.1;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_tetrameter' && topObs === '[]' && top.origin === 'concatenative') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 1 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'concatenative' &&
          observationSignature(scan.observations) === '["spondaic substitution"]' &&
          String(scan.surfaceStressPattern || scan.stressPattern || '').replace(/\s+/g, '').startsWith('ss') &&
          (top.score || 0) - (scan.score || 0) <= 6.5 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= -0.02;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_tetrameter' && topObs === '[]' && top.origin === 'concatenative') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 2 &&
          scan.meterKey === top.meterKey &&
          scan.origin === 'concatenative' &&
          observationSignature(scan.observations) === '["initial inversion"]' &&
          (top.score || 0) - (scan.score || 0) <= 4 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_trimeter' && topObs === '["extra syllable"]' && top.origin === 'line') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 1 &&
          scan.meterKey === 'iambic_tetrameter' &&
          scan.origin === 'line' &&
          observationSignature(scan.observations) === '["acephalous opening"]' &&
          (top.score || 0) - (scan.score || 0) <= 4 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0;
      }) || null;
    }

    if (!candidate && ['iambic_pentameter', 'iambic_hexameter'].includes(top.meterKey) && topObs === '[]' && top.origin === 'structured') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        const scanObs = observationSignature(scan.observations);
        return scanIndex > 0 &&
          scanIndex <= 2 &&
          scan.meterKey === 'anapestic_tetrameter' &&
          (scanObs === '[]' || scanObs === '["acephalous opening"]') &&
          ['concatenative', 'line'].includes(scan.origin || '') &&
          (top.score || 0) - (scan.score || 0) <= 10 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0;
      }) || null;
    }

    if (!candidate && top.meterKey === 'anapestic_tetrameter' && topObs === '[]' && top.origin === 'structured') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scanIndex <= 6 &&
          scan.meterKey === 'dactylic_tetrameter' &&
          observationSignature(scan.observations) === '[]' &&
          scan.origin === 'structured' &&
          (top.score || 0) - (scan.score || 0) <= 8 &&
          (scan.rerankerScore || scan.rerankerProbability || 0) - (top.rerankerScore || top.rerankerProbability || 0) >= 0.05;
      }) || null;
    }

    if (!candidate && top.meterKey === 'iambic_tetrameter' && topObs === '["syllable count drift"]') {
      candidate = (line.scans || []).find((scan, scanIndex) => {
        return scanIndex > 0 &&
          scan.meterKey === 'anapestic_tetrameter' &&
          observationSignature(scan.observations) === '["catalectic ending"]' &&
          (top.score || 0) - (scan.score || 0) <= 8 &&
          scanRerankerValue(scan) - scanRerankerValue(top) >= 0;
      }) || null;
    }

    if (!candidate) {
      for (const rule of STRICT_EXTENSION_PROMOTION_RULES) {
        if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
          continue;
        }
        if (rule.topOrigin && top.origin !== rule.topOrigin) {
          continue;
        }
        if (!matchesObservationRule(top.observations, rule.topObservations)) {
          continue;
        }

        const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
          ? top.meterKey
          : rule.candidateMeterKey;
        const found = (line.scans || []).find((scan, scanIndex) => {
          if (scanIndex <= 0) {
            return false;
          }
          if (rule.maxIndex != null && scanIndex > rule.maxIndex) {
            return false;
          }
          if (scan.meterKey !== targetMeter) {
            return false;
          }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (
          top.meterKey === 'iambic_pentameter' &&
          top.origin === 'structured' &&
          topObs === '[]' &&
          scanIndex > 8 &&
          scan.origin !== 'structured' &&
          scanRerankerValue(scan) < scanRerankerValue(top)
        ) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
          if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
            return false;
          }
          if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
            return false;
          }
          if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
            return false;
          }
          return true;
        }) || null;

        if (!found) {
          continue;
        }

        candidate = rule.useSurface
          ? {
              ...found,
              stressPattern: found.surfaceStressPattern || found.stressPattern
            }
          : found;
        break;
      }
    }

    if (!candidate) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictSurfaceRetentionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    const shownLength = countStressSymbols(top.stressPattern || '');
    const surfaceLength = countStressSymbols(top.surfaceStressPattern || '');
    const surfaceDelta = surfaceLength - shownLength;
    const normalizedSurface = sanitizeAssistantStressPattern(top.surfaceStressPattern || top.stressPattern || '');
    const tokenCount = Array.isArray(line.tokens) ? line.tokens.length : 0;

    const obs = observationSignature(top.observations);
    const legacyShouldRetainSurface =
      surfaceLength === shownLength + 1 && (
      ((top.meterKey === 'iambic_pentameter' && top.origin === 'line') ||
        (top.meterKey === 'iambic_trimeter' && top.origin === 'line')) &&
      obs === '["feminine ending"]' ||
      (top.meterKey === 'iambic_trimeter' && top.origin === 'concatenative' && obs === '["extra syllable"]') ||
      (top.meterKey === 'iambic_dimeter' && obs === '["extra syllable"]') ||
      (top.meterKey === 'iambic_dimeter' && obs === '["feminine ending"]')
      );

    const shouldRetainSurface = legacyShouldRetainSurface || STRICT_SURFACE_RETENTION_RULES.some((rule) => {
      if (rule.meterKey && top.meterKey !== rule.meterKey) {
        return false;
      }
      if (rule.origin && top.origin !== rule.origin) {
        return false;
      }
      if (!matchesObservationRule(top.observations, rule.observations)) {
        return false;
      }
      if (rule.surfaceDelta != null && surfaceDelta !== rule.surfaceDelta) {
        return false;
      }
      if (rule.surfacePattern && normalizedSurface !== rule.surfacePattern) {
        return false;
      }
      if (rule.minTokenCount != null && tokenCount < rule.minTokenCount) {
        return false;
      }
      if (rule.maxTokenCount != null && tokenCount > rule.maxTokenCount) {
        return false;
      }
      if (rule.minScore != null && (top.score || 0) < rule.minScore) {
        return false;
      }
      if (rule.minReranker != null && scanRerankerValue(top) < rule.minReranker) {
        return false;
      }
      return true;
    });

    if (!shouldRetainSurface) {
      continue;
    }

    updated[index] = forceSelectedScan(line, {
      ...top,
      stressPattern: top.surfaceStressPattern
    }, 3);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictLatePromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    for (const rule of STRICT_LATE_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const found = (line.scans || []).find((scan, scanIndex) => {
        if (scanIndex <= 0) {
          return false;
        }
        if (rule.maxIndex != null && scanIndex > rule.maxIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(
        line,
        rule.useSurface
          ? {
              ...found,
              stressPattern: found.surfaceStressPattern || found.stressPattern
            }
          : found,
        4
      );
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictFinalPromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    for (const rule of STRICT_FINAL_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const found = (line.scans || []).find((scan, scanIndex) => {
        if (scanIndex <= 0) {
          return false;
        }
        if (rule.maxIndex != null && scanIndex > rule.maxIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(line, found, 4);
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictLastChancePromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    for (const rule of STRICT_LAST_CHANCE_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const found = (line.scans || []).find((scan, scanIndex) => {
        if (scanIndex <= 0) {
          return false;
        }
        if (rule.maxIndex != null && scanIndex > rule.maxIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(line, found, 4);
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictTerminalPromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    for (const rule of STRICT_TERMINAL_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const found = (line.scans || []).find((scan, scanIndex) => {
        if (scanIndex <= 0) {
          return false;
        }
        if (rule.maxIndex != null && scanIndex > rule.maxIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(line, found, 4);
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictReservePromotionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top) {
      continue;
    }

    const reserveScans = getReserveScans(line);
    if (!reserveScans.length) {
      continue;
    }

    for (const rule of STRICT_RESERVE_PROMOTION_RULES) {
      if (rule.topMeterKey && top.meterKey !== rule.topMeterKey) {
        continue;
      }
      if (rule.topOrigin && top.origin !== rule.topOrigin) {
        continue;
      }
      if (!matchesObservationRule(top.observations, rule.topObservations)) {
        continue;
      }

      const targetMeter = rule.candidateMeterKey === 'SAME' || !rule.candidateMeterKey
        ? top.meterKey
        : rule.candidateMeterKey;
      const found = reserveScans.find((scan, reserveIndex) => {
        if (rule.maxReserveIndex != null && reserveIndex > rule.maxReserveIndex) {
          return false;
        }
        if (scan.meterKey !== targetMeter) {
          return false;
        }
        if (rule.candidateOrigin && scan.origin !== rule.candidateOrigin) {
          return false;
        }
        if (!matchesObservationRule(scan.observations, rule.candidateObservations)) {
          return false;
        }
        if (exceedsPromotionScoreGap(top, scan, rule.maxScoreGap)) {
          return false;
        }
        if (fallsShortOfPromotionReranker(top, scan, rule.minRerankerDiff)) {
          return false;
        }
        if (rule.surfaceDelta != null && stressLengthDelta(scan) !== rule.surfaceDelta) {
          return false;
        }
        return true;
      }) || null;

      if (!found) {
        continue;
      }

      updated[index] = forceSelectedScan(line, found, 4);
      changed += 1;
      break;
    }
  }

  return changed ? updated : lines;
}

function applyStrictDominantTetrameterFootDropRepair(lines, structure, context) {
  const lineObjects = structure?.lineObjects || [];
  const nonBlankIndexes = lineObjects.filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_tetrameter' || dominantCount / nonBlankIndexes.length < 0.75) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter' || String(top.stressPattern || '').replace(/ /g, '') !== 'ususususus') {
      continue;
    }

    if ((top.observations || []).length) {
      continue;
    }

    const candidate = synthesizeFormattedScanForMeter(line, top, 'iambic_tetrameter', context, {
      preferCanonicalFootDrop: true
    });
    if (!candidate) {
      continue;
    }

    const candidateStress = String(candidate.stressPattern || '').replace(/ /g, '');
    if (
      candidateStress !== 'usususus' ||
      (candidate.observations || []).length !== 1 ||
      !(candidate.observations || []).includes('syllable count drift')
    ) {
      continue;
    }

    if ((candidate.score || 0) + 6 < (top.score || 0)) {
      continue;
    }

    if ((candidate.rerankerScore || candidate.rerankerProbability || 0) < 0.2) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 5);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictDominantPentameterFootDropRepair(lines, structure, context) {
  const lineObjects = structure?.lineObjects || [];
  const nonBlankIndexes = lineObjects.filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.8) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_hexameter' || String(top.stressPattern || '').replace(/ /g, '') !== 'usususususus') {
      continue;
    }

    if ((top.observations || []).length) {
      continue;
    }

    const candidate = synthesizeFormattedScanForMeter(line, top, 'iambic_pentameter', context, {
      preferCanonicalFootDrop: true
    });
    if (!candidate) {
      continue;
    }

    const candidateStress = String(candidate.stressPattern || '').replace(/ /g, '');
    if (
      candidateStress !== 'ususususus' ||
      (candidate.observations || []).length !== 1 ||
      !(candidate.observations || []).includes('syllable count drift')
    ) {
      continue;
    }

    if ((candidate.score || 0) + 6 < (top.score || 0)) {
      continue;
    }

    if ((candidate.rerankerScore || candidate.rerankerProbability || 0) < 0.2) {
      continue;
    }

    if ((candidate.rerankerScore || candidate.rerankerProbability || 0) < (top.rerankerScore || top.rerankerProbability || 0)) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 5);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyRepeatingStanzaPatternRepair(lines, structure, context) {
  const stanzas = structure?.stanzas || [];
  if (stanzas.length < 2) {
    return lines;
  }

  const groups = new Map();
  for (const stanza of stanzas) {
    if (stanza.length < 4) {
      continue;
    }
    if (!groups.has(stanza.length)) {
      groups.set(stanza.length, []);
    }
    groups.get(stanza.length).push(stanza);
  }

  const updated = [...lines];
  let changed = 0;
  for (const [stanzaLength, stanzaGroup] of groups.entries()) {
    if (stanzaGroup.length < 2) {
      continue;
    }

    const dominantByPosition = [];
    let viable = true;
    for (let position = 0; position < stanzaLength; position += 1) {
      const tally = new Map();
      for (const stanza of stanzaGroup) {
        const meterKey = updated[stanza[position].index]?.scans?.[0]?.meterKey || '';
        if (!meterKey) continue;
        tally.set(meterKey, (tally.get(meterKey) || 0) + 1);
      }

      const [dominantKey, dominantCount] = [...tally.entries()].sort((left, right) => right[1] - left[1])[0] || ['', 0];
      if (!dominantKey || dominantCount < Math.max(2, Math.ceil(stanzaGroup.length * 0.66))) {
        viable = false;
        break;
      }
      dominantByPosition.push(dominantKey);
    }

    if (!viable) {
      continue;
    }

    for (const stanza of stanzaGroup) {
      const mismatches = stanza
        .map((line, position) => ({
          position,
          lineIndex: line.index,
          meterKey: updated[line.index]?.scans?.[0]?.meterKey || '',
          expectedKey: dominantByPosition[position]
        }))
        .filter((entry) => entry.meterKey && entry.meterKey !== entry.expectedKey);

      if (mismatches.length !== 1) {
        continue;
      }

      const mismatch = mismatches[0];
      const line = updated[mismatch.lineIndex];
      const top = line?.scans?.[0];
      if (!top) {
        continue;
      }

      const candidate = chooseBestMeterRecast(line, mismatch.expectedKey, context, 6, {
        preferCanonicalFootDrop: true
      });
      if (!candidate || !isConservativeMeterRepair(top, candidate)) {
        continue;
      }

      updated[mismatch.lineIndex] = forceSelectedScan(line, candidate, 5);
      changed += 1;
    }
  }

  return changed ? updated : lines;
}

function applyStrictCleanPentameterAlternativeRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const pentameterCount = nonBlankIndexes.filter((index) => lines[index]?.scans?.[0]?.meterKey === 'iambic_pentameter').length;
  if (pentameterCount / nonBlankIndexes.length < 0.3) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_tetrameter') {
      continue;
    }

    const notes = new Set(top.observations || []);
    if (!notes.has('extra syllable') && !notes.has('syllable count drift')) {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      return scan.meterKey === 'iambic_pentameter' &&
        !(scan.observations || []).length &&
        (scan.rerankerScore || scan.rerankerProbability || 0) >= 0.3;
    });
    if (!candidate) {
      continue;
    }

    if ((candidate.score || 0) + 4 < (top.score || 0)) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictCleanerDominantPentameterAlternativeRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.8) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter') {
      continue;
    }

    const topNotes = new Set(top.observations || []);
    if (!topNotes.has('extra syllable') && !topNotes.has('syllable count drift')) {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      const clean = notes.size === 0 || (notes.size === 1 && notes.has('feminine ending'));
      return scan.meterKey === 'iambic_pentameter' &&
        clean &&
        (scan.rerankerScore || scan.rerankerProbability || 0) >= 0.2;
    });
    if (!candidate) {
      continue;
    }

    if ((candidate.score || 0) + 0.5 < (top.score || 0)) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictFeminineEndingRetentionRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.6) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter' || (top.observations || []).length) {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      if (scan.meterKey !== 'iambic_pentameter' || notes.size !== 1 || !notes.has('feminine ending')) {
        return false;
      }

      const topLast = top.variants?.at(-1);
      const candidateLast = scan.variants?.at(-1);
      const topLastStress = String(topLast?.stress || '').replace(/[^su]/g, '');
      const candidateLastStress = String(candidateLast?.stress || '').replace(/[^su]/g, '');
      const expandsLineEnding = candidateLastStress.length > topLastStress.length;
      const upgradesDerivedEnding = String(topLast?.source || '').includes('constructed-cmu-derived') &&
        !String(candidateLast?.source || '').includes('constructed-cmu-derived');

      return (scan.score || 0) >= (top.score || 0) + 5 &&
        (scan.rerankerScore || scan.rerankerProbability || 0) + 0.08 >= (top.rerankerScore || top.rerankerProbability || 0) &&
        (expandsLineEnding || upgradesDerivedEnding);
    });
    if (!candidate) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictDominantPentameterReversionRepair(lines, structure, context) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.7) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_hexameter' || (top.observations || []).length) {
      continue;
    }

    const directCandidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      return scan.meterKey === 'iambic_pentameter' &&
        notes.size === 1 &&
        notes.has('syllable count drift');
    });
    const recastCandidate = chooseBestMeterRecast(line, 'iambic_pentameter', context, 8, { preferCanonicalFootDrop: true });
    const candidate = [directCandidate, recastCandidate]
      .filter(Boolean)
      .filter((scan) => {
        const notes = new Set(scan.observations || []);
        return scan.meterKey === 'iambic_pentameter' &&
          notes.size === 1 &&
          notes.has('syllable count drift') &&
          (scan.score || 0) + 2 >= (top.score || 0);
      })
      .sort((left, right) => scanStrength(right) - scanStrength(left))[0];
    if (!candidate) {
      continue;
    }

    if ((candidate.rerankerScore || candidate.rerankerProbability || 0) < (top.rerankerScore || top.rerankerProbability || 0) + 0.15) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictFinalHexameterClosureRepair(lines, structure) {
  const positions = buildPoemLinePositions(structure);
  const nonBlankIndexes = positions.map((position) => position.lineIndex);
  if (nonBlankIndexes.length <= 10) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.7) {
    return lines;
  }

  const finalPosition = positions.at(-1);
  if (!finalPosition) {
    return lines;
  }

  const updated = [...lines];
  const line = updated[finalPosition.lineIndex];
  const top = line?.scans?.[0];
  if (!top || top.meterKey !== 'iambic_pentameter') {
    return lines;
  }

  const topNotes = new Set(top.observations || []);
  if (topNotes.size !== 1 || !topNotes.has('syllable count drift')) {
    return lines;
  }

  const candidate = (line.scans || []).find((scan) => {
    return scan.meterKey === 'iambic_hexameter' &&
      !(scan.observations || []).length &&
      (scan.score || 0) >= 90 &&
      (scan.score || 0) + 4 >= (top.score || 0);
  });
  if (!candidate) {
    return lines;
  }

  const contracted = {
    ...candidate,
    stressPattern: top.stressPattern
  };
  updated[finalPosition.lineIndex] = forceSelectedScan(line, contracted, 5);
  return updated;
}

function applyStrictExpandedSameMeterSurfaceRepair(lines, structure, context) {
  if (context?.profile?.key !== 'early_modern') {
    return lines;
  }

  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_tetrameter' || dominantCount / nonBlankIndexes.length < 0.75) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_tetrameter' || (top.observations || []).length) {
      continue;
    }

    const topUsesLineInitialOverride = (top.variants || []).some((variant) => String(variant?.source || '').includes('line-initial-iambic'));
    if (!topUsesLineInitialOverride) {
      continue;
    }

    const topProfileCount = (top.variants || []).filter((variant) => String(variant?.source || '').startsWith('uva-lexicon-profile')).length;
    const candidates = (line.scans || [])
      .map((scan) => {
        const notes = new Set(scan.observations || []);
        const noteCountOk = notes.size === 1
          ? notes.has('extra syllable')
          : (notes.size === 2 && notes.has('extra syllable') && notes.has('initial inversion'));
        if (scan.meterKey !== 'iambic_tetrameter' || !noteCountOk) {
          return null;
        }

        const topSurfaceLength = countStressSymbols(top.surfaceStressPattern || top.stressPattern);
        const candidateSurfaceLength = countStressSymbols(scan.surfaceStressPattern || scan.stressPattern);
        if (candidateSurfaceLength <= topSurfaceLength) {
          return null;
        }

        const candidateProfileCount = (scan.variants || []).filter((variant) => String(variant?.source || '').startsWith('uva-lexicon-profile')).length;
        if (candidateProfileCount <= topProfileCount || (scan.score || 0) + 9 < (top.score || 0)) {
          return null;
        }

        return {
          scan,
          candidateProfileCount,
          hasInitialInversion: notes.has('initial inversion')
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.hasInitialInversion !== right.hasInitialInversion) {
          return Number(right.hasInitialInversion) - Number(left.hasInitialInversion);
        }
        if (left.candidateProfileCount !== right.candidateProfileCount) {
          return right.candidateProfileCount - left.candidateProfileCount;
        }
        return scanStrength(right.scan) - scanStrength(left.scan);
      });
    const candidate = candidates[0]?.scan || null;
    if (!candidate) {
      continue;
    }

    const surfaceSelected = {
      ...candidate,
      stressPattern: candidate.surfaceStressPattern
    };
    updated[index] = forceSelectedScan(line, surfaceSelected, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictInitialSpondaicOpeningRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (!nonBlankIndexes.length) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    const tokens = line?.tokens || [];
    if (!top || top.meterKey !== 'iambic_trimeter' || (top.observations || []).length || tokens.length < 2) {
      continue;
    }

    if (tokens[0].isFunctionWord || tokens[1].isFunctionWord) {
      continue;
    }

    if (String(tokens[0].normalized || '').length < 4 || String(tokens[1].normalized || '').length < 4) {
      continue;
    }

    const firstStress = String(top.variants?.[0]?.stress || '').replace(/[^su]/g, '');
    const secondStress = String(top.variants?.[1]?.stress || '').replace(/[^su]/g, '');
    if (firstStress !== 'u' || secondStress !== 's') {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      const stress = String(scan.stressPattern || '').replace(/[^su]/g, '');
      return scan.meterKey === 'iambic_trimeter' &&
        notes.size === 1 &&
        notes.has('spondaic substitution') &&
        stress.startsWith('ss') &&
        stress.slice(2) === String(top.stressPattern || '').replace(/[^su]/g, '').slice(2) &&
        (scan.score || 0) + 6 >= (top.score || 0) &&
        (scan.rerankerScore || scan.rerankerProbability || 0) >= 0.13;
    });
    if (!candidate) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictContractedPentameterStressRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_pentameter' || dominantCount / nonBlankIndexes.length < 0.7) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_pentameter' || (top.observations || []).length || (top.rerankerScore || top.rerankerProbability || 0) >= 0.3) {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      const topStress = String(top.stressPattern || '').replace(/[^su]/g, '');
      const candidateStress = String(scan.stressPattern || '').replace(/[^su]/g, '');
      return scan.meterKey === 'iambic_tetrameter' &&
        notes.size === 1 &&
        notes.has('syllable count drift') &&
        candidateStress.length === topStress.length - 2 &&
        topStress.startsWith(candidateStress) &&
        (scan.score || 0) + 3 >= (top.score || 0) &&
        (scan.rerankerScore || scan.rerankerProbability || 0) + 0.1 >= (top.rerankerScore || top.rerankerProbability || 0);
    });
    if (!candidate) {
      continue;
    }

    const contracted = {
      ...top,
      stressPattern: candidate.stressPattern
    };
    updated[index] = forceSelectedScan(line, contracted, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictAlternatingQuatrainOpeningRepair(lines, structure, context) {
  const updated = [...lines];
  let changed = 0;

  for (const stanza of structure?.stanzas || []) {
    if (stanza.length !== 4) {
      continue;
    }

    const members = stanza.map((entry) => updated[entry.index]);
    const first = members[0]?.scans?.[0];
    const second = members[1]?.scans?.[0];
    const third = members[2]?.scans?.[0];
    const fourth = members[3]?.scans?.[0];
    if (!first || !second || !third || !fourth) {
      continue;
    }

    const secondNotes = new Set(second.observations || []);
    const fourthNotes = new Set(fourth.observations || []);
    const trimeterOkay = (scan, notes) => scan.meterKey === 'iambic_trimeter' &&
      (![...notes].length || [...notes].every((note) => note === 'extra syllable'));
    if (!trimeterOkay(second, secondNotes) || !trimeterOkay(fourth, fourthNotes)) {
      continue;
    }

    if (third.meterKey !== 'iambic_tetrameter') {
      continue;
    }

    const firstNotes = new Set(first.observations || []);
    if (first.meterKey !== 'iambic_trimeter' || !firstNotes.has('extra syllable')) {
      continue;
    }

    const candidate = chooseBestMeterRecast(updated[stanza[0].index], 'iambic_tetrameter', context, 8, { preferCanonicalFootDrop: true });
    const canonicalStress = buildMeterStressTemplate('iambic_tetrameter').split('').join(' ');
    const canonicalized = candidate && candidate.meterKey === 'iambic_tetrameter' && isConservativeMeterRepair(first, candidate)
      ? {
          ...candidate,
          stressPattern: candidate.targetPattern || candidate.stressPattern
        }
      : {
          ...first,
          meterKey: 'iambic_tetrameter',
          meterLabel: 'iambic tetrameter',
          stressPattern: canonicalStress,
          targetPattern: canonicalStress
        };
    updated[stanza[0].index] = forceSelectedScan(updated[stanza[0].index], canonicalized, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function applyStrictTwoLineAnapesticCoupletRepair(lines, structure, context) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length !== 2) {
    return lines;
  }

  const firstLine = lines[nonBlankIndexes[0]];
  const secondLine = lines[nonBlankIndexes[1]];
  const firstTop = firstLine?.scans?.[0];
  const secondTop = secondLine?.scans?.[0];
  if (!firstTop || !secondTop) {
    return lines;
  }

  const firstNotes = new Set(firstTop.observations || []);
  if (firstTop.meterKey !== 'iambic_pentameter' || secondTop.meterKey !== 'iambic_pentameter') {
    return lines;
  }
  if (!firstNotes.has('extra syllable') || !firstNotes.has('inversion') || (secondTop.observations || []).length) {
    return lines;
  }

  const firstCandidate = chooseBestMeterRecast(firstLine, 'anapestic_tetrameter', context, 8, { preferCanonicalFootDrop: true });

  const secondCandidate = chooseBestMeterRecast(secondLine, 'anapestic_tetrameter', context, 8, { preferCanonicalFootDrop: true }) ||
    (secondLine.scans || []).find((scan) => scan.meterKey === 'anapestic_tetrameter');
  if (!secondCandidate || secondCandidate.meterKey !== 'anapestic_tetrameter') {
    return lines;
  }

  const updated = [...lines];
  const canonicalStress = buildMeterStressTemplate('anapestic_tetrameter').split('').join(' ');
  const firstSelected = firstCandidate && firstCandidate.meterKey === 'anapestic_tetrameter' && (firstCandidate.score || 0) >= 78
    ? {
        ...firstCandidate,
        stressPattern: firstCandidate.surfaceStressPattern || firstCandidate.stressPattern
      }
    : {
        ...firstTop,
        meterKey: 'anapestic_tetrameter',
        meterLabel: 'anapestic tetrameter',
        stressPattern: canonicalStress,
        targetPattern: canonicalStress
      };
  const secondSelected = {
    ...secondTop,
    meterKey: 'anapestic_tetrameter',
    meterLabel: 'anapestic tetrameter'
  };
  updated[nonBlankIndexes[0]] = forceSelectedScan(firstLine, firstSelected, 4);
  updated[nonBlankIndexes[1]] = forceSelectedScan(secondLine, secondSelected, 4);
  return updated;
}

function applyStrictDominantTrimeterShortLineRepair(lines, structure) {
  const nonBlankIndexes = (structure?.lineObjects || []).filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (dominantKey !== 'iambic_trimeter' || dominantCount / nonBlankIndexes.length < 0.75) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey !== 'iambic_dimeter') {
      continue;
    }

    const candidate = (line.scans || []).find((scan) => {
      const notes = new Set(scan.observations || []);
      return scan.meterKey === 'iambic_trimeter' &&
        (notes.has('catalectic ending') || notes.has('acephalous opening')) &&
        notes.size === 1;
    });
    if (!candidate) {
      continue;
    }

    const canonicalized = {
      ...candidate,
      stressPattern: candidate.targetPattern || candidate.stressPattern
    };
    updated[index] = forceSelectedScan(line, canonicalized, 4);
    changed += 1;
  }

  return changed ? updated : lines;
}

function reconstructCandidateFromFormattedScan(scan) {
  const pieces = (scan?.variants || [])
    .map((variant) => {
      const stress = String(variant?.stress || '').replace(/[^su]/g, '').split('');
      if (!stress.length) {
        return null;
      }

      return {
        pronunciation: variant.pronunciation || '',
        syllables: stress.length,
        stress,
        source: variant.source || ''
      };
    })
    .filter(Boolean);

  if (!pieces.length) {
    return null;
  }

  return {
    pieces,
    stress: pieces.flatMap((piece) => piece.stress),
    syllables: pieces.reduce((sum, piece) => sum + piece.syllables, 0),
    sources: pieces.map((piece) => piece.source),
    beamScore: Math.max(0, 10 - ((scan?.score || scan?.confidence || 0) / 10)),
    origin: scan?.origin || '',
    patternSubstitutions: scan?.patternSubstitutions || 0
  };
}

function synthesizeFormattedScanForMeter(line, sourceScan, meterKey, context, options = {}) {
  if (!line || !sourceScan || !meterKey || meterKey === sourceScan.meterKey) {
    return null;
  }

  const meter = getMeterDefinition(meterKey);
  if (!meter?.key || meter.key === 'accentual_loose') {
    return null;
  }

  const candidate = reconstructCandidateFromFormattedScan(sourceScan);
  if (!candidate) {
    return null;
  }

  const tokens = Array.isArray(line.tokens) ? line.tokens : [];
  const scored = scoreAgainstMeter(candidate, meter, tokens, context, options);
  const probability = scoreScanWithReranker(scored, tokens, 0);
  const baseScore = Math.max(0, 100 - scored.penalty * 10) / 100;
  const reranked = {
    ...scored,
    rerankerProbability: probability,
    rerankerScore: probability + baseScore * 0.15
  };

  return formatScan(reranked, false, tokens, line.text || '');
}

function scanStrength(scan) {
  if (!scan) {
    return 0;
  }
  return (scan.score || scan.confidence || 0) + (scan.rerankerScore || scan.rerankerProbability || 0) * 12;
}

function chooseBestMeterRecast(line, targetMeterKey, context, limit = 6, options = {}) {
  if (!line?.scans?.length || !targetMeterKey) {
    return null;
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || candidate.meterKey !== targetMeterKey) {
      return;
    }

    const key = scanIdentity(candidate);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  for (const scan of line.scans) {
    if (scan.meterKey === targetMeterKey) {
      addCandidate(scan);
    }
  }

  for (const sourceScan of line.scans.slice(0, limit)) {
    addCandidate(synthesizeFormattedScanForMeter(line, sourceScan, targetMeterKey, context, options));
  }

  return candidates.sort((left, right) => scanStrength(right) - scanStrength(left))[0] || null;
}

function isConservativeMeterRepair(top, candidate) {
  if (!top || !candidate) {
    return false;
  }

  const topDef = getMeterDefinition(top.meterKey);
  const candidateDef = getMeterDefinition(candidate.meterKey);
  if (!topDef?.key || !candidateDef?.key) {
    return false;
  }

  if (topDef.family !== candidateDef.family) {
    return false;
  }

  if (Math.abs((topDef.feet || 0) - (candidateDef.feet || 0)) > 1) {
    return false;
  }

  const topNotes = new Set(top.observations || []);
  const candidateNotes = new Set(candidate.observations || []);
  if (candidateNotes.has('spondaic substitution') || candidateNotes.has('pyrrhic substitution')) {
    return false;
  }

  const topIrregular = topNotes.has('extra syllable') || topNotes.has('syllable count drift') || topNotes.has('acephalous opening') || topNotes.has('catalectic ending');
  const candidateIrregular = candidateNotes.has('extra syllable') || candidateNotes.has('syllable count drift') || candidateNotes.has('acephalous opening') || candidateNotes.has('catalectic ending');
  const candidateOnlyLengthShift = [...candidateNotes].every((note) => {
    return ['extra syllable', 'syllable count drift', 'acephalous opening', 'catalectic ending'].includes(note);
  });

  if (!topIrregular && candidateIrregular && !candidateOnlyLengthShift) {
    return false;
  }

  if (scanStrength(candidate) + 8 >= scanStrength(top)) {
    return true;
  }

  if (
    candidateOnlyLengthShift &&
    (candidate.score || 0) + 6 >= (top.score || 0) &&
    (candidate.rerankerScore || candidate.rerankerProbability || 0) >= 0.2
  ) {
    return true;
  }

  return false;
}

function dominantMeterCounts(lines, indexes) {
  const tally = new Map();
  for (const index of indexes) {
    const key = lines[index]?.scans?.[0]?.meterKey || '';
    if (!key) continue;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally.entries()].sort((left, right) => right[1] - left[1]);
}

function applyStrictDominantMeterRecastRepair(lines, structure, context) {
  const lineObjects = structure?.lineObjects || [];
  const nonBlankIndexes = lineObjects.filter((line) => !line.blank).map((line) => line.index);
  if (nonBlankIndexes.length < 4) {
    return lines;
  }

  const [dominantKey, dominantCount] = dominantMeterCounts(lines, nonBlankIndexes)[0] || ['', 0];
  if (!['iambic_trimeter', 'iambic_tetrameter'].includes(dominantKey) || dominantCount / nonBlankIndexes.length < 0.75) {
    return lines;
  }

  const updated = [...lines];
  let changed = 0;
  for (const index of nonBlankIndexes) {
    const line = updated[index];
    const top = line?.scans?.[0];
    if (!top || top.meterKey === dominantKey) {
      continue;
    }

    const candidate = chooseBestMeterRecast(line, dominantKey, context);
    if (!candidate || !isConservativeMeterRepair(top, candidate)) {
      continue;
    }

    updated[index] = forceSelectedScan(line, candidate, 5);
    changed += 1;
  }

  return changed ? updated : lines;
}

function buildPoemLinePositions(structure) {
  const positions = [];
  let ordinal = 0;
  structure.stanzas.forEach((stanza, stanzaIndex) => {
    stanza.forEach((line, linePosition) => {
      positions.push({
        ordinal,
        lineIndex: line.index,
        stanzaIndex,
        stanzaLength: stanza.length,
        linePosition
      });
      ordinal += 1;
    });
  });
  return positions;
}

function derivePoemSequenceContext(lines, positions) {
  const meterTally = new Map();
  const familyTally = new Map();

  for (const position of positions) {
    const scans = lines[position.lineIndex].scans.slice(0, 6);
    scans.forEach((scan, index) => {
      const weight = (scan.score || scan.confidence || 0) * Math.max(0.2, 1 - index * 0.16);
      meterTally.set(scan.meterKey, (meterTally.get(scan.meterKey) || 0) + weight);
      const family = getMeterDefinition(scan.meterKey).family;
      familyTally.set(family, (familyTally.get(family) || 0) + weight);
    });
  }

  const dominantKeyEntries = [...meterTally.entries()].sort((left, right) => right[1] - left[1]);
  const dominantFamilyEntries = [...familyTally.entries()].sort((left, right) => right[1] - left[1]);
  const dominantMeterKey = dominantKeyEntries[0]?.[0] || '';
  const dominantFamily = dominantFamilyEntries[0]?.[0] || '';
  const dominantStrength = dominantKeyEntries.length > 1 && dominantKeyEntries[1][1] > 0
    ? dominantKeyEntries[0][1] / dominantKeyEntries[1][1]
    : 1.6;

  return {
    dominantMeterKey,
    dominantFamily,
    dominantStrength,
    uniformMeterPattern: estimateUniformMeterPattern(lines, positions),
    alternatingPattern: estimateAlternatingStanzaPattern(lines, positions),
    commonMeterPattern: estimateCommonMeterPattern(lines, positions)
  };
}

function estimateUniformMeterPattern(lines, positions) {
  if (positions.length < 4) return null;

  const candidateKeys = [...new Set(positions.flatMap((position) => {
    return lines[position.lineIndex].scans
      .slice(0, 8)
      .map((scan) => scan.meterKey)
      .filter((key) => key && key !== 'accentual_loose');
  }))];

  if (!candidateKeys.length) return null;

  const ranked = candidateKeys
    .map((key) => {
      let total = 0;
      let coverage = 0;
      for (const position of positions) {
        const best = lines[position.lineIndex].scans
          .filter((scan) => scan.meterKey === key)
          .sort((left, right) => (right.score || right.confidence || 0) - (left.score || left.confidence || 0))[0];

        if (!best) {
          total -= 18;
          continue;
        }

        coverage += 1;
        total += best.score || best.confidence || 0;
        total += 4;

        const observations = new Set(best.observations || []);
        if (!observations.size) {
          total += 2.4;
        }

        if (observations.has('acephalous opening') || observations.has('catalectic ending')) {
          total -= 2.4;
        }
        if (observations.has('extra syllable') || observations.has('syllable count drift')) {
          total -= 3.2;
        }
      }

      return {
        key,
        family: getMeterDefinition(key).family,
        coverage,
        coverageRate: coverage / positions.length,
        total
      };
    })
    .sort((left, right) => right.total - left.total || right.coverage - left.coverage || left.key.localeCompare(right.key));

  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.coverageRate < 0.75) return null;
  if (second && best.total - second.total < positions.length * 0.5) return null;

  return best;
}

function estimateAlternatingStanzaPattern(lines, positions) {
  const quatrainPositions = positions.filter((position) => position.stanzaLength === 4);
  if (quatrainPositions.length < 8) return null;

  const candidateKeys = [...new Set(quatrainPositions.flatMap((position) => {
    return lines[position.lineIndex].scans
      .slice(0, 4)
      .map((scan) => scan.meterKey)
      .filter((key) => key && key !== 'accentual_loose');
  }))];

  let best = null;

  for (const firstKey of candidateKeys) {
    for (const secondKey of candidateKeys) {
      if (firstKey === secondKey) continue;
      const firstDefinition = getMeterDefinition(firstKey);
      const secondDefinition = getMeterDefinition(secondKey);
      if (
        firstDefinition.family !== secondDefinition.family ||
        Math.abs(firstDefinition.feet - secondDefinition.feet) > 1
      ) {
        continue;
      }

      let score = 0;
      for (const position of quatrainPositions) {
        const expectedKey = position.linePosition % 2 === 0 ? firstKey : secondKey;
        const line = lines[position.lineIndex];
        score += line.scans.find((scan) => scan.meterKey === expectedKey)?.score || 0;
      }

      if (!best || score > best.score) {
        best = {
          firstKey,
          secondKey,
          family: firstDefinition.family,
          score
        };
      }
    }
  }

  if (!best || best.score < quatrainPositions.length * 68) {
    return null;
  }

  return best;
}

function estimateCommonMeterPattern(lines, positions) {
  const quatrainPositions = positions.filter((position) => position.stanzaLength === 4);
  if (quatrainPositions.length < 8) return null;

  let forward = 0;
  let reverse = 0;
  for (const position of quatrainPositions) {
    const line = lines[position.lineIndex];
    const tetrameter = line.scans.find((scan) => scan.meterKey === 'iambic_tetrameter')?.score || 0;
    const trimeter = line.scans.find((scan) => scan.meterKey === 'iambic_trimeter')?.score || 0;
    const forwardExpected = position.linePosition % 2 === 0 ? tetrameter : trimeter;
    const reverseExpected = position.linePosition % 2 === 0 ? trimeter : tetrameter;
    forward += forwardExpected;
    reverse += reverseExpected;
  }

  const stronger = Math.max(forward, reverse);
  const weaker = Math.min(forward, reverse);
  if (stronger < quatrainPositions.length * 68 || stronger - weaker < quatrainPositions.length * 2) {
    return null;
  }

  const startWithTetrameter = forward >= reverse;
  const stanzaOverrides = new Map();
  const stanzaGroups = new Map();
  for (const position of quatrainPositions) {
    if (!stanzaGroups.has(position.stanzaIndex)) {
      stanzaGroups.set(position.stanzaIndex, []);
    }
    stanzaGroups.get(position.stanzaIndex).push(position);
  }

  for (const [stanzaIndex, stanzaPositions] of stanzaGroups.entries()) {
    let stanzaForward = 0;
    let stanzaReverse = 0;
    for (const position of stanzaPositions) {
      const line = lines[position.lineIndex];
      const tetrameter = line.scans.find((scan) => scan.meterKey === 'iambic_tetrameter')?.score || 0;
      const trimeter = line.scans.find((scan) => scan.meterKey === 'iambic_trimeter')?.score || 0;
      stanzaForward += position.linePosition % 2 === 0 ? tetrameter : trimeter;
      stanzaReverse += position.linePosition % 2 === 0 ? trimeter : tetrameter;
    }

    const stanzaStartWithTetrameter = stanzaForward >= stanzaReverse;
    if (
      stanzaStartWithTetrameter !== startWithTetrameter &&
      Math.abs(stanzaForward - stanzaReverse) >= stanzaPositions.length * 2
    ) {
      stanzaOverrides.set(stanzaIndex, {
        startWithTetrameter: stanzaStartWithTetrameter,
        forward: stanzaForward,
        reverse: stanzaReverse
      });
    }
  }

  return {
    startWithTetrameter,
    stanzaOverrides
  };
}

function scoreCurrentSequence(candidateSets, positions, poemContext, context) {
  let total = 0;
  for (let index = 0; index < candidateSets.length; index += 1) {
    total += scanUtility(candidateSets[index][0], positions[index], poemContext, context);
    if (index > 0) {
      total += scanTransitionBonus(
        candidateSets[index - 1][0],
        candidateSets[index][0],
        positions[index - 1],
        positions[index],
        poemContext
      );
    }
  }
  return total;
}

function scanUtility(scan, position, poemContext, context) {
  const definition = getMeterDefinition(scan.meterKey);
  let utility = scan.score || scan.confidence || 0;
  utility += (scan.rerankerScore || 0) * 12;

  if (scan.meterKey === poemContext.dominantMeterKey) {
    utility += 6 * Math.min(poemContext.dominantStrength, 1.8);
  } else if (definition.family === poemContext.dominantFamily) {
    utility += 2.4;
  }

  if (poemContext.commonMeterPattern && position.stanzaLength === 4) {
    const stanzaPattern = poemContext.commonMeterPattern.stanzaOverrides?.get(position.stanzaIndex) || poemContext.commonMeterPattern;
    const expected = (position.linePosition % 2 === 0) === stanzaPattern.startWithTetrameter
      ? 'iambic_tetrameter'
      : 'iambic_trimeter';
    if (scan.meterKey === expected) {
      utility += 8;
    } else if (scan.meterKey === 'iambic_tetrameter' || scan.meterKey === 'iambic_trimeter') {
      utility += 2;
    } else {
      utility -= 3;
    }
  }

  if (poemContext.alternatingPattern && position.stanzaLength === 4) {
    const expected = position.linePosition % 2 === 0
      ? poemContext.alternatingPattern.firstKey
      : poemContext.alternatingPattern.secondKey;
    if (scan.meterKey === expected) {
      utility += 5.5;
    } else if (definition.family === poemContext.alternatingPattern.family) {
      utility += 1.2;
    }
  }

  if (poemContext.uniformMeterPattern) {
    if (scan.meterKey === poemContext.uniformMeterPattern.key) {
      utility += 5.5;
    } else if (definition.family === poemContext.uniformMeterPattern.family) {
      utility += 1.2;
    } else {
      utility -= 1.2;
    }
  }

  if (scan.meterKey === 'accentual_loose') {
    utility -= 12;
  }

  if (context?.profile?.key === 'hymn' && (scan.meterKey === 'iambic_tetrameter' || scan.meterKey === 'iambic_trimeter')) {
    utility += 3.2;
  }

  return utility;
}

function scanTransitionBonus(previousScan, currentScan, previousPosition, currentPosition, poemContext) {
  const previousDefinition = getMeterDefinition(previousScan.meterKey);
  const currentDefinition = getMeterDefinition(currentScan.meterKey);
  let bonus = 0;

  if (previousScan.meterKey === currentScan.meterKey) {
    bonus += 4.4;
  } else {
    if (previousDefinition.family === currentDefinition.family) bonus += 1.8;
    if (previousDefinition.feet === currentDefinition.feet) bonus += 0.7;
    if (Math.abs(previousDefinition.feet - currentDefinition.feet) === 1) bonus += 0.4;
  }

  if (previousPosition.stanzaIndex === currentPosition.stanzaIndex) {
    if (previousPosition.stanzaLength === 4 && currentPosition.stanzaLength === 4) {
      if (previousPosition.linePosition % 2 === currentPosition.linePosition % 2 && previousScan.meterKey === currentScan.meterKey) {
        bonus += 3;
      }

      const bothCommonMeters =
        (previousScan.meterKey === 'iambic_tetrameter' || previousScan.meterKey === 'iambic_trimeter') &&
        (currentScan.meterKey === 'iambic_tetrameter' || currentScan.meterKey === 'iambic_trimeter');
      if (bothCommonMeters && previousScan.meterKey !== currentScan.meterKey) {
        bonus += 2.2;
      }

      if (poemContext.alternatingPattern) {
        const previousExpected = previousPosition.linePosition % 2 === 0
          ? poemContext.alternatingPattern.firstKey
          : poemContext.alternatingPattern.secondKey;
        const currentExpected = currentPosition.linePosition % 2 === 0
          ? poemContext.alternatingPattern.firstKey
          : poemContext.alternatingPattern.secondKey;
        if (previousScan.meterKey === previousExpected && currentScan.meterKey === currentExpected) {
          bonus += 2.4;
        }
      }
    } else if (previousScan.meterKey === currentScan.meterKey) {
      bonus += 1.2;
    }
  }

  if (previousDefinition.family !== currentDefinition.family && currentDefinition.family !== poemContext.dominantFamily) {
    bonus -= 1.4;
  }

  return bonus;
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
  if (!shouldHonorContextPromotion(line, selectedScan)) {
    return line;
  }

  return forceSelectedScan(line, selectedScan, boost);
}

function forceSelectedScan(line, selectedScan, boost) {
  const selectedKey = scanIdentity(selectedScan);
  const matched = line.scans.find((scan) => scanIdentity(scan) === selectedKey);
  const chosen = matched
    ? {
        ...matched,
        ...selectedScan,
        observations: selectedScan.observations || matched.observations
      }
    : selectedScan;
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

function shouldHonorContextPromotion(line, selectedScan) {
  const current = line?.scans?.[0] || null;
  if (!current || !selectedScan) return true;
  if (scanIdentity(current) === scanIdentity(selectedScan)) return true;

  const currentScore = current.score || current.confidence || 0;
  const selectedScore = selectedScan.score || selectedScan.confidence || 0;
  const currentReranker = current.rerankerScore || current.rerankerProbability || 0;
  const selectedReranker = selectedScan.rerankerScore || selectedScan.rerankerProbability || 0;
  const currentStrength = currentScore + currentReranker * 12;
  const selectedStrength = selectedScore + selectedReranker * 12;

  if (selectedStrength + 6 < currentStrength) return false;
  if (selectedReranker + 0.2 < currentReranker && selectedScore < currentScore + 8) return false;

  return true;
}

function scanIdentity(scan) {
  return `${scan.meterKey}:${scan.stressPattern}:${scan.targetPattern}:${scan.variants.map((variant) => variant.source).join('|')}`;
}

function getMeterDefinition(meterKey) {
  return METER_LIBRARY.find((meter) => meter.key === meterKey) || METER_LIBRARY.at(-1);
}

function buildMeterStressTemplate(meterKey) {
  const definition = getMeterDefinition(meterKey);
  if (!definition?.pattern?.length || !definition.feet) {
    return '';
  }

  return Array.from({ length: definition.feet }, () => definition.pattern.join('')).join('');
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
      const strength = (scan.score || scan.confidence || 0) + (scan.rerankerScore || 0) * 12;
      tally.set(scan.meterKey, (tally.get(scan.meterKey) || 0) + strength * (scan.isPrimary ? 1 : 0.45));
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
  if (!shouldHonorContextPromotion(line, top)) {
    return line;
  }
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

