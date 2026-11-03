/**
 * Un événement de la reconstruction des index (HNSW + BM25), du store au renderer.
 *
 * `phase` seule dit où elle en est : le pourcentage ne peut pas le dire, un échec
 * arrive à celui qu'elle avait atteint, et il se lisait comme un début.
 */
export interface RebuildProgressEvent {
  current: number;
  total: number;
  status: string;
  percentage: number;
  phase: 'running' | 'done' | 'failed';
  /** La cause, quand `phase` vaut `failed`. */
  error?: string;
}
