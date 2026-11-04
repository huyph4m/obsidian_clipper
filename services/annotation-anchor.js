/**
 * Phase 4a: W3C Web Annotation Anchoring, Re-Anchoring & URL Normalization Engine
 * (`services/annotation-anchor.js`)
 *
 * Implements:
 * 1. URL Normalization: strips tracking params (utm_*, fbclid, gclid, msclkid, ref, etc.),
 *    optional canonical link resolution, hash-route preservation for SPAs, and URL alias mapping.
 * 2. Unicode NFC & Whitespace Normalization: handles Vietnamese diacritics, RTL, CJK,
 *    and multi-node text spans cleanly while ignoring extension-injected nodes.
 * 3. W3C Multi-Selector Generation:
 *    - TextQuoteSelector: { exact, prefix (~32 chars), suffix (~32 chars) }
 *    - TextPositionSelector: { start, end } within normalized root text
 *    - RangeSelector: { startContainerPath, startOffset, endContainerPath, endOffset } (XPath + CSS path)
 *    - ElementSelector: for Sticky Notes, Image/Area Rects, and Bookmark Markers
 * 4. 4-Stage Re-Anchoring Algorithm:
 *    - Stage 1: Fast path via RangeSelector (XPath/CSS) verified against NFC-normalized `exact`
 *    - Stage 2: Exact TextQuoteSelector match disambiguated by `prefix` + `suffix` score
 *    - Stage 3: Fuzzy Bitap / Levenshtein-Window search near `TextPositionSelector.start`
 *      with configurable similarity threshold (default 0.78)
 *    - Stage 4: Mark `orphaned` so user data is preserved and can be re-attached in 1 click
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  'rb_clickid',
  's_kwcid'
]);

/**
 * Normalize a string to Unicode NFC and collapse runs of whitespace
 */
export function normalizeTextNFC(str = '') {
  return String(str || '')
    .normalize('NFC')
    .replace(/\u00AD/g, '') // soft hyphen
    .replace(/[\r\n\t\u00A0]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Normalize a page URL for consistent indexing & Obsidian note mapping
 */
export function normalizePageUrl(rawUrl = '', options = {}) {
  const {
    stripTracking = true,
    keepHashForSpa = true,
    stripTrailingSlash = true,
    canonicalUrl = ''
  } = options;

  const target = canonicalUrl && options.useCanonical ? canonicalUrl : rawUrl;
  if (!target) return '';

  try {
    const u = new URL(target);
    if (stripTracking) {
      for (const key of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
          u.searchParams.delete(key);
        }
      }
    }
    // Sort remaining query parameters deterministically
    u.searchParams.sort();

    // Keep SPA hash routes (e.g. #/module/335 or #!/app), strip plain in-page #heading anchors
    if (!keepHashForSpa || (u.hash && !u.hash.startsWith('#/') && !u.hash.startsWith('#!'))) {
      u.hash = '';
    }

    let normalized = u.toString();
    if (stripTrailingSlash && normalized.endsWith('/') && u.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (_) {
    return String(rawUrl || '').split('#')[0].trim();
  }
}

/**
 * Generate a RFC4122 v4 UUID
 */
export function generateAnnotationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate short 6-char Obsidian block ID (`ann-xxxxxx`) from annotation UUID
 */
export function toObsidianBlockId(uuid = '') {
  const clean = String(uuid).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `ann-${clean.slice(0, 6) || Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute XPath for a DOM node (ignoring extension-injected wrapper tags)
 */
export function getNodeXPath(node, root = document.body) {
  if (!node || node === root) return '.';
  const parts = [];
  let curr = node;

  while (curr && curr !== root && curr !== document.documentElement) {
    if (curr.nodeType === Node.TEXT_NODE) {
      let textIndex = 1;
      let sib = curr.previousSibling;
      while (sib) {
        if (sib.nodeType === Node.TEXT_NODE) textIndex++;
        sib = sib.previousSibling;
      }
      parts.unshift(`text()[${textIndex}]`);
    } else if (curr.nodeType === Node.ELEMENT_NODE) {
      // Unwrap our own <mark data-ann-id> if computing XPath while highlights are rendered
      if (curr.hasAttribute && curr.hasAttribute('data-obsidian-ann-id')) {
        curr = curr.parentNode;
        continue;
      }
      const tag = curr.tagName.toLowerCase();
      let index = 1;
      let sib = curr.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag && !sib.hasAttribute('data-obsidian-ann-id')) {
          index++;
        }
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}[${index}]`);
    }
    curr = curr.parentNode;
  }
  return './' + parts.join('/');
}

