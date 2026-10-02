import { describe, it, expect } from 'vitest';
import {
  formatContextAsSystemPrompt,
  formatManuscriptContext,
  formatReadingNotesContext,
  formatSelectionScope,
  hitsToSources,
  isFreeMode,
  readingNoteHitsToSources,
  resolvePromptLanguage,
  resolveTurnOptions,
  shouldIncludeReadingNotes,
} from '../fusion-chat-service.js';
import type {
  ManuscriptMappedSearchResult,
  ReadingNoteMappedSearchResult,
} from '../retrieval-service.js';
import type { LLMConfig } from '../../../../backend/types/config.js';
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

describe('notes de lecture dans le chat', () => {
  const hit: ReadingNoteMappedSearchResult = {
    chunk: { id: 'n-0', content: 'La longue  durée\nécrase l’événement.', documentId: 'zotero:ABCD1234', chunkIndex: 0 },
    document: { id: 'zotero:ABCD1234', title: 'La Méditerranée', author: null, bibtexKey: 'Braudel_1949' },
    source: {
      kind: 'reading-note',
      relativePath: 'reading-notes/Braudel_1949.md',
      noteId: 'zotero:ABCD1234',
      citekey: 'Braudel_1949',
      zoteroKey: 'ABCD1234',
      tags: ['chapitre-2'],
      line: 9,
    },
    similarity: 0.7,
    sourceType: 'readingNotes',
  };

  it('exclut les notes d’un fournisseur distant sans consentement, jamais d’un local', () => {
    expect(shouldIncludeReadingNotes({ enabled: true, isCloud: false, cloudConsent: false })).toBe(true);
    expect(shouldIncludeReadingNotes({ enabled: true, isCloud: true, cloudConsent: false })).toBe(false);
    expect(shouldIncludeReadingNotes({ enabled: true, isCloud: true, cloudConsent: true })).toBe(true);
    expect(shouldIncludeReadingNotes({ enabled: false, isCloud: false, cloudConsent: true })).toBe(false);
  });

  it('nomme la référence commentée et garde de quoi rouvrir la note', () => {
    expect(readingNoteHitsToSources([hit])).toEqual([
      {
        kind: 'lecture',
        sourceType: 'readingNotes',
        title: '@Braudel_1949 — La Méditerranée',
        snippet: 'La longue durée écrase l’événement.',
        similarity: 0.7,
        relativePath: 'reading-notes/Braudel_1949.md',
        notePath: 'reading-notes/Braudel_1949.md',
        lineNumber: 9,
      },
    ]);
  });

  it('présente les notes au modèle comme le commentaire de l’auteur, pas comme la source', () => {
    const block = formatReadingNotesContext([hit]);
    expect(block).toContain('NOTES DE LECTURE');
    expect(block).toContain("N'attribue JAMAIS leur contenu à l'ouvrage commenté");
    expect(block).toContain('[L1] @Braudel_1949 — La Méditerranée');
    expect(block).toContain('ÉTIQUETTES : chapitre-2');
    expect(formatReadingNotesContext([])).toBe('');
  });
});

