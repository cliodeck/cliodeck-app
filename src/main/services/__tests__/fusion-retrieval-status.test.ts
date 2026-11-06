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
import type { ManuscriptMappedSearchResult } from '../retrieval-service.js';

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

// Retouches de #212 : la consigne d'échec total suit la langue des consignes,
// et le manuscrit garde son préambule quand seules les sources tombent.
describe('fusion chat : échec des sources (retouches #212)', () => {
  const ownHit: ManuscriptMappedSearchResult = {
    chunk: { id: 'm1', content: 'Mon chapitre soutient que la crise de 1929…', documentId: 'document.md', chunkIndex: 0 },
    document: { id: 'document.md', title: 'Mon article', author: null, bibtexKey: null },
    source: { kind: 'manuscript-chapter', relativePath: 'document.md', chapterId: 'document', line: 3 },
    similarity: 0.6,
    sourceType: 'manuscript',
  };

  const setup = (language: 'fr' | 'en', manuscriptEnabled: boolean): void => {
    vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
    vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, systemPromptLanguage: language } as ReturnType<typeof configManager.getRAGConfig>);
    vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue('missing-project');
    vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(manuscriptEnabled);
    vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
    vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
    vi.spyOn(retrievalService, 'describeDocuments').mockReturnValue([]);
  };

  const runTurn = async (language: 'fr' | 'en'): Promise<string> => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const webContents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } as unknown as WebContents;
    fusionChatService.start({
      webContents, messages: [{ role: 'user', content: 'question' }],
      systemPrompt: { language },
    });
    await vi.waitFor(() => expect(sent.some((event) => event.channel === 'fusion:chat:chunk' && (event.payload as { chunk: { done: boolean } }).chunk.done)).toBe(true));
    return state.messages[state.messages.length - 1].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  };

  it('dit l’échec total de la recherche dans la langue des consignes', async () => {
    setup('fr', false);
    vi.spyOn(retrievalService, 'searchWithStats').mockRejectedValue(new Error('index absent'));
    const fr = await runTurn('fr');
    expect(fr).toContain('La recherche dans les sources a échoué');
    expect(fr).not.toContain('source search failed');
    expect(await runTurn('en')).toContain('The source search failed');
  });

  it('garde le préambule « texte de l’utilisateur, jamais une source » quand seul le manuscrit répond', async () => {
    for (const [language, preamble] of [
      ['en', 'NEVER present them as the content of a source'],
      ['fr', 'ne les présente JAMAIS comme le contenu d\'une source'],
    ] as const) {
      setup(language, true);
      const corpus = (source: 'primary' | 'secondary' | 'manuscript', ok: boolean, hitCount: number) =>
        ({ source, attempted: true, ok, hitCount, selectedCount: hitCount });
      vi.spyOn(retrievalService, 'searchWithStats').mockResolvedValueOnce({
        hits: [], manuscriptHits: [ownHit], readingNoteHits: [], outcomes: [], securityEvents: [],
        stats: { search: { query: 'question', totalResults: 0, searchDurationMs: 1, cacheHit: false, sourceType: 'both', documents: [],
          corpora: [corpus('secondary', false, 0), corpus('primary', false, 0), corpus('manuscript', true, 1)] }, timing: { searchMs: 1 } },
      });
      const context = await runTurn(language);
      expect(context).toContain('[M1]');
      expect(context).toContain(preamble);
      expect(context.indexOf(preamble)).toBeLessThan(context.indexOf('[M1]'));
      vi.restoreAllMocks();
    }
  });
});
