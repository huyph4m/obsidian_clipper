# Obsidian Web Clipper & AI Companion (Manifest V3)

A full-featured Chrome Extension that connects your browser directly to **Obsidian** via the **Local REST API** plugin. It combines smart Web-to-Markdown clipping, a persistent **Side Panel** workspace, a full **In-Page Web Annotator** (W3C multi-selector highlights, sticky notes, image/area boxes, and bookmarks), native **Obsidian Note Properties**, real-time **Bi-Directional Sync**, binary image attachment capture, multi-vendor LLM auto-tagging & summarization (including **DeepSeek**, **OpenAI**, **Anthropic Claude**, **Google Gemini**, **Ollama**, and custom endpoints), and relevant vault note discovery.

---

## Core Features

### 1. Default Persistent Side Panel & Full Vault Folder Selector
- **Default Side Panel View (`background.js`, `sidepanel.html`, `workspace.js`)**: Clicking the extension toolbar icon opens the persistent Chrome **Side Panel** immediately (`Cmd+Shift+S` / `Alt+Shift+S`) and automatically tracks active tab changes.
- **Full Vault Folder Tree Discovery (`services/obsidian-api.js`)**: Recursively scans your Obsidian vault (up to 8 levels deep in parallel, skipping hidden `.obsidian`/`.git` directories) so you can choose any existing folder—or filter and type a new subfolder path on the fly.
- **Native Obsidian Note Properties (`services/markdown-converter.js`)**: Stores all note metadata (`title`, `source`, `domain`, `author`, `created`, `status`, `description`, `annotations_count`, `tags`, plus custom user properties) exclusively in valid YAML frontmatter so your Markdown editor body remains clean.

---

### 2. In-Page Web Annotator Module (`content.js`, `services/annotation-anchor.js`, `services/annotation-store.js`)
Annotate any web page directly in place, persist annotations locally in IndexedDB (`ObsidianWebAnnotatorDB`), and sync them bi-directionally with your Obsidian note.
- **One-Click Enable / Disable Toggle**: You can enable or disable the In-Page Web Annotator at any time using the **Enable In-Page Web Annotator** switch at the top of the Side Panel **Annotations** tab or in **⚙️ Settings → Section 3**. When disabled, the floating text-selection toolbar, in-page highlights, sticky pins, and area boxes are completely turned off on web pages while preserving your saved annotations in storage.

#### Supported Annotation Types
1. **Multi-Color Highlights**: 5 colors (`Yellow`, `Green`, `Blue`, `Purple`, `Pink`) with optional Markdown comments and `#tags`.
2. **Text Style Variants**: **Underline**, **Strikethrough**, and **Squiggly** text-anchored annotations.
3. **Note Tooltip Popover**: Hover or click any highlighted text to open an isolated Shadow DOM popover supporting Markdown preview, inline editing, color switching, tag chips, AI actions, and vault `[[Wikilink]]` lookup.
4. **Sticky Notes / Pins (`📌`)**: Collapsible floating notes pinned to a specific DOM element or coordinate that track scroll and window resize.
5. **Image / Area Annotations (`▢`)**: Click and drag a rectangle over any image or page region to attach a visual note (stored relative to the anchor element).
6. **Page-Level Notes**: Whole-page notes without a DOM anchor.
7. **Bookmark Markers (`🔖`)**: Scroll-anchored reading markers pinned to the page margin.

#### W3C Multi-Selector Anchoring & 4-Stage Re-Anchoring
Every text annotation stores three selectors following the **W3C Web Annotation Data Model**:
- **`TextQuoteSelector`**: Exact selected text (`exact`) plus ~32 characters of `prefix` and `suffix` context.
- **`TextPositionSelector`**: Character `start` and `end` offsets within the Unicode NFC-normalized document text.
- **`RangeSelector`**: XPath and character offsets to the start and end DOM containers.
- **`ElementSelector`**: Resilient element locator (`id`, `src`, CSS path, XPath, and text fingerprint) for Sticky Notes and Area/Image boxes.

When you revisit a page (including SPAs and lazy-loaded pages observed via a debounced `MutationObserver`), the engine re-anchors highlights in 4 stages:
1. **Fast Path**: XPath `RangeSelector` verified against Unicode NFC-normalized `exact` text.
2. **Context Quote Match**: Exact quote match disambiguated by `prefix` + `suffix` similarity and proximity.
3. **Whitespace & Diacritics Tolerant Match**: Handles line wraps, soft hyphens, and Vietnamese/Unicode NFC text.
4. **Fuzzy Window Match & Orphaned Fallback**: Uses Levenshtein similarity around the stored position (configurable threshold, default `0.78`). If the underlying text was deleted from the page, the annotation is preserved as **`Orphaned`** in the **Annotations** tab where you can re-anchor it in one click with **🔗 Re-attach**.

#### Host-Safe Rendering & Per-Site Permissions
- **Non-Destructive Highlighting**: Uses the **CSS Custom Highlight API** (`CSS.highlights`) alongside restorable `<mark data-obsidian-ann-id>` wrappers, and isolates all toolbars, popovers, and sticky pins inside a **Shadow DOM** (`#obsidian-web-annotator-host`).
- **Privacy-First Permissions (`optional_host_permissions`)**: Uses `activeTab` on first use without requiring `<all_urls>` at install. Once you annotate a page, click **Always Restore on Site** in the **Annotations** tab (or enable globally in Settings) to automatically restore highlights whenever you revisit that domain.

#### Where Annotations Are Stored in Obsidian
When you save or sync a note, annotations are written into a human-readable managed section at the bottom of the note (`## Annotations`), preserving 100% of your note content outside the markers:

