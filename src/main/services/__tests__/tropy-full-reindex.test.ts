/**
 * Les extraits des sources primaires refaits une fois, sans geste de l'historien (H7).
 *
 * Depuis L06-2, renommer une source dans Tropy invalide ses extraits. Une source renommée avant
 * n'est plus détectable : son titre en base est déjà le nouveau, ses extraits portent l'ancien, et
 * l'assistant la cite sous ce nom. La phase d'embarquement de la synchro ne reprend que les sources
 * sans extrait : rien ne les refaisait. Décision de l'auteur : tout le corpus est réindexé une fois,
 * en arrière-plan, dit à l'écran, repris sans perte après une interruption.
 *
 * Vrai `tropyService`, vrai `TropySync` sur un .tpy écrit par `makeTpy`, vrai
 * `PrimarySourcesVectorStore` dans un brain.db temporaire. La base « d'avant » est celle qu'une
 * version antérieure a laissée : sans la colonne de version des extraits, et, pour une source
 * renommée avant L06-2, le nouveau titre en base sous des extraits qui portent l'ancien. Simulés :
 * Electron (une fenêtre qui note ce que le main lui envoie), la configuration et le fournisseur
 * d'embeddings (un vecteur calculé localement, sans réseau), qui tombe en panne sur commande.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { makeTpy, type TpyItemSpec } from '../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';

const sent = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);
vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: { handle: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => {
            sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

/**
 * `ok` : répond ; `fail-on` : tout texte qui contient `failOn` échoue, comme un Ollama qui tombe
 * en arrivant à cette source ; `fail-once-on` : seul le premier de ces textes échoue, comme une
 * connexion réinitialisée ; `absent` : le registre ne se construit pas, aucun fournisseur ;
 * `gate` : le 1er texte attend qu'on ouvre `gate`, comme un Ollama lent.
 */
type ProviderMode = 'ok' | 'fail-on' | 'fail-once-on' | 'absent' | 'gate';
const provider = vi.hoisted(() => ({
  mode: 'ok' as ProviderMode,
  failOn: '',
  failures: 0,
  texts: [] as string[],
  gate: null as Promise<void> | null,
  reached: null as (() => void) | null,
}));

const DIMENSION = 768;
function hashedVector(text: string): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIMENSION] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
// Le fournisseur simulé passe par le vrai décorateur du journal d'usage IA, comme ceux du registre.
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async () => {
  const { instrumentEmbedding } = await import('../../../../backend/core/llm/providers/instrument.js');
  return {
  createRegistryFromClioDeckConfig: () => {
    if (provider.mode === 'absent') throw new Error('aucun fournisseur configuré');
    return {
      getLLM: () => null,
      getEmbedding: () => instrumentEmbedding({
        id: 'local-test',
        name: 'local-test',
        model: 'hashed-bag-of-words',
        dimension: DIMENSION,
        getStatus: () => ({ state: 'ready' }),
        healthCheck: async () => ({ state: 'ready' }),
        embed: async (texts: string[]) => {
          for (const text of texts) {
            provider.texts.push(text);
            if (provider.mode === 'gate' && provider.texts.length === 1 && provider.gate) {
              provider.reached?.();
              await provider.gate;
            }
            if (provider.mode === 'fail-on' && text.includes(provider.failOn)) {
              throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
            }
            if (provider.mode === 'fail-once-on' && text.includes(provider.failOn) && provider.failures === 0) {
              provider.failures += 1;
              throw Object.assign(new Error('fetch failed'), { cause: new Error('read ECONNRESET') });
            }
          }
          return texts.map(hashedVector);
        },
        dispose: async () => undefined,
      }, 'ollama', 'http://127.0.0.1:1'),
      dispose: async () => undefined,
    };
  },
  };
});

const { tropyService } = await import('../tropy-service.js');
const { setBatchSink, setInferenceSink } = await import('../../../../backend/core/usage-journal/context.js');
const { PrimarySourcesVectorStore, TROPY_CHUNKS_VERSION } = await import(
  '../../../../backend/core/vector-store/PrimarySourcesVectorStore.js'
);

