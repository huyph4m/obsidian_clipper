/**
 * Unified Workspace Controller (`workspace.js`)
 * Powers `sidepanel.html` (default view) and `popup.html`:
 * - Strictly separates Obsidian Note Properties (metadata) from the Note Body
 * - AI Summary is inserted directly into the Note Body inside a `> [!abstract] AI Summary` callout block
 * - Phase 4 In-Page Web Annotator Sidebar ("Annotations" Tab):
 *   - Lists all annotations for the current page, filterable by type, color, or search query
 *   - Click any annotation card to scroll to & flash it on the page
 *   - Inline edit comment, change color, manage tags, soft-delete with Undo, and re-attach orphaned annotations
 *   - Offers 1-click "Always Restore on Site" (`chrome.permissions.request`) per-origin host permission flow
 *   - Bi-directionally syncs the managed `## Annotations` block (`<!-- obsidian-clipper:annotations:start/end -->` with `^ann-xxxx` block IDs) with Obsidian!
 *   - AI "Digest" (summarize my annotations) & AI "Suggest" (propose key verbatim sentences to accept/reject as highlights)
 */

import { getSettings, saveSettings } from './services/storage.js';
import { ObsidianClient } from './services/obsidian-api.js';
import { LLMService } from './services/llm-service.js';
import {
  htmlToMarkdown,
  sanitizeFileName,
  normalizeObsidianTag,
  buildNoteFromTemplate,
  parseObsidianProperties,
  buildFullMarkdownWithProperties,
  upsertSummaryCalloutInBody
} from './services/markdown-converter.js';
import { normalizePageUrl } from './services/annotation-anchor.js';
import {
  AnnotationStore,
  HIGHLIGHT_COLORS,
  upsertAnnotationsSectionInMarkdown,
  parseAnnotationsFromObsidianMarkdown,
  reconcileAnnotationsWithObsidian
} from './services/annotation-store.js';

// State
let settings = null;
let obsidian = null;
let llm = null;
const annotationStore = new AnnotationStore();
let activeTab = null;
let pageData = null;
let allVaultFolders = [];
let currentTags = [];
let currentSummary = '';
let customProperties = {};
let pageAnnotations = [];
let lastDeletedAnnotationId = null;
let pageImages = [];
let linkedVaultPath = null;
let lastVaultModifiedTime = null;
let localDirty = false;
let liveSyncIntervalId = null;

