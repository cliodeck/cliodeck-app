# ADR 0001 — RAG pipeline arbitration: keep ClioDeck, defer full unification

Status: accepted — 2026-04-13
Context: fusion step 2.4 (see `docs/archive/fusion-cliobrain-implementation-plan.md`)

## Decision

On the RAG pipeline consolidation, **keep ClioDeck's implementations** of `HybridSearch`, `BM25Index`, `ContextCompressor`, and `VectorStore`. Do **not** swap to the ClioBrain equivalents as the plan text suggested.

## Rationale

After comparing both codebases head-to-head:

| Parameter | ClioBrain | ClioDeck |
|---|---|---|
| RRF K | 60 | 60 |
| Dense retrieval weight | 0.6 | 0.6 |
| Sparse retrieval weight | 0.4 | 0.4 |
| HybridSearch LOC | 155 | 241 |
| BM25Index LOC | 138 | 239 |
| ContextCompressor LOC | 171 | 316 |

Key findings:

1. **Algorithmic convergence**: both codebases already use RRF K=60 with 60/40 dense/sparse weighting. The plan's headline claim ("Adopter le pipeline ClioBrain") was written against the module map (step 0.2) rather than the source; the sources converge.
2. **ClioDeck is strictly richer**:
   - `HybridSearch` renormalizes weights automatically on `setWeights(...)`; the ClioBrain version does not.
   - `ContextCompressor` has four strategies (incl. query-aware sentence extraction that preserves chunks containing query terms); ClioBrain has three threshold bands (light / medium / aggressive).
   - `BM25Index` has more thorough tokenization and position tracking.
3. **No meaningful behavioral gap on the happy path** — a switch would be pure churn for less functionality.

## What's preserved from ClioBrain

The following ideas came through the fusion and are already incorporated elsewhere:

- **Three-level compression threshold model** (15k / 30k char bands) — already reconciled inside ClioDeck's richer compressor; its `small/medium/aggressive` strategy selection covers the same cases with additional query-awareness.
- **`ContextCompressor` applied to `SearchResult` streams** — this call pattern is the one `HybridSearch` already feeds; no change needed.

## What is actually still to do on 2.4

The plan's "branching chunking PDF/OCR de ClioDeck en amont" is partly a non-issue (ClioDeck is already upstream), but one real dependency remains:

**`ObsidianVaultIndexer` reactivation** (deferred from step 2.1).

The indexer was not ported in 2.1 because it consumes `DocumentChunk` / `VectorStore` / `BM25Index` / `OllamaClient` types that are PDF-centric in ClioDeck (`PDFDocument.pageCount`, `DocumentChunk.pageNumber`). Reactivating it requires one of:

- **Path A — generalise** `PDFDocument` → `SourceDocument` with a `sourceType` discriminant across the entire vector-store surface. Touches `EnhancedVectorStore`, `HNSWVectorStore`, `PrimarySourcesVectorStore`, IPC handlers, renderer search components. 1–2 days, high blast radius.
- **Path B — parallel store** (now tracked as step 2.4b): give the Obsidian indexer its own SQLite + HNSW files under `.cliodeck/obsidian-vectors.db`, independent of the PDF vector store. Unification to Path A happens when its value exceeds the cost — likely after Phase 3 UI surfaces both sources in Brainstorm.

