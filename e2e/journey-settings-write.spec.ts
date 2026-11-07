/**
 * Enregistrer n'écrit que ce qui a changé, Réinitialiser écrit vraiment, et une révocation n'est
 * plus annulée par un masque. Jugé sur le disque : `cliodeck-config.json` et `cliodeck-secrets.json`
 * du userData temporaire, avec l'interface réelle et le trousseau simulé (`launchApp`).
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';
import { textPdf } from './_helpers/text-pdf';

/** Personne n'écoute ici : pas de vrai Ollama dans ces tests. */
const NO_OLLAMA = 'http://127.0.0.1:9';

type Config = Record<string, Record<string, unknown>>;

/** Une configuration d'auteur, avec tout ce que les valeurs par défaut n'ont pas. */
const AUTHOR = {
  language: 'fr',
  recentProjects: [],
  rag: {
    topK: 7,
    similarityThreshold: 0.33,
    chunkingConfig: 'large',
    useSemanticChunking: true,
    systemPromptLanguage: 'en',
    readingNotesCloudConsent: true,
  },
  llm: {
    backend: 'ollama',
    ollamaURL: NO_OLLAMA,
    ollamaEmbeddingModel: 'bge-m3',
    ollamaEmbeddingNumCtx: 4096,
    ollamaChatModel: 'qwen3:14b',
    ollamaNumCtx: 16384,
    generationProvider: 'embedded',
    embeddingProvider: 'embedded',
    embeddedEmbeddingModelId: 'nomic-embed-text-v2',
    embeddedEmbeddingModelPath: '/modeles/absent.gguf',
  },
  editor: { fontSize: 15, theme: 'light', wordWrap: true, showMinimap: true, fontFamily: 'serif', engine: 'cm6' },
  zotero: { mode: 'local', userId: '12345', dataDirectory: '/zotero' },
};

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userData(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-reglages-'));
  toClean.push(dir);
  writeFileSync(join(dir, 'cliodeck-config.json'), JSON.stringify(config));
  return dir;
}

const configPath = (dir: string) => join(dir, 'cliodeck-config.json');
const readConfig = (dir: string) => JSON.parse(readFileSync(configPath(dir), 'utf8')) as Config;

async function launch(dir: string): Promise<{ app: ElectronApplication; window: Page } | null> {
  const outcome = await launchApp({ userDataDir: dir });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return null;
  }
  await expect(outcome.value.window.locator('#root')).toBeVisible({ timeout: 20_000 });
  return outcome.value;
}

async function openSettings(window: Page): Promise<void> {
  // Même événement que le raccourci du menu.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-settings-modal')));
  await expect(window.locator('#settings-modal-title')).toBeVisible({ timeout: 15_000 });
}

const section = (window: Page, name: string) =>
  window.locator('.settings-modal').getByRole('button', { name, exact: true }).click();
/** Le champ numérique de la police : `first()` seul prendrait celui d'une section ouverte au-dessus. */
const fontField = (window: Page) => window.locator('.settings-modal input[type="number"][max="24"]');
const save = (window: Page, title = 'Sauvegarder') => window.locator(`.settings-modal button[title="${title}"]`).click();
const reset = (window: Page, title = 'Réinitialiser') => window.locator(`.settings-modal button[title="${title}"]`).click();
const saved = (window: Page) => window.locator('.save-message.success');
const failed = (window: Page) => window.locator('.save-message.error');
const question = (window: Page) => window.locator('.confirm-dialog');

/** Ouvre la section Éditeur et attend que la police du disque soit affichée : le panneau a chargé. */
async function openEditorSection(window: Page, fontSize: number, name = 'Éditeur'): Promise<void> {
  await section(window, name);
  await expect(fontField(window)).toHaveValue(String(fontSize));
}

