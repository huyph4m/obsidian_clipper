/**
 * Background Service Worker (Manifest V3)
 * Handles:
 * - Default Side Panel opening on extension toolbar icon click (`setPanelBehavior({ openPanelOnActionClick: true })`)
 * - Dynamic Content Script Injection (`activeTab` on demand + `chrome.scripting.registerContentScripts` for origins granted auto-restore permission)
 * - Context Menus:
 *   1. "Highlight selection"
 *   2. "Add note to selection"
 *   3. "Add page note"
 *   4. "Annotate this image"
 *   5. "Clip Full Page to Obsidian Side Panel"
 *   6. "Capture Image to Obsidian Vault & Copy Embed"
 *   7. "Append Selection to Today's Daily Note"
 * - Extension Badge with current page Annotation Count (or SYNC indicator)
 * - AI Assistance proxy for in-page selection ("Ask AI": explain, translate, simplify, define, free-form)
 *   and Vault Related Notes lookup for a highlight popover
 */

import { getSettings } from './services/storage.js';
import { ObsidianClient } from './services/obsidian-api.js';
import { LLMService } from './services/llm-service.js';
import { sanitizeFileName } from './services/markdown-converter.js';
import { normalizePageUrl } from './services/annotation-anchor.js';
import { AnnotationStore } from './services/annotation-store.js';

const annotationStore = new AnnotationStore();

// Ensure clicking the extension icon opens the Side Panel by default
async function configureDefaultSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn('Could not set sidePanel behavior:', err);
    }
  }
}

configureDefaultSidePanel();

chrome.runtime.onStartup.addListener(() => {
  configureDefaultSidePanel();
  syncRegisteredOriginContentScripts();
});

// Fallback action click listener to open Side Panel and inject annotator on activeTab
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    await ensureContentScriptInjected(tab.id, tab.url);
    if (chrome.sidePanel?.open) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch (_) {}
    }
  }
});

/**
 * Dynamically register content scripts for origins where the user granted "Always restore annotations on this site"
 * or "Enable everywhere" via `optional_host_permissions`.
 */
export async function syncRegisteredOriginContentScripts() {
  if (!chrome.scripting?.registerContentScripts) return;
  try {
    const perms = await chrome.permissions.getAll();
    const origins = (perms.origins || []).filter(
      (o) => !o.includes('127.0.0.1') && !o.includes('localhost')
    );

    await chrome.scripting.unregisterContentScripts().catch(() => {});
    if (origins.length > 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: 'obsidian-web-annotator-Dynamic',
          matches: origins,
          js: ['content.js'],
          css: ['content.css'],
          runAt: 'document_idle'
        }
      ]);
    }
  } catch (err) {
    console.warn('Could not sync registered content scripts:', err);
  }
}

/**
 * Ensure `content.js` and `content.css` are injected into a tab via `activeTab` or granted host permissions
 */
export async function ensureContentScriptInjected(tabId, url = '') {
  if (!tabId || !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith(' https://chrome.google.com/webstore')) {
    return false;
  }
  try {
    const ping = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'PING_ANNOTATOR' }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
    if (ping?.ok) return true;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Setup Context Menus on installation
chrome.runtime.onInstalled.addListener(() => {
  configureDefaultSidePanel();
  syncRegisteredOriginContentScripts();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'obsidian-highlight-selection',
      title: 'Highlight Selection (Obsidian Annotator)',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'obsidian-note-selection',
      title: 'Add Note to Selection (Obsidian Annotator)',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'obsidian-add-page-note',
      title: 'Add Page-Level Note',
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: 'obsidian-annotate-image',
      title: 'Annotate This Image / Region',
      contexts: ['image', 'page']
    });

    chrome.contextMenus.create({
      id: 'obsidian-capture-image',
      title: 'Capture Image to Obsidian Vault & Copy Embed',
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'obsidian-append-daily',
      title: "Append Selection to Today's Daily Note",
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'obsidian-open-sidepanel',
      title: 'Open Obsidian Companion Side Panel',
      contexts: ['all']
    });
  });
});

