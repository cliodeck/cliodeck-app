/**
 * Indexation des notes de lecture — cinquième corpus RAG.
 *
 * Les notes de lecture (`reading-notes/<clé>.md`, cf. docs/reading-notes.md)
 * sont le commentaire de l'historien sur ses références : « qu'avais-je noté
 * sur Braudel ? » est une question que ni les PDF ni le manuscrit ne savent
 * trancher.
 *
 * Mêmes choix que `manuscript-index-service`, pour les mêmes raisons :
 * indexation depuis le disque, incrémentale par empreinte de contenu (note
 * par note), tout ou rien par note, best-effort et jamais bloquante.
 *
 * Deux différences :
 *  - une note est identifiée par sa **référence** (`zotero:<clé>`), pas par
 *    son chemin : renommer le fichier ne la réembarque pas ;
 *  - chaque extrait est embarqué et indexé **avec un en-tête** qui nomme la
 *    référence et les étiquettes du projet (`readingNoteHeader`) : une note
 *    ne répète presque jamais l'auteur ni le titre qu'elle commente.
 *
 * Désactivable par `rag.indexReadingNotes` (défaut : activé). L'envoi à un
 * modèle en ligne est une autre question, tranchée par
 * `rag.readingNotesCloudConsent` (défaut : refusé) à **deux** endroits : dans
 * le chat, et ici. Indexer, c'est envoyer le texte des notes au fournisseur
 * d'embeddings ; quand celui-ci est distant (`useCloudEmbeddings`, Ollama
 * distant), la passe s'abstient sans ce consentement. Avant, seul le chat le
 * vérifiait, et la promesse « sans lui, les notes ne partent jamais » était
 * fausse dès l'indexation.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  ReadingNotesStore,
  readingNoteHeader,
  readingNoteId,
  readingNotesStorePath,
  type ReadingNoteRecord,
} from '../../../backend/core/vector-store/ReadingNotesStore.js';
import { chunkManuscriptChapter } from '../../../backend/core/rag/manuscript-chunker.js';
import { workspaceLinkOutsideSync } from '../../../backend/core/workspace/link-guard.js';
import { isInside } from '../../../backend/core/vector-store/file-identity.js';
import { readReadingNote, READING_NOTES_DIR } from '../../../backend/core/bibliography/readingNotes.js';
import type { EmbeddingProvider } from '../../../backend/core/llm/providers/base.js';
import { clioDeckConfigToRegistryConfig } from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import { classifyEmbeddingTarget } from '../../../backend/security/cloud-consent.js';
import { configManager } from './config-manager.js';

const EMBEDDING_BATCH_SIZE = 16;
/** Au-delà, ce n'est plus une note de lecture : on refuse plutôt que de saturer. */
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

export interface ReadingNotesIndexReport {
  /** Notes réellement (ré)indexées lors de cette passe. */
  indexed: number;
  /** Notes inchangées (ou vides), sautées sans coût d'embedding. */
  unchanged: number;
  /** Notes retirées de l'index (fichier supprimé). */
  removed: number;
  chunks: number;
  /** Échecs par note — l'indexation continue malgré eux. */
  failures: Array<{ relativePath: string; reason: string }>;
  durationMs: number;
  /**
   * Présent quand la passe s'est abstenue : le fournisseur d'embeddings est
   * distant (son nom est ici) et l'auteur n'a pas consenti à y envoyer ses
   * notes. L'index est resté tel quel.
   */
  withheldFrom?: string;
  /**
   * Présent quand une réindexation complète (`reindexAll`) a été abandonnée,
   * avec la raison : le fournisseur d'embeddings a échoué sur une note, ou
   * l'écriture a été refusée. Rien n'a été écrit : l'index précédent reste
   * celui que le chat consulte.
   */
  abandoned?: string;
}

export interface ReadingNotesIndexStats {
  noteCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
}

interface ReadingNotesFlags {
  indexReadingNotes?: boolean;
  readingNotesCloudConsent?: boolean;
}

/** Configuration lue : protégée, car hors application le store electron jette. */
function ragFlags(): ReadingNotesFlags {
  try {
    return configManager.getRAGConfig() as ReadingNotesFlags;
  } catch {
    return {};
  }
}

/**
 * Nom du fournisseur distant qui recevrait le texte des notes sans que
 * l'auteur y ait consenti ; `null` si l'indexation peut partir (fournisseur
 * local, ou consentement donné). Configuration illisible : on s'abstient.
 */