// MARK: - Données

/**
 * Le corps d'une source : 600 mots tous distincts, dans un vocabulaire propre à chaque source,
 * soit trois extraits environ. Des mots répétés seraient écartés par le filtre de qualité.
 */
const SYLLABLES = ['ba', 'cor', 'di', 'fu', 'gal', 'le', 'mi', 'nor', 'pa', 'ru', 'sel', 'to', 'van', 'ze', 'qui', 'ran', 'tel', 'mor'];
function word(n: number): string {
  let s = '';
  for (let k = 0, x = n; k < 4; k++, x = Math.floor(x / SYLLABLES.length)) s += SYLLABLES[x % SYLLABLES.length];
  return s;
}
function bodyOf(opening: string, offset: number): string {
  return [
    opening,
    ...Array.from({ length: 50 }, (_, i) =>
      `${Array.from({ length: 12 }, (_, k) => word(offset + 12 * i + k)).join(' ')}.`
    ),
  ].join(' ');
}

/**
 * Trois sources, dans l'ordre où la passe les prend (par titre). Leur corps vient d'un OCR ou d'un
 * import, comme sur un corpus d'archives : c'est là qu'un renommage d'avant L06-2 restait dans les
 * extraits. Le texte d'une source « notes Tropy » commence par son titre (`extractItemText`) :
 * renommée, sa transcription changeait, et ses extraits étaient refaits.
 */
const ARRETE = 'Arrêté du maire de Nantes';
const LETTRE_X = 'Lettre à Xavier';
const LETTRE_Y = 'Lettre à Yves';
const RAPPORT = 'Rapport du commissaire central';
const RAPPORT_ANCIEN = 'Rapport au préfet';
const RAPPORT_COPIE = 'Rapport du commissaire central (copie)';

const ARRETE_OPENING = 'Le maire interdit les réunions publiques sur le cours Saint-Pierre.';
const LETTRE_OPENING = 'Mon cher ami, les dockers ont tenu leur assemblée hier soir.';
const RAPPORT_OPENING = 'Le commissaire central signale huit cents grévistes salle Colbert.';

const BODIES: Record<number, string> = {
  10: bodyOf(ARRETE_OPENING, 0),
  20: bodyOf(LETTRE_OPENING, 1000),
  30: bodyOf(RAPPORT_OPENING, 2000),
};

/** Une note courte (moins de 500 caractères, Q26) : un commentaire, gardé à côté du corps. */
const NOTE = 'Voir aussi la réponse du préfet, carton 12.';

function items(titles: { arrete?: string; lettre?: string; rapport?: string } = {}): TpyItemSpec[] {
  return [
    { id: 10, title: titles.arrete ?? ARRETE, date: '1907-03-12', tags: ['mairie'] },
    { id: 20, title: titles.lettre ?? LETTRE_X, creator: 'Charles Rivière', notes: [{ text: NOTE }], tags: ['correspondance'] },
    { id: 30, title: titles.rapport ?? RAPPORT },
  ];
}

let root: string;
let projectDir: string;
let tropyDir: string;
let tpy: string;

const brainDb = (dir = projectDir) => path.join(dir, '.cliodeck', 'brain.db');

