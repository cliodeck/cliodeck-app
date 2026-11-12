/**
 * Retriever `pdf-lexical` du banc RAG : la part lexicale de la recherche des PDF, par le code de l'app.
 *
 * Le retriever `bm25` du banc (`in-memory-bm25.ts`) est une implémentation à part, avec son propre
 * tokeniseur : il ne mesure ni `BM25Index` ni `HybridSearch`, qu'emploie la recherche des PDF, et un
 * changement de l'un ou de l'autre ne s'y voit pas. Celui-ci passe par eux, dans l'ordre de l'app
 * (`EnhancedVectorStore.search`, puis `SecondaryRetriever`) :
 *   1. `BM25Index` indexe et cherche ;
 *   2. `HybridSearch` fusionne les rangs, bonus « mot-clé exact » compris, et coupe à `topK` ;
 *   3. le tri final suit la pertinence publiée (`similarity`), comme `SecondaryRetriever`.
 *
 * Aucun embedding : la jambe dense est un index HNSW vide, créé en mémoire, qui ne rend rien
 * (`HNSWVectorStore.search` s'arrête sur un index vide, sans lire le vecteur de la requête). Le banc
 * reste reproductible, sans Ollama, modèle embarqué ni service en ligne ; un extrait que seul le sens
 * rapproche de la question n'y est donc jamais trouvé.
 *
 * Le banc ne passe pas par l'expansion FR → EN de `SecondaryRetriever`. Elle touche pourtant au
 * lexical : dès qu'une question contient un terme du dictionnaire, `SecondaryRetriever` lance une
 * recherche BM25 de plus par variante traduite. Aucune question du jeu de contrôle n'en contient : un
 * jeu qui en ajouterait mesurerait ici moins que l'app. Le seuil de pertinence ne s'applique pas non
 * plus : il ne coupe aucun extrait classé par BM25 (`SPARSE_FLOOR` est au-dessus du seuil par défaut).
 */

import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { BM25Index } from '../../search/BM25Index.js';
import { HybridSearch } from '../../search/HybridSearch.js';
import { HNSWVectorStore } from '../../vector-store/HNSWVectorStore.js';
import type { DocumentChunk } from '../../../types/pdf-document.js';
import type { BenchmarkHit, Retriever } from '../benchmark.js';

/** Dimension de l'index dense vide : il n'est jamais interrogé, seule sa présence compte. */
const EMPTY_DENSE_DIMENSION = 1;

export function pdfLexicalRetriever(): Retriever {
  const bm25 = new BM25Index();
  const hybrid = new HybridSearch();
  hybrid.setBM25Index(bm25);

  return {
    async index(docs) {
      bm25.clear();
      // Un dossier qui n'existe pas : l'index se crée en mémoire, rien n'est lu ni écrit sur le disque.
      const dense = new HNSWVectorStore(
        path.join(os.tmpdir(), `cliodeck-banc-${randomUUID()}`),
        EMPTY_DENSE_DIMENSION,
        1
      );
      await dense.initialize();
      hybrid.setHNSWStore(dense);

      const chunks: DocumentChunk[] = docs.flatMap((d) =>
        d.chunks.map((c, i) => ({
          id: c.id,
          documentId: d.id,
          content: c.content,
          pageNumber: 1,
          chunkIndex: i,
          startPosition: 0,
          endPosition: c.content.length,
        }))
      );
      bm25.addChunks(chunks);
    },

    async search(queryText, topK) {
      const results = await hybrid.search(
        queryText,
        new Float32Array(EMPTY_DENSE_DIMENSION),
        topK
      );
      return results
        .slice()
        .sort((a, b) => b.similarity - a.similarity)
        .map((r): BenchmarkHit => ({ chunkId: r.chunk.id, score: r.similarity }));
    },
  };
}
