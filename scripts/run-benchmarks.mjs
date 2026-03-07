import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BENCHMARK_CORPUS } from '../benchmarks/corpus.mjs';
import { APP_VERSION } from '../public/app-shared.js';
import { scanPoem } from '../netlify/functions/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export async function runBenchmarkRounds({ rounds = 3 } = {}) {
  const roundResults = [];
  for (let round = 1; round <= rounds; round += 1) {
    roundResults.push(runSingleRound(round));
  }

  const finalRound = roundResults.at(-1);
  const report = buildReport(roundResults, finalRound);
  return report;
}

function runSingleRound(round) {
  const poems = BENCHMARK_CORPUS.map((entry) => evaluateBenchmarkPoem(entry));
  const poemPasses = poems.filter((poem) => poem.pass).length;
  const lineTotals = poems.reduce((sum, poem) => sum + poem.lineAccuracy.total, 0);
  const lineCorrect = poems.reduce((sum, poem) => sum + poem.lineAccuracy.correct, 0);

  return {
    round,
    poemPassRate: ratio(poemPasses, poems.length),
    lineAccuracy: ratio(lineCorrect, lineTotals),
    poems
  };
}

function evaluateBenchmarkPoem(entry) {
  const analysis = scanPoem({
    poem: entry.poem,
    profileKey: entry.profile
  });

  const lines = analysis.lines.filter((line) => !line.blank);
  const lineChecks = lines.map((line, index) => {
    const expectedMeter = entry.expected.lineMeters?.[index] || '';
    const actualMeter = line.scans?.[0]?.meterKey || '';
    const combinedConfidence = Math.round((clampPercent(line.scans?.[0]?.score) * clampPercent(line.confidence ?? line.scans?.[0]?.confidence)) / 100);
    return {
      line: index + 1,
      text: line.text,
      expectedMeter,
      actualMeter,
      pass: !expectedMeter || expectedMeter === actualMeter,
      confidence: combinedConfidence
    };
  });

  const actualStanzaPatterns = (analysis.rhyme?.stanzas || []).map((stanza) => normalizeSchemePattern(stanza.scheme));
  const checks = {
    overallMeter: {
      expected: entry.expected.overallMeter,
      actual: analysis.overallMeter,
      pass: analysis.overallMeter === entry.expected.overallMeter
    },
    form: {
      expected: entry.expected.form,
      actual: analysis.form?.primary?.key || '',
      pass: (analysis.form?.primary?.key || '') === entry.expected.form
    },
    rhyme: {
      expected: entry.expected.rhymeScheme || entry.expected.stanzaSchemePatterns || [],
      actual: entry.expected.rhymeScheme ? analysis.rhyme?.overallScheme || '' : actualStanzaPatterns,
      pass: entry.expected.rhymeScheme
        ? (analysis.rhyme?.overallScheme || '') === entry.expected.rhymeScheme
        : JSON.stringify(actualStanzaPatterns) === JSON.stringify(entry.expected.stanzaSchemePatterns || [])
    },
    lineMeters: {
      expected: entry.expected.lineMeters.length,
      actual: lineChecks.filter((line) => line.pass).length,
      pass: lineChecks.every((line) => line.pass)
    }
  };

  const pass = Object.values(checks).every((check) => check.pass);
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author,
    profile: entry.profile,
    meterFamily: entry.meterFamily,
    formFamily: entry.formFamily,
    ambiguityTypes: entry.ambiguityTypes,
    sourceTruth: entry.sourceTruth,
    analysis: {
      overallMeter: analysis.overallMeter,
      form: analysis.form?.primary?.key || '',
      rhymeScheme: analysis.rhyme?.overallScheme || '',
      stanzaSchemePatterns: actualStanzaPatterns
    },
    checks,
    lineAccuracy: {
      total: lineChecks.length,
      correct: lineChecks.filter((line) => line.pass).length
    },
    lineChecks,
    pass
  };
}