/**
 * Resolve XPath relative to root
 */
export function resolveNodeXPath(xpath, root = document.body) {
  if (!xpath || typeof document === 'undefined') return null;
  try {
    const res = document.evaluate(
      xpath,
      root,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return res.singleNodeValue;
  } catch (_) {
    return null;
  }
}

/**
 * Compute a resilient Element Locator for Sticky Notes, Image/Area annotations, & Bookmarks
 */
export function buildElementLocator(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = el.tagName.toLowerCase();
  const id = el.id || '';
  const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
  const xpath = getNodeXPath(el);

  // Build concise CSS selector path
  const cssParts = [];
  let curr = el;
  while (curr && curr !== document.body && cssParts.length < 5) {
    let seg = curr.tagName.toLowerCase();
    if (curr.id && /^[a-zA-Z][\w-]*$/.test(curr.id)) {
      seg += `#${curr.id}`;
      cssParts.unshift(seg);
      break;
    }
    const parent = curr.parentElement;
    if (parent) {
      const sameTagSibs = Array.from(parent.children).filter((c) => c.tagName === curr.tagName);
      if (sameTagSibs.length > 1) {
        const nth = sameTagSibs.indexOf(curr) + 1;
        seg += `:nth-of-type(${nth})`;
      }
    }
    cssParts.unshift(seg);
    curr = parent;
  }

  return {
    tag,
    id,
    src,
    xpath,
    cssSelector: cssParts.join(' > '),
    textFingerprint: normalizeTextNFC(el.innerText || el.textContent || '').slice(0, 64)
  };
}

/**
 * Resolve an Element Locator back to a live DOM element
 */
export function resolveElementLocator(locator, root = document.body) {
  if (!locator || typeof document === 'undefined') return null;
  if (locator.id) {
    const byId = document.getElementById(locator.id);
    if (byId) return byId;
  }
  if (locator.src) {
    const imgs = Array.from(root.querySelectorAll(locator.tag || 'img'));
    const matchImg = imgs.find(
      (img) => img.src === locator.src || img.getAttribute('src') === locator.src
    );
    if (matchImg) return matchImg;
  }
  if (locator.cssSelector) {
    try {
      const byCss = root.querySelector(locator.cssSelector);
      if (byCss) return byCss;
    } catch (_) {}
  }
  if (locator.xpath) {
    const byXPath = resolveNodeXPath(locator.xpath, root);
    if (byXPath && byXPath.nodeType === Node.ELEMENT_NODE) return byXPath;
  }
  return null;
}

/**
 * Collect an ordered flat index of all text nodes inside `root`, skipping extension UI hosts & script/style tags.
 * Returns { fullText, segments: [{ node, start, end, rawLength }] }
 */
export function buildTextNodeIndex(root = document.body) {
  const segments = [];
  let fullText = '';

  if (!root || typeof document === 'undefined') {
    return { fullText: '', segments: [] };
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (
        parent.closest('#obsidian-web-annotator-host') ||
        parent.closest('#obsidian-companion-toast')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current;
  while ((current = walker.nextNode())) {
    const text = current.nodeValue.normalize('NFC');
    const start = fullText.length;
    fullText += text;
    segments.push({
      node: current,
      start,
      end: fullText.length
    });
  }

  return { fullText, segments };
}

/**
 * Build W3C Selectors (`TextQuoteSelector`, `TextPositionSelector`, `RangeSelector`) from a DOM Range
 */
export function buildSelectorsFromRange(range, root = document.body) {
  const { fullText, segments } = buildTextNodeIndex(root);
  const rawQuote = range.toString();
  const exact = rawQuote.normalize('NFC');

  // Compute global character start/end offsets in `fullText`
  let globalStart = -1;
  let globalEnd = -1;

  for (const seg of segments) {
    if (seg.node === range.startContainer) {
      globalStart = seg.start + range.startOffset;
    }
    if (seg.node === range.endContainer) {
      globalEnd = seg.start + range.endOffset;
      break;
    }
  }

  if (globalStart === -1) {
    globalStart = fullText.indexOf(exact);
    globalEnd = globalStart !== -1 ? globalStart + exact.length : -1;
  }

  const prefixStart = Math.max(0, globalStart - 32);
  const suffixEnd = Math.min(fullText.length, (globalEnd !== -1 ? globalEnd : globalStart + exact.length) + 32);

  const prefix = globalStart >= 0 ? fullText.slice(prefixStart, globalStart) : '';
  const suffix = globalEnd >= 0 ? fullText.slice(globalEnd, suffixEnd) : '';

  return {
    TextQuoteSelector: {
      type: 'TextQuoteSelector',
      exact,
      prefix,
      suffix
    },
    TextPositionSelector: {
      type: 'TextPositionSelector',
      start: Math.max(0, globalStart),
      end: Math.max(0, globalEnd !== -1 ? globalEnd : globalStart + exact.length)
    },
    RangeSelector: {
      type: 'RangeSelector',
      startContainerXPath: getNodeXPath(range.startContainer, root),
      startOffset: range.startOffset,
      endContainerXPath: getNodeXPath(range.endContainer, root),
      endOffset: range.endOffset
    }
  };
}

/**
 * Convert character offsets [charStart, charEnd] in `fullText` back into a live DOM Range
 */
export function charOffsetsToDomRange(charStart, charEnd, segments) {
  if (charStart < 0 || charEnd <= charStart || !segments || segments.length === 0) {
    return null;
  }

  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;

  for (const seg of segments) {
    if (!startNode && charStart >= seg.start && charStart <= seg.end) {
      startNode = seg.node;
      startOffset = Math.min(charStart - seg.start, seg.node.nodeValue.length);
    }
    if (charEnd >= seg.start && charEnd <= seg.end) {
      endNode = seg.node;
      endOffset = Math.min(charEnd - seg.start, seg.node.nodeValue.length);
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch (_) {
    return null;
  }
}

/**
 * Compute normalized similarity ratio [0.0 .. 1.0] between two strings using Levenshtein distance
 */
export function computeStringSimilarity(a = '', b = '') {
  const s1 = normalizeTextNFC(a).trim();
  const s2 = normalizeTextNFC(b).trim();
  if (s1 === s2) return 1.0;
  if (!s1.length || !s2.length) return 0.0;

  // Cap length for fast DP calculation
  const maxLen = 280;
  const x = s1.slice(0, maxLen);
  const y = s2.slice(0, maxLen);
  const m = x.length;
  const n = y.length;

  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n];
  return Math.max(0, 1 - distance / Math.max(m, n));
}

/**
 * Find the best character span `{ start, end, score, method }` in `fullText`
 * using the 4-stage W3C re-anchoring cascade (pure text function, unit-testable in Node & DOM).
 */
export function findTextSpanInFullText(fullText, selectors = {}, similarityThreshold = 0.78) {
  const quoteSel = selectors?.TextQuoteSelector || {};
  const posSel = selectors?.TextPositionSelector || {};
  const exact = (quoteSel.exact || '').normalize('NFC');
  if (!exact || !fullText) return null;

  const prefix = (quoteSel.prefix || '').normalize('NFC');
  const suffix = (quoteSel.suffix || '').normalize('NFC');
  const hintStart = typeof posSel.start === 'number' ? posSel.start : 0;

  // 1. Check exact position match first
  if (
    typeof posSel.start === 'number' &&
    typeof posSel.end === 'number' &&
    fullText.slice(posSel.start, posSel.end) === exact
  ) {
    return { start: posSel.start, end: posSel.end, score: 1.0, method: 'position-exact' };
  }

  // 2. Find all exact occurrences of `exact` and score each by prefix/suffix context + proximity to hintStart
  const candidates = [];
  let idx = fullText.indexOf(exact);
  while (idx !== -1) {
    const actualPrefix = fullText.slice(Math.max(0, idx - prefix.length), idx);
    const actualSuffix = fullText.slice(idx + exact.length, idx + exact.length + suffix.length);

    const prefixScore = prefix ? computeStringSimilarity(prefix, actualPrefix) : 1.0;
    const suffixScore = suffix ? computeStringSimilarity(suffix, actualSuffix) : 1.0;
    const distancePenalty = Math.min(0.15, Math.abs(idx - hintStart) / Math.max(fullText.length, 1) * 0.15);
    const totalScore = prefixScore * 0.45 + suffixScore * 0.45 + (0.1 - distancePenalty);

    candidates.push({
      start: idx,
      end: idx + exact.length,
      score: totalScore,
      method: 'quote-exact'
    });
    idx = fullText.indexOf(exact, idx + 1);
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  // 3. Whitespace-agnostic & Unicode-normalized regex match (handles linebreaks, hyphenation, minor spacing shifts)
  const words = exact
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (words.length > 0 && words.length <= 80) {
    try {
      const pattern = new RegExp(words.join('[\\s\\u00AD\\r\\n]+'), 'u');
      const regexMatch = pattern.exec(fullText);
      if (regexMatch) {
        return {
          start: regexMatch.index,
          end: regexMatch.index + regexMatch[0].length,
          score: 0.92,
          method: 'whitespace-normalized'
        };
      }
    } catch (_) {}
  }

  // 4. Fuzzy Window Search around `hintStart` (or across document if small)
  const targetLen = exact.length;
  if (targetLen < 4) return null;

  const searchRadius = 2400;
  const winStart = Math.max(0, hintStart - searchRadius);
  const winEnd = Math.min(fullText.length, hintStart + targetLen + searchRadius);
  const anchorHead = exact.slice(0, Math.min(10, targetLen));

  let bestFuzzy = null;
  const step = Math.max(1, Math.floor(targetLen / 6));

  // Probe candidate offsets using anchor head matches first, then coarse stride
  const probeOffsets = new Set();
  let headIdx = fullText.indexOf(anchorHead, winStart);
  while (headIdx !== -1 && headIdx < winEnd) {
    probeOffsets.add(headIdx);
    headIdx = fullText.indexOf(anchorHead, headIdx + 1);
  }
  for (let pos = winStart; pos <= winEnd - targetLen; pos += step) {
    probeOffsets.add(pos);
  }

  for (const pos of probeOffsets) {
    const candidateStr = fullText.slice(pos, pos + targetLen);
    const sim = computeStringSimilarity(exact, candidateStr);
    if (sim >= similarityThreshold && (!bestFuzzy || sim > bestFuzzy.score)) {
      bestFuzzy = {
        start: pos,
        end: pos + targetLen,
        score: sim,
        method: 'fuzzy'
      };
      if (sim > 0.95) break;
    }
  }

  return bestFuzzy;
}

/**
 * Full DOM Re-Anchoring for an Annotation
 * Returns `{ range, status: 'active' | 'orphaned', method }`
 */
export function reanchorAnnotationInDom(annotation, root = document.body, similarityThreshold = 0.78) {
  const selectors = annotation?.selectors || {};

  // Stage 1: Try RangeSelector fast path
  const rangeSel = selectors.RangeSelector;
  const quoteSel = selectors.TextQuoteSelector;
  if (rangeSel?.startContainerXPath && rangeSel?.endContainerXPath && quoteSel?.exact) {
    const startNode = resolveNodeXPath(rangeSel.startContainerXPath, root);
    const endNode = resolveNodeXPath(rangeSel.endContainerXPath, root);
    if (startNode && endNode) {
      try {
        const candidateRange = document.createRange();
        candidateRange.setStart(startNode, rangeSel.startOffset || 0);
        candidateRange.setEnd(endNode, rangeSel.endOffset || 0);
        if (normalizeTextNFC(candidateRange.toString()).trim() === normalizeTextNFC(quoteSel.exact).trim()) {
          return { range: candidateRange, status: 'active', method: 'xpath-fast' };
        }
      } catch (_) {}
    }
  }

  // Stage 2, 3, 4: TextQuote + Context + Fuzzy search over text node index
  const { fullText, segments } = buildTextNodeIndex(root);
  const span = findTextSpanInFullText(fullText, selectors, similarityThreshold);
  if (span) {
    const domRange = charOffsetsToDomRange(span.start, span.end, segments);
    if (domRange) {
      return { range: domRange, status: 'active', method: span.method };
    }
  }

  return { range: null, status: 'orphaned', method: 'orphaned' };
}
