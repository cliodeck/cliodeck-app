import { randomUUID } from 'crypto';
import {
  TropyReader,
  TropyItem,
  PrimarySourceItem,
  PrimarySourcePhoto,
} from './TropyReader';
import {
  TropyOCRPipeline,
  TranscriptionFormat,
  OcrEngineStoppedError,
  OcrEngineUnavailableError,
  type TropyOCRPipelineOptions,
} from './TropyOCRPipeline';
import { PopplerNotFoundError } from './PDFConverter';
import { isNoteTranscription } from './note-transcription';
import { transcriptionSourceOfFormat } from './transcription-provenance';
import { assessTropyBinding } from './tropy-project-identity';
import {
  PrimarySourcesVectorStore,
  PrimarySourceDocument,
} from '../../core/vector-store/PrimarySourcesVectorStore';
import { NERService } from '../../core/ner/NERService';
import type { LLMProvider } from '../../core/llm/providers/base';
import { archivalFromTropyMetadata } from '../../types/archival-metadata';
import { sameFile } from '../../core/vector-store/file-identity';
import * as fs from 'fs';
import * as path from 'path';

// MARK: - Types

export interface TropySyncOptions {
  performOCR: boolean;
  ocrLanguage: string;
  transcriptionDirectory?: string;
  forceReindex?: boolean;
  extractEntities?: boolean;  // Enable NER extraction (default: false - opt-in due to slow performance)
  /**
   * Typed provider for NER. Required when `extractEntities === true` —
   * the legacy `ollamaClient` slot was removed in fusion step 1.2c.
   */
  llm?: LLMProvider;
}

/**
 * Ce qui a empêché ou gêné une passe, sous une forme que le renderer traduit
 * (`describeSyncIssue`, `sync-issues.ts`). `errors` garde le texte technique,
 * pour la console.
 */
export type TropySyncIssue =
  | {
      /** Le projet ouvert n'est pas le projet Tropy lié, qui a déjà des sources (Q25). */
      code: 'different-project';
      /** Nom du projet lié ; '' si des sources existent sans projet enregistré. */
      linkedName: string;
      candidateName: string;
      sourceCount: number;
    }
  | {
      /**
       * Des sources enregistrées n'ont pas pu être embarquées (fournisseur en
       * panne, Ollama arrêté) : elles restent sans extrait, et la synchro
       * suivante les reprend. Un état qui peut durer, pas un refus.
       */
      code: 'embedding-failed';
      sources: number;
    }
  | {
      /** Aucun fournisseur d'embeddings : `sources` sources attendent leurs extraits. */
      code: 'no-embedding-provider';
      sources: number;
    }
  | {
      /**
       * Poppler est absent : les PDF n'ont pas pu passer à l'OCR. Les items
       * sont enregistrés, et leurs images, s'ils en ont, reconnues (#138) ;
       * leur transcription reste « à reprendre » (`ocrPending`), et la passe
       * OCR suivante, sans forcer, reconnaît leurs PDF. Une transcription
       * complète déjà acquise n'est pas remplacée par ce texte partiel.
       */
      code: 'poppler-missing';
    }
  | {
      /**
       * Le moteur OCR n'a pas démarré dans cette langue (modèle introuvable
       * hors ligne, ou aucune réponse) : la passe a continué sans OCR.
       */
      code: 'ocr-language-unavailable';
      language: string;
    };

/** Ce qui a empêché l'OCR d'un item, et vaudra pour toute la passe. */
type OcrBlocked = Extract<TropySyncIssue, { code: 'poppler-missing' | 'ocr-language-unavailable' }>;

export interface TropySyncResult {
  success: boolean;
  projectName: string;
  totalItems: number;
  newItems: number;
  updatedItems: number;
  skippedItems: number;
  ocrPerformed: number;
  transcriptionsImported: number;
  /**
   * Sources qui repartent de cette passe avec une transcription qu'elles
   * n'avaient pas. C'est le seul chiffre qui dise à l'utilisateur si les
   * heures d'OCR ont servi — `ocrPerformed` mesure l'effort, pas le résultat.
   */
  transcriptionsWritten: number;
  errors: string[];
  issues: TropySyncIssue[];
}

export interface TropySyncProgress {
  phase: 'reading' | 'processing' | 'extracting-entities' | 'indexing' | 'done';
  current: number;
  total: number;
  currentItem?: string;
}

