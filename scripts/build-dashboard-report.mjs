import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION } from '../public/app-shared.js';
import { scanPoem } from '../netlify/functions/scan.js';
import { fetchUvaCorpus, normalizeStressPattern } from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(repoRoot, 'public', 'dashboard', 'report.json');
const DIFFICULTY_ORDER = ['WARMING UP', 'MOVING ALONG', 'SPECIAL CHALLENGE'];

export async function buildDashboardReport({
  limit = Infinity,
  cacheDir,
  writePath = DEFAULT_OUTPUT
} = {}) {
  const corpus = await fetchUvaCorpus({ limit, cacheDir });
  const lines = [];
  const poems = [];

  for (const poem of corpus.poems) {
    const analysis = scanPoem({
      poem: poem.poem,
      profileKey: poem.profileHint
    });
    const actualLines = analysis.lines.filter((line) => !line.blank);
    let passCount = 0;

    poem.lines.forEach((expectedLine, index) => {
      const actualLine = actualLines[index];
      const top = actualLine?.scans?.[0] || null;
      const canonicalStress = expectedLine.canonicalStressPattern || '';
      const actualStress = normalizeStressPattern(top?.surfaceStressPattern || top?.stressPattern || '');
      const surfaceStress = normalizeStressPattern(top?.surfaceStressPattern || '');
      const projectedStress = normalizeStressPattern(top?.stressPattern || '');
      const stressPass = canonicalStress ? canonicalStress === actualStress : true;
      const meterPass = expectedLine.meterKey ? expectedLine.meterKey === (top?.meterKey || '') : true;
      const pass = stressPass && meterPass;
      if (pass) {
        passCount += 1;
      }

      lines.push({
        id: `${poem.slug}:${expectedLine.lineNumber}`,
        slug: poem.slug,
        poemTitle: poem.title,
        author: poem.author,
        difficulty: poem.difficulty,
        type: poem.type,
        profileHint: poem.profileHint,
        lineNumber: expectedLine.lineNumber,
        text: expectedLine.text,
        pass,
        stressPass,
        meterPass,
        canonical: {
          source: expectedLine.canonicalStressSource,
          raw: expectedLine.canonicalStressRaw,
          stressPattern: canonicalStress,
          meterKey: expectedLine.meterKey,
          meterLabel: expectedLine.meterLabel,
          acceptedStressPatterns: expectedLine.acceptedStressPatterns,
          studentStressPatterns: expectedLine.studentStressPatterns,
          feetText: expectedLine.feetText,
          footTexts: expectedLine.footTexts
        },
        system: {
          meterKey: top?.meterKey || '',
          meterLabel: top?.meterLabel || '',
          stressPattern: actualStress,
          surfaceStressPattern: surfaceStress,
          projectedStressPattern: projectedStress,
          rawStressPattern: top?.stressPattern || '',
          rawSurfaceStressPattern: top?.surfaceStressPattern || '',
          displayGuide: top?.displayGuide || '',
          confidence: top?.confidence || 0,
          score: top?.score || 0,
          observations: top?.observations || []
        }
      });
    });

    poems.push({
      slug: poem.slug,
      poemTitle: poem.title,
      author: poem.author,
      difficulty: poem.difficulty,
      type: poem.type,
      profileHint: poem.profileHint,
      lineCount: poem.lines.length,
      passCount,
      failCount: poem.lines.length - passCount,
      passRate: ratio(passCount, poem.lines.length),
      overallMeter: analysis.overallMeter,
      perfect: passCount === poem.lines.length
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    source: corpus.source,
    sitemap: corpus.sitemap,
    corpusSize: corpus.count,
    lineCount: lines.length,
    summary: buildSummary(lines, poems),
    poems,
    lines
  };

  await fs.mkdir(path.dirname(writePath), { recursive: true });
  await fs.writeFile(writePath, JSON.stringify(report, null, 2), 'utf8');

  return {
    writePath,
    corpusSize: report.corpusSize,
    lineCount: report.lineCount,
    easyPassRate: report.summary.byDifficulty.find((entry) => entry.key === 'WARMING UP')?.passRate || 0
  };
}

function buildSummary(lines, poems) {
  const byDifficulty = DIFFICULTY_ORDER
    .map((key) => {
      const difficultyLines = lines.filter((line) => line.difficulty === key);
      const difficultyPoems = poems.filter((poem) => poem.difficulty === key);
      const passLines = difficultyLines.filter((line) => line.pass).length;
      const perfectPoems = difficultyPoems.filter((poem) => poem.perfect).length;

      return {
        key,
        poems: difficultyPoems.length,
        perfectPoems,
        lines: difficultyLines.length,
        passLines,
        failLines: difficultyLines.length - passLines,
        passRate: ratio(passLines, difficultyLines.length)
      };
    })
    .filter((entry) => entry.lines > 0);

  const overallPassLines = lines.filter((line) => line.pass).length;
  const overallPerfectPoems = poems.filter((poem) => poem.perfect).length;

  return {
    overall: {
      poems: poems.length,
      perfectPoems: overallPerfectPoems,
      lines: lines.length,
      passLines: overallPassLines,
      failLines: lines.length - overallPassLines,
      passRate: ratio(overallPassLines, lines.length)
    },
    byDifficulty
  };
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

  const result = await buildDashboardReport({
    limit: limitFlag ? Number(limitFlag.split('=')[1]) : Infinity,
    cacheDir: cacheFlag ? path.resolve(repoRoot, cacheFlag.split('=')[1]) : undefined,
    writePath: writeFlag ? path.resolve(repoRoot, writeFlag.split('=')[1]) : DEFAULT_OUTPUT
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
