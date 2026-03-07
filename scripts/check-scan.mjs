import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler, { API_VERSION, scanPoem } from '../netlify/functions/scan.js';
import { BENCHMARK_CORPUS } from '../benchmarks/corpus.mjs';
import {
  buildPrintableDocument,
  createProjectRecord,
  decodeShareState,
  encodeShareState
} from '../public/app-shared.js';
import { createWidgetMarkup } from '../public/widget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

await testSingleScanRequest();
await testBatchRequest();
await testStreamingRequest();
await testOverrideRequest();
testProfileAwareBenchmarks();
testRhymeClassificationFixtures();
testFeminineEndingSignal();
testShareAndProjectState();
testPrintableDocument();
testWidgetMarkup();
await testFrontendFiles();

console.log(`check ok: api ${API_VERSION}`);

async function testSingleScanRequest() {
  const response = await handler(new Request('http://localhost/.netlify/functions/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      poem: "Shall I compare thee to a summer's day?",
      includeSummary: false,
      profile: 'early_modern'
    })
  }));

  if (!(response instanceof Response) || !response.ok) {
    throw new Error(`Single scan request failed: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.apiVersion !== API_VERSION || data.kind !== 'single') {
    throw new Error(`Single scan should include api version ${API_VERSION}.`);
  }

  if (data.profile?.key !== 'early_modern') {
    throw new Error(`Single scan should echo the active profile, got ${data.profile?.key || 'missing'}.`);
  }
}

async function testBatchRequest() {
  const response = await handler(new Request('http://localhost/.netlify/functions/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile: 'modern',
      poems: [
        {
          id: 'grace',
          title: 'Amazing Grace',
          profile: 'hymn',
          poem: `Amazing grace! How sweet the sound
That saved a wretch like me!
I once was lost, but now am found,
Was blind, but now I see.`
        },
        {
          id: 'couplets',
          title: 'Pope',
          profile: 'early_modern',
          poem: `True wit is nature to advantage dress'd,
What oft was thought, but ne'er so well express'd;`
        }
      ]
    })
  }));

  if (!response.ok) {
    throw new Error(`Batch request failed: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.kind !== 'batch' || data.count !== 2 || !Array.isArray(data.analyses)) {
    throw new Error('Batch response returned the wrong shape.');
  }

  const grace = data.analyses.find((entry) => entry.id === 'grace');
  if (grace?.form?.primary?.key !== 'hymn_common_meter') {
    throw new Error(`Batch hymn form should be hymn_common_meter, got ${grace?.form?.primary?.key || 'missing'}.`);
  }
}

async function testStreamingRequest() {
  const response = await handler(new Request('http://localhost/.netlify/functions/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      poem: "Because I could not stop for Death -\nHe kindly stopped for me -",
      includeSummary: false,
      stream: true
    })
  }));

  if (!(response.headers.get('content-type') || '').includes('application/x-ndjson')) {
    throw new Error('Streaming response should be NDJSON.');
  }

  const text = await response.text();
  const events = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const firstLine = events.findIndex((event) => event.type === 'line');
  const complete = events.findIndex((event) => event.type === 'complete');

  if (firstLine < 0 || complete < 0 || firstLine > complete) {
    throw new Error('Streaming response emitted events in the wrong order.');
  }
}

async function testOverrideRequest() {
  const response = await handler(new Request('http://localhost/.netlify/functions/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      poem: 'At Recess - in the Ring -',
      includeSummary: false,
      overrides: {
        tokens: {
          '0:1': {
            stressPattern: 'su',
            pronunciation: 'R IH0 S EH1 S',
            label: 'noun reading'
          },
          '0:2': {
            stressPattern: 's',
            pronunciation: 'IH0 N',
            label: 'promoted preposition'
          }
        }
      }
    })
  }));

  if (!response.ok) {
    throw new Error(`Override request failed: ${await response.text()}`);
  }

  const data = await response.json();
  const line = data.lines.find((entry) => !entry.blank);
  if (line.scans?.[0]?.meterKey !== 'iambic_trimeter') {
    throw new Error(`Overrides should push the line to iambic_trimeter, got ${line.scans?.[0]?.meterKey || 'missing'}.`);
  }

  const recessToken = line.tokens.find((token) => token.raw === 'Recess');
  if (!recessToken?.overrideApplied) {
    throw new Error('Override request should mark the affected token.');
  }
}

