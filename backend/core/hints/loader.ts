/**
 * Contexte de projet — chargeur et injection de prompt.
 *
 * Historique : deux mécanismes concurrents ont coexisté. `.cliodeck/hints.md`
 * (goose lesson #3, `.cliohints`) était injecté à chaque conversation mais
 * enfoui dans un dossier caché ; `context.md`, à la racine du projet, était
 * créé d'office avec la promesse écrite qu'il « sera utilisé pour améliorer
 * les réponses de l'assistant IA » — et **personne ne le lisait**. Le fichier
 * découvrable était mort, le fichier vivant était caché.
 *
 * `context.md` est désormais la face visible : l'historien l'ouvre et l'édite
 * comme n'importe quel document, il se versionne avec le projet.
 * `.cliodeck/hints.md` reste lu quand il existe — les projets qui s'en
 * servent déjà ne perdent rien — et les deux sources sont concaténées.
 *
 * **Piège traité** : `context.md` naît avec un gabarit d'instructions. Injecter
 * ce gabarit apprendrait au modèle un sujet de recherche qui n'est pas celui
 * de l'utilisateur (l'ancien exemple parlait d'intelligence artificielle dans
 * l'éducation supérieure). Le gabarit est donc inerte par construction — ses
 * instructions vivent dans un commentaire HTML, invisible au rendu et retiré
 * ici — et l'ancien gabarit littéral est reconnu et ignoré pour les projets
 * déjà créés.
 *
 * Les outils MCP externes NE DOIVENT PAS recevoir ce contexte sans opt-in
 * explicite : il peut contenir des jugements historiographiques privés.
 *
 * Un lien qui sort du projet n'est ni lu ni réécrit (décision Q16) : un projet
 * reçu garde ses liens, et ce fichier partirait dans un message `system` à
 * chaque tour, sans que l'auteur ait rien demandé.
 *
 * Absent, illisible et lié dehors sont trois états : seul le premier peut se
 * créer. L'injection les traite tous comme vides, un tour de chat n'échoue pas
 * pour son contexte, mais l'interface les distingue (`unreadable`).
 */

import path from 'path';
import { workspaceFiles } from '../workspace/layout.js';
import { isInsideAsync } from '../vector-store/file-identity.js';
import { atomicWriteFile, readUserFile, updateFile, type UserFileRead } from '../fs/user-files.js';
import type { ChatMessage } from '../llm/providers/base.js';

/** Nom du fichier de contexte, à la racine du projet. */
export const CONTEXT_FILE = 'context.md';

/**
 * Gabarit d'un `context.md` neuf. Les instructions sont dans un commentaire
 * HTML : invisibles au rendu markdown, retirées avant injection, donc un
 * fichier jamais édité n'apprend rien au modèle.
 */
export const CONTEXT_TEMPLATE = `# Contexte du projet

<!--
  Décrivez ici le contexte de votre recherche : sujet, période, corpus,
  angle d'analyse, conventions que l'assistant doit respecter (style de
  citation, langue, façon de nommer les sources).

  Ce texte est transmis à l'assistant au début de chaque conversation.
  Tant que ce fichier ne contient que ces instructions, rien n'est envoyé.
-->
`;

/**
 * Ancien gabarit, écrit par les versions antérieures. Reconnu pour ne pas
 * injecter ses paragraphes dans les projets déjà créés.
 */
const LEGACY_PLACEHOLDER_MARKERS = [
  'Décrivez ici le contexte de votre recherche',
  'Ce contexte sera utilisé pour améliorer les réponses',
  'Exemple : "Cette recherche porte sur l',
];

const isLegacyPlaceholder = (text: string): boolean =>
  LEGACY_PLACEHOLDER_MARKERS.some((marker) => text.includes(marker));

export type ContextUnreadableReason =
  | Extract<UserFileRead, { kind: 'unreadable' }>['reason']
  | 'outside-project';

export interface ContextSource {
  /** Chemin absolu du fichier (qu'il existe ou non). */
  sourcePath: string;
  /** Contenu utile, gabarit et commentaires retirés. Vide si rien à injecter. */
  content: string;
  present: boolean;
  /** Vide, ou gabarit laissé tel quel : rien de l'auteur à préserver. */
  blank: boolean;
  /** Le fichier est là, mais on ne l'a pas lu : ne jamais le prendre pour un absent à créer. */
  unreadable?: { reason: ContextUnreadableReason };
}

export interface WorkspaceHints {
  /** Markdown brut du fichier principal (`context.md`), à l'octet près. Vide s'il n'a pas été lu. */
  raw: string;
  /** Contenu prêt à injecter — les deux sources concaténées. */
  normalized: string;
  /** Chemin du fichier principal, édité par les réglages. */
  sourcePath: string;
  /** Vrai si au moins une source apporte du contenu. */
  present: boolean;
  /** Détail par source, pour l'interface. */
  sources: { context: ContextSource; legacyHints: ContextSource };
}

/**
 * Retire ce qui ne doit jamais atteindre le modèle : commentaires HTML
 * (les instructions du gabarit), titre de tête, et gabarits hérités.
 */
export function extractContextContent(raw: string): string {
  let text = raw.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/^\s*#\s+[^\n]*\n?/, '');
  const trimmed = text.trim();
  if (!isLegacyPlaceholder(trimmed)) return trimmed;
  // Gabarit hérité : ses paragraphes sont inertes, comme le gabarit actuel. Ce qui a été
  // écrit autour reste, à commencer par ce que l'assistant de démarrage y ajoute.
  return trimmed
    .split(/\n\s*\n/)
    .filter((paragraph) => !isLegacyPlaceholder(paragraph))
    .join('\n\n')
    .trim();
}

