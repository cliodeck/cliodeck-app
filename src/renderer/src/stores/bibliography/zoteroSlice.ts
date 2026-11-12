import type { TFunction } from 'i18next';
import type { Citation, NotAttached, ZoteroSliceState, BibliographySliceCreator } from './types';
import { isPdfPath } from '../../../../../backend/core/bibliography/pdf-attachment';
import { idleBatchIndexing, isEmbeddingDimensionRefusal, pdfIndexFailure } from './indexingSlice';
import { refusedAsProjectChanged, stillIn, stillShown } from '../../services/still-in-project';
import i18n from '../../i18n';

/** Le PDF est dans `PDFs/`, mais pas rattaché : la fiche le dit, et il n'est pas indexé. */
export class AttachmentNotSavedError extends Error {
  readonly notAttached: NotAttached;

  constructor(notAttached: NotAttached) {
    super(`PDF téléchargé mais non rattaché : ${notAttached.filePath} (${notAttached.detail})`);
    this.name = 'AttachmentNotSavedError';
    this.notAttached = notAttached;
  }
}

/**
 * Téléchargé dans `PDFs/` et rattaché à sa référence (le rattachement est écrit), puis refusé ou
 * manqué par l'indexation : ce n'est pas un échec du téléchargement. Dit « Erreur de
 * téléchargement », il faisait relancer un téléchargement réussi (L04-7). Le message est la cause
 * de l'échec de l'indexation, déjà traduite quand le main a rendu un code.
 */
export class DownloadedNotIndexedError extends Error {
  readonly title: string;
  readonly filePath: string;

  constructor(title: string, filePath: string, reason: string) {
    super(reason);
    this.name = 'DownloadedNotIndexedError';
    this.title = title;
    this.filePath = filePath;
  }
}

/** Où est le PDF, qu'il est rattaché, et pourquoi il n'est pas indexé. */
export function describeNotIndexed(t: TFunction, error: DownloadedNotIndexedError): string {
  const file = error.filePath.split(/[\\/]/).pop() || error.filePath;
  return t('bibliography.pdfDownloadedNotIndexed', { title: error.title, file, reason: error.message });
}

/** Où est le PDF, qu'il n'est pas rattaché, et pourquoi. */
export function describeNotAttached(t: TFunction, notAttached: NotAttached): string {
  const reason = notAttached.metadataUnreadable
    ? t('bibliography.pdfNotAttachedMetadataUnreadable', { file: '.cliodeck/bibliography-metadata.json' })
    : t('bibliography.pdfNotAttachedCause', { error: notAttached.detail });
  const file = notAttached.filePath.split(/[\\/]/).pop() || notAttached.filePath;
  return t('bibliography.pdfNotAttached', { title: notAttached.title, file, reason });
}

type AttachResponse = { success?: boolean; error?: string; code?: string };

/**
 * Rattache le PDF à sa seule pièce jointe : le main relit le fichier et n'y change que cela. La
 * liste entière, prise avant le téléchargement, effaçait le rattachement d'un téléchargement
 * simultané (S07-1-5). Un échec revient comme réponse, jamais levé : le PDF est déjà là.
 */
