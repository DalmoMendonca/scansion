import {
  PROFILE_OPTIONS,
  normalizePoem,
  escapeHtml,
  formatPercent,
  makeProjectTitle,
  sanitizeOverrides,
  createProjectRecord,
  mergeProjectRecord,
  encodeShareState,
  decodeShareState,
  formatDateTime,
  buildPrintableDocument
} from './app-shared.js';

const input = document.getElementById('poemInput');
const editorLineNumbers = document.getElementById('editorLineNumbers');
const scanButton = document.getElementById('scanButton');
const profileSelect = document.getElementById('profileSelect');
const projectsButton = document.getElementById('projectsButton');
const saveButton = document.getElementById('saveButton');
const shareButton = document.getElementById('shareButton');
const exportPdfButton = document.getElementById('exportPdfButton');
const clearOverridesButton = document.getElementById('clearOverridesButton');
const editButton = document.getElementById('editButton');
const overviewButton = document.getElementById('overviewButton');
const poemView = document.getElementById('poemView');
const noticeBox = document.getElementById('notice');
const errorBox = document.getElementById('error');
const overallMeter = document.getElementById('overallMeter');
const overallForm = document.getElementById('overallForm');
const drawer = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerClose = document.getElementById('drawerClose');
const drawerKicker = document.getElementById('drawerKicker');
const drawerTitle = document.getElementById('drawerTitle');
const drawerSubtitle = document.getElementById('drawerSubtitle');
const drawerBody = document.getElementById('drawerBody');

const STORAGE_KEY = 'scansion-projects-v1';
const EMPTY_OVERRIDES = Object.freeze({ tokens: {}, words: {} });

const state = {
  analysis: null,
  profile: 'modern',
  overrides: cloneValue(EMPTY_OVERRIDES),
  activeProjectId: '',
  savedProjects: loadSavedProjects(),
  pendingView: null,
  scan: {
    id: 0,
    controller: null,
    phase: 'idle'
  },
  drawer: {
    open: false,
    mode: 'overview',
    lineIndex: null,
    rhymeLetter: '',
    tokenIndex: 0
  }
};

populateProfileOptions();
bindEvents();
syncEditorState();
renderEditorLineNumbers();
autoResizeInput();
setMode('edit');
renderToolbar(state.analysis);

const sharedState = decodeShareState(window.location.hash);
if (sharedState?.poem) {
  applyProjectState(sharedState, { shouldScan: true, notice: 'Loaded shared state.' });
} else {
  input.focus();
}

function bindEvents() {
  input.addEventListener('input', () => {
    syncEditorState();
    renderEditorLineNumbers();
    autoResizeInput();
    if (state.drawer.open && state.drawer.mode !== 'projects' && state.analysis && !isAnalysisCurrent()) {
      closeDrawer({ keepState: false });
    }
    renderToolbar(state.analysis);
  });

  scanButton.addEventListener('click', () => {
    runScan({ preserveAnalysis: false, resetView: true });
  });

  profileSelect.addEventListener('change', () => {
    state.profile = profileSelect.value;
    renderToolbar(state.analysis);

    if (!normalizePoem(input.value).trim()) {
      setNotice(`Profile set to ${getActiveProfile().label}.`);
      return;
    }

    const pendingLineIndexes = state.analysis?.lines
      ? state.analysis.lines.filter((line) => !line.blank).map((line) => line.index)
      : null;
    runScan({ preserveAnalysis: Boolean(state.analysis), pendingLineIndexes, resetView: false });
    setNotice(`Rescanning with ${getActiveProfile().label}.`);
  });

  projectsButton.addEventListener('click', () => openProjectsDrawer());
  saveButton.addEventListener('click', () => saveCurrentProject());
  shareButton.addEventListener('click', () => copyShareLink());
  exportPdfButton.addEventListener('click', () => exportPdf());
  clearOverridesButton.addEventListener('click', () => clearAllOverrides());
  editButton.addEventListener('click', () => {
    closeDrawer();
    setMode('edit');
    requestAnimationFrame(() => input.focus());
  });
  overviewButton.addEventListener('click', () => openOverviewDrawer());
  drawerBackdrop.addEventListener('click', () => closeDrawer());
  drawerClose.addEventListener('click', () => closeDrawer());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer();
    }
  });

  window.addEventListener('resize', () => {
    if (document.body.dataset.mode === 'scan') {
      hydrateAnnotatedLines(poemView);
    }

    if (state.drawer.open) {
      hydrateAnnotatedLines(drawerBody);
    }
  });
}

function populateProfileOptions() {
  profileSelect.innerHTML = PROFILE_OPTIONS.map((profile) => {
    return `<option value="${escapeHtml(profile.key)}">${escapeHtml(profile.label)}</option>`;
  }).join('');
  profileSelect.value = state.profile;
}

async function runScan({
  preserveAnalysis = false,
  pendingLineIndexes = null,
  resetView = false
} = {}) {
  const poem = normalizePoem(input.value);
  if (!poem.trim()) return;

  if (state.scan.controller) {
    state.scan.controller.abort();
  }

  const previousAnalysis = preserveAnalysis && state.analysis ? cloneValue(state.analysis) : null;
  const controller = new AbortController();
  const scanId = state.scan.id + 1;
  state.scan.id = scanId;
  state.scan.controller = controller;

  prepareAnalysisForScan(poem, preserveAnalysis ? pendingLineIndexes : null);
  setMode('scan');

  if (resetView) {
    closeDrawer({ keepState: false });
  }

  renderToolbar(state.analysis);
  renderPoem(state.analysis);
  setLoadingPhase('scanning');
  errorBox.textContent = '';

  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poem,
        includeSummary: true,
        stream: true,
        profile: state.profile,
        overrides: state.overrides
      }),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      const data = await readJsonResponse(response);
      throw new Error(data.error || 'Scan failed.');
    }

    if (contentType.includes('application/x-ndjson') && response.body) {
      await consumeProgressStream(response, scanId);
    } else {
      const data = await readJsonResponse(response);
      applyCompleteAnalysis({ ...data, complete: true, summaryPending: false }, scanId);
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (previousAnalysis) {
      state.analysis = previousAnalysis;
      renderToolbar(state.analysis);
      renderPoem(state.analysis);
      renderDrawer();
    }
    errorBox.textContent = error.message || 'Something went wrong.';
  } finally {
    if (scanId === state.scan.id) {
      state.scan.controller = null;
      if (state.scan.phase !== 'idle') {
        setLoadingPhase('idle');
      }
    }
  }
}

