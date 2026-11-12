/**
 * Un corpus vide n'est pas un corpus en échec (P212-F).
 *
 * Sur un projet neuf, sans aucun PDF, avec des embeddings qui répondent, une
 * question au chat marquait « Bibliographie échec » ; depuis #212, la bande
 * « Certaines recherches ont échoué » et la consigne d'échec au modèle
 * suivaient. L'historien qui commence un projet voyait une panne à chaque
 * question.
 *
 * Vrai `retrievalService`, vrai `EnhancedVectorStore` sur un vrai projet vide,
 * vrais magasins du coffre, du manuscrit et des notes de lecture sur le même
 * `brain.db` ; seuls les fournisseurs (embeddings, modèle) sont simulés. Le
 * témoin : des embeddings qui lèvent restent un échec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { WebContents } from 'electron';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const state = vi.hoisted(() => ({
  messages: [] as Array<Array<{ role: string; content: string }>>,
  embedFails: false,
}));

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
      getEmbedding: () => ({
        id: 'fake-embed:corpus-vide',
        embed: async (texts: string[]) => {
          if (state.embedFails) throw new Error('Ollama embeddings: connexion refusée');
          return texts.map(() => Array(768).fill(0.1));
        },
      }),
      dispose: async () => undefined,
    }),
  };
});

import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { fusionChatService } from '../fusion-chat-service.js';
import { configManager } from '../config-manager.js';
import { projectManager } from '../project-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';
import { ObsidianVaultStore } from '../../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { ManuscriptStore } from '../../../../backend/core/vector-store/ManuscriptStore.js';

let project = '';
let store: EnhancedVectorStore | null = null;
/** Chaque question est neuve : le cache d'embeddings du module ne doit pas répondre à la place du fournisseur. */
let turn = 0;
const question = (): string => `question ${++turn} sur la crise de 1929`;

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-corpus-vide-'));
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, similarityThreshold: 0.12, systemPromptLanguage: 'en' } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue(project);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
  store = new EnhancedVectorStore(project);
  await store.initialize();
  retrievalService.configure({ vectorStore: store, workspaceRoot: project });
});

afterEach(() => {
  retrievalService.clear();
  manuscriptIndexService.clear();
  store?.close();
  store = null;
  vi.restoreAllMocks();
  state.messages.length = 0;
  state.embedFails = false;
  fs.rmSync(project, { recursive: true, force: true });
});

const outcomeOf = async (q: Parameters<typeof retrievalService.search>[0]) =>
  Object.fromEntries((await retrievalService.search(q)).outcomes.map((o) => [o.source, o]));

async function chatTurn(): Promise<{ status: unknown; prompt: string }> {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const webContents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } as unknown as WebContents;
  fusionChatService.start({ webContents, messages: [{ role: 'user', content: question() }], systemPrompt: { language: 'en' } });
  await vi.waitFor(() => expect(sent.some((event) => event.channel === 'fusion:chat:chunk' && (event.payload as { chunk: { done: boolean } }).chunk.done)).toBe(true));
  const explanation = sent.find((event) => event.channel === 'fusion:chat:explanation')?.payload as
    | { explanation: { search: { retrievalStatus?: unknown } } }
    | undefined;
  return {
    status: explanation?.explanation.search.retrievalStatus,
    prompt: state.messages[state.messages.length - 1].map((m) => m.content).join('\n'),
  };
}

describe.skipIf(!sqliteAvailable)('un corpus vide n’est pas un corpus en échec (P212-F)', () => {
  it('projet sans PDF, embeddings qui répondent : la bibliographie est vide, pas en échec', async () => {
    const map = await outcomeOf({ query: question(), sourceType: 'secondary' });
    expect(map.secondary).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(map.secondary.error).toBeUndefined();
  });

  it('coffre, manuscrit et notes de lecture vides : aucun n’est en échec', async () => {
    vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(true);
    const map = await outcomeOf({
      query: question(),
      sourceType: 'both',
      includeVault: true,
      includeManuscript: true,
      includeReadingNotes: true,
    });
    for (const source of ['secondary', 'primary', 'vault', 'manuscript', 'readingNotes']) {
      expect(map[source], source).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    }
  });

  it('au chat : statut « vide », et aucune consigne d’échec au modèle', async () => {
    const { status, prompt } = await chatTurn();
    expect(status).toBe('empty');
    expect(prompt).toContain('No excerpt');
    expect(prompt).not.toContain('searches failed');
  });

  it('témoin : des embeddings qui lèvent restent un échec de la bibliographie', async () => {
    state.embedFails = true;
    const map = await outcomeOf({ query: question(), sourceType: 'secondary' });
    expect(map.secondary).toMatchObject({ attempted: true, ok: false });
    expect(map.secondary.error).toContain('connexion refusée');

    const { status, prompt } = await chatTurn();
    // Tropy, absent, répond sans embarquer : la bibliographie seule tombe.
    expect(status).toBe('partial');
    expect(prompt).toContain('searches failed');
  });
});

/**
 * L'inverse, pour le coffre et le manuscrit (S04-1-3, étape 5 de L06-9) : leur magasin, sur un
 * brain.db qui existe mais ne s'ouvre pas (base abîmée, verrou), rendait `null` après un
 * avertissement à la console. Le corpus passait alors pour vide : « Vault 0 », « Manuscrit 0 ».
 * L'ouverture qui échoue est simulée au premier accès du magasin à sa base (`initSchema`).
 */
describe.skipIf(!sqliteAvailable)('un magasin qui ne s’ouvre pas est en échec, pas vide (S04-1-3)', () => {
  const malformed = (): never => {
    throw new Error('SQLITE_CORRUPT: database disk image is malformed');
  };

  it('coffre illisible : « vault » en échec, avec la cause', async () => {
    vi.spyOn(ObsidianVaultStore.prototype as unknown as { initSchema(): void }, 'initSchema').mockImplementation(malformed);
    const map = await outcomeOf({ query: question(), sourceType: 'secondary', includeVault: true });
    expect(map.vault).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map.vault.error).toContain('database disk image is malformed');
    expect(map.secondary).toMatchObject({ attempted: true, ok: true });
  });

  it('manuscrit illisible : « manuscript » en échec, avec la cause', async () => {
    vi.spyOn(ManuscriptStore.prototype as unknown as { initSchema(): void }, 'initSchema').mockImplementation(malformed);
    const map = await outcomeOf({ query: question(), sourceType: 'secondary', includeManuscript: true });
    expect(map.manuscript).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map.manuscript.error).toContain('database disk image is malformed');
  });

  it('témoin : sans brain.db, coffre et manuscrit restent vides, pas en échec', async () => {
    retrievalService.configure({ vectorStore: store as EnhancedVectorStore, workspaceRoot: path.join(project, 'ailleurs') });
    const vault = vi.spyOn(ObsidianVaultStore.prototype as unknown as { initSchema(): void }, 'initSchema');
    const map = await outcomeOf({ query: question(), sourceType: 'secondary', includeVault: true, includeManuscript: true });
    expect(map.vault).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(map.manuscript).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(vault).not.toHaveBeenCalled();
  });
});