async function attach(projectPath: string, citation: Citation, attachmentKey: string, filePath: string): Promise<AttachResponse> {
  const { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified } = citation;
  try {
    return await window.electron.bibliography.updateAttachment({
      projectPath,
      citation: { id, zoteroKey, zoteroAttachments, zoteroTags, zoteroNotes, dateAdded, dateModified },
      attachmentKey,
      localPath: filePath,
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * La clé sous laquelle `bibliography-metadata.json` range une référence (`storageKeyFor`) : la clé
 * Zotero, sinon la clé BibTeX. Deux notices Zotero peuvent partager leur clé BibTeX (jumeaux
 * Better BibTeX, `Lester_1935`) : cherchée par celle-ci, la seconde rendait toujours la première.
 */
const entryKey = (citation: Pick<Citation, 'id' | 'zoteroKey'>): string => citation.zoteroKey || citation.id;

/** La référence telle que le store la tient maintenant, retrouvée comme le fichier la range. */
const latestOf = (citations: Citation[], citation: Citation): Citation =>
  citations.find((c) => entryKey(c) === entryKey(citation)) ?? citation;

/**
 * Pourquoi le téléchargement n'a pas abouti. Le dossier du projet a disparu : sa traduction, jamais
 * le code du refus ; le main n'a rien transféré ni recréé.
 */
const downloadFailure = (response: { error?: string; code?: string }, fallback: string): string =>
  response.code === 'project_root_missing' ? i18n.t('project.rootMissing') : response.error || fallback;

const notAttachedOf = (citation: Citation, filePath: string, response: AttachResponse): NotAttached => ({
  title: citation.title,
  filePath,
  metadataUnreadable: response.code === 'metadata-unreadable',
  // Le dossier du projet a disparu : sa traduction, jamais le code du refus.
  detail: response.code === 'project_root_missing' ? i18n.t('project.rootMissing') : (response.error ?? ''),
});

/**
 * Rattache un PDF téléchargé à son entrée : `file` pour la session, et la
 * pièce jointe marquée `downloaded` / `localPath` — c'est elle que
 * `bibliography-metadata.json` conserve et qui recrée `file` au lancement
 * suivant (`mergeCitationsWithMetadata`). Sans elle, le lien ne vit qu'en
 * mémoire. La référence est désignée comme le fichier la range (`entryKey`) : par sa seule clé
 * BibTeX, le PDF d'une notice allait aussi à sa jumelle.
 */
export function withDownloadedAttachment(
  citations: Citation[],
  entry: Pick<Citation, 'id' | 'zoteroKey'>,
  attachmentKey: string,
  filePath: string
): Citation[] {
  return citations.map((c) =>
    entryKey(c) === entryKey(entry)
      ? {
          ...c,
          file: filePath,
          zoteroAttachments: c.zoteroAttachments?.map((att) =>
            att.key === attachmentKey ? { ...att, downloaded: true, localPath: filePath } : att
          ),
        }
      : c
  );
}

export const createZoteroSlice: BibliographySliceCreator<ZoteroSliceState> = (set, get) => ({
  downloadAndIndexZoteroPDF: async (citationId: string, attachmentKey: string, projectPath: string) => {
    // Après chaque attente : un autre projet ouvert entre-temps recevrait les références de
    // celui-ci dans son store, et son PDF dans son corpus (S18-2-0).
    const left = async () => !(await stillIn(projectPath));
    try {
      const { citations } = get();
      // La pièce jointe désigne la notice : deux notices Zotero peuvent partager leur clé BibTeX.
      const citation =
        citations.find((c) => c.id === citationId && c.zoteroAttachments?.some((att) => att.key === attachmentKey)) ??
        citations.find((c) => c.id === citationId);

      if (!citation) {
        throw new Error('Citation not found');
      }

      const attachment = citation.zoteroAttachments?.find((att) => att.key === attachmentKey);
      if (!attachment) {
        throw new Error('Attachment not found in citation');
      }

      // Get Zotero config to determine mode
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      const mode = zoteroConfig.mode || 'api';

      // Get project-specific config
      let groupId: string | undefined;
      let libraryID: number | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        libraryID = projectConfig?.zotero?.libraryID;
      } catch (configError) {
        console.warn('Could not load project config:', configError);
      }

      // Build download options based on mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic options bag passed to IPC
      let downloadOptions: any;
      if (mode === 'api') {
        if (!zoteroConfig.userId || !zoteroConfig.apiKey) {
          throw new Error('Zotero API not configured. Please configure userId and apiKey in Settings.');
        }
        downloadOptions = {
          mode: 'api',
          userId: zoteroConfig.userId,
          apiKey: zoteroConfig.apiKey,
          groupId,
          attachmentKey: attachment.key,
          filename: attachment.filename,
          targetDirectory: projectPath,
        };
      } else {
        if (!zoteroConfig.dataDirectory) {
          throw new Error('Zotero data directory not configured. Please configure it in Settings.');
        }
        downloadOptions = {
          mode: 'local',
          dataDirectory: zoteroConfig.dataDirectory,
          libraryID,
          attachmentKey: attachment.key,
          filename: attachment.filename,
          targetDirectory: projectPath,
        };
      }

      console.log(`Downloading PDF from Zotero (${mode}): ${attachment.filename}`);
      if (await left()) return { interrupted: true };

      // Download PDF from Zotero
      const downloadResult = await window.electron.zotero.downloadPDF(downloadOptions);
      if (refusedAsProjectChanged(downloadResult) || (await left())) return { interrupted: true };

      if (!downloadResult.success || !downloadResult.filePath) {
        throw new Error(downloadFailure(downloadResult, 'Failed to download PDF'));
      }

      console.log(`✅ PDF downloaded to: ${downloadResult.filePath}`);
      const filePath = downloadResult.filePath;

      // Le rattachement d'abord, pour qu'il survive au lancement suivant. Refusé, le PDF reste
      // dans PDFs/ sans être rattaché ni indexé, et l'historien le sait.
      const attached = await attach(projectPath, latestOf(get().citations, citation), attachmentKey, filePath);
      if (refusedAsProjectChanged(attached)) return { interrupted: true };
      if (attached.success !== true) throw new AttachmentNotSavedError(notAttachedOf(citation, filePath, attached));
      console.log('💾 Metadata saved after PDF download');
      // Le PDF est rattaché dans ce projet : son indexation part aussitôt, le main refuse s'il a
      // déjà basculé. Attendre l'issue d'une ouverture la ferait refuser à coup sûr.
      if (!stillShown(projectPath)) return { interrupted: true };

      // Sur la liste du moment, pas sur celle d'avant le téléchargement : un autre téléchargement
      // ou une synchronisation l'a changée depuis (S07-1-5).
      set((state) => ({ citations: withDownloadedAttachment(state.citations, citation, attachmentKey, filePath) }));
      get().applyFilters();

      // Index the downloaded PDF
      console.log(`🔍 Indexing downloaded PDF for citation: ${citation.title}`);

      window.dispatchEvent(new CustomEvent('bibliography:indexing-start', {
        detail: { citationId, title: citation.title, filePath: downloadResult.filePath }
      }));

      const bibliographyMetadata = {
        title: citation.title,
        author: citation.author,
        year: citation.year,
      };

      const indexResult = await window.electron.pdf.index(
        downloadResult.filePath!,
        citationId,
        bibliographyMetadata,
        projectPath
      );

      if (refusedAsProjectChanged(indexResult) || (await left())) {
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false }
        }));
        return { interrupted: true };
      }

      if (!indexResult.success) {
        const message = pdfIndexFailure(indexResult, 'Failed to index PDF');
        window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
          detail: { citationId, success: false, error: message }
        }));
        throw new DownloadedNotIndexedError(citation.title, filePath, message);
      }

      // Add to indexed set
      set((state) => ({
        indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!])
      }));

      window.dispatchEvent(new CustomEvent('bibliography:indexing-end', {
        detail: { citationId, success: true }
      }));

      console.log(`✅ PDF downloaded and indexed from Zotero: ${citation.title}`);
      return {};
    } catch (error) {
      console.error('❌ Failed to download and index PDF from Zotero:', error);
      throw error;
    }
  },

  downloadAllMissingPDFs: async (projectPath: string) => {
    try {
      const { citations } = get();

      // Get Zotero config to determine mode
      const zoteroConfig = await window.electron.config.get('zotero');
      if (!zoteroConfig) {
        throw new Error('Zotero not configured. Please configure Zotero in Settings.');
      }

      const mode = zoteroConfig.mode || 'api';

      if (mode === 'api' && (!zoteroConfig.userId || !zoteroConfig.apiKey)) {
        throw new Error('Zotero API not configured. Please configure userId and apiKey in Settings.');
      }
      if (mode === 'local' && !zoteroConfig.dataDirectory) {
        throw new Error('Zotero data directory not configured. Please configure it in Settings.');
      }

      // Get project-specific config
      let groupId: string | undefined;
      let libraryID: number | undefined;
      try {
        const projectConfig = await window.electron.project.getConfig(`${projectPath}/project.json`);
        groupId = projectConfig?.zotero?.groupId || undefined;
        libraryID = projectConfig?.zotero?.libraryID;
      } catch (configError) {
        console.warn('Could not load project config:', configError);
      }

      // Find citations with Zotero PDFs but no local PDF — a notice whose
      // file is an HTML snapshot still needs its PDF.
      const citationsNeedingPDFs = citations.filter(
        (c) => !isPdfPath(c.file) && c.zoteroAttachments && c.zoteroAttachments.length > 0
      );

      const errors: string[] = [];
      let downloaded = 0;
      const skipped = 0;
      /** Rattachés dans ce projet mais pas indexés : la relance du téléchargement les écarterait. */
      let toIndex = 0;
      /**
       * Le projet du lot n'est plus l'ouvert (S18-2-0). Les références du store sont alors celles
       * de l'autre : enregistrées sous ce projet, elles effaçaient tous ses rattachements, et ses
       * PDF partaient dans le corpus de l'autre. Le lot s'arrête là, sans rien écrire ni relire,
       * la progression disparaît, et ce qui reste se dit.
       */
      const interrupt = () => {
        set({ batchIndexing: idleBatchIndexing() });
        const remaining = citationsNeedingPDFs.length - downloaded - skipped - errors.length - toIndex;
        return { downloaded, skipped, errors, interrupted: true as const, remaining, toIndex };
      };
      /** Arrêté sur le PDF d'indice `index`, téléchargé mais pas rattaché : les suivants ne partent pas. */
      const stop = (notAttached: NotAttached, index: number) => {
        set({
          batchIndexing: {
            isIndexing: false,
            current: index + 1,
            total: citationsNeedingPDFs.length,
            skipped,
            indexed: downloaded,
            errors,
          },
        });
        return { downloaded, skipped, errors, stopped: notAttached, remaining: citationsNeedingPDFs.length - index - 1 };
      };
      /**
       * Arrêté sur le PDF d'indice `index`, téléchargé et rattaché, mais refusé par l'index : ses
       * embeddings n'ont pas la dimension du corpus (L04-7). Les suivants le seraient de même ; ils
       * ne partent pas, et le refus se dit une fois.
       */
      const stopOnDimension = (index: number) => {
        set({
          batchIndexing: {
            isIndexing: false,
            current: index + 1,
            total: citationsNeedingPDFs.length,
            skipped,
            indexed: downloaded,
            errors,
          },
        });
        return {
          downloaded,
          skipped,
          errors,
          stoppedOnDimension: true as const,
          remaining: citationsNeedingPDFs.length - index - 1,
        };
      };
      if (!(await stillIn(projectPath))) return interrupt();

      if (citationsNeedingPDFs.length === 0) {
        return { downloaded: 0, skipped: 0, errors: [] };
      }

      // Update batch indexing state
      set({
        batchIndexing: {
          isIndexing: true,
          current: 0,
          total: citationsNeedingPDFs.length,
          skipped: 0,
          indexed: 0,
          errors: [],
        }
      });

      for (let i = 0; i < citationsNeedingPDFs.length; i++) {
        const citation = citationsNeedingPDFs[i];
        if (!(await stillIn(projectPath))) return interrupt();

        set((state) => ({
          batchIndexing: {
            ...state.batchIndexing,
            current: i + 1,
            currentCitation: {
              citationId: citation.id,
              title: citation.title,
              progress: 0,
              stage: 'Downloading PDF...',
            }
          }
        }));

        try {
          // Download first available PDF
          const firstAttachment = citation.zoteroAttachments![0];

          console.log(`Downloading PDF for: ${citation.title}`);

          // Build download options based on mode
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic options bag passed to IPC
          const downloadOptions: any = mode === 'api'
            ? {
                mode: 'api',
                userId: zoteroConfig.userId,
                apiKey: zoteroConfig.apiKey,
                groupId,
                attachmentKey: firstAttachment.key,
                filename: firstAttachment.filename,
                targetDirectory: projectPath,
              }
            : {
                mode: 'local',
                dataDirectory: zoteroConfig.dataDirectory,
                libraryID,
                attachmentKey: firstAttachment.key,
                filename: firstAttachment.filename,
                targetDirectory: projectPath,
              };

          const downloadResult = await window.electron.zotero.downloadPDF(downloadOptions);
          // Le PDF en vol reste dans le dossier du projet, sans rattachement : la relance le reprend.
          if (refusedAsProjectChanged(downloadResult) || !(await stillIn(projectPath))) return interrupt();

          if (!downloadResult.success || !downloadResult.filePath) {
            errors.push(`${citation.title}: ${downloadFailure(downloadResult, 'Failed to download')}`);
            continue;
          }

          // Même rattachement que le téléchargement unitaire, et sauvegardé
          // AVANT l'indexation (#125). Le lot ne posait `file` qu'en mémoire :
          // si l'indexation échouait ou si l'app était fermée, le PDF restait
          // dans le dossier mais l'entrée n'avait plus de fichier au lancement
          // suivant, et « Indexer tous les PDFs » l'écartait sans la compter.
          const filePath = downloadResult.filePath;
          const attached = await attach(
            projectPath,
            latestOf(get().citations, citation),
            firstAttachment.key,
            filePath
          );
          if (refusedAsProjectChanged(attached)) return interrupt();
          if (attached.success !== true) {
            // Pas rattaché, donc pas indexé : jamais compté comme un succès. Des métadonnées
            // illisibles refuseraient aussi tous les suivants : le lot s'arrête là, et le dit.
            const notAttached = notAttachedOf(citation, filePath, attached);
            if (notAttached.metadataUnreadable) return stop(notAttached, i);
            errors.push(describeNotAttached(i18n.t, notAttached));
            continue;
          }
          // Le PDF est rattaché dans ce projet : une relance du téléchargement l'écarterait. Son
          // indexation part donc aussitôt, le main refuse s'il a déjà basculé ; attendre l'issue
          // d'une ouverture la ferait refuser à coup sûr.
          if (!stillShown(projectPath)) {
            toIndex++;
            return interrupt();
          }
          set((state) => ({
            citations: withDownloadedAttachment(state.citations, citation, firstAttachment.key, filePath),
          }));
          get().applyFilters();

          // Index the downloaded PDF
          set((state) => ({
            batchIndexing: {
              ...state.batchIndexing,
              currentCitation: {
                citationId: citation.id,
                title: citation.title,
                progress: 50,
                stage: 'Indexing PDF...',
              }
            }
          }));

          const bibliographyMetadata = {
            title: citation.title,
            author: citation.author,
            year: citation.year,
          };

          const indexResult = await window.electron.pdf.index(
            downloadResult.filePath,
            citation.id,
            bibliographyMetadata,
            projectPath
          );
          // Le PDF en vol a été indexé dans le projet du lot : il compte, mais l'ouvert n'en sait rien.
          // Refusé ou en échec, il reste rattaché sans être indexé.
          if (refusedAsProjectChanged(indexResult) || !(await stillIn(projectPath))) {
            if (indexResult.success) downloaded++;
            else toIndex++;
            return interrupt();
          }

          if (indexResult.success) {
            downloaded++;
            set((state) => ({
              indexedFilePaths: new Set([...state.indexedFilePaths, downloadResult.filePath!]),
              batchIndexing: { ...state.batchIndexing, indexed: downloaded }
            }));
          } else {
            errors.push(`${citation.title}: ${pdfIndexFailure(indexResult, 'Failed to index')}`);
            if (isEmbeddingDimensionRefusal(indexResult)) return stopOnDimension(i);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${citation.title}: ${errorMsg}`);
        }
      }

      set({
        batchIndexing: {
          isIndexing: false,
          current: citationsNeedingPDFs.length,
          total: citationsNeedingPDFs.length,
          skipped,
          indexed: downloaded,
          errors,
        }
      });

      console.log(`✅ Batch download complete: ${downloaded} downloaded, ${errors.length} errors`);

      return { downloaded, skipped, errors };
    } catch (error) {
      console.error('❌ Failed to download all missing PDFs:', error);
      throw error;
    }
  },
});