function prepareAnalysisForScan(poem, pendingLineIndexes) {
  if (!state.analysis || normalizePoem(state.analysis.poem) !== poem) {
    state.analysis = createProgressAnalysis(poem);
    return;
  }

  const pendingSet = new Set(
    Array.isArray(pendingLineIndexes) && pendingLineIndexes.length
      ? pendingLineIndexes
      : state.analysis.lines.filter((line) => !line.blank).map((line) => line.index)
  );

  state.analysis = {
    ...state.analysis,
    poem,
    overallMeter: 'Scanning...',
    form: {
      primary: null,
      candidates: []
    },
    complete: false,
    summaryPending: true,
    lines: state.analysis.lines.map((line) => {
      if (line.blank) return line;
      return {
        ...line,
        pending: pendingSet.has(line.index)
      };
    })
  };
}

function setLoadingPhase(phase) {
  state.scan.phase = phase;
  const isBusy = phase === 'scanning' || phase === 'finishing';
  const canExport = Boolean(state.analysis?.complete && isAnalysisCurrent());
  const hasPoem = Boolean(normalizePoem(input.value).trim());

  input.readOnly = isBusy;
  scanButton.disabled = isBusy;
  profileSelect.disabled = isBusy;
  projectsButton.disabled = isBusy;
  saveButton.disabled = isBusy || !hasPoem;
  shareButton.disabled = isBusy || !hasPoem;
  exportPdfButton.disabled = isBusy || !canExport;
  clearOverridesButton.disabled = isBusy || !hasAnyOverrides();
  overviewButton.disabled = isBusy || !state.analysis?.complete || !isAnalysisCurrent();
  editButton.disabled = isBusy;

  if (phase === 'scanning') {
    scanButton.textContent = 'Scanning';
    return;
  }

  if (phase === 'finishing') {
    scanButton.textContent = 'Finishing';
    return;
  }

  scanButton.textContent = 'Scan';
}

function setMode(mode) {
  document.body.dataset.mode = mode;
  editButton.hidden = mode !== 'scan';
}

function syncEditorState() {
  const hasText = normalizePoem(input.value).trim().length > 0;
  scanButton.classList.toggle('visible', hasText);
}

function renderEditorLineNumbers() {
  const rawLines = input.value.split('\n');
  const lines = rawLines.length ? rawLines : [''];
  let countedLines = 0;

  editorLineNumbers.innerHTML = lines.map((line) => {
    if (!line.trim()) {
      return '<div class="editor-line-number-row"></div>';
    }

    countedLines += 1;
    return `<div class="editor-line-number-row">${countedLines}</div>`;
  }).join('');
}

function autoResizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.max(420, input.scrollHeight)}px`;
}

function createProgressAnalysis(poem) {
  const lines = normalizePoem(poem).split('\n').map((text, index) => ({
    index,
    text,
    blank: text.trim().length === 0,
    pending: text.trim().length > 0,
    tag: '',
    confidence: 0,
    scans: [],
    tokens: [],
    rhymeLetter: '',
    rhymeMatchType: '',
    rhymeGroupQuality: ''
  }));

  return {
    poem: normalizePoem(poem),
    overallMeter: 'Scanning...',
    form: {
      primary: null,
      candidates: []
    },
    rhyme: {
      overallScheme: '',
      stanzas: [],
      lines: [],
      groups: []
    },
    stanzaResults: [],
    lines,
    diagnostics: {
      averageLineConfidence: 0,
      stanzaCount: 0,
      lineCount: lines.filter((line) => !line.blank).length,
      heuristicWords: [],
      detectedForm: ''
    },
    summary: '',
    complete: false,
    summaryPending: true
  };
}

function renderToolbar(data) {
  const analysisCurrent = isAnalysisCurrent();
  const formLabel = data?.complete && analysisCurrent
    ? data.form?.primary?.label || 'Not identified'
    : data && !analysisCurrent
      ? 'Needs rescan'
      : data
        ? 'Scanning...'
        : '-';
  const meterLabel = data?.complete && analysisCurrent
    ? data.overallMeter || 'Mixed meter'
    : data && !analysisCurrent
      ? 'Needs rescan'
      : data
        ? 'Scanning...'
        : '-';

  overallMeter.textContent = meterLabel;
  overallForm.textContent = formLabel;
  profileSelect.value = state.profile;
  saveButton.textContent = state.activeProjectId ? 'Update save' : 'Save';
  clearOverridesButton.hidden = !hasAnyOverrides();
  projectsButton.textContent = state.savedProjects.length ? `Projects (${state.savedProjects.length})` : 'Projects';
  setLoadingPhase(state.scan.phase);
}

function renderPoem(data) {
  if (!data) {
    poemView.innerHTML = '';
    return;
  }

  let countedLines = 0;
  const rows = data.lines.map((line) => {
    if (line.blank) {
      return `
        <div class="line-row blank" aria-hidden="true">
          <div class="line-number"></div>
          <div class="line-spacer"></div>
          <div class="line-rhyme"></div>
          <div class="line-spacer-meta"></div>
        </div>
      `;
    }

    countedLines += 1;
    return buildLineRowMarkup(line, countedLines);
  });

  poemView.innerHTML = `<div class="poem-grid">${rows.join('')}</div>`;
  hydrateAnnotatedLines(poemView);
  bindPoemLineButtons(poemView);
}

function buildLineRowMarkup(line, lineNumber) {
  const isOverridden = lineHasOverrides(line);
  if (line.pending) {
    return `
      <article class="line-row${isOverridden ? ' overridden' : ''}" data-line-index="${line.index}">
        <div class="line-number">${lineNumber}</div>
        <div class="line-content">
          ${createAnnotatedLineMarkup(line.text, '')}
        </div>
        <div class="line-rhyme"></div>
        <div class="line-meta">
          <div class="line-status" aria-live="polite">
            <span class="line-spinner" aria-hidden="true"></span>
            <span class="sr-only">Scanning line</span>
          </div>
        </div>
      </article>
    `;
  }

  const primary = line.scans?.[0] || {};
  const combined = getCombinedConfidence(primary, line.confidence ?? primary.confidence);
  const rhymeGroup = getRhymeGroup(line.rhymeLetter);
  const rhymeLetter = line.rhymeLetter
    ? `
        <button class="rhyme-button" type="button" data-open-rhyme="${escapeHtml(line.rhymeLetter)}" data-quality="${escapeHtml(rhymeGroup?.quality || line.rhymeGroupQuality || 'unique')}" aria-label="Inspect rhyme group ${escapeHtml(line.rhymeLetter)}">
          <span class="rhyme-letter">${escapeHtml(line.rhymeLetter)}</span>
        </button>
      `
    : '';

  return `
    <article class="line-row${isOverridden ? ' overridden' : ''}" data-line-index="${line.index}">
      <div class="line-number">${lineNumber}</div>
      <div class="line-content">
        ${createAnnotatedLineMarkup(line.text, primary.displayGuide || '')}
      </div>
      <div class="line-rhyme">
        ${rhymeLetter}
      </div>
      <div class="line-meta">
        <button class="line-tag" type="button" data-open-line="${line.index}">
          <span class="tag-head">
            <span class="tag-label">${escapeHtml(primary.meterLabel || line.tag || 'mixed meter')}</span>
            ${isOverridden ? '<span class="tag-note">user override</span>' : ''}
          </span>
          <span class="tag-bar"><span style="width:${combined}%"></span></span>
        </button>
      </div>
    </article>
  `;
}

function bindPoemLineButtons(root) {
  root.querySelectorAll('[data-open-line]').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => openLineDrawer(Number(button.dataset.openLine)));
  });

  root.querySelectorAll('[data-open-rhyme]').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => openRhymeDrawer(button.dataset.openRhyme));
  });
}

function updatePoemLine(lineIndex) {
  const line = state.analysis?.lines?.find((entry) => entry.index === lineIndex);
  if (!line || line.blank) return;

  const row = poemView.querySelector(`[data-line-index="${lineIndex}"]`);
  if (!row) {
    renderPoem(state.analysis);
    return;
  }

  row.outerHTML = buildLineRowMarkup(line, getDisplayedLineNumber(lineIndex));
  const nextRow = poemView.querySelector(`[data-line-index="${lineIndex}"]`);
  if (!nextRow) return;

  hydrateAnnotatedLines(nextRow);
  bindPoemLineButtons(nextRow);
}

async function consumeProgressStream(response, scanId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (chunk) {
        handleProgressEvent(JSON.parse(chunk), scanId);
      }
      boundary = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    handleProgressEvent(JSON.parse(buffer.trim()), scanId);
  }
}

function handleProgressEvent(event, scanId) {
  if (scanId !== state.scan.id) return;

  if (event.type === 'error') {
    throw new Error(event.error || 'Scan failed.');
  }

  if (event.type === 'line') {
    applyProgressLine(event.line);
    return;
  }

  if (event.type === 'complete') {
    applyCompleteAnalysis({
      ...event.analysis,
      complete: true,
      summaryPending: event.analysis?.summary == null
    }, scanId);
    return;
  }

  if (event.type === 'summary') {
    applySummary(event.summary, scanId);
  }
}

function applyProgressLine(line) {
  if (!state.analysis?.lines?.[line.index]) return;

  state.analysis.lines[line.index] = {
    ...line,
    pending: false
  };

  updatePoemLine(line.index);
  if (state.drawer.open && state.drawer.mode === 'line' && state.drawer.lineIndex === line.index) {
    renderDrawer();
  }
}

function applyCompleteAnalysis(analysis, scanId) {
  if (scanId !== state.scan.id) return;

  state.profile = analysis.profile?.key || state.profile;
  state.analysis = {
    ...analysis,
    summary: analysis.summary || state.analysis?.summary || '',
    complete: true,
    summaryPending: Boolean(analysis.summaryPending)
  };

  renderToolbar(state.analysis);
  renderPoem(state.analysis);
  maybeRestorePendingView();

  if (state.drawer.open) {
    renderDrawer();
  }

  setLoadingPhase(state.analysis.summaryPending ? 'finishing' : 'idle');
}

function applySummary(summary, scanId) {
  if (scanId !== state.scan.id || !state.analysis) return;

  state.analysis = {
    ...state.analysis,
    summary: summary || state.analysis.summary,
    summaryPending: false
  };

  if (state.drawer.open) {
    renderDrawer();
  }

  setLoadingPhase('idle');
}

function openOverviewDrawer() {
  if (!state.analysis?.complete || !isAnalysisCurrent()) return;
  state.drawer.open = true;
  state.drawer.mode = 'overview';
  state.drawer.lineIndex = null;
  state.drawer.rhymeLetter = '';
  renderDrawer();
}

function openProjectsDrawer() {
  state.drawer.open = true;
  state.drawer.mode = 'projects';
  state.drawer.lineIndex = null;
  state.drawer.rhymeLetter = '';
  renderDrawer();
}

function openRhymeDrawer(letter) {
  if (!state.analysis?.complete || !letter) return;
  state.drawer.open = true;
  state.drawer.mode = 'rhyme';
  state.drawer.lineIndex = null;
  state.drawer.rhymeLetter = String(letter);
  renderDrawer();
}

function openLineDrawer(lineIndex) {
  const line = state.analysis?.lines?.find((entry) => entry.index === lineIndex);
  if (!state.analysis || !line || line.pending) return;

  state.drawer.open = true;
  state.drawer.mode = 'line';
  state.drawer.lineIndex = lineIndex;
  state.drawer.rhymeLetter = '';
  state.drawer.tokenIndex = Math.max(0, line.tokens.findIndex((token) => token.overrideApplied));
  if (state.drawer.tokenIndex < 0) {
    state.drawer.tokenIndex = 0;
  }
  renderDrawer();
}

function closeDrawer(options = {}) {
  state.drawer.open = false;
  if (!options.keepState) {
    state.drawer.mode = 'overview';
    state.drawer.lineIndex = null;
    state.drawer.rhymeLetter = '';
    state.drawer.tokenIndex = 0;
  }
  renderDrawer();
}

function renderDrawer() {
  const isOpen = state.drawer.open && (Boolean(state.analysis) || state.drawer.mode === 'projects');
  document.body.classList.toggle('drawer-open', isOpen);
  drawer.setAttribute('aria-hidden', String(!isOpen));
  drawerBackdrop.setAttribute('aria-hidden', String(!isOpen));

  if (!isOpen) return;

  if (state.drawer.mode === 'projects') {
    renderProjectsDrawer();
    return;
  }

  if (!state.analysis) return;

  if (state.drawer.mode === 'line') {
    renderLineDrawer();
    return;
  }

  if (state.drawer.mode === 'rhyme') {
    renderRhymeDrawer();
    return;
  }

  renderOverviewDrawer();
}

function renderOverviewDrawer() {
  const analysis = state.analysis;
  if (!analysis?.complete) return;

  const heuristics = analysis.diagnostics?.heuristicWords || [];
  const rhyme = analysis.rhyme || { overallScheme: '', stanzas: [], groups: [] };
  const form = analysis.form?.primary || null;
  const uncertainLines = analysis.lines
    .filter((line) => !line.blank)
    .map((line) => ({
      line,
      combined: getCombinedConfidence(line.scans?.[0], line.confidence)
    }))
    .sort((a, b) => a.combined - b.combined)
    .slice(0, 5);

  drawerKicker.textContent = 'Overview';
  drawerTitle.textContent = analysis.overallMeter || 'Scansion overview';
  drawerSubtitle.textContent = form
    ? `${form.label}. ${form.explanation}`
    : 'No strong poem-level form signal was identified.';

  const summary = analysis.summaryPending
    ? 'Generating summary...'
    : analysis.summary || 'No summary was generated for this poem.';
  const heuristicMarkup = heuristics.length
    ? `<p>${heuristics.map((word) => escapeHtml(word)).join(', ')}</p>`
    : '<p class="empty-panel">Every scanned word was found in the pronunciation layer.</p>';
  const rhymeMarkup = rhyme.groups?.length
    ? `
        <div class="scheme-overall">${escapeHtml(rhyme.overallScheme || '-')}</div>
        <div class="quality-list">
          ${rhyme.groups.map((group) => `
            <button class="drawer-link" type="button" data-open-rhyme="${escapeHtml(group.letter)}">
              <span class="quality-row">
                <span class="quality-pill">
                  <span class="quality-dot" data-quality="${escapeHtml(group.quality || 'unique')}"></span>
                  ${escapeHtml(group.letter)}
                </span>
                <span>${escapeHtml(formatRhymeQuality(group.quality || 'unique'))}</span>
              </span>
              <span class="drawer-link-copy">${group.lines.map((detail) => escapeHtml(detail.word || detail.text)).join(', ')}</span>
            </button>
          `).join('')}
        </div>
      `
    : '<p class="empty-panel">Rhyme letters will appear after the poem scan completes.</p>';
  const uncertainMarkup = uncertainLines.length
    ? uncertainLines.map(({ line, combined }) => `
        <button class="drawer-link" type="button" data-open-uncertain="${line.index}">
          <span class="drawer-link-copy">Line ${getDisplayedLineNumber(line.index)}. ${escapeHtml(line.text)}</span>
          <span class="mini-link-bar"><span style="width:${combined}%"></span></span>
        </button>
      `).join('')
    : '<p class="empty-panel">No uncertainty hotspots were detected.</p>';
  const formSignals = form?.signals?.length
    ? `<div class="signal-list">${form.signals.map((signal) => `<span class="signal-chip">${escapeHtml(signal)}</span>`).join('')}</div>`
    : '<p class="empty-panel">The meter and rhyme did not lock strongly enough to name a specific form.</p>';

  drawerBody.innerHTML = `
    <section class="panel">
      <h3>Summary</h3>
      <p>${escapeHtml(summary)}</p>
    </section>

    <section class="panel">
      <h3>Structure</h3>
      <div class="mini-grid">
        <div class="mini-stat"><span>Profile</span><strong>${escapeHtml(getActiveProfile().label)}</strong></div>
        <div class="mini-stat"><span>Stanzas</span><strong>${analysis.diagnostics?.stanzaCount || 0}</strong></div>
        <div class="mini-stat"><span>Counted lines</span><strong>${analysis.diagnostics?.lineCount || 0}</strong></div>
        <div class="mini-stat"><span>Feminine endings</span><strong>${analysis.diagnostics?.feminineEndingCount || 0}</strong></div>
      </div>
    </section>

    <section class="panel">
      <h3>Detected form</h3>
      <p>${escapeHtml(form?.label || 'Not identified')}</p>
      ${formSignals}
    </section>

    <section class="panel">
      <h3>Rhyme scheme</h3>
      ${rhymeMarkup}
    </section>

    <section class="panel">
      <h3>Fallback pronunciations</h3>
      ${heuristicMarkup}
    </section>

    <section class="panel">
      <h3>Lines to inspect first</h3>
      <div class="mini-grid">${uncertainMarkup}</div>
    </section>
  `;

  drawerBody.querySelectorAll('[data-open-uncertain]').forEach((button) => {
    button.addEventListener('click', () => openLineDrawer(Number(button.dataset.openUncertain)));
  });

  drawerBody.querySelectorAll('[data-open-rhyme]').forEach((button) => {
    button.addEventListener('click', () => openRhymeDrawer(button.dataset.openRhyme));
  });
}

function renderProjectsDrawer() {
  drawerKicker.textContent = 'Projects';
  drawerTitle.textContent = 'Saved analyses';
  drawerSubtitle.textContent = state.savedProjects.length
    ? 'Saved locally in this browser. Loading a project restores its poem, profile, and overrides.'
    : 'Save a poem to keep its profile, overrides, and current reading context without a login.';

  drawerBody.innerHTML = state.savedProjects.length
    ? state.savedProjects.map((project) => `
        <section class="project-card">
          <div class="project-head">
            <div>
              <h3 class="project-title">${escapeHtml(project.title)}</h3>
              <div class="project-meta">${escapeHtml(profileLabelFor(project.profile))} - Updated ${escapeHtml(formatDateTime(project.updatedAt))}</div>
            </div>
          </div>
          <div class="project-actions">
            <button class="project-action" type="button" data-load-project="${escapeHtml(project.id)}">Load</button>
            <button class="project-action" type="button" data-delete-project="${escapeHtml(project.id)}">Delete</button>
          </div>
        </section>
      `).join('')
    : `
        <section class="panel">
          <p class="empty-panel">No projects are saved yet.</p>
        </section>
      `;

  drawerBody.querySelectorAll('[data-load-project]').forEach((button) => {
    button.addEventListener('click', () => {
      const project = state.savedProjects.find((entry) => entry.id === button.dataset.loadProject);
      if (project) {
        applyProjectState(project, { shouldScan: true, notice: `Loaded ${project.title}.` });
      }
    });
  });

  drawerBody.querySelectorAll('[data-delete-project]').forEach((button) => {
    button.addEventListener('click', () => deleteProject(button.dataset.deleteProject));
  });
}

function renderRhymeDrawer() {
  const group = getRhymeGroup(state.drawer.rhymeLetter);
  if (!group) {
    renderOverviewDrawer();
    return;
  }

  drawerKicker.textContent = `Rhyme ${group.letter}`;
  drawerTitle.textContent = `${group.letter} - ${formatRhymeQuality(group.quality || 'unique')}`;
  drawerSubtitle.textContent = describeRhymeQuality(group.quality || 'unique');

  drawerBody.innerHTML = `
    <section class="panel">
      <h3>Matched endings</h3>
      <div class="quality-list">
        ${group.lines.map((detail) => `
          <button class="drawer-link" type="button" data-open-group-line="${detail.index}">
            <span class="quality-row">
              <span class="quality-pill">
                <span class="quality-dot" data-quality="${escapeHtml(detail.matchType || group.quality || 'unique')}"></span>
                Line ${getDisplayedLineNumber(detail.index)}
              </span>
              <span>${escapeHtml(detail.word || '')}</span>
            </span>
            <span class="drawer-link-copy">${escapeHtml(detail.explanation || '')}</span>
          </button>
        `).join('')}
      </div>
    </section>
  `;

  drawerBody.querySelectorAll('[data-open-group-line]').forEach((button) => {
    button.addEventListener('click', () => openLineDrawer(Number(button.dataset.openGroupLine)));
  });
}

function renderLineDrawer() {
  const line = state.analysis?.lines.find((entry) => entry.index === state.drawer.lineIndex);
  if (!line || line.blank) {
    renderOverviewDrawer();
    return;
  }

  if (line.pending) {
    drawerKicker.textContent = `Line ${getDisplayedLineNumber(line.index)}`;
    drawerTitle.textContent = line.text;
    drawerSubtitle.textContent = 'This line is still scanning.';
    drawerBody.innerHTML = `
      <section class="panel">
        <p class="empty-panel">Scansion details for this line will appear as soon as the scan is ready.</p>
      </section>
    `;
    return;
  }

  const primary = line.scans?.[0] || {};
  const lineNumberValue = getDisplayedLineNumber(line.index);
  const cards = (line.scans || []).slice(0, 3).map((scan, scanIndex) => renderScanCard(line, scan, primary, scanIndex)).join('');
  const overridePanel = renderOverridePanel(line);

  drawerKicker.textContent = `Line ${lineNumberValue}`;
  drawerTitle.textContent = line.text;
  drawerSubtitle.textContent = `${state.analysis?.complete ? 'Best' : 'Current'} reading: ${primary.meterLabel || line.tag || 'mixed meter'}${line.rhymeLetter ? `. Rhyme ${line.rhymeLetter}.` : '.'}`;
  drawerBody.innerHTML = `
    ${cards || '<section class="panel"><p class="empty-panel">No alternate scans are available for this line.</p></section>'}
    ${overridePanel}
  `;

  hydrateAnnotatedLines(drawerBody);
  bindLineDrawerActions(line);
}

function renderScanCard(line, scan, primary, scanIndex) {
  const notes = (scan.observations || []).length ? scan.observations.join(', ') : '';
  const noteMarkup = notes ? `<p class="candidate-note">${escapeHtml(notes)}</p>` : '';
  const combined = getCombinedConfidence(scan);
  const diffIndexes = scan.isPrimary ? [] : getGuideDifferenceIndexes(scan.displayGuide || '', primary?.displayGuide || '');

  return `
    <article class="candidate-card${scan.isPrimary ? ' primary' : ''}">
      <div class="candidate-top">
        <div class="candidate-title-wrap">
          <div class="candidate-rank">${scan.isPrimary ? 'Top reading' : `Reading ${scanIndex + 1}`}</div>
          <h3 class="candidate-title">${escapeHtml(scan.meterLabel)}</h3>
        </div>
        <div class="candidate-metrics">
          <span class="candidate-bar"><span style="width:${combined}%"></span></span>
        </div>
      </div>

      ${createAnnotatedLineMarkup(line.text, scan.displayGuide || '', 'drawer-annotated', diffIndexes)}
      ${noteMarkup}
    </article>
  `;
}

function renderOverridePanel(line) {
  const selectedToken = line.tokens[state.drawer.tokenIndex] || line.tokens[0];
  if (!selectedToken) {
    return `
      <section class="panel">
        <h3>Pronunciation overrides</h3>
        <p class="empty-panel">No editable tokens were found on this line.</p>
      </section>
    `;
  }

  const tokenButtons = line.tokens.map((token, tokenIndex) => `
    <button class="token-button${tokenIndex === state.drawer.tokenIndex ? ' active' : ''}" type="button" data-select-token="${tokenIndex}">
      <span class="token-word">${escapeHtml(token.raw)}</span>
      <span class="token-meta">${escapeHtml(formatStressPattern(token.activeVariant?.stress || ''))}${token.overrideApplied ? ' - override' : ''}</span>
    </button>
  `).join('');

  const optionsMarkup = selectedToken.options.map((option, optionIndex) => `
    <button class="option-button${optionMatchesTokenSelection(option, selectedToken) ? ' active' : ''}" type="button" data-apply-option="${optionIndex}">
      <span class="option-pattern">${escapeHtml(formatStressPattern(option.stressPattern || ''))}</span>
      <span class="option-meta">${escapeHtml(option.pronunciation || option.source || '')}</span>
    </button>
  `).join('');

  return `
    <section class="panel">
      <h3>Pronunciation overrides</h3>
      <div class="token-grid">${tokenButtons}</div>
      <div class="override-detail">
        <div class="override-head">
          <div>
            <h4 class="override-title">${escapeHtml(selectedToken.raw)}</h4>
            <div class="project-meta">Choose a candidate pronunciation or clear the current override.</div>
          </div>
        </div>
        <div class="override-data">
          <div><strong>Active stress</strong> ${escapeHtml(formatStressPattern(selectedToken.activeVariant?.stress || ''))}</div>
          <div><strong>Pronunciation</strong> ${escapeHtml(selectedToken.activeVariant?.pronunciation || 'Unavailable')}</div>
        </div>
        <div class="option-list">${optionsMarkup}</div>
        <div class="inline-actions">
          <button class="secondary-button" type="button" data-clear-token="true">Clear this word</button>
          <button class="secondary-button" type="button" data-clear-line-overrides="${line.index}">Clear line overrides</button>
          <button class="secondary-button" type="button" data-clear-all-overrides="true">Clear all overrides</button>
        </div>
      </div>
    </section>
  `;
}

function bindLineDrawerActions(line) {
  drawerBody.querySelectorAll('[data-select-token]').forEach((button) => {
    button.addEventListener('click', () => {
      state.drawer.tokenIndex = Number(button.dataset.selectToken);
      renderLineDrawer();
    });
  });

  drawerBody.querySelectorAll('[data-apply-option]').forEach((button) => {
    button.addEventListener('click', () => {
      applyTokenOption(line.index, state.drawer.tokenIndex, Number(button.dataset.applyOption));
    });
  });

  drawerBody.querySelector('[data-clear-token="true"]')?.addEventListener('click', () => {
    clearTokenOverride(line.index, state.drawer.tokenIndex);
  });

  drawerBody.querySelector('[data-clear-line-overrides]')?.addEventListener('click', () => {
    clearLineOverrides(line.index);
  });

  drawerBody.querySelector('[data-clear-all-overrides="true"]')?.addEventListener('click', () => {
    clearAllOverrides();
  });
}

function applyTokenOption(lineIndex, tokenIndex, optionIndex) {
  const line = state.analysis?.lines.find((entry) => entry.index === lineIndex);
  const token = line?.tokens?.[tokenIndex];
  const option = token?.options?.[optionIndex];
  if (!line || !token || !option) return;

  const key = `${lineIndex}:${token.index}`;
  const matchesActive = option.stressPattern === (token.activeVariant?.stress || '') && option.pronunciation === (token.activeVariant?.pronunciation || '');
  if (matchesActive && !token.overrideApplied) {
    delete state.overrides.tokens[key];
  } else {
    state.overrides.tokens[key] = {
      stressPattern: option.stressPattern,
      pronunciation: option.pronunciation || token.activeVariant?.pronunciation || token.raw,
      label: option.source || 'user override'
    };
  }

  state.overrides = sanitizeOverrides(state.overrides);
  renderToolbar(state.analysis);
  setNotice(`Updated ${token.raw}.`);
  runScan({ preserveAnalysis: true, pendingLineIndexes: [lineIndex], resetView: false });
}

function clearTokenOverride(lineIndex, tokenIndex) {
  const line = state.analysis?.lines.find((entry) => entry.index === lineIndex);
  const token = line?.tokens?.[tokenIndex];
  if (!token) return;

  delete state.overrides.tokens[`${lineIndex}:${token.index}`];
  state.overrides = sanitizeOverrides(state.overrides);
  renderToolbar(state.analysis);
  setNotice(`Cleared the override on ${token.raw}.`);
  runScan({ preserveAnalysis: true, pendingLineIndexes: [lineIndex], resetView: false });
}

function clearLineOverrides(lineIndex) {
  const keys = Object.keys(state.overrides.tokens).filter((key) => key.startsWith(`${lineIndex}:`));
  if (!keys.length) {
    setNotice('That line has no overrides to clear.');
    return;
  }

  keys.forEach((key) => delete state.overrides.tokens[key]);
  state.overrides = sanitizeOverrides(state.overrides);
  renderToolbar(state.analysis);
  setNotice(`Cleared overrides on line ${getDisplayedLineNumber(lineIndex)}.`);
  runScan({ preserveAnalysis: true, pendingLineIndexes: [lineIndex], resetView: false });
}

function clearAllOverrides() {
  if (!hasAnyOverrides()) {
    setNotice('There are no overrides to clear.');
    return;
  }

  state.overrides = cloneValue(EMPTY_OVERRIDES);
  renderToolbar(state.analysis);
  setNotice('Cleared all user overrides.');

  if (normalizePoem(input.value).trim()) {
    const pendingLineIndexes = state.analysis?.lines
      ? state.analysis.lines.filter((line) => !line.blank).map((line) => line.index)
      : null;
    runScan({ preserveAnalysis: Boolean(state.analysis), pendingLineIndexes, resetView: false });
  }
}

function saveCurrentProject() {
  const poem = normalizePoem(input.value);
  if (!poem.trim()) {
    setNotice('Paste a poem before saving.', true);
    return;
  }

  const existing = state.savedProjects.find((project) => project.id === state.activeProjectId);
  const record = createProjectRecord({
    id: existing?.id,
    createdAt: existing?.createdAt,
    poem,
    profile: state.profile,
    overrides: state.overrides,
    view: buildProjectViewState()
  });

  state.savedProjects = mergeProjectRecord(state.savedProjects, record);
  state.activeProjectId = record.id;
  saveProjectsToStorage();
  renderToolbar(state.analysis);
  if (state.drawer.open && state.drawer.mode === 'projects') {
    renderProjectsDrawer();
  }
  setNotice(`Saved ${record.title}.`);
}

function applyProjectState(project, { shouldScan = true, notice = '' } = {}) {
  state.activeProjectId = project.id || '';
  state.profile = project.profile || 'modern';
  state.overrides = sanitizeOverrides(project.overrides);
  state.pendingView = project.view || null;

  input.value = normalizePoem(project.poem || '');
  syncEditorState();
  renderEditorLineNumbers();
  autoResizeInput();
  renderToolbar(state.analysis);
  closeDrawer({ keepState: false });

  if (shouldScan && normalizePoem(project.poem).trim()) {
    runScan({ preserveAnalysis: false, resetView: false });
  } else {
    setMode('edit');
  }

  if (notice) {
    setNotice(notice);
  }
}

function deleteProject(projectId) {
  const project = state.savedProjects.find((entry) => entry.id === projectId);
  state.savedProjects = state.savedProjects.filter((entry) => entry.id !== projectId);
  if (state.activeProjectId === projectId) {
    state.activeProjectId = '';
  }
  saveProjectsToStorage();
  renderToolbar(state.analysis);
  renderProjectsDrawer();
  setNotice(project ? `Deleted ${project.title}.` : 'Project deleted.');
}

async function copyShareLink() {
  const poem = normalizePoem(input.value);
  if (!poem.trim()) {
    setNotice('Paste a poem before creating a share link.', true);
    return;
  }

  const shareState = {
    poem,
    profile: state.profile,
    overrides: state.overrides,
    view: buildProjectViewState()
  };
  const encoded = encodeShareState(shareState);
  const shareUrl = `${window.location.origin}${window.location.pathname}#share=${encoded}`;

  try {
    await navigator.clipboard.writeText(shareUrl);
    history.replaceState(null, '', `#share=${encoded}`);
    setNotice('Share link copied.');
  } catch {
    window.prompt('Copy this share link', shareUrl);
  }
}