We proceed with **Path B** first to unblock Phase 3, reserving Path A for a dedicated PR with a benchmark (per the fusion plan's risks table: "Divergence qualité RAG après fusion 2.4 — Élevé").

## Consequences

- The plan's section 2.4 text is superseded by this ADR; follow-up commits reference 2.4b (Path B) instead of a literal "adopt ClioBrain" swap.
- A RAG benchmark (ClioDeck PDF pipeline before vs after any future unification) becomes a blocking artifact for Path A. It does not block 2.4b.
- ClioBrain's `DocumentIngestionPipeline` is not ported — ClioDeck already has `pdf-service.ts` fulfilling that role for PDFs. A parallel `obsidian-service.ts` arrives with 2.4b.

---

## Amendement du 2026-09-14 — Path A′ : un contrat commun, pas un schéma commun

### Constat

Le Path B a fait des petits : non pas deux stores parallèles mais **quatre** — bibliographie (`pdf_*`), archives (`tropy_*`), notes (`obsidian_*`), manuscrit (`manuscript_*`). Depuis le 2026-05-12, ils partagent un fichier (`brain.db`), et rien d'autre : chacun a son store, sa recherche hybride et sa manière de noter un extrait.

Ce dernier point avait un coût visible, que ce document et `path-a-readiness.md` disaient nul. Les extraits des quatre corpus sont triés **ensemble** puis coupés à `topK`, alors qu'ils ne parlaient pas la même échelle :

- le vault publiait un score RRF (maximum 1/61 ≈ 0,016) face aux cosinus des autres (0,3 à 0,8) : ses notes n'obtenaient une place que s'il en restait — le défaut corrigé pour le manuscrit en rc.4, resté ici ;
- Tropy ramenait tout seuil à 0,005, conversion pensée pour des scores RRF que son store ne publiait plus : aucun extrait d'archive n'était filtré, et le repli en gardait `topK` quand aucun ne passait ;
- un extrait trouvé seulement par mot-clé portait un cosinus de 0 dans Tropy — précisément le cas d'un nom propre dans un OCR.

### Décision

**Le Path A — un schéma `SourceDocument` unique pour tous les corpus — n'est plus la cible.** Bibliographie, archives, notes et manuscrit sont de nature différente : métadonnées, langue, bruit OCR et usages n'ont pas grand-chose en commun, et les fondre dans une table obligerait à réintroduire leurs différences en cas particuliers. La décision est celle de l'auteur du projet, le 2026-09-14.

On adopte à la place le **Path A′** : chaque corpus garde ses tables, son store et sa recherche, mais tous respectent un **contrat** :

1. **Une échelle de pertinence** — `backend/core/rag/relevance.ts`. Le RRF choisit quels extraits un corpus renvoie ; la pertinence publiée (`similarity`) est `max(cosinus, pertinence du rang lexical)`, avec les constantes que `HybridSearch` appliquait déjà aux PDF. Les rangs BM25 se comparent d'un index à l'autre, les scores bruts non.
2. **Une forme d'appel** — `CorpusRetriever` dans `backend/core/rag/retrievers/corpus.ts`. `RetrievalService.search` parcourt une liste de corpus (`fanOutCorpora`) au lieu d'enchaîner quatre blocs recopiés ; la portée est une table de vérité unique (`corporaInScope`).
3. **Un seuil par corpus, assumé.** Même valeur pour tous aujourd'hui, mais une politique de repli différente : bibliographie et archives gardent trois extraits quand aucun ne passe (une question peut changer de langue) ; notes et manuscrit se taisent (écrits par l'historien, dans sa langue — un extrait hors seuil prendrait la place d'une source pertinente, et le quota du manuscrit ne doit servir que « quand il a quelque chose à dire »).

### Conséquences

- Plus de migration de schéma ni de reconstruction d'index HNSW à prévoir.
- Ajouter un corpus : un adaptateur `CorpusRetriever` et une valeur de `CorpusId`, sans toucher au tri, au quota ni à l'inspecteur de sécurité. C'est aussi le préalable à des corpus fournis par des extensions.
- **Le benchmark reste utile, mais change de rôle** : il ne conditionne plus une unification ; il servira à calibrer le seuil et les constantes de pertinence **par corpus**, qui ne sont aujourd'hui calibrés sur aucun jeu de référence. Il n'est pas urgent.
- Limite connue, non traitée ici : dans le vault et le manuscrit, la fusion RRF sans bonus de correspondance exacte (que PDF et Tropy appliquent) empêche un extrait trouvé seulement par mot-clé d'entrer dans les `topK` du store dès que le corpus compte plus de `topK` extraits : son RRF (0,4/61) reste inférieur à celui des 31 premiers rangs denses (0,6/(60+r)).
