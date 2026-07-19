/**
 * Indexation du manuscrit — quatrième corpus RAG (item 25 des audits).
 *
 * Le RAG ne connaissait que des sources externes : PDF de bibliographie,
 * archives Tropy, vault Obsidian. Le texte que l'historien écrit lui-même
 * n'était regardé par personne, si bien que « qu'ai-je déjà écrit sur
 * Danzig ? » restait sans réponse — le manque le plus criant dans un livre,
 * passé quelques chapitres.
 *
 * Trois choix de conception, chacun pour éviter un piège rencontré ailleurs :
 *
 *  1. **Indexation à la sauvegarde, depuis le disque.** L'alternative —
 *     lire l'éditeur vivant — ferait dépendre l'index d'un état renderer
 *     transitoire et rendrait l'incrémental indécidable (quelle empreinte
 *     pour un texte non écrit ?). En indexant ce qui est sur le disque,
 *     l'index décrit exactement ce que l'auteur a enregistré, et le service
 *     reste utilisable hors interface (CLI, tests).
 *  2. **Incrémental par empreinte de contenu**, chapitre par chapitre : un
 *     manuscrit de 400 000 mots ne se réembarque pas à chaque frappe. Seul
 *     un chapitre dont le SHA-256 a changé est réindexé ; les chapitres
 *     disparus du manifeste sortent de l'index.
 *  3. **Best-effort, jamais bloquant.** L'écriture ne doit jamais attendre
 *     l'indexation ni échouer avec elle : toute erreur est journalisée et
 *     avalée. Un provider d'embedding absent (Ollama éteint) laisse
 *     simplement l'index en l'état.
 *
 * Le corpus est **désactivable** (`rag.indexManuscript`, défaut : activé
 * seulement si le projet a un manuscrit à indexer).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  ManuscriptStore,
  manuscriptStorePath,
} from '../../../backend/core/vector-store/ManuscriptStore.js';
import { chunkManuscriptChapter } from '../../../backend/core/rag/manuscript-chunker.js';
import { parseOutline } from '../../editor/outline.js';
import type { EmbeddingProvider } from '../../../backend/core/llm/providers/base.js';
import { projectManager } from './project-manager.js';
import { configManager } from './config-manager.js';

const EMBEDDING_BATCH_SIZE = 16;
/** Au-delà, ce n'est plus un chapitre : on refuse plutôt que de saturer. */
const MAX_CHAPTER_BYTES = 5 * 1024 * 1024;

export interface ManuscriptIndexReport {
  /** Chapitres réellement (ré)indexés lors de cette passe. */
  indexed: number;
  /** Chapitres inchangés, sautés sans coût d'embedding. */
  unchanged: number;
  /** Chapitres retirés de l'index (sortis du manifeste ou disparus). */
  removed: number;
  /** Chunks écrits lors de cette passe. */
  chunks: number;
  /** Échecs par chapitre — l'indexation continue malgré eux. */
  failures: Array<{ relativePath: string; reason: string }>;
  durationMs: number;
}

interface ManuscriptPiece {
  relativePath: string;
  absolutePath: string;
  title: string;
  order: number;
}