function testProfileAwareBenchmarks() {
  for (const poem of BENCHMARK_CORPUS) {
    const analysis = scanPoem({
      poem: poem.poem,
      profileKey: poem.profile
    });
    const nonBlankLines = analysis.lines.filter((line) => !line.blank);

    if (analysis.overallMeter !== poem.expected.overallMeter) {
      throw new Error(`${poem.id}: expected overall meter ${poem.expected.overallMeter}, got ${analysis.overallMeter}.`);
    }

    if ((analysis.form?.primary?.key || '') !== poem.expected.form) {
      throw new Error(`${poem.id}: expected form ${poem.expected.form}, got ${analysis.form?.primary?.key || 'missing'}.`);
    }

    if (poem.expected.rhymeScheme && (analysis.rhyme?.overallScheme || '') !== poem.expected.rhymeScheme) {
      throw new Error(`${poem.id}: expected rhyme ${poem.expected.rhymeScheme}, got ${analysis.rhyme?.overallScheme || 'missing'}.`);
    }

    if (poem.expected.stanzaSchemePatterns) {
      const actual = (analysis.rhyme?.stanzas || []).map((stanza) => normalizeSchemePattern(stanza.scheme));
      if (JSON.stringify(actual) !== JSON.stringify(poem.expected.stanzaSchemePatterns)) {
        throw new Error(`${poem.id}: expected stanza rhyme patterns ${JSON.stringify(poem.expected.stanzaSchemePatterns)}, got ${JSON.stringify(actual)}.`);
      }
    }

    const mismatches = nonBlankLines
      .map((line, index) => ({
        line: index + 1,
        expected: poem.expected.lineMeters[index],
        actual: line.scans?.[0]?.meterKey || ''
      }))
      .filter((line) => line.expected && line.expected !== line.actual);

    if (mismatches.length) {
      throw new Error(`${poem.id}: line meter regression ${JSON.stringify(mismatches)}.`);
    }
  }
}

function testRhymeClassificationFixtures() {
  const consonance = scanPoem({
    poem: `This heart will move with patient love
The dawn arrives and stars still move`
  });
  if (consonance.rhyme?.groups?.[0]?.quality !== 'consonance') {
    throw new Error(`Consonance fixture should classify as consonance, got ${consonance.rhyme?.groups?.[0]?.quality || 'missing'}.`);
  }

  const eye = scanPoem({
    poem: `We heard the winter cough
Above the orchard bough`
  });
  if (eye.rhyme?.groups?.[0]?.quality !== 'eye') {
    throw new Error(`Eye-rhyme fixture should classify as eye, got ${eye.rhyme?.groups?.[0]?.quality || 'missing'}.`);
  }
}

function testFeminineEndingSignal() {
  const analysis = scanPoem({
    poem: 'To be, or not to be: that is the question:',
    profileKey: 'early_modern'
  });
  const line = analysis.lines.find((entry) => !entry.blank);

  if (line?.scans?.[0]?.meterKey !== 'iambic_pentameter') {
    throw new Error(`Feminine-ending fixture should remain iambic pentameter, got ${line?.scans?.[0]?.meterKey || 'missing'}.`);
  }

  if (!line?.scans?.[0]?.observations?.includes('feminine ending')) {
    throw new Error('Feminine-ending fixture should flag the line-level observation.');
  }

  if (analysis.diagnostics?.feminineEndingCount !== 1) {
    throw new Error(`Feminine-ending fixture should report 1 feminine ending, got ${analysis.diagnostics?.feminineEndingCount ?? 'missing'}.`);
  }
}