// Update toolbar badge with Annotation Count on the current page (or SYNC indicator)
async function updateBadgeForTab(tabId, url) {
  if (!url || !url.startsWith('http')) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }

  try {
    const settings = await getSettings();
    const annotations = settings.annotatorEnabled !== false
      ? await annotationStore.getAnnotationsForUrl(url, false)
      : [];
    const activeCount = annotations.length;

    if (activeCount > 0) {
      chrome.action.setBadgeText({ tabId, text: String(activeCount) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' });
      chrome.action.setTitle({
        tabId,
        title: `${activeCount} annotation${activeCount === 1 ? '' : 's'} on this page (Click to open Side Panel)`
      });
      return;
    }

    const client = await new ObsidianClient().init();
    const cleanUrl = normalizePageUrl(url);
    const hits = await client.searchSimple(cleanUrl, 60);
    if (hits && hits.length > 0) {
      chrome.action.setBadgeText({ tabId, text: 'SYNC' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' });
      chrome.action.setTitle({
        tabId,
        title: `Synced in Obsidian: ${hits[0].filename}`
      });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({
        tabId,
        title: 'Open Obsidian AI Companion Side Panel'
      });
    }
  } catch (_) {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      updateBadgeForTab(tabId, tab.url);
    }
  } catch (_) {}
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  await ensureContentScriptInjected(tab.id, tab.url);

  if (info.menuItemId === 'obsidian-open-sidepanel') {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
    return;
  }

  if (info.menuItemId === 'obsidian-highlight-selection') {
    await notifyTab(tab.id, { type: 'ANNOTATOR_CREATE_FROM_SELECTION', mode: 'highlight' });
    return;
  }

  if (info.menuItemId === 'obsidian-note-selection') {
    await notifyTab(tab.id, { type: 'ANNOTATOR_CREATE_FROM_SELECTION', mode: 'note' });
    return;
  }

  if (info.menuItemId === 'obsidian-add-page-note') {
    await notifyTab(tab.id, { type: 'ANNOTATOR_ADD_PAGE_NOTE' });
    return;
  }

  if (info.menuItemId === 'obsidian-annotate-image') {
    await notifyTab(tab.id, {
      type: 'ANNOTATOR_START_AREA_MODE',
      srcUrl: info.srcUrl || ''
    });
    return;
  }

  if (info.menuItemId === 'obsidian-capture-image' && info.srcUrl) {
    try {
      const result = await captureAndSaveImageToVault(info.srcUrl, tab.title || 'web-image', tab.url);
      await notifyTab(tab.id, {
        type: 'OBSIDIAN_TOAST',
        message: `Saved image to ${result.vaultPath} & copied ![[${result.fileName}]]`,
        embedCode: `![[${result.fileName}]]`
      });
    } catch (err) {
      await notifyTab(tab.id, {
        type: 'OBSIDIAN_TOAST',
        message: `Image capture failed: ${err.message}`,
        isError: true
      });
    }
    return;
  }

  if (info.menuItemId === 'obsidian-append-daily' && info.selectionText) {
    try {
      const client = await new ObsidianClient().init();
      const quote = info.selectionText
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      const block = `\n### Clip from [${tab.title || tab.url}](${tab.url})\n${quote}\n`;
      const res = await client.appendToDailyNote(block);
      await notifyTab(tab.id, {
        type: 'OBSIDIAN_TOAST',
        message: `Appended selection to ${res.target}!`
      });
    } catch (err) {
      await notifyTab(tab.id, {
        type: 'OBSIDIAN_TOAST',
        message: `Failed to append to Daily Note: ${err.message}`,
        isError: true
      });
    }
    return;
  }
});

// Keyboard Shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await ensureContentScriptInjected(tab.id, tab.url);

  if (command === 'open-sidepanel') {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } else if (command === 'quick-clip') {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
    await notifyTab(tab.id, { type: 'TRIGGER_QUICK_CLIP' });
  } else if (command === 'highlight-selection') {
    await notifyTab(tab.id, { type: 'ANNOTATOR_CREATE_FROM_SELECTION', mode: 'highlight' });
  } else if (command === 'toggle-annotations') {
    await notifyTab(tab.id, { type: 'ANNOTATOR_TOGGLE_VISIBILITY' });
  }
});