test('une langue choisie, puis une police : Sauvegarder ne ramène pas l’ancienne langue', async () => {
  const dir = userData({ ...AUTHOR, rag: { ...AUTHOR.rag, systemPromptLanguage: 'fr' } });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    await openEditorSection(window, 15);
    const before = readConfig(dir);

    await section(window, 'Langue');
    await window.locator('.settings-modal select').first().selectOption('en');
    await expect(window.locator('#settings-modal-title')).toHaveText('Settings');
    await expect.poll(() => readConfig(dir).rag.systemPromptLanguage).toBe('en');

    await fontField(window).fill('18');
    await save(window, 'Save');
    await expect(saved(window)).toBeVisible();

    const after = readConfig(dir);
    expect(after.rag).toEqual({ ...before.rag, systemPromptLanguage: 'en' });
    expect(after.llm).toEqual(before.llm);
    expect(after.zotero).toEqual(before.zotero);
    expect(after.editor).toEqual({ ...before.editor, fontSize: 18 });
    expect(after.language).toBe('en');
  } finally {
    await app.close();
  }
});

test('un fournisseur d’embeddings changé, puis une police : le choix n’est pas annulé', async () => {
  const dir = userData({ ...AUTHOR, llm: { ...AUTHOR.llm, embeddingProvider: 'auto' } });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    await openEditorSection(window, 15);
    await window.locator('.settings-modal').getByRole('button', { name: 'Expert', exact: true }).click();
    await section(window, 'Embeddings (recherche sémantique)');
    await window.locator('.settings-modal select:has(option[value="embedded"])').selectOption('embedded');
    await window.locator('.confirm-dialog-btn-confirm').click();
    // « Réindexation nécessaire » : un simple avis, à fermer.
    await window.locator('.alert-dialog button').first().click();
    await expect.poll(() => readConfig(dir).llm.embeddingProvider).toBe('embedded');

    await fontField(window).fill('18');
    await save(window);
    await expect(saved(window)).toBeVisible();

    const after = readConfig(dir);
    expect(after.llm.embeddingProvider).toBe('embedded');
    expect(after.editor.fontSize).toBe(18);
  } finally {
    await app.close();
  }
});

test('ouvrir puis Sauvegarder, sur une configuration à laquelle il manque des champs : le fichier reste identique à l’octet', async () => {
  const dir = userData({
    language: 'fr',
    rag: { topK: 7 },
    llm: { backend: 'ollama', ollamaURL: NO_OLLAMA },
    editor: { fontSize: 15 },
  });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    await openEditorSection(window, 15);
    const bytes = readFileSync(configPath(dir));
    const mtime = statSync(configPath(dir)).mtimeMs;

    await save(window);
    await expect(saved(window)).toBeVisible();
    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
    expect(statSync(configPath(dir)).mtimeMs).toBe(mtime);
  } finally {
    await app.close();
  }
});