function testShareAndProjectState() {
  const state = {
    poem: `Amazing grace! How sweet the sound
That saved a wretch like me!`,
    profile: 'hymn',
    overrides: {
      tokens: {
        '0:0': {
          stressPattern: 'u',
          pronunciation: 'AH0 M EY1 Z IH0 NG',
          label: 'light opening'
        }
      }
    },
    view: {
      mode: 'line',
      lineIndex: 0,
      rhymeLetter: ''
    }
  };

  const encoded = encodeShareState(state);
  const decoded = decodeShareState(encoded);
  if (decoded.profile !== 'hymn' || decoded.view?.mode !== 'line' || decoded.view?.lineIndex !== 0) {
    throw new Error('Share state should round-trip profile and focused line state.');
  }

  const project = createProjectRecord({
    ...state,
    title: 'Amazing Grace'
  });
  if (project.profile !== 'hymn' || !project.view || project.view.mode !== 'line') {
    throw new Error('Saved project should preserve profile and view state.');
  }
}

function testPrintableDocument() {
  const analysis = scanPoem({
    poem: `Amazing grace! How sweet the sound
That saved a wretch like me!
I once was lost, but now am found,
Was blind, but now I see.`,
    profileKey: 'hymn'
  });

  const html = buildPrintableDocument({
    analysis,
    profileLabel: 'Hymn / Common Meter',
    title: 'Amazing Grace',
    alternates: [{
      lineNumber: 1,
      text: analysis.lines[0].text,
      readings: analysis.lines[0].scans.slice(0, 2).map((scan) => ({
        meterLabel: scan.meterLabel,
        displayGuide: scan.displayGuide
      }))
    }]
  });

  if (!html.includes('Alternate readings') || !html.includes('Amazing Grace')) {
    throw new Error('Printable document should include metadata and alternates.');
  }
}

function testWidgetMarkup() {
  const analysis = scanPoem({
    poem: `Amazing grace! How sweet the sound
That saved a wretch like me!
I once was lost, but now am found,
Was blind, but now I see.`,
    profileKey: 'hymn'
  });
  const markup = createWidgetMarkup(analysis, { maxLines: 2 });

  if (!markup.includes('Scansion widget') || !markup.includes('Amazing grace! How sweet the sound')) {
    throw new Error('Widget markup should render summary and poem lines.');
  }
}

async function testFrontendFiles() {
  const appJs = await fs.readFile(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const apiHtml = await fs.readFile(path.join(repoRoot, 'public', 'api.html'), 'utf8');
  const benchmarksHtml = await fs.readFile(path.join(repoRoot, 'public', 'benchmarks.html'), 'utf8');
  const indexHtml = await fs.readFile(path.join(repoRoot, 'public', 'index.html'), 'utf8');

  if (!appJs.includes('applyProjectState') || !appJs.includes('renderRhymeDrawer')) {
    throw new Error('Frontend app module is missing expected project and rhyme hooks.');
  }

  if (appJs.includes('exportHtmlButton') || appJs.includes('window.open(')) {
    throw new Error('Frontend app module should not use the removed HTML export or popup export path.');
  }

  if (!apiHtml.includes('Embeddable widget') || !apiHtml.includes('/api/scan')) {
    throw new Error('API docs page is missing required sections.');
  }

  if (!benchmarksHtml.includes('Benchmark dashboard') || !benchmarksHtml.includes('/benchmarks.json')) {
    throw new Error('Benchmark dashboard page is missing expected wiring.');
  }

  if (!indexHtml.includes('/app.js') || !indexHtml.includes('profileSelect')) {
    throw new Error('Main page is not wired to the new app module.');
  }

  if (indexHtml.includes('exportHtmlButton')) {
    throw new Error('Main page should not expose the removed HTML export control.');
  }
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