function emptyReport(): ManuscriptIndexReport {
  return {
    indexed: 0,
    unchanged: 0,
    removed: 0,
    chunks: 0,
    failures: [],
    durationMs: 0,
  };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function chapterId(relativePath: string): string {
  return crypto.createHash('md5').update(relativePath).digest('hex');
}

class ManuscriptIndexService {
  private store: ManuscriptStore | null = null;
  private workspaceRoot: string | null = null;
  /** Une seule passe à la fois : une sauvegarde rapide ne doit pas en lancer dix. */
  private running: Promise<ManuscriptIndexReport> | null = null;

  /**
   * Rattache le service à un projet. Fermer le store précédent est
   * indispensable : `brain.db` est partagé, et un handle sur l'ancien
   * projet garderait un verrou WAL.
   */
  configure(workspaceRoot: string | null): void {
    if (workspaceRoot === this.workspaceRoot) return;
    this.store?.close();
    this.store = null;
    this.workspaceRoot = workspaceRoot;
  }

  clear(): void {
    this.store?.close();
    this.store = null;
    this.workspaceRoot = null;
  }

  private getStore(): ManuscriptStore | null {
    if (!this.workspaceRoot) return null;
    if (this.store) return this.store;
    try {
      // Dimension omise : elle se verrouille au premier embedding écrit.
      // Ouvrir sans elle permet de tester les empreintes AVANT d'appeler
      // le provider — c'est tout l'intérêt de l'incrémental.
      this.store = new ManuscriptStore({
        dbPath: manuscriptStorePath(this.workspaceRoot),
      });
      return this.store;
    } catch (e) {
      console.warn('[manuscript-index] cannot open store:', e);
      return null;
    }
  }

  /**
   * Le corpus est-il activé ? Désactivable par `rag.indexManuscript`.
   *
   * La lecture de configuration est protégée : hors application (CLI,
   * tests) le store electron n'est pas initialisé et `getRAGConfig` jette.
   * Un service best-effort ne doit jamais tomber pour cette raison — on
   * retombe sur le défaut, activé.
   */
  isEnabled(): boolean {
    try {
      const rag = configManager.getRAGConfig() as { indexManuscript?: boolean };
      return rag.indexManuscript !== false;
    } catch {
      return true;
    }
  }

  /**
   * Énumère les pièces du manuscrit : les chapitres du manifeste pour un
   * livre, `document.md` sinon. Les pièces absentes du disque sont
   * ignorées — `getChapters` les signale déjà comme `missing`.
   */
  private async listPieces(workspaceRoot: string): Promise<ManuscriptPiece[]> {
    const res = await projectManager.getChapters(workspaceRoot);
    const pieces: ManuscriptPiece[] = [];

    if (res.success && res.chapters.length > 0) {
      for (const chapter of res.chapters) {
        if (chapter.missing) continue;
        pieces.push({
          relativePath: chapter.filePath,
          absolutePath: path.join(workspaceRoot, chapter.filePath),
          title: chapter.title,
          order: chapter.order,
        });
      }
      return pieces;
    }

    // Article / présentation : un document unique.
    for (const candidate of ['document.md', 'slides.md']) {
      const absolutePath = path.join(workspaceRoot, candidate);
      try {
        await fs.access(absolutePath);
        pieces.push({
          relativePath: candidate,
          absolutePath,
          title: candidate,
          order: 0,
        });
        break;
      } catch {
        // pièce absente : on essaie la suivante
      }
    }
    return pieces;
  }

  /**
   * Indexe le manuscrit du projet courant. Best-effort : ne jette jamais.
   * Les appels concurrents partagent la passe en cours.
   */
  async index(embedder: EmbeddingProvider): Promise<ManuscriptIndexReport> {
    if (this.running) return this.running;
    this.running = this.runIndex(embedder).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runIndex(
    embedder: EmbeddingProvider
  ): Promise<ManuscriptIndexReport> {
    const started = Date.now();
    const report = emptyReport();
    const workspaceRoot = this.workspaceRoot;

    if (!workspaceRoot || !this.isEnabled()) {
      report.durationMs = Date.now() - started;
      return report;
    }

    let pieces: ManuscriptPiece[];
    try {
      pieces = await this.listPieces(workspaceRoot);
    } catch (e) {
      report.failures.push({
        relativePath: '(manifeste)',
        reason: e instanceof Error ? e.message : String(e),
      });
      report.durationMs = Date.now() - started;
      return report;
    }
    if (pieces.length === 0) {
      report.durationMs = Date.now() - started;
      return report;
    }

    const store = this.getStore();
    if (!store) {
      report.failures.push({ relativePath: '(store)', reason: 'store unavailable' });
      report.durationMs = Date.now() - started;
      return report;
    }
    const seenIds = new Set<string>();

    for (const piece of pieces) {
      const id = chapterId(piece.relativePath);
      seenIds.add(id);

      let content: string;
      try {
        const stat = await fs.stat(piece.absolutePath);
        if (stat.size > MAX_CHAPTER_BYTES) {
          report.failures.push({
            relativePath: piece.relativePath,
            reason: `oversized (${stat.size} bytes)`,
          });
          continue;
        }
        content = await fs.readFile(piece.absolutePath, 'utf8');
      } catch (e) {
        report.failures.push({
          relativePath: piece.relativePath,
          reason: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      const hash = hashContent(content);

      // Incrémental : rien n'a changé ⇒ aucun appel au provider. C'est ce
      // qui rend un manuscrit de 400 000 mots tenable à chaque sauvegarde.
      const existing = store.getChapterByPath(piece.relativePath);
      if (existing && existing.contentHash === hash) {
        report.unchanged += 1;
        continue;
      }

      const chunks = chunkManuscriptChapter(content);
      const record = {
        id,
        relativePath: piece.relativePath,
        title: piece.title || this.titleFromContent(content, piece.relativePath),
        order: piece.order,
        contentHash: hash,
        indexedAt: new Date().toISOString(),
      };

      if (chunks.length === 0) {
        // Chapitre vide ou purement syntaxique : on enregistre l'empreinte
        // pour ne pas le reparcourir, sans écrire de chunk.
        store.deleteChapterChunks(id);
        store.upsertChapter(record);
        report.unchanged += 1;
        continue;
      }

      let vectors: Float32Array[];
      try {
        vectors = await this.embedBatched(embedder, chunks.map((c) => c.content));
      } catch (e) {
        // Provider absent (Ollama éteint) : on laisse l'index en l'état
        // plutôt que d'écrire un chapitre à moitié embarqué.
        report.failures.push({
          relativePath: piece.relativePath,
          reason: `embedding failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      if (vectors.length !== chunks.length) {
        report.failures.push({
          relativePath: piece.relativePath,
          reason: `provider returned ${vectors.length} vectors for ${chunks.length} chunks`,
        });
        continue;
      }

      try {
        store.upsertChapter(record);
        store.deleteChapterChunks(id);
        for (let i = 0; i < chunks.length; i++) {
          store.addChunk(
            {
              id: `${id}-${chunks[i].chunkIndex}`,
              chapterId: id,
              chunkIndex: chunks[i].chunkIndex,
              content: chunks[i].content,
              sectionTitle: chunks[i].sectionTitle,
              line: chunks[i].line,
            },
            vectors[i]
          );
        }
        report.indexed += 1;
        report.chunks += chunks.length;
      } catch (e) {
        report.failures.push({
          relativePath: piece.relativePath,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Chapitres sortis du manifeste (ou du disque) : on les retire, sinon
    // l'assistant citerait un texte que l'auteur a détaché.
    for (const known of store.listChapters()) {
      if (!seenIds.has(known.id)) {
        store.deleteChapter(known.id);
        report.removed += 1;
      }
    }

    report.durationMs = Date.now() - started;
    return report;
  }

  /** Réindexe tout, empreintes ignorées (changement de modèle d'embedding). */
  async reindexAll(embedder: EmbeddingProvider): Promise<ManuscriptIndexReport> {
    const store = this.getStore();
    if (store) {
      for (const chapter of store.listChapters()) store.deleteChapter(chapter.id);
    }
    return this.index(embedder);
  }

  stats(): { chapterCount: number; chunkCount: number } | null {
    return this.store ? this.store.stats() : null;
  }

  private titleFromContent(content: string, fallback: string): string {
    const first = parseOutline(content).find((h) => h.level === 1);
    return first?.text || fallback;
  }

  private async embedBatched(
    embedder: EmbeddingProvider,
    texts: string[]
  ): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const vectors = await embedder.embed(batch);
      for (const v of vectors) out.push(Float32Array.from(v));
    }
    return out;
  }
}

export const manuscriptIndexService = new ManuscriptIndexService();
