import { dictionary as cmuDictionary } from 'cmu-pronouncing-dictionary';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

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
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  try {
    const body = await request.json();
    const poem = String(body?.poem || '');
    const wantSummary = body?.includeSummary !== false;
    const stream = body?.stream === true;

    if (!poem.trim()) {
      return json({ error: 'Please paste a poem first.' }, 400);
    }

    if (stream) {
      return streamAnalysis(poem, wantSummary);
    }

    const analysis = analyzePoem(poem);
    const summary = wantSummary ? await generateSummary(analysis).catch(() => fallbackSummary(analysis)) : null;

    return json({ ...analysis, summary });
  } catch (error) {
    return json({ error: error?.message || 'Unexpected error.' }, 500);
  }
};

function analyzePoem(poem) {
  const structure = buildPoemStructure(poem);
  const analyzedLines = structure.lineObjects.map((line) => {
    return line.blank ? createBlankLineAnalysis(line) : analyzeLine(line.text, line.index);
  });

  return finalizeAnalysis(structure, analyzedLines);
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

function finalizeAnalysis(structure, analyzedLines) {
  const { normalized, stanzas } = structure;
  const finalLines = [...analyzedLines];
  const stanzaResults = stanzas.map((stanzaLines, stanzaIndex) => {
    const members = stanzaLines.map((line) => analyzedLines[line.index]);
    const selection = selectStanzaReadings(members);

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

  const overall = inferOverallMeter(finalLines, stanzaResults, meterTally);
  const overallLabel = overall === 'common_meter'
    ? 'common meter'
    : (METER_LIBRARY.find((m) => m.key === overall) || METER_LIBRARY.at(-1)).label;
  const rhymeAnalysis = buildRhymeAnalysis(structure, finalLines);

  return {
    poem: normalized,
    overallMeter: overallLabel,
    stanzaResults,
    lines: rhymeAnalysis.annotatedLines,
    rhyme: rhymeAnalysis.rhyme,
    diagnostics: buildDiagnostics(rhymeAnalysis.annotatedLines, stanzaResults)
  };
}

function streamAnalysis(poem, wantSummary) {
  const encoder = new TextEncoder();
  const structure = buildPoemStructure(poem);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const analyzedLines = Array.from({ length: structure.lineObjects.length });

        for (const line of structure.lineObjects) {
          const result = line.blank ? createBlankLineAnalysis(line) : analyzeLine(line.text, line.index);
          analyzedLines[line.index] = result;
          send({ type: 'line', line: result });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const analysis = finalizeAnalysis(structure, analyzedLines);
        send({
          type: 'complete',
          analysis: {
            ...analysis,
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
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'access-control-allow-origin': '*'
    }
  });
}

function analyzeLine(text, index) {
  const tokens = tokenize(text);
  const candidates = expandTokenCandidates(tokens);
  const lineCandidates = composeLineCandidates(candidates, 192);
  const ranked = rankMeters(lineCandidates, tokens);
  const scans = ranked.slice(0, 10).map((scan, i) => formatScan(scan, i === 0, tokens, text));
  const top = scans[0] || {
    meterLabel: 'accentual / mixed meter',
    confidence: 50
  };

  return {
    index,
    text,
    blank: false,
    tag: top.meterLabel,
    confidence: top.confidence,
    scans,
    tokens: tokens.map((token, i) => ({
      ...token,
      options: candidates[i].map((candidate) => ({
        source: candidate.source,
        syllables: candidate.syllables,
        stressPattern: candidate.stress.join(''),
        pronunciation: candidate.pronunciation
      }))
    }))
  };
}

function tokenize(text) {
  const parts = [];
  let match;
  while ((match = WORD_RE.exec(text)) !== null) {
    const raw = match[0];
    const cleaned = normalizeWord(raw);
    if (!cleaned) continue;
    parts.push({
      raw,
      normalized: cleaned,
      isFunctionWord: FUNCTION_WORDS.has(cleaned),
      start: match.index,
      end: match.index + raw.length
    });
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

function expandTokenCandidates(tokens) {
  return tokens.map((token, index) => {
    const base = lookupPronunciations(token.normalized, token.raw, token.isFunctionWord);
    const contextual = buildContextualCandidates(token, base, tokens[index - 1], tokens[index + 1]);
    return rankPronunciationCandidates(dedupeCandidates([...base, ...contextual])).slice(0, 6);
  });
}

function lookupPronunciations(normalized, raw, isFunctionWord) {
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
      return buildPoeticStressVariants(normalized, entry.stress).map((stress, index) => ({
        ...entry,
        syllables: stress.length,
        stress,
        source: `${entry.source}-poetic-${index + 1}`
      }));
    }));

    if (isFunctionWord) {
      found.push(...found.map((entry) => ({
        ...entry,
        stress: entry.stress.map((v, i) => (i === 0 ? 'u' : v)),
        source: `${entry.source}-demoted`
      })));
    }
    return found;
  }

  return heuristicPronunciations(normalized, raw, isFunctionWord);
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

function buildPoeticStressVariants(normalized, stress) {
  const variants = new Map();

  for (const reduced of OPTIONAL_POETIC_REDUCTIONS.get(normalized) || []) {
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

function heuristicPronunciations(normalized, raw, isFunctionWord) {
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
    source: idx === 0 ? 'heuristic-primary' : 'heuristic-alt'
  }));
}

function buildContextualCandidates(token, candidates, prevToken, nextToken) {
  const contextual = [];

  if (token.isFunctionWord) {
    for (const candidate of candidates) {
      if (candidate.syllables !== 1 || candidate.stress[0] !== 'u') continue;
      contextual.push({
        ...candidate,
        stress: ['s'],
        source: `${candidate.source}-${STRESSABLE_FUNCTION_WORDS.has(token.normalized) ? 'promoted' : 'promoted-rare'}`
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

function rankPronunciationCandidates(candidates) {
  return [...candidates].sort((a, b) => pronunciationCandidateCost(a) - pronunciationCandidateCost(b));
}

function pronunciationCandidateCost(candidate) {
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

function composeLineCandidates(tokenCandidates, limit = 128) {
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
    next.sort((a, b) => scoreCandidateSimplicity(a) - scoreCandidateSimplicity(b));
    states = next.slice(0, limit);
  }

  return states;
}

function scoreCandidateSimplicity(candidate) {
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
    return sum + cost;
  }, 0) + candidate.syllables * 0.01;
}

function rankMeters(lineCandidates, tokens) {
  const results = [];

  for (const candidate of lineCandidates) {
    for (const meter of METER_LIBRARY) {
      if (meter.key === 'accentual_loose') continue;
      const scored = scoreAgainstMeter(candidate, meter, tokens);
      results.push(scored);
    }

    results.push(scoreAccentual(candidate, tokens));
  }

  results.sort((a, b) => a.penalty - b.penalty || b.confidence - a.confidence);
  return dedupeScans(results).slice(0, 8);
}

function scoreAgainstMeter(candidate, meter, tokens) {
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

function scoreAccentual(candidate, tokens) {
  const stresses = candidate.stress.filter((x) => x === 's').length;
  const heuristicCount = candidate.sources.filter((source) => source.startsWith('heuristic')).length;
  const irregularity = Math.abs(candidate.stress.length - stresses * 2);
  const penalty = 3 + irregularity * 0.6 + heuristicCount * 0.4;
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

function selectStanzaReadings(lines) {
  if (lines.length === 4) {
    return selectQuatrainReadings(lines);
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

function selectQuatrainReadings(lines) {
  const options = lines.map((line) => line.scans.slice(0, 8));
  let best = null;

  for (const first of options[0]) {
    for (const second of options[1]) {
      for (const third of options[2]) {
        for (const fourth of options[3]) {
          const combo = [first, second, third, fourth];
          const evaluation = scoreQuatrainCombo(combo);
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

function scoreQuatrainCombo(combo) {
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

  return {
    ...line,
    tag: rescored[0].meterLabel,
    confidence: rescored[0].confidence,
    scans: rescored
  };
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

function inferOverallMeter(lines, stanzaResults, meterTally) {
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

  return [...meterTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'accentual_loose';
}

function buildRhymeAnalysis(structure, lines) {
  const stanzaAnalyses = structure.stanzas.map((stanzaLines, stanzaIndex) => {
    return analyzeStanzaRhyme(stanzaLines, lines, stanzaIndex);
  });

  const lineDetails = stanzaAnalyses.flatMap((stanza) => stanza.lines);
  const detailByIndex = new Map(lineDetails.map((detail) => [detail.index, detail]));
  const annotatedLines = lines.map((line) => {
    if (line.blank) return line;
    const detail = detailByIndex.get(line.index);
    return {
      ...line,
      rhymeLetter: detail?.letter || '',
      rhymeWord: detail?.word || '',
      rhymeMatchType: detail?.matchType || ''
    };
  });

  return {
    annotatedLines,
    rhyme: {
      overallScheme: stanzaAnalyses.map((stanza) => stanza.scheme).join(' / '),
      stanzas: stanzaAnalyses,
      lines: lineDetails
    }
  };
}

function analyzeStanzaRhyme(stanzaLines, lines, stanzaIndex) {
  const groups = [];
  const details = stanzaLines.map((stanzaLine) => {
    const line = lines[stanzaLine.index];
    const profile = buildLineRhymeProfile(line);
    const match = findRhymeGroup(profile, groups);

    if (match) {
      match.group.perfectKeys.add(profile.perfectKey);
      match.group.tailKeys.add(profile.tailKey);
      match.group.orthographicTails.add(profile.orthographicTail);
    } else {
      groups.push({
        letter: indexToSchemeLabel(groups.length),
        perfectKeys: new Set(profile.perfectKey ? [profile.perfectKey] : []),
        tailKeys: new Set(profile.tailKey ? [profile.tailKey] : []),
        orthographicTails: new Set(profile.orthographicTail ? [profile.orthographicTail] : [])
      });
    }

    const group = match?.group || groups.at(-1);
    return {
      index: line.index,
      letter: group.letter,
      word: profile.word,
      matchType: match?.type || 'unique',
      pronunciation: profile.pronunciation,
      perfectKey: profile.perfectKey,
      tailKey: profile.tailKey
    };
  });

  return {
    stanzaIndex,
    lineIndexes: stanzaLines.map((line) => line.index),
    scheme: details.map((detail) => detail.letter).join(''),
    lines: details
  };
}

function buildLineRhymeProfile(line) {
  const token = line.tokens?.at(-1);
  const variant = line.scans?.[0]?.variants?.[line.tokens.length - 1];
  const word = token?.raw || '';
  const pronunciation = variant?.pronunciation || '';
  const phonemes = buildRhymePhonemes(variant);

  return {
    word,
    pronunciation,
    perfectKey: extractPerfectRhymeKey(phonemes),
    tailKey: extractTailRhymeKey(phonemes),
    orthographicTail: extractOrthographicTail(token?.normalized || '')
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

function extractOrthographicTail(word) {
  if (!word) return '';
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return '';
  const match = cleaned.match(/[aeiouy][a-z]*$/);
  return match ? match[0] : cleaned.slice(-3);
}

function findRhymeGroup(profile, groups) {
  if (!profile.perfectKey && !profile.tailKey && !profile.orthographicTail) return null;

  for (const group of groups) {
    if (profile.perfectKey && group.perfectKeys.has(profile.perfectKey)) {
      return { group, type: 'perfect' };
    }
  }

  for (const group of groups) {
    if (profile.tailKey && group.tailKeys.has(profile.tailKey)) {
      return { group, type: 'tail' };
    }
  }

  for (const group of groups) {
    if (profile.orthographicTail && group.orthographicTails.has(profile.orthographicTail)) {
      return { group, type: 'orthographic' };
    }
  }

  return null;
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
  return {
    ...line,
    tag: top.meterLabel,
    confidence: top.confidence,
    scans: rescored
  };
}

function buildDiagnostics(lines, stanzaResults) {
  const nonBlank = lines.filter((line) => !line.blank);
  const avgConfidence = nonBlank.length
    ? Math.round(nonBlank.reduce((sum, line) => sum + line.confidence, 0) / nonBlank.length)
    : 0;
  const fallbackWords = nonBlank.flatMap((line) => line.tokens).filter((token) => token.options.some((o) => o.source.startsWith('heuristic'))).map((t) => t.raw);
  return {
    averageLineConfidence: avgConfidence,
    stanzaCount: stanzaResults.length,
    lineCount: nonBlank.length,
    heuristicWords: [...new Set(fallbackWords)]
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
  return `${capitalize(analysis.overallMeter)} appears to govern the poem overall, with stanza-level agreement pushing the reading above line-by-line noise.${rhyme} The scan is strongest where multiple lines converge on the same stress architecture and weaker where lexical variants or extra unstressed syllables open alternate parses.${uncertain}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    }
  });
}