test('Réinitialiser, puis relancer : les valeurs par défaut sont lues, le modèle d’embeddings n’a pas bougé', async () => {
  test.setTimeout(120_000);
  // Ce que l'auteur a écrit lui-même, sans copie ailleurs : Réinitialiser le garde (D12).
  const written = {
    customSystemPrompt: 'Réponds en historien, cite tes sources.',
    useCustomSystemPrompt: true,
    queryExpansionDictionary: { lettre: ['letter', 'missive'] },
  };
  const dir = userData({ ...AUTHOR, rag: { ...AUTHOR.rag, ...written } });
  const session = await launch(dir);
  if (!session) return;

  try {
    const { window } = session;
    await openSettings(window);
    await openEditorSection(window, 15);
    const before = readConfig(dir);

    // La question dit ce qui revient et ce qui reste. La refuser à Échap ne ferme que la question.
    await reset(window);
    await expect(question(window)).toContainText('gemma2:2b');
    await expect(question(window)).toContainText('Restent en place');
    await expect(question(window)).toContainText('Aucune réindexation');
    await expect(question(window)).toContainText('Corpus manuscrit et Corpus notes de lecture');
    await expect(question(window)).toContainText('même si vous les aviez désactivés');
    await expect(question(window)).toContainText('le prompt système personnalisé et le dictionnaire');
    await expect(question(window)).not.toContainText('effacé');
    await expect(question(window)).not.toContainText('Configuration Zotero');
    await window.keyboard.press('Escape');
    await expect(question(window)).toHaveCount(0);
    await expect(window.locator('#settings-modal-title')).toBeVisible();
    expect(readConfig(dir)).toEqual(before);

    await reset(window);
    await window.locator('.confirm-dialog-btn-confirm').click();
    await expect(saved(window)).toBeVisible();
    await expect(fontField(window)).toHaveValue('14');
    // La seule question est la sienne : pas de `providerChangeConfirm` à la suite.
    await expect(question(window)).toHaveCount(0);
    // Le chat envoie son `topK` : sans répercussion, il gardait l'ancien jusqu'à la relance.
    const chatTopK = () =>
      window.evaluate(() => (JSON.parse(localStorage.getItem('rag-query-params') ?? '{}') as { state?: { params?: { topK?: number } } }).state?.params?.topK);
    await expect.poll(chatTopK).toBe(10);

    const after = readConfig(dir);
    expect(after.rag).toMatchObject({ topK: 10, similarityThreshold: 0.12, chunkingConfig: 'cpuOptimized', useSemanticChunking: false });
    expect(after.rag.systemPromptLanguage).toBe('en');
    expect(after.rag).toMatchObject(written);
    expect(after.rag).not.toHaveProperty('readingNotesCloudConsent');
    expect(after.llm).toMatchObject({ backend: 'ollama', ollamaChatModel: 'gemma2:2b', generationProvider: 'auto' });
    expect(after.llm).not.toHaveProperty('ollamaNumCtx');
    for (const field of [
      'ollamaURL',
      'ollamaEmbeddingModel',
      'ollamaEmbeddingNumCtx',
      'embeddingProvider',
      'embeddedEmbeddingModelId',
      'embeddedEmbeddingModelPath',
    ]) {
      expect(after.llm[field], field).toEqual(before.llm[field]);
    }
    expect(after.editor).toMatchObject({ fontSize: 14, theme: 'dark', fontFamily: 'system', engine: 'cm6' });
    expect(after.zotero).toEqual(before.zotero);
    expect(after.language).toBe('fr');

    await session.app.close();
    const relaunched = await launch(dir);
    if (!relaunched) return;
    session.app = relaunched.app;
    await openSettings(relaunched.window);
    await openEditorSection(relaunched.window, 14);
    await relaunched.window.locator('.settings-modal').getByRole('button', { name: 'Expert', exact: true }).click();
    await section(relaunched.window, 'Configuration RAG');
    await expect(relaunched.window.locator('.settings-modal input[type="number"][value="0.12"]').first()).toBeVisible();
    await section(relaunched.window, 'Configuration LLM');
    await expect(relaunched.window.getByPlaceholder('gemma2:2b')).toHaveValue('gemma2:2b');

    // Rien à écrire après la relance.
    const bytes = readFileSync(configPath(dir));
    await save(relaunched.window);
    await expect(saved(relaunched.window)).toBeVisible();
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
  } finally {
    await session.app.close();
  }
});

test('la question de Réinitialiser, longue, garde ses boutons à l’écran dans une petite fenêtre', async () => {
  const dir = userData({ ...AUTHOR, language: 'de' });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(200, 200);
      win.setSize(800, 500);
    });
    await openSettings(window);
    await reset(window, 'Zurücksetzen');
    await expect(window.locator('.confirm-dialog-btn-confirm')).toBeInViewport({ ratio: 1 });
    await expect(window.locator('.confirm-dialog')).toBeInViewport({ ratio: 1 });
    // Le texte reste lisible jusqu'au bout : il défile dans son corps.
    const scrolls = await window
      .locator('.confirm-dialog-body')
      .evaluate((body) => {
        body.scrollTop = body.scrollHeight;
        return body.scrollTop > 0;
      });
    expect(scrolls).toBe(true);
  } finally {
    await app.close();
  }
});

