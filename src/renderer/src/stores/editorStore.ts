import { create } from 'zustand';
import i18n from '../i18n';
import { detectLineSeparator } from '@/editor/cm/fidelity';
import type { EditorFacade } from '@/editor/facade';
import { nextFootnoteNumber } from '@/editor/footnote-tools';
import { logger } from '../utils/logger';
import { useDialogStore } from './dialogStore';
import { insertDraftAtOffset } from '../components/Brainstorm/messageToDraft';

// MARK: - Types

export interface EditorSettings {
  fontSize: number;
  theme: 'light' | 'dark';
  wordWrap: boolean;
  showPreview: boolean;
  previewPosition: 'right' | 'bottom';
  showMinimap: boolean;
  fontFamily: string;
  autoSave: boolean;
  autoSaveDelay: number; // in milliseconds
}

export type EditorSwitchLock = 'book.renumberInProgress';

/**
 * Ce qui remplace le document ouvert. `untitled` : un tampon sans titre.
 * `detach` : hors de tout document et en lecture seule, le temps qu'un changement
 * de projet se fasse. `discardOutgoing` saute l'écriture du sortant : seulement
 * après un accord explicite de l'auteur. `text` rend à un tampon sans titre le texte
 * qu'un détachement lui a pris (`detachedText`), si le changement de projet n'a rien
 * mis à sa place.
 */
export type BufferTarget =
  | { kind: 'open'; filePath: string }
  | { kind: 'untitled'; discardOutgoing?: true; text?: string }
  | { kind: 'detach'; discardOutgoing?: true };

/**
 * Pourquoi le document change : pour le journal et, hors de tout document, pour
 * laisser au changement de projet en cours le soin de sortir de `detach`.
 */
export type BufferReason =
  | 'open-file'
  | 'new-document'
  | 'project-switch'
  | 'project-open'
  | 'project-restore'
  | 'project-close';

/**
 * `unchanged` : le fichier demandé est déjà là, rien n'a bougé. `superseded` : une
 * demande plus récente, ou un verrou entre-temps, a pris le pas. `cancelled` :
 * l'auteur a refusé d'abandonner un tampon sans titre. `locked` : refusé par le
 * verrou de bascule, à dire à l'auteur (`lock` est la clé i18n du motif). Un détachement
 * rend ce qu'il a quitté : le chemin du fichier (`detachedFrom`), ou le texte d'un tampon
 * sans titre (`detachedText`), qui n'existe nulle part ailleurs.
 */
export type BufferOutcome =
  | { status: 'replaced'; detachedFrom?: string | null; detachedText?: string }
  | { status: 'unchanged' }
  | { status: 'superseded' }
  | { status: 'cancelled' }
  | { status: 'locked'; lock: EditorSwitchLock };

/**
 * Le document demandé n'a pas pu être lu. `absent` est le seul cas où le créer ne peut
 * rien écraser ; sous `unreadable` (droits, encodage, chemin refusé), le fichier reste tel quel.
 */
export class EditorFileError extends Error {
  readonly code: 'absent' | 'unreadable';
  readonly reason: string | undefined;

  constructor(code: 'absent' | 'unreadable', reason: string | undefined, message: string) {
    super(message);
    this.name = 'EditorFileError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Le document sortant n'a pas pu s'écrire, et le remplacement s'arrête là : rien n'a été
 * lu. L'erreur garde le message de l'écriture, pour le journal et pour qui l'affiche tel quel.
 */
export class OutgoingSaveError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'OutgoingSaveError';
  }
}

const NOT_UTF8_KEY = 'editor.notUtf8';

/**
 * Le message d'une ouverture impossible. Un fichier qui n'est pas en UTF-8 est refusé
 * exprès, et l'auteur peut y remédier : « introuvable ou illisible » l'enverrait ailleurs.
 * De même quand c'est le document ouvert qui ne s'écrit pas : le fichier demandé n'y est
 * pour rien, et c'est le texte à l'écran qui n'est pas enregistré.
 */
export function openErrorKey(error: unknown, fallbackKey: string): string {
  if (error instanceof OutgoingSaveError) return 'toolbar.saveError';
  return error instanceof EditorFileError && error.reason === 'encoding' ? NOT_UTF8_KEY : fallbackKey;
}

