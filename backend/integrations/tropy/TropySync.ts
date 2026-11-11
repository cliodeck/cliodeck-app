import { randomUUID } from 'crypto';
import {
  TropyReader,
  TropyReadError,
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
import { isNoteTranscription, longestNoteLength } from './note-transcription';
import { transcriptionSourceOfFormat } from './transcription-provenance';
import { assessTropyBinding } from './tropy-project-identity';
import {
  PrimarySourcesVectorStore,
  PrimarySourceDocument,
  type OcrPending,
  type PrimarySourceRecord,
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
    }
  | {
      /**
       * Les pages de `sources` sources OCRisées ont changé dans Tropy (photo
       * arrivée d'un autre item ou partie vers lui, G3) : leur transcription,
       * gardée, porte encore les anciennes. La passe OCR suivante, sans
       * forcer, les reprend (`ocrPending = 'pages'`).
       */
      code: 'pages-changed';
      sources: number;
    }
  | {
      /**
       * Une passe d'OCR n'a pas repris `sources` sources aux pages changées
       * (G3) : des images de leur item manquent sur le disque (disque externe
       * débranché, fichiers déplacés). Le texte des seules présentes aurait
       * perdu celui des absentes. Transcription et marque sont gardées ; la
       * passe d'OCR suivante les reprend, les fichiers revenus.
       */
      code: 'pages-images-missing';
      sources: number;
    }
  | {
      /**
       * Le .tpy n'a pas pu être lu (J6) : base verrouillée ou abîmée, table
       * ou colonne qu'aucune version connue de Tropy n'écrit. La passe
       * s'arrête avant toute écriture : rien n'est modifié. Elle se disait
       * réussie, avec 0 item, et un item mal lu perdait ses photos en base.
       * Un état qui peut durer (fichier abîmé) : dit dans le panneau, y
       * compris après une synchro automatique, qui n'alerte pas.
       */
      code: 'tropy-unreadable';
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

/**
 * Les photos d'un item sont-elles celles que la base lui connaissait ? Un
 * ensemble d'identifiants Tropy : leur ordre ne compte pas. Une source sans
 * photo en base n'en avait aucune.
 */
function samePhotoIds(before: ReadonlySet<number> | undefined, photos: ReadonlyArray<{ id: number }>): boolean {
  const now = new Set(photos.map((photo) => photo.id));
  const known = before ?? new Set<number>();
  return now.size === known.size && [...now].every((id) => known.has(id));
}

/**
 * Une transcription venue de l'OCR, et non vide : la seule que des pages
 * changées font refaire (G3). Une transcription saisie, importée, Transkribus
 * ou faite de notes n'est jamais marquée.
 */
function isOcrBody(source: PrimarySourceDocument): boolean {
  return source.transcriptionSource === 'tesseract' && (source.transcription ?? '').trim().length > 0;
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
      // Toute la base du .tpy se lit ici, avant la première écriture : une
      // lecture qui échoue au milieu lève `TropyReadError`, et la passe
      // s'arrête sans rien avoir écrit, ni source, ni projet, ni date de
      // synchro (J6). Une lecture de la base dans la boucle des items, après
      // les premières écritures, laisserait une passe à moitié faite.
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
      // Les sources dont les pages ont changé et que l'OCR n'a pas reprises :
      // en attente d'une passe d'OCR, ou d'images absentes du disque.
      let pagesPending = 0;
      let pagesImagesMissing = 0;

      // Les photos de chaque source avant la passe (G3). Un item réenregistré
      // s'attribue les photos qu'il a reçues : comparé à la base du moment,
      // l'item qui les a perdues, traité après lui, ne verrait rien changer.
      const photosBefore = vectorStore.getPhotoIdsBySource();
      // Les items qui ont encore une photo dans Tropy : un autre (fusionné,
      // vidé) ne se reconnaîtra plus, aucune reprise ne lui est promise.
      const itemsWithPhotos = new Set(items.filter((item) => item.photos.length > 0).map((item) => item.id));

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
            { popplerMissing, photosBefore, itemsWithPhotos }
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
          if (processResult.pagesImagesMissing) pagesImagesMissing++;
          else if (processResult.pagesPending) pagesPending++;

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

      // Une transcription qui porte d'autres pages que les siennes se dit au
      // bilan, à chaque passe, jusqu'à ce qu'un OCR la refasse.
      // Celle qu'une image absente a retenue le dit à part : « Lancer l'OCR »
      // n'y fera rien tant que le fichier manque.
      if (pagesPending > 0) result.issues.push({ code: 'pages-changed', sources: pagesPending });
      if (pagesImagesMissing > 0) {
        result.issues.push({ code: 'pages-images-missing', sources: pagesImagesMissing });
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
      // Le .tpy illisible se dit à l'écran ; le détail reste pour la console.
      if (error instanceof TropyReadError) result.issues.push({ code: 'tropy-unreadable' });
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
    /**
     * Ce que la passe sait déjà : Poppler manque ; les photos de chaque source
     * avant elle, et les items qui ont encore une photo dans Tropy (sans ces
     * relevés, aucune page n'est comparée ni aucune source marquée).
     */
    pass: {
      popplerMissing: boolean;
      photosBefore?: ReadonlyMap<string, ReadonlySet<number>>;
      itemsWithPhotos?: ReadonlySet<number>;
    } = { popplerMissing: false }
  ): Promise<{
    isNew: boolean;
    isUpdated: boolean;
    ocrCount: number;
    transcriptionCount: number;
    /** Une transcription qui n'existait pas a été écrite pour cette source. */
    transcriptionWritten: boolean;
    /** L'OCR n'a pas pu se faire, faute d'outil ou de modèle : l'item est enregistré sans. */
    ocrBlocked?: OcrBlocked;
    /** La source reste marquée : ses pages ont changé, son OCR est à refaire (G3). */
    pagesPending: boolean;
    /** Elle l'est parce qu'une image de l'item manque sur le disque : la reprise l'attend. */
    pagesImagesMissing: boolean;
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
    // courte un commentaire, qui ne doit pas empêcher l'OCR. G1 : la plus
    // longue note décide, pas la somme — quelques annotations courtes
    // retenaient l'OCR ensemble.
    const longestNote = longestNoteLength(item);
    const notesAreTranscription = isNoteTranscription(longestNote);

    // Un corps obtenu par une passe précédente. Une source 'tropy-notes'
    // n'en a pas : son texte se recalcule à partir des notes de Tropy.
    const existingBody =
      existingSource?.transcriptionSource !== 'tropy-notes'
        ? (existingSource?.transcription ?? '').trim()
        : '';
    // Un corps partiel — les images d'un item dont les PDF attendaient
    // Poppler — n'est pas acquis : il se garde, mais l'OCR suivant le reprend.
    // Tenu pour acquis, il empêchait à jamais de reconnaître le PDF. Il reste
    // partiel quand ses pages changent ('pages', G3) : tenu alors pour
    // complet, il retenait le nouveau texte partiel, aux bonnes pages, et la
    // page partie restait sous lui jusqu'à l'installation de Poppler.
    const existingPending = existingSource?.ocrPending ?? null;
    const existingPartial = existingSource?.ocrPartial === true;
    const acquiredBody = existingPartial ? '' : existingBody;
    let ocrPending: OcrPending | null = null;
    let ocrPartial = false;

    // G3 : l'OCR n'est rangé que par item. Une photo arrivée d'un autre item
    // ou partie vers lui laisse son texte dans la transcription de l'item
    // qu'elle a quitté. Les pages de l'item ont-elles changé depuis la passe
    // précédente ? Un ensemble, pas une liste : réordonner ne change rien.
    // Seul un texte venu de l'OCR se refait (`isOcrBody`). Un item qui n'a
    // plus aucune photo (fusionné dans un autre, dans Tropy) ne se
    // reconnaîtra plus : il n'est pas marqué, et une marque posée tombe, sans
    // quoi sa carte et le bilan promettraient pour toujours une reprise
    // impossible.
    const hasPhotos = item.photos.length > 0;
    const knownPhotos = existingSource ? pass.photosBefore?.get(existingSource.id) : undefined;
    const pagesChanged =
      !!existingSource &&
      isOcrBody(existingSource) &&
      hasPhotos &&
      !!pass.photosBefore &&
      !samePhotoIds(knownPhotos, item.photos);
    // Ce qui reste à reprendre si cette passe ne refait pas l'OCR. Des pages
    // changées l'emportent sur l'attente de Poppler : la carte le dit, et
    // l'OCR qui les reprend refait tout l'item. Leur corps garde ce qu'il
    // était (`existingPartial`). Complet, le texte des seules images d'un
    // item qui a un PDF ne le remplace pas sans Poppler (L06-10), et la
    // marque reste jusqu'à un OCR complet. Partiel, il cède à un nouveau texte
    // partiel, qui redevient 'poppler'.
    const keptPending: OcrPending | null = pagesChanged
      ? 'pages'
      : existingPending === 'pages' && !hasPhotos
        ? null
        : existingPending;
    const keptPartial = keptPending !== null && existingPartial;

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
    //
    //    Une reprise de pages changées (G3) refait, sans « Relancer… », l'OCR
    //    d'une transcription gardée : elle ne se fait qu'avec toutes les
    //    images de l'item. `performOCROnItem` écarte en silence celles qui
    //    manquent sur le disque (disque externe débranché, dossier renommé) :
    //    le texte des seules présentes remplaçait la transcription, et celui
    //    des absentes était perdu, même une fois revenues. Elle les attend,
    //    marquée, et le bilan le dit. Une passe forcée fait avec ce qu'elle
    //    trouve, comme avant.
    const imagesMissing =
      !transcription &&
      options.performOCR &&
      !options.forceReindex &&
      keptPending === 'pages' &&
      existingBody.length > 0 &&
      this.hasMissingImage(item);
    if (
      !transcription &&
      options.performOCR &&
      !imagesMissing &&
      (options.forceReindex ||
        // Une source en attente de Poppler se reprend quoi qu'en disent ses
        // notes : le texte de ses images est déjà là, il manque celui de ses
        // PDF. Une passe forcée sans Poppler en met une à notes-transcription
        // en attente, et l'avis promet la reprise sans forcer.
        existingPending === 'poppler' ||
        // Des pages changées (G3) : le texte d'une page partie, ou celui d'une
        // page arrivée, est à sa place après un nouvel OCR seulement.
        keptPending === 'pages' ||
        (acquiredBody.length === 0 && !notesAreTranscription)) &&
      // Poppler toujours absent : la reprendre referait l'OCR de ses images
      // pour le même texte partiel ('poppler'), ou pour un texte partiel
      // qu'une transcription complète ne cède pas ('pages' d'un item qui a
      // un PDF). Une source 'pages' au corps partiel, elle, se reprend : son
      // nouveau texte partiel n'a plus la page partie. La première source
      // reprise de la passe l'apprend.
      !(
        pass.popplerMissing &&
        (keptPending === 'poppler' ||
          (keptPending === 'pages' && acquiredBody.length > 0 && this.hasPdfOnDisk(item)))
      )
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
        ocrPartial = !!ocrResult.missingTool;
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
      // Le corps gardé tel quel reste ce qu'il était : partiel, acquis, ou
      // fait sur d'autres pages que celles de l'item.
      ocrPending = keptPending;
      ocrPartial = keptPartial;
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
    const sourceItem: PrimarySourceRecord = {
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
      longestNoteLength: longestNote,
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
    const markChanged = ocrPending !== existingPending || ocrPartial !== existingPartial;
    const pendingChanged = !!existingSource && markChanged;

    // La longueur de la plus longue note, que le rapport de la source relit
    // (G1). Absente sur une ligne écrite avant la colonne : on l'initialise
    // sans réembarquer, elle n'entre pas dans les extraits.
    const longestNoteChanged = !!existingSource && existingSource.longestNoteLength !== longestNote;

    // Initialiser `notes_text` ou `longest_note_length`, ou lever la seule
    // marque d'attente, réécrit la ligne sans que rien n'ait changé pour
    // l'historien : ce n'est pas une mise à jour.
    let saved = isNew || isUpdated || notesUninitialized || pendingChanged || longestNoteChanged;
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

        // G3 : une photo que cet item a reçue, la base l'attribue encore à
        // l'item qui l'a perdue, et `saveSource` va la lui retirer. La marque
        // de cet item se pose ici, dans la même transaction. Posée seulement
        // quand la passe arrivait à lui, elle manquait dès que la passe
        // s'arrêtait avant (changement de projet, erreur sur cet item) : la
        // passe suivante, ses photos déjà retirées en base, ne voyait plus
        // rien changer, et son texte gardait la page partie. Un item qui n'a
        // plus de photo dans Tropy, ou qui n'y est plus, n'est pas marqué. Un
        // corps qui attendait Poppler le dit encore (`ocrPartial`).
        if (pass.itemsWithPhotos) {
          const received = sourceItem.photos.map((photo) => photo.id);
          for (const ownerId of vectorStore.getOtherPhotoOwners(sourceItem.id, received)) {
            const owner = vectorStore.getSource(ownerId);
            if (owner && isOcrBody(owner) && pass.itemsWithPhotos.has(owner.tropyId)) {
              vectorStore.setOcrPending(ownerId, 'pages', owner.ocrPartial === true);
            }
          }
        }

        vectorStore.saveSource(sourceItem);
        // `saveSource` n'y touche pas : la marque change avec le corps, ici.
        if (markChanged) {
          vectorStore.setOcrPending(sourceItem.id, ocrPending, ocrPartial);
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

    const pagesPending = (saved ? ocrPending : existingPending) === 'pages';
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
      pagesPending,
      pagesImagesMissing: pagesPending && imagesMissing,
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
   * L'item a-t-il, sur le disque, un PDF que l'OCR ne lit qu'avec Poppler ?
   * La même règle que `performOCROnItem`, qui écarte les fichiers absents.
   */
  private hasPdfOnDisk(item: TropyItem): boolean {
    return item.photos.some((photo) => this.ocrPipeline.isPDF(photo.path) && fs.existsSync(photo.path));
  }

  /**
   * Une image de l'item manque-t-elle sur le disque ? `performOCROnItem` les
   * écarte sans rien dire : son texte n'aurait pas toutes les pages.
   */
  private hasMissingImage(item: TropyItem): boolean {
    return item.photos.some((photo) => !fs.existsSync(photo.path));
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