```markdown
## Annotations
<!-- obsidian-clipper:annotations:start -->
> [!quote] ==highlighted text from the web page== ^ann-3f2a1b
> Your Markdown comment here #tag1 #tag2
<!-- obsidian-ann-meta:{"id":"...","type":"highlight","color":"yellow","selectors":{...}} -->
<!-- obsidian-clipper:annotations:end -->
```

- **Block Referenceable (`^ann-xxxxxx`)**: Link directly to any highlight from other notes in your vault using `[[Note Title#^ann-3f2a1b]]` (click **`[[#^]]`** on any card in the **Annotations** tab to copy the link).
- **True Bi-Directional Sync**: Editing an annotation's comment, adding `#tags`, or deleting a callout block inside Obsidian is automatically parsed and reconciled back onto the live webpage when you pull or run **Live 2-Way Sync**.
- **Backup & Portability**: Export all annotations as JSON or import existing **Hypothes.is** JSON exports from the **Annotations** tab.

---

### 3. Multi-Vendor AI (OpenAI, DeepSeek, Anthropic, Gemini, Ollama, Custom)
Configured in `services/llm-service.js` and `options.html`:
- **Supported Providers**:
  - **OpenAI** (`gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`, `o3-mini`)
  - **DeepSeek** (`deepseek-chat` V3 and `deepseek-reasoner` R1 with automatic `<think>` block stripping)
  - **Anthropic Claude** (`claude-3-5-sonnet-latest`, `claude-3-5-haiku-latest`, `claude-3-7-sonnet-latest`)
  - **Google Gemini** (`gemini-2.5-flash`, `gemini-2.5-pro`)
  - **Ollama (Local)** (`llama3.1`, `deepseek-r1:8b`, `qwen2.5:7b`, `mistral`)
  - **Custom OpenAI-Compatible** (OpenRouter, Groq, LM Studio)
- **AI Auto-Tag (`✨ AI Auto-Tag`)**: Generates clean kebab-case tags and saves them directly into your Obsidian `tags` Note Property.
- **AI Page Summary (`🧠 AI Summary`)**: Summarizes the page and inserts it into the note body inside a `> [!abstract] AI Summary` callout block.
- **In-Page AI Selection Assistant (`✨ Ask AI`)**: Explain, simplify, or translate any highlighted passage directly inside the on-page annotation popover.
- **AI Annotation Digest & Highlight Suggestions**: In the **Annotations** tab, click **🧠 Digest** to synthesize all your highlights and comments into `> [!abstract] AI Summary`, or click **✨ Suggest** to let AI propose key verbatim sentences to highlight.

---

### 4. Image Capture & Relevant Vault Notes Discovery
- **Page Images Gallery & Visual Picker**: Save individual or all page images as binary files directly into your Obsidian `Attachments/` folder and rewrite links to `![[image.png]]`, or use **📷 Pick Image** to click any image on the live page.
- **Relevant Notes Tab**: Automatically queries your vault by URL, title, and heading keywords to surface related notes with 1-click **Load & Bi-Sync**, **+ Insert `[[Wikilink]]`**, and **Open in Obsidian** actions.

---

## Keyboard Shortcuts

| Action | Windows / Linux | macOS |
| :--- | :--- | :--- |
| Toggle Obsidian Side Panel | `Alt + Shift + S` | `Cmd + Shift + S` |
| Quick Capture Page | `Alt + Shift + O` | `Cmd + Shift + O` |
| Highlight Selected Text | `Alt + Shift + H` | `Cmd + Shift + H` |
| Toggle In-Page Annotations Visibility | `Alt + Shift + A` | `Cmd + Shift + A` |
| Jump to Next / Previous Annotation on Page | `Alt + N` / `Alt + P` | `Alt + N` / `Alt + P` |
| Undo / Redo Annotation Action on Page | `Alt + Z` / `Alt + Shift + Z` | `Alt + Z` / `Alt + Shift + Z` |

---

## Installation & Manual Test Checklist

1. **Enable Obsidian Local REST API**:
   - In Obsidian, go to **Settings → Community Plugins**, install **Local REST API**, enable it, and copy your **API Key** (enabling HTTP on port `27123` is recommended).
2. **Load Unpacked Extension in Chrome**:
   - Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select `/Users/berniepham/Code/Obsidian 2.0`.
3. **Configure Settings**:
   - Click the extension icon to open the Side Panel, click **⚙️ Settings**, paste your Obsidian API Key and LLM API Key (e.g., DeepSeek or OpenAI), and click **Test Obsidian Connection** and **Test Active LLM Provider**.
4. **Manual Verification Checklist (Wikipedia, Medium, GitHub, News Sites)**:
   - Select text on an article → click a color swatch on the floating Shadow DOM toolbar → verify the highlight renders cleanly without shifting page layout.
   - Hover or click the highlight → add a Markdown comment and `#tag` → click **🔗 Vault Links** or **✨ Explain**.
   - Open the Side Panel **Annotations** tab → click **Always Restore on Site**, reload the page, and confirm the highlight re-anchors automatically.
   - Click **Save to Obsidian** (or **⇄ Sync Annotations Now**) → open the note in Obsidian and verify the `## Annotations` block with `^ann-xxxx` block IDs and clean YAML Note Properties.

### Known Limitations
- **Cross-Origin Sandboxed Iframes & Chrome Built-In PDF Viewer**: Chrome restricts content script injection inside built-in PDF viewers and cross-origin iframes without host permissions; use **+ Page Note** in the **Annotations** tab or clip content into the **Editor** tab as a fallback.
- **Canvas-Only Sites (e.g., Google Docs Canvas / Figma)**: Because canvas-rendered text does not expose standard DOM text nodes, use **+ Area/Image**, **+ Sticky**, or **+ Page Note** on canvas surfaces.
