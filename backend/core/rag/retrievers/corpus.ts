/**
 * Interface commune des corpus de recherche (Path A′, amendement de l'ADR 0001).
 *
 * ClioDeck interroge quatre corpus de nature différente — bibliographie (PDF),
 * archives (Tropy), notes (vault Obsidian), manuscrit de l'auteur — et le
 * Path A′ assume cette différence : chaque corpus garde ses tables, son store
 * et sa recherche. Ce qu'ils partagent, c'est un **contrat** :
 *
 *   1. une forme d'appel — `CorpusRetriever.search(query, options)` ;
 *   2. une échelle de pertinence — `backend/core/rag/relevance.ts`.
 *
 * Avant, `RetrievalService.search` enchaînait quatre blocs écrits à la main,
 * chacun avec son objet de résultat, ses mesures de durée et sa gestion
 * d'erreur recopiée. Ajouter un corpus voulait dire recopier un cinquième
 * bloc. Désormais le service construit une liste de retrievers et la parcourt.
 */

/** Les corpus connus, dans l'ordre où leurs résultats sont rapportés. */
export type CorpusId = 'secondary' | 'primary' | 'vault' | 'manuscript';

export const CORPUS_ORDER: readonly CorpusId[] = [
  'secondary',
  'primary',
  'vault',
  'manuscript',
];

/**
 * Portée demandée par l'appelant.
 *
 * `sourceType` : 'secondary' = bibliographie, 'primary' = archives,
 * 'both' = les deux, 'vault' = notes seules, 'manuscript' = manuscrit seul.
 * `includeVault` / `includeManuscript` ajoutent notes et manuscrit aux deux
 * premiers — ce sont des opt-in : un appelant historique ne les voit jamais.
 */
export interface CorpusScopeQuery {
  sourceType?: 'secondary' | 'primary' | 'both' | 'vault' | 'manuscript';
  includeVault?: boolean;
  includeManuscript?: boolean;
}

/**
 * Corpus interrogés pour une portée donnée. Table de vérité unique, testée
 * isolément, au lieu de quatre conditions dispersées dans `search()`.
 */
export function corporaInScope(q: CorpusScopeQuery): Set<CorpusId> {
  const sourceType = q.sourceType || 'both';
  const scope = new Set<CorpusId>();
  if (sourceType === 'secondary' || sourceType === 'both') scope.add('secondary');
  if (sourceType === 'primary' || sourceType === 'both') scope.add('primary');
  // Le mode « notes seules » implique les notes, quel que soit le drapeau.
  if (q.includeVault || sourceType === 'vault') scope.add('vault');
  if (q.includeManuscript || sourceType === 'manuscript') scope.add('manuscript');
  return scope;
}

/** Options transmises à chaque corpus. Un corpus ignore ce qu'il ne sait pas filtrer. */
export interface CorpusSearchOptions {
  topK: number;
  /** Seuil sur l'échelle commune de pertinence (cosinus). */
  threshold: number;
  /** Bibliographie seulement : restreindre à ces documents. */
  documentIds?: string[];
  /** Bibliographie seulement : restreindre à ces collections Zotero. */
  collectionKeys?: string[];
}

/**
 * Un corpus interrogeable. `similarity` de chaque extrait DOIT respecter le
 * contrat de `relevance.ts` : c'est ce qui rend le tri commun légitime.
 */
export interface CorpusRetriever<THit extends { similarity: number }> {
  readonly corpus: CorpusId;
  search(query: string, options: CorpusSearchOptions): Promise<THit[]>;
}

/**
 * Issue d'un corpus pour une requête (fusion 1.7 — succès partiel de plein
 * droit). Un corpus peut être hors portée, réussir avec N extraits, réussir
 * avec 0, ou échouer : l'appelant doit pouvoir distinguer « Tropy était
 * vide » de « Tropy a planté ».
 */
export interface RetrievalSourceOutcome {
  source: CorpusId;
  /** Vrai si le corpus était dans la portée demandée. */
  attempted: boolean;
  /** Vrai si la recherche du corpus s'est terminée sans exception. */
  ok: boolean;
  /** Extraits apportés par ce corpus AVANT le tri et la coupe communs. */
  hitCount: number;
  /** Durée de la recherche en ms (seulement quand `attempted`). */
  durationMs?: number;
  /** Message d'erreur quand `ok === false`. */
  error?: string;
}

export interface FanOutResult<THit> {
  /** Tous les extraits, corpus confondus, non triés. */
  hits: THit[];
  /** Toujours une issue par corpus connu, dans `CORPUS_ORDER`. */
  outcomes: RetrievalSourceOutcome[];
}

/**
 * Interroge les corpus de la portée, un par un, et rapporte l'issue de chacun.
 *
 * Séquentiel à dessein : c'était le comportement d'avant, et Tropy et la
 * bibliographie embarquent la requête chacun de leur côté — les lancer en
 * parallèle doublerait les appels simultanés à un Ollama local.
 *
 * L'échec d'un corpus n'emporte jamais les autres.
 */
export async function fanOutCorpora<THit extends { similarity: number }>(
  retrievers: readonly CorpusRetriever<THit>[],
  scope: ReadonlySet<CorpusId>,
  query: string,
  options: CorpusSearchOptions,
  onError?: (corpus: CorpusId, error: unknown) => void
): Promise<FanOutResult<THit>> {
  const byCorpus = new Map(retrievers.map((r) => [r.corpus, r]));
  const hits: THit[] = [];
  const outcomes: RetrievalSourceOutcome[] = [];

  for (const corpus of CORPUS_ORDER) {
    const outcome: RetrievalSourceOutcome = {
      source: corpus,
      attempted: false,
      ok: false,
      hitCount: 0,
    };
    outcomes.push(outcome);

    const retriever = byCorpus.get(corpus);
    if (!scope.has(corpus) || !retriever) continue;

    outcome.attempted = true;
    const t0 = Date.now();
    try {
      const found = await retriever.search(query, options);
      hits.push(...found);
      outcome.ok = true;
      outcome.hitCount = found.length;
    } catch (error: unknown) {
      outcome.error = error instanceof Error ? error.message : String(error);
      onError?.(corpus, error);
    } finally {
      outcome.durationMs = Date.now() - t0;
    }
  }

  return { hits, outcomes };
}