function exportPdf() {
  if (!state.analysis?.complete || !isAnalysisCurrent()) {
    setNotice('Run a current scan before exporting.', true);
    return;
  }

  const documentHtml = buildPrintableDocument({
    analysis: state.analysis,
    profileLabel: getActiveProfile().label,
    title: makeProjectTitle(input.value)
  });
  triggerPrintDocument(documentHtml);
  setNotice('Preparing the print dialog for PDF export.');
}

function buildProjectViewState() {
  if (!state.drawer.open) {
    return { mode: 'overview', lineIndex: null, rhymeLetter: '' };
  }

  return {
    mode: state.drawer.mode,
    lineIndex: state.drawer.mode === 'line' ? state.drawer.lineIndex : null,
    rhymeLetter: state.drawer.mode === 'rhyme' ? state.drawer.rhymeLetter : ''
  };
}

function maybeRestorePendingView() {
  if (!state.pendingView || !state.analysis?.complete) return;
  const view = state.pendingView;
  state.pendingView = null;

  if (view.mode === 'line' && Number.isInteger(view.lineIndex)) {
    openLineDrawer(view.lineIndex);
    return;
  }

  if (view.mode === 'rhyme' && view.rhymeLetter) {
    openRhymeDrawer(view.rhymeLetter);
    return;
  }

  if (view.mode === 'overview') {
    openOverviewDrawer();
  }
}

