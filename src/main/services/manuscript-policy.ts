/**
 * La place du manuscrit dans un tour de chat (docs/poids-du-manuscrit.md,
 * palier 2).
 *
 * Jusqu'au palier 1, le manuscrit entrait dans chaque tour dès que son index
 * était activé. Il entre désormais selon une politique, résolue côté main à
 * chaque tour, par ordre de préséance :
 *
 *   1. une **question de rappel** explicite (« qu'ai-je déjà écrit sur X ? »,
 *      détectée par `detectManuscriptIntent`) l'admet toujours, avec une
 *      bande élargie et la consigne de rappel — même quand la case est
 *      décochée ou le mode le tient à l'écart : la question l'emporte ;
 *   2. la **portée** « manuscrit seul » lui donne toutes les places ;
 *   3. une **portée restreinte** par l'utilisateur (documents choisis,
 *      collection, notes seules) l'écarte : il a dit de quoi il parle ;
 *   4. la **case « Mon manuscrit »** du panneau du chat, épinglée ou laissée
 *      au défaut de l'espace de travail (Brainstorm : non ; ailleurs : oui) ;
 *   5. la **posture du mode de chat** (`ragOverrides.manuscript`) : `off`
 *      l'écarte, `background` le réduit à une ou deux places présentées comme
 *      ce que l'utilisateur pense déjà, `recall` (défaut) lui laisse sa bande.
 *
 * Fonctions pures : l'appelant (`fusion-chat-service`) fournit ce qu'il sait,
 * les tests énumèrent la table.
 */

import type { ManuscriptStance } from '../../../backend/types/mode.js';
import { manuscriptSlots } from './retrieval-quota.js';

/** La consigne qui accompagne les passages du manuscrit dans le prompt. */
export type ManuscriptWording = 'recall' | 'background' | 'only';

export type ManuscriptPolicyReason =
  | 'disabled'
  | 'scope-only'
  | 'recall-intent'
  | 'scope-restricted'
  | 'toggle-off'
  | 'stance-off'
  | 'background'
  | 'default';

/** Les portées que le chat peut demander, « seul » compris. */
export type OwnTextScope = 'primary' | 'secondary' | 'both' | 'vault' | 'manuscript' | 'readingNotes';

export interface ManuscriptPolicyInput {
  /** `rag.indexManuscript` : sans index, rien à interroger. */
  enabled: boolean;
  /**
   * Valeur effective de la case « Mon manuscrit » (épinglée ou défaut de
   * l'espace). `undefined` = appelant historique : admis.
   */
  requested?: boolean;
  sourceType: OwnTextScope;
  documentIds?: string[];
  collectionKeys?: string[];
  /** Posture du mode de chat, telle que lue dans son fichier (non validée). */
  stance?: unknown;
  /** Question de rappel détectée dans le dernier message. */
  recallIntent: boolean;
  topK: number;
}

export interface ManuscriptPolicy {
  /** Le manuscrit est-il interrogé pour ce tour ? */
  include: boolean;
  /** Largeur de sa bande de places (`RetrievalQuery.manuscriptSlots`). */
  slots: number;
  wording: ManuscriptWording;
  /** Posture retenue après validation (`recall` quand le mode n'en dit rien). */
  stance: ManuscriptStance;
  reason: ManuscriptPolicyReason;
}

/** Une question de rappel obtient jusqu'à six passages, jamais toutes les places. */
export const RECALL_MAX_SLOTS = 6;
/** En arrière-plan, deux passages au plus : des repères, pas une matière. */
export const BACKGROUND_MAX_SLOTS = 2;

/** Un fichier de mode peut porter n'importe quoi : tout l'inconnu vaut `recall`. */
export function normalizeStance(raw: unknown): ManuscriptStance {
  return raw === 'off' || raw === 'background' || raw === 'recall' ? raw : 'recall';
}

/**
 * Bande d'une question de rappel : la plus large qui laisse encore une place
 * aux sources — la consigne demande de dire quelles sources étayent ou
 * contredisent les passages. Une seule place : elle va à la question posée.
 */
export function recallSlots(topK: number): number {
  if (topK <= 0) return 0;
  if (topK === 1) return 1;
  return Math.min(topK - 1, RECALL_MAX_SLOTS);
}

/** Bande d'arrière-plan : la bande ordinaire, plafonnée à deux. */
export function backgroundSlots(topK: number): number {
  return Math.min(manuscriptSlots(topK), BACKGROUND_MAX_SLOTS);
}

/**
 * Le manuscrit entre-t-il dans une recherche que l'utilisateur a cadrée ?
 *
 * Jusqu'en 2026-10 il entrait toujours : avec un seul livre sélectionné, le
 * modèle prenait le texte de l'utilisateur pour le livre, et un paragraphe
 * « PÉRIMÈTRE » rattrapait la confusion dans le prompt. Quand l'utilisateur a
 * dit de quoi il parle — des documents choisis, une collection, ses notes
 * seules — c'est de cela qu'il parle.
 */
