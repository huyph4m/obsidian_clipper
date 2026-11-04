/**
 * Phase 4b, 4c, 4d: In-Page Web Annotator & Clipper Content Script (`content.js`)
 *
 * Implements:
 * 1. All 8 Annotation Types behind a unified `Annotation` model:
 *    - `highlight` (5 configurable colors + optional Markdown comment & tags)
 *    - `underline`, `strikethrough`, `squiggly` (text-anchored style variants)
 *    - `note` (rich-text/Markdown hover & click tooltip popover with inline edit, color picker, tag chips, related vault notes, and delete)
 *    - `sticky` (collapsible floating sticky note pinned to a DOM element or page coordinates that tracks scroll/resize)
 *    - `area` (click-and-drag rectangle on any image or page region, stored relative to the anchor element)
 *    - `page_note` (whole-page annotation)
 *    - `bookmark` (scroll-anchor bookmark flag in the margin)
 *    - `drawing` (optional freehand SVG pen overlay behind feature flag)
 * 2. Rendering Without Breaking the Host Page:
 *    - Uses CSS Custom Highlight API (`CSS.highlights`) for non-destructive text highlights where supported, plus restorable `<mark data-obsidian-ann-id>` wrappers for rich styles (`underline`, `strikethrough`, `squiggly`) and hover detection.
 *    - All extension UI (Selection Toolbar, Tooltip/Editor Popover, Sticky Notes, Area Rects, Bookmark Markers, and Permission Banner) lives inside an isolated **Shadow DOM** (`#obsidian-web-annotator-host`) with `all: initial` reset and adaptive dark/light theme.
 * 3. W3C Multi-Selector Anchoring & 4-Stage Re-Anchoring:
 *    - `TextQuoteSelector` (`exact`, `prefix`, `suffix`), `TextPositionSelector`, `RangeSelector` (XPath), and `ElementSelector`.
 *    - Debounced `MutationObserver` + `requestIdleCallback` for lazy-loaded content and SPA route navigation (`pushState`, `popstate`, `hashchange`).
 *    - Interactive **Re-attach Orphaned Annotation** mode.
 * 4. Undo / Redo stack for the current page session & full keyboard navigation (`Esc`, `Alt+N`, `Alt+P`, `Alt+H`).
 */

