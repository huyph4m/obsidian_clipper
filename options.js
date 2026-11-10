/**
 * Options Page Controller (`options.js`)
 * Manages Obsidian Local REST API config, Multi-Vendor LLM keys/models/endpoints
 * (including OpenAI, DeepSeek, Anthropic, Gemini, Ollama, and Custom),
 * Phase 4 In-Page Web Annotator settings, and per-origin `optional_host_permissions`.
 */

import { getSettings, saveSettings } from './services/storage.js';
import { ObsidianClient } from './services/obsidian-api.js';
import { LLMService } from './services/llm-service.js';

let settings = null;
let editingVendor = 'openai';

const MODEL_PRESETS = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o3-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  ollama: ['llama3.1', 'deepseek-r1:8b', 'qwen2.5:7b', 'mistral'],
  custom: ['deepseek/deepseek-chat', 'deepseek/deepseek-r1', 'gpt-4o-mini']
};

const els = {
  obsidianProtocol: document.getElementById('obsidianProtocol'),
  obsidianPort: document.getElementById('obsidianPort'),
  obsidianHost: document.getElementById('obsidianHost'),
  obsidianApiKey: document.getElementById('obsidianApiKey'),
  defaultFolder: document.getElementById('defaultFolder'),
  attachmentsFolder: document.getElementById('attachmentsFolder'),
  testObsidianBtn: document.getElementById('testObsidianBtn'),
  obsidianTestResult: document.getElementById('obsidianTestResult'),

  activeVendorSelect: document.getElementById('activeVendorSelect'),
  vendorConfigTabs: document.getElementById('vendorConfigTabs'),
  vendorEndpointInput: document.getElementById('vendorEndpointInput'),
  vendorModelInput: document.getElementById('vendorModelInput'),
  modelPresetsContainer: document.getElementById('modelPresetsContainer'),
  vendorApiKeyInput: document.getElementById('vendorApiKeyInput'),
  summaryStyleSelect: document.getElementById('summaryStyleSelect'),
  maxAutoTagsInput: document.getElementById('maxAutoTagsInput'),
  tagPrefixInput: document.getElementById('tagPrefixInput'),
  customSummaryPromptInput: document.getElementById('customSummaryPromptInput'),
  testLlmBtn: document.getElementById('testLlmBtn'),
  llmTestResult: document.getElementById('llmTestResult'),

  // Annotator settings
  annotatorEnabledCheckbox: document.getElementById('annotatorEnabledCheckbox'),
  annotatorDefaultColorSelect: document.getElementById('annotatorDefaultColorSelect'),
  annotatorSyncModeSelect: document.getElementById('annotatorSyncModeSelect'),
  annotatorObsidianFormatSelect: document.getElementById('annotatorObsidianFormatSelect'),
  annotatorFuzzyThresholdInput: document.getElementById('annotatorFuzzyThresholdInput'),
  annotatorBlockedDomainsInput: document.getElementById('annotatorBlockedDomainsInput'),
  enableEverywhereBtn: document.getElementById('enableEverywhereBtn'),
  grantedOriginsList: document.getElementById('grantedOriginsList'),

  autoSyncOnEditCheckbox: document.getElementById('autoSyncOnEditCheckbox'),
  syncIntervalInput: document.getElementById('syncIntervalInput'),
  defaultTemplateTextarea: document.getElementById('defaultTemplateTextarea'),
  saveAllSettingsBtn: document.getElementById('saveAllSettingsBtn'),
  settingsToast: document.getElementById('settingsToast')
};

function showToast(msg, isError = false) {
  els.settingsToast.textContent = msg;
  els.settingsToast.className = `workspace-toast ${isError ? 'error' : ''}`;
  setTimeout(() => {
    els.settingsToast.classList.add('hidden');
  }, 3500);
}