function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(brainDb(), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function sourceId(title: string): string {
  const [row] = query<{ id: string }>('SELECT id FROM tropy_sources WHERE title = ?', title);
  return row.id;
}

function chunks(id: string, dir = projectDir): Array<{ id: string; content: string }> {
  const db = new Database(brainDb(dir), { readonly: true });
  try {
    return db
      .prepare('SELECT id, content FROM tropy_chunks WHERE source_id = ? ORDER BY chunk_index')
      .all(id) as Array<{ id: string; content: string }>;
  } finally {
    db.close();
  }
}

/** La version d'extraits d'une source ; `null` sur une base d'avant. */
function versionOf(id: string): number | null {
  const [row] = query<Record<string, unknown>>('SELECT * FROM tropy_sources WHERE id = ?', id);
  return (row.chunks_version as number | null | undefined) ?? null;
}

/** Ce que l'historien a dans la base : sources (sans la marque des extraits), photos, étiquettes. */
function historianRows(): unknown {
  const sources = query<Record<string, unknown>>('SELECT * FROM tropy_sources ORDER BY id').map((row) => {
    const copy = { ...row };
    delete copy.chunks_version;
    return copy;
  });
  return {
    sources,
    photos: query('SELECT * FROM tropy_photos ORDER BY id'),
    tags: query('SELECT * FROM tropy_tags ORDER BY source_id, tag'),
  };
}

/**
 * La base telle qu'une version d'avant cette PR l'a laissée : pas de version d'extraits. Les
 * `renames` reproduisent une source renommée dans Tropy avant L06-2 : la ligne porte le nouveau
 * titre, ses extraits l'ancien. Le service doit être fermé.
 */
function makeBaseFromBefore(renames: Record<string, string> = {}): void {
  const db = new Database(brainDb());
  try {
    const columns = (db.prepare("PRAGMA table_info('tropy_sources')").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    if (columns.includes('chunks_version')) db.exec('ALTER TABLE tropy_sources DROP COLUMN chunks_version');
    for (const [from, to] of Object.entries(renames)) {
      db.prepare('UPDATE tropy_sources SET title = ? WHERE title = ?').run(to, from);
    }
  } finally {
    db.close();
  }
}

/**
 * Lie le projet Tropy, le synchronise, écrit le corps de chaque source comme un import (son
 * écriture puis sa réindexation, le chemin de `tropy:update-transcription`), puis ferme le projet
 * ClioDeck.
 */
async function linkSyncAndClose(spec = items()): Promise<void> {
  tpy = makeTpy(tropyDir, { projectId: 'projet-tropy-greves', name: 'Grèves nantaises', items: spec });
  await tropyService.init(projectDir);
  expect((await tropyService.openProject(tpy)).success).toBe(true);
  const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
  expect(result.issues).toEqual([]);
  for (const source of tropyService.getAllSources()) {
    expect(await tropyService.updateSourceTranscription(source.id, BODIES[source.tropyId], 'imported')).toMatchObject({
      success: true,
    });
    expect(await tropyService.reindexSource(source.id)).toEqual({ success: true });
  }
  await tropyService.close();
}

async function setProvider(mode: ProviderMode, failOn = ''): Promise<void> {
  provider.mode = mode;
  provider.failOn = failOn;
  provider.failures = 0;
  provider.texts = [];
}

/** Arrête le 1er texte embarqué jusqu'à `open()` ; `reached` se résout quand l'embarquement y est. */
function gateFirstEmbed(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  provider.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    provider.reached = resolve;
  });
  void setProvider('gate');
  return { reached, open };
}

/** Les états de la réindexation complète envoyés au renderer depuis `since`. */
function reindexEvents(since = 0): Array<Record<string, unknown>> {
  return sent
    .slice(since)
    .filter((e) => e.channel === 'tropy:reindex-progress')
    .map((e) => e.payload as Record<string, unknown>);
}

/** Les sources embarquées, dans l'ordre, sans répétition consécutive. */
function embeddedSequence(texts: string[]): string[] {
  const labels = texts.map((t) =>
    t.includes(ARRETE) ? 'arrete'
    : t.includes(LETTRE_Y) || t.includes(LETTRE_X) ? 'lettre'
    : t.includes(RAPPORT) || t.includes(RAPPORT_ANCIEN) ? 'rapport'
    : 'autre'
  );
  return labels.filter((label, i) => label !== labels[i - 1]);
}