export function shouldIncludeManuscript(opts: {
  enabled: boolean;
  sourceType: Exclude<OwnTextScope, 'manuscript'>;
  documentIds?: string[];
  collectionKeys?: string[];
}): boolean {
  if (!opts.enabled) return false;
  // Notes seules — Obsidian ou notes de lecture — : l'utilisateur a nommé
  // ce qu'il interroge.
  if (opts.sourceType === 'vault' || opts.sourceType === 'readingNotes') return false;
  if ((opts.documentIds?.length ?? 0) > 0) return false;
  if ((opts.collectionKeys?.length ?? 0) > 0) return false;
  return true;
}

/** Ce qui distingue un corpus de l'autre : sa lecture de la portée demandée. */
interface OwnTextScopeReading {
  /** La portée ne demande que ce corpus : toutes les places, consigne « seul ». */
  only: boolean;
  /**
   * La portée ne demande que le texte de l'auteur et l'inclut explicitement
   * (manuscrit seul avec les notes cochées) : sa bande ordinaire, sans que la
   * posture du mode puisse l'écarter.
   */
  companion: boolean;
  /** L'utilisateur a cadré sa recherche ailleurs : écarté, sauf question de rappel. */
  restricted: boolean;
}

/**
 * Le tronc commun des deux corpus à la voix de l'auteur. Un seul ordre de
 * préséance, pour qu'une règle ajoutée ici vaille pour les deux : index →
 * portée « seul » → compagnon d'une portée « seul » → question de rappel →
 * portée restreinte → case → posture du mode → bande.
 */
function resolveOwnTextPolicy(
  input: { enabled: boolean; requested?: boolean; stance?: unknown; recallIntent: boolean; topK: number },
  scope: OwnTextScopeReading
): ManuscriptPolicy {
  const stance = normalizeStance(input.stance);
  const policy = (
    include: boolean,
    slots: number,
    wording: ManuscriptWording,
    reason: ManuscriptPolicyReason
  ): ManuscriptPolicy => ({ include, slots: include ? slots : 0, wording, stance, reason });

  if (!input.enabled) return policy(false, 0, 'recall', 'disabled');
  if (scope.only) return policy(true, Math.max(0, input.topK), 'only', 'scope-only');
  if (scope.companion) return policy(true, manuscriptSlots(input.topK), 'recall', 'scope-only');
  if (input.recallIntent) return policy(true, recallSlots(input.topK), 'recall', 'recall-intent');
  if (scope.restricted) return policy(false, 0, 'recall', 'scope-restricted');
  if (input.requested === false) return policy(false, 0, 'recall', 'toggle-off');
  if (stance === 'off') return policy(false, 0, 'recall', 'stance-off');
  if (stance === 'background') {
    return policy(true, backgroundSlots(input.topK), 'background', 'background');
  }
  return policy(true, manuscriptSlots(input.topK), 'recall', 'default');
}

export function resolveManuscriptPolicy(input: ManuscriptPolicyInput): ManuscriptPolicy {
  return resolveOwnTextPolicy(input, {
    only: input.sourceType === 'manuscript',
    companion: false,
    restricted:
      input.sourceType !== 'manuscript' &&
      !shouldIncludeManuscript({
        enabled: true,
        sourceType: input.sourceType,
        documentIds: input.documentIds,
        collectionKeys: input.collectionKeys,
      }),
  });
}

export interface ReadingNotesPolicyInput {
  /**
   * `rag.indexReadingNotes`, ET le consentement d'envoi quand le fournisseur
   * de génération est distant (`shouldIncludeReadingNotes`) : les deux
   * conditions d'existence du corpus pour ce tour, décidées par l'appelant.
   */
  enabled: boolean;
  /** Valeur effective de la case « Notes de lecture » ; `undefined` = admis. */
  requested?: boolean;
  sourceType: OwnTextScope;
  /** Posture du mode, celle des notes ou, à défaut, celle du manuscrit. */
  stance?: unknown;
  /** Question de rappel sur les notes (« qu'ai-je noté sur… »). */
  recallIntent: boolean;
  topK: number;
}

/**
 * Les notes de lecture suivent la même préséance que le manuscrit, à une
 * différence près, voulue par l'auteur du projet : une recherche restreinte
 * à des documents ou à une collection ne les écarte pas, elle les **cadre**
 * (`CorpusSearchOptions.readingNoteCitekeys`) — « d'après tes notes sur
 * Braudel » garde son sens quand Braudel est sélectionné. Les notes Obsidian
 * seules (`vault`) les écartent comme le manuscrit : l'utilisateur a nommé
 * ce qu'il interroge. Notes seules (`readingNotes`) : toutes les places ;
 * manuscrit seul avec la case des notes **explicitement** cochée : leur
 * bande ordinaire — un appelant historique qui demande « manuscrit seul »
 * sans rien dire des notes obtient le manuscrit seul.
 */
export function resolveReadingNotesPolicy(input: ReadingNotesPolicyInput): ManuscriptPolicy {
  return resolveOwnTextPolicy(input, {
    only: input.sourceType === 'readingNotes',
    companion: input.sourceType === 'manuscript' && input.requested === true,
    restricted: input.sourceType === 'vault' || input.sourceType === 'manuscript',
  });
}