async function initOptions() {
  settings = await getSettings();

  els.obsidianProtocol.value = settings.obsidianProtocol || 'http';
  els.obsidianPort.value = settings.obsidianPort || '27123';
  els.obsidianHost.value = settings.obsidianHost || '127.0.0.1';
  els.obsidianApiKey.value = settings.obsidianApiKey || '';
  els.defaultFolder.value = settings.defaultFolder || 'Clippings';
  els.attachmentsFolder.value = settings.attachmentsFolder || 'Attachments';

  els.activeVendorSelect.value = settings.llmVendor || 'openai';
  editingVendor = settings.llmVendor || 'openai';
  loadVendorFields(editingVendor);

  els.summaryStyleSelect.value = settings.summaryStyle || 'bullet_key_takeaways';
  els.maxAutoTagsInput.value = settings.maxAutoTags || 6;
  els.tagPrefixInput.value = settings.tagPrefix || '';
  els.customSummaryPromptInput.value = settings.customSummaryPrompt || '';

  // Annotator fields
  if (els.annotatorEnabledCheckbox) {
    els.annotatorEnabledCheckbox.checked = settings.annotatorEnabled !== false;
  }
  if (els.annotatorDefaultColorSelect) {
    els.annotatorDefaultColorSelect.value = settings.annotatorDefaultColor || 'yellow';
    els.annotatorSyncModeSelect.value = settings.annotatorSyncMode || 'auto';
    els.annotatorObsidianFormatSelect.value = settings.annotatorObsidianFormat || 'callout';
    els.annotatorFuzzyThresholdInput.value = settings.annotatorFuzzyThreshold ?? 0.78;
    els.annotatorBlockedDomainsInput.value = (settings.annotatorBlockedDomains || []).join(', ');
  }

  els.autoSyncOnEditCheckbox.checked = Boolean(settings.autoSyncOnEdit);
  els.syncIntervalInput.value = settings.syncIntervalSeconds || 10;

  const firstTpl = settings.templates?.[0];
  if (firstTpl) {
    els.defaultTemplateTextarea.value = firstTpl.content;
  }

  await renderGrantedPermissionsList();
  bindEvents();
}

async function renderGrantedPermissionsList() {
  if (!els.grantedOriginsList || !chrome.permissions?.getAll) return;
  const perms = await chrome.permissions.getAll();
  const origins = (perms.origins || []).filter(
    (o) => !o.includes('127.0.0.1') && !o.includes('localhost')
  );

  if (origins.length === 0) {
    els.grantedOriginsList.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">No automatic site permissions granted yet (Using activeTab on click).</span>`;
    return;
  }

  els.grantedOriginsList.innerHTML = origins
    .map(
      (origin) => `
      <span class="tag-chip" style="padding:3px 10px;font-size:12px;">
        🌐 ${origin}
        <button data-revoke-origin="${origin}" title="Revoke auto-restore on ${origin}" style="margin-left:4px;">&times;</button>
      </span>
    `
    )
    .join('');
}

function saveCurrentVendorTabToMemory() {
  if (!settings.llmConfig[editingVendor]) {
    settings.llmConfig[editingVendor] = {};
  }
  settings.llmConfig[editingVendor].endpoint = els.vendorEndpointInput.value.trim();
  settings.llmConfig[editingVendor].model = els.vendorModelInput.value.trim();
  settings.llmConfig[editingVendor].apiKey = els.vendorApiKeyInput.value.trim();
}

function loadVendorFields(vendor) {
  editingVendor = vendor;
  document.querySelectorAll('.vendor-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.vendor === vendor);
  });

  const cfg = settings.llmConfig?.[vendor] || {};
  els.vendorEndpointInput.value = cfg.endpoint || '';
  els.vendorModelInput.value = cfg.model || '';
  els.vendorApiKeyInput.value = cfg.apiKey || '';

  renderModelPresets(vendor);
}

function renderModelPresets(vendor) {
  if (!els.modelPresetsContainer) return;
  const presets = MODEL_PRESETS[vendor] || [];
  els.modelPresetsContainer.innerHTML = presets
    .map((m) => `<span class="preset-chip" data-preset-model="${m}">${m}</span>`)
    .join('');
}

