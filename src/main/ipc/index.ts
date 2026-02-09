/**
 * IPC Handlers Entry Point
 *
 * Centralizes registration of all IPC handlers organized by domain.
 * This replaces the monolithic handlers.ts file with a modular architecture.
 */

import { setupConfigHandlers } from './handlers/config-handlers.js';
import { setupProjectHandlers } from './handlers/project-handlers.js';
import { setupPDFHandlers } from './handlers/pdf-handlers.js';
import { setupChatHandlers } from './handlers/chat-handlers.js';
import { setupBibliographyHandlers } from './handlers/bibliography-handlers.js';
import { setupEditorHandlers } from './handlers/editor-handlers.js';
import { setupFilesystemHandlers } from './handlers/filesystem-handlers.js';
import { setupZoteroHandlers } from './handlers/zotero-handlers.js';
import { setupExportHandlers } from './handlers/export-handlers.js';
import { setupCorpusHandlers } from './handlers/corpus-handlers.js';
import { setupHistoryHandlers } from './handlers/history-handlers.js';
import { setupModeHandlers } from './handlers/mode-handlers.js';
import { setupTopicModelingHandlers } from './handlers/topic-modeling-handlers.js';
import { setupEmbeddedLLMHandlers } from './handlers/embedded-llm-handlers.js';
import { setupSimilarityHandlers } from './handlers/similarity-handlers.js';
import { setupTropyHandlers } from './handlers/tropy-handlers.js';

/**
 * Setup all IPC handlers
 *
 * Registers handlers for:
 * - Configuration and Ollama (5 handlers)
 * - Project management (8 handlers)
 * - PDF indexing and search (7 handlers)
 * - Chat and RAG (2 handlers)
 * - Bibliography (3 handlers)
 * - Editor operations (3 handlers)
 * - Filesystem and dialogs (7 handlers)
 * - Zotero integration (3 handlers)
 * - Export (PDF + RevealJS) (3 handlers)
 * - Corpus analysis and knowledge graph (7 handlers)
 * - History and session tracking (7 handlers)
 * - Embedded LLM management (10 handlers)
 * - Similarity finder (5 handlers)
 *
 * Total: 68 IPC handlers
 */
export function setupIPCHandlers() {
  console.log('🔧 Setting up modular IPC handlers...');

  // Register all handler modules
  setupConfigHandlers();
  setupProjectHandlers();
  setupPDFHandlers();
  setupChatHandlers();
  setupBibliographyHandlers();
  setupEditorHandlers();
  setupFilesystemHandlers();
  setupZoteroHandlers();
  setupExportHandlers();
  setupCorpusHandlers();
  setupHistoryHandlers();
  setupModeHandlers();
  setupTopicModelingHandlers();
  setupEmbeddedLLMHandlers();
  setupSimilarityHandlers();
  setupTropyHandlers();

  console.log('✅ All IPC handlers registered successfully');
}
