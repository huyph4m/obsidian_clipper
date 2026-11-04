/**
 * Obsidian Local REST API Client
 * Supports full CRUD on vault files, full recursive directory tree discovery,
 * bi-directional sync, binary image saving, active file / periodic notes, and vault-wide search.
 */

import { getSettings, getBaseUrl } from './storage.js';

export class ObsidianClient {
  constructor(settings = null) {
    this.settings = settings;
  }

  async init() {
    if (!this.settings) {
      this.settings = await getSettings();
    }
    return this;
  }

  getHeaders(accept = 'application/json', contentType = null) {
    const headers = {
      Accept: accept
    };
    if (this.settings?.obsidianApiKey) {
      headers['Authorization'] = `Bearer ${this.settings.obsidianApiKey.trim()}`;
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  encodePath(vaultPath) {
    const clean = (vaultPath || '')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/');
    return clean
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  async request(path, options = {}) {
    await this.init();
    const baseUrl = getBaseUrl(this.settings);
    const url = `${baseUrl}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getHeaders(options.accept, options.contentType),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      let errText = '';
      try {
        errText = await response.text();
      } catch (_) {
        errText = response.statusText;
      }
      throw new Error(`Obsidian API Error (${response.status}): ${errText || response.statusText}`);
    }

    if (response.status === 204) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('application/vnd.olrapi')) {
      return await response.json();
    }
    return await response.text();
  }

  /**
   * Test connection to Obsidian Local REST API
   */
  async checkConnection() {
    try {
      await this.init();
      const data = await this.request('/', { method: 'GET' });
      return {
        connected: true,
        authenticated: Boolean(data?.authenticated),
        status: data?.status || 'OK',
        versions: data?.versions || {},
        service: data?.service || 'Obsidian Local REST API'
      };
    } catch (error) {
      return {
        connected: false,
        authenticated: false,
        error: error.message
      };
    }
  }

  /**
   * Recursively list all available folders across the entire Obsidian vault
   * Uses parallel breadth-first traversal per level for fast discovery even on deep vaults.
   */
  async listFolders(rootPath = '', maxDepth = 8, currentDepth = 0) {
    if (currentDepth > maxDepth) return [];
    const encoded = this.encodePath(rootPath);
    const endpoint = encoded ? `/vault/${encoded}/` : '/vault/';
    try {
      const data = await this.request(endpoint, { method: 'GET' });
      const files = data?.files || [];
      const directFolders = [];

      for (const item of files) {
        if (item.endsWith('/')) {
          const folderName = item.replace(/\/$/, '');
          // Skip hidden system directories like .obsidian or .git
          if (folderName.startsWith('.')) continue;
          const fullFolder = rootPath ? `${rootPath}/${folderName}` : folderName;
          directFolders.push(fullFolder);
        }
      }

      if (currentDepth + 1 <= maxDepth && directFolders.length > 0) {
        const subFolderArrays = await Promise.all(
          directFolders.map((folder) => this.listFolders(folder, maxDepth, currentDepth + 1))
        );
        for (const sub of subFolderArrays) {
          directFolders.push(...sub);
        }
      }

      return Array.from(new Set(directFolders)).sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.warn('Error listing folders at', rootPath, err);
      return [];
    }
  }

  /**
   * List all files inside a specific vault folder
   */
  async listFilesInFolder(folderPath = '') {
    const encoded = this.encodePath(folderPath);
    const endpoint = encoded ? `/vault/${encoded}/` : '/vault/';
    const data = await this.request(endpoint, { method: 'GET' });
    return (data?.files || []).map((f) => ({
      name: f.replace(/\/$/, ''),
      path: folderPath ? `${folderPath.replace(/\/$/, '')}/${f.replace(/\/$/, '')}` : f.replace(/\/$/, ''),
      isFolder: f.endsWith('/')
    }));
  }

  /**
   * Read a note from the vault (with optional JSON metadata including frontmatter & stat)
   */
  async getNote(vaultPath, asJson = true) {
    const encoded = this.encodePath(vaultPath);
    const accept = asJson ? 'application/vnd.olrapi.note+json' : 'text/markdown';
    return await this.request(`/vault/${encoded}`, {
      method: 'GET',
      accept
    });
  }

  /**
   * Create or overwrite a note in the vault (PUT /vault/{path})
   */
  async saveNote(vaultPath, markdownContent) {
    const encoded = this.encodePath(vaultPath);
    await this.request(`/vault/${encoded}`, {
      method: 'PUT',
      accept: '*/*',
      contentType: 'text/markdown',
      body: markdownContent
    });
    return { success: true, path: vaultPath, updatedAt: Date.now() };
  }

  /**
   * Append content to an existing note or create if not exists (POST /vault/{path})
   */
  async appendToNote(vaultPath, markdownContent) {
    const encoded = this.encodePath(vaultPath);
    await this.request(`/vault/${encoded}`, {
      method: 'POST',
      accept: '*/*',
      contentType: 'text/markdown',
      body: `\n${markdownContent}`
    });
    return { success: true, path: vaultPath, updatedAt: Date.now() };
  }

  /**
   * Append content to Today's Daily Note via Periodic Notes endpoint or fallback path
   */
  async appendToDailyNote(markdownContent) {
    try {
      await this.request('/periodic/daily/', {
        method: 'POST',
        accept: '*/*',
        contentType: 'text/markdown',
        body: `\n${markdownContent}`
      });
      return { success: true, target: 'Periodic Daily Note' };
    } catch (_) {
      const today = new Date().toISOString().slice(0, 10);
      const folder = this.settings?.dailyNotesFolder || 'Daily Notes';
      const fallbackPath = `${folder}/${today}.md`;
      await this.appendToNote(fallbackPath, markdownContent);
      return { success: true, target: fallbackPath };
    }
  }

  /**
   * Save binary file (such as a captured image) directly into the Obsidian vault
   */
  async saveBinaryAttachment(vaultPath, arrayBuffer, mimeType = 'image/png') {
    await this.init();
    const encoded = this.encodePath(vaultPath);
    const baseUrl = getBaseUrl(this.settings);
    const url = `${baseUrl}/vault/${encoded}`;

    const headers = {
      'Content-Type': mimeType
    };
    if (this.settings?.obsidianApiKey) {
      headers['Authorization'] = `Bearer ${this.settings.obsidianApiKey.trim()}`;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: arrayBuffer
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to save attachment (${response.status}): ${errText}`);
    }

    return {
      success: true,
      path: vaultPath
    };
  }

  /**
   * Open a note inside Obsidian desktop app
   */
  async openInObsidian(vaultPath, newLeaf = false) {
    const encoded = this.encodePath(vaultPath);
    await this.request(`/open/${encoded}?newLeaf=${newLeaf ? 'true' : 'false'}`, {
      method: 'POST',
      accept: '*/*'
    });
    return { success: true };
  }

  /**
   * Search the vault using Simple Search endpoint (/search/simple/)
   */
  async searchSimple(query, contextLength = 120) {
    if (!query || !query.trim()) return [];
    const params = new URLSearchParams({
      query: query.trim(),
      contextLength: String(contextLength)
    });
    try {
      const results = await this.request(`/search/simple/?${params.toString()}`, {
        method: 'POST',
        accept: 'application/json'
      });
      return Array.isArray(results) ? results : [];
    } catch (err) {
      console.warn('Simple search error:', err);
      return [];
    }
  }

  /**
   * Find notes that reference the exact URL or domain, or share top keywords with the current web page
   */
  async findRelevantNotes({ url = '', title = '', keywords = [], maxResults = 8 }) {
    const scoreMap = new Map();

    const addResult = (item, weight, reason) => {
      if (!item || !item.filename) return;
      const existing = scoreMap.get(item.filename) || {
        filename: item.filename,
        score: 0,
        matches: [],
        reasons: new Set()
      };
      existing.score += weight * (item.score || 1);
      existing.reasons.add(reason);
      if (Array.isArray(item.matches)) {
        for (const m of item.matches.slice(0, 2)) {
          if (m.context && existing.matches.length < 3) {
            existing.matches.push(m.context.trim());
          }
        }
      }
      scoreMap.set(item.filename, existing);
    };

    if (url) {
      const cleanUrl = url.split('#')[0];
      const urlHits = await this.searchSimple(cleanUrl, 100);
      for (const hit of urlHits) {
        addResult(hit, 50, 'Same URL');
      }
    }

    const searchTerms = [];
    if (title) {
      const titleWords = title
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .slice(0, 3);
      if (titleWords.length > 0) {
        searchTerms.push({ term: titleWords.join(' '), weight: 10, label: 'Title match' });
      }
    }

    for (const kw of keywords.slice(0, 5)) {
      if (kw && kw.length >= 3) {
        searchTerms.push({ term: kw, weight: 6, label: `Topic: ${kw}` });
      }
    }

    const promises = searchTerms.slice(0, 5).map(async ({ term, weight, label }) => {
      const hits = await this.searchSimple(term, 90);
      for (const hit of hits.slice(0, 6)) {
        addResult(hit, weight, label);
      }
    });

    await Promise.all(promises);

    return Array.from(scoreMap.values())
      .map((entry) => ({
        filename: entry.filename,
        score: Math.round(entry.score * 10) / 10,
        snippets: entry.matches,
        reasons: Array.from(entry.reasons),
        isExactUrlMatch: entry.reasons.has('Same URL')
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }
}
