import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const netlifyDir = path.join(rootDir, '.netlify');
const stalePaths = [
  path.join(netlifyDir, 'functions'),
  path.join(netlifyDir, 'functions-internal'),
  path.join(netlifyDir, 'functions-serve'),
  path.join(netlifyDir, 'v1'),
  path.join(netlifyDir, 'netlify.toml'),
];

for (const targetPath of stalePaths) {
  await rm(targetPath, { recursive: true, force: true });
}

console.log('Cleared stale Netlify function cache.');
