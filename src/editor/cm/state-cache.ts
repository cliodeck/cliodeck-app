import { EditorState, type Extension } from '@codemirror/state';
import { historyField } from '@codemirror/commands';
import { detectLineSeparator, readDocText } from './fidelity';

/**
 * Cache d'état par document (plan chapitres, Phase 2).
 *
 * Basculer d'un chapitre à l'autre recrée la vue CM6 : sans cache, on perd
 * l'historique d'annulation, la position du curseur et le défilement — un
 * aller-retour pour vérifier une référence coûtait tout le contexte
 * d'édition.
 *
 * ## Ce qui est conservé, et pourquoi pas le reste
 *
 * On sérialise via `EditorState.toJSON` en ne déclarant QUE le champ
 * `history`. Conséquence voulue : le document, la sélection et l'annulation
 * traversent la bascule, tandis que les `StateField` de nos extensions
 * (propositions, rendu live, appareil savant) sont reconstruits à neuf par
 * les extensions fraîches.
 *
 * C'est délibéré et non un pis-aller :
 *
 * - **Propositions IA** — la destruction de la vue émet déjà `expired` pour
 *   les propositions en attente (`proposalExpiry`, arbitrage 5 du plan CM6).
 *   Les restaurer ferait réapparaître une proposition que les journaux ont
 *   enregistrée comme expirée : deux événements contradictoires pour un
 *   même identifiant. Tant que l'expiration n'est pas rendue consciente de
 *   la bascule, ne pas les restaurer est la seule option cohérente.
 * - **Instances d'extensions** — un `StateField` restauré appartient à
 *   l'instance qui l'a créé. Réutiliser l'ancien état avec des extensions
 *   neuves ferait échouer `state.field(...)` ; réutiliser les anciennes
 *   extensions figerait les libellés i18n et les résolveurs. La
 *   sérialisation JSON coupe court aux deux.
 *
 * ## Règle de fraîcheur : le disque fait foi
 *
 * Un état n'est restauré que si son document est **identique** au contenu
 * que le store vient de charger. Un fichier modifié hors ClioDeck, ou un
 * `createNewFile` qui remplace le contenu, invalide donc le cache — on
 * repart du texte réel plutôt que de ressusciter un tampon périmé.
 */

/** Nombre de documents mémorisés avant éviction du plus ancien. */
const MAX_CACHED_DOCUMENTS = 24;

export interface CachedEditorState {
  /** `EditorState.toJSON({ history })` — doc, sélection, annulation. */
  json: unknown;
  /** Texte exact au moment de la mise en cache (séparateur compris). */
  text: string;
  /** Défilement en pixels, restauré après le premier rendu. */
  scrollTop: number;
}

/** Champs sérialisés en plus du document et de la sélection. */
const SERIALIZED_FIELDS = { history: historyField };

export function serializeEditorState(
  state: EditorState,
  scrollTop: number
): CachedEditorState {
  // `toJSON` sérialise le document via `doc.toString()`, qui ignore le
  // séparateur déclaré : on mémorise à part le texte exact, seul juge de la
  // fraîcheur de l'entrée (un fichier CRLF ne doit pas paraître périmé).
  return {
    json: state.toJSON(SERIALIZED_FIELDS),
    text: readDocText(state),
    scrollTop,
  };
}

/**
 * Reconstruit un état depuis le cache, ou `null` si l'entrée est périmée.
 * `source` est la vérité (contenu chargé depuis le disque) : c'est lui, et
 * non le JSON, qui décide de la validité et du séparateur de ligne.
 */
export function restoreEditorState(
  cached: CachedEditorState | undefined,
  source: string,
  extensions: Extension[]
): EditorState | null {
  if (!cached || cached.text !== source) return null;
  const json = cached.json as { doc?: unknown } | null;
  if (!json || typeof json.doc !== 'string') return null;

  try {
    const restored = EditorState.fromJSON(
      json,
      {
        extensions: [
          EditorState.lineSeparator.of(detectLineSeparator(source)),
          ...extensions,
        ],
      },
      SERIALIZED_FIELDS
    );
    // Garde-fou : `fromJSON` reconstruit le document depuis un texte joint
    // en "\n". Si la restauration ne rend pas le texte d'origine (fichier
    // CRLF), on repart du contenu disque plutôt que de le normaliser.
    return readDocText(restored) === source ? restored : null;
  } catch {
    // Un JSON d'une version antérieure du schéma d'historique ne doit jamais
    // empêcher d'ouvrir un chapitre : on repart d'un état neuf.
    return null;
  }
}

/**
 * Cache borné, ordonné par usage (le plus récemment touché en dernier).
 * Les clés sont des chemins de fichiers absolus : pas de collision entre
 * projets.
 */
export class EditorStateCache {
  private readonly entries = new Map<string, CachedEditorState>();

  constructor(private readonly maxSize: number = MAX_CACHED_DOCUMENTS) {}

  get(filePath: string): CachedEditorState | undefined {
    const entry = this.entries.get(filePath);
    if (entry) {
      // Remise en tête : Map conserve l'ordre d'insertion.
      this.entries.delete(filePath);
      this.entries.set(filePath, entry);
    }
    return entry;
  }

  set(filePath: string, entry: CachedEditorState): void {
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(filePath: string): void {
    this.entries.delete(filePath);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
