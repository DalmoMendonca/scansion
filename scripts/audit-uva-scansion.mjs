import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPoem } from '../netlify/functions/scan.js';
import { fetchUvaCorpus, normalizeStressPattern } from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(repoRoot, 'artifacts', 'uva-scansion-audit.json');

export async function auditUvaScansion({
  rounds = 1,
  limit = Infinity,
  cacheDir,
  writePath = DEFAULT_OUTPUT,
  requirePerfect = true
} = {}) {
  const corpus = await fetchUvaCorpus({ limit, cacheDir });
  const roundReports = [];

  for (let round = 1; round <= rounds; round += 1) {
    roundReports.push(runAuditRound(corpus, round));
  }

  const baseline = roundReports[0];
  const consistent = roundReports.every((report) => report.signature === baseline.signature);
  const finalReport = {
    generatedAt: new Date().toISOString(),
    rounds,
    consistent,
    corpusSize: corpus.count,
    lineCount: baseline.summary.lineCount,
    summary: baseline.summary,
    nativeSummary: baseline.nativeSummary,
    rootCauses: baseline.rootCauses,
    resolutionModes: baseline.resolutionModes,
    failures: baseline.failures,
    nativeFailures: baseline.nativeFailures,
    roundSignatures: roundReports.map((report) => ({
      round: report.round,
      signature: report.signature
    }))
  };

  await fs.mkdir(path.dirname(writePath), { recursive: true });
  await fs.writeFile(writePath, JSON.stringify(finalReport, null, 2), 'utf8');

  if (requirePerfect && (!consistent || finalReport.summary.exactTopLineRate < 1 || finalReport.summary.scansionPoemPassRate < 1)) {
    const error = new Error('UVA scansion audit failed.');
    error.report = finalReport;
    throw error;
  }

  return finalReport;
}

function runAuditRound(corpus, round) {
  const failures = [];
  const nativeFailures = [];
  const resolutionModes = new Map();
  const rootCauses = new Map();

  let lineCount = 0;
  let exactTopCount = 0;
  let scansionPoemPassCount = 0;
  let nativeExactTopCount = 0;
  let nativeScansionPoemPassCount = 0;

  for (const poem of corpus.poems) {
    const corrected = scanPoem({
      poem: poem.poem,
      profileKey: poem.profileHint
    });
    const native = scanPoem({
      poem: poem.poem,
      profileKey: poem.profileHint,
      disableUvaReference: true
    });

    const correctedLines = corrected.lines.filter((line) => !line.blank);
    const nativeLines = native.lines.filter((line) => !line.blank);
    let poemPass = true;
    let nativePoemPass = true;

    poem.lines.forEach((expected, index) => {
      lineCount += 1;
      const correctedLine = correctedLines[index];
      const nativeLine = nativeLines[index];
      const expectedStress = expected.canonicalStressPattern || expected.studentStressPatterns[0] || '';
      const expectedMeter = expected.meterKey || '';

      const correctedTop = correctedLine?.scans?.[0] || null;
      const nativeTop = nativeLine?.scans?.[0] || null;
      const correctedPass = isExactMatch(correctedTop, expectedStress, expectedMeter);
      const nativePass = isExactMatch(nativeTop, expectedStress, expectedMeter);

      if (correctedPass) {
        exactTopCount += 1;
      } else {
        poemPass = false;
        failures.push(buildFailureRecord(poem, expected, correctedLine, expectedStress, expectedMeter));
      }

      if (nativePass) {
        nativeExactTopCount += 1;
      } else {
        nativePoemPass = false;
        const failure = buildFailureRecord(poem, expected, nativeLine, expectedStress, expectedMeter);
        const correctedMode = classifyResolutionMode(correctedLine, expectedStress, expectedMeter);
        const rootCause = classifyRootCause(nativeLine, expectedStress, expectedMeter);
        incrementMap(rootCauses, rootCause);
        incrementMap(resolutionModes, correctedMode);
        nativeFailures.push({
          ...failure,
          rootCause,
          resolutionMode: correctedMode
        });
      }
    });

    if (poemPass) {
      scansionPoemPassCount += 1;
    }
    if (nativePoemPass) {
      nativeScansionPoemPassCount += 1;
    }
  }

  const signature = JSON.stringify({
    lineCount,
    exactTopCount,
    scansionPoemPassCount,
    failures,
    nativeFailures
  });

  return {
    round,
    signature,
    summary: {
      lineCount,
      exactTopCount,
      exactTopLineRate: ratio(exactTopCount, lineCount),
      scansionPoems: corpus.count,
      scansionPoemPassCount,
      scansionPoemPassRate: ratio(scansionPoemPassCount, corpus.count)
    },
    nativeSummary: {
      lineCount,
      exactTopCount: nativeExactTopCount,
      exactTopLineRate: ratio(nativeExactTopCount, lineCount),
      scansionPoems: corpus.count,
      scansionPoemPassCount: nativeScansionPoemPassCount,
      scansionPoemPassRate: ratio(nativeScansionPoemPassCount, corpus.count)
    },
    rootCauses: mapToSortedArray(rootCauses, 'rootCause'),
    resolutionModes: mapToSortedArray(resolutionModes, 'resolutionMode'),
    failures,
    nativeFailures
  };
}

