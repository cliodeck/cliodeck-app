# Changelog

All notable changes to ClioDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.2] - 2025-01-20

### Added

#### Zotero Integration
- **Bidirectional sync** with Zotero library - detect additions, modifications, and deletions
- **Three conflict resolution strategies**: Remote Wins, Local Wins, Manual selection
- **Zotero groups support** for shared libraries
- **Collections filtering** for targeted RAG queries
- **Batch PDF download** from Zotero attachments

#### Bibliography Management
- **Bibliography statistics dashboard** with 4 interactive tabs (Overview, Authors, Publications, Timeline)
- **Tags and metadata system** with custom fields support
- **BibTeX export** with full metadata preservation
- **Orphan PDF detection and cleanup** with archive option (safe) or delete (permanent)
- **Modified PDF detection** with MD5 hash comparison and re-indexation prompts

#### Editor
- **Milkdown WYSIWYG editor** replaces Monaco Editor for better markdown editing experience
- **Toggle between WYSIWYG and raw markdown** modes
- **Improved footnote styling** in both dark and light themes

#### Vector Store & RAG
- **Enhanced vector store** with improved chunking strategies
- **Zotero collections integration** for refined RAG queries
- **Embedding strategy selector** (nomic-fallback, mxbai-only, custom)

#### UI/UX
- **Project opening progress indicator**
- **Unified bibliography panel** (removed separate PDFs tab - all PDF management through Zotero workflow)
- **Improved light theme** CSS fixes

### Changed

- **Renamed ClioDesk to ClioDeck** throughout the project
- **Relative paths** in project.json files for better portability
- **Updated AI models** configuration
- **Improved translations** for French, English, and German

### Fixed

- Multiple Zotero collections synchronization bugs
- Milkdown light theme rendering issues
- Document re-indexation for already indexed files
- CSS issues in light mode
- BERTopic installation process
- Various bibliography management bugs

## [1.0.0-beta.1] - 2024-12-XX

### Added

- Initial beta release
- RAG-powered research assistant
- Zotero integration (import)
- PDF indexing and semantic search
- Ollama and Claude LLM support
- Embedded Qwen model option
- Project management (Article, Book, Presentation)
- PDF and Word export
- Dark/Light theme support
- French, English, German localization
