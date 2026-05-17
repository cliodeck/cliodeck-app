import { describe, it, expect } from 'vitest';
import { hitsToSources, isFreeMode } from '../fusion-chat-service.js';
import type { MultiSourceSearchResult } from '../retrieval-service.js';
import { runChatTurn } from '../chat-engine.js';
import type {
  ChatChunk,
  ChatMessage,
  LLMProvider,
} from '../../../../backend/core/llm/providers/base.js';

function makeFakeProvider(chunks: ChatChunk[]): {
  provider: LLMProvider;
  seenMessages: ChatMessage[][];
} {
  const seenMessages: ChatMessage[][] = [];
  const provider = {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => ({ state: 'ready' }) as never,
    healthCheck: async () => ({ state: 'ready' }) as never,
    chat: async function* (msgs: ChatMessage[]) {
      seenMessages.push(msgs);
      for (const c of chunks) yield c;
    },
    complete: async () => '',
    dispose: async () => undefined,
  } as unknown as LLMProvider;
  return { provider, seenMessages };
}

describe('isFreeMode', () => {
  it('returns false for undefined / empty configs', () => {
    expect(isFreeMode(undefined)).toBe(false);
    expect(isFreeMode({})).toBe(false);
  });

  it('returns true when noPrompt flag is set', () => {
    expect(isFreeMode({ noPrompt: true })).toBe(true);
  });

  it('recognises the built-in free-mode id (and legacy "free" alias)', () => {
    expect(isFreeMode({ modeId: 'free-mode' })).toBe(true);
    expect(isFreeMode({ modeId: 'free' })).toBe(true);
  });

  it('returns false for any other modeId', () => {
    expect(isFreeMode({ modeId: 'summary' })).toBe(false);
  });
});

describe('fusion free-mode — chat-engine contract', () => {
  // Guards the engine-level invariant fusion-chat-service relies on for
  // free-mode: when the service passes `systemPrompt: undefined` (because
  // `isFreeMode` short-circuited hints + mode resolution), `runChatTurn`
  // must forward the user messages verbatim, with no leading system role.
  it('produces a message list without any system role', async () => {
    const { provider, seenMessages } = makeFakeProvider([
      { delta: 'hi', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ]);
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      // No systemPrompt, no retriever → free-mode analogue.
    });
    expect(seenMessages).toHaveLength(1);
    const roles = seenMessages[0].map((m) => m.role);
    expect(roles).toEqual(['user']);
    expect(roles).not.toContain('system');
  });

  it('does inject a system message when customText is provided (sanity check)', async () => {
    const { provider, seenMessages } = makeFakeProvider([
      { delta: 'hi', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ]);
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      systemPrompt: { customText: 'You are a historian.' },
    });
    const roles = seenMessages[0].map((m) => m.role);
    expect(roles[0]).toBe('system');
  });
});

describe('hitsToSources', () => {
  it('returns an empty array for empty input', () => {
    expect(hitsToSources([])).toEqual([]);
  });

  it('labels secondary hits as bibliographie', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'secondary',
        chunk: { id: 'c1', content: 'Hello world', documentId: 'd1', chunkIndex: 0 },
        document: { id: 'd1', title: 'Some Paper', author: 'X', bibtexKey: 'x2024' },
        similarity: 0.9,
      } as unknown as MultiSourceSearchResult,
    ];
    const out = hitsToSources(hits);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'bibliographie',
      sourceType: 'secondary',
      title: 'Some Paper',
      snippet: 'Hello world',
      similarity: 0.9,
    });
    expect(out[0].relativePath).toBeUndefined();
  });

  it('labels primary hits as archive', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'primary',
        chunk: { id: 'c2', content: 'Archive text', documentId: 'p1', chunkIndex: 0 },
        document: { id: 'p1', title: 'Lettre 1914', author: 'Foch', bibtexKey: null },
        source: undefined,
        similarity: 0.7,
      } as unknown as MultiSourceSearchResult,
    ];
    expect(hitsToSources(hits)[0].kind).toBe('archive');
  });

  it('labels vault hits as note and preserves relativePath', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'vault',
        chunk: { id: 'c3', content: 'Note content', documentId: 'n1', chunkIndex: 0 },
        document: { id: 'n1', title: 'My Note', author: null, bibtexKey: null },
        source: {
          kind: 'obsidian-note',
          relativePath: 'research/note1.md',
          noteId: 'n1',
        },
        similarity: 0.42,
      } as unknown as MultiSourceSearchResult,
    ];
    const out = hitsToSources(hits);
    expect(out[0].kind).toBe('note');
    expect(out[0].relativePath).toBe('research/note1.md');
    expect(out[0].title).toBe('My Note');
  });

  it('falls back to relativePath for title when document.title is missing', () => {
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'vault',
        chunk: { id: 'c4', content: 'body', documentId: 'n2', chunkIndex: 0 },
        document: { id: 'n2', title: undefined, author: null, bibtexKey: null },
        source: {
          kind: 'obsidian-note',
          relativePath: 'folder/untitled.md',
          noteId: 'n2',
        },
        similarity: 0.1,
      } as unknown as MultiSourceSearchResult,
    ];
    expect(hitsToSources(hits)[0].title).toBe('folder/untitled.md');
  });

  it('collapses whitespace and truncates snippet to 400 chars', () => {
    const content = 'alpha\n\nbeta   gamma\t\tdelta ' + 'x'.repeat(1000);
    const hits: MultiSourceSearchResult[] = [
      {
        sourceType: 'secondary',
        chunk: { id: 'c5', content, documentId: 'd', chunkIndex: 0 },
        document: { id: 'd', title: 'T', author: 'A', bibtexKey: null },
        similarity: 1,
      } as unknown as MultiSourceSearchResult,
    ];
    const snippet = hitsToSources(hits)[0].snippet;
    expect(snippet.length).toBe(400);
    expect(snippet.startsWith('alpha beta gamma delta')).toBe(true);
    expect(snippet).not.toMatch(/\s{2,}/);
  });
});
