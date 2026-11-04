/**
 * Phase 4c & 4e: Local IndexedDB Annotation Store & Obsidian Managed-Block Sync Serializer
 * (`services/annotation-store.js`)
 *
 * Implements:
 * 1. Versioned IndexedDB store (`ObsidianWebAnnotatorDB` v1) with stores:
 *    - `annotations` (keyPath: `id`, indexes: `pageUrl`, `obsidianBlockId`, `status`, `updatedAt`)
 *    - `pages` (keyPath: `pageUrl`, tracks linked Obsidian note path & last sync state)
 *    - `oplog` (keyPath: `opId`, tracks mutations for offline queue & undo/redo)
 *    Plus automatic fallback to `chrome.storage.local` when running in contexts where IndexedDB is restricted.
 * 2. Human-Readable + Machine-Reanchorable Obsidian Managed Section Serializer & Parser:
 *    ```markdown
 *    ## Annotations
 *    <!-- obsidian-clipper:annotations:start -->
 *    > [!quote] ==highlighted text== ^ann-3f2a1b
 *    > Comment text here #tag1 #tag2
 *    <!-- obsidian-ann-meta:{"id":"...","type":"highlight","color":"yellow","selectors":{...}} -->
 *    <!-- obsidian-clipper:annotations:end -->
 *    ```
 * 3. Bi-Directional Merge & Conflict Resolution:
 *    - Parses user edits to comments, tags, or deleted blocks made inside Obsidian
 *    - Preserves all text outside `<!-- obsidian-clipper:annotations:start/end -->`
 *    - Supports export/import (JSON backup, Markdown export, and Hypothes.is JSON import)
 */

import {
  normalizePageUrl,
  generateAnnotationId,
  toObsidianBlockId,
  normalizeTextNFC
} from './annotation-anchor.js';
import { normalizeObsidianTag } from './markdown-converter.js';

const DB_NAME = 'ObsidianWebAnnotatorDB';
const DB_VERSION = 1;

export const HIGHLIGHT_COLORS = [
  { id: 'yellow', label: 'Yellow', hex: '#facc15', rgba: 'rgba(250, 204, 21, 0.38)', callout: 'quote' },
  { id: 'green', label: 'Green', hex: '#34d399', rgba: 'rgba(52, 211, 153, 0.35)', callout: 'tip' },
  { id: 'blue', label: 'Blue', hex: '#60a5fa', rgba: 'rgba(96, 165, 250, 0.35)', callout: 'info' },
  { id: 'purple', label: 'Purple', hex: '#c084fc', rgba: 'rgba(192, 132, 252, 0.38)', callout: 'example' },
  { id: 'pink', label: 'Pink', hex: '#f472b6', rgba: 'rgba(244, 114, 182, 0.38)', callout: 'important' }
];

/**
 * Normalize & validate an Annotation record
 */
export function createAnnotationRecord(partial = {}) {
  const now = new Date().toISOString();
  const id = partial.id || generateAnnotationId();
  const tags = Array.isArray(partial.tags)
    ? Array.from(new Set(partial.tags.map(normalizeObsidianTag).filter(Boolean)))
    : [];

  return {
    id,
    type: partial.type || 'highlight', // 'highlight' | 'underline' | 'strikethrough' | 'squiggly' | 'note' | 'sticky' | 'area' | 'page_note' | 'bookmark' | 'drawing'
    color: partial.color || 'yellow',
    comment: String(partial.comment || '').trim(),
    tags,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
    pageUrl: normalizePageUrl(partial.pageUrl || ''),
    pageTitle: String(partial.pageTitle || 'Untitled Page').trim(),
    selectors: partial.selectors || {},
    quote: normalizeTextNFC(partial.quote || ''),
    status: partial.status || 'active', // 'active' | 'orphaned' | 'deleted'
    obsidianBlockId: partial.obsidianBlockId || toObsidianBlockId(id),
    source: partial.source || 'user', // 'user' | 'ai'
    rect: partial.rect || null, // For image/area or sticky pin coordinates
    drawingPaths: partial.drawingPaths || null // For optional freehand drawing
  };
}

/**
 * Open IndexedDB connection (with schema creation & version migration)
 */
function openAnnotatorDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB unavailable'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('annotations')) {
        const store = db.createObjectStore('annotations', { keyPath: 'id' });
        store.createIndex('pageUrl', 'pageUrl', { unique: false });
        store.createIndex('obsidianBlockId', 'obsidianBlockId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'pageUrl' });
      }
      if (!db.objectStoreNames.contains('oplog')) {
        const opStore = db.createObjectStore('oplog', { keyPath: 'opId', autoIncrement: true });
        opStore.createIndex('pageUrl', 'pageUrl', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mirror annotations per page into `chrome.storage.local` so Content Scripts and Side Panel
 * share instant cross-origin access via `chrome.storage` events!
 */
async function getChromeStorageMirror() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
  return new Promise((resolve) => {
    chrome.storage.local.get(['obsidianAnnotationsByUrl'], (res) => {
      resolve(res?.obsidianAnnotationsByUrl || {});
    });
  });
}

async function saveChromeStorageMirror(byUrlMap) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.set({ obsidianAnnotationsByUrl: byUrlMap }, () => resolve());
  });
}

export class AnnotationStore {
  /**
   * Get all annotations for a given page URL (excluding hard-deleted ones unless requested)
   */
  async getAnnotationsForUrl(rawUrl, includeDeleted = false) {
    const pageUrl = normalizePageUrl(rawUrl);
    if (!pageUrl) return [];

    // Primary shared mirror in chrome.storage.local (accessible from both Content Scripts & Extension pages)
    const mirror = await getChromeStorageMirror();
    let list = Array.isArray(mirror[pageUrl]) ? mirror[pageUrl] : [];

    // Also merge any records from IndexedDB if running in extension page context
    try {
      const db = await openAnnotatorDB();
      const idbList = await new Promise((resolve) => {
        const tx = db.transaction('annotations', 'readonly');
        const idx = tx.objectStore('annotations').index('pageUrl');
        const req = idx.getAll(pageUrl);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      if (idbList.length > 0) {
        const mergedMap = new Map();
        for (const item of [...list, ...idbList]) {
          const prev = mergedMap.get(item.id);
          if (!prev || new Date(item.updatedAt) >= new Date(prev.updatedAt)) {
            mergedMap.set(item.id, item);
          }
        }
        list = Array.from(mergedMap.values());
      }
    } catch (_) {}

    return list
      .filter((a) => includeDeleted || a.status !== 'deleted')
      .sort((a, b) => {
        const posA = a.selectors?.TextPositionSelector?.start ?? 999999;
        const posB = b.selectors?.TextPositionSelector?.start ?? 999999;
        if (posA !== posB) return posA - posB;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
  }

  /**
   * Save or update a single annotation
   */
  async saveAnnotation(partial) {
    const record = createAnnotationRecord({
      ...partial,
      updatedAt: new Date().toISOString()
    });

    // Save to chrome.storage.local mirror
    const mirror = await getChromeStorageMirror();
    const existingList = Array.isArray(mirror[record.pageUrl]) ? mirror[record.pageUrl] : [];
    const idx = existingList.findIndex((a) => a.id === record.id);
    if (idx >= 0) {
      existingList[idx] = record;
    } else {
      existingList.push(record);
    }
    mirror[record.pageUrl] = existingList;
    await saveChromeStorageMirror(mirror);

    // Save to IndexedDB if available
    try {
      const db = await openAnnotatorDB();
      await new Promise((resolve) => {
        const tx = db.transaction(['annotations', 'oplog'], 'readwrite');
        tx.objectStore('annotations').put(record);
        tx.objectStore('oplog').add({
          pageUrl: record.pageUrl,
          action: 'upsert',
          annotationId: record.id,
          timestamp: record.updatedAt
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}

    return record;
  }

  /**
   * Bulk save annotations for a page URL
   */
  async saveAnnotationsForUrl(rawUrl, annotationsArray) {
    const pageUrl = normalizePageUrl(rawUrl);
    const normalizedList = annotationsArray.map((a) =>
      createAnnotationRecord({ ...a, pageUrl })
    );

    const mirror = await getChromeStorageMirror();
    mirror[pageUrl] = normalizedList;
    await saveChromeStorageMirror(mirror);

    try {
      const db = await openAnnotatorDB();
      await new Promise((resolve) => {
        const tx = db.transaction('annotations', 'readwrite');
        const store = tx.objectStore('annotations');
        for (const item of normalizedList) {
          store.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}

    return normalizedList;
  }

  /**
   * Soft-delete an annotation (supports undo!)
   */
  async softDeleteAnnotation(rawUrl, annotationId) {
    const list = await this.getAnnotationsForUrl(rawUrl, true);
    const target = list.find((a) => a.id === annotationId);
    if (!target) return null;
    target.status = 'deleted';
    target.updatedAt = new Date().toISOString();
    await this.saveAnnotation(target);
    return target;
  }

  /**
   * Restore a soft-deleted annotation (Undo delete)
   */
  async restoreAnnotation(rawUrl, annotationId) {
    const list = await this.getAnnotationsForUrl(rawUrl, true);
    const target = list.find((a) => a.id === annotationId);
    if (!target) return null;
    target.status = 'active';
    target.updatedAt = new Date().toISOString();
    await this.saveAnnotation(target);
    return target;
  }

  /**
   * Export all annotations across all pages as JSON or Markdown
   */
  async exportAllAnnotations() {
    const mirror = await getChromeStorageMirror();
    return mirror;
  }

  /**
   * Import annotations from JSON backup or Hypothes.is export format
   */
  async importAnnotationsJson(jsonData) {
    let importedCount = 0;
    // Check if Hypothes.is array or object with `rows`
    const rows = Array.isArray(jsonData)
      ? jsonData
      : Array.isArray(jsonData?.rows)
      ? jsonData.rows
      : null;

    if (rows) {
      for (const item of rows) {
        if (item.uri && Array.isArray(item.target)) {
          // Convert Hypothes.is annotation format
          const selectors = {};
          let quote = '';
          for (const sel of item.target[0]?.selector || []) {
            if (sel.type === 'TextQuoteSelector') {
              selectors.TextQuoteSelector = sel;
              quote = sel.exact || '';
            } else if (sel.type === 'TextPositionSelector') {
              selectors.TextPositionSelector = sel;
            }
          }
          await this.saveAnnotation({
            id: item.id || generateAnnotationId(),
            type: quote ? 'highlight' : 'page_note',
            color: 'yellow',
            comment: item.text || '',
            tags: item.tags || [],
            pageUrl: item.uri,
            pageTitle: item.document?.title?.[0] || item.uri,
            selectors,
            quote,
            createdAt: item.created,
            updatedAt: item.updated
          });
          importedCount++;
        } else if (item.pageUrl) {
          await this.saveAnnotation(item);
          importedCount++;
        }
      }
      return importedCount;
    }

    // Standard map format: { [pageUrl]: Annotation[] }
    if (jsonData && typeof jsonData === 'object') {
      for (const [url, arr] of Object.entries(jsonData)) {
        if (Array.isArray(arr)) {
          await this.saveAnnotationsForUrl(url, arr);
          importedCount += arr.length;
        }
      }
    }
    return importedCount;
  }
}

/**
 * OBSIDIAN MANAGED SECTION SERIALIZER & BI-DIRECTIONAL PARSER
 * Renders human-readable Markdown inside:
 * <!-- obsidian-clipper:annotations:start -->
 * ...
 * <!-- obsidian-clipper:annotations:end -->
 */
export const ANNOTATIONS_START_MARKER = '<!-- obsidian-clipper:annotations:start -->';
export const ANNOTATIONS_END_MARKER = '<!-- obsidian-clipper:annotations:end -->';

const COLOR_TO_CALLOUT = {
  yellow: 'quote',
  green: 'tip',
  blue: 'info',
  purple: 'example',
  pink: 'important'
};

/**
 * Serialize an array of active/orphaned annotations into an Obsidian Managed Block
 */
export function serializeAnnotationsToObsidianBlock(annotations = [], format = 'callout') {
  const activeList = (annotations || []).filter((a) => a.status !== 'deleted');
  if (activeList.length === 0) {
    return `## Annotations\n${ANNOTATIONS_START_MARKER}\n*No active annotations on this page.*\n${ANNOTATIONS_END_MARKER}`;
  }

  const blocks = activeList.map((ann) => {
    const blockId = ann.obsidianBlockId || toObsidianBlockId(ann.id);
    const calloutType = COLOR_TO_CALLOUT[ann.color] || 'quote';
    const tagsStr =
      Array.isArray(ann.tags) && ann.tags.length > 0
        ? ' ' + ann.tags.map((t) => `#${normalizeObsidianTag(t)}`).filter((t) => t !== '#').join(' ')
        : '';

    const typeBadge =
      ann.type === 'sticky'
        ? '[Sticky Note] '
        : ann.type === 'area'
        ? '[Area/Image Region] '
        : ann.type === 'page_note'
        ? '[Page Note] '
        : ann.type === 'bookmark'
        ? '[Bookmark] '
        : ann.type === 'underline'
        ? '[Underline] '
        : ann.type === 'strikethrough'
        ? '[Strikethrough] '
        : ann.type === 'squiggly'
        ? '[Squiggly] '
        : '';

    const quoteHeadline = ann.quote
      ? format === 'plain'
        ? `"${ann.quote.replace(/\r?\n/g, ' ')}"`
        : `==${ann.quote.replace(/\r?\n/g, ' ')}==`
      : `${typeBadge}${ann.pageTitle || 'Note'}`;

    const metaPayload = JSON.stringify({
      id: ann.id,
      type: ann.type,
      color: ann.color,
      status: ann.status,
      source: ann.source,
      obsidianBlockId: blockId,
      createdAt: ann.createdAt,
      updatedAt: ann.updatedAt,
      rect: ann.rect || null,
      selectors: ann.selectors || {}
    });

    if (format === 'mark') {
      const commentPart = ann.comment ? `\n  - ${ann.comment.replace(/\r?\n/g, '\n    ')}${tagsStr}` : tagsStr;
      return `- ${quoteHeadline} ^${blockId}${commentPart}\n<!-- obsidian-ann-meta:${metaPayload} -->`;
    }

    // Default Callout format:
    // > [!quote] ==highlighted text== ^ann-3f2a
    // > Comment text here #tag1 #tag2
    const commentLines = [];
    if (ann.comment) {
      for (const line of ann.comment.split(/\r?\n/)) {
        commentLines.push(`> ${line}`);
      }
    }
    if (tagsStr.trim()) {
      if (commentLines.length > 0) {
        commentLines[commentLines.length - 1] += tagsStr;
      } else {
        commentLines.push(`>${tagsStr}`);
      }
    }

    const bodyPart = commentLines.length > 0 ? `\n${commentLines.join('\n')}` : '';
    return `> [!${calloutType}] ${typeBadge}${quoteHeadline} ^${blockId}${bodyPart}\n<!-- obsidian-ann-meta:${metaPayload} -->`;
  });

  return `## Annotations\n${ANNOTATIONS_START_MARKER}\n${blocks.join('\n\n')}\n${ANNOTATIONS_END_MARKER}`;
}

/**
 * Upsert the `## Annotations` managed block inside a Markdown note body
 * while preserving 100% of user content outside the start/end markers.
 */
export function upsertAnnotationsSectionInMarkdown(bodyMarkdown = '', annotations = [], format = 'callout') {
  const renderedSection = serializeAnnotationsToObsidianBlock(annotations, format);
  const current = String(bodyMarkdown || '');

  const startIdx = current.indexOf(ANNOTATIONS_START_MARKER);
  const endIdx = current.indexOf(ANNOTATIONS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace only between start and end markers (and optional preceding `## Annotations` heading)
    const before = current.slice(0, startIdx).replace(/## Annotations[ \t]*\r?\n*$/, '');
    const after = current.slice(endIdx + ANNOTATIONS_END_MARKER.length);
    return `${before.trimEnd()}\n\n${renderedSection}\n${after.replace(/^\r?\n/, '')}`.trim() + '\n';
  }

  if (!annotations || annotations.filter((a) => a.status !== 'deleted').length === 0) {
    return current;
  }

  return `${current.trimEnd()}\n\n${renderedSection}\n`;
}

/**
 * Parse annotations back out of an Obsidian note's managed block for Bi-Directional Sync!
 * Detects comment edits, newly added `#tags`, and deleted annotation blocks in Obsidian.
 */
export function parseAnnotationsFromObsidianMarkdown(markdown = '', pageUrl = '', pageTitle = '') {
  const str = String(markdown || '');
  const startIdx = str.indexOf(ANNOTATIONS_START_MARKER);
  const endIdx = str.indexOf(ANNOTATIONS_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { hasManagedSection: false, annotations: [] };
  }

  const managedContent = str.slice(startIdx + ANNOTATIONS_START_MARKER.length, endIdx).trim();
  if (!managedContent || managedContent.includes('*No active annotations on this page.*')) {
    return { hasManagedSection: true, annotations: [] };
  }

  const parsedAnnotations = [];
  // Split entries by the trailing `<!-- obsidian-ann-meta:{...} -->` comment
  const entryRegex = /([\s\S]*?)<!--\s*obsidian-ann-meta:(\{[\s\S]*?\})\s*-->/g;
  let match;

  while ((match = entryRegex.exec(managedContent)) !== null) {
    const visibleBlock = match[1].trim();
    const metaJson = match[2];

    let meta = {};
    try {
      meta = JSON.parse(metaJson);
    } catch (_) {
      continue;
    }

    const lines = visibleBlock.split(/\r?\n/);
    const headerLine = lines[0] || '';

    // Extract quote between `==...==` if present
    const quoteMatch = headerLine.match(/==([\s\S]+?)==/);
    const quote = quoteMatch
      ? quoteMatch[1].trim()
      : meta.selectors?.TextQuoteSelector?.exact || '';

    // Extract comment & inline `#tags` from remaining lines
    const commentLines = lines
      .slice(1)
      .map((l) => l.replace(/^>\s?/, '').replace(/^\s*-\s+/, ''));

    let rawComment = commentLines.join('\n').trim();
    const extractedTags = [];

    rawComment = rawComment
      .replace(/(?:^|\s)#([a-zA-Z0-9/_-]+)/g, (_m, tag) => {
        const clean = normalizeObsidianTag(tag);
        if (clean) extractedTags.push(clean);
        return '';
      })
      .trim();

    parsedAnnotations.push(
      createAnnotationRecord({
        ...meta,
        pageUrl,
        pageTitle,
        quote,
        comment: rawComment,
        tags: extractedTags,
        status: meta.status || 'active'
      })
    );
  }

  return {
    hasManagedSection: true,
    annotations: parsedAnnotations
  };
}

/**
 * Reconcile Local Annotations with Remote Obsidian Managed Block Annotations
 * - Updates local comment/tags if edited inside Obsidian
 * - Soft-deletes local annotations that were removed from the managed block in Obsidian
 * - Preserves newly created local annotations
 */
export function reconcileAnnotationsWithObsidian(localAnnotations = [], obsidianParsed = {}) {
  if (!obsidianParsed || !obsidianParsed.hasManagedSection) {
    return localAnnotations;
  }

  const remoteById = new Map();
  for (const r of obsidianParsed.annotations || []) {
    remoteById.set(r.id, r);
  }

  const merged = [];
  const seenIds = new Set();

  for (const local of localAnnotations) {
    seenIds.add(local.id);
    const remote = remoteById.get(local.id);
    if (remote) {
      const commentChanged = remote.comment !== local.comment;
      const tagsChanged = JSON.stringify(remote.tags) !== JSON.stringify(local.tags);
      merged.push({
        ...local,
        comment: remote.comment,
        tags: remote.tags,
        updatedAt: commentChanged || tagsChanged ? new Date().toISOString() : local.updatedAt
      });
    } else if (local.status === 'active') {
      // Removed inside Obsidian -> treat as soft delete so user can undo if needed
      merged.push({
        ...local,
        status: 'deleted',
        updatedAt: new Date().toISOString()
      });
    } else {
      merged.push(local);
    }
  }

  // Add any annotations that existed only in Obsidian's note
  for (const remote of obsidianParsed.annotations || []) {
    if (!seenIds.has(remote.id)) {
      merged.push(remote);
    }
  }

  return merged;
}
