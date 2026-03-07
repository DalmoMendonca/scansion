# Scansion

Scansion is a poetry meter and rhyme analysis app that turns a pasted poem into a line-by-line prosody reading surface. It identifies likely meters, surfaces alternate scans, annotates stress directly over the text, labels rhyme schemes, and streams results line by line while the rest of the poem is still being processed.

Live site: `https://poetryscansion.netlify.app`  
GitHub: `https://github.com/DalmoMendonca/scansion`

## Why this project is interesting

This app tackles a problem that usually takes literature students years of practice to do well by hand:

- breaking lines into syllabic stress patterns
- comparing those patterns against multiple metrical templates
- resolving ambiguity caused by pronunciation variants, archaic forms, and poetic contractions
- using stanza context to improve local line decisions instead of treating each line in isolation
- identifying rhyme schemes from resolved line endings

The point is not to fake expertise with an LLM. The hard part is handled by a deterministic scansion engine. AI is optional and only used for the final prose summary.

## What it does

- scans accentual-syllabic verse line by line
- detects common metrical patterns including iambic, trochaic, anapestic, dactylic, and amphibrachic families
- supports stanza-aware selection so the best reading for one line can be informed by the surrounding pattern
- recognizes rhyme schemes and labels lines with standard letter notation
- shows alternate readings when a line is genuinely ambiguous
- streams long scans progressively instead of blocking the whole poem behind one loading state
- overlays stress marks directly on the poem text rather than rendering a detached scansion table
- generates a concise meter summary when `OPENAI_API_KEY` is available, with a deterministic fallback when it is not

## Technical highlights

### Deterministic prosody engine

The core engine in `netlify/functions/scan.js` does not ask an LLM how to scan a poem. It:

1. tokenizes each line
2. pulls candidate pronunciations from CMUdict
3. generates fallback pronunciations for out-of-vocabulary words
4. expands poetic and historical variants
5. composes candidate stress strings
6. scores them against a metrical template library
7. reranks them with stanza-level evidence
8. derives rhyme data from resolved line endings

That makes the system inspectable, testable, and debuggable in a way a pure prompt-based solution is not.

### Ambiguity is surfaced, not hidden

Poetry is full of lines that admit more than one plausible reading. Instead of pretending there is always one perfect answer, the app keeps multiple candidates, ranks them, and lets the reader inspect the strongest alternatives in a side drawer.

### Streaming UX for long poems

The frontend does not wait for the entire poem to finish before showing anything. The Netlify function can stream NDJSON events so completed lines appear immediately while remaining lines keep a lightweight spinner.

### Real regression coverage

The project has a regression script in `scripts/check-scan.mjs` that exercises:

- rhyme scheme extraction
- streamed scan responses
- Emily Dickinson's common meter in "Because I could not stop for Death -"
- Shakespeare's Sonnet 73 as iambic pentameter with `ABABCDCDEFEFGG`

Those checks exist because prosody code is easy to break with small heuristic changes.

## Stack

- static frontend in `public/index.html`
- Netlify serverless backend in `netlify/functions/scan.js`
- pronunciation layer built on `cmu-pronouncing-dictionary`
- optional OpenAI summary generation through the Responses API
- production deployment on Netlify with GitHub-linked auto deploys

## Local development

```bash
npm install
npm run dev
```

Then open the local Netlify URL shown in the terminal.

## Deploy

`netlify.toml` is already configured with:

- publish directory: `public`
- functions directory: `netlify/functions`
- redirect from `/api/scan` to the serverless function

Optional environment variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` defaults to `gpt-5-mini`

## Limits

This engine is strongest on English accentual-syllabic verse. It is less certain with:

- free verse with intentionally unstable stress
- historical pronunciation drift that differs sharply from modern pronunciation dictionaries
- unusual proper nouns and multilingual lines
- performances where intended stress diverges from lexical stress

When the engine is uncertain, the UI exposes that uncertainty with alternate readings rather than burying it.
