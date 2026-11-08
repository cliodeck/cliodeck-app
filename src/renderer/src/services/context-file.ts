import type { TFunction } from 'i18next';
import { detectLineSeparator } from '@/editor/cm/fidelity';
import type { EditorFacade } from '@/editor/facade';
import { useEditorStore, writeOpenDocumentWhileDirty } from '../stores/editorStore';
import { logger } from '../utils/logger';
import { waitForEditorFacade } from './wait-for-facade';

/**
 * `context.md` s'écrit depuis trois portes : la zone des Réglages, l'assistant de démarrage et
 * l'éditeur, qui l'ouvre comme n'importe quel document. Chacune écrivait d'un bloc ce qu'elle
 * avait en main, et chacune effaçait les autres : un paragraphe ajouté dans les Réglages
 * disparaissait à la frappe suivante dans l'éditeur, deux pages de consignes au passage de
 * l'assistant.
 *
 * Les deux premières passent donc par ici. Le texte de l'éditeur part d'abord sur le disque,
 * l'écriture n'a lieu que sur le texte lu, et l'éditeur relit ensuite le fichier. Pas de fusion :
 * un conflit se dit, et chacun garde son texte.
 */

export interface ContextSourceView {
  sourcePath: string;
  content: string;
  present: boolean;
  blank: boolean;
  unreadable?: { reason: string };
}

export interface ContextHints {
  raw: string;
  normalized: string;
  sourcePath: string;
  present: boolean;
  sources: { context: ContextSourceView; legacyHints: ContextSourceView };
}

export interface ContextFailure {
  error: string;
  reason?: string;
}

export type ContextResponse = { success: true; hints: ContextHints } | ({ success: false } & ContextFailure);

/** Le texte lu, et d'où : l'écriture s'y réfère pour ne rien effacer, ni écrire ailleurs. */
export interface ContextGuard {
  expectedRaw: string;
  sourcePath: string;
  projectPath: string;
}

const BOM = '﻿';
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

function failureOf(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/** Le chemin du document ouvert, s'il s'agit de ce fichier. */
async function openedAs(sourcePath: string): Promise<string | null> {
  const { filePath } = useEditorStore.getState();
  if (!filePath) return null;
  return (await window.electron.fs.sameFile(filePath, sourcePath)) ? filePath : null;
}

/**
 * Le disque n'a plus rien de l'auteur, et l'éditeur tient encore son texte : le fichier a été
 * supprimé, vidé ou remis au gabarit dehors. Le tampon est propre, rien ne l'écrirait, et
 * l'écriture qui suit croirait n'avoir rien à préserver avant de le remplacer.
 */
function heldOnlyByEditor({ raw, sources }: ContextHints): boolean {
  const live = useEditorStore.getState().getLiveContent();
  return sources.context.blank && live.trim() !== '' && withoutBom(live) !== withoutBom(raw);
}

/**
 * Lit `context.md`, sans lever. Ouvert dans l'éditeur, il s'écrit d'abord : le texte qui compte
 * est celui de l'éditeur vivant, et partir de l'ancien mènerait droit à un conflit dès l'autosave.
 */
export async function readContextFile(): Promise<ContextResponse> {
  const { hints } = window.electron.fusion;
  try {
    const first = (await hints.read()) as ContextResponse;
    if (!first.success || !(await openedAs(first.hints.sourcePath))) return first;
    if (heldOnlyByEditor(first.hints)) await useEditorStore.getState().saveFile();
    await writeOpenDocumentWhileDirty();
    return (await hints.read()) as ContextResponse;
  } catch (error) {
    return failureOf(error);
  }
}

/** La première ligne (1-indexée) où `after` diffère de `before`, `null` s'ils ont les mêmes lignes. */
function firstChangedLine(before: string, after: string): number | null {
  const was = before.split(/\r\n|\r|\n/);
  const now = after.split(/\r\n|\r|\n/);
  for (let i = 0; i < Math.max(was.length, now.length); i += 1) {
    if (was[i] !== now[i]) return i + 1;
  }
  return null;
}

/**
 * Le rechargement recrée la vue en haut du fichier : un paragraphe ajouté à la fin d'un long
 * `context.md` restait hors de l'écran, et l'éditeur semblait ne pas l'avoir. La première ligne
 * changée y est amenée, curseur compris, dès que la nouvelle vue est montée. Sans le focus : les
 * Paramètres sont encore ouverts par-dessus, et une frappe partirait dans l'éditeur, derrière eux.
 */
async function revealChange(previous: EditorFacade | null, version: number, line: number): Promise<void> {
  const facade = await waitForEditorFacade(previous);
  // Éditeur non monté (autre mode), ou un autre document a pris la place : rien à montrer.
  if (!facade || useEditorStore.getState().documentVersion !== version) return;
  facade.revealLine(line, { focus: false });
}

/** L'éditeur montre toujours ce fichier, mais pas ce qui vient de s'y écrire. */
function stillShowsOtherText(filePath: string, written: string): boolean {
  const now = useEditorStore.getState();
  return now.filePath === filePath && withoutBom(now.getLiveContent()) !== withoutBom(written);
}

/**
 * L'éditeur reprend ce qui vient de s'écrire, par la seule porte qui remplace un document. Il
 * repart d'un état neuf : l'annulation se vide, et Cmd+Z ne ramène pas l'ancien texte.
 *
 * Rend faux si le tampon garde son texte : l'auteur a tapé pendant l'écriture, et une frappe ne
 * se jette pas. L'autosave réécrirait de toute façon ce tampon, sans rien dire. Il est donc écrit
 * tout de suite, et l'appelant annonce le conflit : ce qu'il voulait écrire est toujours chez lui.
 */
async function bufferFollowed(filePath: string, written: string): Promise<boolean> {
  const editor = useEditorStore.getState();
  // L'auteur est passé à un autre document : celui-ci se relira à son retour.
  if (editor.filePath !== filePath) return true;
  const before = editor.getLiveContent();
  const previousFacade = editor.editorFacade;
  // Une autre demande peut prendre le pas sur la relecture sans remplacer ce tampon : un verrou
  // posé puis levé pendant la lecture, une ouverture qui n'aboutit pas. Le tenir pour suivi
  // laissait l'ancien texte à l'écran, propre, et la frappe suivante l'écrivait par-dessus celui
  // des Réglages, sans un mot (BT1-2). On relit donc une fois ; ensuite, c'est un conflit.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await useEditorStore
      .getState()
      .loadFile(filePath)
      .catch((error: unknown) => {
        logger.error('ContextFile', error);
        return null;
      });
    if (outcome?.status === 'replaced') {
      // Le fichier vient de s'écrire : la barre d'état ne doit pas dire « Non enregistré ».
      useEditorStore.setState({ lastSavedAt: Date.now() });
      const { content, documentVersion } = useEditorStore.getState();
      const line = firstChangedLine(before, content);
      if (line !== null) {
        void revealChange(previousFacade, documentVersion, line).catch((error: unknown) =>
          logger.error('ContextFile', error)
        );
      }
      return true;
    }
    // L'éditeur a quitté ce fichier (changement de projet, autre document) ou montre déjà ce
    // texte : rien à relire. Toute autre issue que « remplacé » se règle plus bas.
    if (outcome?.status !== 'superseded' || !stillShowsOtherText(filePath, written)) break;
  }
  if (!stillShowsOtherText(filePath, written)) return true;
  await useEditorStore
    .getState()
    .saveFile()
    .catch((error: unknown) => logger.error('ContextFile', error));
  return false;
}

