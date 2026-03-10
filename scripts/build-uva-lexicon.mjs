import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLineSyllables, fetchUvaCorpus } from './lib/uva-prosody.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cacheRoot = path.resolve(repoRoot, '.cache', 'uva-prosody');

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

async function main() {
  const corpus = await fetchUvaCorpus({ cacheDir: cacheRoot });
  const lexicon = {};
  let assignedWords = 0;
  let failedLines = 0;

  for (const poem of corpus.poems) {
    const htmlPath = path.join(cacheRoot, `${poem.slug}.html`);
    const html = await fs.readFile(htmlPath, 'utf8');
    const lineBlocks = [...html.matchAll(/<div class="TEI-l" id="prosody-real-(\d+)"([^>]*)>([\s\S]*?)<\/div><div class="buttons">/g)];

    for (const match of lineBlocks) {
      const lineIndex = Number(match[1]) - 1;
      const attrs = match[2] || '';
      const body = match[3] || '';
      const rawStress = attributeValue(attrs, 'data-real');
      const line = poem.lines[lineIndex];
      if (!line || !rawStress) continue;

      const patterns = rawStress
        .split('|')
        .map((pattern) => pattern.replace(/\+/g, 's').replace(/-/g, 'u').replace(/[^su]/g, ''))
        .filter(Boolean);

      const syllables = extractLineSyllables(body)
        .map((syllable) => syllable.text || syllable.normalizedText)
        .filter((text) => text.length > 0);

      if (!patterns.length || !syllables.length) continue;

      const tokenGroups = assignSyllablesToWords(line.text, syllables);
      if (!tokenGroups) {
        failedLines += 1;
        continue;
      }

      assignedWords += tokenGroups.length;

      for (const pattern of patterns) {
        if (pattern.length !== syllables.length) continue;
        let cursor = 0;
        for (const group of tokenGroups) {
          const wordPattern = pattern.slice(cursor, cursor + group.syllableCount);
          cursor += group.syllableCount;
          if (!wordPattern) continue;

          const profileBucket = poem.profileHint || 'modern';
          if (!lexicon[group.normalized]) {
            lexicon[group.normalized] = {
              syllables: group.syllableCount,
              patterns: {},
              profiles: {}
            };
          }

          const entry = lexicon[group.normalized];
          entry.syllables = Math.max(entry.syllables, group.syllableCount);
          entry.patterns[wordPattern] = (entry.patterns[wordPattern] || 0) + 1;
          if (!entry.profiles[profileBucket]) {
            entry.profiles[profileBucket] = {};
          }
          entry.profiles[profileBucket][wordPattern] = (entry.profiles[profileBucket][wordPattern] || 0) + 1;
        }
      }
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'https://prosody.lib.virginia.edu/',
    wordCount: Object.keys(lexicon).length,
    assignedWords,
    failedLines,
    entries: lexicon
  };

  const outputPath = path.resolve(repoRoot, 'artifacts', 'uva-word-stress-lexicon.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify({
    wordCount: output.wordCount,
    assignedWords,
    failedLines,
    outputPath
  }, null, 2));
}

function assignSyllablesToWords(lineText, syllables) {
  const tokens = tokenize(lineText);
  const groups = [];
  let cursor = 0;

  for (const token of tokens) {
    let built = '';
    const assigned = [];
    while (cursor < syllables.length && built !== token.normalized) {
      const fragment = normalizeWord(syllables[cursor]);
      assigned.push(syllables[cursor]);
      built += fragment;
      cursor += 1;
      if (!token.normalized.startsWith(built) && built !== token.normalized) {
        return null;
      }
    }

    if (!assigned.length || built !== token.normalized) {
      return null;
    }

    groups.push({
      raw: token.raw,
      normalized: token.normalized,
      syllableCount: assigned.length
    });
  }

  if (cursor !== syllables.length) {
    return null;
  }

  return groups;
}

function tokenize(text) {
  const tokens = [];
  const regex = /[A-Za-zÀ-ÖØ-öø-ÿ'’-]+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const normalized = normalizeWord(raw);
    if (!normalized) continue;
    tokens.push({ raw, normalized });
  }
  return tokens;
}

function normalizeWord(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[\u2019]/g, "'")
    .replace(/[â€™]/g, "'")
    .replace(/^[-']+|[-']+$/g, '')
    .replace(/[^a-z']/g, '');
}

function attributeValue(attrs, name) {
  return attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '';
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_, name) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? `&${name};`);
}

main();
