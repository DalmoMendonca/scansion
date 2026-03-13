import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPoem } from '../netlify/functions/scan.js';
import { fetchUvaCorpus, normalizeStressPattern } from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const writeFlag = args.find((arg) => arg.startsWith('--write='));
  const outputPath = path.resolve(repoRoot, writeFlag?.split('=')[1] || 'artifacts/reranker-candidates.jsonl');
  const limitFlag = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitFlag ? Number(limitFlag.split('=')[1]) : Infinity;

  const corpus = await fetchUvaCorpus({ limit });
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const stream = fs.createWriteStream(outputPath);
  let rows = 0;

  for (let poemIndex = 0; poemIndex < corpus.poems.length; poemIndex += 1) {
    const poem = corpus.poems[poemIndex];
    const analysis = scanPoem({
      poem: poem.poem,
      profileKey: poem.profileHint,
      disableUvaReference: true
    });
    const lines = analysis.lines.filter((line) => !line.blank);

    for (let lineIndex = 0; lineIndex < poem.lines.length; lineIndex += 1) {
      const expected = poem.lines[lineIndex];
      const line = lines[lineIndex];
      for (let candidateIndex = 0; candidateIndex < line.scans.length; candidateIndex += 1) {
        const scan = line.scans[candidateIndex];
        const stressPattern = normalizeStressPattern(scan.surfaceStressPattern || scan.stressPattern || '');
        const projectedStressPattern = normalizeStressPattern(scan.stressPattern || '');
        const canonicalStress = expected.canonicalStressPattern || '';
        const studentStress = expected.studentStressPatterns || [];
        const acceptedStress = expected.acceptedStressPatterns || [];
        const meterMatch = scan.meterKey === expected.meterKey;
        const canonicalLabel = Boolean(canonicalStress && stressPattern === canonicalStress && meterMatch);
        const studentLabel = Boolean(studentStress.includes(stressPattern) && meterMatch);
        const acceptedLabel = Boolean(acceptedStress.includes(stressPattern) && meterMatch);
        const label = canonicalLabel ? 1 : 0;

        stream.write(
          JSON.stringify({
            poemIndex,
            poemSlug: poem.slug,
            title: poem.title,
            profile: poem.profileHint,
            lineIndex,
            lineNumber: lineIndex + 1,
            candidateIndex,
            label,
            labelCanonical: canonicalLabel ? 1 : 0,
            labelStudent: studentLabel ? 1 : 0,
            labelAccepted: acceptedLabel ? 1 : 0,
            expectedMeter: expected.meterKey,
            expectedCanonicalStress: canonicalStress,
            expectedStudentStress: studentStress,
            expectedAcceptedStress: acceptedStress,
            meterKey: scan.meterKey,
            confidence: scan.confidence,
            score: scan.score,
            beamScore: scan.beamScore ?? scan.rerankerBeamScore ?? 0,
            origin: scan.origin || scan.candidate?.origin || '',
            patternSubstitutions: scan.patternSubstitutions ?? scan.candidate?.patternSubstitutions ?? 0,
            syllableCount: scan.syllableCount,
            stressPattern,
            projectedStressPattern,
            targetPattern: normalizeStressPattern(scan.targetPattern || ''),
            observations: scan.observations || [],
            sources: (scan.variants || []).map((variant) => variant.source),
            pieceStress: (scan.variants || []).map((variant) => variant.stress),
            tokenNormalized: (line.tokens || []).map((token) => token.normalized || ''),
            tokenIsFunction: (line.tokens || []).map((token) => Boolean(token.isFunctionWord)),
            lineTokenCount: (line.tokens || []).length
          }) + '\n'
        );
        rows += 1;
      }
    }
  }

  stream.end();
  await new Promise((resolve) => stream.on('finish', resolve));
  console.log(JSON.stringify({ outputPath, rows }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