/** Écrit `context.md` sur le texte lu, sans lever. Rien n'est écrit en cas d'échec. */
export async function saveContextFile(markdown: string, guard: ContextGuard): Promise<ContextResponse> {
  const { expectedRaw, sourcePath, projectPath } = guard;
  try {
    const opened = await openedAs(sourcePath);
    if (opened) await writeOpenDocumentWhileDirty();
    const written = (await window.electron.fusion.hints.write(markdown, {
      expectedRaw,
      projectPath,
    })) as ContextResponse;
    if (!written.success) return written;
    // Un fichier absent n'a pas de chemin réel : ouvert sous une autre casse, puis supprimé
    // dehors, il n'était pas reconnu avant d'être écrit. Il l'est maintenant qu'il existe.
    const shown = opened ?? (await openedAs(sourcePath));
    if (shown && !(await bufferFollowed(shown, markdown))) {
      return { success: false, error: 'context_conflict' };
    }
    return written;
  } catch (error) {
    return failureOf(error);
  }
}

/** Ce fichier est là, mais on ne l'a pas lu : l'interface le dit, et ne propose pas de l'écrire. */
export function unreadableFailure(hints: ContextHints): ContextFailure | null {
  const unreadable = hints.sources.context.unreadable;
  if (!unreadable) return null;
  return unreadable.reason === 'outside-project'
    ? { error: 'context_outside_project' }
    : { error: 'context_unreadable', reason: unreadable.reason };
}

/** Ce qui s'est passé, et ce qui est arrivé au fichier. */
export function contextFailureText(t: TFunction, failure: ContextFailure): string {
  switch (failure.error) {
    case 'context_conflict':
      return t('hints.reasons.conflict');
    case 'context_outside_project':
      return t('hints.reasons.outsideProject');
    case 'context_project_changed':
      return t('hints.reasons.projectChanged');
    case 'context_unreadable':
      return failure.reason === 'encoding' ? t('hints.reasons.notUtf8') : t('hints.reasons.unreadable');
    case 'no_project':
      return t('hints.errors.noProject');
    default:
      return t('hints.reasons.writeFailed', { detail: failure.error });
  }
}

/**
 * Ajoute une section à la suite du texte existant, dans ses fins de ligne. Rend le texte tel
 * quel si cette section s'y trouve déjà : les mêmes réponses n'ont pas à s'ajouter deux fois.
 */
export function appendToContext(raw: string, section: string): string {
  const eol = detectLineSeparator(raw);
  const converted = section.replace(/\n/g, eol);
  if (raw.includes(converted.trimEnd())) return raw;
  return `${raw.trimEnd()}${eol}${eol}${converted}`;
}
