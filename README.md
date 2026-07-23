# ClioDeck — Research environment for historians

Desktop application (Electron + React + TypeScript) for the full historian workflow: **explore → brainstorm → write → export**, with RAG, Zotero / Tropy / Obsidian integrations, and a local-first footprint.

> **Note:** ClioDeck is a [vibe-coding](https://en.wikipedia.org/wiki/Vibe_coding) experiment. Provided *as is*, at your own risk. Designed by [Frédéric Clavert](https://inactinique.net), coded with [Claude Code](https://claude.ai/code). See my [talk on vibe-coding for historians](https://inactinique.net/prez/2025-07-03_DH-LLM/2025-07-03_DH-LLM.html#/title-slide) (French) and [ethics considerations](https://github.com/cliodeck/cliodeck-app/wiki/4.-Ethics).

**License:** [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)

## Download

**[Download v1.0.0-rc.3](https://github.com/cliodeck/cliodeck-app/releases/tag/v1.0.0-rc.3)** — release candidate.

- **macOS** — DMG for Apple Silicon and Intel
- **Linux** — AppImage and `.deb`, **arm64 only** in this candidate; on x86_64, build from source (below)
- **Windows** — no build shipped; the code should work on Windows but is **untested**

Builds are **not code-signed**: macOS will refuse the app on first launch until you allow it explicitly. See the [installation guides](https://github.com/cliodeck/cliodeck-app/wiki/1.-ClioDeck-Installation) for how to get past it.

## Three kinds of project

## Four modes, one workspace

ClioDeck organises work into four top-level modes that share the same project / sources / index:

- **Explore** — corpus explorer, similarity finder, textometrics.
- **Brainstorm** — chat-driven exploration of your corpus, with an ideas board and a graph, and a one-click *Send to Write* that lands a formatted draft block in the editor.
- **Write** — CodeMirror 6 live-render Markdown editor (Obsidian-style) with Pandoc citations (`[@key]`, autocomplete from Zotero), footnotes with in-place editing, and byte-perfect file fidelity.
- **Export** — PDF (Pandoc / LaTeX), Word, RevealJS slides.

## Key features

- **Your file stays your file** — the editor never converts your text to an internal document and back. Open a file, save it untouched, and it is identical byte for byte, line endings and trailing spaces included.
- **The assistant can read your manuscript** — what you have already written becomes a fourth corpus, next to your PDFs, Tropy archives and Obsidian notes, so you can ask what you wrote about a subject three chapters ago. Excerpts from your own draft are labelled apart from your sources, and the assistant is told not to cite them as evidence. Indexing runs after each save and needs an embeddings model. See [`docs/manuscript-corpus.md`](docs/manuscript-corpus.md).
- **The AI only ever proposes** — no AI feature writes into your document on its own. Anything it suggests arrives as a proposal you accept, alter or refuse, and each decision is recorded: in full in the research journal, as bare counts in the AI usage journal.
- **Consent before sending** — the assistant will not reach a remote provider without your explicit consent, a rule the application core enforces itself rather than leaving to the interface.
- **Typed LLM provider layer** — embedded (bundled `llama.cpp`), Ollama, OpenAI-compatible (llama.cpp, LM Studio, vLLM, OpenAI), Anthropic Claude, Mistral, Google Gemini. Switch backend in a few clicks, no code change. API keys are encrypted at rest via Electron `safeStorage` (key derived from the OS keyring; on Linux without a keyring it falls back to plain text with a warning).
- **Runs fully offline** — with Ollama and local models, or with the small embedded models downloaded from the settings panel; no API key needed.
- **RAG-powered assistant** — hybrid search (HNSW + BM25 + RRF K=60), context compression that keeps RAG citations verbatim, query-aware reranking.
- **Zotero integration** — sync bibliography, download PDFs, manage tags and metadata.
- **Tropy integration** — import and search primary sources with OCR + multilingual NER (fr / en / de).
- **Obsidian vault integration** — index notes (frontmatter, wikilinks, tags) into a parallel SQLite+FTS5 store, searchable from Brainstorm.
- **Project context** — a `context.md` at the project root (subject, period, conventions to observe) is given to the assistant at the start of every conversation. Until you write in it, nothing is sent. See [`.cliohints`](#project-context-and-cliohints).
- **ClioRecipes** — YAML workflows chaining brainstorm → search → graph → write → export steps. Four builtin recipes ship for common historian tasks (Zotero review, Tropy thematic analysis, chapter brainstorm, Chicago export). Run them from Settings → Recipes with a typed inputs form and a live event log.
- **MCP server (inactive by default)** — expose your corpus to Claude Desktop / Cursor over stdio with a typed, auditable JSONL access log.
- **MCP clients** — consume external MCP servers (stdio + SSE) with a typed lifecycle state machine, infra-only auto-recovery, and a status view in Settings; their tools are offered to the agent loop.
- **Source inspector** — scans RAG chunks for prompt-injection patterns before they reach the model (warn / audit / block, default warn).
- **AI usage journal** — a reflexive, ethics-oriented record of your inference use (volumes, tasks, corpora) plus a manual decision layer: what non-AI alternative existed, why it was set aside, was it worth it. Kept in a separate `.cliodeck/journal.db` so it can be archived and published independently. It logs volumes and decisions, **never prompts**. See [`docs/journal-usage-ia.md`](docs/journal-usage-ia.md).
- **Headless CLI** — `bin/cliodeck` (`recipe list|run`, `search`, `hints show|set`, `import-cliobrain`, `rag-benchmark`) for batch / CI work, with usage captured in the journal; `bin/cliodeck-journal today|week|export` to review and annotate it.

### Project context and .cliohints

Two layers of durable context, both local-only and never leaked to MCP clients unless you opt in per tool:

- **`context.md`** at the project root — the visible one. Subject, period, conventions. Edit it like any other file.
- **`.cliodeck/hints.md`** — workspace house rules injected into every prompt: citation style ("always Chicago author-date"), language ("reply in French").

## Quick start

### 1. Pick how the AI runs

**Fully local, nothing to install** — download one of the small embedded models from Settings → LLM (Qwen2.5-0.5B, ~470 MB, or Qwen2.5-1.5B, ~1 GB), plus the embedded embedding model (Nomic Embed Text v2, ~344 MB) if you want RAG. Modest quality, but no dependency and no network.

**Local with Ollama** — better quality, still offline:

```bash
# macOS
brew install ollama && brew services start ollama

# Linux
curl -fsSL https://ollama.ai/install.sh | sh
```

```bash
ollama pull nomic-embed-text          # embeddings
ollama pull qwen3:8b                  # generation, tool-capable
```

Pick a **tool-capable** model if you want the assistant to search your corpus on its own: `qwen3:8b/14b/32b`, `ministral-3:8b/14b`, `mistral-nemo`. The Llama 3.x / 4.x families are served without tools (see `OLLAMA_TOOL_CAPABLE_PATTERNS` in `backend/core/llm/providers/ollama.ts`).

**Cloud** — Anthropic, Mistral, Gemini or any OpenAI-compatible endpoint. The same provider can serve embeddings, so no local Ollama is needed.

### 2. Install ClioDeck

Download from [Releases](https://github.com/cliodeck/cliodeck-app/releases) and run. Detailed guides: [macOS](https://github.com/cliodeck/cliodeck-app/wiki/1.2-ClioDeck-Installation-‐-macOS) · [Linux](https://github.com/cliodeck/cliodeck-app/wiki/1.1-ClioDeck-Installation-‐-Linux).

### Build from source

```bash
git clone https://github.com/cliodeck/cliodeck-app.git
cd cliodeck-app
npm install
npm run build
npm start
```

Native modules (`better-sqlite3`, `hnswlib-node`) are compiled for Electron's ABI by the postinstall. Running the test suite under Node needs `npm rebuild better-sqlite3` first — that is what `npm run test:integration` does, and what CI does. See the [Build and Deployment Guide](https://github.com/cliodeck/cliodeck-app/wiki/2.1-Build-and-Deployment-Guide).

### Coming from ClioBrain?

ClioBrain was absorbed into ClioDeck as the *Brainstorm* mode and is in maintenance mode; new features go to ClioDeck.

```bash
npm run cliodeck -- import-cliobrain /path/to/your/cliobrain/workspace
```

The importer copies `brain.db`, `hnsw.index`, `hints.md` and the MCP access log into the workspace's `.cliodeck/`, merging your existing `config.json` and preserving unknown keys. Legacy workspace layouts are migrated automatically when a project is opened. See [`docs/archive/fusion-cliobrain-strategy.md`](docs/archive/fusion-cliobrain-strategy.md).

## Documentation

Full documentation lives in the **[ClioDeck Wiki](https://github.com/cliodeck/cliodeck-app/wiki)**.

### User guides
- [Getting started](https://github.com/cliodeck/cliodeck-app/wiki/1.0-Getting-Started)
- [Installation](https://github.com/cliodeck/cliodeck-app/wiki/1.-ClioDeck-Installation)
- [The editor](https://github.com/cliodeck/cliodeck-app/wiki/1.16-The-Editor)
- [Books and chapters](https://github.com/cliodeck/cliodeck-app/wiki/1.15-Books-and-Chapters)
- [Brainstorm mode](https://github.com/cliodeck/cliodeck-app/wiki/1.11-Brainstorm-Mode-Guide)
- [Keyboard shortcuts](https://github.com/cliodeck/cliodeck-app/wiki/1.4-Keyboard-Shortcuts)
- [Zotero integration](https://github.com/cliodeck/cliodeck-app/wiki/1.5-Zotero-Integration-Guide)
- [Tropy integration](https://github.com/cliodeck/cliodeck-app/wiki/1.6-Tropy-Integration-Guide)
- [Obsidian vault](https://github.com/cliodeck/cliodeck-app/wiki/1.14-Obsidian-Vault-Guide)
- [Embedded LLM](https://github.com/cliodeck/cliodeck-app/wiki/1.7-Embedded-LLM-Guide)
- [Corpus analysis](https://github.com/cliodeck/cliodeck-app/wiki/1.8-Corpus-Analysis-Guide)
- [Journals and history](https://github.com/cliodeck/cliodeck-app/wiki/1.9-Journal-and-History)
- [Export presentations](https://github.com/cliodeck/cliodeck-app/wiki/1.10-Export-Presentations)
- [Word templates](https://github.com/cliodeck/cliodeck-app/wiki/1.3-Guide-for-Using-Word-Templates)

### Technical documentation
- [Release notes — RC3](https://github.com/cliodeck/cliodeck-app/wiki/3.3-RC3-Release-Notes)
- [Technical architecture](https://github.com/cliodeck/cliodeck-app/wiki/2.-Technical-Architecture)
- [Book architecture](docs/book-architecture.md) · [Editor architecture](docs/editor-architecture.md) · [Manuscript corpus](docs/manuscript-corpus.md)
- [Editor proposals contract](docs/editor-proposals.md) — how AI suggestions are adjudicated
- [ADR 0001](docs/adr/0001-rag-pipeline-arbitration.md) — RAG pipeline arbitration
- [AI usage journal](docs/journal-usage-ia.md) ([ADR 0007](docs/adr/0007-usage-journal-separate-db-and-provider-hook.md))
- [Status and remaining work](docs/status-and-remaining-work.md)

## Tech stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Electron 40, React 18, TypeScript, CodeMirror 6 / Lezer, Zustand, Vite |
| **Backend** | Node.js, better-sqlite3, hnswlib-node, pdfjs-dist, chokidar |
| **LLM layer** | Embedded (`node-llama-cpp`), Ollama, OpenAI-compatible, Anthropic, Mistral, Gemini (typed provider registry) |
| **Embeddings** | nomic-embed-text, mxbai-embed-large, Nomic Embed v2 (embedded), OpenAI / Mistral / Gemini embeddings |
| **MCP** | `@modelcontextprotocol/sdk` (server + clients) |
| **Export** | Pandoc / LaTeX, `docx`, RevealJS |
| **Analysis** | Python 3.11+, BERTopic (optional) |

The Markdown extensions written for the editor are kept as standalone packages under [`packages/`](packages/) — `@cliodeck/lezer-pandoc-citations` and `@cliodeck/lezer-footnotes` — so they can be reused outside ClioDeck. Not published to npm yet.

## Contributing

Issues and contributions are welcome on [GitHub](https://github.com/cliodeck/cliodeck-app/issues).
