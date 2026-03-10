import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchUvaCorpus } from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const limitFlag = args.find((arg) => arg.startsWith('--limit='));
  const writeFlag = args.find((arg) => arg.startsWith('--write='));
  const cacheFlag = args.find((arg) => arg.startsWith('--cache-dir='));

  const limit = limitFlag ? Number(limitFlag.split('=')[1]) : Infinity;
  const outputPath = path.resolve(repoRoot, writeFlag?.split('=')[1] || 'artifacts/uva-rubric.json');
  const cacheDir = cacheFlag ? path.resolve(repoRoot, cacheFlag.split('=')[1]) : undefined;

  const corpus = await fetchUvaCorpus({ limit, cacheDir });
  const lineCount = corpus.poems.reduce((sum, poem) => sum + poem.lines.length, 0);
  const syllableCount = corpus.poems.reduce(
    (sum, poem) => sum + poem.lines.reduce((lineSum, line) => lineSum + (line.syllableCount || 0), 0),
    0
  );

  const rubric = {
    generatedAt: new Date().toISOString(),
    source: corpus.source,
    sitemap: corpus.sitemap,
    corpusSize: corpus.count,
    lineCount,
    syllableCount,
    poems: corpus.poems
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(rubric, null, 2));

  console.log(JSON.stringify({
    outputPath,
    corpusSize: rubric.corpusSize,
    lineCount: rubric.lineCount,
    syllableCount: rubric.syllableCount
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
