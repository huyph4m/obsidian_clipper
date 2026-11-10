/**
 * Default Configuration & Storage Manager for Obsidian Web Clipper & AI Companion
 * Includes Phase 4 In-Page Web Annotator settings:
 * - Color palette & default highlight color
 * - Tooltip behavior (hover/click, delay)
 * - Annotation sync mode (`auto` | `manual` | `local_only`)
 * - Obsidian rendering format (`callout` | `mark` | `plain`)
 * - URL normalization rules & per-domain AI blocklist
 */

export const DEFAULT_SETTINGS = {
  // Obsidian Local REST API Connection
  obsidianProtocol: 'http', // 'http' (default port 27123) or 'https' (default port 27124)
  obsidianHost: '127.0.0.1',
  obsidianPort: '27123',
  obsidianApiKey: '',
  defaultFolder: 'Clippings',
  attachmentsFolder: 'Attachments',
  dailyNotesFolder: 'Daily Notes',
  fileNameTemplate: '{{title}}',

  // Capture & Sync Preferences
  includeFrontmatter: true,
  frontmatterFields: ['title', 'source', 'domain', 'author', 'created', 'status', 'description', 'annotations_count', 'tags'],
  captureImagesMode: 'link', // 'link', 'download_vault', 'base64'
  autoSyncOnEdit: false,
  syncIntervalSeconds: 10,
  autoFindRelevantNotes: true,
  showFloatingButton: true,

  // Phase 4: In-Page Web Annotator Settings
  annotatorEnabled: true, // Master toggle to enable/disable the In-Page Web Annotator module
  annotatorDefaultColor: 'yellow',
  annotatorSyncMode: 'auto', // 'auto' | 'manual' | 'local_only'
  annotatorObsidianFormat: 'callout', // 'callout' | 'mark' | 'plain'
  annotatorTooltipTrigger: 'hover_and_click', // 'hover_and_click' | 'click_only'
  annotatorHoverDelayMs: 280,
  annotatorFuzzyThreshold: 0.78,
  annotatorShowInPrint: true,
  annotatorEnableDrawing: false,
  annotatorStripTrackingParams: true,
  annotatorBlockedDomains: [], // Domains excluded from LLM calls & auto-injection

  // LLM / AI Configuration
  llmVendor: 'openai', // 'openai', 'deepseek', 'anthropic', 'gemini', 'ollama', 'custom'
  llmConfig: {
    openai: {
      apiKey: '',
      model: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    deepseek: {
      apiKey: '',
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/chat/completions'
    },
    anthropic: {
      apiKey: '',
      model: 'claude-3-5-sonnet-latest',
      endpoint: 'https://api.anthropic.com/v1/messages'
    },
    gemini: {
      apiKey: '',
      model: 'gemini-2.5-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models'
    },
    ollama: {
      apiKey: '',
      model: 'llama3.1',
      endpoint: 'http://localhost:11434/api/chat'
    },
    custom: {
      apiKey: '',
      model: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions'
    }
  },

  // AI Prompts & Tagging Settings
  maxAutoTags: 6,
  preferExistingVaultTags: true,
  tagPrefix: '',
  summaryStyle: 'bullet_key_takeaways', // 'concise', 'bullet_key_takeaways', 'executive', 'academic'
  customSummaryPrompt: '',

  // Note Body Templates (Metadata is stored automatically in Obsidian Note Properties)
  templates: [
    {
      id: 'default-article',
      name: 'Standard Web Article',
      folder: 'Clippings',
      content: `# {{title}}

{{content}}
`
    },
    {
      id: 'research-note',
      name: 'Research & Literature Note',
      folder: 'Research',
      content: `# {{title}}

{{summary}}

##Full Article Clipping
{{content}}
`
    },
    {
      id: 'quick-bookmark',
      name: 'Quick Bookmark & Summary',
      folder: 'Bookmarks',
      content: `# [{{title}}]({{url}})

{{summary}}
`
    }
  ],
  selectedTemplateId: 'default-article'
};

/**
 * Strip any legacy hardcoded YAML frontmatter or inline metadata bullets from saved templates
 */
function sanitizeTemplates(templates) {
  if (!Array.isArray(templates)) return DEFAULT_SETTINGS.templates;
  return templates.map((tpl) => {
    let cleanBody = String(tpl.content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
    cleanBody = cleanBody
      .replace(/^- \*\*Source:\*\*.*$\r?\n?/gm, '')
      .replace(/^- \*\*Author:\*\*.*$\r?\n?/gm, '')
      .replace(/^- \*\*Captured:\*\*.*$\r?\n?/gm, '')
      .trim();
    return {
      ...tpl,
      content: cleanBody + '\n'
    };
  });
}

export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['obsidianCompanionSettings'], (result) => {
      if (result && result.obsidianCompanionSettings) {
        const saved = result.obsidianCompanionSettings;
        const merged = {
          ...DEFAULT_SETTINGS,
          ...saved,
          llmConfig: {
            ...DEFAULT_SETTINGS.llmConfig,
            ...(saved.llmConfig || {}),
            deepseek: {
              ...DEFAULT_SETTINGS.llmConfig.deepseek,
              ...(saved.llmConfig?.deepseek || {})
            }
          },
          templates: sanitizeTemplates(saved.templates || DEFAULT_SETTINGS.templates)
        };
        resolve(merged);
      } else {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  });
}

export async function saveSettings(newSettings) {
  const sanitized = {
    ...newSettings,
    templates: sanitizeTemplates(newSettings.templates || DEFAULT_SETTINGS.templates)
  };
  return new Promise((resolve) => {
    chrome.storage.local.set({ obsidianCompanionSettings: sanitized }, () => {
      resolve(sanitized);
    });
  });
}

export function getBaseUrl(settings) {
  const protocol = (settings.obsidianProtocol || 'http').replace(':', '');
  const host = settings.obsidianHost || '127.0.0.1';
  const port = settings.obsidianPort || (protocol === 'https' ? '27124' : '27123');
  return `${protocol}://${host}:${port}`;
}
