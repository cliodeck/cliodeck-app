/**
 * Unified chat message type shared by the RAG ChatInterface and the
 * Brainstorm surface. Stores keep their richer domain types; they adapt
 * down to UnifiedMessage at the render boundary.
 */
export interface UnifiedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  pending?: boolean;
  isError?: boolean;
  /** Optional label shown next to role (e.g. active mode name). */
  badge?: string;
}
