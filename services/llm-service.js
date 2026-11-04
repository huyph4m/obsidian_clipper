/**
 * Multi-Vendor LLM Service
 * Supports OpenAI, DeepSeek (`deepseek-chat` & `deepseek-reasoner`), Anthropic Claude,
 * Google Gemini, Ollama (Local), and Custom OpenAI-compatible endpoints.
 * Provides:
 *  1. Auto-tagging (returns structured array of clean Obsidian tags)
 *  2. Page summarization (multiple styles: concise, key takeaways, executive, academic)
 *  3. Annotation synthesis ("Summarize my annotations") & "Suggest AI Highlights"
 *  4. Custom AI transformation on selected text/markdown
 */

import { getSettings } from './storage.js';

export class LLMService {
  constructor(settings = null) {
    this.settings = settings;
  }

  async init() {
    if (!this.settings) {
      this.settings = await getSettings();
    }
    return this;
  }

  /**
   * Core completion method that routes to the active LLM vendor
   */
  async complete({ systemPrompt, userPrompt, temperature = 0.3, jsonMode = false }) {
    await this.init();
    const vendor = this.settings.llmVendor || 'openai';
    const config = this.settings.llmConfig?.[vendor] || {};

    switch (vendor) {
      case 'openai':
      case 'custom':
        return await this.callOpenAICompatible(config, systemPrompt, userPrompt, temperature, jsonMode, vendor);
      case 'deepseek':
        return await this.callDeepSeek(config, systemPrompt, userPrompt, temperature, jsonMode);
      case 'anthropic':
        return await this.callAnthropic(config, systemPrompt, userPrompt, temperature);
      case 'gemini':
        return await this.callGemini(config, systemPrompt, userPrompt, temperature, jsonMode);
      case 'ollama':
        return await this.callOllama(config, systemPrompt, userPrompt, temperature, jsonMode);
      default:
        throw new Error(`Unsupported LLM vendor: ${vendor}`);
    }
  }

