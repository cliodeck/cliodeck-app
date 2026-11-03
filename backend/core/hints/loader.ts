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
 */

import fs from 'fs/promises';
import path from 'path';
import { workspaceFiles } from '../workspace/layout.js';
import { isInsideAsync } from '../vector-store/file-identity.js';
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
 * injecter son exemple dans les projets déjà créés.
 */
const LEGACY_PLACEHOLDER_MARKERS = [
  'Décrivez ici le contexte de votre recherche',
  'Ce contexte sera utilisé pour améliorer les réponses',
];

export interface ContextSource {
  /** Chemin absolu du fichier (qu'il existe ou non). */
  sourcePath: string;
  /** Contenu utile, gabarit et commentaires retirés. Vide si rien à injecter. */
  content: string;
  present: boolean;
}

export interface WorkspaceHints {
  /** Markdown brut du fichier principal (`context.md`), tel qu'écrit. */
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
  if (!trimmed) return '';
  // Gabarit hérité laissé tel quel : inerte, comme le gabarit actuel.
  if (LEGACY_PLACEHOLDER_MARKERS.some((marker) => trimmed.includes(marker))) {
    return '';
  }
  return trimmed;
}

/** Le texte de ce fichier du projet ; `null` s'il est absent, illisible ou lié dehors. */
async function readInsideProject(workspaceRoot: string, sourcePath: string): Promise<string | null> {
  try {
    if (!(await isInsideAsync(workspaceRoot, sourcePath))) {
      console.warn(`[hints] ${sourcePath} est un lien qui sort du projet : il n'est pas lu.`);
      return null;
    }
    return await fs.readFile(sourcePath, 'utf8');
  } catch {
    return null;
  }
}

function toSource(sourcePath: string, raw: string | null): ContextSource {
  if (raw === null) return { sourcePath, content: '', present: false };
  const content = extractContextContent(raw);
  return { sourcePath, content, present: content.length > 0 };
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

  const [contextRaw, hintsRaw] = await Promise.all([
    readInsideProject(workspaceRoot, contextPath),
    readInsideProject(workspaceRoot, hintsPath),
  ]);
  const context = toSource(contextPath, contextRaw);
  const legacyHints = toSource(hintsPath, hintsRaw);

  const parts = [context.content, legacyHints.content].filter(Boolean);
  const normalized = parts.join('\n\n');

  return {
    raw: contextRaw ?? '',
    normalized,
    sourcePath: contextPath,
    present: normalized.length > 0,
    sources: { context, legacyHints },
  };
}

/** Écrit le fichier de contexte visible du projet. */
export async function writeWorkspaceHints(
  workspaceRoot: string,
  markdown: string
): Promise<void> {
  const contextPath = path.join(workspaceRoot, CONTEXT_FILE);
  // `writeFile` suit les liens, y compris un lien cassé : le fichier s'écrirait dehors.
  if (!(await isInsideAsync(workspaceRoot, contextPath))) {
    throw new Error(`${CONTEXT_FILE} est un lien qui sort du projet : il n'a pas été réécrit.`);
  }
  await fs.writeFile(contextPath, markdown, 'utf8');
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
