/**
 * IPC Handlers Entry Point
 *
 * Centralizes registration of all IPC handlers organized by domain.
 * This replaces the monolithic handlers.ts file with a modular architecture.
 */
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
export declare function setupIPCHandlers(): void;
