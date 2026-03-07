export const APP_VERSION = '1.3.0';
export const PROJECT_STORAGE_KEY = 'scansion-projects-v1';
export const MAX_SAVED_PROJECTS = 20;

export const PROFILE_OPTIONS = [
  {
    key: 'modern',
    label: 'Modern American',
    description: 'Default contemporary pronunciation assumptions.'
  },
  {
    key: 'early_modern',
    label: 'Early Modern leaning',
    description: 'More permissive archaic contractions, rhyme spellings, and syllabic endings.'
  },
  {
    key: 'hymn',
    label: 'Hymn / Common Meter',
    description: 'Biases hymnbook-style common meter and common poetic reductions.'
  }
];

export function normalizePoem(value) {
  return String(value || '').replace(/\r\n/g, '\n').trimEnd();
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

export function makeProjectTitle(poem) {
  const firstLine = normalizePoem(poem)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return 'Untitled project';
  }

  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

export function sanitizeProjectState(state) {
  return {
    poem: normalizePoem(state?.poem || ''),
    profile: PROFILE_OPTIONS.some((profile) => profile.key === state?.profile) ? state.profile : 'modern',
    overrides: sanitizeOverrides(state?.overrides),
    view: sanitizeProjectView(state?.view)
  };
}

export function sanitizeProjectView(view) {
  const mode = ['overview', 'line', 'rhyme', 'projects'].includes(view?.mode) ? view.mode : 'overview';
  const lineIndex = Number.isInteger(view?.lineIndex) && view.lineIndex >= 0 ? view.lineIndex : null;
  const rhymeLetter = /^[A-Z]{1,3}$/.test(String(view?.rhymeLetter || '')) ? String(view.rhymeLetter) : '';
  return {
    mode,
    lineIndex,
    rhymeLetter
  };
}

export function sanitizeOverrides(overrides) {
  const safe = {
    tokens: {},
    words: {}
  };

  for (const [collectionKey, target] of [['tokens', overrides?.tokens], ['words', overrides?.words]]) {
    if (!target || typeof target !== 'object') continue;
    for (const [key, value] of Object.entries(target)) {
      const stressPattern = String(value?.stressPattern || '').toLowerCase().replace(/[^su]/g, '');
      if (!stressPattern) continue;
      safe[collectionKey][key] = {
        stressPattern,
        pronunciation: String(value?.pronunciation || value?.label || 'user override'),
        label: String(value?.label || 'user override')
      };
    }
  }

  return safe;
}

export function createProjectRecord({ poem, profile, overrides, view, title, id, createdAt, updatedAt } = {}) {
  const normalized = sanitizeProjectState({ poem, profile, overrides });
  const timestamp = updatedAt || new Date().toISOString();

  return {
    id: id || `project-${Date.now()}`,
    title: title || makeProjectTitle(normalized.poem),
    poem: normalized.poem,
    profile: normalized.profile,
    overrides: normalized.overrides,
    view: sanitizeProjectView(view),
    createdAt: createdAt || timestamp,
    updatedAt: timestamp
  };
}

export function mergeProjectRecord(projects, record) {
  const next = [record, ...(projects || []).filter((project) => project.id !== record.id)];
  return next.slice(0, MAX_SAVED_PROJECTS);
}

export function encodeShareState(state) {
  const json = JSON.stringify(sanitizeProjectState(state));
  return toBase64Url(json);
}

export function decodeShareState(value) {
  if (!value) return null;
  const raw = String(value).replace(/^#(?:share=)?/, '').replace(/^share=/, '');
  if (!raw) return null;

  try {
    return sanitizeProjectState(JSON.parse(fromBase64Url(raw)));
  } catch {
    return null;
  }
}

export function formatDateTime(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

export function buildPrintableDocument({
  analysis,
  profileLabel = 'Modern American',
  title = '',
  exportedAt = new Date().toISOString(),
  alternates = []
} = {}) {
  const safeTitle = escapeHtml(title || makeProjectTitle(analysis?.poem || ''));
  const safeMeter = escapeHtml(analysis?.overallMeter || 'Mixed meter');
  const safeProfile = escapeHtml(profileLabel);
  const safeExportedAt = escapeHtml(formatDateTime(exportedAt));
  const safeForm = escapeHtml(analysis?.form?.primary?.label || 'Not identified');
  const safeRhyme = escapeHtml(analysis?.rhyme?.overallScheme || '-');
  const rows = (analysis?.lines || []).map((line, displayIndex) => {
    if (line.blank) {
      return '<div class="print-row blank" aria-hidden="true"><div class="print-number"></div><div class="print-content"></div><div class="print-rhyme"></div><div class="print-tag"></div></div>';
    }

    const lineNumber = countDisplayedLines(analysis.lines, displayIndex);
    const guide = escapeHtml(line?.scans?.[0]?.displayGuide || '');
    const text = escapeHtml(line.text || '');
    const tag = escapeHtml(line?.scans?.[0]?.meterLabel || line?.tag || '');
    const rhyme = escapeHtml(line?.rhymeLetter || '');
    return `
      <div class="print-row">
        <div class="print-number">${lineNumber}</div>
        <div class="print-content">
          <div class="annotated-line" data-annotated-text="${text}" data-annotated-guide="${guide}">
            <div class="annotation-layer"></div>
            <div class="annotated-text">${text}</div>
          </div>
        </div>
        <div class="print-rhyme">${rhyme}</div>
        <div class="print-tag">${tag}</div>
      </div>
    `;
  }).join('');
  const alternatesMarkup = alternates.length
    ? `
      <section class="print-alternates">
        <h2>Alternate readings</h2>
        <div class="alternate-grid">
          ${alternates.map((alternate) => `
            <article class="alternate-card">
              <div class="alternate-kicker">Line ${escapeHtml(alternate.lineNumber || '')}</div>
              <div class="alternate-line">${escapeHtml(alternate.text || '')}</div>
              <div class="alternate-readings">
                ${(alternate.readings || []).map((reading, index) => `
                  <div class="alternate-reading">
                    <div class="alternate-reading-head">
                      <span>${index === 0 ? 'Top reading' : `Reading ${index + 1}`}</span>
                      <strong>${escapeHtml(reading.meterLabel || '')}</strong>
                    </div>
                    <div class="annotated-line drawer-annotated" data-annotated-text="${escapeHtml(alternate.text || '')}" data-annotated-guide="${escapeHtml(reading.displayGuide || '')}">
                      <div class="annotation-layer"></div>
                      <div class="annotated-text">${escapeHtml(alternate.text || '')}</div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    `
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle} | Scansion PDF export</title>
    <style>
      :root {
        --fg: #181612;
        --muted: #6f695e;
        --line: rgba(24, 22, 18, 0.12);
        --annotation: #d83b2b;
        --annotation-break: #9f978f;
        --poem-font: "Constantia", "Cambria", Georgia, serif;
        --ui-font: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--fg);
        font-family: var(--ui-font);
        background: #ffffff;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      main {
        padding: 28px 32px 36px;
      }
      .print-header {
        display: grid;
        gap: 8px;
        margin-bottom: 22px;
      }
      .print-title {
        font-family: var(--poem-font);
        font-size: 28px;
        line-height: 1.2;
      }
      .print-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .print-grid {
        display: grid;
        gap: 8px;
      }
      .print-alternates {
        margin-top: 32px;
        display: grid;
        gap: 16px;
      }
      .print-alternates h2 {
        margin: 0;
        font-size: 14px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .alternate-grid {
        display: grid;
        gap: 14px;
      }
      .alternate-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px 18px;
        display: grid;
        gap: 12px;
      }
      .alternate-kicker {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .alternate-line {
        font-family: var(--poem-font);
        font-size: 21px;
        line-height: 1.4;
      }
      .alternate-readings {
        display: grid;
        gap: 12px;
      }
      .alternate-reading {
        display: grid;
        gap: 8px;
      }
      .alternate-reading-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .print-row {
        display: grid;
        grid-template-columns: 38px minmax(0, 1fr) 26px 160px;
        gap: 18px;
        align-items: start;
      }
      .print-row.blank {
        min-height: 22px;
      }
      .print-number,
      .print-rhyme,
      .print-tag {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .print-number {
        text-align: right;
        padding-top: 6px;
      }
      .print-rhyme {
        text-align: center;
        padding-top: 6px;
      }
      .print-tag {
        padding-top: 6px;
      }
      .annotated-line {
        position: relative;
        font-family: var(--poem-font);
        font-size: 22px;
        line-height: 1.58;
        min-height: 34px;
      }
      .annotated-text {
        position: relative;
        z-index: 1;
        white-space: pre-wrap;
      }
      .annotation-layer {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
      }
      .annotated-mark {
        position: absolute;
        transform: translateX(-50%);
        font-family: "Palatino Linotype", "Book Antiqua", Georgia, serif;
        line-height: 1;
      }
      .annotated-mark.stressed {
        color: var(--annotation);
        font-size: 12px;
        font-weight: 800;
      }
      .annotated-mark.unstressed {
        color: var(--annotation);
        font-size: 10px;
        font-weight: 900;
        transform: translateX(-50%) scaleX(3.2) scaleY(0.88);
      }
      .annotated-mark.break {
        color: var(--annotation-break);
        font-size: 11px;
      }
      @media print {
        main {
          padding: 20px 24px 28px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="print-header">
        <div class="print-title">${safeTitle}</div>
        <div class="print-meta">
          <span>Overall ${safeMeter}</span>
          <span>Form ${safeForm}</span>
          <span>Rhyme ${safeRhyme}</span>
          <span>Profile ${safeProfile}</span>
          <span>Exported ${safeExportedAt}</span>
          <span>Scansion ${escapeHtml(APP_VERSION)}</span>
        </div>
      </section>
      <section class="print-grid">${rows}</section>
      ${alternatesMarkup}
    </main>
    <script>
      const hydrate = () => {
        document.querySelectorAll('[data-annotated-text]').forEach((container) => {
          const text = container.getAttribute('data-annotated-text') || '';
          const guide = container.getAttribute('data-annotated-guide') || '';
          const textLayer = container.querySelector('.annotated-text');
          const annotationLayer = container.querySelector('.annotation-layer');
          if (!textLayer || !annotationLayer) return;
          textLayer.textContent = text;
          annotationLayer.textContent = '';
          const textNode = textLayer.firstChild;
          if (!textNode) return;
          const containerRect = container.getBoundingClientRect();
          for (let index = 0; index < guide.length; index += 1) {
            const markerValue = guide[index];
            if (!markerValue || markerValue === ' ') continue;
            const range = document.createRange();
            range.setStart(textNode, Math.min(index, text.length));
            range.setEnd(textNode, Math.min(index + 1, text.length));
            const rect = range.getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height)) continue;
            const marker = document.createElement('span');
            marker.className = 'annotated-mark ' + (markerValue === 'u' ? 'unstressed' : markerValue === '|' ? 'break' : 'stressed');
            marker.textContent = markerValue === 'u' ? '\\u02D8' : markerValue;
            marker.style.left = (rect.left - containerRect.left + rect.width / 2) + 'px';
            marker.style.top = (markerValue === '|' ? 1 : 0) + 'px';
            annotationLayer.appendChild(marker);
          }
        });
      };
      window.addEventListener('load', () => {
        hydrate();
        setTimeout(() => window.print(), 80);
      });
    </script>
  </body>
</html>`;
}

function countDisplayedLines(lines, targetIndex) {
  let count = 0;
  for (let index = 0; index <= targetIndex; index += 1) {
    if (lines[index]?.blank) continue;
    count += 1;
  }
  return count;
}

function toBase64Url(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }

  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