(function () {
  if (window.__obsidianCompanionInjected) return;
  window.__obsidianCompanionInjected = true;

  const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'igshid', 'mc_cid', 'mc_eid'
  ]);

  const COLORS = [
    { id: 'yellow', label: 'Yellow', hex: '#facc15', bg: 'rgba(250, 204, 21, 0.36)', border: '#eab308' },
    { id: 'green', label: 'Green', hex: '#34d399', bg: 'rgba(52, 211, 153, 0.34)', border: '#10b981' },
    { id: 'blue', label: 'Blue', hex: '#60a5fa', bg: 'rgba(96, 165, 250, 0.34)', border: '#3b82f6' },
    { id: 'purple', label: 'Purple', hex: '#c084fc', bg: 'rgba(192, 132, 252, 0.36)', border: '#a855f7' },
    { id: 'pink', label: 'Pink', hex: '#f472b6', bg: 'rgba(244, 114, 182, 0.36)', border: '#ec4899' }
  ];

  // Runtime State
  let currentUrl = normalizeUrl(window.location.href);
  let annotations = [];
  let activeDomRanges = new Map(); // ann.id -> Range
  let lastUsedColor = 'yellow';
  let annotationsVisible = true;
  let currentSelectionRange = null;
  let reattachingAnnotationId = null;
  let areaSelectionMode = false;
  let stickyPlacementMode = false;
  let freehandDrawingMode = false;
  let imagePickerActive = false;
  let hoveredImg = null;
  let activePopoverAnnId = null;
  let popoverPinned = false;
  let hoverTimer = null;
  let focusedAnnIndex = -1;

  // Session Undo / Redo Stacks
  const undoStack = [];
  const redoStack = [];

  // Shadow DOM Host & Root
  let shadowHost = null;
  let shadowRoot = null;
  let selectionToolbarEl = null;
  let popoverEl = null;
  let overlayLayerEl = null;
  let drawingSvgEl = null;
  let ariaLiveEl = null;

  /**
   * -------------------------------------------------------------------------
   * 1. SANITIZATION, URL & UNICODE HELPERS (Zero Unsanitized innerHTML)
   * -------------------------------------------------------------------------
   */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeMarkdownToHtml(md = '') {
    let safe = escapeHtml(md);
    safe = safe.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    safe = safe.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    safe = safe.replace(/\[\[([^\]]+)\]\]/g, '<span class="obs-wikilink">[[$1]]</span>');
    safe = safe.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    safe = safe.replace(/\n/g, '<br/>');
    return safe;
  }

  function normalizeTextNFC(str = '') {
    return String(str || '')
      .normalize('NFC')
      .replace(/\u00AD/g, '')
      .replace(/[\r\n\t\u00A0]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function normalizeUrl(rawUrl = '') {
    try {
      const u = new URL(rawUrl);
      for (const k of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAMS.has(k.toLowerCase()) || k.toLowerCase().startsWith('utm_')) {
          u.searchParams.delete(k);
        }
      }
      u.searchParams.sort();
      if (u.hash && !u.hash.startsWith('#/') && !u.hash.startsWith('#!')) {
        u.hash = '';
      }
      let out = u.toString();
      if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
      return out;
    } catch (_) {
      return String(rawUrl || '').split('#')[0].trim();
    }
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function announceAria(msg) {
    if (ariaLiveEl) ariaLiveEl.textContent = msg;
  }

  /**
   * -------------------------------------------------------------------------
   * 2. W3C SELECTOR GENERATION & 4-STAGE RE-ANCHORING ENGINE
   * -------------------------------------------------------------------------
   */
  function getNodeXPath(node, root = document.body) {
    if (!node || node === root) return '.';
    const parts = [];
    let curr = node;
    while (curr && curr !== root && curr !== document.documentElement) {
      if (curr.nodeType === Node.TEXT_NODE) {
        let idx = 1;
        let sib = curr.previousSibling;
        while (sib) {
          if (sib.nodeType === Node.TEXT_NODE) idx++;
          sib = sib.previousSibling;
        }
        parts.unshift(`text()[${idx}]`);
      } else if (curr.nodeType === Node.ELEMENT_NODE) {
        if (curr.hasAttribute && curr.hasAttribute('data-obsidian-ann-id')) {
          curr = curr.parentNode;
          continue;
        }
        const tag = curr.tagName.toLowerCase();
        let idx = 1;
        let sib = curr.previousElementSibling;
        while (sib) {
          if (sib.tagName.toLowerCase() === tag && !sib.hasAttribute('data-obsidian-ann-id')) idx++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(`${tag}[${idx}]`);
      }
      curr = curr.parentNode;
    }
    return './' + parts.join('/');
  }

  function resolveNodeXPath(xpath, root = document.body) {
    if (!xpath) return null;
    try {
      return document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch (_) {
      return null;
    }
  }

  function buildElementLocator(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      src: el.getAttribute('src') || '',
      xpath: getNodeXPath(el),
      textFingerprint: normalizeTextNFC(el.innerText || '').slice(0, 50)
    };
  }

  function resolveElementLocator(loc) {
    if (!loc) return null;
    if (loc.id && document.getElementById(loc.id)) return document.getElementById(loc.id);
    if (loc.src) {
      const img = Array.from(document.querySelectorAll(loc.tag || 'img')).find(
        (i) => i.src === loc.src || i.getAttribute('src') === loc.src
      );
      if (img) return img;
    }
    if (loc.xpath) {
      const node = resolveNodeXPath(loc.xpath);
      if (node && node.nodeType === Node.ELEMENT_NODE) return node;
    }
    return null;
  }

  function buildTextNodeIndex(root = document.body) {
    const segments = [];
    let fullText = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (p.closest('#obsidian-web-annotator-host') || p.closest('#obsidian-companion-toast')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.normalize('NFC');
      const start = fullText.length;
      fullText += t;
      segments.push({ node: n, start, end: fullText.length });
    }
    return { fullText, segments };
  }

  function buildSelectorsFromRange(range) {
    const { fullText, segments } = buildTextNodeIndex(document.body);
    const exact = range.toString().normalize('NFC');
    let globalStart = -1;
    let globalEnd = -1;

    for (const seg of segments) {
      if (seg.node === range.startContainer) globalStart = seg.start + range.startOffset;
      if (seg.node === range.endContainer) {
        globalEnd = seg.start + range.endOffset;
        break;
      }
    }
    if (globalStart === -1) {
      globalStart = fullText.indexOf(exact);
      globalEnd = globalStart !== -1 ? globalStart + exact.length : 0;
    }

    const prefix = fullText.slice(Math.max(0, globalStart - 32), Math.max(0, globalStart));
    const suffix = fullText.slice(Math.max(0, globalEnd), Math.min(fullText.length, globalEnd + 32));

    return {
      TextQuoteSelector: { type: 'TextQuoteSelector', exact, prefix, suffix },
      TextPositionSelector: { type: 'TextPositionSelector', start: Math.max(0, globalStart), end: Math.max(0, globalEnd) },
      RangeSelector: {
        type: 'RangeSelector',
        startContainerXPath: getNodeXPath(range.startContainer),
        startOffset: range.startOffset,
        endContainerXPath: getNodeXPath(range.endContainer),
        endOffset: range.endOffset
      }
    };
  }

  function stringSimilarity(a = '', b = '') {
    const s1 = normalizeTextNFC(a).trim();
    const s2 = normalizeTextNFC(b).trim();
    if (s1 === s2) return 1;
    if (!s1.length || !s2.length) return 0;
    const x = s1.slice(0, 240);
    const y = s2.slice(0, 240);
    const m = x.length;
    const n = y.length;
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      }
      [prev, curr] = [curr, prev];
    }
    return Math.max(0, 1 - prev[n] / Math.max(m, n));
  }

  function reanchorTextAnnotation(ann) {
    const sel = ann.selectors || {};
    const rangeSel = sel.RangeSelector;
    const quoteSel = sel.TextQuoteSelector;
    const posSel = sel.TextPositionSelector;
    const exact = (quoteSel?.exact || ann.quote || '').normalize('NFC');
    if (!exact) return null;

    // 1. Fast path via XPath RangeSelector
    if (rangeSel?.startContainerXPath && rangeSel?.endContainerXPath) {
      const sNode = resolveNodeXPath(rangeSel.startContainerXPath);
      const eNode = resolveNodeXPath(rangeSel.endContainerXPath);
      if (sNode && eNode) {
        try {
          const r = document.createRange();
          r.setStart(sNode, rangeSel.startOffset || 0);
          r.setEnd(eNode, rangeSel.endOffset || 0);
          if (normalizeTextNFC(r.toString()).trim() === normalizeTextNFC(exact).trim()) {
            return r;
          }
        } catch (_) {}
      }
    }

    const { fullText, segments } = buildTextNodeIndex(document.body);
    if (!fullText) return null;

    const hintStart = posSel?.start ?? 0;
    const prefix = (quoteSel?.prefix || '').normalize('NFC');
    const suffix = (quoteSel?.suffix || '').normalize('NFC');

    let bestStart = -1;
    let bestEnd = -1;
    let bestScore = -1;

    // 2. Exact quote search scored by prefix/suffix context
    let idx = fullText.indexOf(exact);
    while (idx !== -1) {
      const actPre = fullText.slice(Math.max(0, idx - prefix.length), idx);
      const actSuf = fullText.slice(idx + exact.length, idx + exact.length + suffix.length);
      const score =
        (prefix ? stringSimilarity(prefix, actPre) : 1) * 0.45 +
        (suffix ? stringSimilarity(suffix, actSuf) : 1) * 0.45 +
        0.1 * (1 - Math.min(1, Math.abs(idx - hintStart) / Math.max(fullText.length, 1)));
      if (score > bestScore) {
        bestScore = score;
        bestStart = idx;
        bestEnd = idx + exact.length;
      }
      idx = fullText.indexOf(exact, idx + 1);
    }

    // 3. Whitespace-tolerant regex fallback
    if (bestStart === -1) {
      const words = exact.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length > 0 && words.length <= 60) {
        try {
          const re = new RegExp(words.join('[\\s\\u00AD\\r\\n]+'), 'u');
          const m = re.exec(fullText);
          if (m) {
            bestStart = m.index;
            bestEnd = m.index + m[0].length;
          }
        } catch (_) {}
      }
    }

    // 4. Fuzzy window search near `hintStart`
    if (bestStart === -1 && exact.length >= 5) {
      const radius = 2000;
      const wStart = Math.max(0, hintStart - radius);
      const wEnd = Math.min(fullText.length, hintStart + exact.length + radius);
      const step = Math.max(1, Math.floor(exact.length / 5));
      let bestSim = 0.78;
      for (let p = wStart; p <= wEnd - exact.length; p += step) {
        const sim = stringSimilarity(exact, fullText.slice(p, p + exact.length));
        if (sim >= bestSim) {
          bestSim = sim;
          bestStart = p;
          bestEnd = p + exact.length;
        }
      }
    }

    if (bestStart === -1 || bestEnd <= bestStart) return null;

    // Map character offsets back to DOM Range
    let sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const seg of segments) {
      if (!sNode && bestStart >= seg.start && bestStart <= seg.end) {
        sNode = seg.node;
        sOff = Math.min(bestStart - seg.start, seg.node.nodeValue.length);
      }
      if (bestEnd >= seg.start && bestEnd <= seg.end) {
        eNode = seg.node;
        eOff = Math.min(bestEnd - seg.start, seg.node.nodeValue.length);
        break;
      }
    }
    if (!sNode || !eNode) return null;
    try {
      const range = document.createRange();
      range.setStart(sNode, sOff);
      range.setEnd(eNode, eOff);
      return range;
    } catch (_) {
      return null;
    }
  }

  /**
   * -------------------------------------------------------------------------
   * 3. ISOLATED SHADOW DOM UI (Toolbar, Popover, Sticky Notes, Area Overlay)
   * -------------------------------------------------------------------------
   */
  function initShadowDomUI() {
    if (shadowHost) return;
    shadowHost = document.createElement('div');
    shadowHost.id = 'obsidian-web-annotator-host';
    shadowHost.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;';
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #f4f4f6;
      }
      * { box-sizing: border-box; }
      .ann-toolbar {
        position: fixed;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 10px;
        background: #18181f;
        border: 1px solid #3f3f5a;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
        pointer-events: auto;
        z-index: 2147483647;
        user-select: none;
      }
      .ann-toolbar.visible { display: flex; }
      .swatch {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.25);
        cursor: pointer;
        transition: transform 0.12s ease, border-color 0.12s ease;
      }
      .swatch:hover, .swatch.active {
        transform: scale(1.18);
        border-color: #ffffff;
      }
      .tb-sep {
        width: 1px;
        height: 18px;
        background: #2e2e3d;
        margin: 0 2px;
      }
      .tb-btn {
        background: #22222c;
        border: 1px solid #323246;
        color: #e4e4f0;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .tb-btn:hover {
        background: #7c3aed;
        border-color: #8b5cf6;
        color: #fff;
      }
      /* Tooltip & Editor Popover */
      .ann-popover {
        position: fixed;
        display: none;
        flex-direction: column;
        gap: 8px;
        width: 320px;
        max-width: calc(100vw - 24px);
        padding: 12px;
        border-radius: 12px;
        background: #18181f;
        border: 1px solid #4b4b6b;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
        pointer-events: auto;
        z-index: 2147483647;
      }
      .ann-popover.visible { display: flex; }
      .pop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .pop-swatches {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .pop-textarea {
        width: 100%;
        min-height: 68px;
        background: #111115;
        color: #f4f4f6;
        border: 1px solid #2e2e3d;
        border-radius: 6px;
        padding: 7px 9px;
        font-size: 12px;
        font-family: inherit;
        resize: vertical;
        outline: none;
      }
      .pop-textarea:focus { border-color: #8b5cf6; }
      .pop-rendered {
        font-size: 12.5px;
        line-height: 1.45;
        color: #e4e4f0;
        background: #111115;
        padding: 8px 10px;
        border-radius: 6px;
        border-left: 3px solid #8b5cf6;
        max-height: 150px;
        overflow-y: auto;
      }
      .pop-tags {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pop-tag-chip {
        font-size: 10.5px;
        padding: 1px 7px;
        border-radius: 999px;
        background: rgba(124, 58, 237, 0.22);
        color: #c4b5fd;
        border: 1px solid rgba(139, 92, 246, 0.4);
      }
      .pop-tag-input {
        background: #111115;
        border: 1px solid #2e2e3d;
        color: #f4f4f6;
        border-radius: 5px;
        padding: 3px 6px;
        font-size: 11px;
        outline: none;
        flex: 1;
        min-width: 80px;
      }
      .pop-ai-row {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        padding-top: 4px;
        border-top: 1px solid #262636;
      }
      .pop-related-list {
        font-size: 11px;
        color: #a1a1b5;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .obs-wikilink {
        color: #a78bfa;
        font-weight: 500;
      }
      /* Sticky Notes & Area Rectangles Overlay */
      .ann-overlay-layer {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483645;
      }
      .sticky-pin {
        position: fixed;
        pointer-events: auto;
        background: #1e1b4b;
        border: 2px solid #8b5cf6;
        border-radius: 10px;
        padding: 8px 10px;
        width: 210px;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5);
        font-size: 12px;
        color: #f4f4f6;
        cursor: pointer;
      }
      .sticky-pin.collapsed {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
      }
      .area-rect-box {
        position: fixed;
        border: 2px dashed #facc15;
        background: rgba(250, 204, 21, 0.14);
        pointer-events: auto;
        cursor: pointer;
        border-radius: 4px;
      }
      .bookmark-flag {
        position: fixed;
        right: 12px;
        pointer-events: auto;
        background: #7c3aed;
        color: #fff;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        cursor: pointer;
      }
      @media print {
        :host(.hide-on-print) { display: none !important; }
      }
    `;
    shadowRoot.appendChild(style);

    // Screen reader live region
    ariaLiveEl = document.createElement('div');
    ariaLiveEl.setAttribute('aria-live', 'polite');
    ariaLiveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);';
    shadowRoot.appendChild(ariaLiveEl);

    // Overlay layer for Sticky Notes, Area Rects, and Bookmark flags
    overlayLayerEl = document.createElement('div');
    overlayLayerEl.className = 'ann-overlay-layer';
    shadowRoot.appendChild(overlayLayerEl);

    // Floating Selection Toolbar
    selectionToolbarEl = document.createElement('div');
    selectionToolbarEl.className = 'ann-toolbar';
    selectionToolbarEl.setAttribute('role', 'toolbar');
    selectionToolbarEl.setAttribute('aria-label', 'Obsidian Web Annotator Toolbar');

    const swatchesHtml = COLORS.map(
      (c) =>
        `<button class="swatch" data-color="${c.id}" title="Highlight ${c.label}" style="background:${c.hex};" aria-label="Highlight ${c.label}"></button>`
    ).join('');

    selectionToolbarEl.innerHTML = `
      ${swatchesHtml}
      <div class="tb-sep"></div>
      <button class="tb-btn" data-action="note" title="Add Note Tooltip">📝 Note</button>
      <button class="tb-btn" data-action="underline" title="Underline Selection"><u>U</u></button>
      <button class="tb-btn" data-action="strikethrough" title="Strikethrough"><s>S</s></button>
      <button class="tb-btn" data-action="copy-quote" title="Copy as Markdown Quote">❝ Copy</button>
      <button class="tb-btn" data-action="ask-ai" title="Ask AI about Selection">✨ Ask AI</button>
      <button class="tb-btn" data-action="clip-obsidian" title="Open in Obsidian Side Panel">💎 Clip</button>
    `;
    shadowRoot.appendChild(selectionToolbarEl);

    // Tooltip / Editor Popover
    popoverEl = document.createElement('div');
    popoverEl.className = 'ann-popover';
    popoverEl.setAttribute('role', 'dialog');
    popoverEl.setAttribute('aria-label', 'Annotation Inspector');
    shadowRoot.appendChild(popoverEl);

    document.documentElement.appendChild(shadowHost);
    bindShadowToolbarEvents();
  }

  function bindShadowToolbarEvents() {
    selectionToolbarEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    selectionToolbarEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const swatch = e.target.closest('.swatch');
      if (swatch) {
        const color = swatch.dataset.color;
        lastUsedColor = color;
        await createTextAnnotationFromCurrentSelection({ type: 'highlight', color });
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'note') {
        const created = await createTextAnnotationFromCurrentSelection({
          type: 'note',
          color: lastUsedColor
        });
        if (created) openAnnotationPopover(created.id, null, true);
      } else if (action === 'underline' || action === 'strikethrough') {
        await createTextAnnotationFromCurrentSelection({ type: action, color: lastUsedColor });
      } else if (action === 'copy-quote') {
        const text = currentSelectionRange ? currentSelectionRange.toString().trim() : '';
        if (text) {
          const mdQuote = `> ${text.split('\n').join('\n> ')}\n> — [${document.title}](${window.location.href})`;
          await navigator.clipboard?.writeText(mdQuote).catch(() => {});
          showToast('Copied selection as Markdown quote!');
        }
        hideSelectionToolbar();
      } else if (action === 'ask-ai') {
        const created = await createTextAnnotationFromCurrentSelection({
          type: 'note',
          color: 'purple',
          source: 'ai',
          comment: '*Asking AI...*'
        });
        if (created) {
          openAnnotationPopover(created.id, null, true);
          triggerAskAiForAnnotation(created.id, 'explain');
        }
      } else if (action === 'clip-obsidian') {
        hideSelectionToolbar();
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
      }
    });
  }

  function positionElementInViewport(el, anchorRect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 44;

    let left = anchorRect.left + anchorRect.width / 2 - width / 2;
    left = Math.max(12, Math.min(vw - width - 12, left));

    let top = anchorRect.top - height - 10;
    if (top < 12) {
      top = Math.min(vh - height - 12, anchorRect.bottom + 10);
    }

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function showSelectionToolbar(range) {
    initShadowDomUI();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    selectionToolbarEl.classList.add('visible');
    positionElementInViewport(selectionToolbarEl, rect);
  }

  function hideSelectionToolbar() {
    if (selectionToolbarEl) selectionToolbarEl.classList.remove('visible');
  }

  /**
   * -------------------------------------------------------------------------
   * 4. ANNOTATION CREATION, STORAGE & PER-SITE PERMISSION PROMPT
   * -------------------------------------------------------------------------
   */
  async function loadAnnotationsForCurrentPage() {
    currentUrl = normalizeUrl(window.location.href);
    return new Promise((resolve) => {
      chrome.storage.local.get(['obsidianAnnotationsByUrl'], (res) => {
        const map = res?.obsidianAnnotationsByUrl || {};
        const list = Array.isArray(map[currentUrl]) ? map[currentUrl] : [];
        annotations = list.filter((a) => a.status !== 'deleted');
        renderAllAnnotationsOnPage();
        chrome.runtime.sendMessage({ type: 'REFRESH_BADGE', url: currentUrl });
        resolve(annotations);
      });
    });
  }

  async function persistAnnotations(pushUndoSnapshot = null) {
    if (pushUndoSnapshot) {
      undoStack.push(pushUndoSnapshot);
      redoStack.length = 0;
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(['obsidianAnnotationsByUrl'], (res) => {
        const map = res?.obsidianAnnotationsByUrl || {};
        map[currentUrl] = annotations;
        chrome.storage.local.set({ obsidianAnnotationsByUrl: map }, () => {
          renderAllAnnotationsOnPage();
          chrome.runtime.sendMessage({ type: 'REFRESH_BADGE', url: currentUrl });
          resolve();
        });
      });
    });
  }

  async function createTextAnnotationFromCurrentSelection({
    type = 'highlight',
    color = lastUsedColor,
    comment = '',
    source = 'user'
  } = {}) {
    const sel = window.getSelection();
    const range =
      currentSelectionRange ||
      (sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null);

    if (!range) {
      showToast('Select text on the page first', true);
      return null;
    }

    const quote = normalizeTextNFC(range.toString()).trim();
    if (!quote) return null;

    const prevSnapshot = JSON.parse(JSON.stringify(annotations));
    const selectors = buildSelectorsFromRange(range);

    // Check if user is in "Re-attach orphaned annotation" mode
    if (reattachingAnnotationId) {
      const target = annotations.find((a) => a.id === reattachingAnnotationId);
      reattachingAnnotationId = null;
      if (target) {
        target.selectors = selectors;
        target.quote = quote;
        target.status = 'active';
        target.updatedAt = new Date().toISOString();
        await persistAnnotations(prevSnapshot);
        hideSelectionToolbar();
        sel?.removeAllRanges();
        showToast('Re-attached orphaned annotation!');
        return target;
      }
    }

    const id = uuid();
    const now = new Date().toISOString();
    const newAnn = {
      id,
      type,
      color,
      comment,
      tags: [],
      createdAt: now,
      updatedAt: now,
      pageUrl: currentUrl,
      pageTitle: document.title || currentUrl,
      selectors,
      quote,
      status: 'active',
      obsidianBlockId: `ann-${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)}`,
      source
    };

    annotations.push(newAnn);
    await persistAnnotations(prevSnapshot);
    hideSelectionToolbar();
    currentSelectionRange = null;
    sel?.removeAllRanges();
    announceAria(`Created ${type} annotation`);
    showToast(`Added ${type} (^${newAnn.obsidianBlockId})`);
    return newAnn;
  }

  /**
   * -------------------------------------------------------------------------
   * 5. NON-DESTRUCTIVE HIGHLIGHT RENDERING (CSS.highlights + <mark> wrappers)
   * -------------------------------------------------------------------------
   */
  function clearRenderedDomHighlights() {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      for (const c of COLORS) {
        CSS.highlights.delete(`obs-hl-${c.id}`);
      }
    }
    // Unwrap any fallback `<mark data-obsidian-ann-id>` elements cleanly back to original text nodes
    const marks = document.querySelectorAll('mark[data-obsidian-ann-id]');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function wrapRangeWithRestorableMark(range, ann) {
    try {
      const mark = document.createElement('mark');
      mark.setAttribute('data-obsidian-ann-id', ann.id);
      mark.setAttribute('data-obsidian-color', ann.color || 'yellow');
      mark.setAttribute('data-obsidian-type', ann.type || 'highlight');
      if (ann.comment) {
        mark.setAttribute('data-obsidian-has-note', 'true');
      }
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    } catch (_) {
      // Multi-block range fallback: rely on CSS.highlights + bounding-rect hit-testing
    }
  }

  function renderAllAnnotationsOnPage() {
    initShadowDomUI();
    clearRenderedDomHighlights();
    activeDomRanges.clear();
    overlayLayerEl.innerHTML = '';

    if (!annotationsVisible) return;

    const rangesByColor = new Map();
    COLORS.forEach((c) => rangesByColor.set(c.id, []));

    for (const ann of annotations) {
      if (ann.status === 'deleted') continue;

      if (['highlight', 'note', 'underline', 'strikethrough', 'squiggly'].includes(ann.type)) {
        const range = reanchorTextAnnotation(ann);
        if (range) {
          ann.status = 'active';
          activeDomRanges.set(ann.id, range.cloneRange());
          const colorKey = rangesByColor.has(ann.color) ? ann.color : 'yellow';
          rangesByColor.get(colorKey).push(range.cloneRange());
          wrapRangeWithRestorableMark(range, ann);
        } else {
          ann.status = 'orphaned';
        }
      } else if (ann.type === 'sticky') {
        renderStickyNotePin(ann);
      } else if (ann.type === 'area') {
        renderAreaRectAnnotation(ann);
      } else if (ann.type === 'bookmark') {
        renderBookmarkFlag(ann);
      }
    }

    // Register CSS Custom Highlight API ranges where supported
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      for (const [colorId, rangeList] of rangesByColor.entries()) {
        if (rangeList.length > 0) {
          try {
            CSS.highlights.set(`obs-hl-${colorId}`, new Highlight(...rangeList));
          } catch (_) {}
        }
      }
    }
  }

  function renderStickyNotePin(ann) {
    const pin = document.createElement('div');
    pin.className = `sticky-pin ${ann.collapsed ? 'collapsed' : ''}`;
    const anchorEl = resolveElementLocator(ann.selectors?.ElementSelector);
    let x = ann.rect?.x ?? 40;
    let y = ann.rect?.y ?? 120;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      x = Math.max(8, Math.min(window.innerWidth - 220, r.left + (ann.rect?.offsetX || 0)));
      y = Math.max(8, Math.min(window.innerHeight - 80, r.top + (ann.rect?.offsetY || 0)));
    }
    pin.style.left = `${Math.round(x)}px`;
    pin.style.top = `${Math.round(y)}px`;

    if (ann.collapsed) {
      pin.textContent = '📌';
      pin.title = ann.comment || 'Sticky Note (Click to expand)';
    } else {
      pin.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-weight:600;color:#c4b5fd;">
          <span>📌 Sticky Note</span>
          <span data-collapse-sticky="${escapeHtml(ann.id)}" style="cursor:pointer;padding:0 4px;">—</span>
        </div>
        <div>${sanitizeMarkdownToHtml(ann.comment || '*Click to edit note*')}</div>
      `;
    }

    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-collapse-sticky]')) {
        ann.collapsed = true;
        renderAllAnnotationsOnPage();
        return;
      }
      if (ann.collapsed) {
        ann.collapsed = false;
        renderAllAnnotationsOnPage();
      }
      openAnnotationPopover(ann.id, pin.getBoundingClientRect(), true);
    });

    overlayLayerEl.appendChild(pin);
  }

  function renderAreaRectAnnotation(ann) {
    if (!ann.rect) return;
    const box = document.createElement('div');
    box.className = 'area-rect-box';
    const anchorEl = resolveElementLocator(ann.selectors?.ElementSelector);
    let left = ann.rect.x || 100;
    let top = ann.rect.y || 100;
    let width = ann.rect.width || 140;
    let height = ann.rect.height || 90;

    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      left = r.left + (ann.rect.relX || 0) * r.width;
      top = r.top + (ann.rect.relY || 0) * r.height;
      width = (ann.rect.relW || 0.3) * r.width;
      height = (ann.rect.relH || 0.3) * r.height;
    }

    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    box.style.width = `${Math.round(width)}px`;
    box.style.height = `${Math.round(height)}px`;
    box.title = ann.comment || 'Area Annotation';

    box.addEventListener('click', (e) => {
      e.stopPropagation();
      openAnnotationPopover(ann.id, box.getBoundingClientRect(), true);
    });
    overlayLayerEl.appendChild(box);
  }

  function renderBookmarkFlag(ann) {
    const flag = document.createElement('div');
    flag.className = 'bookmark-flag';
    const docHeight = Math.max(document.documentElement.scrollHeight, 1);
    const ratio = (ann.rect?.scrollY || 0) / docHeight;
    const topPx = Math.max(60, Math.min(window.innerHeight - 60, ratio * window.innerHeight));
    flag.style.top = `${Math.round(topPx)}px`;
    flag.textContent = `🔖 ${ann.comment || 'Bookmark'}`;
    flag.addEventListener('click', (e) => {
      e.stopPropagation();
      window.scrollTo({ top: ann.rect?.scrollY || 0, behavior: 'smooth' });
      openAnnotationPopover(ann.id, flag.getBoundingClientRect(), true);
    });
    overlayLayerEl.appendChild(flag);
  }

  /**
   * -------------------------------------------------------------------------
   * 6. RICH HOVER / CLICK TOOLTIP & INLINE EDITOR POPOVER
   * -------------------------------------------------------------------------
   */
  function openAnnotationPopover(annId, customRect = null, editMode = false) {
    initShadowDomUI();
    const ann = annotations.find((a) => a.id === annId);
    if (!ann) return;

    activePopoverAnnId = annId;
    popoverPinned = editMode;

    const range = activeDomRanges.get(annId);
    const rect =
      customRect ||
      (range ? range.getBoundingClientRect() : { left: window.innerWidth / 2 - 160, top: 100, bottom: 130, width: 100, height: 24 });

    const swatchesHtml = COLORS.map(
      (c) =>
        `<button class="swatch ${ann.color === c.id ? 'active' : ''}" data-pop-color="${c.id}" style="background:${c.hex};" title="${c.label}"></button>`
    ).join('');

    const tagsHtml = (ann.tags || [])
      .map(
        (t) =>
          `<span class="pop-tag-chip">#${escapeHtml(t)} <b data-pop-rm-tag="${escapeHtml(t)}" style="cursor:pointer;">&times;</b></span>`
      )
      .join('');

    popoverEl.innerHTML = `
      <div class="pop-header">
        <div class="pop-swatches">${swatchesHtml}</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:10.5px;color:#a1a1b5;font-family:monospace;">^${escapeHtml(ann.obsidianBlockId)}</span>
          <button class="tb-btn" data-pop-action="pin" title="Pin Popover">${popoverPinned ? '📌' : '📍'}</button>
          <button class="tb-btn" data-pop-action="delete" title="Delete Annotation" style="color:#fca5a5;">🗑</button>
          <button class="tb-btn" data-pop-action="close" title="Close">✕</button>
        </div>
      </div>

      ${
        ann.comment && !editMode
          ? `<div class="pop-rendered" data-pop-action="edit-comment" title="Click to edit Markdown comment">${sanitizeMarkdownToHtml(ann.comment)}</div>`
          : `<textarea class="pop-textarea" id="popCommentInput" placeholder="Write Markdown note, thoughts, or [[Wikilink]]...">${escapeHtml(ann.comment)}</textarea>`
      }

      <div class="pop-tags">
        ${tagsHtml}
        <input type="text" class="pop-tag-input" id="popTagInput" placeholder="+ tag & Enter" />
      </div>

      <div class="pop-ai-row">
        <button class="tb-btn" data-pop-ai="explain">✨ Explain</button>
        <button class="tb-btn" data-pop-ai="simplify">✨ Simplify</button>
        <button class="tb-btn" data-pop-ai="translate">🌐 Translate</button>
        <button class="tb-btn" data-pop-action="related">🔗 Vault Links</button>
        <button class="tb-btn" data-pop-action="save" style="margin-left:auto;background:#7c3aed;color:#fff;">Save</button>
      </div>
      <div class="pop-related-list" id="popRelatedNotes"></div>
    `;

    popoverEl.classList.add('visible');
    positionElementInViewport(popoverEl, rect);

    bindPopoverEvents(ann);
  }

  function bindPopoverEvents(ann) {
    popoverEl.onmousedown = (e) => e.stopPropagation();
    popoverEl.onclick = async (e) => {
      e.stopPropagation();

      const colorBtn = e.target.closest('[data-pop-color]');
      if (colorBtn) {
        const prev = JSON.parse(JSON.stringify(annotations));
        ann.color = colorBtn.dataset.popColor;
        lastUsedColor = ann.color;
        ann.updatedAt = new Date().toISOString();
        await persistAnnotations(prev);
        openAnnotationPopover(ann.id, null, true);
        return;
      }

      const rmTag = e.target.closest('[data-pop-rm-tag]');
      if (rmTag) {
        const prev = JSON.parse(JSON.stringify(annotations));
        ann.tags = (ann.tags || []).filter((t) => t !== rmTag.dataset.popRmTag);
        ann.updatedAt = new Date().toISOString();
        await persistAnnotations(prev);
        openAnnotationPopover(ann.id, null, true);
        return;
      }

      const aiBtn = e.target.closest('[data-pop-ai]');
      if (aiBtn) {
        await triggerAskAiForAnnotation(ann.id, aiBtn.dataset.popAi);
        return;
      }

      const actBtn = e.target.closest('[data-pop-action]');
      if (!actBtn) return;
      const act = actBtn.dataset.popAction;

      if (act === 'close') {
        closeAnnotationPopover();
      } else if (act === 'pin') {
        popoverPinned = !popoverPinned;
        openAnnotationPopover(ann.id, null, true);
      } else if (act === 'edit-comment') {
        openAnnotationPopover(ann.id, null, true);
      } else if (act === 'save') {
        const ta = shadowRoot.getElementById('popCommentInput');
        const prev = JSON.parse(JSON.stringify(annotations));
        if (ta) ann.comment = ta.value.trim();
        ann.updatedAt = new Date().toISOString();
        await persistAnnotations(prev);
        showToast('Saved annotation note');
        openAnnotationPopover(ann.id, null, false);
      } else if (act === 'delete') {
        const prev = JSON.parse(JSON.stringify(annotations));
        ann.status = 'deleted';
        ann.updatedAt = new Date().toISOString();
        await persistAnnotations(prev);
        closeAnnotationPopover();
        showToast('Deleted annotation (Press Alt+Z to Undo)');
      } else if (act === 'related') {
        const container = shadowRoot.getElementById('popRelatedNotes');
        if (container) container.textContent = 'Searching Obsidian vault...';
        chrome.runtime.sendMessage(
          { type: 'ANNOTATOR_FIND_RELATED_NOTES', query: ann.quote || ann.comment || document.title },
          (res) => {
            if (!container) return;
            if (!res?.ok || !res.notes?.length) {
              container.textContent = 'No matching vault notes found.';
              return;
            }
            container.innerHTML = res.notes
              .map(
                (n) =>
                  `<div style="display:flex;justify-content:space-between;align-items:center;background:#111115;padding:3px 6px;border-radius:4px;">
                    <span>📄 ${escapeHtml(n.wikilink)}</span>
                    <button class="tb-btn" data-insert-wiki="${escapeHtml(n.wikilink)}" style="padding:1px 6px;font-size:10px;">+ [[Link]]</button>
                  </div>`
              )
              .join('');
          }
        );
      }
    };

    popoverEl.addEventListener('click', async (e) => {
      const wikiBtn = e.target.closest('[data-insert-wiki]');
      if (wikiBtn) {
        const link = `[[${wikiBtn.dataset.insertWiki}]]`;
        const ta = shadowRoot.getElementById('popCommentInput');
        if (ta) {
          ta.value = `${ta.value} ${link}`.trim();
          ann.comment = ta.value;
        } else {
          ann.comment = `${ann.comment || ''} ${link}`.trim();
        }
        await persistAnnotations();
        openAnnotationPopover(ann.id, null, true);
      }
    });

    const tagInp = shadowRoot.getElementById('popTagInput');
    if (tagInp) {
      tagInp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const clean = tagInp.value.toLowerCase().replace(/[^a-z0-9/_-]/g, '').trim();
          if (clean && !ann.tags.includes(clean)) {
            const prev = JSON.parse(JSON.stringify(annotations));
            const ta = shadowRoot.getElementById('popCommentInput');
            if (ta) ann.comment = ta.value.trim();
            ann.tags.push(clean);
            ann.updatedAt = new Date().toISOString();
            await persistAnnotations(prev);
            openAnnotationPopover(ann.id, null, true);
          }
        }
      });
    }
  }

  function closeAnnotationPopover() {
    activePopoverAnnId = null;
    popoverPinned = false;
    if (popoverEl) popoverEl.classList.remove('visible');
  }

  async function triggerAskAiForAnnotation(annId, task = 'explain') {
    const ann = annotations.find((a) => a.id === annId);
    if (!ann) return;
    showToast(`Asking AI (${task})...`);

    chrome.runtime.sendMessage(
      {
        type: 'ANNOTATOR_ASK_AI',
        quote: ann.quote || ann.comment,
        task,
        pageUrl: currentUrl,
        pageTitle: document.title
      },
      async (res) => {
        if (res?.ok && res.answer) {
          ann.comment = res.answer;
          ann.source = 'ai';
          if (Array.isArray(res.tags)) {
            for (const t of res.tags) {
              if (!ann.tags.includes(t)) ann.tags.push(t);
            }
          }
          ann.updatedAt = new Date().toISOString();
          await persistAnnotations();
          openAnnotationPopover(ann.id, null, false);
          showToast('AI insight added to annotation!');
        } else {
          showToast(`AI Error: ${res?.error || 'Check LLM settings'}`, true);
        }
      }
    );
  }

  /**
   * -------------------------------------------------------------------------
   * 7. STICKY NOTE, AREA/IMAGE RECTANGLE & PAGE NOTE MODES
   * -------------------------------------------------------------------------
   */
  function startAreaAnnotationMode() {
    if (areaSelectionMode) return;
    areaSelectionMode = true;
    showToast('Click and drag on any image or region to create an Area Annotation (Esc to cancel)');

    let startX = 0, startY = 0;
    let dragBox = null;
    let targetElement = null;

    const onMouseDown = (e) => {
      if (!areaSelectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      targetElement = e.target;

      dragBox = document.createElement('div');
      dragBox.className = 'area-rect-box';
      dragBox.style.left = `${startX}px`;
      dragBox.style.top = `${startY}px`;
      dragBox.style.width = '0px';
      dragBox.style.height = '0px';
      overlayLayerEl.appendChild(dragBox);
    };

    const onMouseMove = (e) => {
      if (!dragBox) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      dragBox.style.left = `${x}px`;
      dragBox.style.top = `${y}px`;
      dragBox.style.width = `${w}px`;
      dragBox.style.height = `${h}px`;
    };

    const onMouseUp = async (e) => {
      if (!dragBox) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.max(40, Math.abs(e.clientX - startX));
      const h = Math.max(30, Math.abs(e.clientY - startY));
      dragBox.remove();
      cleanup();

      const anchorRect = targetElement?.getBoundingClientRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const id = uuid();
      const now = new Date().toISOString();
      const newAnn = {
        id,
        type: 'area',
        color: 'yellow',
        comment: '',
        tags: ['visual'],
        createdAt: now,
        updatedAt: now,
        pageUrl: currentUrl,
        pageTitle: document.title,
        selectors: { ElementSelector: buildElementLocator(targetElement) },
        quote: targetElement?.alt || targetElement?.title || 'Visual Region Annotation',
        status: 'active',
        obsidianBlockId: `ann-${id.slice(0, 6)}`,
        source: 'user',
        rect: {
          x,
          y,
          width: w,
          height: h,
          relX: (x - anchorRect.left) / Math.max(anchorRect.width, 1),
          relY: (y - anchorRect.top) / Math.max(anchorRect.height, 1),
          relW: w / Math.max(anchorRect.width, 1),
          relH: h / Math.max(anchorRect.height, 1)
        }
      };

      const prev = JSON.parse(JSON.stringify(annotations));
      annotations.push(newAnn);
      await persistAnnotations(prev);
      openAnnotationPopover(newAnn.id, { left: x, top: y, bottom: y + h, width: w, height: h }, true);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (dragBox) dragBox.remove();
        cleanup();
      }
    };

    function cleanup() {
      areaSelectionMode = false;
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
    }

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function startStickyPlacementMode() {
    if (stickyPlacementMode) return;
    stickyPlacementMode = true;
    showToast('Click anywhere on the page to pin a Sticky Note (Esc to cancel)');

    const onClick = async (e) => {
      if (!stickyPlacementMode) return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();

      const targetEl = e.target;
      const r = targetEl?.getBoundingClientRect?.() || { left: e.clientX, top: e.clientY };
      const id = uuid();
      const now = new Date().toISOString();
      const newAnn = {
        id,
        type: 'sticky',
        color: 'purple',
        comment: '',
        tags: ['sticky'],
        createdAt: now,
        updatedAt: now,
        pageUrl: currentUrl,
        pageTitle: document.title,
        selectors: { ElementSelector: buildElementLocator(targetEl) },
        quote: '',
        status: 'active',
        obsidianBlockId: `ann-${id.slice(0, 6)}`,
        source: 'user',
        rect: {
          x: e.clientX,
          y: e.clientY,
          offsetX: e.clientX - r.left,
          offsetY: e.clientY - r.top
        }
      };

      const prev = JSON.parse(JSON.stringify(annotations));
      annotations.push(newAnn);
      await persistAnnotations(prev);
      openAnnotationPopover(newAnn.id, { left: e.clientX, top: e.clientY, bottom: e.clientY + 30, width: 180, height: 30 }, true);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    function cleanup() {
      stickyPlacementMode = false;
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
    }

    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  }

  async function createPageNoteOrBookmark(type = 'page_note', comment = '') {
    const id = uuid();
    const now = new Date().toISOString();
    const newAnn = {
      id,
      type,
      color: type === 'bookmark' ? 'blue' : 'purple',
      comment: comment || (type === 'bookmark' ? 'Reading bookmark' : ''),
      tags: [type === 'bookmark' ? 'bookmark' : 'page-note'],
      createdAt: now,
      updatedAt: now,
      pageUrl: currentUrl,
      pageTitle: document.title,
      selectors: {},
      quote: '',
      status: 'active',
      obsidianBlockId: `ann-${id.slice(0, 6)}`,
      source: 'user',
      rect: { scrollY: window.scrollY }
    };

    const prev = JSON.parse(JSON.stringify(annotations));
    annotations.push(newAnn);
    await persistAnnotations(prev);
    openAnnotationPopover(newAnn.id, null, true);
    return newAnn;
  }

  /**
   * -------------------------------------------------------------------------
   * 8. PAGE EXTRACTION & TOAST HELPERS (Preserved from Original Web Clipper)
   * -------------------------------------------------------------------------
   */
  function extractMetadata() {
    const getMeta = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const val = el?.getAttribute('content') || el?.textContent;
        if (val && val.trim()) return val.trim();
      }
      return '';
    };
    return {
      title: getMeta(['meta[property="og:title"]', 'meta[name="twitter:title"]']) || document.title || 'Untitled Web Page',
      url: currentUrl,
      author: getMeta(['meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]', '.author-name']),
      description: getMeta(['meta[property="og:description"]', 'meta[name="description"]']),
      publishedTime: getMeta(['meta[property="article:published_time"]', 'time[datetime]']),
      siteName: getMeta(['meta[property="og:site_name"]']) || window.location.hostname
    };
  }

  function findMainArticleElement() {
    const prioritySelectors = ['article', '[role="main"] article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content', '.markdown-body', '#content'];
    for (const sel of prioritySelectors) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 250) return el;
    }
    return document.body;
  }

  function collectPageImages() {
    const imgs = Array.from(document.querySelectorAll('img'));
    const seen = new Set();
    const list = [];
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:image/svg') || seen.has(src)) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && w < 48 && h > 0 && h < 48) continue;
      seen.add(src);
      list.push({ src, alt: (img.alt || img.title || 'Captured Image').trim(), width: w, height: h });
    }
    return list.slice(0, 40);
  }

  function extractPagePayload(mode = 'auto') {
    const metadata = extractMetadata();
    const sel = window.getSelection();
    let selHtml = '', selText = '';
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const div = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
      selHtml = div.innerHTML;
      selText = sel.toString().trim();
    }
    const mainEl = findMainArticleElement();
    const images = collectPageImages();
    let targetHtml = mainEl.innerHTML;
    if (mode === 'selection' && selHtml) targetHtml = selHtml;
    else if (mode === 'full') targetHtml = document.body.innerHTML;
    else if (mode === 'auto' && selHtml && selText.length > 40) targetHtml = selHtml;

    const headingWords = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => h.innerText.trim())
      .join(' ')
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 6);

    return {
      metadata,
      html: targetHtml,
      selectionHtml: selHtml,
      selectionText: selText,
      plainText: (mainEl.innerText || document.body.innerText || '').trim().slice(0, 25000),
      images,
      keywords: headingWords,
      annotations
    };
  }

  function showToast(message, isError = false) {
    let existing = document.getElementById('obsidian-companion-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'obsidian-companion-toast';
    toast.className = `obsidian-companion-toast ${isError ? 'error' : 'success'}`;
    toast.innerHTML = `<span class="obs-toast-dot"></span><span class="obs-toast-text">${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 350);
    }, 3400);
  }

  function enableImagePicker() {
    if (imagePickerActive) return;
    imagePickerActive = true;
    showToast('Click any image on the page to capture it directly to Obsidian Vault (Press Esc to cancel)');
    const onMouseOver = (e) => {
      const img = e.target.closest('img');
      if (hoveredImg && hoveredImg !== img) hoveredImg.classList.remove('obsidian-image-picker-highlight');
      if (img) {
        hoveredImg = img;
        img.classList.add('obsidian-image-picker-highlight');
      }
    };
    const onClick = (e) => {
      const img = e.target.closest('img');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      const src = img.currentSrc || img.src;
      cleanup();
      chrome.runtime.sendMessage({ type: 'CAPTURE_IMAGE_TO_VAULT', imageUrl: src, pageTitle: document.title, pageUrl: currentUrl }, (res) => {
        if (res?.ok) {
          navigator.clipboard?.writeText(res.markdownEmbed).catch(() => {});
          showToast(`Saved ${res.vaultPath}! Copied ${res.markdownEmbed}`);
        } else {
          showToast(`Failed: ${res?.error}`, true);
        }
      });
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') cleanup(); };
    function cleanup() {
      imagePickerActive = false;
      if (hoveredImg) hoveredImg.classList.remove('obsidian-image-picker-highlight');
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  /**
   * -------------------------------------------------------------------------
   * 9. EVENT LISTENERS, HOVER DETECTION, UNDO/REDO & SPA / MUTATION OBSERVERS
   * -------------------------------------------------------------------------
   */
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#obsidian-web-annotator-host')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim().length >= 2) {
        currentSelectionRange = sel.getRangeAt(0).cloneRange();
        showSelectionToolbar(currentSelectionRange);
      } else {
        hideSelectionToolbar();
      }
    }, 20);
  });

  // Hover & click detection on `<mark data-obsidian-ann-id>` elements
  document.addEventListener('mouseover', (e) => {
    const mark = e.target.closest?.('mark[data-obsidian-ann-id]');
    if (!mark) return;
    const annId = mark.getAttribute('data-obsidian-ann-id');
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!popoverPinned) {
        openAnnotationPopover(annId, mark.getBoundingClientRect(), false);
      }
    }, 280);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest?.('#obsidian-web-annotator-host')) return;
    const mark = e.target.closest?.('mark[data-obsidian-ann-id]');
    if (mark) {
      e.stopPropagation();
      const annId = mark.getAttribute('data-obsidian-ann-id');
      openAnnotationPopover(annId, mark.getBoundingClientRect(), true);
      return;
    }
    if (!popoverPinned) {
      closeAnnotationPopover();
    }
  });

  // Keyboard navigation & Undo/Redo shortcuts
  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      hideSelectionToolbar();
      closeAnnotationPopover();
      reattachingAnnotationId = null;
    }
    // Alt+Z: Undo annotation action
    if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && undoStack.length > 0) {
      e.preventDefault();
      redoStack.push(JSON.parse(JSON.stringify(annotations)));
      annotations = undoStack.pop();
      await persistAnnotations();
      showToast('Undid last annotation action');
    }
    // Alt+Shift+Z: Redo annotation action
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'z' && redoStack.length > 0) {
      e.preventDefault();
      undoStack.push(JSON.parse(JSON.stringify(annotations)));
      annotations = redoStack.pop();
      await persistAnnotations();
      showToast('Redid annotation action');
    }
    // Alt+N / Alt+P: Next / Previous annotation on page
    if (e.altKey && (e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'p')) {
      const activeList = annotations.filter((a) => a.status === 'active');
      if (activeList.length === 0) return;
      e.preventDefault();
      focusedAnnIndex =
        e.key.toLowerCase() === 'n'
          ? (focusedAnnIndex + 1) % activeList.length
          : (focusedAnnIndex - 1 + activeList.length) % activeList.length;
      scrollToAndFlashAnnotation(activeList[focusedAnnIndex].id);
    }
  });

  function scrollToAndFlashAnnotation(annId) {
    const mark = document.querySelector(`mark[data-obsidian-ann-id="${annId}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      mark.classList.add('obsidian-ann-flash');
      setTimeout(() => mark.classList.remove('obsidian-ann-flash'), 1600);
      return;
    }
    const ann = annotations.find((a) => a.id === annId);
    if (ann?.rect?.scrollY !== undefined) {
      window.scrollTo({ top: ann.rect.scrollY, behavior: 'smooth' });
    }
  }

  // Listen to storage changes so edits from Side Panel or Obsidian Sync immediately update in-page DOM!
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.obsidianAnnotationsByUrl) {
      const map = changes.obsidianAnnotationsByUrl.newValue || {};
      const updatedList = Array.isArray(map[currentUrl]) ? map[currentUrl] : [];
      annotations = updatedList.filter((a) => a.status !== 'deleted');
      renderAllAnnotationsOnPage();
    }
  });

  // Update Sticky/Area positions on scroll & resize
  window.addEventListener(
    'scroll',
    () => {
      if (annotations.some((a) => a.type === 'sticky' || a.type === 'area')) {
        renderAllAnnotationsOnPage();
      }
    },
    { passive: true }
  );

  // SPA Route Change Detection (`popstate`, `hashchange`, and periodic URL check)
  setInterval(() => {
    const newNorm = normalizeUrl(window.location.href);
    if (newNorm !== currentUrl) {
      currentUrl = newNorm;
      loadAnnotationsForCurrentPage();
    }
  }, 1200);

  // Bounded Debounced MutationObserver to re-anchor orphaned annotations on lazy-loaded DOM
  let mutationDebounce = null;
  let reanchorAttempts = 0;
  const observer = new MutationObserver(() => {
    if (reanchorAttempts > 15) return;
    if (!annotations.some((a) => a.status === 'orphaned')) return;
    clearTimeout(mutationDebounce);
    mutationDebounce = setTimeout(() => {
      reanchorAttempts++;
      const idleFn = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
      idleFn(() => renderAllAnnotationsOnPage());
    }, 600);
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Message Handler for Side Panel & Background Worker commands
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING_ANNOTATOR') {
      sendResponse({ ok: true, count: annotations.length });
      return false;
    }

    if (msg?.type === 'EXTRACT_PAGE') {
      try {
        const data = extractPagePayload(msg.mode || 'auto');
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg?.type === 'ANNOTATOR_CREATE_FROM_SELECTION') {
      createTextAnnotationFromCurrentSelection({
        type: msg.mode || 'highlight',
        color: msg.color || lastUsedColor
      }).then((ann) => sendResponse({ ok: Boolean(ann), annotation: ann }));
      return true;
    }

    if (msg?.type === 'ANNOTATOR_ADD_PAGE_NOTE') {
      createPageNoteOrBookmark('page_note', msg.comment || '').then((ann) =>
        sendResponse({ ok: true, annotation: ann })
      );
      return true;
    }

    if (msg?.type === 'ANNOTATOR_ADD_BOOKMARK') {
      createPageNoteOrBookmark('bookmark', msg.label || 'Bookmark').then((ann) =>
        sendResponse({ ok: true, annotation: ann })
      );
      return true;
    }

    if (msg?.type === 'ANNOTATOR_START_STICKY_MODE') {
      startStickyPlacementMode();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'ANNOTATOR_START_AREA_MODE') {
      startAreaAnnotationMode();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'ANNOTATOR_SCROLL_TO') {
      scrollToAndFlashAnnotation(msg.annotationId);
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'ANNOTATOR_START_REATTACH') {
      reattachingAnnotationId = msg.annotationId;
      showToast('Select new text on the page and click any highlight swatch to re-attach this annotation');
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'ANNOTATOR_TOGGLE_VISIBILITY') {
      annotationsVisible = !annotationsVisible;
      renderAllAnnotationsOnPage();
      showToast(annotationsVisible ? 'Annotations visible' : 'Annotations hidden');
      sendResponse({ ok: true, visible: annotationsVisible });
      return false;
    }

    if (msg?.type === 'START_IMAGE_PICKER') {
      enableImagePicker();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'OBSIDIAN_TOAST') {
      if (msg.embedCode) navigator.clipboard?.writeText(msg.embedCode).catch(() => {});
      showToast(msg.message, Boolean(msg.isError));
      sendResponse({ ok: true });
      return false;
    }
  });

  // Initial load of saved annotations on page boot
  loadAnnotationsForCurrentPage();
})();
