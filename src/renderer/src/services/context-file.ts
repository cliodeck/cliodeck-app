import type { TFunction } from 'i18next';
import { detectLineSeparator } from '@/editor/cm/fidelity';
import { useEditorStore, writeOpenDocumentWhileDirty } from '../stores/editorStore';
import { logger } from '../utils/logger';

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
 * Lit `context.md`, sans lever. Ouvert dans l'éditeur, il s'écrit d'abord : le texte qui compte
 * est celui de l'éditeur vivant, et partir de l'ancien mènerait droit à un conflit dès l'autosave.
 */
export async function readContextFile(): Promise<ContextResponse> {
  const { hints } = window.electron.fusion;
  try {
    const first = (await hints.read()) as ContextResponse;
    if (!first.success || !(await openedAs(first.hints.sourcePath))) return first;
    await writeOpenDocumentWhileDirty();
    return (await hints.read()) as ContextResponse;
  } catch (error) {
    return failureOf(error);
  }
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
  const outcome = await editor.loadFile(filePath).catch((error: unknown) => {
    logger.error('ContextFile', error);
    return null;
  });
  if (outcome?.status === 'replaced') {
    // Le fichier vient de s'écrire : la barre d'état ne doit pas dire « Non enregistré ».
    useEditorStore.setState({ lastSavedAt: Date.now() });
    return true;
  }
  // Une autre demande a pris le pas (changement de projet, autre document) : elle relit le disque.
  if (outcome?.status === 'superseded') return true;
  const now = useEditorStore.getState();
  if (now.filePath !== filePath || withoutBom(now.getLiveContent()) === withoutBom(written)) return true;
  await now.saveFile().catch((error: unknown) => logger.error('ContextFile', error));
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
    if (written.success && opened && !(await bufferFollowed(opened, markdown))) {
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