// Helper: Fetch remote image binary and save into Obsidian Vault attachments folder
export async function captureAndSaveImageToVault(imageUrl, pageTitle = 'image', _pageUrl = '') {
  const settings = await getSettings();
  const client = await new ObsidianClient(settings).init();

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Could not download image (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || 'image/png';
  let ext = 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('gif')) ext = 'gif';
  else if (contentType.includes('svg')) ext = 'svg';

  const arrayBuffer = await response.arrayBuffer();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanPrefix = sanitizeFileName(pageTitle).slice(0, 35).replace(/\s+/g, '-').toLowerCase();
  const fileName = `${cleanPrefix}-${timestamp}.${ext}`;
  const folder = (settings.attachmentsFolder || 'Attachments').replace(/\/$/, '');
  const vaultPath = folder ? `${folder}/${fileName}` : fileName;

  await client.saveBinaryAttachment(vaultPath, arrayBuffer, contentType);

  return {
    fileName,
    vaultPath,
    markdownEmbed: `![[${fileName}]]`,
    standardMarkdown: `![${pageTitle}](${vaultPath})`
  };
}

async function notifyTab(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (_) {}
}

/**
 * Handle "Ask AI about selection" from the In-Page Selection Toolbar / Popover
 * Respects domain blocklist and sends ONLY the selected text + minimal context.
 */
async function handleAskAiAboutSelection({ quote, task = 'explain', customQuestion = '', pageUrl = '', pageTitle = '' }) {
  const settings = await getSettings();

  // Check privacy domain blocklist
  const blockedDomains = settings.annotatorBlockedDomains || [];
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (blockedDomains.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()))) {
      throw new Error(`Domain "${host}" is on your AI privacy blocklist.`);
    }
  } catch (e) {
    if (e.message.includes('privacy blocklist')) throw e;
  }

  const llm = await new LLMService(settings).init();

  const taskPrompts = {
    explain: 'Explain the selected passage clearly and concisely in 2-4 sentences.',
    simplify: 'Simplify this passage into plain, easy-to-understand language.',
    translate: 'Translate this passage into English (or into Vietnamese if it is already in English).',
    define: 'Define the key technical or domain terms in this selection.',
    critique: 'Identify key assumptions, trade-offs, or counterarguments in this passage.',
    question: customQuestion || 'Analyze this selection.'
  };

  const instruction = taskPrompts[task] || taskPrompts.explain;
  const systemPrompt = `You are an intelligent research annotator integrated with Obsidian.
${instruction}
Write concise, clean Markdown suitable for an annotation note.`;

  const userPrompt = `Page Context: ${pageTitle || 'Web Page'}
Selected Text:
"${String(quote || '').slice(0, 2500)}"`;

  const answer = await llm.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.25
  });

  // Also generate 2-3 relevant tags
  const tagRes = await llm.generateTags({
    title: pageTitle,
    url: pageUrl,
    content: `${quote}\n${answer}`
  }).catch(() => ({ tags: [] }));

  return {
    answer,
    tags: (tagRes.tags || []).slice(0, 3)
  };
}

// Message listener for Content Script & Side Panel requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CAPTURE_IMAGE_TO_VAULT') {
    captureAndSaveImageToVault(message.imageUrl, message.pageTitle, message.pageUrl)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'OPEN_SIDE_PANEL') {
    const tabId = message.tabId || sender?.tab?.id;
    if (tabId && chrome.sidePanel?.open) {
      chrome.sidePanel
        .open({ tabId })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }

  if (message?.type === 'REFRESH_BADGE') {
    const tabId = message.tabId || sender?.tab?.id;
    const url = message.url || sender?.tab?.url;
    if (tabId && url) {
      updateBadgeForTab(tabId, url);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    ensureContentScriptInjected(message.tabId, message.url)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'SYNC_REGISTERED_SCRIPTS') {
    syncRegisteredOriginContentScripts()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'ANNOTATOR_ASK_AI') {
    handleAskAiAboutSelection(message)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'ANNOTATOR_FIND_RELATED_NOTES') {
    new ObsidianClient()
      .init()
      .then((client) => client.searchSimple(String(message.query || '').slice(0, 120), 80))
      .then((hits) =>
        sendResponse({
          ok: true,
          notes: (hits || []).slice(0, 5).map((h) => ({
            filename: h.filename,
            wikilink: h.filename.replace(/\.md$/i, ''),
            snippet: h.matches?.[0]?.context || ''
          }))
        })
      )
      .catch((err) => sendResponse({ ok: false, error: err.message, notes: [] }));
    return true;
  }
});
