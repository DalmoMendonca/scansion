import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION } from '../public/app-shared.js';
import { scanPoem, scanPoemWithAssistant } from '../netlify/functions/scan.js';
import {
  canonicalizeRhymeScheme,
  fetchUvaCorpus,
  normalizeStressPattern
} from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PROFILE_KEYS = ['modern', 'early_modern', 'hymn'];

export async function runUvaBenchmarks({
  limit = Infinity,
  cacheDir,
  includeProfiles = PROFILE_KEYS,
  assisted = false,
  assistantCacheDir = path.resolve(repoRoot, '.cache', 'assistant-scans')
} = {}) {
  const corpus = await fetchUvaCorpus({ limit, cacheDir });
  const poems = [];
  for (const poem of corpus.poems) {
    poems.push(await evaluatePoemAgainstProfiles(poem, includeProfiles, { assisted, assistantCacheDir }));
  }

  return {
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    source: corpus.source,
    sitemap: corpus.sitemap,
    corpusSize: corpus.count,
    assisted,
    summary: {
      hinted: buildModeSummary(poems, 'hinted'),
      best: buildModeSummary(poems, 'best')
    },
    profileWins: summarizeProfileWins(poems),
    poems
  };
}

async function evaluatePoemAgainstProfiles(poem, includeProfiles, options) {
  const uniqueProfiles = options?.assisted
    ? [poem.profileHint]
    : [...new Set([poem.profileHint, ...includeProfiles].filter(Boolean))];
  const evaluations = [];
  for (const profile of uniqueProfiles) {
    evaluations.push(await evaluatePoem(poem, profile, options));
  }
  const hinted = evaluations.find((entry) => entry.profile === poem.profileHint) || evaluations[0];
  const best = [...evaluations].sort(compareEvaluations)[0];

  return {
    slug: poem.slug,
    sourceUrl: poem.sourceUrl,
    title: poem.title,
    author: poem.author,
    year: poem.year,
    difficulty: poem.difficulty,
    type: poem.type,
    profileHint: poem.profileHint,
    expected: {
      rhymeScheme: poem.rhymeSchemeCanonical,
      lineCount: poem.lines.length
    },
    hinted,
    best,
    evaluations
  };
}

