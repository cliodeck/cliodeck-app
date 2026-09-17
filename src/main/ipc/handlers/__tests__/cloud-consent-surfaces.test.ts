/**
 * Consentement distant hors du chat (ADR 0005, dette n° 17).
 *
 * Recettes, diapositives et reclassement de la similarité construisaient leur
 * registre et envoyaient au LLM sans rien demander, ni dans le renderer ni
 * dans le main. Ces tests appellent les vrais handlers IPC avec un backend
 * distant et vérifient qu'aucun registre n'est construit — donc qu'aucun
 * envoi ne part — tant que l'utilisateur n'a pas accepté le dialogue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialogResponse: 0,
  showMessageBox: vi.fn(),
  llmConfig: { backend: 'claude', ollamaURL: 'http://127.0.0.1:11434' } as Record<string, unknown>,
  projectPath: '' as string,
  createRegistry: vi.fn(),
  llmComplete: vi.fn(async () => 'réponse'),
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() } };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: { showMessageBox: h.showMessageBox },
    BrowserWindow: {
      fromWebContents: () => win,
      getFocusedWindow: () => win,
      getAllWindows: () => [win],
    },
    app: { isPackaged: false, getPath: () => '/tmp' },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => h.llmConfig },
}));

vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));

vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: h.createRegistry,
}));

// Dépendances lourdes de fusion-handlers, sans rapport avec les recettes.
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined },
}));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));
vi.mock('../../../services/slides-generation-service.js', () => ({
  slidesGenerationService: {
    setLLMProvider: vi.fn(),
    generateSlides: vi.fn(async () => '# Diapositive'),
    cancelGeneration: vi.fn(),
  },
}));
vi.mock('../../../services/revealjs-export.js', () => ({ generatePreviewHtml: vi.fn() }));

import { cloudConsent } from '../../../../../backend/security/cloud-consent.js';
import { similarityService } from '../../../services/similarity-service.js';
import { setupSlidesHandlers } from '../slides-handlers.js';
import { setupSimilarityHandlers } from '../similarity-handlers.js';
import { setupFusionHandlers } from '../fusion-handlers.js';

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };

function invoke(channel: string, ...args: unknown[]): Promise<{ success: boolean; error?: string }> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler absent : ${channel}`);
  return fn(event, ...args) as Promise<{ success: boolean; error?: string }>;
}

function lastDialogDetail(): string {
  const call = h.showMessageBox.mock.calls.at(-1);
  return (call?.[1] as { detail: string }).detail;
}

setupSlidesHandlers();
setupSimilarityHandlers();
setupFusionHandlers();

beforeEach(() => {
  cloudConsent.revoke();
  h.llmConfig = { backend: 'claude', ollamaURL: 'http://127.0.0.1:11434' };
  h.dialogResponse = 0;
  h.showMessageBox.mockReset();
  h.showMessageBox.mockImplementation(async () => ({ response: h.dialogResponse }));
  h.createRegistry.mockReset();
  h.createRegistry.mockImplementation(() => ({
    getLLM: () => ({ model: 'fake', complete: h.llmComplete, chat: vi.fn() }),
    dispose: async () => undefined,
  }));
  h.llmComplete.mockClear();
});

describe('slides:generate — consentement distant', () => {
  it('refuse sans rien envoyer quand le dialogue est annulé', async () => {
    const res = await invoke('slides:generate', { text: 'Mon chapitre', language: 'fr' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Anthropic Claude');
    expect(h.createRegistry).not.toHaveBeenCalled();
    expect(lastDialogDetail()).toContain('diapositives');
  });

  it('génère une fois le dialogue accepté, et ne redemande pas pendant la session', async () => {
    h.dialogResponse = 1;
    expect((await invoke('slides:generate', { text: 'Mon chapitre', language: 'fr' })).success).toBe(true);
    expect((await invoke('slides:generate', { text: 'Mon chapitre', language: 'fr' })).success).toBe(true);

    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    expect(h.createRegistry).toHaveBeenCalledTimes(2);
  });

  it('ne demande rien avec un Ollama local', async () => {
    h.llmConfig = { backend: 'ollama', ollamaURL: 'http://127.0.0.1:11434' };
    expect((await invoke('slides:generate', { text: 'Mon chapitre', language: 'fr' })).success).toBe(true);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it('traite un Ollama distant comme un service distant', async () => {
    h.llmConfig = { backend: 'ollama', ollamaURL: 'http://gpu.labo.example:11434' };
    const res = await invoke('slides:generate', { text: 'Mon chapitre', language: 'fr' });
    expect(res.success).toBe(false);
    expect(h.createRegistry).not.toHaveBeenCalled();
  });
});

describe('similarity:analyze — consentement distant', () => {
  beforeEach(() => {
    h.projectPath = '/projet';
    vi.spyOn(similarityService, 'analyzeDocument').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuse le reclassement (actif par défaut) sans consentement', async () => {
    const res = await invoke('similarity:analyze', 'Un paragraphe.', {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('reclassement');
    expect(h.createRegistry).not.toHaveBeenCalled();
    expect(similarityService.analyzeDocument).not.toHaveBeenCalled();
    expect(lastDialogDetail()).toContain('passage analysé');
  });

  it('analyse une fois le dialogue accepté', async () => {
    h.dialogResponse = 1;
    const res = await invoke('similarity:analyze', 'Un paragraphe.', {});
    expect(res.success).toBe(true);
    expect(similarityService.analyzeDocument).toHaveBeenCalledTimes(1);
  });

  it('ne demande rien quand le reclassement est désactivé : rien ne part au LLM', async () => {
    const res = await invoke('similarity:analyze', 'Un paragraphe.', { useReranking: false });
    expect(res.success).toBe(true);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('fusion:recipes:run — consentement distant', () => {
  let tmp = '';

  function writeRecipe(fileName: string, kind: 'brainstorm' | 'export'): void {
    const dir = path.join(tmp, '.cliodeck', 'recipes');
    fs.mkdirSync(dir, { recursive: true });
    const withBlock = kind === 'brainstorm' ? '      prompt: Des pistes sur {{ inputs.sujet }}\n' : '      format: pdf\n';
    fs.writeFileSync(
      path.join(dir, fileName),
      `name: essai\nversion: 0.1.0\ndescription: essai\ninputs:\n  sujet:\n    type: string\n    required: true\nsteps:\n  - id: etape\n    kind: ${kind}\n    with:\n${withBlock}`
    );
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-consent-recipe-'));
    h.projectPath = tmp;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuse une recette à étape LLM sans rien envoyer', async () => {
    writeRecipe('llm.yaml', 'brainstorm');
    const res = await invoke('fusion:recipes:run', 'user', 'llm.yaml', { sujet: 'Schuman' });

    expect(res.success).toBe(false);
    expect(h.createRegistry).not.toHaveBeenCalled();
    expect(h.llmComplete).not.toHaveBeenCalled();
    expect(lastDialogDetail()).toContain('recette');
  });

  it('exécute la recette une fois le dialogue accepté', async () => {
    writeRecipe('llm.yaml', 'brainstorm');
    h.dialogResponse = 1;
    const res = await invoke('fusion:recipes:run', 'user', 'llm.yaml', { sujet: 'Schuman' });

    expect(res.success).toBe(true);
    expect(h.llmComplete).toHaveBeenCalledTimes(1);
  });

  it('ne demande rien pour une recette sans étape LLM', async () => {
    writeRecipe('export.yaml', 'export');
    const res = await invoke('fusion:recipes:run', 'user', 'export.yaml', { sujet: 'Schuman' });

    expect(res.success).toBe(true);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });
});