/** Les extraits sont tous neufs : aucun id d'avant ne reste, et il y en a. */
function expectRedone(before: Array<{ id: string }>, after: Array<{ id: string }>): void {
  expect(after.length).toBeGreaterThan(0);
  const old = new Set(before.map((c) => c.id));
  expect(after.filter((c) => old.has(c.id))).toEqual([]);
}

// Attendre le résultat, pas un délai : ces bornes ne sont que des garde-fous pour une CI lente.
const WAIT = { timeout: 10_000 };
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-full-reindex-'));
  projectDir = path.join(root, 'projet-cliodeck');
  tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(tropyDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  sent.length = 0;
  provider.mode = 'ok';
  provider.failOn = '';
  provider.texts = [];
  provider.gate = null;
  provider.reached = null;
});

afterEach(async () => {
  provider.gate = null;
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// MARK: - La passe

describe.skipIf(!sqliteAvailable)('réindexation complète : les extraits d’avant sont refaits une fois, à l’ouverture', () => {
  it('trois sources aux extraits d’avant : toutes refaites, à la version courante, sans toucher au texte de l’historien', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    const ids = [ARRETE, LETTRE_X, RAPPORT].map(sourceId);
    const before = ids.map((id) => chunks(id));
    const rowsBefore = historianRows();
    // D'un bloc, la reconstruction des index gèle le processus principal une centaine de
    // secondes sur 40 000 extraits (mesuré) : la passe ne doit jamais la faire.
    const blockingRebuild = vi.spyOn(PrimarySourcesVectorStore.prototype, 'rebuildAllIndexes');

    await tropyService.init(projectDir);

    await vi.waitFor(() => ids.forEach((id, i) => expectRedone(before[i], chunks(id))), WAIT);
    await tropyService.whenFullReindexSettled();
    expect(blockingRebuild).not.toHaveBeenCalled();
    expect(TROPY_CHUNKS_VERSION).toBeGreaterThan(0);
    for (const id of ids) expect(versionOf(id)).toBe(TROPY_CHUNKS_VERSION);
    // Transcriptions, notes, métadonnées, photos et étiquettes : identiques à l'octet.
    expect(historianRows()).toEqual(rowsBefore);
    // Le dernier état dit que c'est fini, et combien de sources ont été refaites.
    expect(reindexEvents().at(-1)).toEqual({ phase: 'done', total: 3 });
  });

  it('une source renommée dans Tropy avant L06-2 : plus aucun extrait ne porte son ancien titre', async () => {
    await linkSyncAndClose();
    // Renommée dans Tropy, la ligne a suivi, pas ses extraits.
    makeBaseFromBefore({ [LETTRE_X]: LETTRE_Y });
    const id = sourceId(LETTRE_Y);
    expect(chunks(id).every((c) => c.content.includes(LETTRE_X))).toBe(true);

    await tropyService.init(projectDir);

    await vi.waitFor(() => {
      const after = chunks(id);
      expect(after.length).toBeGreaterThan(0);
      expect(after.filter((c) => c.content.includes(LETTRE_X))).toEqual([]);
    }, WAIT);
    expect(chunks(id).every((c) => c.content.includes(LETTRE_Y))).toBe(true);
  });

  it('le message dit ce qui se passe et ce que cela coûte : sources faites sur le total, extraits comptés au départ', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    const totalChunks = query<{ n: number }>('SELECT COUNT(*) AS n FROM tropy_chunks')[0].n;

    await tropyService.init(projectDir);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);

    const running = reindexEvents().filter((e) => e.phase === 'running');
    expect(running[0]).toEqual({ phase: 'running', done: 0, total: 3, chunks: totalChunks, waitingForSync: false });
    expect(running.map((e) => e.done)).toEqual([0, 1, 2]);
    // Fini : le main n'a plus rien à annoncer à un panneau ouvert plus tard.
    expect(tropyService.getReindexStatus()).toEqual({ phase: 'idle' });
  });

  it('une seule fois : la réouverture d’un projet déjà refait n’embarque rien et ne dit rien', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    await tropyService.init(projectDir);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);
    await tropyService.whenFullReindexSettled();
    const ids = [ARRETE, LETTRE_X, RAPPORT].map(sourceId);
    const after = ids.map((id) => chunks(id));
    await tropyService.close();

    await setProvider('ok');
    const since = sent.length;
    await tropyService.init(projectDir);
    await tropyService.whenFullReindexSettled();

    expect(provider.texts).toEqual([]);
    expect(reindexEvents(since)).toEqual([]);
    expect(ids.map((id) => chunks(id))).toEqual(after);
  });

  it('témoin : un projet synchronisé avec cette version n’est pas touché à l’ouverture', async () => {
    await linkSyncAndClose();
    await setProvider('ok');

    await tropyService.init(projectDir);
    await tropyService.whenFullReindexSettled();

    expect(provider.texts).toEqual([]);
    expect(reindexEvents()).toEqual([]);
  });

  it('un projet sans source primaire n’est pas touché', async () => {
    await tropyService.init(projectDir);
    await tropyService.whenFullReindexSettled();

    expect(provider.texts).toEqual([]);
    expect(reindexEvents()).toEqual([]);
    expect(tropyService.getReindexStatus()).toEqual({ phase: 'idle' });
  });
});