// DOM Elements
const els = {
  connectionStatusPill: document.getElementById('connectionStatusPill'),
  connectionStatusText: document.getElementById('connectionStatusText'),
  openSidePanelBtn: document.getElementById('openSidePanelBtn'),
  openInObsidianBtn: document.getElementById('openInObsidianBtn'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  noteTitleInput: document.getElementById('noteTitleInput'),
  folderSelect: document.getElementById('folderSelect'),
  folderFilterInput: document.getElementById('folderFilterInput'),
  refreshFoldersBtn: document.getElementById('refreshFoldersBtn'),
  captureModeSelect: document.getElementById('captureModeSelect'),
  templateSelect: document.getElementById('templateSelect'),
  recapturePageBtn: document.getElementById('recapturePageBtn'),
  syncBanner: document.getElementById('syncBanner'),
  syncBannerText: document.getElementById('syncBannerText'),
  pullFromVaultBtn: document.getElementById('pullFromVaultBtn'),
  pushToVaultBtn: document.getElementById('pushToVaultBtn'),
  aiAutoTagBtn: document.getElementById('aiAutoTagBtn'),
  aiSummarizeBtn: document.getElementById('aiSummarizeBtn'),
  aiTransformSelect: document.getElementById('aiTransformSelect'),
  pickImageOnPageBtn: document.getElementById('pickImageOnPageBtn'),

  // Obsidian Note Properties UI
  togglePropertiesBtn: document.getElementById('togglePropertiesBtn'),
  propertiesChevron: document.getElementById('propertiesChevron'),
  propertiesBody: document.getElementById('propertiesBody'),
  propertiesCountBadge: document.getElementById('propertiesCountBadge'),
  addCustomPropertyBtn: document.getElementById('addCustomPropertyBtn'),
  propSourceInput: document.getElementById('propSourceInput'),
  propAuthorInput: document.getElementById('propAuthorInput'),
  propCreatedInput: document.getElementById('propCreatedInput'),
  propStatusInput: document.getElementById('propStatusInput'),
  propDescriptionInput: document.getElementById('propDescriptionInput'),
  customPropertiesList: document.getElementById('customPropertiesList'),
  tagChipsContainer: document.getElementById('tagChipsContainer'),
  addTagInput: document.getElementById('addTagInput'),

  // Annotations Tab UI
  annotatorEnabledToggle: document.getElementById('annotatorEnabledToggle'),
  annotatorStateBadge: document.getElementById('annotatorStateBadge'),
  annotationsCountBadge: document.getElementById('annotationsCountBadge'),
  sitePermissionBanner: document.getElementById('sitePermissionBanner'),
  sitePermissionText: document.getElementById('sitePermissionText'),
  grantSitePermissionBtn: document.getElementById('grantSitePermissionBtn'),
  addStickyNoteBtn: document.getElementById('addStickyNoteBtn'),
  addAreaAnnotationBtn: document.getElementById('addAreaAnnotationBtn'),
  addPageNoteBtn: document.getElementById('addPageNoteBtn'),
  addBookmarkMarkerBtn: document.getElementById('addBookmarkMarkerBtn'),
  aiSuggestHighlightsBtn: document.getElementById('aiSuggestHighlightsBtn'),
  aiSummarizeAnnotationsBtn: document.getElementById('aiSummarizeAnnotationsBtn'),
  annSearchInput: document.getElementById('annSearchInput'),
  annFilterTypeSelect: document.getElementById('annFilterTypeSelect'),
  annFilterColorSelect: document.getElementById('annFilterColorSelect'),
  aiSuggestionsContainer: document.getElementById('aiSuggestionsContainer'),
  undoDeleteBanner: document.getElementById('undoDeleteBanner'),
  undoDeleteAnnotationBtn: document.getElementById('undoDeleteAnnotationBtn'),
  annotationsListContainer: document.getElementById('annotationsListContainer'),
  exportAnnotationsJsonBtn: document.getElementById('exportAnnotationsJsonBtn'),
  importAnnotationsJsonBtn: document.getElementById('importAnnotationsJsonBtn'),
  importAnnotationsFileInput: document.getElementById('importAnnotationsFileInput'),
  syncAnnotationsToObsidianBtn: document.getElementById('syncAnnotationsToObsidianBtn'),

  relevantCountBadge: document.getElementById('relevantCountBadge'),
  imagesCountBadge: document.getElementById('imagesCountBadge'),
  editorContainer: document.getElementById('editorContainer'),
  markdownEditor: document.getElementById('markdownEditor'),
  markdownPreview: document.getElementById('markdownPreview'),
  viewEditBtn: document.getElementById('viewEditBtn'),
  viewSplitBtn: document.getElementById('viewSplitBtn'),
  viewPreviewBtn: document.getElementById('viewPreviewBtn'),
  vaultSearchInput: document.getElementById('vaultSearchInput'),
  vaultSearchBtn: document.getElementById('vaultSearchBtn'),
  relevantNotesList: document.getElementById('relevantNotesList'),
  imagesGrid: document.getElementById('imagesGrid'),
  saveAllImagesBtn: document.getElementById('saveAllImagesBtn'),
  workspaceToast: document.getElementById('workspaceToast'),
  liveBiSyncToggle: document.getElementById('liveBiSyncToggle'),
  wordCountLabel: document.getElementById('wordCountLabel'),
  appendDailyNoteBtn: document.getElementById('appendDailyNoteBtn'),
  saveToObsidianBtn: document.getElementById('saveToObsidianBtn')
};

function showToast(message, isError = false) {
  if (!els.workspaceToast) return;
  els.workspaceToast.textContent = message;
  els.workspaceToast.className = `workspace-toast ${isError ? 'error' : ''}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    els.workspaceToast.classList.add('hidden');
  }, 3800);
}

/**
 * Initialize Workspace on SidePanel / Popup Load
 */
async function initWorkspace() {
  settings = await getSettings();
  obsidian = new ObsidianClient(settings);
  llm = new LLMService(settings);

  populateTemplateDropdown();
  syncAnnotatorEnabledUI();
  bindUIEvents();

  // 1. Check Obsidian REST API status & load all available vault folders
  await checkObsidianConnectionAndFolders();

  // 2. Get active browser tab & inject content script via activeTab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  await loadPageAnnotations();
  await captureActivePage(els.captureModeSelect.value);

  // 3. Find relevant notes & check if current page URL already exists in Obsidian
  if (activeTab?.url) {
    await discoverRelevantNotesAndCheckSync();
  }

  // 4. Configure auto bi-directional sync if enabled in settings
  if (settings.autoSyncOnEdit) {
    els.liveBiSyncToggle.checked = true;
    startLiveBiDirectionalSync();
  }

  // 5. Listen for real-time annotation & settings updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.obsidianCompanionSettings) {
        settings = changes.obsidianCompanionSettings.newValue || settings;
        syncAnnotatorEnabledUI();
      }
      if (changes.obsidianAnnotationsByUrl && activeTab?.url) {
        loadPageAnnotations();
      }
    }
  });

  // 6. Listen for active tab switches while Side Panel remains open
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const updatedTab = await chrome.tabs.get(tabId);
      if (updatedTab && updatedTab.url !== activeTab?.url && !localDirty) {
        activeTab = updatedTab;
        linkedVaultPath = null;
        currentSummary = '';
        els.syncBanner.classList.add('hidden');
        await loadPageAnnotations();
        await captureActivePage(els.captureModeSelect.value);
        await discoverRelevantNotesAndCheckSync();
      }
    } catch (_) {}
  });
}


function syncAnnotatorEnabledUI() {
  const isEnabled = settings?.annotatorEnabled !== false;
  if (els.annotatorEnabledToggle) {
    els.annotatorEnabledToggle.checked = isEnabled;
  }
  if (els.annotatorStateBadge) {
    els.annotatorStateBadge.textContent = isEnabled ? 'Enabled' : 'Disabled';
    els.annotatorStateBadge.style.background = isEnabled
      ? 'rgba(16, 185, 129, 0.2)'
      : 'rgba(239, 68, 68, 0.2)';
    els.annotatorStateBadge.style.color = isEnabled ? '#6ee7b7' : '#fca5a5';
  }
  const controls = [
    els.addStickyNoteBtn,
    els.addAreaAnnotationBtn,
    els.addPageNoteBtn,
    els.addBookmarkMarkerBtn,
    els.aiSuggestHighlightsBtn,
    els.aiSummarizeAnnotationsBtn,
    els.syncAnnotationsToObsidianBtn
  ];
  controls.forEach((btn) => {
    if (btn) btn.disabled = !isEnabled;
  });
}

function populateTemplateDropdown() {
  const templates = settings.templates || [];
  els.templateSelect.innerHTML = '';
  for (const tpl of templates) {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    if (tpl.id === settings.selectedTemplateId) {
      opt.selected = true;
    }
    els.templateSelect.appendChild(opt);
  }
}

async function checkObsidianConnectionAndFolders() {
  const status = await obsidian.checkConnection();
  if (status.connected) {
    els.connectionStatusPill.className = 'status-pill connected';
    els.connectionStatusText.textContent = 'Vault Connected';
    await loadFoldersIntoSelect();
  } else {
    els.connectionStatusPill.className = 'status-pill disconnected';
    els.connectionStatusText.textContent = 'Offline (Configure API)';
    allVaultFolders = ['/', settings.defaultFolder || 'Clippings', 'Daily Notes', 'Research', 'Bookmarks'];
    setFolderOptions(allVaultFolders, settings.defaultFolder || 'Clippings');
  }
}

async function loadFoldersIntoSelect() {
  const discovered = await obsidian.listFolders('', 8);
  const defaultFolder = settings.defaultFolder || 'Clippings';
  allVaultFolders = Array.from(new Set(['/', defaultFolder, ...discovered]));
  setFolderOptions(allVaultFolders, els.folderSelect.value || defaultFolder);
}

function setFolderOptions(folders, selectedFolder = null) {
  const currentVal =
    selectedFolder !== null
      ? selectedFolder
      : els.folderSelect.value || settings.defaultFolder || 'Clippings';

  els.folderSelect.innerHTML = '';
  for (const folder of folders) {
    const opt = document.createElement('option');
    opt.value = folder === '/' ? '' : folder;
    opt.textContent = folder === '/' ? '/ (Vault Root)' : `📁 ${folder}`;
    if (opt.value === currentVal) {
      opt.selected = true;
    }
    els.folderSelect.appendChild(opt);
  }
}

function ensureFolderOptionExists(folderName) {
  const clean = (folderName || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return;
  if (!allVaultFolders.includes(clean)) {
    allVaultFolders.push(clean);
    allVaultFolders.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  }
  const exists = Array.from(els.folderSelect.options).some((o) => o.value === clean);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = clean;
    opt.textContent = `📁 ${clean}`;
    els.folderSelect.appendChild(opt);
  }
}

/**
 * Collect current Obsidian Note Properties from the UI Panel (includes `annotations_count`)
 */
function collectPropertiesFromUI() {
  let domain = '';
  try {
    domain = new URL(els.propSourceInput.value || activeTab?.url || 'https://example.com').hostname.replace(
      /^www\./,
      ''
    );
  } catch (_) {}

  const activeAnnCount = pageAnnotations.filter((a) => a.status !== 'deleted').length;

  const props = {
    title: els.noteTitleInput.value.trim() || 'Untitled',
    source: normalizePageUrl(els.propSourceInput.value.trim() || activeTab?.url || ''),
    domain,
    author: els.propAuthorInput.value.trim() || 'Unknown',
    created: els.propCreatedInput.value || new Date().toISOString().slice(0, 10),
    status: els.propStatusInput.value || 'unread',
    description: els.propDescriptionInput.value.trim(),
    annotations_count: activeAnnCount,
    ...customProperties,
    tags: currentTags.map(normalizeObsidianTag).filter(Boolean)
  };

  updatePropertiesCountBadge(props);
  return props;
}

function populatePropertiesUI(properties = {}) {
  if (properties.title) els.noteTitleInput.value = sanitizeFileName(String(properties.title));
  els.propSourceInput.value = properties.source || properties.url || normalizePageUrl(activeTab?.url || '');
  els.propAuthorInput.value = properties.author || 'Unknown';
  els.propCreatedInput.value =
    properties.created || properties.date || new Date().toISOString().slice(0, 10);
  els.propStatusInput.value = properties.status || 'unread';
  els.propDescriptionInput.value = properties.description || '';

  if (Array.isArray(properties.tags)) {
    currentTags = properties.tags.map(normalizeObsidianTag).filter(Boolean);
    renderTagChips();
  }

  const reservedKeys = new Set([
    'title',
    'source',
    'url',
    'domain',
    'author',
    'published',
    'created',
    'date',
    'status',
    'description',
    'summary',
    'annotations_count',
    'tags'
  ]);

  customProperties = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!reservedKeys.has(k)) {
      customProperties[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    }
  }
  renderCustomPropertiesRows();
  updatePropertiesCountBadge(collectPropertiesFromUI());
}

function updatePropertiesCountBadge(props) {
  const count = Object.keys(props || {}).length;
  if (els.propertiesCountBadge) {
    els.propertiesCountBadge.textContent = String(count);
  }
}

function renderCustomPropertiesRows() {
  els.customPropertiesList.innerHTML = '';
  for (const [key, val] of Object.entries(customProperties)) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `
      <span class="prop-key">&#9881; ${escapeHtml(key)}</span>
      <input type="text" class="prop-input" data-custom-prop-key="${escapeHtml(key)}" value="${escapeHtml(val)}" />
      <button class="icon-btn" data-remove-custom-prop="${escapeHtml(key)}" title="Remove property" style="padding:1px 5px;">&times;</button>
    `;
    els.customPropertiesList.appendChild(row);
  }
}

/**
 * Build the complete Obsidian file content (YAML Frontmatter Properties + Clean Markdown Body + Managed `## Annotations` Section)
 */
function getFullNoteForObsidian() {
  const props = collectPropertiesFromUI();
  let bodyWithAnnotations = els.markdownEditor.value;

  if (settings.annotatorEnabled !== false && settings.annotatorSyncMode !== 'local_only') {
    bodyWithAnnotations = upsertAnnotationsSectionInMarkdown(
      bodyWithAnnotations,
      pageAnnotations,
      settings.annotatorObsidianFormat || 'callout'
    );
  }

  return buildFullMarkdownWithProperties(bodyWithAnnotations, props);
}

/**
 * -------------------------------------------------------------------------
 * PHASE 4b/4c/4e: ANNOTATIONS SIDEBAR TAB & PER-SITE PERMISSIONS
 * -------------------------------------------------------------------------
 */
async function loadPageAnnotations() {
  if (!activeTab?.url || !activeTab.url.startsWith('http')) {
    pageAnnotations = [];
    renderAnnotationsList();
    return;
  }

  pageAnnotations = await annotationStore.getAnnotationsForUrl(activeTab.url, false);
  if (els.annotationsCountBadge) {
    els.annotationsCountBadge.textContent = String(pageAnnotations.length);
  }
  renderAnnotationsList();
  checkSiteAutoRestorePermission();
  collectPropertiesFromUI();
}

async function checkSiteAutoRestorePermission() {
  if (!activeTab?.url || !activeTab.url.startsWith('http') || pageAnnotations.length === 0) {
    els.sitePermissionBanner?.classList.add('hidden');
    return;
  }
  try {
    const u = new URL(activeTab.url);
    const originPattern = `${u.protocol}//${u.hostname}/*`;
    const hasPerm = await chrome.permissions.contains({ origins: [originPattern] });
    if (!hasPerm) {
      els.sitePermissionBanner?.classList.remove('hidden');
      if (els.sitePermissionText) {
        els.sitePermissionText.textContent = `Always restore annotations on ${u.hostname}?`;
      }
    } else {
      els.sitePermissionBanner?.classList.add('hidden');
    }
  } catch (_) {
    els.sitePermissionBanner?.classList.add('hidden');
  }
}

function renderAnnotationsList() {
  if (!els.annotationsListContainer) return;

  const query = (els.annSearchInput?.value || '').trim().toLowerCase();
  const typeFilter = els.annFilterTypeSelect?.value || 'all';
  const colorFilter = els.annFilterColorSelect?.value || 'all';

  const filtered = pageAnnotations.filter((ann) => {
    if (ann.status === 'deleted') return false;
    if (typeFilter === 'orphaned' && ann.status !== 'orphaned') return false;
    if (typeFilter !== 'all' && typeFilter !== 'orphaned' && ann.type !== typeFilter) return false;
    if (colorFilter !== 'all' && ann.color !== colorFilter) return false;
    if (query) {
      const hay = `${ann.quote || ''} ${ann.comment || ''} ${(ann.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    els.annotationsListContainer.innerHTML = `<div class="empty-state">No annotations match your filter. Select text on the page or use + Sticky / + Area / + Page Note above.</div>`;
    return;
  }

  els.annotationsListContainer.innerHTML = '';

  for (const ann of filtered) {
    const colorObj = HIGHLIGHT_COLORS.find((c) => c.id === ann.color) || HIGHLIGHT_COLORS[0];
    const card = document.createElement('div');
    card.className = 'note-card';
    card.style.borderLeft = `4px solid ${colorObj.hex}`;

    const isOrphaned = ann.status === 'orphaned';
    const statusBadge = isOrphaned
      ? `<span class="reason-pill" style="background:rgba(239,68,68,0.2);color:#fca5a5;">Orphaned</span>`
      : '';
    const aiBadge =
      ann.source === 'ai'
        ? `<span class="reason-pill" style="background:rgba(168,85,247,0.25);color:#e9d5ff;">✨ AI</span>`
        : '';

    const swatchesHtml = HIGHLIGHT_COLORS.map(
      (c) =>
        `<span data-ann-color="${c.id}" data-ann-id="${escapeHtml(ann.id)}" style="width:12px;height:12px;border-radius:50%;background:${c.hex};display:inline-block;cursor:pointer;border:${ann.color === c.id ? '2px solid #fff' : '1px solid transparent'};" title="${c.label}"></span>`
    ).join('');

    const tagsHtml = (ann.tags || [])
      .map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`)
      .join(' ');

    card.innerHTML = `
      <div class="note-card-header">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);">${escapeHtml(ann.type)}</span>
          <span style="font-size:10.5px;font-family:var(--font-mono);color:var(--text-muted);">^${escapeHtml(ann.obsidianBlockId)}</span>
          ${statusBadge}
          ${aiBadge}
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          ${swatchesHtml}
        </div>
      </div>

      ${
        ann.quote
          ? `<div class="note-snippet" data-scroll-ann="${escapeHtml(ann.id)}" style="cursor:pointer;border-left:2px solid ${colorObj.hex};" title="Click to scroll to & flash on page">"${escapeHtml(ann.quote)}"</div>`
          : ''
      }

      <textarea
        class="input-field"
        data-edit-ann-comment="${escapeHtml(ann.id)}"
        placeholder="Add Markdown comment or #tags..."
        style="width:100%;min-height:46px;font-size:11.5px;resize:vertical;"
      >${escapeHtml(ann.comment || '')}</textarea>

      ${tagsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${tagsHtml}</div>` : ''}

      <div class="note-card-actions" style="justify-content:space-between;">
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm" data-scroll-ann="${escapeHtml(ann.id)}" title="Scroll to annotation on page">
            🎯 Jump
          </button>
          ${
            isOrphaned
              ? `<button class="btn btn-sm btn-primary" data-reattach-ann="${escapeHtml(ann.id)}" title="Select new text on page to re-anchor">🔗 Re-attach</button>`
              : ''
          }
          <button class="btn btn-sm" data-copy-block-link="${escapeHtml(ann.obsidianBlockId)}" title="Copy Obsidian [[Note#^blockId]] link">
            [[#^]]
          </button>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm btn-primary" data-save-ann="${escapeHtml(ann.id)}">Save</button>
          <button class="btn btn-sm" data-delete-ann="${escapeHtml(ann.id)}" style="color:#fca5a5;">Delete</button>
        </div>
      </div>
    `;

    els.annotationsListContainer.appendChild(card);
  }
}

/**
 * Extract DOM from the active tab and populate Properties Panel + clean Markdown Body Editor
 */
async function captureActivePage(mode = 'auto') {
  if (!activeTab?.id) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
      tabId: activeTab.id,
      url: activeTab.url
    });

    const response = await sendMessageToTab(activeTab.id, { type: 'EXTRACT_PAGE', mode });
    const selectedTpl =
      (settings.templates || []).find((t) => t.id === els.templateSelect.value) ||
      settings.templates[0];

    if (response?.ok && response.data) {
      pageData = response.data;
      const converted = htmlToMarkdown(pageData.html, pageData.metadata.url);
      const selectionMd = pageData.selectionHtml
        ? htmlToMarkdown(pageData.selectionHtml, pageData.metadata.url).markdown
        : '';

      pageImages = pageData.images || converted.images || [];
      renderImagesGallery();

      if (selectedTpl?.folder && !linkedVaultPath) {
        ensureFolderOptionExists(selectedTpl.folder);
        els.folderSelect.value = selectedTpl.folder;
      }

      const contentBody =
        mode === 'annotations_only'
          ? upsertAnnotationsSectionInMarkdown('', pageAnnotations, settings.annotatorObsidianFormat || 'callout')
          : converted.markdown;

      const { properties, bodyMarkdown } = buildNoteFromTemplate(selectedTpl.content, {
        title: pageData.metadata.title,
        url: pageData.metadata.url,
        author: pageData.metadata.author,
        description: pageData.metadata.description,
        publishedTime: pageData.metadata.publishedTime,
        tags: currentTags,
        summary: currentSummary,
        customProperties,
        selection: selectionMd,
        content: contentBody
      });

      populatePropertiesUI(properties);
      setEditorBodyMarkdown(bodyMarkdown, false);
    } else {
      const { properties, bodyMarkdown } = buildNoteFromTemplate(selectedTpl.content, {
        title: activeTab.title || 'Quick Note',
        url: activeTab.url || '',
        author: 'Unknown',
        description: '',
        tags: currentTags,
        summary: currentSummary,
        content: ''
      });
      populatePropertiesUI(properties);
      setEditorBodyMarkdown(bodyMarkdown, false);
    }
  } catch (_) {
    const selectedTpl = settings.templates[0];
    const { properties, bodyMarkdown } = buildNoteFromTemplate(selectedTpl.content, {
      title: activeTab?.title || 'Quick Note',
      url: activeTab?.url || '',
      author: 'Unknown',
      description: '',
      tags: currentTags,
      summary: currentSummary,
      content: ''
    });
    populatePropertiesUI(properties);
    setEditorBodyMarkdown(bodyMarkdown, false);
  }
}

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (res) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });
}

/**
 * Markdown Body Editor Management & Live Preview Renderer
 */
function setEditorBodyMarkdown(md, markDirty = true) {
  const { properties, body } = parseObsidianProperties(md);
  if (Object.keys(properties).length > 0) {
    populatePropertiesUI(properties);
  }
  els.markdownEditor.value = body;
  localDirty = markDirty;
  updateWordCount();
  renderMarkdownPreview();
}

function updateWordCount() {
  const text = els.markdownEditor.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  els.wordCountLabel.textContent = `${words} words`;
}

function renderMarkdownPreview() {
  const body = els.markdownEditor.value || '';
  const props = collectPropertiesFromUI();

  let frontmatterHtml = '';
  const propEntries = Object.entries(props).filter(([, v]) =>
    Array.isArray(v) ? v.length > 0 : v !== '' && v !== null && v !== undefined
  );
  if (propEntries.length > 0) {
    const rows = propEntries
      .map(
        ([k, v]) =>
          `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}`
      )
      .join('\n');
    frontmatterHtml = `<div class="frontmatter-badge"><strong>Obsidian Note Properties (Frontmatter)</strong>\n${rows}</div>`;
  }

  let html = escapeHtml(body);

  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
  html = html.replace(/!\[\[([^\]]+)\]\]/g, '<span class="tag-chip">&#128444; Embedded: $1</span>');
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="tag-chip">&#128279; [[$1]]</span>');

  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  html = html.replace(/^- \[x\] (.*)$/gm, '<div>&#9745; $1</div>');
  html = html.replace(/^- \[ \] (.*)$/gm, '<div>&#9744; $1</div>');
  html = html.replace(/^- (.*)$/gm, '&bull; $1<br/>');
  html = html.replace(/\n{2,}/g, '<br/><br/>');

  els.markdownPreview.innerHTML = frontmatterHtml + html;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tag Chips Management
 */
function renderTagChips() {
  els.tagChipsContainer.innerHTML = '';
  for (const tag of currentTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `#${escapeHtml(tag)} <button data-remove-tag="${escapeHtml(tag)}" title="Remove tag">&times;</button>`;
    els.tagChipsContainer.appendChild(chip);
  }
}

function addTag(rawTag) {
  const clean = normalizeObsidianTag(rawTag);
  if (!clean) return;
  if (!currentTags.includes(clean)) {
    currentTags.push(clean);
    renderTagChips();
    localDirty = true;
    collectPropertiesFromUI();
    renderMarkdownPreview();
  }
}

function removeTag(tagToRemove) {
  currentTags = currentTags.filter((t) => t !== tagToRemove);
  renderTagChips();
  localDirty = true;
  collectPropertiesFromUI();
  renderMarkdownPreview();
}

/**
 * Bi-Directional Sync Engine (Includes Managed `## Annotations` Round-Trip Reconciliation)
 */
function getTargetVaultPath() {
  const customTypedFolder = (els.folderFilterInput?.value || '').replace(/^\/+|\/+$/g, '').trim();
  const selectedFolder = (els.folderSelect.value || '').replace(/^\/+|\/+$/g, '').trim();
  const folder =
    customTypedFolder && !allVaultFolders.includes(customTypedFolder)
      ? customTypedFolder
      : selectedFolder;

  const title = sanitizeFileName(els.noteTitleInput.value || 'Untitled Note');
  const fileName = title.endsWith('.md') ? title : `${title}.md`;
  return folder ? `${folder}/${fileName}` : fileName;
}

function activateBiDirectionalLink(vaultPath, mtime = null) {
  linkedVaultPath = vaultPath;
  if (mtime) lastVaultModifiedTime = mtime;

  const parts = vaultPath.split('/');
  const file = parts.pop().replace(/\.md$/i, '');
  const folder = parts.join('/');

  els.noteTitleInput.value = file;
  ensureFolderOptionExists(folder);
  els.folderSelect.value = folder;

  els.syncBanner.classList.remove('hidden');
  els.syncBannerText.textContent = `Bi-Directional Sync: ${vaultPath}`;
}

async function pullNoteFromObsidian(vaultPath = null) {
  const targetPath = vaultPath || linkedVaultPath || getTargetVaultPath();
  try {
    const noteObj = await obsidian.getNote(targetPath, true);
    const rawContent = typeof noteObj === 'string' ? noteObj : noteObj?.content || '';
    const mtime = noteObj?.stat?.mtime || Date.now();

    const { properties, body } = parseObsidianProperties(rawContent);
    if (noteObj?.frontmatter && typeof noteObj.frontmatter === 'object') {
      const fmCopy = { ...noteObj.frontmatter };
      delete fmCopy.summary;
      Object.assign(properties, fmCopy);
    }

    // Reconcile Managed `## Annotations` Block from Obsidian with Local In-Page Annotations!
    if (activeTab?.url) {
      const parsedObsAnn = parseAnnotationsFromObsidianMarkdown(
        body,
        activeTab.url,
        els.noteTitleInput.value
      );
      if (parsedObsAnn.hasManagedSection) {
        const currentLocal = await annotationStore.getAnnotationsForUrl(activeTab.url, true);
        const reconciled = reconcileAnnotationsWithObsidian(currentLocal, parsedObsAnn);
        await annotationStore.saveAnnotationsForUrl(activeTab.url, reconciled);
        await loadPageAnnotations();
      }
    }

    populatePropertiesUI(properties);
    setEditorBodyMarkdown(body, false);

    activateBiDirectionalLink(targetPath, mtime);
    showToast(`Pulled note, Properties & Annotations from Obsidian: ${targetPath}`);
  } catch (err) {
    showToast(`Could not pull from Obsidian: ${err.message}`, true);
  }
}

async function pushNoteToObsidian() {
  const targetPath = getTargetVaultPath();
  const fullMarkdown = getFullNoteForObsidian();

  try {
    els.saveToObsidianBtn.disabled = true;
    await obsidian.saveNote(targetPath, fullMarkdown);

    // Update editor body so user sees the synced `## Annotations` managed block
    const { body } = parseObsidianProperties(fullMarkdown);
    els.markdownEditor.value = body;
    renderMarkdownPreview();

    try {
      const meta = await obsidian.getNote(targetPath, true);
      lastVaultModifiedTime = meta?.stat?.mtime || Date.now();
    } catch (_) {
      lastVaultModifiedTime = Date.now();
    }

    localDirty = false;
    if (els.folderFilterInput) els.folderFilterInput.value = '';
    activateBiDirectionalLink(targetPath, lastVaultModifiedTime);
    showToast(`Synced Note + ${pageAnnotations.length} Annotations to: ${targetPath}`);

    if (activeTab?.id && activeTab?.url) {
      chrome.runtime.sendMessage({
        type: 'REFRESH_BADGE',
        tabId: activeTab.id,
        url: activeTab.url
      });
    }
  } catch (err) {
    showToast(`Failed to save to Obsidian: ${err.message}`, true);
  } finally {
    els.saveToObsidianBtn.disabled = false;
  }
}

function startLiveBiDirectionalSync() {
  stopLiveBiDirectionalSync();
  const intervalMs = Math.max((settings?.syncIntervalSeconds || 8) * 1000, 4000);

  liveSyncIntervalId = setInterval(async () => {
    if (!linkedVaultPath) return;
    try {
      const remoteNote = await obsidian.getNote(linkedVaultPath, true);
      if (!remoteNote || typeof remoteNote !== 'object') return;

      const remoteMtime = remoteNote.stat?.mtime || 0;
      const remoteContent = remoteNote.content || '';
      const currentFull = getFullNoteForObsidian();

      if (lastVaultModifiedTime && remoteMtime > lastVaultModifiedTime + 500) {
        if (remoteContent.trim() !== currentFull.trim()) {
          await pullNoteFromObsidian(linkedVaultPath);
        }
      } else if (localDirty) {
        await obsidian.saveNote(linkedVaultPath, currentFull);
        const refreshed = await obsidian.getNote(linkedVaultPath, true);
        lastVaultModifiedTime = refreshed?.stat?.mtime || Date.now();
        localDirty = false;
        showToast('Live Sync: Pushed editor & Annotations updates to Obsidian');
      }
    } catch (_) {}
  }, intervalMs);
}

function stopLiveBiDirectionalSync() {
  if (liveSyncIntervalId) {
    clearInterval(liveSyncIntervalId);
    liveSyncIntervalId = null;
  }
}

/**
 * Relevant Notes Discovery & Vault Search
 */
async function discoverRelevantNotesAndCheckSync() {
  try {
    const results = await obsidian.findRelevantNotes({
      url: pageData?.metadata?.url || activeTab?.url || '',
      title: pageData?.metadata?.title || activeTab?.title || '',
      keywords: pageData?.keywords || []
    });

    els.relevantCountBadge.textContent = String(results.length);
    renderRelevantNotesList(results);

    const exactMatch = results.find((r) => r.isExactUrlMatch);
    if (exactMatch) {
      linkedVaultPath = exactMatch.filename;
      els.syncBanner.classList.remove('hidden');
      els.syncBannerText.textContent = `Existing Vault Note Found: ${exactMatch.filename}`;
    }
  } catch (_) {
    els.relevantNotesList.innerHTML = `<div class="empty-state">Connect to Obsidian Local REST API to discover relevant notes.</div>`;
  }
}

function renderRelevantNotesList(notes) {
  if (!notes || notes.length === 0) {
    els.relevantNotesList.innerHTML = `<div class="empty-state">No matching notes found in vault yet. Try searching with keywords above.</div>`;
    return;
  }

  els.relevantNotesList.innerHTML = '';
  for (const item of notes) {
    const card = document.createElement('div');
    card.className = `note-card ${item.isExactUrlMatch ? 'exact-match' : ''}`;

    const reasonsHtml = (item.reasons || [])
      .map((r) => `<span class="reason-pill">${escapeHtml(r)}</span>`)
      .join('');

    const snippetText =
      item.snippets && item.snippets.length > 0
        ? escapeHtml(item.snippets[0])
        : 'Click "Load & Bi-Sync" to view or edit this note directly inside the extension.';

    const wikilinkTarget = item.filename.replace(/\.md$/i, '');

    card.innerHTML = `
      <div class="note-card-header">
        <span class="note-filename">&#128196; ${escapeHtml(item.filename)}</span>
        <div class="note-reasons">${reasonsHtml}</div>
      </div>
      <div class="note-snippet">${snippetText}</div>
      <div class="note-card-actions">
        <button class="btn btn-sm btn-primary" data-load-note="${escapeHtml(item.filename)}">
          &#8644; Load &amp; Bi-Sync
        </button>
        <button class="btn btn-sm" data-insert-wikilink="${escapeHtml(wikilinkTarget)}">
          + Insert [[Wikilink]]
        </button>
        <button class="btn btn-sm" data-open-obsidian="${escapeHtml(item.filename)}">
          &#8599; Open in Obsidian
        </button>
      </div>
    `;

    els.relevantNotesList.appendChild(card);
  }
}

/**
 * Page Images Gallery & Vault Binary Attachment Saving
 */
function renderImagesGallery() {
  els.imagesCountBadge.textContent = String(pageImages.length);
  if (pageImages.length === 0) {
    els.imagesGrid.innerHTML = `<div class="empty-state" style="grid-column: span 2;">No captureable images detected on this page.</div>`;
    return;
  }

  els.imagesGrid.innerHTML = '';
  pageImages.forEach((img, index) => {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.innerHTML = `
      <div class="image-thumb-wrap">
        <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt)}" loading="lazy" />
      </div>
      <div class="image-meta">
        <div class="image-alt" title="${escapeHtml(img.alt)}">${escapeHtml(img.alt || 'Image ' + (index + 1))}</div>
        <button class="btn btn-sm btn-primary" data-save-img-idx="${index}">
          &#128190; Save to Vault &amp; Embed
        </button>
      </div>
    `;
    els.imagesGrid.appendChild(card);
  });
}

async function saveSingleImageToVaultAndEmbed(imgObj) {
  showToast('Saving image to Obsidian Vault...');
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'CAPTURE_IMAGE_TO_VAULT',
        imageUrl: imgObj.src,
        pageTitle: els.noteTitleInput.value || 'image',
        pageUrl: activeTab?.url || ''
      },
      (res) => {
        if (res && res.ok) {
          const currentMd = els.markdownEditor.value;
          if (currentMd.includes(imgObj.src)) {
            const replaced = currentMd.split(imgObj.src).join(res.vaultPath);
            setEditorBodyMarkdown(replaced, true);
          } else {
            insertAtCursor(els.markdownEditor, `\n${res.markdownEmbed}\n`);
          }
          showToast(`Saved ${res.vaultPath} & embedded ${res.markdownEmbed}`);
          resolve(res);
        } else {
          showToast(`Image save error: ${res?.error || 'Failed'}`, true);
          resolve(null);
        }
      }
    );
  });
}

