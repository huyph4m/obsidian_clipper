# Obsidian Web Clipper & AI Companion (Manifest V3)

A full-featured Chrome Extension that connects your browser directly to **Obsidian** via the **Local REST API** plugin, combining smart web clipping, a live in-extension Markdown editor, real-time bi-directional sync, image attachment capture, multi-vendor LLM auto-tagging & summarization, and relevant vault note discovery.

---

## Core Features

1. **Obsidian Local REST API Integration (`services/obsidian-api.js`)**
   - Connects over HTTP (`27123`) or HTTPS (`27124`) using your Local REST API Bearer key.
   - Dynamically fetches and populates your Obsidian vault folder hierarchy so you can save notes into any specific folder.
   - Automatic **`SYNC` extension badge** when the web page you are viewing is already saved inside your Obsidian vault.

2. **Smart Web-to-Markdown Capture (`content.js` & `services/markdown-converter.js`)**
   - Supports **Auto (Selection or Main Article)**, **Main Article**, **Selected Text Only**, and **Full Page** capture modes.
   - Converts headings, tables, code blocks with language tags, blockquotes, checklists, and links into clean Obsidian-flavored Markdown with YAML frontmatter.
   - Customizable Markdown templates (**Standard Web Article**, **Research & Literature Note**, **Quick Bookmark & Summary**).

3. **In-Extension Markdown Editor (`popup.html`, `sidepanel.html`, `workspace.js`)**
   - Full formatting toolbar (`Bold`, `Italic`, `H2`, `H3`, `Blockquote`, `Code`, `[!info] Callout`, `[[Wikilink]]`, `- [ ] Task`).
   - Switch seamlessly between **Edit**, **Split View**, and **Rendered Preview** modes.
   - Works both as a quick toolbar **Popup** and as a persistent Chrome **Side Panel** (`Cmd/Alt + Shift + S`).

4. **Bi-Directional Sync (`workspace.js` & `services/obsidian-api.js`)**
   - Automatically detects if the current URL or selected note already exists in your Obsidian vault.
   - **Pull from Obsidian (`↓`)**: Pull the latest edits made inside the Obsidian desktop app directly into the browser Markdown editor.
   - **Push to Obsidian (`↑`)**: Save and update the vault note directly from Chrome.
   - **Live 2-Way Sync Toggle**: Optional background polling that automatically syncs changes in both directions while you research and take notes.

5. **Image Capture to Obsidian Vault (`background.js`, `content.js`, `workspace.js`)**
   - **Page Images Gallery Tab**: Inspect all images extracted from the page, save individual images (or all images at once) as binary files directly into your Obsidian `Attachments/` folder, and automatically rewrite remote URLs to local Obsidian embeds (`![[image.png]]`).
   - **Interactive Visual Image Picker**: Click **"Pick Image"** in the toolbar (or right-click any image on any webpage → *Capture Image to Obsidian Vault & Copy Embed*) to save images directly to your vault with one click.

6. **Multi-Vendor AI Auto-Tagging, Summarization & Editor Actions (`services/llm-service.js`)**
   - Supports **OpenAI**, **Anthropic Claude**, **Google Gemini**, **Ollama (Local)**, and **Custom OpenAI-Compatible** endpoints (OpenRouter, Groq, LM Studio).
   - **AI Auto-Tag**: Generates clean, normalized kebab-case tags and injects them straight into your YAML frontmatter.
   - **AI Page Summary**: Generates a structured summary (`TL;DR + Key Takeaways`, `Concise`, `Executive`, or `Academic`) and embeds it as an `> [!abstract] AI Summary` callout.
   - **AI Editor Actions**: Polish Markdown structure, extract `- [ ]` action items, generate spaced-repetition flashcards (`Question :: Answer`), or synthesize callouts.

7. **Relevant Vault Notes Discovery (`services/obsidian-api.js` & `workspace.js`)**
   - Automatically scans your Obsidian vault using the current page's URL, title, and extracted heading keywords.
   - Displays ranked matching notes with context snippets and match reasons.
   - One-click **Insert `[[Wikilink]]`** into your current editor, **Load & Bi-Sync** to edit that note in Chrome, or **Open in Obsidian**.

---

## Installation & Setup

1. **Enable Obsidian Local REST API**:
   - Open Obsidian → **Settings** → **Community Plugins** → Browse and install **"Local REST API"**.
   - Enable the plugin, copy your **API Key**, and optionally enable **Non-encrypted (HTTP) Server** on port `27123` for hassle-free local connection.
2. **Load Extension in Chrome**:
   - Open `chrome://extensions/` in Google Chrome.
   - Toggle **Developer mode** on (top right).
   - Click **Load unpacked** and select this folder (`/Users/berniepham/Code/Obsidian 2.0`).
3. **Configure API Keys**:
   - Click the extension icon → click the **⚙️ Settings** gear button.
   - Paste your Obsidian Local REST API Key and click **Test Obsidian Connection**.
   - Choose your preferred AI vendor (OpenAI, Anthropic, Gemini, Ollama, or Custom), enter your API key/model, and click **Test Active LLM Provider**.
