import handler from '../netlify/functions/scan.js';

const request = new Request('http://localhost/.netlify/functions/scan', {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    poem: "Shall I compare thee to a summer's day?",
    includeSummary: false
  })
});

const response = await handler(request);

if (!(response instanceof Response)) {
  throw new Error('Scan function did not return a Response instance.');
}

if (!response.ok) {
  throw new Error(`Scan function returned ${response.status}: ${await response.text()}`);
}

const data = await response.json();

if (!data.overallMeter || !Array.isArray(data.lines) || data.lines.length === 0) {
  throw new Error('Scan function returned an incomplete payload.');
}

const rhymeRequest = new Request('http://localhost/.netlify/functions/scan', {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    poem: `The light was bright
We watched the night
The sea moved slow
And stars would glow`,
    includeSummary: false
  })
});

const rhymeResponse = await handler(rhymeRequest);

if (!rhymeResponse.ok) {
  throw new Error(`Rhyme scan returned ${rhymeResponse.status}: ${await rhymeResponse.text()}`);
}

const rhymeData = await rhymeResponse.json();

if (rhymeData.rhyme?.overallScheme !== 'AABB') {
  throw new Error(`Rhyme scheme should be AABB, got ${rhymeData.rhyme?.overallScheme || 'missing'}`);
}

const rhymeLetters = rhymeData.lines.filter((line) => !line.blank).map((line) => line.rhymeLetter).join('');

if (rhymeLetters !== 'AABB') {
  throw new Error(`Rhyme letters should be AABB, got ${rhymeLetters || 'missing'}`);
}

const sonnet73Poem = `That time of year thou mayst in me behold
When yellow leaves, or none, or few, do hang
Upon those boughs which shake against the cold,
Bare ruin'd choirs, where late the sweet birds sang.
In me thou see'st the twilight of such day
As after sunset fadeth in the west,
Which by and by black night doth take away,
Death's second self, that seals up all in rest.
In me thou see'st the glowing of such fire
That on the ashes of his youth doth lie,
As the death-bed whereon it must expire,
Consum'd with that which it was nourish'd by.
This thou perceiv'st, which makes thy love more strong,
To love that well which thou must leave ere long.`;

const sonnet73Request = new Request('http://localhost/.netlify/functions/scan', {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    poem: sonnet73Poem,
    includeSummary: false
  })
});

const sonnet73Response = await handler(sonnet73Request);

if (!sonnet73Response.ok) {
  throw new Error(`Sonnet 73 scan returned ${sonnet73Response.status}: ${await sonnet73Response.text()}`);
}

const sonnet73Data = await sonnet73Response.json();
const sonnet73Lines = sonnet73Data.lines.filter((line) => !line.blank);
const sonnet73Mismatch = sonnet73Lines
  .map((line, index) => ({
    line: index + 1,
    actual: line.scans[0]?.meterKey,
    stress: line.scans[0]?.stressPattern
  }))
  .filter((row) => row.actual !== 'iambic_pentameter' || row.stress?.replace(/\s+/g, ' ') !== 'u s u s u s u s u s');

if (sonnet73Mismatch.length) {
  throw new Error(`Sonnet 73 regression failed: ${JSON.stringify(sonnet73Mismatch)}`);
}

if (sonnet73Data.rhyme?.overallScheme !== 'ABABCDCDEFEFGG') {
  throw new Error(`Sonnet 73 rhyme scheme should be ABABCDCDEFEFGG, got ${sonnet73Data.rhyme?.overallScheme || 'missing'}`);
}

const dickinsonPoem = `Because I could not stop for Death -
He kindly stopped for me -
The Carriage held but just Ourselves -
And Immortality.

We slowly drove - He knew no haste
And I had put away
My labor and my leisure too,
For His Civility -

We passed the School, where Children strove
At Recess - in the Ring -
We passed the Fields of Gazing Grain -
We passed the Setting Sun -

Or rather - He passed Us -
The Dews drew quivering and Chill -
For only Gossamer, my Gown -
My Tippet - only Tulle -

We paused before a House that seemed
A Swelling of the Ground -
The Roof was scarcely visible -
The Cornice - in the Ground -

Since then - 'tis Centuries - and yet
Feels shorter than the Day
I first surmised the Horses' Heads
Were toward Eternity -`;

const dickinsonExpected = [
  'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
  'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
  'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
  'iambic_trimeter', 'iambic_tetrameter', 'iambic_tetrameter', 'iambic_trimeter',
  'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
  'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter'
];

const dickinsonRequest = new Request('http://localhost/.netlify/functions/scan', {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    poem: dickinsonPoem,
    includeSummary: false
  })
});

const dickinsonResponse = await handler(dickinsonRequest);

if (!dickinsonResponse.ok) {
  throw new Error(`Dickinson scan returned ${dickinsonResponse.status}: ${await dickinsonResponse.text()}`);
}

const dickinsonData = await dickinsonResponse.json();
const dickinsonLines = dickinsonData.lines.filter((line) => !line.blank);
const dickinsonMismatches = dickinsonLines
  .map((line, index) => ({
    line: index + 1,
    expected: dickinsonExpected[index],
    actual: line.scans[0]?.meterKey,
    text: line.text
  }))
  .filter((row) => row.expected !== row.actual);

if (dickinsonMismatches.length) {
  throw new Error(`Dickinson regression failed: ${JSON.stringify(dickinsonMismatches)}`);
}

if (dickinsonData.overallMeter !== 'common meter') {
  throw new Error(`Dickinson overall meter should be common meter, got ${dickinsonData.overallMeter}`);
}

const dickinsonLine10 = dickinsonLines[9]?.scans?.[0];

if (!dickinsonLine10 || dickinsonLine10.stressPattern.replace(/\s+/g, ' ') !== 'u s u s u s') {
  throw new Error(`Dickinson line 10 should scan as u s u s u s, got ${dickinsonLine10?.stressPattern || 'missing'}`);
}

const streamRequest = new Request('http://localhost/.netlify/functions/scan', {
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    poem: "Because I could not stop for Death -\nHe kindly stopped for me -",
    includeSummary: false,
    stream: true
  })
});

const streamResponse = await handler(streamRequest);

if (!(streamResponse instanceof Response)) {
  throw new Error('Streamed scan function did not return a Response instance.');
}

if (!streamResponse.ok) {
  throw new Error(`Streamed scan returned ${streamResponse.status}: ${await streamResponse.text()}`);
}

if (!(streamResponse.headers.get('content-type') || '').includes('application/x-ndjson')) {
  throw new Error('Streamed scan did not return NDJSON.');
}

const streamText = await streamResponse.text();
const events = streamText
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const firstLineEvent = events.findIndex((event) => event.type === 'line');
const completeEvent = events.findIndex((event) => event.type === 'complete');

if (firstLineEvent < 0) {
  throw new Error('Streamed scan did not emit any line events.');
}

if (completeEvent < 0) {
  throw new Error('Streamed scan did not emit a completion event.');
}

if (firstLineEvent > completeEvent) {
  throw new Error('Streamed scan emitted completion before line results.');
}

console.log(`check ok: ${data.overallMeter}`);