// MARK: - Interruptions

describe.skipIf(!sqliteAvailable)('réindexation complète : une interruption ne perd rien, la passe suivante reprend là où elle en était', () => {
  it('le fournisseur tombe à la 2e source : la 1re est refaite, les deux autres gardent leurs extraits et leur marque ; la passe suivante les finit sans refaire la 1re', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore({ [LETTRE_X]: LETTRE_Y });
    const [arrete, lettre, rapport] = [ARRETE, LETTRE_Y, RAPPORT].map(sourceId);
    const before = { arrete: chunks(arrete), lettre: chunks(lettre), rapport: chunks(rapport) };

    // Ollama tombe en arrivant à la lettre.
    await setProvider('fail-on', LETTRE_Y);
    await tropyService.init(projectDir);

    await vi.waitFor(() => expectRedone(before.arrete, chunks(arrete)), WAIT);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'stopped' }), WAIT);
    expect(reindexEvents().at(-1)).toEqual({
      phase: 'stopped',
      reason: 'embedding-failed',
      total: 3,
      remaining: 2,
    });
    expect(versionOf(arrete)).toBe(TROPY_CHUNKS_VERSION);
    // Les anciens extraits restent servis, et la marque aussi.
    expect(chunks(lettre)).toEqual(before.lettre);
    expect(chunks(rapport)).toEqual(before.rapport);
    expect(versionOf(lettre)).toBeNull();
    expect(versionOf(rapport)).toBeNull();
    // Le panneau ouvert ensuite lit le même état.
    expect(tropyService.getReindexStatus()).toEqual(reindexEvents().at(-1));
    const arreteRedone = chunks(arrete);
    await tropyService.close();

    // Ollama relancé, projet rouvert.
    await setProvider('ok');
    await tropyService.init(projectDir);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);
    await tropyService.whenFullReindexSettled();

    expect(reindexEvents().at(-1)).toEqual({ phase: 'done', total: 2 });
    // Rien n'est refait deux fois : la 1re source n'est pas réembarquée.
    expect(embeddedSequence(provider.texts)).toEqual(['lettre', 'rapport']);
    expect(chunks(arrete)).toEqual(arreteRedone);
    expectRedone(before.lettre, chunks(lettre));
    expectRedone(before.rapport, chunks(rapport));
    expect([arrete, lettre, rapport].map(versionOf)).toEqual([
      TROPY_CHUNKS_VERSION,
      TROPY_CHUNKS_VERSION,
      TROPY_CHUNKS_VERSION,
    ]);
  });

  it('une coupure passagère (connexion réinitialisée) : la source est reprise, et la passe va jusqu’au bout', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore({ [LETTRE_X]: LETTRE_Y });
    const ids = [ARRETE, LETTRE_Y, RAPPORT].map(sourceId);
    const before = ids.map((id) => chunks(id));

    await setProvider('fail-once-on', LETTRE_Y);
    await tropyService.init(projectDir);
    await vi.waitFor(() => expect(reindexEvents().at(-1)?.phase).toMatch(/done|stopped/), WAIT);
    await tropyService.whenFullReindexSettled();

    expect(provider.failures).toBe(1);
    expect(reindexEvents().at(-1)).toEqual({ phase: 'done', total: 3 });
    ids.forEach((id, i) => expectRedone(before[i], chunks(id)));
    expect(ids.map(versionOf)).toEqual([TROPY_CHUNKS_VERSION, TROPY_CHUNKS_VERSION, TROPY_CHUNKS_VERSION]);
  });

  it('aucun fournisseur : la passe s’arrête sans rien embarquer, le dit, et toutes les sources gardent leurs extraits', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    const ids = [ARRETE, LETTRE_X, RAPPORT].map(sourceId);
    const before = ids.map((id) => chunks(id));

    await setProvider('absent');
    await tropyService.init(projectDir);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'stopped' }), WAIT);

    expect(reindexEvents().at(-1)).toEqual({
      phase: 'stopped',
      reason: 'no-embedding-provider',
      total: 3,
      remaining: 3,
    });
    expect(ids.map((id) => chunks(id))).toEqual(before);
    expect(ids.map(versionOf)).toEqual([null, null, null]);
  });

  it('projet changé pendant la passe : rien n’est écrit dans le magasin du projet suivant, ni dans celui du premier', async () => {
    // Le projet B, synchronisé avec cette version : rien à y refaire.
    const projectB = path.join(root, 'projet-B');
    fs.mkdirSync(projectB);
    const tropyB = path.join(root, 'tropy-B');
    const tpyB = makeTpy(tropyB, {
      projectId: 'projet-tropy-B',
      name: 'Archives B',
      items: [{ id: 10, title: 'Registre B', notes: [{ text: bodyOf('Le registre B commence ici.', 5000) }] }],
    });
    await tropyService.init(projectB);
    expect((await tropyService.openProject(tpyB)).success).toBe(true);
    await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
    await tropyService.close();
    const chunksB = () => {
      const db = new Database(brainDb(projectB), { readonly: true });
      try {
        return db.prepare('SELECT id, source_id, content FROM tropy_chunks ORDER BY id').all();
      } finally {
        db.close();
      }
    };
    const beforeB = chunksB();

    // Le projet A, aux extraits d'avant ; sa passe s'arrête sur le 1er extrait.
    await linkSyncAndClose();
    makeBaseFromBefore();
    const ids = [ARRETE, LETTRE_X, RAPPORT].map(sourceId);
    const beforeA = ids.map((id) => chunks(id));
    const gate = gateFirstEmbed();
    await tropyService.init(projectDir);
    await gate.reached;

    // L'historien ouvre B pendant ce temps.
    await tropyService.init(projectB);
    const since = sent.length;
    gate.open();
    await tropyService.whenFullReindexSettled();

    expect(chunksB()).toEqual(beforeB);
    expect(ids.map((id) => chunks(id))).toEqual(beforeA);
    expect(ids.map(versionOf)).toEqual([null, null, null]);
    // Et la passe de A ne parle plus au panneau de B.
    expect(reindexEvents(since)).toEqual([]);
    expect(tropyService.getReindexStatus()).toEqual({ phase: 'idle' });
  });
});