export type TropySyncProgressCallback = (progress: TropySyncProgress) => void;

/**
 * La ligne d'une source a-t-elle été écrite par un autre que cette passe depuis
 * sa lecture ? Hors synchro, seule l'écriture d'une transcription (OCR manuel,
 * import, saisie) touche une ligne existante, et elle date toujours
 * `last_modified` ; une source apparue ou disparue entre-temps compte aussi.
 */
function rewrittenSince(read: PrimarySourceDocument | null, now: PrimarySourceDocument | null): boolean {
  if (!read || !now) return read !== now;
  return (
    read.id !== now.id ||
    (read.transcription ?? '') !== (now.transcription ?? '') ||
    read.transcriptionSource !== now.transcriptionSource ||
    read.ocrConfidence !== now.ocrConfidence ||
    read.lastModified !== now.lastModified
  );
}

// MARK: - TropySync

/**
 * Synchronisation entre Tropy et ClioDeck
 * Lit les données du fichier .tpy (sans le modifier) et les indexe
 */
export class TropySync {
  private reader: TropyReader;
  private ocrPipeline: TropyOCRPipeline;
  private nerService: NERService | null = null;

  constructor(ocrOptions?: TropyOCRPipelineOptions) {
    this.reader = new TropyReader();
    this.ocrPipeline = new TropyOCRPipeline(ocrOptions);
  }

  /**
   * Initialises the NER service with a typed LLMProvider. As of fusion
   * step 1.2d, NERService takes the provider directly — no stub needed.
   */
  initNERServiceWithProvider(llm: LLMProvider): void {
    this.nerService = new NERService(llm, undefined, 'fr');
    console.log('🏷️ [TROPY-SYNC] NER service initialized (LLMProvider)');
  }