function buildFailureRecord(poem, expected, line, expectedStress, expectedMeter) {
  const top = line?.scans?.[0] || null;
  return {
    slug: poem.slug,
    poemTitle: poem.title,
    author: poem.author,
    difficulty: poem.difficulty,
    lineNumber: expected.lineNumber,
    text: expected.text,
    expectedStress,
    actualStress: normalizeStressPattern(top?.surfaceStressPattern || top?.stressPattern || ''),
    expectedMeter,
    actualMeter: top?.meterKey || '',
    observations: top?.observations || []
  };
}

function classifyResolutionMode(line, expectedStress, expectedMeter) {
  const top = line?.scans?.[0] || null;
  const observations = top?.observations || [];
  const usedReference = observations.some((note) => note.startsWith('UVA reference') || note.startsWith('UVA easy reference'));
  if (!usedReference) {
    return 'native';
  }

  const exactAlternate = (line?.scans || []).slice(1).some((scan) => isExactMatch(scan, expectedStress, expectedMeter));
  return exactAlternate ? 'reference-promoted' : 'reference-synthetic';
}

function classifyRootCause(line, expectedStress, expectedMeter) {
  const top = line?.scans?.[0] || null;
  const actualStress = normalizeStressPattern(top?.surfaceStressPattern || top?.stressPattern || '');
  const actualMeter = top?.meterKey || '';
  const exactInCandidates = (line?.scans || []).some((scan) => isExactMatch(scan, expectedStress, expectedMeter));
  const expectedFamily = meterFamily(expectedMeter);
  const actualFamily = meterFamily(actualMeter);
  const expectedFeet = meterFeet(expectedMeter);
  const actualFeet = meterFeet(actualMeter);

  if (exactInCandidates) {
    return 'exact-candidate-not-top';
  }
  if (!actualMeter || !actualStress) {
    return 'missing-meter-or-stress';
  }
  if (expectedMeter && actualMeter !== expectedMeter && expectedFamily && actualFamily && expectedFamily !== actualFamily) {
    return 'meter-family-drift';
  }
  if (expectedMeter && actualMeter !== expectedMeter && expectedFeet && actualFeet && expectedFamily === actualFamily) {
    return 'foot-count-drift';
  }
  if (expectedMeter && actualMeter !== expectedMeter) {
    return 'meter-mismatch';
  }
  if (expectedStress && actualStress !== expectedStress) {
    return 'stress-mismatch-same-meter';
  }
  return 'unclassified';
}

function isExactMatch(scan, expectedStress, expectedMeter) {
  if (!scan) {
    return false;
  }
  const stressMatch = !expectedStress || normalizeStressPattern(scan.surfaceStressPattern || scan.stressPattern || '') === expectedStress;
  const meterMatch = !expectedMeter || scan.meterKey === expectedMeter;
  return stressMatch && meterMatch;
}

function meterFamily(meterKey) {
  return String(meterKey || '').split('_')[0] || '';
}

function meterFeet(meterKey) {
  return String(meterKey || '').split('_').slice(1).join('_');
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function mapToSortedArray(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({
      [keyName]: key,
      count
    }))
    .sort((left, right) => right.count - left.count || String(left[keyName]).localeCompare(String(right[keyName])));
}

function ratio(part, total) {
  if (!total) {
    return 0;
  }
  return Number((part / total).toFixed(4));
}

async function main() {
  const args = process.argv.slice(2);
  const limitFlag = args.find((arg) => arg.startsWith('--limit='));
  const cacheFlag = args.find((arg) => arg.startsWith('--cache-dir='));
  const writeFlag = args.find((arg) => arg.startsWith('--write='));
  const roundsFlag = args.find((arg) => arg.startsWith('--rounds='));
  const noRequirePerfect = args.includes('--allow-failures');

  const report = await auditUvaScansion({
    limit: limitFlag ? Number(limitFlag.split('=')[1]) : Infinity,
    cacheDir: cacheFlag ? path.resolve(repoRoot, cacheFlag.split('=')[1]) : undefined,
    writePath: writeFlag ? path.resolve(repoRoot, writeFlag.split('=')[1]) : DEFAULT_OUTPUT,
    rounds: roundsFlag ? Number(roundsFlag.split('=')[1]) : 1,
    requirePerfect: !noRequirePerfect
  });

  console.log(JSON.stringify({
    writePath: writeFlag ? path.resolve(repoRoot, writeFlag.split('=')[1]) : DEFAULT_OUTPUT,
    consistent: report.consistent,
    summary: report.summary,
    nativeSummary: report.nativeSummary,
    rootCauses: report.rootCauses,
    resolutionModes: report.resolutionModes
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.report ? JSON.stringify(error.report, null, 2) : error);
    process.exitCode = 1;
  });
}
