/**
 * Rich HTML-to-Markdown Converter & Obsidian Note Properties (YAML Frontmatter) Engine
 * - Converts DOM/HTML trees into clean Obsidian Flavored Markdown
 * - Strictly separates Note Body from Note Properties (YAML Frontmatter) so raw YAML
 *   never leaks into the Markdown Editor body or produces invalid YAML syntax inside Obsidian.
 * - Formats AI Summaries into an `> [!abstract] AI Summary` callout inside the note body.
 */

export function htmlToMarkdown(htmlString, baseUrl = '') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString || '', 'text/html');

  const noiseSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    'canvas',
    'nav',
    'footer',
    'header .nav',
    '.advertisement',
    '.ads',
    '.cookie-banner',
    '.social-share',
    '[aria-hidden="true"]'
  ];
  noiseSelectors.forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  });

  const extractedImages = [];

  function resolveUrl(rel) {
    if (!rel) return '';
    if (rel.startsWith('data:') || rel.startsWith('http://') || rel.startsWith('https://')) {
      return rel;
    }
    try {
      return new URL(rel, baseUrl || 'https://example.com').href;
    } catch (_) {
      return rel;
    }
  }

  function convertTable(tableNode) {
    const rows = Array.from(tableNode.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const matrix = rows.map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) =>
        convertChildren(cell).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
      )
    );

    const colCount = Math.max(...matrix.map((r) => r.length), 0);
    if (colCount === 0) return '';

    const normalized = matrix.map((r) => {
      const copy = [...r];
      while (copy.length < colCount) copy.push('');
      return copy;
    });

    const header = `| ${normalized[0].join(' | ')} |`;
    const divider = `| ${new Array(colCount).fill('---').join(' | ')} |`;
    const body = normalized
      .slice(1)
      .map((r) => `| ${r.join(' | ')} |`)
      .join('\n');

    return `\n\n${header}\n${divider}${body ? '\n' + body : ''}\n\n`;
  }

  function convertList(listNode, depth = 0) {
    const isOrdered = listNode.tagName.toLowerCase() === 'ol';
    const items = Array.from(listNode.children).filter((c) => c.tagName.toLowerCase() === 'li');
    const indent = '  '.repeat(depth);

    return (
      '\n' +
      items
        .map((li, idx) => {
          const bullet = isOrdered ? `${idx + 1}. ` : '- ';
          const checkbox = li.querySelector('input[type="checkbox"]');
          let checkPrefix = '';
          if (checkbox) {
            checkPrefix = checkbox.checked ? '[x] ' : '[ ] ';
          }
          const childContent = Array.from(li.childNodes)
            .map((n) => {
              if (n.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(n.tagName.toLowerCase())) {
                return convertList(n, depth + 1);
              }
              return convertNode(n, depth);
            })
            .join('')
            .trim();
          return `${indent}${bullet}${checkPrefix}${childContent}`;
        })
        .join('\n') +
      (depth === 0 ? '\n\n' : '')
    );
  }

  function convertChildren(node, listDepth = 0) {
    return Array.from(node.childNodes)
      .map((child) => convertNode(child, listDepth))
      .join('');
  }

  function convertNode(node, listDepth = 0) {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\s+/g, ' ');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case 'h1':
        return `\n\n# ${convertChildren(node).trim()}\n\n`;
      case 'h2':
        return `\n\n## ${convertChildren(node).trim()}\n\n`;
      case 'h3':
        return `\n\n### ${convertChildren(node).trim()}\n\n`;
      case 'h4':
        return `\n\n#### ${convertChildren(node).trim()}\n\n`;
      case 'h5':
        return `\n\n##### ${convertChildren(node).trim()}\n\n`;
      case 'h6':
        return `\n\n###### ${convertChildren(node).trim()}\n\n`;
      case 'p': {
        const inner = convertChildren(node).trim();
        return inner ? `\n\n${inner}\n\n` : '';
      }
      case 'br':
        return '  \n';
      case 'hr':
        return '\n\n---\n\n';
      case 'strong':
      case 'b': {
        const inner = convertChildren(node).trim();
        return inner ? `**${inner}**` : '';
      }
      case 'em':
      case 'i': {
        const inner = convertChildren(node).trim();
        return inner ? `*${inner}*` : '';
      }
      case 'del':
      case 's': {
        const inner = convertChildren(node).trim();
        return inner ? `~~${inner}~~` : '';
      }
      case 'mark': {
        const inner = convertChildren(node).trim();
        return inner ? `==${inner}==` : '';
      }
      case 'code': {
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
          return node.textContent;
        }
        const inner = node.textContent.trim();
        return inner ? `\`${inner.replace(/`/g, '\\`')}\`` : '';
      }
      case 'pre': {
        const codeEl = node.querySelector('code');
        const classAttr = (codeEl?.getAttribute('class') || node.getAttribute('class') || '').toLowerCase();
        const langMatch = classAttr.match(/language-([a-z0-9_+-]+)/);
        const lang = langMatch ? langMatch[1] : '';
        const rawCode = (codeEl ? codeEl.textContent : node.textContent).replace(/\n$/, '');
        return `\n\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n\n`;
      }
      case 'blockquote': {
        const inner = convertChildren(node).trim();
        if (!inner) return '';
        const quoted = inner
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        return `\n\n${quoted}\n\n`;
      }
      case 'ul':
      case 'ol':
        return convertList(node, listDepth);
      case 'table':
        return convertTable(node);
      case 'a': {
        const href = resolveUrl(node.getAttribute('href'));
        const text = convertChildren(node).trim() || href;
        if (!href || href.startsWith('javascript:')) return text;
        return `[${text}](${href})`;
      }
      case 'img': {
        const rawSrc =
          node.getAttribute('src') ||
          node.getAttribute('data-src') ||
          node.getAttribute('data-lazy-src') ||
          '';
        const src = resolveUrl(rawSrc);
        if (!src) return '';
        const alt = (node.getAttribute('alt') || node.getAttribute('title') || 'Image')
          .replace(/[\[\]\n]/g, ' ')
          .trim();
        extractedImages.push({ src, alt });
        return `\n\n![${alt}](${src})\n\n`;
      }
      case 'figure': {
        const img = node.querySelector('img');
        const caption = node.querySelector('figcaption');
        let out = convertChildren(node);
        if (img && caption) {
          const capText = caption.textContent.trim();
          if (capText) {
            out += `\n*${capText}*\n`;
          }
        }
        return `\n\n${out.trim()}\n\n`;
      }
      default:
        return convertChildren(node, listDepth);
    }
  }

  let markdown = convertChildren(doc.body);
  markdown = markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    markdown,
    images: extractedImages
  };
}