  async callDeepSeek(config, systemPrompt, userPrompt, temperature, jsonMode) {
    const endpoint = (config.endpoint || 'https://api.deepseek.com/chat/completions').trim();
    const apiKey = (config.apiKey || '').trim();
    const model = (config.model || 'deepseek-chat').trim();

    if (!apiKey) {
      throw new Error('DeepSeek API key is missing. Please configure it in Extension Settings.');
    }

    const isReasoner = model.includes('reasoner') || model.includes('r1');
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    if (!isReasoner) {
      body.temperature = temperature;
      if (jsonMode) {
        body.response_format = { type: 'json_object' };
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DeepSeek API Error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content?.trim() || '';
    return rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  async callOpenAICompatible(config, systemPrompt, userPrompt, temperature, jsonMode, vendorName = 'openai') {
    const endpoint = config.endpoint || 'https://api.openai.com/v1/chat/completions';
    const apiKey = (config.apiKey || '').trim();
    const model = config.model || 'gpt-4o-mini';

    if (!apiKey && endpoint.includes('api.openai.com')) {
      throw new Error('OpenAI API key is missing. Please configure it in Extension Settings.');
    }

    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
      model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    if (jsonMode && (endpoint.includes('api.openai.com') || endpoint.includes('api.deepseek.com'))) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${vendorName.toUpperCase()} API Error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  async callAnthropic(config, systemPrompt, userPrompt, temperature) {
    const endpoint = config.endpoint || 'https://api.anthropic.com/v1/messages';
    const apiKey = (config.apiKey || '').trim();
    const model = config.model || 'claude-3-5-sonnet-latest';

    if (!apiKey) {
      throw new Error('Anthropic API key is missing. Please configure it in Extension Settings.');
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API Error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text?.trim() || '';
  }

  async callGemini(config, systemPrompt, userPrompt, temperature, jsonMode) {
    const baseEndpoint = (config.endpoint || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/, '');
    const apiKey = (config.apiKey || '').trim();
    const model = config.model || 'gemini-2.5-flash';

    if (!apiKey) {
      throw new Error('Google Gemini API key is missing. Please configure it in Extension Settings.');
    }

    const url = `${baseEndpoint}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const generationConfig = {
      temperature
    };
    if (jsonMode) {
      generationConfig.responseMimeType = 'application/json';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }]
          }
        ],
        generationConfig
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API Error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  async callOllama(config, systemPrompt, userPrompt, temperature, jsonMode) {
    const endpoint = config.endpoint || 'http://localhost:11434/api/chat';
    const model = config.model || 'llama3.1';

    const body = {
      model,
      stream: false,
      options: { temperature },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    if (jsonMode) {
      body.format = 'json';
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama Error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const content = data.message?.content?.trim() || '';
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  /**
   * Generate Obsidian-compatible tags using the configured LLM
   */
  async generateTags({ title, url, content, existingTags = [] }) {
    await this.init();
    const maxTags = this.settings.maxAutoTags || 6;
    const prefix = (this.settings.tagPrefix || '').trim();
    const truncated = (content || '').slice(0, 8000);

    const systemPrompt = `You are an expert knowledge management assistant for Obsidian.
Generate up to ${maxTags} highly relevant, specific, lowercase kebab-case tags for the provided web page.
Rules:
- Format tags as lowercase kebab-case strings without the '#' symbol (e.g., "machine-learning", "web-development", "productivity").
- Return ONLY a valid JSON object with the shape: {"tags": ["tag-1", "tag-2"], "keywords": ["concept 1", "concept 2"]}.
- Do not include markdown code fences or extra commentary.`;

    const userPrompt = `Page Title: ${title || 'Untitled'}
URL: ${url || ''}
Existing Tags on Note: ${existingTags.join(', ') || 'None'}

Content Excerpt:
${truncated}`;

    const raw = await this.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
      jsonMode: true
    });

    let parsedTags = [];
    let keywords = [];
    try {
      const cleanJson = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const obj = JSON.parse(cleanJson);
      parsedTags = Array.isArray(obj.tags) ? obj.tags : [];
      keywords = Array.isArray(obj.keywords) ? obj.keywords : [];
    } catch (_) {
      parsedTags = raw
        .split(/[\n,]+/)
        .map((t) => t.replace(/^[#\-*\d.\s"]+|[",\s]+$/g, '').trim())
        .filter(Boolean);
    }

    const normalized = parsedTags
      .map((t) =>
        String(t)
          .toLowerCase()
          .replace(/^#+/, '')
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9/_-]/g, '')
      )
      .filter(Boolean)
      .map((t) => (prefix && !t.startsWith(prefix) ? `${prefix}${t}` : t));

    return {
      tags: Array.from(new Set(normalized)).slice(0, maxTags),
      keywords: keywords.slice(0, 6)
    };
  }

  /**
   * Summarize page content using the configured style
   */
  async summarizePage({ title, url, content, style = null }) {
    await this.init();
    const chosenStyle = style || this.settings.summaryStyle || 'bullet_key_takeaways';
    const truncated = (content || '').slice(0, 12000);

    const styleGuides = {
      concise: 'Write a crisp 2-3 sentence summary capturing the core thesis and conclusion.',
      bullet_key_takeaways:
        'Provide a 1-sentence TL;DR followed by 4-6 concise bullet points highlighting the most actionable insights, facts, and takeaways.',
      executive:
        'Provide an Executive Summary with three short sections: **Core Thesis**, **Key Insights**, and **Actionable Implications**.',
      academic:
        'Provide a structured research synthesis covering **Background/Objective**, **Methodology/Arguments**, and **Key Findings**.'
    };

    const customInstruction = (this.settings.customSummaryPrompt || '').trim();
    const instruction = customInstruction || styleGuides[chosenStyle] || styleGuides.bullet_key_takeaways;

    const systemPrompt = `You are an expert research assistant summarizing web pages for an Obsidian Second Brain vault.
${instruction}
Write clean Markdown suitable for embedding directly inside an Obsidian note.`;

    const userPrompt = `Title: ${title || 'Untitled'}
URL: ${url || ''}

Content:
${truncated}`;

    return await this.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      jsonMode: false
    });
  }

  /**
   * Phase 4e: Summarize the user's Highlights & Annotations on the current page into a synthesis digest
   */
  async summarizeAnnotations({ title, url, annotations = [] }) {
    await this.init();
    const active = annotations.filter((a) => a.status !== 'deleted');
    if (active.length === 0) {
      throw new Error('No annotations on this page to summarize yet.');
    }

    const itemized = active
      .map((a, idx) => {
        const q = a.quote ? `Quote: "${a.quote}"` : `Type: ${a.type}`;
        const c = a.comment ? `\nUser Note: ${a.comment}` : '';
        const t = a.tags?.length ? `\nTags: #${a.tags.join(' #')}` : '';
        return `${idx + 1}. [^${a.obsidianBlockId}] ${q}${c}${t}`;
      })
      .join('\n\n');

    const systemPrompt = `You are an expert knowledge synthesis assistant for Obsidian.
Synthesize the user's highlights and personal annotations from the web page into a cohesive research digest.
- Group key insights logically using concise bullet points.
- Reference the user's own notes and conclusions.
- Do not fabricate information outside the provided annotations.`;

    const userPrompt = `Page Title: ${title || 'Untitled'}
URL: ${url || ''}

User Annotations (${active.length}):
${itemized.slice(0, 10000)}`;

    return await this.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.25
    });
  }

  /**
   * Phase 4e: Suggest up to 4 high-value verbatim sentences from the page text to highlight
   */
  async suggestHighlights({ title, plainText }) {
    await this.init();
    const excerpt = String(plainText || '').slice(0, 9000);
    const systemPrompt = `You are a research assistant that identifies the 4 most important verbatim sentences in an article worth highlighting.
Rules:
- Each quote MUST be an EXACT verbatim substring from the provided text (so it can be anchored on the page).
- Include a 1-sentence reason/comment explaining why it matters.
- Return ONLY valid JSON with shape: {"suggestions": [{"quote": "exact verbatim sentence...", "comment": "Why this matters", "color": "yellow"}]}`;

    const raw = await this.complete({
      systemPrompt,
      userPrompt: `Title: ${title || ''}\n\nArticle Text:\n${excerpt}`,
      temperature: 0.15,
      jsonMode: true
    });

    try {
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * AI Assistant action on selected text in the editor (Refine, Action Items, Critique, Explain)
   */
  async transformEditorContent({ content, action = 'improve' }) {
    const prompts = {
      improve: 'Clean up formatting, improve clarity, and structure this Markdown cleanly for Obsidian while preserving all factual information and links.',
      action_items: 'Extract concrete action items and tasks from this text as an Obsidian Markdown checklist (`- [ ] Task`).',
      flashcards: 'Generate 4-6 Q&A flashcards from this content in Obsidian spaced-repetition format (`Question :: Answer`).',
      callout: 'Synthesize the key insight of this text into an Obsidian Callout block (`> [!tip] Key Insight`).'
    };

    const systemPrompt = prompts[action] || prompts.improve;
    return await this.complete({
      systemPrompt,
      userPrompt: content.slice(0, 10000),
      temperature: 0.3
    });
  }
}