function getDisplayedLineNumber(targetIndex) {
  if (!state.analysis) return '';

  let count = 0;
  for (const line of state.analysis.lines) {
    if (line.blank) continue;
    count += 1;
    if (line.index === targetIndex) return count;
  }

  return '';
}

function getCombinedConfidence(scan, contextOverride) {
  const fit = formatPercent(scan?.score ?? 0);
  const context = formatPercent(contextOverride ?? scan?.confidence ?? 0);
  return Math.round((fit * context) / 100);
}

function createAnnotatedLineMarkup(text, guide, extraClass = '', diffIndexes = []) {
  const className = extraClass ? `annotated-line ${extraClass}` : 'annotated-line';
  return `
    <div class="${className}" data-annotated-text="${escapeHtml(text)}" data-annotated-guide="${escapeHtml(guide || '')}" data-annotated-diff="${escapeHtml((diffIndexes || []).join(','))}">
      <div class="annotation-layer"></div>
      <div class="annotated-text">${escapeHtml(text)}</div>
    </div>
  `;
}

function hydrateAnnotatedLines(root) {
  root.querySelectorAll('[data-annotated-text]').forEach((container) => {
    const text = container.getAttribute('data-annotated-text') || '';
    const guide = container.getAttribute('data-annotated-guide') || '';
    const diffIndexes = new Set((container.getAttribute('data-annotated-diff') || '')
      .split(',')
      .filter(Boolean)
      .map((value) => Number(value)));
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
      const displayMarker = markerValue === 'u' ? '\u02D8' : markerValue;
      const markerClass = markerValue === 'u' ? 'unstressed' : markerValue === '|' ? 'break' : 'stressed';
      marker.className = `annotated-mark ${markerClass}${diffIndexes.has(index) ? ' diff' : ''}`;
      marker.textContent = displayMarker;
      marker.style.left = `${rect.left - containerRect.left + rect.width / 2}px`;
      marker.style.top = markerClass === 'break' ? '1px' : '0px';
      annotationLayer.appendChild(marker);
    }
  });
}

