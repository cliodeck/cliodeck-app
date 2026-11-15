/**
 * L'index de recherche d'un corpus se construit (E3) : une reconstruction en cours
 * (`EnhancedVectorStore.search`), ou la toute première indexation d'un PDF, dont les embeddings se
 * calculent avant que le moindre extrait n'entre dans SQLite (`retrievalService`, qui le sait par
 * `pdfService`). Le corpus n'a pas pu être interrogé, mais il n'est ni en panne ni vide :
 * `fanOutCorpora` le rapporte « en indexation », et le chat dit « indexation en cours » au lieu de
 * « Bibliographie : échec » ou de « Bibliographie 0 ».
 *
 * Un index vide que rien ne construit reste une panne : une `Error` ordinaire.
 */
export class SearchIndexBuildingError extends Error {
  readonly code = 'search_index_building' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SearchIndexBuildingError';
  }
}
