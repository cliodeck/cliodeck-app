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
  /** Demande arrivée pendant une passe : une passe de plus suit, pour ne rien manquer. */
  private rerun: EmbeddingProvider | null = null;

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
    if (this.running) {
      this.rerun = embedder;
      return this.running;
    }
    const run = async (): Promise<ReadingNotesIndexReport> => {
      let report = await this.runIndex(embedder);
      while (this.rerun) {
        const next = this.rerun;
        this.rerun = null;
        report = await this.runIndex(next);
      }
      return report;
    };
    this.running = run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runIndex(embedder: EmbeddingProvider): Promise<ReadingNotesIndexReport> {
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
    for (const file of files) {
      const relativePath = path.relative(workspaceRoot, file);
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
        if (existing && existing.contentHash === record.contentHash) {
          // Inchangé, mais peut-être renommé : le chemin suit sans réembarquer.
          if (existing.relativePath !== relativePath) store.upsertNote({ ...existing, relativePath });
          report.unchanged += 1;
          continue;
        }

        const chunks = chunkManuscriptChapter(note.body);
        if (chunks.length === 0) {
          // Note encore vide (titre seul) : l'empreinte suffit, rien à embarquer.
          store.transaction(() => {
            store.upsertNote(record);
            store.deleteNoteChunks(id);
          });
          report.unchanged += 1;
          continue;
        }

        const header = readingNoteHeader(record);
        const vectors = await this.embedBatched(
          embedder,
          chunks.map((c) => `${header}\n\n${c.content}`)
        );
        if (vectors.length !== chunks.length) {
          report.failures.push({
            relativePath,
            reason: `provider returned ${vectors.length} vectors for ${chunks.length} chunks`,
          });
          continue;
        }

        // Tout ou rien : une empreinte sans ses extraits ferait sauter la
        // note à la passe suivante, et elle disparaîtrait de l'index.
        store.transaction(() => {
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
        // Front matter illisible, provider absent, écriture refusée : la note
        // garde son état d'index précédent — illisible n'est pas supprimée.
        report.failures.push({ relativePath, reason: e instanceof Error ? e.message : String(e) });
        const kept = store.listNotes().find((n) => n.relativePath === relativePath);
        if (kept) seenIds.add(kept.id);
      }
    }

    for (const known of store.listNotes()) {
      if (!seenIds.has(known.id)) {
        store.deleteNote(known.id);
        report.removed += 1;
      }
    }
    return done();
  }

  /** Réindexe tout, empreintes ignorées (changement de modèle d'embedding). */
  async reindexAll(embedder: EmbeddingProvider): Promise<ReadingNotesIndexReport> {
    if (this.running) await this.running.catch(() => undefined);
    // Avant de vider l'index : une réindexation refusée ne doit rien effacer.
    if (this.workspaceRoot && this.isEnabled() && this.deps.withheldFrom?.()) {
      return this.index(embedder);
    }
    const store = this.getStore();
    if (store) {
      store.transaction(() => {
        for (const note of store.listNotes()) store.deleteNote(note.id);
      });
    }
    return this.index(embedder);
  }

  stats(): ReadingNotesIndexStats | null {
    return this.getStore()?.stats() ?? null;
  }

  /** Le store à interroger, ou `null` si le corpus est désactivé ou sans projet. */
  getSearchStore(): ReadingNotesStore | null {
    return this.isEnabled() ? this.getStore() : null;
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