async function evaluatePoem(poem, profile, options = {}) {
  const analysis = options.assisted
    ? await scanPoemWithAssistant({
        poem: poem.poem,
        profileKey: profile,
        cacheDir: options.assistantCacheDir,
        cacheKey: `${poem.slug}:${profile}`
      })
    : scanPoem({
        poem: poem.poem,
        profileKey: profile
      });
  const actualLines = analysis.lines.filter((line) => !line.blank);
  const lineChecks = poem.lines.map((expectedLine, index) => {
    const actualLine = actualLines[index];
    const scans = actualLine?.scans || [];
    const top = scans[0] || null;
    const topStress = normalizeStressPattern(top?.surfaceStressPattern || top?.stressPattern || '');
    const canonical = expectedLine.canonicalStressPattern || '';
    const student = expectedLine.studentStressPatterns || [];
    const accepted = expectedLine.acceptedStressPatterns || [];
    const expectedMeter = expectedLine.meterKey || '';
    const canonicalStressTopPass = canonical ? canonical === topStress : true;
    const studentStressTopPass = student.length ? student.includes(topStress) : false;
    const acceptedStressTopPass = accepted.length ? accepted.includes(topStress) : canonicalStressTopPass;
    const topMeterPass = expectedMeter ? expectedMeter === (top?.meterKey || '') : true;
    const anyExactPass = scans.some((scan) => {
      const candidateStress = normalizeStressPattern(scan.surfaceStressPattern || scan.stressPattern || '');
      const stressPass = canonical ? candidateStress === canonical : true;
      const meterPass = expectedMeter ? expectedMeter === (scan.meterKey || '') : true;
      return stressPass && meterPass;
    });
    const anyAcceptedPass = scans.some((scan) => {
      const candidateStress = normalizeStressPattern(scan.surfaceStressPattern || scan.stressPattern || '');
      const stressPass = accepted.length ? accepted.includes(candidateStress) : canonical ? candidateStress === canonical : true;
      const meterPass = expectedMeter ? expectedMeter === (scan.meterKey || '') : true;
      return stressPass && meterPass;
    });
    const anyStudentPass = scans.some((scan) => {
      const candidateStress = normalizeStressPattern(scan.surfaceStressPattern || scan.stressPattern || '');
      const stressPass = student.length ? student.includes(candidateStress) : false;
      const meterPass = expectedMeter ? expectedMeter === (scan.meterKey || '') : true;
      return stressPass && meterPass;
    });

    return {
      line: index + 1,
      text: expectedLine.text,
      expectedCanonicalStress: canonical,
      expectedStudentStress: student,
      expectedAcceptedStress: accepted,
      expectedMeter,
      actualStress: topStress,
      actualMeter: top?.meterKey || '',
      exactTopPass: canonicalStressTopPass && topMeterPass,
      canonicalStressTopPass,
      studentStressTopPass,
      acceptedStressTopPass,
      meterTopPass: topMeterPass,
      anyExactPass,
      anyAcceptedPass,
      anyStudentPass
    };
  });

  const expectedRhyme = poem.rhymeSchemeCanonical || '';
  const actualRhyme = canonicalizeRhymeScheme(analysis.rhyme?.globalScheme || analysis.rhyme?.overallScheme || '');
  const rhymePass = expectedRhyme ? actualRhyme === expectedRhyme : null;

  const exactTopCount = lineChecks.filter((line) => line.exactTopPass).length;
  const canonicalStressTopCount = lineChecks.filter((line) => line.canonicalStressTopPass).length;
  const studentStressTopCount = lineChecks.filter((line) => line.studentStressTopPass).length;
  const acceptedStressTopCount = lineChecks.filter((line) => line.acceptedStressTopPass).length;
  const meterTopCount = lineChecks.filter((line) => line.meterTopPass).length;
  const anyExactCount = lineChecks.filter((line) => line.anyExactPass).length;
  const anyAcceptedCount = lineChecks.filter((line) => line.anyAcceptedPass).length;
  const anyStudentCount = lineChecks.filter((line) => line.anyStudentPass).length;
  const scansionPass = exactTopCount === lineChecks.length;
  const pass = scansionPass && (rhymePass !== false);

  return {
    profile,
    analysis: {
      overallMeter: analysis.overallMeter,
      form: analysis.form?.primary?.key || '',
      rhymeScheme: actualRhyme
    },
    metrics: {
      lineCount: lineChecks.length,
      exactTopCount,
      canonicalStressTopCount,
      studentStressTopCount,
      acceptedStressTopCount,
      meterTopCount,
      anyExactCount,
      anyAcceptedCount,
      anyStudentCount,
      exactTopRate: ratio(exactTopCount, lineChecks.length),
      canonicalStressTopRate: ratio(canonicalStressTopCount, lineChecks.length),
      studentStressTopRate: ratio(studentStressTopCount, lineChecks.length),
      acceptedStressTopRate: ratio(acceptedStressTopCount, lineChecks.length),
      meterTopRate: ratio(meterTopCount, lineChecks.length),
      anyExactRate: ratio(anyExactCount, lineChecks.length),
      anyAcceptedRate: ratio(anyAcceptedCount, lineChecks.length),
      anyStudentRate: ratio(anyStudentCount, lineChecks.length),
      rhymePass
    },
    scansionPass,
    pass,
    mismatches: lineChecks.filter((line) => !line.exactTopPass),
    lineChecks
  };
}

function compareEvaluations(left, right) {
  return (
    right.metrics.exactTopCount - left.metrics.exactTopCount ||
    right.metrics.anyAcceptedCount - left.metrics.anyAcceptedCount ||
    right.metrics.anyExactCount - left.metrics.anyExactCount ||
    right.metrics.meterTopCount - left.metrics.meterTopCount ||
    Number(Boolean(right.metrics.rhymePass)) - Number(Boolean(left.metrics.rhymePass)) ||
    left.metrics.lineCount - right.metrics.lineCount ||
    left.profile.localeCompare(right.profile)
  );
}