/**
 * Un brouillon ne devient jamais du texte sans décision : soit une proposition, dont on
 * suit le sort par son identifiant, soit rien, et l'appelant garde le texte.
 */
export type DraftInsertion = { mode: 'cursor'; proposalId: string } | { mode: 'unavailable' };

/** `saveFileAs` n'est pas un remplacement : le document reste, seul son chemin change. */
export type SaveAsOutcome =
  | { status: 'saved' }
  | { status: 'superseded' }
  | { status: 'locked'; lock: EditorSwitchLock };

interface EditorState {
  // Content
  content: string;
  filePath: string | null;
  isDirty: boolean;
  /**
   * Horodatage (ms) de la dernière sauvegarde réussie du fichier courant,
   * `null` tant que rien n'a été écrit. Alimente l'indicateur de la barre
   * d'état : sur un manuscrit long, ne pas savoir si son texte est sur le
   * disque est anxiogène (audit item 20).
   */
  lastSavedAt: number | null;

  // Settings
  settings: EditorSettings;

  // Preview
  showPreview: boolean;

  /**
   * Façade éditeur-agnostique posée par l'éditeur CM6 au montage.
   * Point de contact unique pour les Slides, l'IPC et les insertions.
   */
  editorFacade: EditorFacade | null;

  /**
   * Incrémenté à chaque remplacement du document (`replaceBuffer`) : l'éditeur
   * CM6 se recrée sur ce signal au lieu d'observer `content` (interdit — boucle
   * de resynchronisation). Une vue n'appartient à son document que tant que ce
   * numéro ne change pas. Le chemin ne le dit pas : il reste le même quand on
   * relit un fichier, et change sans remplacement au premier enregistrement.
   */
  documentVersion: number;

  /**
   * La vue est hors de tout document (`detach`) : lecture seule, pas de cache, et
   * seul le changement de projet en cours remplace le tampon.
   */
  bufferDetached: boolean;

  /**
   * Tant qu'il est posé, le document ouvert ne peut pas être remplacé ; sa
   * valeur est la clé i18n du motif. Une renumérotation écrit le manuscrit
   * chapitre par chapitre en s'appuyant sur le chapitre ouvert : le changer
   * sous elle envoyait le texte d'un chapitre dans le fichier d'un autre.
   */
  switchLock: EditorSwitchLock | null;
  setSwitchLock: (lock: EditorSwitchLock | null) => void;

  // Actions
  setContent: (content: string) => void;
  /**
   * La seule porte pour remplacer le document ouvert : elle écrit le sortant,
   * demande avant d'abandonner un tampon sans titre, laisse gagner la dernière
   * demande et refuse sous le verrou. Rejette si le sortant ne peut pas être écrit
   * ou si le fichier demandé ne peut pas être lu : rien n'a alors changé.
   */
  replaceBuffer: (next: BufferTarget, reason: BufferReason) => Promise<BufferOutcome>;
  loadFile: (filePath: string) => Promise<BufferOutcome>;
  saveFile: () => Promise<void>;
  saveFileAs: (filePath: string) => Promise<SaveAsOutcome>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: () => Promise<BufferOutcome>;

  updateSettings: (settings: Partial<EditorSettings>) => void;
  togglePreview: () => void;
  setEditorFacade: (facade: EditorFacade | null) => void;
  /** Contenu réel : l'éditeur vivant s'il est monté, sinon le miroir du store. */
  getLiveContent: () => string;

  insertText: (text: string) => void;
  insertCitation: (citationKey: string) => void;
  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => void;
  insertTextAtCursor: (text: string) => void;

  /**
   * Propose un brouillon au curseur de l'auteur (fusion 2.6, A13 option a), ou
   * en fin de document s'il n'y a posé aucun curseur. Sans éditeur capable de
   * recevoir une proposition, rien n'entre nulle part : `unavailable`.
   */
  insertDraftAtCursor: (
    draft: string,
    source?: { model?: string; task?: string }
  ) => DraftInsertion;

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => { definitionPosition: number; footnoteNumber: number } | null;
}

// MARK: - Default settings

const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 14,
  theme: 'dark',
  wordWrap: true,
  showPreview: false,
  previewPosition: 'right',
  showMinimap: true,
  fontFamily: 'system',
  autoSave: true,
  autoSaveDelay: 3000, // 3 seconds
};

