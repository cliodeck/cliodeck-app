/**
 * @deprecated — stores merged into `chatStore` (fusion step 4b).
 * Kept as a re-export for one release so external imports keep working.
 * Remove at step 5.
 */
export {
  useChatStore as useBrainstormChatStore,
  useChatStore,
} from './chatStore';
export type {
  BrainstormMessage,
  BrainstormSource,
  BrainstormToolCall,
  BrainstormChatSettings,
  BrainstormChatRetrievalSettings,
} from './chatStore';