describe('sélection de documents et manuscrit — ne pas prendre l’un pour l’autre', () => {
  const own: ManuscriptMappedSearchResult = {
    chunk: { id: 'm1', content: 'Mon article soutient que…', documentId: 'document.md', chunkIndex: 0 },
    document: { id: 'document.md', title: 'Mon article', author: null, bibtexKey: null },
    source: { kind: 'manuscript-chapter', relativePath: 'document.md', chapterId: 'document', line: 3 },
    similarity: 0.6,
    sourceType: 'manuscript',
  };

  it('nomme au modèle le document auquel la recherche est limitée', () => {
    const scope = formatSelectionScope(1, [
      { title: 'La Méditerranée', author: 'Braudel', year: '1949' },
    ]);
    expect(scope).toContain('un seul document');
    expect(scope).toContain('« La Méditerranée » (Braudel, 1949)');
    expect(scope).toContain('jamais de son propre manuscrit');
  });

  it('ne dit rien sans sélection, et donne le compte quand la liste serait longue ou incomplète', () => {
    expect(formatSelectionScope(0, [])).toBe('');
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `Titre ${i}` }));
    const scope = formatSelectionScope(8, many);
    expect(scope).toContain('8 documents');
    expect(scope).not.toContain('Titre 0');
    // Un document introuvable en base : pas de liste tronquée qui mentirait.
    expect(formatSelectionScope(2, [{ title: 'Seul retrouvé' }])).not.toContain('Seul retrouvé');
  });

  it('compte et nomme l’ouvrage une fois quand il a plusieurs pièces jointes', () => {
    const book = { title: 'La Méditerranée', author: 'Braudel', year: '1949' };
    const scope = formatSelectionScope(2, [book, { ...book }]);
    expect(scope).toContain('un seul document');
    expect(scope.match(/La Méditerranée/g)).toHaveLength(1);
  });

  it('écrit les consignes dans la langue demandée, pas seulement en français', () => {
    const scope = formatSelectionScope(1, [{ title: 'La Méditerranée' }], 'en');
    expect(scope).toContain('SCOPE: the user has restricted this search to a single document');
    expect(scope).toContain('never their own manuscript');
    expect(formatManuscriptContext([own], 0, 'en')).toContain('MANUSCRIPT IN PROGRESS');
    expect(formatContextAsSystemPrompt([], 'en')).toContain('No excerpt from the searched sources');
    const sources = formatContextAsSystemPrompt(
      [
        {
          sourceType: 'secondary',
          chunk: { id: 'c1', content: 'Hello', documentId: 'd1', chunkIndex: 0 },
          document: { id: 'd1', title: 'Some Paper', author: 'X' },
          similarity: 0.9,
        } as unknown as MultiSourceSearchResult,
      ],
      'en'
    );
    expect(sources).toContain('RULE: answer ONLY from the sources below');
    // Étiquettes de champ inchangées : les prompts système anglais les nomment ainsi.
    expect(sources).toContain('TITRE : Some Paper');
    expect(sources).not.toContain('RÈGLE');
  });

  it('choisit la langue demandée, puis celle des réglages, puis le français', () => {
    expect(resolvePromptLanguage('en', 'fr')).toBe('en');
    expect(resolvePromptLanguage(undefined, 'en')).toBe('en');
    expect(resolvePromptLanguage(undefined, undefined)).toBe('fr');
    expect(resolvePromptLanguage('de', 'en')).toBe('en');
  });

  it('présente le manuscrit comme le texte de l’utilisateur, pas « de l’auteur »', () => {
    const block = formatManuscriptContext([own], 2);
    expect(block).toContain("le texte que l'utilisateur est lui-même en train d'écrire");
    expect(block).not.toContain("texte de l'auteur");
    expect(block).toContain('[M3] Mon article');
    expect(formatManuscriptContext([], 0)).toBe('');
  });

  it('sans extrait de source, n’annonce pas des « sources ci-dessous » devant le seul manuscrit', () => {
    const block = formatContextAsSystemPrompt([]);
    expect(block).toContain('Aucun extrait des sources');
    expect(block).not.toContain('UNIQUEMENT');
  });
});

describe('resolveTurnOptions — ce qui est propre à Ollama reste chez Ollama', () => {
  const ollama: LLMConfig = {
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:11434',
    ollamaEmbeddingModel: 'nomic-embed-text',
    ollamaChatModel: 'qwen3.5:35b',
    ollamaNumCtx: 262_144,
  };
  const opts = {
    temperature: 0.1,
    maxTokens: 512,
    numCtx: 1_000_000,
    topP: 0.85,
    topK: 40,
    repeatPenalty: 1.1,
    think: false,
  };

  it('transmet tout à la génération Ollama locale, fenêtre du panneau en tête', () => {
    expect(resolveTurnOptions(ollama, opts)).toEqual(opts);
  });

  it('retombe sur llm.ollamaNumCtx des réglages quand le panneau ne fixe rien', () => {
    const { numCtx: _omit, ...rest } = opts;
    expect(resolveTurnOptions(ollama, rest).numCtx).toBe(262_144);
    // 0 / hors bornes dans les réglages → défaut du serveur.
    expect(resolveTurnOptions({ ...ollama, ollamaNumCtx: 0 }, rest).numCtx).toBeUndefined();
  });

  it('ne laisse pas une fenêtre Ollama piloter le compacteur d’un backend cloud', () => {
    const claude: LLMConfig = { ...ollama, backend: 'claude', claudeAPIKey: 'k', claudeModel: 'claude-sonnet-4-6' };
    const r = resolveTurnOptions(claude, opts);
    expect(r.numCtx).toBeUndefined();
    expect(r.topP).toBeUndefined();
    expect(r.topK).toBeUndefined();
    expect(r.repeatPenalty).toBeUndefined();
    expect(r.think).toBeUndefined();
    // La température vaut pour tous.
    expect(r.temperature).toBe(0.1);
    expect(r.maxTokens).toBe(512);
  });

  it('traite le modèle embarqué comme un fournisseur non-Ollama', () => {
    const embedded: LLMConfig = {
      ...ollama,
      generationProvider: 'embedded',
      embeddedModelPath: '/models/q.gguf',
    };
    expect(resolveTurnOptions(embedded, opts).numCtx).toBeUndefined();
  });
});