// MARK: - La porte

/**
 * Le document a-t-il du texte à écrire ?
 *
 * On compare le texte VIVANT au miroir du store, pas seulement `isDirty` : la
 * synchronisation CM6 → store est debouncée, et une frappe pendant une écriture
 * n'est dans aucun des deux drapeaux. C'est précisément la fenêtre qui perdait
 * des données.
 */
export function needsFlush(state: {
  filePath: string | null;
  isDirty: boolean;
  live: string;
  mirror: string;
}): boolean {
  if (!state.filePath) return false;
  return state.isDirty || state.live !== state.mirror;
}

/** Une demande de remplacement chasse la précédente, et la pose du verrou aussi. */
let bufferRequestSeq = 0;

/** On peut taper pendant l'écriture : quelques passes, pas une boucle sans fin. */
const MAX_FLUSH_PASSES = 3;

function openDocumentNeedsFlush(): boolean {
  const state = useEditorStore.getState();
  return needsFlush({
    filePath: state.filePath,
    isDirty: state.isDirty,
    live: state.getLiveContent(),
    mirror: state.content,
  });
}

/**
 * Écrit le document ouvert tant qu'il reste du texte à écrire. Un échec d'écriture
 * remonte. `stillWanted` arrête la boucle quand l'écriture suivante n'a plus d'objet.
 */
export async function writeOpenDocumentWhileDirty(stillWanted: () => boolean = () => true): Promise<void> {
  for (let pass = 0; pass < MAX_FLUSH_PASSES && openDocumentNeedsFlush(); pass += 1) {
    await useEditorStore.getState().saveFile();
    if (!stillWanted()) break;
  }
}

/**
 * À relever avant d'écrire : rend vrai si l'échec de cette écriture n'a plus d'objet. Le
 * document a été remplacé et n'est plus à l'écran, ou une autre écriture a tout mis sur le
 * disque entre-temps. Un document propre au départ reste signalé : son fichier n'est
 * peut-être plus là, et la pastille dirait « Enregistré ».
 */
export function watchSaveOvertaken(): () => boolean {
  const { documentVersion, lastSavedAt } = useEditorStore.getState();
  return () => {
    const now = useEditorStore.getState();
    return now.documentVersion !== documentVersion || (now.lastSavedAt !== lastSavedAt && !now.isDirty);
  };
}

/**
 * Met le document sortant à l'abri. Rend faux si l'auteur refuse d'abandonner un
 * tampon sans titre. Un échec d'écriture remonte : les modifications seraient
 * perdues sans un mot si le remplacement continuait. Une demande chassée entre-temps
 * s'arrête là : l'écriture suivante n'est plus la sienne.
 */
async function flushOutgoing(request: number): Promise<boolean> {
  const state = useEditorStore.getState();
  if (!state.filePath) {
    if (state.getLiveContent() === '') return true;
    return useDialogStore.getState().showConfirm(i18n.t('editor.discardUntitledConfirm'));
  }
  try {
    await writeOpenDocumentWhileDirty(() => request === bufferRequestSeq);
  } catch (error) {
    throw new OutgoingSaveError(error);
  }
  return true;
}

async function readDocumentFromDisk(filePath: string): Promise<string> {
  logger.ipc('editor.loadFile', { filePath });
  const result = await window.electron.editor.loadFile(filePath);
  logger.ipc('editor.loadFile response', result);
  if (result.success) return result.content;
  // Une réponse qui ne le dit pas n'est jamais « absent » : ce cas autorise à créer le fichier.
  throw new EditorFileError(
    result.code === 'absent' ? 'absent' : 'unreadable',
    result.reason,
    result.reason === 'encoding' ? i18n.t(NOT_UTF8_KEY) : result.error || 'Failed to load file'
  );
}

// MARK: - Store