/**
 * Rien de l'auteur dans ce fichier ? Se juge sur le texte brut, pas sur
 * `extractContextContent` : il retire aussi des consignes écrites dans un commentaire et
 * des titres qu'il reste à remplir, et ce qui n'atteint pas le modèle reste le texte de
 * l'auteur. L'ancien gabarit n'en fait pas partie : il passe par une question.
 */
function isBlankContext(raw: string): boolean {
  return raw.trim() === '' || raw.trimEnd() === CONTEXT_TEMPLATE.trimEnd();
}

type SourceRead =
  | Exclude<UserFileRead, { kind: 'unreadable' }>
  | { kind: 'unreadable'; reason: ContextUnreadableReason };

/** Le texte de ce fichier du projet, sans lever : le tour de chat en dépend. */
async function readInsideProject(workspaceRoot: string, sourcePath: string): Promise<SourceRead> {
  if (!(await isInsideAsync(workspaceRoot, sourcePath))) {
    console.warn(`[hints] ${sourcePath} est un lien qui sort du projet : il n'est pas lu.`);
    return { kind: 'unreadable', reason: 'outside-project' };
  }
  const read = await readUserFile(sourcePath);
  if (read.kind === 'unreadable') console.warn(`[hints] ${sourcePath} n'est pas lu : ${read.message}`);
  return read;
}

function toSource(sourcePath: string, read: SourceRead): ContextSource {
  if (read.kind === 'unreadable') {
    return { sourcePath, content: '', present: false, blank: false, unreadable: { reason: read.reason } };
  }
  const raw = read.kind === 'ok' ? read.content : '';
  const content = extractContextContent(raw);
  return { sourcePath, content, present: content.length > 0, blank: isBlankContext(raw) };
}

/**
 * Charge le contexte d'un projet : `context.md` (face visible) puis
 * `.cliodeck/hints.md` (hérité, toujours honoré).
 */
export async function loadWorkspaceHints(
  workspaceRoot: string
): Promise<WorkspaceHints> {
  const contextPath = path.join(workspaceRoot, CONTEXT_FILE);
  const hintsPath = workspaceFiles(workspaceRoot).hints;

  const [contextRead, hintsRead] = await Promise.all([
    readInsideProject(workspaceRoot, contextPath),
    readInsideProject(workspaceRoot, hintsPath),
  ]);
  const context = toSource(contextPath, contextRead);
  const legacyHints = toSource(hintsPath, hintsRead);

  const parts = [context.content, legacyHints.content].filter(Boolean);
  const normalized = parts.join('\n\n');

  return {
    raw: contextRead.kind === 'ok' ? contextRead.content : '',
    normalized,
    sourcePath: contextPath,
    present: normalized.length > 0,
    sources: { context, legacyHints },
  };
}

/** Le fichier a changé depuis qu'on l'a lu : l'écrire effacerait ce qui s'y est ajouté. */
export class ContextConflictError extends Error {
  readonly code = 'context_conflict';

  constructor() {
    super(`${CONTEXT_FILE} a changé depuis sa lecture : il n'a pas été réécrit.`);
    this.name = 'ContextConflictError';
  }
}

/** Un refus, ni un conflit ni un fichier illisible : relire n'y changera rien. */
export class ContextOutsideProjectError extends Error {
  readonly code = 'context_outside_project';

  constructor() {
    super(`${CONTEXT_FILE} est un lien qui sort du projet : il n'a pas été réécrit.`);
    this.name = 'ContextOutsideProjectError';
  }
}

/**
 * Écrit le fichier de contexte visible du projet, tout entier ou pas du tout. Avec
 * `expectedRaw`, seulement s'il est resté tel que `loadWorkspaceHints` l'a lu : les
 * deux lectures rendent les mêmes octets, BOM et fins de ligne compris. Un fichier
 * disparu depuis se recrée : ce qui s'écrit part de ce qui a été lu. Un fichier illisible
 * lève `UnreadableFileError`, sans être touché.
 */
export async function writeWorkspaceHints(
  workspaceRoot: string,
  markdown: string,
  options?: { expectedRaw?: string }
): Promise<void> {
  const contextPath = path.join(workspaceRoot, CONTEXT_FILE);
  // L'écriture suit les liens, y compris un lien cassé : le fichier s'écrirait dehors.
  if (!(await isInsideAsync(workspaceRoot, contextPath))) throw new ContextOutsideProjectError();
  const expectedRaw = options?.expectedRaw;
  if (expectedRaw === undefined) {
    await atomicWriteFile(contextPath, markdown);
    return;
  }
  await updateFile(contextPath, (current) => {
    if (current !== null && current !== expectedRaw) throw new ContextConflictError();
    return markdown;
  });
}

const HEADER = 'Contexte du projet, fourni par l’auteur';
const FOOTER = 'Fin du contexte.';

function wrap(hints: WorkspaceHints): string {
  return `[${HEADER}]\n${hints.normalized}\n[${FOOTER}]`;
}

/**
 * Prepend a `system` message carrying the context to an existing chat. If the
 * conversation already opens with a `system` message, the context is merged
 * into a *new* leading system message so both stay distinguishable for
 * compactor logic (meta.ragCitation=false, ordinary system).
 */
export function prependAsSystemMessage(
  messages: ChatMessage[],
  hints: WorkspaceHints
): ChatMessage[] {
  if (!hints.present) return messages;
  return [{ role: 'system', content: wrap(hints) }, ...messages];
}

/**
 * Wrap a bare prompt string with a context preamble. Recipes / one-shot
 * `llm.complete` calls use this when they don't have a message array.
 */
export function prependAsPrompt(prompt: string, hints: WorkspaceHints): string {
  if (!hints.present) return prompt;
  return `${wrap(hints)}\n\n${prompt}`;
}