/**
 * Sanitize filename for Obsidian vault
 */
export function sanitizeFileName(title) {
  return (
    (title || 'Untitled Web Clipping')
      .replace(/[\\/:*?"<>|#^\[\]]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^-+|-+$/g, '')
      .trim()
      .slice(0, 110) || 'Untitled Note'
  );
}

/**
 * Normalize a single Obsidian tag (strips '#', brackets, quotes, spaces -> kebab-case)
 */
export function normalizeObsidianTag(rawTag) {
  return String(rawTag || '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[\[\]"'`,;:\\|?*<>()]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/_-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Format an AI summary string into an Obsidian `> [!abstract] AI Summary` callout block
 * and insert or replace it cleanly inside the Markdown note body.
 */
export function formatSummaryCallout(summaryMarkdown = '') {
  const clean = String(summaryMarkdown || '').trim();
  if (!clean) return '';
  const quotedLines = clean
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `> [!abstract] AI Summary\n${quotedLines}`;
}

export function upsertSummaryCalloutInBody(bodyMarkdown = '', summaryMarkdown = '') {
  const calloutBlock = formatSummaryCallout(summaryMarkdown);
  if (!calloutBlock) return bodyMarkdown;

  const currentBody = String(bodyMarkdown || '');
  // Match an existing `> [!abstract] AI Summary` callout block
  const existingCalloutRegex = /^> \[!abstract\] AI Summary[ \t]*\r?\n(?:>.*(?:\r?\n|$))*/m;
  if (existingCalloutRegex.test(currentBody)) {
    return currentBody.replace(existingCalloutRegex, `${calloutBlock}\n\n`).replace(/\n{3,}/g, '\n\n');
  }

  // Otherwise, insert right after the top `# Title` heading if present, or at the top of the note body
  const h1Match = currentBody.match(/^(# [^\r\n]+\r?\n+)/);
  if (h1Match) {
    const afterH1 = currentBody.slice(h1Match[0].length).replace(/^\r?\n+/, '');
    return `${h1Match[1]}\n${calloutBlock}\n\n${afterH1}`;
  }

  return `${calloutBlock}\n\n${currentBody.replace(/^\r?\n+/, '')}`;
}

/**
 * Format a JavaScript object of Note Properties into strict Obsidian YAML Frontmatter (`--- ... ---`)
 */
export function serializeObsidianProperties(propertiesObj = {}) {
  const lines = ['---'];

  const formatYamlScalar = (val) => {
    if (val === null || val === undefined) return '""';
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    const str = String(val).replace(/\r?\n+/g, ' ').trim();
    if (!str) return '""';
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(str)) {
      return str;
    }
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };

  for (const [key, rawValue] of Object.entries(propertiesObj)) {
    const cleanKey = String(key || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '');
    // Explicitly skip 'summary' property so summary is never stored in YAML frontmatter
    if (!cleanKey || cleanKey === 'summary') continue;

    if (cleanKey === 'tags') {
      const rawList = Array.isArray(rawValue) ? rawValue : [rawValue];
      const validTags = Array.from(new Set(rawList.map(normalizeObsidianTag).filter(Boolean)));
      if (validTags.length === 0) {
        lines.push('tags: []');
      } else {
        lines.push('tags:');
        for (const tag of validTags) {
          lines.push(`  - ${tag}`);
        }
      }
      continue;
    }

    if (Array.isArray(rawValue)) {
      const items = rawValue
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      if (items.length === 0) {
        lines.push(`${cleanKey}: []`);
      } else {
        lines.push(`${cleanKey}:`);
        for (const item of items) {
          lines.push(`  - ${formatYamlScalar(item)}`);
        }
      }
    } else if (typeof rawValue === 'boolean' || typeof rawValue === 'number') {
      lines.push(`${cleanKey}: ${rawValue}`);
    } else {
      lines.push(`${cleanKey}: ${formatYamlScalar(rawValue)}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse Obsidian YAML Frontmatter from a Markdown string into a structured `properties` object
 * and a clean `body` string with ANY leading YAML frontmatter blocks completely stripped.
 */
export function parseObsidianProperties(markdown = '') {
  let remaining = String(markdown || '').replace(/^\uFEFF/, '');
  const properties = {};

  const unquote = (s) => {
    const t = String(s || '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return t;
  };

  const fmRegex = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  let match = remaining.match(fmRegex);

  while (match) {
    const yamlBlock = match[1];
    remaining = remaining.slice(match[0].length).replace(/^\s*\r?\n/, '');

    const lines = yamlBlock.split(/\r?\n/);
    let currentListKey = null;

    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;

      const listMatch = line.match(/^\s*-\s+(.*)$/);
      if (listMatch && currentListKey) {
        const val = unquote(listMatch[1]);
        if (currentListKey === 'tags') {
          const cleanTag = normalizeObsidianTag(val);
          if (cleanTag) properties[currentListKey].push(cleanTag);
        } else if (val) {
          properties[currentListKey].push(val);
        }
        continue;
      }

      const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const rawVal = kvMatch[2].trim();

        // Skip legacy `summary` property if present in old notes
        if (key === 'summary') {
          currentListKey = null;
          continue;
        }

        if (!rawVal) {
          currentListKey = key;
          if (!Array.isArray(properties[key])) properties[key] = [];
        } else if (rawVal.startsWith('[')) {
          currentListKey = null;
          const bracketEnd = rawVal.indexOf(']');
          const inner = bracketEnd > 1 ? rawVal.slice(1, bracketEnd).trim() : '';
          const parsedArr = inner
            ? inner
                .split(',')
                .map((x) => unquote(x))
                .filter(Boolean)
            : [];
          properties[key] =
            key === 'tags' ? parsedArr.map(normalizeObsidianTag).filter(Boolean) : parsedArr;
        } else if (rawVal === 'true' || rawVal === 'false') {
          currentListKey = null;
          properties[key] = rawVal === 'true';
        } else if (!Number.isNaN(Number(rawVal)) && rawVal !== '' && !/^\d{4}-\d{2}-\d{2}/.test(rawVal)) {
          currentListKey = null;
          properties[key] = Number(rawVal);
        } else {
          currentListKey = null;
          properties[key] = unquote(rawVal);
        }
      }
    }

    match = remaining.match(fmRegex);
  }

  return {
    properties,
    body: remaining.replace(/^\r?\n+/, '')
  };
}

/**
 * Combine structured Obsidian Note Properties and clean Markdown Body into a complete Obsidian note
 */
export function buildFullMarkdownWithProperties(bodyMarkdown, propertiesObj) {
  const { body } = parseObsidianProperties(bodyMarkdown);
  const frontmatter = serializeObsidianProperties(propertiesObj);
  return `${frontmatter}\n\n${body.trim()}\n`;
}

/**
 * Render ONLY the clean Note Body from a template, while returning the structured Properties object
 * separately so the Markdown Editor only shows the note body and the Properties Panel holds all metadata.
 */
export function buildNoteFromTemplate(templateString, data) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const datetimeStr = now.toISOString().replace('T', ' ').slice(0, 16);

  let domain = '';
  try {
    domain = new URL(data.url || 'https://example.com').hostname.replace(/^www\./, '');
  } catch (_) {
    domain = '';
  }

  const properties = {
    title: data.title || 'Untitled',
    source: data.url || '',
    domain,
    author: data.author || 'Unknown',
    created: dateStr,
    status: data.status || 'unread',
    description: data.description || '',
    tags: Array.isArray(data.tags) ? data.tags.map(normalizeObsidianTag).filter(Boolean) : [],
    ...(data.customProperties || {})
  };

  if (data.publishedTime) {
    properties.published = String(data.publishedTime).slice(0, 10);
  }

  const { body: cleanTemplateBody } = parseObsidianProperties(templateString);

  const summaryCallout = data.summary ? formatSummaryCallout(data.summary) : '';

  const replacements = {
    '{{title}}': data.title || 'Untitled',
    '{{url}}': data.url || '',
    '{{domain}}': domain,
    '{{author}}': data.author || 'Unknown',
    '{{date}}': dateStr,
    '{{datetime}}': datetimeStr,
    '{{tags}}': properties.tags.map((t) => `#${t}`).join(' '),
    '{{summary}}': summaryCallout,
    '{{selection}}': data.selection || '',
    '{{content}}': data.content || ''
  };

  let bodyOutput = cleanTemplateBody;
  for (const [token, value] of Object.entries(replacements)) {
    bodyOutput = bodyOutput.split(token).join(value);
  }

  // If `data.summary` exists and the template didn't have `{{summary}}`, insert `> [!abstract] AI Summary` callout
  if (summaryCallout && !cleanTemplateBody.includes('{{summary}}')) {
    bodyOutput = upsertSummaryCalloutInBody(bodyOutput, data.summary);
  }

  bodyOutput = bodyOutput
    .replace(/> \[!abstract\] AI Summary\s*\r?\n> \*No AI summary generated yet[^*\n]*\*\r?\n*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    properties,
    bodyMarkdown: bodyOutput + '\n'
  };
}
