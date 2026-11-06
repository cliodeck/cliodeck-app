import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const state = vi.hoisted(() => ({ messages: [] as Array<Array<{ role: string; content: string }>> }));

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({
        id: 'fake', name: 'Fake', capabilities: { chat: true, streaming: true, tools: false },
        chat: async function* (messages: Array<{ role: string; content: string }>) {
          state.messages.push(messages);
          yield { delta: 'answer', done: false };
          yield { delta: '', done: true, finishReason: 'stop' };
        },
      }),
      dispose: async () => undefined,
    }),
  };
});

import { fusionChatService } from '../fusion-chat-service.js';
import { configManager } from '../config-manager.js';
import { projectManager } from '../project-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';

afterEach(() => { vi.restoreAllMocks(); state.messages.length = 0; });

describe('fusion chat retrieval status', () => {
  it('sends empty and partial-failure results to the model and renderer', async () => {
    vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, systemPromptLanguage: 'en' } as ReturnType<typeof configManager.getRAGConfig>);
    vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue('missing-project');
    vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
    vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
    vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
    vi.spyOn(retrievalService, 'describeDocuments').mockReturnValue([]);

    const search = vi.spyOn(retrievalService, 'searchWithStats');
    const corpus = (ok: boolean, source: 'primary' | 'secondary') => ({ source, attempted: true, ok, hitCount: 0, selectedCount: 0 });
    const run = async (failed: boolean) => {
      const corpora = [corpus(true, 'secondary'), corpus(!failed, 'primary')];
      search.mockResolvedValueOnce({ hits: [], manuscriptHits: [], readingNoteHits: [], outcomes: [], securityEvents: [],
        stats: { search: { query: 'question', totalResults: 0, searchDurationMs: 1, cacheHit: false, sourceType: 'both', documents: [], corpora }, timing: { searchMs: 1 } },
      });
      const sent: Array<{ channel: string; payload: unknown }> = [];
      const webContents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } as unknown as WebContents;
      fusionChatService.start({ webContents, messages: [{ role: 'user', content: 'question' }], systemPrompt: { language: 'en' } });
      await vi.waitFor(() => expect(sent.some((event) => event.channel === 'fusion:chat:chunk' && (event.payload as { chunk: { done: boolean } }).chunk.done)).toBe(true));
      return sent;
    };
    const empty = await run(false);
    expect(empty.filter((event) => event.channel === 'fusion:chat:chunk')).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ error: expect.anything() }) }));
    expect(state.messages[0].some((m) => m.content.includes('No excerpt'))).toBe(true);
    expect(empty.find((event) => event.channel === 'fusion:chat:explanation')?.payload).toMatchObject({ explanation: { search: { retrievalStatus: 'empty' } } });
    const partial = await run(true);
    expect(state.messages[1].some((m) => m.content.includes('searches failed'))).toBe(true);
    expect(partial.find((event) => event.channel === 'fusion:chat:explanation')?.payload).toMatchObject({ explanation: { search: { retrievalStatus: 'partial' } } });
    const recovered = await run(false);
    expect(state.messages[2].some((m) => m.content.includes('searches failed'))).toBe(false);
    expect(recovered.find((event) => event.channel === 'fusion:chat:explanation')?.payload).toMatchObject({ explanation: { search: { retrievalStatus: 'empty' } } });
  });
});
