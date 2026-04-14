# ClioDeck — Research environment for historians

Desktop application (Electron + React + TypeScript) for the full historian workflow: **explore → brainstorm → write → export**, with RAG, knowledge graph, Zotero / Tropy / Obsidian integrations, and a local-first footprint.

> **v2 (fusion branch):** this branch absorbs [ClioBrain](https://github.com/inactinique/cliobrain) into ClioDeck as the *Brainstorm* mode. Historians keep a single app that covers the whole cycle instead of switching between a note-centric brainstormer and a writing assistant. See [`docs/fusion-cliobrain-strategy.md`](docs/fusion-cliobrain-strategy.md) and [`docs/fusion-cliobrain-implementation-plan.md`](docs/fusion-cliobrain-implementation-plan.md).

> **Note:** ClioDeck is a [vibe-coding](https://en.wikipedia.org/wiki/Vibe_coding) experiment. Provided *as is*, at your own risk. Designed by [Frédéric Clavert](https://inactinique.net), coded with [Claude Code](https://claude.ai/code). See my [talk on vibe-coding for historians](https://inactinique.net/prez/2025-07-03_DH-LLM/2025-07-03_DH-LLM.html#/title-slide) (French) and [ethics considerations](https://github.com/inactinique/cliodeck/wiki/4.-Ethics).

**License:** [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)

## Download

**[Download v1.0.0-rc.1 (macOS and Linux)](https://github.com/inactinique/cliodeck/releases/tag/v1.0.0-RC1)**

- **macOS**: DMG for Intel and Apple Silicon
- **Linux**: AppImage and .deb packages

v2.0 (fusion) release builds land when the branch merges to main. Until then build from source (see below).

## Four modes, one workspace

ClioDeck v2 organises work into four top-level modes that share the same project / sources / index:

- **Brainstorm** — chat-driven exploration of your corpus, with durable workspace [`.cliohints`](#cliohints) injected into every prompt and a one-click *Send to Write* button that lands a formatted draft block in the editor.
- **Write** — WYSIWYG Markdown editor with citation autocomplete (`@`), footnotes, and Milkdown rich-text editing.
- **Analyze** — knowledge graph, textometrics, topic modeling, similarity finder.
- **Export** — PDF (Pandoc / LaTeX), Word, RevealJS slides.

## Key features

- **Four-mode workflow** — Brainstorm / Write / Analyze / Export share the same workspace.
- **Typed LLM provider layer** — Ollama, OpenAI-compatible (llama.cpp, LM Studio, vLLM, OpenAI), Anthropic Claude, Mistral, Google Gemini. Switch backend in 3 clicks, no code change. API keys stored in the OS keyring via `secureStorage`.
- **Cloud embeddings** — optional: when you pick a cloud LLM backend, use the same provider for embeddings too (Gemini `text-embedding-004`, OpenAI `text-embedding-3-small`, Mistral `mistral-embed`) so you don't need a local Ollama.
- **RAG-powered assistant** — hybrid search (HNSW + BM25 + RRF K=60), context compression with RAG citations preserved verbatim, query-aware reranking.
- **Zotero integration** — sync bibliography, download PDFs, manage tags and metadata.
- **Tropy integration** — import and search primary sources with OCR + multilingual NER (fr / en / de).
- **Obsidian vault integration** — index notes (frontmatter, wikilinks, tags) into a parallel SQLite+FTS5 store, searchable from Brainstorm.
- **ClioRecipes** — YAML workflows chaining brainstorm → search → graph → write → export steps. Four builtin recipes ship for common historian tasks (Zotero review, Tropy thematic analysis, chapter brainstorm, Chicago export). Run them from Settings → Recipes with a typed inputs form and live event log.
- **MCP server (inactive by default)** — expose your corpus to Claude Desktop / Cursor over stdio with a typed, auditable JSONL access log.
- **MCP clients** (scaffold) — schema is in place (`WorkspaceConfig.mcpClients` with stdio + SSE transports); runtime lifecycle + UI land in a follow-up.
- **Source inspector** — scans RAG chunks for prompt-injection patterns before they reach the model (warn / block modes).
- **`.cliohints`** — durable workspace context injected into every prompt (style guide, period focus, language preference).
- **Headless CLI** — `cliodeck recipe run`, `cliodeck search`, `cliodeck hints`, `cliodeck import-cliobrain` for batch / CI workflows.
- **Local-first** — all data stays on your machine; works offline with embedded LLM.
- **Export** — PDF (via Pandoc/LaTeX) and Word with template support; RevealJS slide generation.

### .cliohints

Every workspace can carry a `.cliodeck/v2/hints.md` file — house rules injected into every prompt. Examples: citation style ("always Chicago author-date"), period focus ("WWII France, 1939-1945"), language ("reply in French"). Hints are *local-only* and never leaked to MCP clients unless you opt in per-tool.

## Quick start

### 1. Install Ollama and models

```bash
# macOS
brew install ollama && brew services start ollama

# Linux
curl -fsSL https://ollama.ai/install.sh | sh
```

```bash
# Required for local mode
ollama pull nomic-embed-text
ollama pull gemma2:2b   # or llama3.2, mistral:7b, …
```

### 2. Install ClioDeck

Download from [Releases](https://github.com/inactinique/cliodeck/releases) and run.

For detailed installation instructions, see:
- [macOS Installation Guide](https://github.com/inactinique/cliodeck/wiki/1.2-ClioDeck-Installation-‐-macOS)
- [Linux Installation Guide](https://github.com/inactinique/cliodeck/wiki/1.1-ClioDeck-Installation-‐-Linux)

### 3. Coming from ClioBrain?

```bash
npm run cliodeck -- import-cliobrain /path/to/your/cliobrain/workspace
```

The importer copies `brain.db`, `hnsw.index`, `hints.md`, and the MCP access log into the v2 layout under `.cliodeck/v2/`, merging your existing `config.json` and preserving unknown keys. See [docs/fusion-cliobrain-strategy.md](docs/fusion-cliobrain-strategy.md) for the full migration rationale. ClioBrain enters maintenance mode; new features go to ClioDeck.

### Build from source

```bash
git clone https://github.com/inactinique/cliodeck.git
cd cliodeck
npm install
npx electron-rebuild -f
npm run build
npm start
```

See [Build and Deployment Guide](https://github.com/inactinique/cliodeck/wiki/2.1-Build-and-Deployment-Guide) for distribution builds.

## Documentation

Full documentation is available in the **[ClioDeck Wiki](https://github.com/inactinique/cliodeck/wiki)**:

### User guides
- [Installation](https://github.com/inactinique/cliodeck/wiki/1.-ClioDeck-Installation) — quick start
- [Keyboard Shortcuts](https://github.com/inactinique/cliodeck/wiki/1.4-Keyboard-Shortcuts) — complete reference
- [Zotero Integration](https://github.com/inactinique/cliodeck/wiki/1.5-Zotero-Integration-Guide) — bibliography sync
- [Tropy Integration](https://github.com/inactinique/cliodeck/wiki/1.6-Tropy-Integration-Guide) — primary sources
- [Embedded LLM](https://github.com/inactinique/cliodeck/wiki/1.7-Embedded-LLM-Guide) — offline mode
- [Corpus Analysis](https://github.com/inactinique/cliodeck/wiki/1.8-Corpus-Analysis-Guide) — knowledge graph & textometrics
- [Export Options](https://github.com/inactinique/cliodeck/wiki/1.10-Export-Presentations) — PDF & Word

### Technical documentation
- [Features Overview](https://github.com/inactinique/cliodeck/wiki/Features) — complete feature list
- [Technical Architecture](https://github.com/inactinique/cliodeck/wiki/2.-Technical-Architecture) — RAG system design
- [Build Guide](https://github.com/inactinique/cliodeck/wiki/2.1-Build-and-Deployment-Guide) — development setup
- [Fusion strategy](docs/fusion-cliobrain-strategy.md) — why v2 absorbs ClioBrain
- [ADR 0001](docs/adr/0001-rag-pipeline-arbitration.md) — RAG pipeline arbitration

## Tech stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Electron 28, React 18, TypeScript, Milkdown, Zustand, Vite |
| **Backend** | Node.js, better-sqlite3, hnswlib-node, pdfjs-dist, chokidar |
| **LLM layer** | Ollama, OpenAI-compatible, Anthropic, Mistral (typed provider registry) |
| **Embeddings** | nomic-embed-text, mxbai-embed-large, OpenAI / Mistral embeddings |
| **MCP** | `@modelcontextprotocol/sdk` (server + clients) |
| **Analysis** | Python 3.11+, BERTopic (optional) |

## Contributing

Issues and contributions are welcome on [GitHub](https://github.com/inactinique/cliodeck/issues).

For the fusion branch specifically, see the implementation plan at [`docs/fusion-cliobrain-implementation-plan.md`](docs/fusion-cliobrain-implementation-plan.md) — every commit message references the step numbers defined there.