function buildReport(roundResults, finalRound) {
  const baseline = finalRound.poems;
  const roundSummaries = roundResults.map((round) => ({
    round: round.round,
    poemPassRate: round.poemPassRate,
    lineAccuracy: round.lineAccuracy
  }));

  const consistency = baseline.map((poem) => {
    const fingerprints = roundResults.map((round) => {
      const result = round.poems.find((entry) => entry.id === poem.id);
      return JSON.stringify(result?.checks || {});
    });
    return {
      id: poem.id,
      stable: new Set(fingerprints).size === 1
    };
  });

  const lineCalibration = [];
  for (const poem of baseline) {
    for (const line of poem.lineChecks) {
      lineCalibration.push({
        confidence: line.confidence,
        pass: line.pass
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    rounds: roundResults.length,
    summary: {
      corpusSize: baseline.length,
      poemPassRate: ratio(baseline.filter((poem) => poem.pass).length, baseline.length),
      lineAccuracy: ratio(
        baseline.reduce((sum, poem) => sum + poem.lineAccuracy.correct, 0),
        baseline.reduce((sum, poem) => sum + poem.lineAccuracy.total, 0)
      ),
      stablePoems: consistency.filter((entry) => entry.stable).length,
      unstablePoems: consistency.filter((entry) => !entry.stable).map((entry) => entry.id)
    },
    roundSummaries,
    byPoet: aggregatePoemMetrics(baseline, (poem) => poem.author),
    byForm: aggregatePoemMetrics(baseline, (poem) => poem.formFamily),
    byMeterFamily: aggregatePoemMetrics(baseline, (poem) => poem.meterFamily),
    byAmbiguityType: aggregatePoemMetrics(
      baseline.flatMap((poem) => poem.ambiguityTypes.map((type) => ({ ...poem, aggregateKey: type }))),
      (poem) => poem.aggregateKey
    ),
    confidenceCalibration: buildCalibrationBins(lineCalibration),
    poems: baseline.map((poem) => ({
      ...poem,
      stable: consistency.find((entry) => entry.id === poem.id)?.stable ?? true
    }))
  };
}

function aggregatePoemMetrics(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        poems: 0,
        poemPasses: 0,
        lineCorrect: 0,
        lineTotal: 0
      });
    }
    const bucket = groups.get(key);
    bucket.poems += 1;
    bucket.poemPasses += item.pass ? 1 : 0;
    bucket.lineCorrect += item.lineAccuracy.correct;
    bucket.lineTotal += item.lineAccuracy.total;
  }

  return [...groups.values()].map((group) => ({
    key: group.key,
    poems: group.poems,
    poemPassRate: ratio(group.poemPasses, group.poems),
    lineAccuracy: ratio(group.lineCorrect, group.lineTotal)
  })).sort((left, right) => right.poemPassRate - left.poemPassRate || right.lineAccuracy - left.lineAccuracy);
}

function buildCalibrationBins(lines) {
  const bins = new Map();
  for (let lower = 0; lower <= 90; lower += 10) {
    bins.set(lower, {
      range: `${lower}-${lower + 9}`,
      count: 0,
      correct: 0
    });
  }

  for (const line of lines) {
    const lower = Math.min(90, Math.floor(line.confidence / 10) * 10);
    const bucket = bins.get(lower);
    bucket.count += 1;
    bucket.correct += line.pass ? 1 : 0;
  }

  return [...bins.values()].map((bucket) => ({
    range: bucket.range,
    count: bucket.count,
    accuracy: ratio(bucket.correct, bucket.count)
  })).filter((bucket) => bucket.count > 0);
}

function normalizeSchemePattern(scheme) {
  const map = new Map();
  let next = 65;
  return String(scheme || '').split('').map((letter) => {
    if (!map.has(letter)) {
      map.set(letter, String.fromCharCode(next));
      next += 1;
    }
    return map.get(letter);
  }).join('');
}

function ratio(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(4));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

async function main() {
  const args = process.argv.slice(2);
  const roundsFlag = args.find((arg) => arg.startsWith('--rounds='));
  const rounds = roundsFlag ? Number(roundsFlag.split('=')[1]) : 3;
  const writeFlag = args.find((arg) => arg.startsWith('--write='));
  const outputPath = writeFlag ? path.resolve(repoRoot, writeFlag.split('=')[1]) : '';

  const report = await runBenchmarkRounds({ rounds });
  console.log(JSON.stringify(report, null, 2));

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  }

  if (report.summary.unstablePoems.length || report.poems.some((poem) => !poem.pass)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