function notesWithheldFrom(): string | null {
  if (ragFlags().readingNotesCloudConsent === true) return null;
  try {
    const target = classifyEmbeddingTarget(
      clioDeckConfigToRegistryConfig(configManager.getLLMConfig()).embedding
    );
    return target.isCloud ? target.providerName : null;
  } catch {
    return 'fournisseur inconnu (configuration illisible)';
  }
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Dépendances substituables, pour tester sans Electron. */
export interface ReadingNotesIndexDeps {
  isEnabled: () => boolean;
  openStore: (workspaceRoot: string) => ReadingNotesStore;
  /**
   * Fournisseur distant auquel les notes ne doivent pas partir, ou `null`.
   * Absent = aucune vérification (tests qui ne portent pas sur le
   * consentement) ; le service de production le fournit toujours.
   */
  withheldFrom?: () => string | null;
}

export class ReadingNotesIndexService {
  private store: ReadingNotesStore | null = null;
  private workspaceRoot: string | null = null;
  private running: Promise<ReadingNotesIndexReport> | null = null;
  /**
   * Demande arrivée pendant une passe : une passe de plus suit, pour ne rien
   * manquer. Complète (`force`) si l'une des demandes l'était.
   */
  private rerun: { embedder: EmbeddingProvider; force: boolean } | null = null;

  constructor(
    private readonly deps: ReadingNotesIndexDeps = {
      isEnabled: () => ragFlags().indexReadingNotes !== false,
      openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
      withheldFrom: notesWithheldFrom,
    }
  ) {}

  /** Rattache le service à un projet ; ferme le handle de l'ancien (verrou WAL). */
  configure(workspaceRoot: string | null): void {
    if (workspaceRoot === this.workspaceRoot) return;
    this.detachStore();
    this.workspaceRoot = workspaceRoot;
  }

  clear(): void {
    this.detachStore();
    this.workspaceRoot = null;
  }

  /** Ne ferme le store qu'une fois la passe en vol terminée (cf. manuscript-index-service). */
  private detachStore(): void {
    const previous = this.store;
    const pending = this.running;
    this.store = null;
    this.rerun = null;
    if (!previous) return;
    if (pending) {
      void pending
        .catch(() => undefined)
        .then(() => {
          try {
            previous.close();
          } catch (e) {
            console.warn('[reading-notes-index] close after drain failed:', e);
          }
        });
      return;
    }
    previous.close();
  }

  private getStore(): ReadingNotesStore | null {
    if (!this.workspaceRoot) return null;
    if (this.store) return this.store;
    // `.cliodeck` lié hors du projet (D18) : la base est celle d'un autre, rien ne s'y écrit.
    const linked = workspaceLinkOutsideSync(this.workspaceRoot);
    if (linked) {
      console.warn('[reading-notes-index] lien hors du projet, base non ouverte :', linked);
      return null;
    }
    try {
      this.store = this.deps.openStore(this.workspaceRoot);
      return this.store;
    } catch (e) {
      console.warn('[reading-notes-index] cannot open store:', e);
      return null;
    }
  }

  isEnabled(): boolean {
    return this.deps.isEnabled();
  }

  /** L'auteur a-t-il accepté que ses notes partent vers un modèle en ligne ? */
  cloudConsent(): boolean {
    return ragFlags().readingNotesCloudConsent === true;
  }

  /** Un fichier est-il une note de lecture du projet courant ? */
  isReadingNoteFile(filePath: string): boolean {
    if (!this.workspaceRoot) return false;
    const rel = path.relative(path.join(this.workspaceRoot, READING_NOTES_DIR), filePath);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.toLowerCase().endsWith('.md');
  }

  /**
   * Indexe les notes du projet courant. Best-effort : ne jette jamais.
   *
   * Une demande arrivée pendant une passe n'est pas perdue : la passe en
   * cours a peut-être déjà lu le fichier qui vient de changer, donc une
   * passe de plus suit. Sans quoi une étiquette ajoutée juste après une
   * sauvegarde restait hors de l'index jusqu'à la sauvegarde suivante.
   */
  async index(embedder: EmbeddingProvider): Promise<ReadingNotesIndexReport> {
    return this.schedule(embedder, false);
  }

  private schedule(embedder: EmbeddingProvider, force: boolean): Promise<ReadingNotesIndexReport> {
    if (this.running) {
      this.rerun = { embedder, force: force || (this.rerun?.force ?? false) };
      return this.running;
    }
    const run = async (): Promise<ReadingNotesIndexReport> => {
      let report = await this.runIndex(embedder, force);
      while (this.rerun) {
        const next = this.rerun;
        this.rerun = null;
        report = await this.runIndex(next.embedder, next.force);
      }
      return report;
    };
    this.running = run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Une passe. Incrémentale par défaut : chaque note s'écrit dans sa propre
   * transaction, aussitôt embarquée.
   *
   * `force` (« Tout réindexer ») ignore les empreintes et ne détruit rien
   * avant d'avoir le remplaçant : tous les embeddings sont d'abord obtenus en
   * mémoire. Le fournisseur échoue sur une note (arrêté, ou un nombre de
   * vecteurs faux) : rien n'est écrit, et l'index précédent reste consulté.
   * Sinon tout s'écrit en une transaction, dimension remise à zéro : un
   * changement de modèle (768 → 1024) réembarque toutes les notes. Une note
   * illisible garde ses anciens extraits, dans l'ancienne dimension ; elle
   * figure dans les échecs.
   */
  private async runIndex(embedder: EmbeddingProvider, force: boolean): Promise<ReadingNotesIndexReport> {
    const started = Date.now();
    const report: ReadingNotesIndexReport = {
      indexed: 0,
      unchanged: 0,
      removed: 0,
      chunks: 0,
      failures: [],
      durationMs: 0,
    };
    const done = (): ReadingNotesIndexReport => ({ ...report, durationMs: Date.now() - started });
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot || !this.isEnabled()) return done();

    // Vérifié à chaque passe, relances comprises : le réglage a pu changer.
    const withheldFrom = this.deps.withheldFrom?.() ?? null;
    if (withheldFrom) {
      console.warn(
        `[reading-notes-index] notes non indexées : le fournisseur d'embeddings (${withheldFrom}) est distant et l'envoi des notes n'est pas autorisé`
      );
      return { ...done(), withheldFrom };
    }

    let files: string[];
    try {
      // Pas `listReadingNotes` : il écarte une note illisible, que la passe
      // prendrait alors pour supprimée et retirerait de l'index.
      const dir = path.join(workspaceRoot, READING_NOTES_DIR);
      const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return [] as string[];
        throw e;
      });
      files = names.filter((n) => n.toLowerCase().endsWith('.md')).sort().map((n) => path.join(dir, n));
    } catch (e) {
      report.failures.push({ relativePath: READING_NOTES_DIR, reason: e instanceof Error ? e.message : String(e) });
      return done();
    }

    const store = this.getStore();
    if (!store) {
      report.failures.push({ relativePath: '(store)', reason: 'store unavailable' });
      return done();
    }

    const seenIds = new Set<string>();
    /** En force, les écritures attendent la fin des embeddings : toutes ensemble, ou aucune. */
    const writes: Array<() => void> = [];
    const write = (fn: () => void): void => {
      if (force) writes.push(fn);
      else store.transaction(fn);
    };
    let abandoned: string | undefined;
    for (const file of files) {
      const relativePath = path.relative(workspaceRoot, file);
      // Un lien qui sort du projet n'est pas une note : ni lu ni envoyé au fournisseur,
      // et hors de `seenIds` ce qu'il avait laissé dans l'index en sort plus bas.
      if (!isInside(workspaceRoot, file)) {
        report.failures.push({ relativePath, reason: 'lien hors du projet' });
        continue;
      }
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_NOTE_BYTES) {
          report.failures.push({ relativePath, reason: `oversized (${stat.size} bytes)` });
          continue;
        }
        const raw = await fs.readFile(file, 'utf8');
        const note = await readReadingNote(file);
        if (!note) continue;

        const id = readingNoteId(note);
        if (seenIds.has(id)) {
          // Deux fichiers pour la même référence : le premier fait foi, et
          // l'auteur doit le savoir plutôt que de voir une note ignorée.
          report.failures.push({ relativePath, reason: `duplicate note for ${id}` });
          continue;
        }
        seenIds.add(id);

        const record: ReadingNoteRecord = {
          id,
          relativePath,
          citekey: note.citekey,
          zoteroKey: note.zoteroKey,
          title: note.title,
          tags: note.tags,
          contentHash: hashContent(raw),
          indexedAt: new Date().toISOString(),
        };

        const existing = store.getNote(id);
        if (!force && existing && existing.contentHash === record.contentHash) {
          // Inchangé, mais peut-être renommé : le chemin suit sans réembarquer.
          if (existing.relativePath !== relativePath) store.upsertNote({ ...existing, relativePath });
          report.unchanged += 1;
          continue;
        }

        const chunks = chunkManuscriptChapter(note.body);
        if (chunks.length === 0) {
          // Note encore vide (titre seul) : l'empreinte suffit, rien à embarquer.
          write(() => {
            store.upsertNote(record);
            store.deleteNoteChunks(id);
          });
          report.unchanged += 1;
          continue;
        }

        const header = readingNoteHeader(record);
        const vectors = await this.embedNote(
          embedder,
          chunks.map((c) => `${header}\n\n${c.content}`)
        );
        if (typeof vectors === 'string') {
          // La note garde son état d'index précédent ; en force, toutes le gardent.
          report.failures.push({ relativePath, reason: vectors });
          if (force) {
            abandoned = vectors;
            break;
          }
          continue;
        }

        // Tout ou rien : une empreinte sans ses extraits ferait sauter la
        // note à la passe suivante, et elle disparaîtrait de l'index.
        write(() => {
          store.upsertNote(record);
          store.deleteNoteChunks(id);
          chunks.forEach((c, i) => {
            store.addChunk(
              {
                id: `${id}-${c.chunkIndex}`,
                noteId: id,
                chunkIndex: c.chunkIndex,
                content: c.content,
                sectionTitle: c.sectionTitle,
                line: c.line + note.bodyStartLine - 1,
              },
              vectors[i],
              header
            );
          });
        });
        report.indexed += 1;
        report.chunks += chunks.length;
      } catch (e) {
        // Front matter illisible, écriture refusée : la note garde son état
        // d'index précédent — illisible n'est pas supprimée.
        report.failures.push({ relativePath, reason: reasonOf(e) });
        const kept = store.listNotes().find((n) => n.relativePath === relativePath);
        if (kept) seenIds.add(kept.id);
      }
    }

    const abandon = (reason: string): ReadingNotesIndexReport => ({
      indexed: 0,
      unchanged: 0,
      removed: 0,
      chunks: 0,
      failures: report.failures,
      durationMs: Date.now() - started,
      abandoned: reason,
    });
    if (abandoned !== undefined) return abandon(abandoned);

    const removeUnseen = (): void => {
      for (const known of store.listNotes()) {
        if (!seenIds.has(known.id)) {
          store.deleteNote(known.id);
          report.removed += 1;
        }
      }
    };
    if (!force) {
      removeUnseen();
      return done();
    }
    try {
      store.transaction(() => {
        store.resetDimension();
        for (const fn of writes) fn();
        removeUnseen();
      });
    } catch (e) {
      // Deux dimensions dans la même passe, écriture refusée : la transaction
      // est annulée, l'index précédent reste.
      report.failures.push({ relativePath: '(store)', reason: reasonOf(e) });
      return abandon(reasonOf(e));
    }
    return done();
  }

  /**
   * Réindexe tout, empreintes ignorées (changement de modèle d'embedding),
   * sans rien vider d'avance (cf. `runIndex`). Une réindexation refusée
   * (fournisseur distant sans consentement) n'efface rien non plus.
   */
  async reindexAll(embedder: EmbeddingProvider): Promise<ReadingNotesIndexReport> {
    if (this.running) await this.running.catch(() => undefined);
    return this.schedule(embedder, true);
  }

  stats(): ReadingNotesIndexStats | null {
    return this.getStore()?.stats() ?? null;
  }

  /** Le store à interroger, ou `null` si le corpus est désactivé ou sans projet. */
  getSearchStore(): ReadingNotesStore | null {
    return this.isEnabled() ? this.getStore() : null;
  }

  /** Les vecteurs d'une note, ou ce qui a empêché le fournisseur de les rendre. */
  private async embedNote(embedder: EmbeddingProvider, texts: string[]): Promise<Float32Array[] | string> {
    try {
      const vectors = await this.embedBatched(embedder, texts);
      return vectors.length === texts.length
        ? vectors
        : `provider returned ${vectors.length} vectors for ${texts.length} chunks`;
    } catch (e) {
      return reasonOf(e);
    }
  }

  private async embedBatched(embedder: EmbeddingProvider, texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const vectors = await embedder.embed(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
      for (const v of vectors) out.push(Float32Array.from(v));
    }
    return out;
  }
}

export const readingNotesIndexService = new ReadingNotesIndexService();