/** Ce que le trousseau simulé contient, déchiffré dans le main. `llm.x` est imbriqué dans le fichier. */
async function storedKeys(app: ElectronApplication, dir: string): Promise<Record<string, string>> {
  const file = join(dir, 'cliodeck-secrets.json');
  if (!existsSync(file)) return {};
  const entries: Record<string, string> = {};
  const walk = (node: object, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === 'string') entries[prefix + name] = value;
      else walk(value as object, `${prefix}${name}.`);
    }
  };
  walk(JSON.parse(readFileSync(file, 'utf8')) as object, '');
  return app.evaluate(({ safeStorage }, encrypted) => {
    const clear: Record<string, string> = {};
    for (const [name, value] of Object.entries(encrypted)) {
      clear[name] = safeStorage.decryptString(Buffer.from(value, 'base64'));
    }
    return clear;
  }, entries);
}

test('révoquer puis Sauvegarder : aucun masque dans le trousseau ni dans le fichier ; et sans révocation, la clé reste', async () => {
  const dir = userData({ ...AUTHOR, llm: { ...AUTHOR.llm, backend: 'openai' } });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const KEY = 'sk-une-vraie-cle-de-test-longue';
  const ZOTERO_KEY = 'zoteroKey24Caracteres000';

  try {
    await window.evaluate(
      async ([openai, zotero]) => {
        await window.electron.config.set('llm.openaiAPIKey', openai);
        await window.electron.config.set('zotero.apiKey', zotero);
      },
      [KEY, ZOTERO_KEY]
    );
    expect(await storedKeys(app, dir)).toEqual({ 'llm.openaiAPIKey': KEY, 'zotero.apiKey': ZOTERO_KEY });

    await openSettings(window);
    await openEditorSection(window, 15);
    await section(window, 'Configuration LLM');
    const keyField = window.locator('.settings-modal input[type="password"]').first();
    await expect(keyField).toHaveValue('sk-u...ngue');

    // Le masque fait l'aller-retour : la clé ne bouge pas.
    await fontField(window).fill('16');
    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(await storedKeys(app, dir)).toEqual({ 'llm.openaiAPIKey': KEY, 'zotero.apiKey': ZOTERO_KEY });

    await window.locator('.settings-modal').getByRole('button', { name: 'Expert', exact: true }).click();
    await window.locator('.security-revoke-btn').last().click();
    await window.locator('.confirm-dialog-btn-confirm').click();
    await expect(window.locator('.settings-modal').getByText(/révoquée/)).toBeVisible();
    expect(await storedKeys(app, dir)).toEqual({});
    await expect(keyField).toHaveValue('');

    await fontField(window).fill('18');
    await save(window);
    await expect(saved(window)).toBeVisible();
    await expect(keyField).toHaveValue('');

    expect(await storedKeys(app, dir)).toEqual({});
    const after = readConfig(dir);
    expect(after.editor.fontSize).toBe(18);
    expect(readFileSync(configPath(dir), 'utf8')).not.toMatch(/\.\.\.|\*\*\*\*/);
    expect(after.llm).not.toHaveProperty('openaiAPIKey');
    expect(after.zotero).not.toHaveProperty('apiKey');
  } finally {
    await app.close();
  }
});

function article(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-reglages-projet-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nTexte du manuscrit.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000082',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
  return projectJson;
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 30_000 });
}