export const useEditorStore = create<EditorState>((set, get) => ({
  content: '',
  filePath: null,
  isDirty: false,
  lastSavedAt: null,
  settings: DEFAULT_SETTINGS,
  showPreview: false,
  editorFacade: null,
  documentVersion: 0,
  bufferDetached: false,
  switchLock: null,

  setSwitchLock: (lock: EditorSwitchLock | null) => {
    // Une lecture partie avant le verrou porte le texte d'avant l'opération : sans
    // cela, elle aboutirait après lui et la frappe suivante le réécrirait.
    if (lock) bufferRequestSeq += 1;
    set({ switchLock: lock });
  },

  setContent: (content: string) => {
    set({
      content,
      isDirty: true,
    });
  },

  replaceBuffer: async (next: BufferTarget, reason: BufferReason): Promise<BufferOutcome> => {
    logger.store('Editor', 'replaceBuffer called', { next, reason });
    const openPath = next.kind === 'open' ? next.filePath : null;

    // Hors de tout document, le changement de projet a la main. Rouvrir un fichier du
    // projet qu'on quitte y ramènerait l'éditeur, et la frappe suivante irait vers un
    // chemin que le main refuse dès qu'il a basculé.
    if (get().bufferDetached && (reason === 'open-file' || reason === 'new-document')) {
      return { status: 'superseded' };
    }

    // Le verrou se contrôle en tête et de nouveau à l'arrivée : la demande partie
    // avant lui ne doit pas aboutir sous l'opération qu'il protège. Rouvrir le
    // fichier ouvert ne bascule rien : il n'y a rien à refuser, ni rien à relire.
    // Un tampon détaché n'a aucun document à protéger, et y rester figerait l'éditeur.
    const refusedByLock = (): BufferOutcome | null => {
      const { switchLock, filePath, bufferDetached } = get();
      if (!switchLock || bufferDetached) return null;
      return openPath !== null && openPath === filePath
        ? { status: 'unchanged' }
        : { status: 'locked', lock: switchLock };
    };
    const refusedAtHead = refusedByLock();
    if (refusedAtHead) return refusedAtHead;

    bufferRequestSeq += 1;
    const request = bufferRequestSeq;
    const refusedOnArrival = (): BufferOutcome | null =>
      refusedByLock() ?? (request === bufferRequestSeq ? null : { status: 'superseded' });

    const commit = (text: string, untitledLeft: string | null = null): BufferOutcome => {
      const detachedFrom = get().filePath;
      set((state) => ({
        content: text,
        filePath: openPath,
        // Un texte rendu à un tampon sans titre n'est toujours écrit nulle part.
        isDirty: openPath === null && text !== '',
        // Nouveau document : l'indicateur ne doit pas dater d'un autre.
        lastSavedAt: null,
        documentVersion: state.documentVersion + 1,
        bufferDetached: next.kind === 'detach',
        // La vue sortante n'est détruite qu'au commit React : d'ici là, sa façade
        // ferait lire son texte sous le chemin du document entrant.
        editorFacade: null,
      }));
      logger.store('Editor', 'Buffer replaced', { reason, contentLength: text.length });
      if (next.kind !== 'detach') return { status: 'replaced' };
      return { status: 'replaced', detachedFrom, ...(untitledLeft ? { detachedText: untitledLeft } : {}) };
    };

    // Déjà ouvert : un tampon modifié n'a rien à attendre du disque, et le recharger
    // jetterait les frappes et l'annulation. Un tampon propre ne reprend le disque que
    // si le fichier a changé dehors. Le miroir a bougé pendant la lecture : l'auteur a
    // tapé puis enregistré, et ce texte lu peut dater d'avant son écriture.
    if (openPath !== null && openPath === get().filePath) {
      if (openDocumentNeedsFlush()) return { status: 'unchanged' };
      const mirrorAtRead = get().content;
      const text = await readDocumentFromDisk(openPath);
      const stale = refusedOnArrival();
      if (stale) return stale;
      const { content: mirror } = get();
      if (openDocumentNeedsFlush() || mirror !== mirrorAtRead || text === mirror) {
        return { status: 'unchanged' };
      }
      return commit(text);
    }

    // Le fichier sortant est écrit AVANT toute chose : sans cela, les frappes des
    // dernières secondes étaient perdues (useAutoSave annule son minuteur quand
    // `filePath` change) et le contenu sortant finissait écrit dans le fichier
    // entrant. L'écriture lit l'éditeur vivant, donc y compris ce que la
    // synchronisation debouncée n'a pas encore poussé. Un tampon détaché n'a rien à
    // garder : ce qui s'y trouverait n'y est pas venu de l'auteur, et une question
    // à ce moment-là laisserait le projet ouvert sur un éditeur figé.
    const outgoingDetached = get().bufferDetached;
    const keepOutgoing = !outgoingDetached && (next.kind === 'open' || !next.discardOutgoing);
    if (keepOutgoing && !(await flushOutgoing(request))) return { status: 'cancelled' };
    const staleAfterFlush = refusedOnArrival();
    if (staleAfterFlush) return staleAfterFlush;

    // Un tampon sans titre n'a nulle part où s'écrire : son texte de cet instant est
    // le seul que l'auteur a accepté de perdre, ou qui était vide.
    const untitledText = get().filePath || outgoingDetached ? null : get().getLiveContent();

    const text =
      openPath !== null
        ? await readDocumentFromDisk(openPath)
        : next.kind === 'untitled' && next.text
          ? next.text
          : '';
    const staleAfterRead = refusedOnArrival();
    if (staleAfterRead) return staleAfterRead;

    // L'auteur a pu taper pendant ces attentes. Comme plus bas pour un fichier, on ne
    // l'interrompt pas pour perdre ce qu'il écrit.
    if (untitledText !== null && get().getLiveContent() !== untitledText) {
      return { status: 'superseded' };
    }
    if (keepOutgoing && openDocumentNeedsFlush()) {
      await flushOutgoing(request);
      const staleAfterSecondFlush = refusedOnArrival();
      if (staleAfterSecondFlush) return staleAfterSecondFlush;
      // Il tape encore : on ne l'interrompt pas pour perdre ce qu'il écrit.
      if (openDocumentNeedsFlush()) return { status: 'superseded' };
    }

    return commit(text, untitledText);
  },

  loadFile: (filePath: string) => get().replaceBuffer({ kind: 'open', filePath }, 'open-file'),

  saveFile: async () => {
    // La sauvegarde lit l'éditeur vivant, jamais le miroir du store : la
    // synchronisation CM6 → store est debouncée et peut être en retard.
    const content = get().getLiveContent();
    const { filePath, documentVersion } = get();
    logger.store('Editor', 'saveFile called', { filePath, contentLength: content.length });

    if (!filePath) {
      // Hors de tout document, le sortant est déjà écrit : Enregistrer n'a rien à
      // proposer. L'erreur ouvrirait le dialogue « Enregistrer sous ».
      if (get().bufferDetached) return;
      throw new Error('No file path specified. Use saveFileAs instead.');
    }

    try {
      logger.ipc('editor.saveFile', { filePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(filePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        // L'éditeur a pu changer de document pendant l'écriture : ce texte n'est
        // pas le sien. Dans le miroir, une vue l'afficherait à son prochain montage
        // et l'autosave l'écrirait dans le fichier entrant.
        if (get().documentVersion === documentVersion) {
          // L'auteur a pu taper pendant l'écriture : ce qui n'est pas parti reste à écrire,
          // et le miroir ne revient pas au texte d'avant. `lastSavedAt` relance l'autosave.
          const live = get().getLiveContent();
          set({ content: live, isDirty: live !== content, lastSavedAt: Date.now() });
        }
        logger.store('Editor', 'File saved successfully');
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      logger.error('Editor', error);
      throw error;
    }
  },

  saveFileAs: async (newFilePath: string): Promise<SaveAsOutcome> => {
    const { switchLock, documentVersion, bufferDetached } = get();
    // Hors de tout document : ce serait écrire un fichier vide, et donner un chemin
    // à un tampon que le changement de projet va remplacer.
    if (bufferDetached) return { status: 'superseded' };
    if (switchLock) return { status: 'locked', lock: switchLock };

    const content = get().getLiveContent();
    logger.store('Editor', 'saveFileAs called', { newFilePath, contentLength: content.length });

    try {
      logger.ipc('editor.saveFile', { filePath: newFilePath, contentLength: content.length });
      const result = await window.electron.editor.saveFile(newFilePath, content);
      logger.ipc('editor.saveFile response', result);

      if (result.success) {
        // Mêmes gardes qu'une bascule : le fichier est écrit, mais le tampon ne
        // change pas de chemin sous une opération verrouillée, et le texte d'un
        // document remplacé pendant l'écriture n'a pas à entrer dans le miroir.
        const { switchLock: lockOnArrival } = get();
        if (lockOnArrival) return { status: 'locked', lock: lockOnArrival };
        if (get().documentVersion !== documentVersion) return { status: 'superseded' };
        // Ce qui a été tapé pendant l'écriture reste à écrire, désormais par l'autosave.
        const live = get().getLiveContent();
        set({
          content: live,
          filePath: newFilePath,
          isDirty: live !== content,
          lastSavedAt: Date.now(),
        });
        logger.store('Editor', 'File saved successfully as', { newFilePath });
        return { status: 'saved' };
      }
      throw new Error(result.error || 'Failed to save file');
    } catch (error) {
      logger.error('Editor', error);
      throw error;
    }
  },

  updateSettings: (newSettings: Partial<EditorSettings>) => {
    set((state) => ({
      settings: {
        ...state.settings,
        ...newSettings,
      },
    }));
  },

  togglePreview: () => {
    set((state) => ({
      showPreview: !state.showPreview,
    }));
  },

  setEditorFacade: (facade: EditorFacade | null) => {
    set({ editorFacade: facade });
  },

  getLiveContent: () => {
    const { editorFacade, content } = get();
    return editorFacade ? editorFacade.getValue() : content;
  },

  insertText: (text: string) => {
    set((state) => ({
      content: state.content + text,
      isDirty: true,
    }));
  },

  insertCitation: (citationKey: string) => {
    const citationText = `[@${citationKey}]`;
    get().insertText(citationText);
  },

  saveCurrentFile: async () => {
    await get().saveFile();
  },

  createNewFile: () => get().replaceBuffer({ kind: 'untitled' }, 'new-document'),

  insertFormatting: (type: 'bold' | 'italic' | 'link' | 'citation' | 'table' | 'footnote' | 'blockquote') => {
    logger.store('Editor', 'insertFormatting called', { type });
    const { content, editorFacade } = get();

    // Footnote : offset exact du curseur via la façade.
    if (type === 'footnote') {
      if (editorFacade) {
        get().insertFootnoteAtPosition(editorFacade.getCursorOffset());
      } else {
        logger.error('Editor', 'No editor available for footnote insertion');
      }
      return;
    }

    // Gras/italique : bascule wrap/unwrap via la façade — le remplacement
    // par placeholder écrasait la sélection (#10). Repli sur l'ancien
    // comportement seulement sans façade montée.
    if ((type === 'bold' || type === 'italic') && editorFacade?.toggleInline) {
      editorFacade.toggleInline(type);
      set({ isDirty: true });
      return;
    }

    // Ces gabarits sont écrits DANS le manuscrit de l'auteur, pas dans
    // l'interface : les laisser en français donnait « texte en gras » à un
    // germanophone, à l'intérieur de son propre document.
    const tr = i18n.t.bind(i18n);
    let textToInsert = '';
    switch (type) {
      case 'bold':
        textToInsert = `**${tr('snippets.boldText')}**`;
        break;
      case 'italic':
        textToInsert = `_${tr('snippets.italicText')}_`;
        break;
      case 'link':
        textToInsert = `[${tr('snippets.linkText')}](url)`;
        break;
      case 'citation':
        textToInsert = `[@${tr('snippets.citationKey')}]`;
        break;
      case 'table': {
        const c1 = tr('snippets.column', { n: 1 });
        const c2 = tr('snippets.column', { n: 2 });
        const v1 = tr('snippets.cell', { n: 1 });
        const v2 = tr('snippets.cell', { n: 2 });
        textToInsert = `\n| ${c1} | ${c2} |\n|---|---|\n| ${v1} | ${v2} |\n`;
        break;
      }
      case 'blockquote':
        textToInsert = `\n> ${tr('snippets.quoteFirst')}\n> ${tr('snippets.quoteSecond')}\n`;
        break;
    }

    if (editorFacade) {
      editorFacade.replaceSelection(textToInsert);
      set({ isDirty: true });
      return;
    }

    // Aucun éditeur monté : append au contenu.
    set({
      content: content + textToInsert,
      isDirty: true,
    });
  },

  insertTextAtCursor: (text: string) => {
    logger.store('Editor', 'insertTextAtCursor called', { text });
    const { editorFacade } = get();
    if (editorFacade) {
      editorFacade.replaceSelection(text);
      set({ isDirty: true });
    }
  },

  insertDraftAtCursor: (
    draft: string,
    source?: { model?: string; task?: string }
  ): DraftInsertion => {
    const { editorFacade } = get();
    if (!editorFacade) return { mode: 'unavailable' };

    // Le draft IA passe par le CONTRAT PROPOSITIONNEL (Phase 4b) —
    // proposition d'insertion adjudicable, jamais d'écriture directe
    // (« aucune fonctionnalité IA d'écriture ne contourne cette API »,
    // docs/editor-proposals.md). Le document ne change qu'à l'acceptation.
    // Les offsets de la façade comptent une fin de ligne pour un caractère : dans un fichier CRLF,
    // ils ne tombent juste que sur le texte en LF. Accepter rend au fichier ses fins de ligne.
    const value = editorFacade.getValue();
    const current = detectLineSeparator(value) === '\r\n' ? value.replace(/\r\n/g, '\n') : value;
    // Sans curseur posé par l'auteur, l'offset 0 serait au-dessus du titre.
    const offset = editorFacade.hasKnownCursor() ? editorFacade.getCursorOffset() : current.length;
    const newContent = insertDraftAtOffset(current, offset, draft);
    // L'ancre est le curseur, et le segment tout ce que insertDraftAtOffset pose après lui, padding
    // de bloc compris. Le premier point de divergence des deux chaînes ne le dit pas : ce padding
    // ressemble aux fins de ligne qui suivent, et un balayage quittait le curseur pour le bloc
    // suivant, où la frappe d'après un rejet serait tombée.
    const at = Math.min(offset, current.length);
    const inserted = newContent.slice(
      at,
      at + (newContent.length - current.length)
    );
    const proposalId = crypto.randomUUID();
    const proposed = editorFacade.propose({
      id: proposalId,
      range: { from: at, to: at },
      original: '',
      proposed: inserted,
      category: 'brainstorm-draft',
      // L'appelant (AssistantChat) transmet le modèle actif quand il le
      // connaît — le store éditeur ne se couple pas au store chat.
      source: {
        model: source?.model ?? 'unknown',
        task: source?.task ?? 'brainstorm',
      },
    });
    if (!proposed) return { mode: 'unavailable' };
    editorFacade.focus();
    return { mode: 'cursor', proposalId };
  },

  // Direct footnote insertion - returns definition position for scrolling
  insertFootnoteAtPosition: (markdownPosition: number) => {
    const content = get().getLiveContent();

    // Prochain numéro par parse Lezer : un `[^99]` dans un bloc de code
    // n'est pas une note (l'ancienne regex comptait tout le contenu).
    const footnoteNumber = nextFootnoteNumber(content);

    const refText = `[^${footnoteNumber}]`;
    const defText = `[^${footnoteNumber}]: `;

    // Insert reference at the specified position
    const beforeRef = content.slice(0, markdownPosition);
    const afterRef = content.slice(markdownPosition);

    // Check if there are existing footnote definitions at the end
    // and insert the new definition before them
    const defRegex = /\n\n(\[\^\d+\]:[\s\S]*)$/;
    const defMatch = afterRef.match(defRegex);

    let newContent: string;
    let definitionPosition: number;

    if (defMatch) {
      // There are existing definitions - insert new def after them (at the end)
      const afterRefWithoutDefs = afterRef.slice(0, defMatch.index);
      const existingDefs = defMatch[1].trimEnd();
      newContent = beforeRef + refText + afterRefWithoutDefs + '\n\n' + existingDefs + '\n\n' + defText;
      // Definition position is at the very end, after the defText marker
      definitionPosition = newContent.length;
    } else {
      // No existing definitions - add at the end
      const trimmedAfter = afterRef.trimEnd();
      newContent = beforeRef + refText + trimmedAfter + '\n\n' + defText;
      // Definition position is at the end, after the defText marker
      definitionPosition = beforeRef.length + refText.length + trimmedAfter.length + 2 + defText.length;
    }

    logger.store('Editor', 'Footnote inserted at position', {
      number: footnoteNumber,
      position: markdownPosition,
      definitionPosition,
    });

    const { editorFacade } = get();
    if (editorFacade) {
      // L'éditeur reçoit l'édition directement, curseur dans la définition.
      editorFacade.setValue(newContent, definitionPosition);
      editorFacade.focus();
      set({ content: newContent, isDirty: true });
    } else {
      set({ content: newContent, isDirty: true });
    }

    return { definitionPosition, footnoteNumber };
  },
}));