function collectAllSettingsFromForm() {
  saveCurrentVendorTabToMemory();

  settings.obsidianProtocol = els.obsidianProtocol.value;
  settings.obsidianPort = els.obsidianPort.value.trim() || '27123';
  settings.obsidianHost = els.obsidianHost.value.trim() || '127.0.0.1';
  settings.obsidianApiKey = els.obsidianApiKey.value.trim();
  settings.defaultFolder = els.defaultFolder.value.trim() || 'Clippings';
  settings.attachmentsFolder = els.attachmentsFolder.value.trim() || 'Attachments';

  settings.llmVendor = els.activeVendorSelect.value;
  settings.summaryStyle = els.summaryStyleSelect.value;
  settings.maxAutoTags = Number(els.maxAutoTagsInput.value) || 6;
  settings.tagPrefix = els.tagPrefixInput.value.trim();
  settings.customSummaryPrompt = els.customSummaryPromptInput.value.trim();

  if (els.annotatorEnabledCheckbox) {
    settings.annotatorEnabled = els.annotatorEnabledCheckbox.checked;
  }
  if (els.annotatorDefaultColorSelect) {
    settings.annotatorDefaultColor = els.annotatorDefaultColorSelect.value;
    settings.annotatorSyncMode = els.annotatorSyncModeSelect.value;
    settings.annotatorObsidianFormat = els.annotatorObsidianFormatSelect.value;
    settings.annotatorFuzzyThreshold = Number(els.annotatorFuzzyThresholdInput.value) || 0.78;
    settings.annotatorBlockedDomains = els.annotatorBlockedDomainsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  settings.autoSyncOnEdit = els.autoSyncOnEditCheckbox.checked;
  settings.syncIntervalSeconds = Math.max(Number(els.syncIntervalInput.value) || 10, 4);

  if (settings.templates && settings.templates[0]) {
    settings.templates[0].content = els.defaultTemplateTextarea.value;
    settings.templates[0].folder = settings.defaultFolder;
  }

  return settings;
}

function bindEvents() {
  els.obsidianProtocol.addEventListener('change', () => {
    if (els.obsidianProtocol.value === 'https' && els.obsidianPort.value === '27123') {
      els.obsidianPort.value = '27124';
    } else if (els.obsidianProtocol.value === 'http' && els.obsidianPort.value === '27124') {
      els.obsidianPort.value = '27123';
    }
  });

  els.vendorConfigTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vendor]');
    if (!btn) return;
    saveCurrentVendorTabToMemory();
    loadVendorFields(btn.dataset.vendor);
  });

  els.activeVendorSelect.addEventListener('change', () => {
    saveCurrentVendorTabToMemory();
    loadVendorFields(els.activeVendorSelect.value);
  });

  if (els.modelPresetsContainer) {
    els.modelPresetsContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-preset-model]');
      if (chip) {
        els.vendorModelInput.value = chip.dataset.presetModel;
      }
    });
  }

  els.enableEverywhereBtn?.addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({
        origins: ['http://*/*', 'https://*/*']
      });
      if (granted) {
        await chrome.runtime.sendMessage({ type: 'SYNC_REGISTERED_SCRIPTS' });
        await renderGrantedPermissionsList();
        showToast('Enabled automatic annotation restoration on all websites!');
      }
    } catch (err) {
      showToast(`Permission error: ${err.message}`, true);
    }
  });

  els.grantedOriginsList?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke-origin]');
    if (!btn) return;
    const origin = btn.dataset.revokeOrigin;
    await chrome.permissions.remove({ origins: [origin] });
    await chrome.runtime.sendMessage({ type: 'SYNC_REGISTERED_SCRIPTS' });
    await renderGrantedPermissionsList();
    showToast(`Revoked automatic access for ${origin}`);
  });

  els.saveAllSettingsBtn.addEventListener('click', async () => {
    const updated = collectAllSettingsFromForm();
    await saveSettings(updated);
    showToast('Settings saved!');
  });

  els.testObsidianBtn.addEventListener('click', async () => {
    const updated = collectAllSettingsFromForm();
    await saveSettings(updated);
    els.obsidianTestResult.className = 'test-result-box show';
    els.obsidianTestResult.textContent = 'Connecting to Obsidian Local REST API...';

    const client = new ObsidianClient(updated);
    const res = await client.checkConnection();
    if (res.connected) {
      els.obsidianTestResult.style.borderColor = '#10b981';
      els.obsidianTestResult.textContent = `Connected! Service: ${res.service} | Authenticated: ${res.authenticated ? 'Yes' : 'No (Check API Key)'}`;
    } else {
      els.obsidianTestResult.style.borderColor = '#ef4444';
      els.obsidianTestResult.textContent = `Connection Failed: ${res.error}. Ensure Obsidian is running and Local REST API plugin is enabled.`;
    }
  });

  els.testLlmBtn.addEventListener('click', async () => {
    const updated = collectAllSettingsFromForm();
    await saveSettings(updated);
    els.llmTestResult.className = 'test-result-box show';
    els.llmTestResult.textContent = `Testing ${updated.llmVendor.toUpperCase()} (${updated.llmConfig?.[updated.llmVendor]?.model || ''})...`;

    try {
      const llm = new LLMService(updated);
      const reply = await llm.complete({
        systemPrompt: 'Reply in one short sentence confirming connection.',
        userPrompt: 'Ping test from Obsidian Web Companion.',
        temperature: 0.1
      });
      els.llmTestResult.style.borderColor = '#10b981';
      els.llmTestResult.textContent = `Success (${updated.llmVendor}): "${reply}"`;
    } catch (err) {
      els.llmTestResult.style.borderColor = '#ef4444';
      els.llmTestResult.textContent = `Error: ${err.message}`;
    }
  });
}

document.addEventListener('DOMContentLoaded', initOptions);