function getGuideDifferenceIndexes(guide, primaryGuide) {
  const output = [];
  const limit = Math.max(guide.length, primaryGuide.length);

  for (let index = 0; index < limit; index += 1) {
    const marker = guide[index] || ' ';
    const baseline = primaryGuide[index] || ' ';
    if (marker !== ' ' && marker !== baseline) {
      output.push(index);
    }
  }

  return output;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const message = text.trim().split('\n')[0] || `Scan failed with status ${response.status}.`;
    throw new Error(message);
  }
}

function getRhymeGroup(letter) {
  if (!letter || !state.analysis?.rhyme?.groups) return null;
  return state.analysis.rhyme.groups.find((group) => group.letter === letter) || null;
}

function lineHasOverrides(line) {
  return Boolean(
    line?.tokens?.some((token) => token.overrideApplied) ||
    Object.keys(state.overrides.tokens).some((key) => key.startsWith(`${line.index}:`))
  );
}

function hasAnyOverrides() {
  return Object.keys(state.overrides.tokens || {}).length > 0 || Object.keys(state.overrides.words || {}).length > 0;
}

function optionMatchesTokenSelection(option, token) {
  return option?.stressPattern === (token?.activeVariant?.stress || '') && option?.pronunciation === (token?.activeVariant?.pronunciation || '');
}