function buildModeSummary(poems, key) {
  const evaluations = poems.map((poem) => poem[key]).filter(Boolean);
  const poemPasses = evaluations.filter((entry) => entry.pass).length;
  const scansionPoemPasses = evaluations.filter((entry) => entry.scansionPass).length;
  const lineTotal = evaluations.reduce((sum, entry) => sum + entry.metrics.lineCount, 0);
  const exactTop = evaluations.reduce((sum, entry) => sum + entry.metrics.exactTopCount, 0);
  const canonicalStressTop = evaluations.reduce((sum, entry) => sum + entry.metrics.canonicalStressTopCount, 0);
  const studentStressTop = evaluations.reduce((sum, entry) => sum + entry.metrics.studentStressTopCount, 0);
  const acceptedStressTop = evaluations.reduce((sum, entry) => sum + entry.metrics.acceptedStressTopCount, 0);
  const meterTop = evaluations.reduce((sum, entry) => sum + entry.metrics.meterTopCount, 0);
  const anyExact = evaluations.reduce((sum, entry) => sum + entry.metrics.anyExactCount, 0);
  const anyAccepted = evaluations.reduce((sum, entry) => sum + entry.metrics.anyAcceptedCount, 0);
  const anyStudent = evaluations.reduce((sum, entry) => sum + entry.metrics.anyStudentCount, 0);
  const rhymed = evaluations.filter((entry) => entry.metrics.rhymePass !== null);
  const rhymePasses = rhymed.filter((entry) => entry.metrics.rhymePass).length;

  return {
    poems: evaluations.length,
    scansionPoemPassRate: ratio(scansionPoemPasses, evaluations.length),
    poemPassRate: ratio(poemPasses, evaluations.length),
    exactTopLineRate: ratio(exactTop, lineTotal),
    canonicalStressTopLineRate: ratio(canonicalStressTop, lineTotal),
    studentStressTopLineRate: ratio(studentStressTop, lineTotal),
    acceptedStressTopLineRate: ratio(acceptedStressTop, lineTotal),
    meterTopLineRate: ratio(meterTop, lineTotal),
    anyExactLineRate: ratio(anyExact, lineTotal),
    anyAcceptedLineRate: ratio(anyAccepted, lineTotal),
    anyStudentLineRate: ratio(anyStudent, lineTotal),
    rhymePassRate: ratio(rhymePasses, rhymed.length),
    failingPoems: evaluations
      .filter((entry) => !entry.pass)
      .sort((left, right) => right.mismatches.length - left.mismatches.length)
      .slice(0, 20)
      .map((entry) => ({
        title: poems.find((poem) => poem[key] === entry)?.title || '',
        author: poems.find((poem) => poem[key] === entry)?.author || '',
        profile: entry.profile,
        mismatches: entry.mismatches.length,
        scansionPass: entry.scansionPass,
        rhymePass: entry.metrics.rhymePass
      }))
  };
}

function summarizeProfileWins(poems) {
  const wins = new Map();
  for (const poem of poems) {
    const profile = poem.best?.profile || '';
    wins.set(profile, (wins.get(profile) || 0) + 1);
  }
  return [...wins.entries()]
    .map(([profile, count]) => ({ profile, count }))
    .sort((left, right) => right.count - left.count || left.profile.localeCompare(right.profile));
}

function ratio(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(4));
}

async function main() {
  const args = process.argv.slice(2);
  const limitFlag = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitFlag ? Number(limitFlag.split('=')[1]) : Infinity;
  const writeFlag = args.find((arg) => arg.startsWith('--write='));
  const outputPath = writeFlag ? path.resolve(repoRoot, writeFlag.split('=')[1]) : '';
  const assisted = args.includes('--assisted');

  const report = await runUvaBenchmarks({ limit, assisted });
  console.log(JSON.stringify(report, null, 2));

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  }

  if (report.summary.hinted.poemPassRate < 1 || report.summary.best.poemPassRate < 1) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