// MARK: - Pendant la passe

describe.skipIf(!sqliteAvailable)('réindexation complète : le reste de l’app continue pendant la passe', () => {
  it('le RAG garde toutes les sources : une source pas encore refaite est trouvée, avec ses anciens extraits', async () => {
    await linkSyncAndClose(items({ rapport: RAPPORT_ANCIEN }));
    // Le rapport, renommé dans Tropy avant L06-2.
    makeBaseFromBefore({ [RAPPORT_ANCIEN]: RAPPORT });
    const gate = gateFirstEmbed();
    await tropyService.init(projectDir);
    try {
      await gate.reached;
      const results = await tropyService.search('commissaire central huit cents grévistes salle Colbert');
      const rapport = results.filter((r) => r.source.title === RAPPORT);
      expect(rapport.length).toBeGreaterThan(0);
      // Anciens extraits : ils portent encore l'ancien titre.
      expect(rapport[0].chunk.content).toContain(RAPPORT_ANCIEN);
      // La source en cours d'embarquement aussi reste trouvée.
      const arrete = await tropyService.search('maire interdit les réunions publiques cours Saint-Pierre');
      expect(arrete.some((r) => r.source.title === ARRETE)).toBe(true);
    } finally {
      gate.open();
    }
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);

    // Refaite : la recherche la trouve sous son vrai nom, sans ancien extrait.
    const after = await tropyService.search('commissaire central huit cents grévistes salle Colbert');
    const rapport = after.filter((r) => r.source.title === RAPPORT);
    expect(rapport.length).toBeGreaterThan(0);
    expect(rapport.every((r) => !r.chunk.content.includes(RAPPORT_ANCIEN))).toBe(true);
  });

  it('le journal d’usage IA reçoit la passe en un seul lot d’embeddings, pas un événement par extrait', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    const totalChunks = query<{ n: number }>('SELECT COUNT(*) AS n FROM tropy_chunks')[0].n;
    const inferences: Array<{ kind: string }> = [];
    const batches: Array<{ corpus: string; chunkCount: number }> = [];
    setInferenceSink((input) => inferences.push(input));
    setBatchSink((acc) => batches.push({ corpus: acc.corpus, chunkCount: acc.chunkCount }));
    try {
      await tropyService.init(projectDir);
      await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);
      await tropyService.whenFullReindexSettled();
    } finally {
      setInferenceSink(undefined);
      setBatchSink(undefined);
    }

    // AnalyseDDF : 40 648 extraits. Un événement chacun noierait le journal de l'historien.
    expect(inferences.filter((e) => e.kind === 'embedding')).toEqual([]);
    expect(batches).toEqual([{ corpus: 'tropy', chunkCount: totalChunks }]);
  });

  it('une synchro lancée pendant la passe : la réindexation lui cède le magasin, puis reprend, sans deux embarquements à la fois', async () => {
    await linkSyncAndClose();
    makeBaseFromBefore();
    const gate = gateFirstEmbed();
    await tropyService.init(projectDir);
    await gate.reached;

    // Pendant ce temps, le rapport est renommé dans Tropy, et l'historien synchronise : depuis
    // L06-2, la synchro refait ses extraits.
    const changed = items({ rapport: RAPPORT_COPIE });
    changed[2] = { ...changed[2], modified: '2026-11-10T08:00:00.000Z' };
    makeTpy(tropyDir, { projectId: 'projet-tropy-greves', name: 'Grèves nantaises', items: changed });
    expect((await tropyService.openProject(tpy)).success).toBe(true);
    const syncing = tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
    gate.open();
    const result = await syncing;
    expect(result.issues).toEqual([]);
    await vi.waitFor(() => expect(reindexEvents().at(-1)).toMatchObject({ phase: 'done' }), WAIT);
    await tropyService.whenFullReindexSettled();

    // La source en cours d'abord, puis la synchro, puis le reste de la passe ; le rapport,
    // refait par la synchro, ne l'est pas une seconde fois.
    expect(embeddedSequence(provider.texts)).toEqual(['arrete', 'rapport', 'lettre']);
    // La pause a été dite.
    expect(reindexEvents().some((e) => e.phase === 'running' && e.waitingForSync === true)).toBe(true);
    const rapport = chunks(sourceId(RAPPORT_COPIE));
    expect(rapport.length).toBeGreaterThan(0);
    expect(rapport.every((c) => c.content.includes(RAPPORT_COPIE))).toBe(true);
  });
});