function isAnalysisCurrent() {
  return Boolean(state.analysis && normalizePoem(input.value) === normalizePoem(state.analysis.poem || ''));
}

function getActiveProfile() {
  return PROFILE_OPTIONS.find((profile) => profile.key === state.profile) || PROFILE_OPTIONS[0];
}

function profileLabelFor(key) {
  return PROFILE_OPTIONS.find((profile) => profile.key === key)?.label || key;
}

function formatStressPattern(pattern) {
  const cleaned = String(pattern || '').replace(/[^su]/g, '');
  if (!cleaned) return 'No stress data';
  return cleaned.split('').map((value) => value === 's' ? '/' : '\u02D8').join(' ');
}

function formatRhymeQuality(value) {
  const label = String(value || 'unique').replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function describeRhymeQuality(value) {
  switch (value) {
    case 'perfect':
      return 'The matched lines share the stressed vowel and full closing sound.';
    case 'slant':
      return 'The lines lean on a near-sound match rather than an exact rhyme.';
    case 'consonance':
      return 'The lines close on similar consonant sounds more than a shared vowel.';
    case 'eye':
      return 'The spelling match is stronger than the spoken rhyme.';
    case 'weak':
      return 'The link is loose and should be treated cautiously.';
    default:
      return 'This letter marks a unique end sound that does not yet repeat elsewhere.';
  }
}

function setNotice(message, isError = false) {
  noticeBox.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  noticeBox.textContent = message || '';
}

function loadSavedProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => createProjectRecord(entry));
  } catch {
    return [];
  }
}

function saveProjectsToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedProjects));
}

function triggerPrintDocument(documentHtml) {
  document.getElementById('scansionPrintFrame')?.remove();

  const frame = document.createElement('iframe');
  frame.id = 'scansionPrintFrame';
  frame.title = 'Scansion PDF export';
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.opacity = '0.01';
  frame.style.border = '0';
  frame.style.pointerEvents = 'none';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);

  frame.addEventListener('load', () => {
    const cleanup = () => {
      window.removeEventListener('focus', cleanup);
      setTimeout(() => frame.remove(), 600);
    };
    window.addEventListener('focus', cleanup, { once: true });
  }, { once: true });

  frame.srcdoc = documentHtml;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
