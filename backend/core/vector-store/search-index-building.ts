/**
 * L'index de recherche d'un corpus se construit : une reconstruction en cours, ou la toute première
 * indexation, dont les extraits sont déjà dans SQLite et pas encore dans HNSW (E3). Le corpus n'a pas
 * pu être interrogé, mais il n'est pas en panne : `fanOutCorpora` le rapporte « en indexation », et le
 * chat dit « indexation en cours » au lieu de « Bibliographie : échec ».
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
