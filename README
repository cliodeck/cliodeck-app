# ClioDeck - Writing Assistant for Historians

Desktop application (Electron + React + TypeScript) to assist historians in writing, with RAG (Retrieval-Augmented Generation) and Zotero/Tropy integrations.

> **Note:** ClioDeck is a [vibe-coding](https://en.wikipedia.org/wiki/Vibe_coding) experiment. It is provided *as is*, at your own risk. Designed by [Frédéric Clavert](https://inactinique.net), coded with [Claude Code](https://claude.ai/code). See my [talk on vibe-coding for historians](https://inactinique.net/prez/2025-07-03_DH-LLM/2025-07-03_DH-LLM.html#/title-slide) (French) and [ethics considerations](https://github.com/inactinique/cliodeck/wiki/4.-Ethics).

**License:** [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)

## Download

**[Download v1.0.0-rc.1 (macOS and Linux)](https://github.com/inactinique/cliodeck/releases/tag/v1.0.0-RC1)**

- **macOS**: DMG for Intel and Apple Silicon
- **Linux**: AppImage and .deb packages

## Key Features

- **RAG-powered Research Assistant** - Query your PDFs and primary sources using natural language with source citations
- **Zotero Integration** - Sync bibliography, download PDFs, manage tags and metadata
- **Tropy Integration** - Import and search primary sources with OCR support
- **WYSIWYG Markdown Editor** - Write with citation autocomplete (`@`) and footnotes
- **Corpus Analysis** - Knowledge graph, textometrics, topic modeling, similarity finder
- **Hybrid Search** - HNSW vectors + BM25 keywords with multilingual query expansion
- **Local-first** - All data stays on your machine; works offline with embedded LLM
- **Export** - PDF (via Pandoc/LaTeX) and Word with template support

## Quick Start

### 1. Install Ollama and models

```bash
# macOS
brew install ollama && brew services start ollama

# Linux
curl -fsSL https://ollama.ai/install.sh | sh
```

```bash
# Download required models
ollama pull nomic-embed-text
ollama pull gemma2:2b
```

### 2. Install ClioDeck

Download from [Releases](https://github.com/inactinique/cliodeck/releases) and run.

For detailed installation instructions, see:
- [macOS Installation Guide](https://github.com/inactinique/cliodeck/wiki/1.2-ClioDeck-Installation-‐-macOS)
- [Linux Installation Guide](https://github.com/inactinique/cliodeck/wiki/1.1-ClioDeck-Installation-‐-Linux)

### Build from source (developers)

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

### User Guides
- [Installation](https://github.com/inactinique/cliodeck/wiki/1.-ClioDeck-Installation) - Quick start
- [Keyboard Shortcuts](https://github.com/inactinique/cliodeck/wiki/1.4-Keyboard-Shortcuts) - Complete reference
- [Zotero Integration](https://github.com/inactinique/cliodeck/wiki/1.5-Zotero-Integration-Guide) - Bibliography sync
- [Tropy Integration](https://github.com/inactinique/cliodeck/wiki/1.6-Tropy-Integration-Guide) - Primary sources
- [Embedded LLM](https://github.com/inactinique/cliodeck/wiki/1.7-Embedded-LLM-Guide) - Offline mode
- [Corpus Analysis](https://github.com/inactinique/cliodeck/wiki/1.8-Corpus-Analysis-Guide) - Knowledge graph & textometrics
- [Export Options](https://github.com/inactinique/cliodeck/wiki/1.10-Export-Presentations) - PDF & Word

### Technical Documentation
- [Features Overview](https://github.com/inactinique/cliodeck/wiki/Features) - Complete feature list
- [Technical Architecture](https://github.com/inactinique/cliodeck/wiki/2.-Technical-Architecture) - RAG system design
- [Build Guide](https://github.com/inactinique/cliodeck/wiki/2.1-Build-and-Deployment-Guide) - Development setup

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Electron 28, React 18, TypeScript, Milkdown, Zustand, Vite |
| **Backend** | Node.js, better-sqlite3, hnswlib-node, pdfjs-dist |
| **AI/LLM** | Ollama (nomic-embed-text, gemma2:2b), embedded Qwen2.5 |
| **Analysis** | Python 3.11+, BERTopic (optional) |

## Contributing

Issues and contributions are welcome on [GitHub](https://github.com/inactinique/cliodeck/issues).