/**
 * Textarea Formatting & Insertion Helpers
 */
function insertAtCursor(textarea, textToInsert) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;
  textarea.value = val.slice(0, start) + textToInsert + val.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
  textarea.focus();
  localDirty = true;
  updateWordCount();
  renderMarkdownPreview();
}

function applyFormatting(type) {
  const ta = els.markdownEditor;
  const start = ta.selectionStart || 0;
  const end = ta.selectionEnd || 0;
  const selected = ta.value.slice(start, end) || 'text';

  const replacements = {
    bold: `**${selected}**`,
    italic: `*${selected}*`,
    h2: `\n## ${selected}\n`,
    h3: `\n### ${selected}\n`,
    quote: `\n> ${selected.split('\n').join('\n> ')}\n`,
    code: `\n\`\`\`\n${selected}\n\`\`\`\n`,
    callout: `\n> [!info] Note\n> ${selected}\n`,
    wikilink: `[[${selected}]]`,
    task: `\n- [ ] ${selected}`
  };

  if (replacements[type]) {
    insertAtCursor(ta, replacements[type]);
  }
}

/**
 * Bind UI Event Listeners
 */
function bindUIEvents() {
  // Navigation Tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // Header actions
  els.connectionStatusPill.addEventListener('click', checkObsidianConnectionAndFolders);
  els.refreshFoldersBtn.addEventListener('click', async () => {
    showToast('Scanning all folders in Obsidian Vault...');
    await loadFoldersIntoSelect();
    showToast(`Loaded ${allVaultFolders.length} vault folders`);
  });

  els.folderSelect.addEventListener('change', () => {
    localDirty = true;
    const newPath = getTargetVaultPath();
    if (linkedVaultPath) {
      linkedVaultPath = newPath;
      els.syncBannerText.textContent = `Target Vault Path: ${newPath}`;
    }
  });

  if (els.folderFilterInput) {
    els.folderFilterInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) {
        setFolderOptions(allVaultFolders, els.folderSelect.value);
        return;
      }
      const filtered = allVaultFolders.filter((f) => f.toLowerCase().includes(q));
      const list = filtered.length > 0 ? filtered : [e.target.value.trim()];
      setFolderOptions(list, list[0]);
    });

    els.folderFilterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const newFolder = els.folderFilterInput.value.trim().replace(/^\/+|\/+$/g, '');
        if (newFolder) {
          ensureFolderOptionExists(newFolder);
          els.folderSelect.value = newFolder;
          els.folderFilterInput.value = '';
          showToast(`Selected destination folder: ${newFolder}`);
        }
      }
    });
  }

  // Obsidian Note Properties Collapsible Toggle & Field Listeners
  els.togglePropertiesBtn.addEventListener('click', (e) => {
    if (e.target.closest('#addCustomPropertyBtn')) return;
    const isCollapsed = els.propertiesBody.classList.toggle('collapsed');
    els.propertiesChevron.innerHTML = isCollapsed ? '&#9656;' : '&#9662;';
  });

  els.addCustomPropertyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = prompt('Enter new Obsidian Property name (e.g. project, rating, aliases):');
    if (!key) return;
    const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!cleanKey || cleanKey === 'summary') return;
    customProperties[cleanKey] = '';
    els.propertiesBody.classList.remove('collapsed');
    els.propertiesChevron.innerHTML = '&#9662;';
    renderCustomPropertiesRows();
    localDirty = true;
    collectPropertiesFromUI();
    renderMarkdownPreview();
  });

  [
    els.noteTitleInput,
    els.propSourceInput,
    els.propAuthorInput,
    els.propCreatedInput,
    els.propStatusInput,
    els.propDescriptionInput
  ].forEach((inputEl) => {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      localDirty = true;
      collectPropertiesFromUI();
      renderMarkdownPreview();
    });
    inputEl.addEventListener('change', () => {
      localDirty = true;
      collectPropertiesFromUI();
      renderMarkdownPreview();
    });
  });

  els.customPropertiesList.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-custom-prop-key]');
    if (inp) {
      customProperties[inp.dataset.customPropKey] = inp.value;
      localDirty = true;
      collectPropertiesFromUI();
      renderMarkdownPreview();
    }
  });

  els.customPropertiesList.addEventListener('click', (e) => {
    const rmBtn = e.target.closest('[data-remove-custom-prop]');
    if (rmBtn) {
      delete customProperties[rmBtn.dataset.removeCustomProp];
      renderCustomPropertiesRows();
      localDirty = true;
      collectPropertiesFromUI();
      renderMarkdownPreview();
    }
  });

  // -------------------------------------------------------------------------
  // ANNOTATIONS TAB EVENT LISTENERS
  // -------------------------------------------------------------------------
  els.annotatorEnabledToggle?.addEventListener('change', async (e) => {
    settings.annotatorEnabled = e.target.checked;
    await saveSettings(settings);
    syncAnnotatorEnabledUI();
    showToast(
      settings.annotatorEnabled
        ? 'In-Page Web Annotator enabled!'
        : 'In-Page Web Annotator disabled (selection toolbar & highlights hidden)'
    );
  });

  els.grantSitePermissionBtn?.addEventListener('click', async () => {
    if (!activeTab?.url) return;
    try {
      const u = new URL(activeTab.url);
      const originPattern = `${u.protocol}//${u.hostname}/*`;
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (granted) {
        await chrome.runtime.sendMessage({ type: 'SYNC_REGISTERED_SCRIPTS' });
        els.sitePermissionBanner.classList.add('hidden');
        showToast(`Auto-restore enabled for ${u.hostname}!`);
      }
    } catch (err) {
      showToast(`Permission request error: ${err.message}`, true);
    }
  });

  els.addStickyNoteBtn?.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    await sendMessageToTab(activeTab.id, { type: 'ANNOTATOR_START_STICKY_MODE' });
    showToast('Click anywhere on the webpage to pin a Sticky Note');
  });

  els.addAreaAnnotationBtn?.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    await sendMessageToTab(activeTab.id, { type: 'ANNOTATOR_START_AREA_MODE' });
    showToast('Click and drag on the webpage to annotate an image or area');
  });

  els.addPageNoteBtn?.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    await sendMessageToTab(activeTab.id, { type: 'ANNOTATOR_ADD_PAGE_NOTE' });
  });

  els.addBookmarkMarkerBtn?.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    await sendMessageToTab(activeTab.id, { type: 'ANNOTATOR_ADD_BOOKMARK' });
  });

  els.annSearchInput?.addEventListener('input', renderAnnotationsList);
  els.annFilterTypeSelect?.addEventListener('change', renderAnnotationsList);
  els.annFilterColorSelect?.addEventListener('change', renderAnnotationsList);

  // Annotations Card List Actions (Jump, Color Change, Save Comment, Delete, Re-attach, Copy Block Link)
  els.annotationsListContainer?.addEventListener('click', async (e) => {
    const colorSwatch = e.target.closest('[data-ann-color]');
    if (colorSwatch) {
      const id = colorSwatch.dataset.annId;
      const color = colorSwatch.dataset.annColor;
      const target = pageAnnotations.find((a) => a.id === id);
      if (target) {
        target.color = color;
        await annotationStore.saveAnnotation(target);
        await loadPageAnnotations();
      }
      return;
    }

    const scrollBtn = e.target.closest('[data-scroll-ann]');
    if (scrollBtn && activeTab?.id) {
      await sendMessageToTab(activeTab.id, {
        type: 'ANNOTATOR_SCROLL_TO',
        annotationId: scrollBtn.dataset.scrollAnn
      });
      return;
    }

    const reattachBtn = e.target.closest('[data-reattach-ann]');
    if (reattachBtn && activeTab?.id) {
      await sendMessageToTab(activeTab.id, {
        type: 'ANNOTATOR_START_REATTACH',
        annotationId: reattachBtn.dataset.reattachAnn
      });
      showToast('Select new text on the page and click a highlight color swatch to re-attach');
      return;
    }

    const copyLinkBtn = e.target.closest('[data-copy-block-link]');
    if (copyLinkBtn) {
      const noteTitle = sanitizeFileName(els.noteTitleInput.value || 'Note');
      const blockId = copyLinkBtn.dataset.copyBlockLink;
      const link = `[[${noteTitle}#^${blockId}]]`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      showToast(`Copied ${link} to clipboard!`);
      return;
    }

    const saveBtn = e.target.closest('[data-save-ann]');
    if (saveBtn) {
      const id = saveBtn.dataset.saveAnn;
      const ta = els.annotationsListContainer.querySelector(`[data-edit-ann-comment="${id}"]`);
      const target = pageAnnotations.find((a) => a.id === id);
      if (target && ta) {
        let rawComment = ta.value.trim();
        // Extract inline #tags from comment if user typed them
        const inlineTags = [...(target.tags || [])];
        rawComment = rawComment
          .replace(/(?:^|\s)#([a-zA-Z0-9/_-]+)/g, (_m, tag) => {
            const clean = normalizeObsidianTag(tag);
            if (clean && !inlineTags.includes(clean)) inlineTags.push(clean);
            return '';
          })
          .trim();
        target.comment = rawComment;
        target.tags = inlineTags;
        await annotationStore.saveAnnotation(target);
        await loadPageAnnotations();
        showToast('Saved annotation update!');
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-ann]');
    if (delBtn && activeTab?.url) {
      const id = delBtn.dataset.deleteAnn;
      lastDeletedAnnotationId = id;
      await annotationStore.softDeleteAnnotation(activeTab.url, id);
      await loadPageAnnotations();
      els.undoDeleteBanner?.classList.remove('hidden');
    }
  });

  els.undoDeleteAnnotationBtn?.addEventListener('click', async () => {
    if (lastDeletedAnnotationId && activeTab?.url) {
      await annotationStore.restoreAnnotation(activeTab.url, lastDeletedAnnotationId);
      lastDeletedAnnotationId = null;
      els.undoDeleteBanner?.classList.add('hidden');
      await loadPageAnnotations();
      showToast('Restored deleted annotation!');
    }
  });

  // AI Digest ("Summarize my annotations")
  els.aiSummarizeAnnotationsBtn?.addEventListener('click', async () => {
    try {
      els.aiSummarizeAnnotationsBtn.disabled = true;
      showToast('Generating AI Digest of your page annotations...');
      const digest = await llm.summarizeAnnotations({
        title: els.noteTitleInput.value,
        url: activeTab?.url || '',
        annotations: pageAnnotations
      });
      const updatedBody = upsertSummaryCalloutInBody(els.markdownEditor.value, digest);
      setEditorBodyMarkdown(updatedBody, true);
      document.querySelector('[data-tab="editorTab"]')?.click();
      showToast('Inserted Annotation Digest into [!abstract] AI Summary!');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.aiSummarizeAnnotationsBtn.disabled = false;
    }
  });

  // AI Suggest Highlights
  els.aiSuggestHighlightsBtn?.addEventListener('click', async () => {
    try {
      els.aiSuggestHighlightsBtn.disabled = true;
      showToast('AI is analyzing page for high-value highlight suggestions...');
      const suggestions = await llm.suggestHighlights({
        title: els.noteTitleInput.value,
        plainText: pageData?.plainText || els.markdownEditor.value
      });

      if (!suggestions.length) {
        showToast('No highlight suggestions returned', true);
        return;
      }

      els.aiSuggestionsContainer.style.display = 'flex';
      els.aiSuggestionsContainer.innerHTML = suggestions
        .map(
          (s, i) => `
          <div class="note-card" style="border-left:3px solid #a855f7;">
            <div style="font-size:11px;color:#e9d5ff;font-weight:600;">✨ AI Suggested Highlight #${i + 1}</div>
            <div class="note-snippet">"${escapeHtml(s.quote)}"</div>
            <div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(s.comment || '')}</div>
            <div class="note-card-actions">
              <button class="btn btn-sm btn-primary" data-accept-sug="${i}">✓ Accept Highlight</button>
              <button class="btn btn-sm" data-reject-sug="${i}">✕ Dismiss</button>
            </div>
          </div>
        `
        )
        .join('');

      els.aiSuggestionsContainer.onclick = async (e) => {
        const acc = e.target.closest('[data-accept-sug]');
        if (acc) {
          const item = suggestions[Number(acc.dataset.acceptSug)];
          if (item && activeTab?.url) {
            await annotationStore.saveAnnotation({
              type: 'highlight',
              color: item.color || 'yellow',
              quote: item.quote,
              comment: item.comment || '',
              tags: ['ai-suggested'],
              pageUrl: activeTab.url,
              pageTitle: els.noteTitleInput.value,
              source: 'ai',
              selectors: {
                TextQuoteSelector: { type: 'TextQuoteSelector', exact: item.quote, prefix: '', suffix: '' }
              }
            });
            acc.closest('.note-card')?.remove();
            await loadPageAnnotations();
            showToast('Accepted AI highlight!');
          }
        }
        const rej = e.target.closest('[data-reject-sug]');
        if (rej) {
          rej.closest('.note-card')?.remove();
        }
      };
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.aiSuggestHighlightsBtn.disabled = false;
    }
  });

  // Sync Annotations Now button
  els.syncAnnotationsToObsidianBtn?.addEventListener('click', () => pushNoteToObsidian());

  // Export & Import JSON / Hypothes.is
  els.exportAnnotationsJsonBtn?.addEventListener('click', async () => {
    const allData = await annotationStore.exportAllAnnotations();
    const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `obsidian-annotations-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported annotations JSON backup!');
  });

  els.importAnnotationsJsonBtn?.addEventListener('click', () => {
    els.importAnnotationsFileInput?.click();
  });

  els.importAnnotationsFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const count = await annotationStore.importAnnotationsJson(json);
      await loadPageAnnotations();
      showToast(`Imported ${count} annotations!`);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, true);
    }
  });

  els.openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  els.openSidePanelBtn.addEventListener('click', () => {
    if (activeTab?.id) {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', tabId: activeTab.id });
      window.close();
    }
  });

  els.openInObsidianBtn.addEventListener('click', async () => {
    const targetPath = getTargetVaultPath();
    try {
      await obsidian.openInObsidian(targetPath, false);
      showToast(`Opened ${targetPath} in Obsidian`);
    } catch (err) {
      showToast(`Save the note first before opening in Obsidian (${err.message})`, true);
    }
  });

  // Capture mode & Template changes
  els.recapturePageBtn.addEventListener('click', () => {
    linkedVaultPath = null;
    els.syncBanner.classList.add('hidden');
    captureActivePage(els.captureModeSelect.value);
  });

  els.captureModeSelect.addEventListener('change', () => {
    captureActivePage(els.captureModeSelect.value);
  });

  els.templateSelect.addEventListener('change', () => {
    captureActivePage(els.captureModeSelect.value);
  });

  // Bi-Directional Sync buttons
  els.pullFromVaultBtn.addEventListener('click', () => pullNoteFromObsidian(linkedVaultPath));
  els.pushToVaultBtn.addEventListener('click', () => pushNoteToObsidian());
  els.saveToObsidianBtn.addEventListener('click', () => pushNoteToObsidian());

  els.liveBiSyncToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      startLiveBiDirectionalSync();
      showToast('Live 2-Way Sync enabled');
    } else {
      stopLiveBiDirectionalSync();
      showToast('Live 2-Way Sync paused');
    }
  });

  // Append to Daily Note
  els.appendDailyNoteBtn.addEventListener('click', async () => {
    try {
      const res = await obsidian.appendToDailyNote(els.markdownEditor.value);
      showToast(`Appended to ${res.target}!`);
    } catch (err) {
      showToast(`Daily Note error: ${err.message}`, true);
    }
  });

  // AI Auto-Tagging
  els.aiAutoTagBtn.addEventListener('click', async () => {
    try {
      els.aiAutoTagBtn.disabled = true;
      els.aiAutoTagBtn.textContent = 'Tagging...';
      showToast(`Generating tags via ${settings.llmVendor.toUpperCase()}...`);

      const result = await llm.generateTags({
        title: els.noteTitleInput.value,
        url: activeTab?.url || '',
        content: els.markdownEditor.value,
        existingTags: currentTags
      });

      for (const t of result.tags) {
        addTag(t);
      }
      showToast(`Added ${result.tags.length} AI tags to Note Properties!`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.aiAutoTagBtn.disabled = false;
      els.aiAutoTagBtn.innerHTML = '&#10024; AI Auto-Tag';
    }
  });

  // AI Page Summarization (Inserts `> [!abstract] AI Summary` callout directly into the Note Body)
  els.aiSummarizeBtn.addEventListener('click', async () => {
    try {
      els.aiSummarizeBtn.disabled = true;
      els.aiSummarizeBtn.textContent = 'Summarizing...';
      showToast(`Generating page summary via ${settings.llmVendor.toUpperCase()}...`);

      const summaryMd = await llm.summarizePage({
        title: els.noteTitleInput.value,
        url: activeTab?.url || '',
        content: pageData?.plainText || els.markdownEditor.value
      });

      currentSummary = summaryMd;
      const updatedBody = upsertSummaryCalloutInBody(els.markdownEditor.value, summaryMd);
      setEditorBodyMarkdown(updatedBody, true);
      showToast('AI Summary inserted into note body at [!abstract] AI Summary!');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.aiSummarizeBtn.disabled = false;
      els.aiSummarizeBtn.innerHTML = '&#129504; AI Summary';
    }
  });

  // AI Editor Transformation Actions
  els.aiTransformSelect.addEventListener('change', async (e) => {
    const action = e.target.value;
    if (!action) return;
    e.target.value = '';

    try {
      showToast(`Running AI transformation (${action})...`);
      const ta = els.markdownEditor;
      const hasSelection = ta.selectionStart !== ta.selectionEnd;
      const inputContent = hasSelection
        ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
        : ta.value;

      const output = await llm.transformEditorContent({
        content: inputContent,
        action
      });

      if (hasSelection) {
        insertAtCursor(ta, `\n\n${output}\n\n`);
      } else {
        setEditorBodyMarkdown(`${ta.value}\n\n## AI Generated (${action})\n\n${output}\n`, true);
      }
      showToast('AI Editor transformation complete!');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      els.aiSummarizeBtn.disabled = false;
    }
  });

  // Interactive Image Picker on Live Web Page
  els.pickImageOnPageBtn.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    await sendMessageToTab(activeTab.id, { type: 'START_IMAGE_PICKER' });
    showToast('Click any image on the active webpage to save it to your Obsidian Vault');
  });

  // Tag input & removal
  els.addTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(els.addTagInput.value);
      els.addTagInput.value = '';
    }
  });

  els.tagChipsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-tag]');
    if (btn) {
      removeTag(btn.dataset.removeTag);
    }
  });

  // Editor Formatting Toolbar & View Mode toggles
  document.querySelectorAll('[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', () => applyFormatting(btn.dataset.fmt));
  });

  els.viewEditBtn.addEventListener('click', () => {
    els.editorContainer.className = 'editor-container';
  });
  els.viewSplitBtn.addEventListener('click', () => {
    els.editorContainer.className = 'editor-container split-mode';
    renderMarkdownPreview();
  });
  els.viewPreviewBtn.addEventListener('click', () => {
    els.editorContainer.className = 'editor-container preview-mode';
    renderMarkdownPreview();
  });

  els.markdownEditor.addEventListener('input', () => {
    localDirty = true;
    updateWordCount();
    if (
      els.editorContainer.classList.contains('split-mode') ||
      els.editorContainer.classList.contains('preview-mode')
    ) {
      renderMarkdownPreview();
    }
  });

  // Vault Search & Relevant Note Actions
  els.vaultSearchBtn.addEventListener('click', async () => {
    const q = els.vaultSearchInput.value.trim();
    if (!q) {
      await discoverRelevantNotesAndCheckSync();
      return;
    }
    const hits = await obsidian.searchSimple(q, 110);
    const formatted = hits.map((h) => ({
      filename: h.filename,
      score: h.score,
      snippets: (h.matches || []).slice(0, 2).map((m) => m.context),
      reasons: [`Search: "${q}"`],
      isExactUrlMatch: false
    }));
    renderRelevantNotesList(formatted);
  });

  els.vaultSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.vaultSearchBtn.click();
  });

  els.relevantNotesList.addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('[data-load-note]');
    if (loadBtn) {
      const filename = loadBtn.dataset.loadNote;
      await pullNoteFromObsidian(filename);
      document.querySelector('[data-tab="editorTab"]')?.click();
      return;
    }

    const wikiBtn = e.target.closest('[data-insert-wikilink]');
    if (wikiBtn) {
      const target = wikiBtn.dataset.insertWikilink;
      insertAtCursor(els.markdownEditor, `[[${target}]]`);
      showToast(`Inserted [[${target}]] into Markdown editor`);
      return;
    }

    const openBtn = e.target.closest('[data-open-obsidian]');
    if (openBtn) {
      const filename = openBtn.dataset.openObsidian;
      try {
        await obsidian.openInObsidian(filename, false);
      } catch (err) {
        showToast(err.message, true);
      }
    }
  });

  // Image Gallery Save buttons
  els.imagesGrid.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('[data-save-img-idx]');
    if (saveBtn) {
      const idx = Number(saveBtn.dataset.saveImgIdx);
      const imgObj = pageImages[idx];
      if (imgObj) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        await saveSingleImageToVaultAndEmbed(imgObj);
        saveBtn.textContent = 'Saved & Embedded';
      }
    }
  });

  els.saveAllImagesBtn.addEventListener('click', async () => {
    if (pageImages.length === 0) return;
    els.saveAllImagesBtn.disabled = true;
    const subset = pageImages.slice(0, 10);
    for (let i = 0; i < subset.length; i++) {
      els.saveAllImagesBtn.textContent = `Saving (${i + 1}/${subset.length})...`;
      await saveSingleImageToVaultAndEmbed(subset[i]);
    }
    els.saveAllImagesBtn.textContent = 'All Images Saved!';
    els.saveAllImagesBtn.disabled = false;
  });
}

document.addEventListener('DOMContentLoaded', initWorkspace);
