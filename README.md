# Scansion

A minimal Netlify-ready poetry scansion app.

## What it does

- blank-page, cursor-first interface
- paste a poem and reveal **Scan** only when text exists
- line-by-line meter tag + confidence bar
- expandable alternate scans based on pronunciation variants
- stanza-aware confidence adjustment
- AI-generated summary blurb at the end when `OPENAI_API_KEY` is set
- deterministic fallback summary when no API key is present

## Stack

- static frontend in `public/`
- Netlify serverless function in `netlify/functions/scan.js`
- pronunciation layer powered by CMUdict, with heuristic fallback for out-of-vocabulary words
- optional OpenAI summary call through the Responses API

## Local setup

```bash
npm install
npm run dev
```

Then open the local Netlify URL shown in the terminal.

## Netlify deploy

1. Push this folder to GitHub or upload it directly to Netlify.
2. In Netlify, set these environment variables:
   - `OPENAI_API_KEY` = your OpenAI API key
   - `OPENAI_MODEL` = optional, defaults to `gpt-5-mini`
3. Deploy.

`netlify.toml` is already configured with:
- publish directory: `public`
- functions directory: `netlify/functions`
- redirect from `/api/scan` to the function

## Notes on reliability

The app does **not** rely on an LLM to do the actual scansion. The scanning engine is deterministic:

1. tokenize line
2. look up candidate pronunciations in CMUdict
3. generate fallback pronunciations when needed
4. compose candidate stress strings
5. score each candidate against a library of meter templates
6. adjust confidence using stanza-level agreement

The LLM is used only for the final summary paragraph.

## Files

- `public/index.html` — full UI
- `netlify/functions/scan.js` — scansion engine + summary generator
- `netlify.toml` — Netlify config

## Limits

This is strong on modern English accentual-syllabic verse. It is less certain on:

- historical pronunciation drift
- radically irregular free verse
- poems whose intended performance stress differs sharply from modern lexical stress
- unusual proper nouns and multilingual lines

The UI exposes that uncertainty through alternate scans and confidence values instead of hiding it.
