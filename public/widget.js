import { escapeHtml, formatPercent } from './app-shared.js';

const DEFAULT_ENDPOINT = new URL('./api/scan', import.meta.url).toString();

const WIDGET_STYLE = `
  :host {
    all: initial;
    color: #181612;
    font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
  }
  .widget {
    border: 1px solid rgba(24, 22, 18, 0.12);
    border-radius: 18px;
    background: #ffffff;
    color: #181612;
    padding: 16px 18px;
    display: grid;
    gap: 14px;
  }
  .widget-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }
  .widget-title {
    margin: 0;
    font-size: 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .widget-meta {
    color: #6f695e;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .widget-grid {
    display: grid;
    gap: 10px;
  }
  .widget-row {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) 24px 126px;
    gap: 12px;
    align-items: start;
  }
  .widget-line-number,
  .widget-rhyme {
    color: #6f695e;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding-top: 5px;
  }
  .widget-rhyme {
    text-align: center;
  }
  .widget-line-text {
    font-family: "Constantia", "Cambria", Georgia, serif;
    font-size: 18px;
    line-height: 1.45;
  }
  .widget-line-tag {
    display: grid;
    gap: 5px;
    justify-items: end;
  }
  .widget-tag-label {
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-align: right;
  }
  .widget-bar {
    width: 64px;
    height: 2px;
    border-radius: 999px;
    background: rgba(24, 22, 18, 0.08);
    position: relative;
    overflow: hidden;
  }
  .widget-bar > span {
    position: absolute;
    inset: 0 auto 0 0;
    background: rgba(24, 22, 18, 0.72);
  }
  .widget-empty,
  .widget-error {
    color: #6f695e;
    font-size: 14px;
    line-height: 1.6;
  }
  .widget-error {
    color: #8b2d2d;
  }
  @media (max-width: 640px) {
    .widget-row {
      grid-template-columns: 24px minmax(0, 1fr);
    }
    .widget-rhyme,
    .widget-line-tag {
      grid-column: 2;
    }
    .widget-line-tag {
      justify-items: start;
    }
    .widget-tag-label {
      text-align: left;
    }
  }
`;

export function createWidgetMarkup(analysis, options = {}) {
  if (!analysis?.lines?.length) {
    return '<div class="widget-empty">No scan data is available.</div>';
  }

  const visibleLineCount = Math.max(1, Math.min(Number(options.maxLines) || 6, analysis.lines.filter((line) => !line.blank).length));
  let countedLines = 0;
  const rows = [];
  for (const line of analysis.lines) {
    if (line.blank) continue;
    countedLines += 1;
    if (countedLines > visibleLineCount) break;
    const primary = line.scans?.[0] || {};
    const combined = Math.round((formatPercent(primary.score) * formatPercent(line.confidence ?? primary.confidence)) / 100);
    rows.push(`
      <div class="widget-row">
        <div class="widget-line-number">${countedLines}</div>
        <div class="widget-line-text">${escapeHtml(line.text)}</div>
        <div class="widget-rhyme">${escapeHtml(line.rhymeLetter || '')}</div>
        <div class="widget-line-tag">
          <div class="widget-tag-label">${escapeHtml(primary.meterLabel || line.tag || 'mixed meter')}</div>
          <div class="widget-bar"><span style="width:${combined}%"></span></div>
        </div>
      </div>
    `);
  }

  return `
    <div class="widget">
      <div class="widget-head">
        <div>
          <h2 class="widget-title">Scansion widget</h2>
          <div class="widget-meta">${escapeHtml(analysis.overallMeter || 'Mixed meter')}</div>
        </div>
        <div class="widget-meta">${escapeHtml(analysis.rhyme?.overallScheme || '')}</div>
      </div>
      <div class="widget-grid">${rows.join('')}</div>
    </div>
  `;
}

export async function renderScansionWidget(target, options = {}) {
  if (!target) {
    throw new Error('A target element is required.');
  }

  const root = target.shadowRoot || target.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${WIDGET_STYLE}</style><div class="widget"><div class="widget-empty">Loading scan…</div></div>`;

  try {
    const analysis = options.analysis || await fetchWidgetAnalysis(target, options);
    root.innerHTML = `<style>${WIDGET_STYLE}</style>${createWidgetMarkup(analysis, options)}`;
    return analysis;
  } catch (error) {
    root.innerHTML = `<style>${WIDGET_STYLE}</style><div class="widget"><div class="widget-error">${escapeHtml(error.message || 'Widget failed to load.')}</div></div>`;
    throw error;
  }
}

async function fetchWidgetAnalysis(target, options) {
  const poem = options.poem || target.getAttribute('data-poem') || '';
  if (!poem.trim()) {
    throw new Error('Widget requires a poem.');
  }

  const endpoint = options.endpoint || target.getAttribute('data-endpoint') || DEFAULT_ENDPOINT;
  const profile = options.profile || target.getAttribute('data-profile') || 'modern';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      poem,
      includeSummary: false,
      profile
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Widget scan failed with ${response.status}.`);
  }

  return response.json();
}

async function autoInitWidgets() {
  const nodes = document.querySelectorAll('[data-scansion-widget]');
  await Promise.all([...nodes].map((node) => renderScansionWidget(node, {
    maxLines: Number(node.getAttribute('data-max-lines') || 6)
  }).catch(() => null)));
}

if (typeof window !== 'undefined') {
  window.ScansionWidget = {
    renderScansionWidget,
    createWidgetMarkup
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoInitWidgets());
  } else {
    autoInitWidgets();
  }
}