test('un projet ouvert : rien à écrire ne relance rien ; une écriture refusée dit son motif et se réessaie', async () => {
  test.setTimeout(120_000);
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  let log = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const restarts = () => log.split('Refreshing providers').length - 1;

  try {
    await openProject(app, window, article());
    await openSettings(window);
    await openEditorSection(window, 15);

    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(restarts()).toBe(0);

    // Claude sans clé : le main écrit, puis la relance des services échoue. Le message le dit tel quel.
    await section(window, 'Configuration LLM');
    await window.locator('.settings-modal select').first().selectOption('claude');
    await save(window);
    await expect(failed(window)).toContainText('Configuration LLM : enregistré');
    await expect(failed(window)).toContainText('claudeAPIKey');
    await expect(saved(window)).toHaveCount(0);
    await expect.poll(restarts).toBe(1);
    expect(readConfig(dir).llm.backend).toBe('claude');

    // Rien à écrire, mais les services sont à l'arrêt : « sauvegardée » serait faux. On retente.
    await save(window);
    await expect.poll(restarts).toBe(2);
    await expect(failed(window)).toContainText('claudeAPIKey');
    await expect(saved(window)).toHaveCount(0);

    // La clé saisie : les services repartent, et le message cesse d'être une erreur.
    // Assemblée en morceaux : d'un seul tenant, le secret scanning de GitHub la signale.
    const testKey = 'sk-ant-' + 'api03-une-cle-de-test';
    await window.locator('.settings-modal input[type="password"]').first().fill(testKey);
    await save(window);
    await expect.poll(restarts).toBe(3);
    await expect(saved(window)).toBeVisible();
    expect(readConfig(dir).llm.backend).toBe('claude');
    expect(await storedKeys(app, dir)).toEqual({ 'llm.claudeAPIKey': testKey });
  } finally {
    await app.close();
  }
});

test('écrit mais non appliqué, puis fermer et rouvrir les Paramètres : Sauvegarder retente, sans annoncer « sauvegardée »', async () => {
  test.setTimeout(120_000);
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  let log = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const restarts = () => log.split('Refreshing providers').length - 1;
  const reopen = async () => {
    await window.keyboard.press('Escape');
    await expect(window.locator('#settings-modal-title')).toHaveCount(0);
    await openSettings(window);
    await openEditorSection(window, 15);
  };

  try {
    await openProject(app, window, article());
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await window.locator('.settings-modal select').first().selectOption('claude');
    await save(window);
    await expect(failed(window)).toContainText('claudeAPIKey');
    await expect.poll(restarts).toBe(1);

    // La modale démonte le panneau ; la recherche et l'indexation, elles, restent à l'arrêt.
    await reopen();
    await save(window);
    await expect.poll(restarts).toBe(2);
    await expect(failed(window)).toContainText('claudeAPIKey');
    await expect(saved(window)).toHaveCount(0);

    // Réparé : le message cesse d'être une erreur, et plus rien à retenter à la réouverture suivante.
    await section(window, 'Configuration LLM');
    await window.locator('.settings-modal select').first().selectOption('ollama');
    await save(window);
    await expect.poll(restarts).toBe(3);
    await expect(saved(window)).toBeVisible();

    await reopen();
    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(restarts()).toBe(3);
  } finally {
    await app.close();
  }
});

test('Claude sans clé, puis retour à Ollama : le disque suit, les services repartent, et le projet se rouvre', async () => {
  test.setTimeout(120_000);
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  let log = '';
  session.app.process().stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const projectJson = article();

  try {
    const { app, window } = session;
    await openProject(app, window, projectJson);
    await openSettings(window);
    await section(window, 'Configuration LLM');
    const backend = window.locator('.settings-modal select').first();

    await backend.selectOption('claude');
    await save(window);
    await expect(failed(window)).toContainText('claudeAPIKey');
    expect(readConfig(dir).llm.backend).toBe('claude');

    // Sans l'instantané qui suit le disque, ce retour passait pour « rien à écrire ».
    await backend.selectOption('ollama');
    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(readConfig(dir).llm.backend).toBe('ollama');
    await expect.poll(() => log.split('Providers refreshed successfully').length - 1).toBe(1);

    await session.app.close();
    const relaunched = await launch(dir);
    if (!relaunched) return;
    session.app = relaunched.app;
    await openProject(relaunched.app, relaunched.window, projectJson);
  } finally {
    await session.app.close();
  }
});

