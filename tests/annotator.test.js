/**
 * Phase 4a/4c/4e Automated Unit Tests (`tests/annotator.test.js`)
 * Tests:
 * 1. URL Normalization (tracking params removal, canonical URL, SPA hash preservation)
 * 2. Unicode NFC & Vietnamese diacritics exact + fuzzy re-anchoring
 * 3. Shifted, edited, and deleted text re-anchoring (orphaned detection)
 * 4. Obsidian Managed Block (`<!-- obsidian-clipper:annotations:start/end -->`) round-trip serialization & parsing
 * 5. Bi-directional conflict resolution / reconciliation when comments or tags are edited in Obsidian
 */

import {
  normalizePageUrl,
  normalizeTextNFC,
  findTextSpanInFullText,
  computeStringSimilarity
} from '../services/annotation-anchor.js';

import {
  createAnnotationRecord,
  serializeAnnotationsToObsidianBlock,
  upsertAnnotationsSectionInMarkdown,
  parseAnnotationsFromObsidianMarkdown,
  reconcileAnnotationsWithObsidian
} from '../services/annotation-store.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

export function runAllAnnotatorUnitTests() {
  const results = [];

  // Test 1: URL Normalization
  {
    const raw = 'https://academy.hackthebox.com/app/module/335/section/4085/?utm_source=twitter&fbclid=IwAR123&a=1/';
    const norm = normalizePageUrl(raw);
    assert(
      norm === 'https://academy.hackthebox.com/app/module/335/section/4085/?a=1',
      `Expected clean URL without utm_source/fbclid, got: ${norm}`
    );

    const spaUrl = 'https://example.com/app#/dashboard/notes?utm_medium=email';
    const normSpa = normalizePageUrl(spaUrl);
    assert(normSpa.includes('#/dashboard/notes'), `Expected SPA hash route preserved, got: ${normSpa}`);
    results.push('PASS: URL Normalization (tracking params & SPA hash routes)');
  }

  // Test 2: Exact + Prefix/Suffix Disambiguation
  {
    const docText =
      'First paragraph mentions differential privacy briefly. Second paragraph explains differential privacy in detail for machine learning models.';
    const selectors = {
      TextQuoteSelector: {
        exact: 'differential privacy',
        prefix: 'Second paragraph explains ',
        suffix: ' in detail for machine'
      },
      TextPositionSelector: { start: 80, end: 100 }
    };
    const match = findTextSpanInFullText(docText, selectors);
    assert(match && match.start === 81, `Expected second occurrence at index 81, got: ${JSON.stringify(match)}`);
    results.push('PASS: W3C TextQuoteSelector with Prefix/Suffix disambiguation');
  }

  // Test 3: Vietnamese Diacritics & Unicode NFC Normalization + Fuzzy Re-anchoring on Edited Text
  {
    // Decomposed NFD input vs NFC document text in Ho Chi Minh City context
    const nfdQuote = 'Thành phố Hồ Chí Minh là trung tâm kinh tế'.normalize('NFD');
    const docText =
      'Giới thiệu: Thành phố Hồ Chí Minh là một trung tâm kinh tế lớn của Việt Nam.'.normalize('NFC');

    const selectors = {
      TextQuoteSelector: {
        exact: nfdQuote.normalize('NFC'),
        prefix: 'Giới thiệu: ',
        suffix: ' lớn của Việt Nam'
      },
      TextPositionSelector: { start: 12, end: 54 }
    };

    const fuzzyMatch = findTextSpanInFullText(docText, selectors, 0.72);
    assert(fuzzyMatch && fuzzyMatch.method === 'fuzzy', `Expected fuzzy match on slightly edited Vietnamese text, got: ${JSON.stringify(fuzzyMatch)}`);
    results.push('PASS: Vietnamese Unicode NFC normalization & Fuzzy re-anchoring');
  }

  // Test 4: Deleted Text -> Orphaned Detection
  {
    const docText = 'This page has been completely rewritten with unrelated topics.';
    const selectors = {
      TextQuoteSelector: {
        exact: 'Quantum entanglement in superconducting qubits',
        prefix: 'Chapter 4: ',
        suffix: ' demonstrates'
      },
      TextPositionSelector: { start: 10, end: 56 }
    };
    const match = findTextSpanInFullText(docText, selectors, 0.78);
    assert(match === null, 'Expected null span so annotation is marked orphaned');
    results.push('PASS: Deleted text gracefully marked as orphaned');
  }

  // Test 5: Obsidian Managed Block Serialization, Round-Trip Parsing & Bi-Directional Reconciliation
  {
    const ann1 = createAnnotationRecord({
      id: '3f2a1b99-1111-4222-8333-abcdef123456',
      type: 'highlight',
      color: 'yellow',
      quote: 'Privacy-utility tradeoff is fundamental in red teaming.',
      comment: 'Core concept for module 335',
      tags: ['privacy-ai', 'red-team'],
      pageUrl: 'https://academy.hackthebox.com/module/335',
      pageTitle: 'Privacy AI',
      selectors: {
        TextQuoteSelector: { exact: 'Privacy-utility tradeoff is fundamental in red teaming.' },
        TextPositionSelector: { start: 120, end: 175 }
      }
    });

    const initialNote = `# Privacy AI\n\nUser written intro paragraph.\n`;
    const withBlock = upsertAnnotationsSectionInMarkdown(initialNote, [ann1], 'callout');

    assert(withBlock.includes('^ann-3f2a1b'), 'Expected ^ann-3f2a1b block ID in serialized Markdown');
    assert(withBlock.includes('User written intro paragraph.'), 'Expected user text outside managed block preserved');

    // Simulate user editing the comment and adding #reviewed inside Obsidian
    const editedInObsidian = withBlock.replace(
      '> Core concept for module 335 #privacy-ai #red-team',
      '> Updated inside Obsidian desktop! #privacy-ai #red-team #reviewed'
    );

    const parsed = parseAnnotationsFromObsidianMarkdown(
      editedInObsidian,
      'https://academy.hackthebox.com/module/335',
      'Privacy AI'
    );
    assert(parsed.hasManagedSection && parsed.annotations.length === 1, 'Expected 1 parsed annotation');
    assert(
      parsed.annotations[0].comment === 'Updated inside Obsidian desktop!',
      `Expected updated comment, got: "${parsed.annotations[0].comment}"`
    );
    assert(
      parsed.annotations[0].tags.includes('reviewed'),
      `Expected #reviewed tag parsed, got: ${JSON.stringify(parsed.annotations[0].tags)}`
    );

    const reconciled = reconcileAnnotationsWithObsidian([ann1], parsed);
    assert(reconciled[0].comment === 'Updated inside Obsidian desktop!', 'Expected reconciled comment updated');
    results.push('PASS: Obsidian Managed Block round-trip & Bi-Directional conflict reconciliation');
  }

  return results;
}