  /**
   * Synchronise un projet Tropy vers le VectorStore
   */
  async sync(
    tpyPath: string,
    vectorStore: PrimarySourcesVectorStore,
    options: TropySyncOptions,
    onProgress?: TropySyncProgressCallback
  ): Promise<TropySyncResult> {
    console.log(`📚 [TROPY-SYNC] Starting sync - performOCR: ${options.performOCR}, forceReindex: ${options.forceReindex}`);

    const result: TropySyncResult = {
      success: false,
      projectName: '',
      totalItems: 0,
      newItems: 0,
      updatedItems: 0,
      skippedItems: 0,
      ocrPerformed: 0,
      transcriptionsImported: 0,
      transcriptionsWritten: 0,
      errors: [],
      issues: [],
    };

    try {
      // Phase 1: Lecture du projet Tropy
      onProgress?.({ phase: 'reading', current: 0, total: 1 });

      // Garde d'identité, avant toute écriture : les ids d'items et de photos
      // sont locaux à chaque .tpy, un autre projet Tropy verrait ses items
      // rattachés aux sources de même numéro (S02-1-18). Bouton, ouverture et
      // surveillance passent tous par ici.
      const binding = assessTropyBinding(tpyPath, vectorStore);
      if (binding.decision.kind === 'different') {
        const { linkedName, sourceCount } = binding.decision;
        result.projectName = binding.identity.name;
        result.issues.push({
          code: 'different-project',
          linkedName,
          candidateName: binding.identity.name,
          sourceCount,
        });
        result.errors.push(
          `Different Tropy project: "${binding.identity.name}" is not the linked project ` +
            `"${linkedName}" (${sourceCount} sources); nothing was synchronised.`
        );
        console.warn(`⚠️ [TROPY-SYNC] ${result.errors[0]}`);
        return result;
      }

      this.reader.openProject(tpyPath);
      result.projectName = this.reader.getProjectName();
      const items = this.reader.listItems();
      result.totalItems = items.length;

      console.log(`📚 Syncing Tropy project: ${result.projectName} (${items.length} items)`);

      // DEBUG: Count items with notes and analyze first item
      let itemsWithNotes = 0;
      let totalNotes = 0;
      for (const item of items) {
        const counts = this.reader.countItemNotes(item);
        if (counts.total > 0) {
          itemsWithNotes++;
          totalNotes += counts.total;
        }
      }
      console.log(`📝 [TROPY-SYNC] Items with notes: ${itemsWithNotes}/${items.length} (${totalNotes} total notes)`);

      // DEBUG: Analyze first item in detail
      if (items.length > 0) {
        const firstItem = items[0];
        console.log(`🔍 [TROPY-SYNC] First item analysis: "${firstItem.title}"`);
        console.log(`   - ID: ${firstItem.id}`);
        console.log(`   - Template: ${firstItem.template}`);
        console.log(`   - Notes count: ${firstItem.notes?.length || 0}`);
        console.log(`   - Photos count: ${firstItem.photos?.length || 0}`);

        if (firstItem.photos?.length > 0) {
          const firstPhoto = firstItem.photos[0];
          console.log(`   - First photo notes: ${firstPhoto.notes?.length || 0}`);
          console.log(`   - First photo selections: ${firstPhoto.selections?.length || 0}`);
          if (firstPhoto.selections?.length > 0) {
            console.log(`   - First selection notes: ${firstPhoto.selections[0].notes?.length || 0}`);
          }
        }

        // Show all raw metadata for first item
        const rawMetadata = this.reader.getAllItemMetadataRaw(firstItem.id);
        console.log(`   - Raw metadata properties: ${rawMetadata.length}`);
        for (const meta of rawMetadata) {
          const valuePreview = meta.value?.substring(0, 100) || '(empty)';
          console.log(`     * ${meta.property}: "${valuePreview}${meta.value?.length > 100 ? '...' : ''}"`);
        }
      }

      // Enregistrer le projet Tropy dans le VectorStore, avec son identité,
      // sur la ligne que la garde a reconnue : un projet déplacé met à jour
      // son chemin, même reconnu par la seule empreinte. Sans `autoSync` : la
      // synchro n'a pas à décider de la surveillance automatique, elle la
      // préserve.
      vectorStore.bindTropyProject(tpyPath, result.projectName, binding.identity.projectId, {
        keepId: binding.linkedId,
      });

      // Un outil ou un modèle de langue absent vaut pour toute la passe : il
      // se dit une fois au bilan (#138). Un moteur qui ne démarre pas n'est
      // pas relancé item après item : chaque tentative attendrait son délai et
      // laisserait un thread derrière elle.
      let ocrUnavailable = false;
      // Poppler manque pour cette passe : une source qui l'attend n'en
      // obtiendrait que le texte de ses images, qu'elle a déjà.
      let popplerMissing = false;

      // Phase 2: Traitement des items
      onProgress?.({ phase: 'processing', current: 0, total: items.length });

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        onProgress?.({
          phase: 'processing',
          current: i + 1,
          total: items.length,
          currentItem: item.title || `Item ${item.id}`,
        });

        try {
          const processResult = await this.processItem(
            item,
            vectorStore,
            ocrUnavailable ? { ...options, performOCR: false } : options,
            { popplerMissing }
          );

          if (processResult.isNew) {
            result.newItems++;
          } else if (processResult.isUpdated) {
            result.updatedItems++;
          } else {
            result.skippedItems++;
          }

          result.ocrPerformed += processResult.ocrCount;
          result.transcriptionsImported += processResult.transcriptionCount;
          if (processResult.transcriptionWritten) result.transcriptionsWritten++;

          const blocked = processResult.ocrBlocked;
          if (blocked) {
            if (!result.issues.some((issue) => issue.code === blocked.code)) result.issues.push(blocked);
            if (blocked.code === 'ocr-language-unavailable') ocrUnavailable = true;
            if (blocked.code === 'poppler-missing') popplerMissing = true;
          }
        } catch (error) {
          // Le moteur arrêté sous la passe (changement de projet) : elle
          // s'arrête là, en échec, au lieu de traiter le reste sans lui.
          if (error instanceof OcrEngineStoppedError) throw error;
          result.errors.push(`Item ${item.id} (${item.title}): ${error}`);
        }
      }

      // Phase 2.5: Extract named entities (if enabled)
      if (options.extractEntities === true && options.llm) {
        if (!this.nerService) {
          this.initNERServiceWithProvider(options.llm);
        }
        if (this.nerService) {
          await this.extractEntitiesForSources(vectorStore, onProgress);
        }
      }

      // Phase 3: Mise à jour de la dernière sync
      onProgress?.({ phase: 'indexing', current: 1, total: 1 });
      vectorStore.updateLastSync(tpyPath);

      onProgress?.({ phase: 'done', current: items.length, total: items.length });

      result.success = true;
      console.log(
        `✅ Sync completed: ${result.newItems} new, ${result.updatedItems} updated, ` +
          `${result.transcriptionsWritten} transcription(s) written (${result.ocrPerformed} page(s) OCR'd)`
      );
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`);
      console.error('Sync error:', error);
    } finally {
      this.reader.closeProject();
    }

    return result;
  }

  /**
   * Traite un item Tropy individuel
   */
  private async processItem(
    item: TropyItem,
    vectorStore: PrimarySourcesVectorStore,
    options: TropySyncOptions,
    /** Ce que la passe sait déjà : Poppler manque. */
    pass: { popplerMissing: boolean } = { popplerMissing: false }
  ): Promise<{
    isNew: boolean;
    isUpdated: boolean;
    ocrCount: number;
    transcriptionCount: number;
    /** Une transcription qui n'existait pas a été écrite pour cette source. */
    transcriptionWritten: boolean;
    /** L'OCR n'a pas pu se faire, faute d'outil ou de modèle : l'item est enregistré sans. */
    ocrBlocked?: OcrBlocked;
  }> {
    const existingSource = vectorStore.getSourceByTropyId(item.id);
    let transcription = '';
    let transcriptionSource: PrimarySourceItem['transcriptionSource'] = undefined;
    let ocrConfidence: number | undefined;
    let ocrCount = 0;
    let transcriptionCount = 0;
    let ocrBlocked: OcrBlocked | undefined;

    // 1. Les notes Tropy (item, photos, sélections), sans les métadonnées.
    //    Une note ne remplace JAMAIS un corps — OCR, transcription de la
    //    fiche, Transkribus : elle est gardée à côté (`notesText`). Elle
    //    remplaçait tout, même « voir aussi carton 12 » sur 50 pages d'OCR,
    //    qui sortaient du RAG ; et elle empêchait de relancer l'OCR.
    const notesOnlyText = this.reader.extractItemNotesOnly(item);
    const notesCounts = this.reader.countItemNotes(item);

    // DEBUG: Log what we're extracting (only for first few items or if there are notes)
    if (notesCounts.total > 0) {
      console.log(`📝 [TROPY-SYNC] Item "${item.title}": ${notesCounts.itemNotes} item notes, ${notesCounts.photoNotes} photo notes, ${notesCounts.selectionNotes} selection notes`);
      console.log(`📝 [TROPY-SYNC] Notes text length: ${notesOnlyText.length} chars`);
      if (notesOnlyText.length > 0) {
        console.log(`📝 [TROPY-SYNC] Notes preview: "${notesOnlyText.substring(0, 200)}..."`);
      }
    }

    const notesText = notesOnlyText.trim();
    // Q26 : une note longue est une transcription faite à la main, une
    // courte un commentaire, qui ne doit pas empêcher l'OCR.
    const notesAreTranscription = isNoteTranscription(notesText.length);

    // Un corps obtenu par une passe précédente. Une source 'tropy-notes'
    // n'en a pas : son texte se recalcule à partir des notes de Tropy.
    const existingBody =
      existingSource?.transcriptionSource !== 'tropy-notes'
        ? (existingSource?.transcription ?? '').trim()
        : '';
    // Un corps partiel — les images d'un item dont les PDF attendaient
    // Poppler — n'est pas acquis : il se garde, mais l'OCR suivant le reprend.
    // Tenu pour acquis, il empêchait à jamais de reconnaître le PDF.
    const existingPending = existingSource?.ocrPending ?? null;
    const acquiredBody = existingPending ? '' : existingBody;
    let ocrPending: 'poppler' | null = null;

    // 2. Chercher des transcriptions externes (Transkribus, etc.)
    if (options.transcriptionDirectory && (!notesAreTranscription || options.forceReindex)) {
      const externalTranscription = await this.findExternalTranscription(
        item,
        options.transcriptionDirectory
      );
      if (externalTranscription) {
        transcription = externalTranscription.text;
        // La provenance suit le format, comme pour l'import d'un seul
        // fichier : un dossier d'ALTO ou de .txt n'est pas un export
        // Transkribus (S15-1-36).
        transcriptionSource = transcriptionSourceOfFormat(externalTranscription.format);
        transcriptionCount++;
      }
    }

    // 3. OCR. Une source déjà transcrite n'est PAS repassée à la
    //    reconnaissance sans demande explicite : c'est ce que la case
    //    « relancer l'OCR sur toutes les sources » promettait sans le faire.
    //    L'OCR repartait de zéro à chaque passe — des heures de calcul sur un
    //    corpus d'archives — pour un résultat que la décision d'écriture
    //    jetait ensuite. Une note-transcription (Q26) vaut transcription ici.
    if (
      !transcription &&
      options.performOCR &&
      (options.forceReindex ||
        // Une source en attente de Poppler se reprend quoi qu'en disent ses
        // notes : le texte de ses images est déjà là, il manque celui de ses
        // PDF. Une passe forcée sans Poppler en met une à notes-transcription
        // en attente, et l'avis promet la reprise sans forcer.
        existingPending === 'poppler' ||
        (acquiredBody.length === 0 && !notesAreTranscription)) &&
      // Poppler toujours absent : la reprendre referait l'OCR de ses images
      // pour le même texte partiel.
      !(existingPending === 'poppler' && pass.popplerMissing)
    ) {
      console.log(`🔍 [TROPY-SYNC] OCR needed for item ${item.id} "${item.title}" - photos: ${item.photos.map(p => p.filename).join(', ')}`);
      const { result: ocrResult, blocked } = await this.performOCROnItem(item, options.ocrLanguage);
      ocrBlocked = blocked;
      // Un texte partiel ne remplace pas une transcription acquise : « Relancer
      // l'OCR sur toutes les sources » sans Poppler y perdait le texte du PDF.
      // Le cas est alors celui d'un OCR qui n'a pas pu se faire.
      if (ocrResult && !(ocrResult.missingTool && acquiredBody)) {
        transcription = ocrResult.text;
        transcriptionSource = 'tesseract';
        ocrConfidence = ocrResult.confidence;
        ocrCount = ocrResult.pageCount;
        ocrPending = ocrResult.missingTool ?? null;
      }
    }

    // 4. Rien de neuf ne doit effacer l'ancien. `saveSource` réécrit la ligne
    //    entière : sans ce report, un OCR infructueux (page illisible,
    //    confiance sous le seuil) faisait perdre une transcription acquise.
    //    Sans corps, les notes tiennent lieu de texte (titre et métadonnées
    //    en tête) ; sans notes non plus, une source 'tropy-notes' n'a plus
    //    rien à dire et perd sa transcription.
    if (!transcription && existingBody && existingSource) {
      transcription = existingSource.transcription ?? '';
      transcriptionSource = existingSource.transcriptionSource;
      ocrConfidence = existingSource.ocrConfidence;
      // Le corps gardé tel quel reste ce qu'il était : partiel ou acquis.
      ocrPending = existingPending;
    } else if (!transcription && notesText) {
      transcription = this.reader.extractItemText(item);
      transcriptionSource = 'tropy-notes';
    }

    // Date de fraîcheur : celle de CET item quand Tropy la fournit
    // (`subjects.modified`). La mtime du .tpy ne reste qu'un filet de
    // sécurité — elle vaut pour le projet entier, donc comparer une source
    // à elle-même revenait à ne jamais voir aucun item changer.
    const itemModified = item.modified
      ? new Date(item.modified)
      : this.reader.getLastModifiedTime();

    // Construire la source primaire
    const sourceItem: PrimarySourceItem = {
      id: existingSource?.id || randomUUID(),
      tropyId: item.id,
      title: item.title || `Source ${item.id}`,
      date: item.date,
      creator: item.creator,
      archive: item.archive,
      collection: item.collection,
      type: item.type,
      tags: item.tags,
      photos: this.convertPhotos(item),
      transcription: transcription || undefined,
      transcriptionSource,
      ocrConfidence,
      notesText,
      lastModified: itemModified,
      metadata: this.extractMetadata(item),
      archival: archivalFromTropyMetadata(this.extractMetadata(item), {
        archive: item.archive,
        collection: item.collection,
        creator: item.creator,
        date: item.date,
      }),
    };

    // Sauvegarder.
    const isNew = !existingSource;

    // Une transcription obtenue dans cette passe s'écrit TOUJOURS. C'est la
    // seule chose que l'utilisateur a payée en heures de calcul ; la faire
    // dépendre d'une détection de fraîcheur la jetait silencieusement.
    const transcriptionChanged =
      !!existingSource && transcription !== (existingSource.transcription ?? '');

    // Les extraits portent aussi les notes (hors 'tropy-notes', où elles sont
    // déjà la transcription) et un en-tête — titre, auteur, date, archive,
    // collection. Si l'un change, les extraits d'avant mentent.
    // `notesText` absent : ligne écrite avant la colonne. On l'initialise sans
    // réembarquer, en supposant les extraits à jour : ceux d'un corps n'ont
    // jamais contenu de note, ceux d'une source 'tropy-notes' les contiennent
    // par la transcription. Sans cela, le premier lancement après la mise à
    // jour réembarquerait tout le corpus.
    const notesUninitialized = !!existingSource && existingSource.notesText === undefined;
    const previousNotes =
      notesUninitialized && existingSource?.transcriptionSource === 'tropy-notes'
        ? notesText
        : (existingSource?.notesText ?? '');
    const notesChanged = !!existingSource && notesText !== previousNotes;
    const headerChanged =
      !!existingSource &&
      (sourceItem.title !== existingSource.title ||
        (sourceItem.creator ?? '') !== (existingSource.creator ?? '') ||
        (sourceItem.date ?? '') !== (existingSource.date ?? '') ||
        (sourceItem.archive ?? '') !== (existingSource.archive ?? '') ||
        (sourceItem.collection ?? '') !== (existingSource.collection ?? ''));
    const chunksStale = transcriptionChanged || notesChanged || headerChanged;

    // Fraîcheur inconnue (Tropy trop ancien pour exposer `modified`) =
    // « a pu changer » : on réécrit, c'est bon marché.
    const itemChanged =
      !!existingSource &&
      (!item.modified || existingSource.lastModified !== sourceItem.lastModified.toISOString());

    const isUpdated =
      !!existingSource && (options.forceReindex || itemChanged || chunksStale);

    // La marque d'attente peut changer seule : la reprise, Poppler installé,
    // rend le même texte partiel quand le PDF est illisible ou a quitté le
    // disque. Ne pas l'écrire faisait refaire l'OCR de l'item à chaque passe.
    const pendingChanged = !!existingSource && ocrPending !== existingPending;

    // Initialiser `notes_text`, ou lever la seule marque d'attente, réécrit la
    // ligne sans que rien n'ait changé pour l'historien : ce n'est pas une
    // mise à jour.
    let saved = isNew || isUpdated || notesUninitialized || pendingChanged;
    if (saved) {
      // La ligne et l'invalidation de ses extraits dans une même transaction :
      // une ligne nouvelle gardée sans elle passerait pour acquise à la passe
      // suivante, qui n'invaliderait plus rien (L06-5). Rien d'asynchrone
      // dedans : OCR et transcriptions sont déjà obtenus.
      saved = vectorStore.transaction(() => {
        // Tout ce qui précède a été décidé d'après `existingSource`, lu avant
        // l'OCR de l'item : des secondes pendant lesquelles un import ou un
        // OCR manuel a pu écrire la source (et la réindexer). Réécrire la
        // ligne d'après cette lecture effaçait leur texte, en gardant parfois
        // leurs extraits (même texte d'OCR qu'avant : rien de « changé »).
        // L'écriture la plus récente l'emporte ; la passe suivante reprendra
        // l'item d'après la ligne à jour.
        if (rewrittenSince(existingSource, vectorStore.getSourceByTropyId(item.id))) {
          console.log(
            `🔁 [TROPY-SYNC] Item ${item.id} "${item.title}" réécrit pendant son traitement : la passe le laisse`
          );
          return false;
        }

        vectorStore.saveSource(sourceItem);
        // `saveSource` n'y touche pas : la marque change avec le corps, ici.
        if (ocrPending !== existingPending) {
          vectorStore.setOcrPending(sourceItem.id, ocrPending);
        }

        // Les chunks appartiennent au texte qu'ils découpent. La phase
        // d'embeddings ne traite que les sources sans chunk : sans cette
        // invalidation, une transcription corrigée resterait invisible au RAG,
        // qui continuerait de répondre sur l'ancienne.
        if (chunksStale) {
          vectorStore.deleteChunks(sourceItem.id);
        }
        return true;
      });
    }

    return {
      isNew: saved && isNew,
      isUpdated: saved && !isNew && isUpdated,
      // Ne compter que ce qui a atteint le disque : un compteur qui recense
      // l'effort plutôt que le résultat annonçait « OCR effectué » sur des
      // transcriptions perdues.
      ocrCount: saved ? ocrCount : 0,
      transcriptionCount: saved ? transcriptionCount : 0,
      transcriptionWritten:
        saved && transcription.length > 0 && (isNew || transcriptionChanged),
      ocrBlocked,
    };
  }

  /**
   * Cherche une transcription externe pour un item
   */
  private async findExternalTranscription(
    item: TropyItem,
    transcriptionDirectory: string
  ): Promise<{ text: string; format: TranscriptionFormat } | null> {
    // Chercher des fichiers correspondants dans le dossier de transcriptions
    // Pattern: item_id.*, title.*, ou premier filename.*
    const possibleNames = [
      `${item.id}`,
      item.title?.replace(/[^a-zA-Z0-9]/g, '_'),
      item.photos[0]?.filename.replace(/\.[^.]+$/, ''),
    ].filter(Boolean);

    const extensions = ['.xml', '.txt'];

    for (const baseName of possibleNames) {
      for (const ext of extensions) {
        const filePath = path.join(transcriptionDirectory, `${baseName}${ext}`);

        if (fs.existsSync(filePath)) {
          const format = this.ocrPipeline.detectFormat(filePath);
          if (format) {
            try {
              const result = await this.ocrPipeline.importTranscription({
                type: format,
                filePath,
              });
              return { text: result.text, format };
            } catch (error) {
              console.warn(`Failed to import transcription ${filePath}:`, error);
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Effectue l'OCR sur toutes les photos d'un item
   * Note: Tropy creates one "photo" entry per page for PDFs, so we deduplicate
   * to avoid OCR'ing the same file multiple times
   */
  private async performOCROnItem(
    item: TropyItem,
    language: string
  ): Promise<{
    /** `missingTool` : le texte ne porte que les images, les PDF attendent Poppler. */
    result: { text: string; pageCount: number; confidence: number; missingTool?: 'poppler' } | null;
    blocked?: OcrBlocked;
  }> {
    // Deduplicate paths - Tropy creates multiple photo entries for multi-page PDFs
    const uniquePaths = [...new Set(item.photos.map((p) => p.path))];
    const photoPaths = uniquePaths.filter((p) => fs.existsSync(p));

    if (photoPaths.length === 0) {
      return { result: null };
    }

    console.log(`📸 [TROPY-SYNC] Item ${item.id}: ${item.photos.length} photo entries -> ${photoPaths.length} unique files`);

    try {
      const result = await this.ocrPipeline.performBatchOCR(photoPaths, { language });
      // Poppler absent pour les PDF de l'item : ses images, elles, sont reconnues.
      const blocked: OcrBlocked | undefined = result.missingTool ? { code: 'poppler-missing' } : undefined;

      // Ne retourner que si on a un texte significatif
      if (result.text.trim().length > 50 && result.confidence > 30) {
        return {
          result: {
            text: result.text,
            // Les pages reconnues, pas les fichiers : un PDF en compte autant
            // que de pages lues. Sans Poppler, ou illisible, il ne compte pas
            // (il se comptera à sa reprise).
            pageCount: result.pageCount,
            confidence: result.confidence,
            ...(result.missingTool ? { missingTool: result.missingTool } : {}),
          },
          blocked,
        };
      }
      return { result: null, blocked };
    } catch (error) {
      // Un outil ou un modèle absent concerne tout le corpus : l'item est
      // enregistré sans OCR, et l'appelant l'inscrit une fois au bilan, plutôt
      // que de conclure « pas de texte » item après item (#138).
      if (error instanceof PopplerNotFoundError) {
        console.warn(`⚠️ [TROPY-SYNC] ${error.message}`);
        return { result: null, blocked: { code: 'poppler-missing' } };
      }
      if (error instanceof OcrEngineUnavailableError) {
        console.warn(`⚠️ [TROPY-SYNC] ${error.message}`);
        return { result: null, blocked: { code: 'ocr-language-unavailable', language: error.language } };
      }
      if (error instanceof OcrEngineStoppedError) throw error;
      console.warn(`OCR failed for item ${item.id}:`, error);
    }

    return { result: null };
  }

  /**
   * Convertit les photos Tropy en format PrimarySourcePhoto
   */
  private convertPhotos(item: TropyItem): PrimarySourcePhoto[] {
    return item.photos.map((photo) => ({
      id: photo.id,
      path: photo.path,
      filename: photo.filename,
      width: photo.width,
      height: photo.height,
      mimetype: photo.mimetype,
      hasTranscription: photo.notes.length > 0,
      transcription: photo.notes.map((n) => n.text).join('\n\n') || undefined,
      notes: photo.notes.map((n) => n.text),
    }));
  }

  /**
   * Extrait les métadonnées supplémentaires d'un item
   */
  private extractMetadata(item: TropyItem): Record<string, string> {
    const metadata: Record<string, string> = {};

    if (item.template) metadata.template = item.template;
    if (item.type) metadata.type = item.type;

    // Ajouter d'autres métadonnées si présentes
    const knownFields = ['title', 'date', 'creator', 'archive', 'collection', 'type', 'tags'];
    for (const [key, value] of Object.entries(item)) {
      if (!knownFields.includes(key) && typeof value === 'string' && value) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  /**
   * Extracts named entities from all sources with transcriptions
   */
  private async extractEntitiesForSources(
    vectorStore: PrimarySourcesVectorStore,
    onProgress?: TropySyncProgressCallback
  ): Promise<void> {
    if (!this.nerService) {
      console.warn('⚠️ [TROPY-SYNC] NER service not initialized, skipping entity extraction');
      return;
    }

    // Get all sources with transcriptions
    const allSources = vectorStore.getAllSources();
    const sourcesWithText = allSources.filter(s => s.transcription && s.transcription.trim().length > 50);

    if (sourcesWithText.length === 0) {
      console.log('🏷️ [TROPY-SYNC] No sources with transcriptions to extract entities from');
      return;
    }

    console.log(`🏷️ [TROPY-SYNC] Extracting entities from ${sourcesWithText.length} sources...`);

    let totalEntities = 0;

    for (let i = 0; i < sourcesWithText.length; i++) {
      const source = sourcesWithText[i];

      onProgress?.({
        phase: 'extracting-entities',
        current: i + 1,
        total: sourcesWithText.length,
        currentItem: source.title,
      });

      try {
        // Delete existing entities for this source (in case of re-sync)
        vectorStore.deleteEntitiesForSource(source.id);

        // Extract entities from transcription
        const result = await this.nerService.extractEntities(source.transcription!);

        if (result.entities.length > 0) {
          // Save entities and their mentions
          vectorStore.saveEntitiesForSource(source.id, result.entities);
          totalEntities += result.entities.length;

          console.log(`  📝 ${source.title}: ${result.entities.length} entities (${result.processingTimeMs}ms)`);
        }
      } catch (error) {
        console.warn(`⚠️ [TROPY-SYNC] Failed to extract entities from ${source.title}:`, error);
      }
    }

    console.log(`🏷️ [TROPY-SYNC] Entity extraction complete: ${totalEntities} total entities`);
  }

  /**
   * Vérifie si une synchronisation est nécessaire
   * Compare la date de modification du fichier .tpy avec la dernière sync
   * Supports both .tropy packages and .tpy files
   */
  checkSyncNeeded(projectPath: string, vectorStore: PrimarySourcesVectorStore): boolean {
    const project = vectorStore.getTropyProject();
    if (!project) return true;

    // Le même fichier, pas la même chaîne : par un lien ou une casse
    // différente (macOS), un projet frais semblait toujours à resynchroniser.
    if (!sameFile(project.tpyPath, projectPath)) return true;

    try {
      // Resolve actual .tpy path if it's a .tropy package
      let tpyPath = projectPath;
      const stats = fs.statSync(projectPath);

      if (stats.isDirectory() && projectPath.endsWith('.tropy')) {
        tpyPath = path.join(projectPath, 'project.tpy');
      }

      const tpyStats = fs.statSync(tpyPath);
      const lastSync = new Date(project.lastSync);
      return tpyStats.mtime > lastSync;
    } catch {
      return true;
    }
  }

  /**
   * Libère les ressources
   */
  async dispose(): Promise<void> {
    this.reader.closeProject();
    await this.ocrPipeline.dispose();
  }
}

// MARK: - Factory

export function createTropySync(): TropySync {
  return new TropySync();
}