test('un changement de découpage seul : le PDF indexé ensuite le suit, sans relancer les services', async () => {
  test.setTimeout(180_000);
  const ollama = await startFakeOllama('Réponse du faux modèle.');
  toClean.push(ollama.userDataDir);
  const session = await launch(ollama.userDataDir);
  if (!session) {
    await ollama.close();
    return;
  }
  const { app, window } = session;
  let log = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const restarts = () => log.split('Refreshing providers').length - 1;
  const projectJson = article();
  const pdf = join(dirname(projectJson), 'source.pdf');
  textPdf(pdf, 12);
  /** Indexe (ou réindexe : un fichier, un document) et rend le nombre d'extraits du projet. */
  const indexedChunks = () =>
    window.evaluate(async (file) => {
      const indexed = await window.electron.pdf.index(file);
      if (!indexed.success) throw new Error(indexed.error);
      const { statistics } = await window.electron.pdf.getStatistics();
      return { documents: statistics.totalDocuments, chunks: statistics.totalChunks };
    }, pdf);

  try {
    await openProject(app, window, projectJson);
    const small = await indexedChunks();
    expect(small.documents).toBe(1);
    expect(small.chunks).toBeGreaterThan(10);

    await openSettings(window);
    await window.locator('.settings-modal').getByRole('button', { name: 'Expert', exact: true }).click();
    await section(window, 'Configuration RAG');
    const preset = window.locator('.settings-modal select:has(option[value="cpuOptimized"])');
    await expect(preset).toHaveValue('cpuOptimized');

    await preset.selectOption('large');
    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(readConfig(ollama.userDataDir).rag.chunkingConfig).toBe('large');
    expect(restarts()).toBe(0);

    const large = await indexedChunks();
    expect(large.documents).toBe(1);
    expect(large.chunks).toBeLessThan(small.chunks);

    // Les deux sections à la fois : le découpage écrit est suivi, et rien n'est relancé — la fenêtre
    // de contexte se lit à chaque tour, aucun fournisseur n'est à refaire pour elle (A3).
    await preset.selectOption('cpuOptimized');
    await section(window, 'Configuration LLM');
    await window.locator('.settings-modal input[placeholder="défaut du serveur (4096)"]').fill('8192');
    await save(window);
    await expect.poll(() => readConfig(ollama.userDataDir).llm.ollamaNumCtx).toBe(8192);
    await expect(saved(window)).toBeVisible();
    expect(restarts()).toBe(0);

    expect((await indexedChunks()).chunks).toBe(small.chunks);
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('après Réinitialiser, le modèle par défaut n’est pas installé : le chat le dit', async () => {
  test.setTimeout(120_000);
  const ollama = await startFakeOllama('Réponse du faux modèle.', { onlyItsModel: true });
  toClean.push(ollama.userDataDir);
  const session = await launch(ollama.userDataDir);
  if (!session) {
    await ollama.close();
    return;
  }
  const { app, window } = session;

  try {
    await openProject(app, window, article());
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await expect(window.locator('.settings-modal select').nth(1)).toHaveValue('faux:latest');
    await reset(window);
    await window.locator('.confirm-dialog-btn-confirm').click();
    await expect(saved(window)).toBeVisible();
    expect(readConfig(ollama.userDataDir).llm.ollamaChatModel).toBe('gemma2:2b');
    await window.keyboard.press('Escape');
    await expect(window.locator('#settings-modal-title')).toBeHidden();

    await window.locator('.workspace-mode-bar').getByRole('button', { name: 'Brainstormer' }).click();
    await window.locator('.center-panel textarea').first().fill('Parle-moi de Danzig');
    await window.keyboard.press('ControlOrMeta+Enter');

    await expect(window.locator('.brainstorm-chat__error').first()).toContainText("model 'gemma2:2b' not found", {
      timeout: 30_000,
    });
  } finally {
    await app.close();
    await ollama.close();
  }
});
