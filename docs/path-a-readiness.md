# Path A readiness — RAG benchmark gate

Status: scaffolded — 2026-04-14 | updated 2026-11-12

## What Path A is

Per [ADR 0001](adr/0001-rag-pipeline-arbitration.md), Path A is the
unification of the Obsidian vault store (the parallel `obsidian_*` tables)
into the main `EnhancedVectorStore` (the `pdf_*` tables) using the generalised
[`SourceDocument` / `SourceChunk` types](../backend/types/source-document.ts).

> **Not to be confused with the file consolidation, which is done.** Since
> 2026-05-12 (commits `3260a40`, `c044d42`, `07741ab`, `a1ca0cb`) every store
> lives in a single `.cliodeck/brain.db`; the former `vectors.db`,
> `primary-sources.db`, `history.db` and `obsidian-vectors.db` are folded in
> by `migrateWorkspaceToFlat` on project load. That change put the corpora in
> one *file*. Path A is about one *schema*: today each corpus still has its
> own tables, its own store class and its own search implementation.

The migration itself is a schema change + a rewrite of every consumer that
narrows on `PDFDocument`. ADR 0001 gates the swap on a benchmark that
proves equivalent retrieval quality before vs after.

## What ships in this commit

- **`cliodeck rag-benchmark`** — CLI command driving `runBenchmark`
  ([`backend/core/rag/benchmark.ts`](../backend/core/rag/benchmark.ts))
  on a user-supplied corpus + queries fixture.
- **`inMemoryBM25Retriever`** ([source](../backend/core/rag/retrievers/in-memory-bm25.ts))
  — deterministic, dependency-free Okapi BM25 baseline. Useful for
  validating the harness end-to-end and for measuring how much hybrid
  search adds on top of pure lexical retrieval. Attention : c'est sa propre
  implémentation, avec son propre tokeniseur ; elle ne dit rien de la
  recherche de l'app (voir `pdf-lexical`, plus bas).

What is **not** shipped: a real `EnhancedVectorStoreRetriever` adapter.
That requires wiring an embedding provider through the CLI (Ollama or a
cloud key), and the comparison only makes sense once the unified store
exists. Both arrive in the swap PR.

## What the user must supply

A pair of JSON files:

### `corpus.json`
```json
[
  {
    "id": "d1",
    "chunks": [
      { "id": "d1-c1", "content": "<chunk text>" },
      { "id": "d1-c2", "content": "<chunk text>" }
    ]
  }
]
```
Match the `BenchmarkDoc` type:

```ts
interface BenchmarkDoc {
  id: string;
  chunks: Array<{ id: string; content: string }>;
}
```

### `queries.json`
```json
[
  {
    "id": "q1",
    "text": "<query as the historian would type it>",
    "relevant": ["d1-c1", "d2-c3"]
  }
]
```
Match the `BenchmarkQuery` type:

```ts
interface BenchmarkQuery {
  id: string;
  text: string;
  relevant: string[];   // chunk ids judged relevant by a human
}
```

`relevant` is the gold-standard signal. **Quality of the benchmark =
quality of these judgments.** Anything below ~30 queries with explicit
relevance judgments is too noisy to ship a Path A decision on.

## Running

Build first (the CLI lives in `dist/scripts/cliodeck-cli.js` after build):

```bash
npm run build
node dist/scripts/cliodeck-cli.js rag-benchmark \
  --corpus path/to/corpus.json \
  --queries path/to/queries.json \
  [--retriever bm25|pdf-lexical]
```

Output is JSON: `recall@K`, `hitRate@K`, `mrr`, `latencyMs.p50/p95/mean`,
plus a per-query breakdown (so you can see which queries the retriever
misses: `firstRelevantRank`, `relevantFound` / `relevantCount`).

- `recall@K` — **rappel** : pour chaque question, la part de ses extraits
  pertinents rendus dans le top K, moyennée sur les questions.
- `hitRate@K` — **taux de succès** : la part des questions qui ont au moins
  un pertinent dans le top K.

> **Les `recall` relevés avant le 2026-11-12 ne se comparent pas à ceux
> d'après** (S04-1-20, L07-23). Jusque-là, `recall` publiait le taux de
> succès : une question à trois pertinents dont un seul rendu comptait 1, au
> lieu d'un tiers. Ce chiffre s'appelle désormais `hitRate` ; un relevé
> antérieur se compare sur lui. Rien n'était calibré sur l'ancien `recall`,
> ni seuil ni référence.

## What "ready for Path A" means

The migration PR can land when:

1. A user-supplied gold standard exists (≥30 queries, judged by a
   historian familiar with the corpus).
2. `cliodeck rag-benchmark --retriever bm25` produces a baseline.
3. The Path A retriever — once implemented — produces results within
   ε of the baseline (for `recall@10` and `mrr`), and stays under the
   p95 latency target.

Until those three exist, the parallel-store layout (Path B) stays
shipping.

> **Superseded on 2026-09-14 — see the amendment to
> [ADR 0001](adr/0001-rag-pipeline-arbitration.md).** Path A is no longer
> the target: the four corpora keep their own schemas (**Path A′**) and
> share a relevance contract (`backend/core/rag/relevance.ts`) and a
> retriever interface (`backend/core/rag/retrievers/corpus.ts`). The claim
> that Path B had "no behavioural cost" was wrong: the corpora were sorted
> together on incomparable scores, which kept vault notes out of the
> results and left Tropy unfiltered. The benchmark below is still worth
> building, now to calibrate per-corpus thresholds rather than to gate a
> schema migration.

## Banc de contrôle et relevé de référence (2026-11-12, L07-23)

### Le retriever `pdf-lexical`

[`pdf-lexical.ts`](../backend/core/rag/retrievers/pdf-lexical.ts) mesure la
**part lexicale de la recherche des PDF, par le code de l'app** : le vrai
`BM25Index` indexe et cherche, `HybridSearch` fusionne (bonus « mot-clé
exact » compris) et coupe à `topK`, puis le tri suit la pertinence publiée,
comme `SecondaryRetriever`. Le retriever `bm25` du banc, lui, a son propre
tokeniseur : un correctif de `BM25Index` ou de `HybridSearch` ne s'y voit pas.

**Aucun embedding** : la jambe dense est un index HNSW vide, en mémoire, qui ne
rend rien. Ni Ollama, ni modèle embarqué, ni service en ligne ; le relevé est
reproductible. Ce que le banc ne voit donc pas : un extrait que seul le sens
rapproche de la question, l'expansion FR → EN de `SecondaryRetriever` (elle
ajoute une recherche BM25 par variante traduite ; aucune question du jeu ne
contient de terme du dictionnaire), le seuil de pertinence (il ne coupe rien de
ce que classe BM25).

### Le jeu de contrôle

[`test-fixtures/rag-benchmark/`](../test-fixtures/rag-benchmark/) :
`corpus.json` (24 extraits courts) et `queries.json` (13 questions, 7 en
français, 6 en allemand). Chaque question dit ce qu'elle vise (`cas`) : mots
accentués (« Liège », « Zürich », « Österreich », « État », « ß »), les mêmes
tapés sans accent, un sigle face à des sous-chaînes (« CIA » et
« socialiste », « négociations », « judiciaire »…), des mots vides
(« le », « de », « la »), et quatre témoins sans accent.

**Ce n'est pas l'étalon de l'historien** qu'attend la condition 1 ci-dessus
(au moins 30 questions jugées par un historien sur un corpus réel). La
pertinence y est posée **par construction** : chaque extrait a été écrit pour
les questions qui le désignent. Ce jeu sert à voir ce que change un correctif
de la recherche lexicale — d'abord L07-3, qui le refera après son correctif —,
pas à juger la qualité de la recherche ni à régler un seuil.

### Relevé de référence

`main` à `f6f0f05` plus L07-23, qui ne touche ni `BM25Index` ni
`HybridSearch` : c'est la recherche lexicale d'avant L07-3.

```bash
npm run build:main
for r in bm25 pdf-lexical; do
  bin/cliodeck rag-benchmark --retriever $r \
    --corpus test-fixtures/rag-benchmark/corpus.json \
    --queries test-fixtures/rag-benchmark/queries.json
done
```

| retriever     | recall@1 | recall@10 | hitRate@1 | hitRate@10 | MRR   |
|---------------|----------|-----------|-----------|------------|-------|
| `bm25`        | 0,769    | 0,846     | 0,846     | 0,846      | 0,846 |
| `pdf-lexical` | 0,346    | 0,423     | 0,385     | 0,462      | 0,393 |

Par question (`perQuery` : rang du premier pertinent, pertinents rendus dans
le top 10) :

| question                | cas                             | `bm25`  | `pdf-lexical` |
|-------------------------|---------------------------------|---------|---------------|
| `fr-liege`              | accent                          | 1 · 2/2 | — · 0/2       |
| `fr-liege-sans-accent`  | accent tapé sans accent         | — · 0/2 | — · 0/2       |
| `fr-etat`               | accent parmi des mots vides     | 1 · 1/1 | 9 · 1/1       |
| `fr-revolution`         | accents                         | 1 · 1/1 | — · 0/1       |
| `fr-cia`                | sigle, sous-chaînes, mots vides | 1 · 2/2 | 1 · 1/2       |
| `fr-grenelle`           | témoin                          | 1 · 1/1 | 1 · 1/1       |
| `fr-verdun`             | témoin                          | 1 · 1/1 | 1 · 1/1       |
| `de-zurich`             | accent                          | 1 · 1/1 | — · 0/1       |
| `de-zurich-ohne-umlaut` | accent tapé sans accent         | — · 0/1 | — · 0/1       |
| `de-oesterreich`        | accent                          | 1 · 1/1 | — · 0/1       |
| `de-grossbritannien`    | ß                               | 1 · 1/1 | — · 0/1       |
| `de-gewerkschaften`     | témoin                          | 1 · 1/1 | 1 · 1/1       |
| `de-mauer`              | témoin                          | 1 · 1/1 | 1 · 1/1       |

Ce que le relevé montre de la recherche lexicale de l'app, avant L07-3 :

- **Aucun mot accentué n'est trouvé** (`fr-liege`, `fr-revolution`,
  `de-zurich`, `de-oesterreich`, `de-grossbritannien`) : le tokeniseur de
  `natural` coupe les mots sur chaque lettre accentuée à l'indexation
  (« Liège » devient « li » et « ge »), alors que la requête garde le mot
  entier. `fr-etat` n'est retrouvé qu'au rang 9, par le seul mot vide « de ».
- **Le sigle est battu par des sous-chaînes** (`fr-cia`) : `guatemala-2`, 2e
  en BM25 seul, sort du top 10 après la fusion, où neuf extraits qui
  contiennent « cia » (« socialiste », « provincial », « négociants »,
  « judiciaire »…) reçoivent le bonus « mot-clé exact ». Ils ne sont
  candidats que par les mots vides de la question (« le », « de », « la »,
  « en »). Le taux de succès ne le voit pas (1) ; le rappel, si (1/2).
- Les quatre témoins sont trouvés au rang 1 : le banc ne compte pas pour un
  défaut ce qui n'en est pas un.
- Le `bm25` du banc trouve les mots accentués : il ne mesurait pas la
  recherche de l'app. Ni l'un ni l'autre ne trouve un mot tapé sans son
  accent (« Liege », « Zurich »).

### Relevé après L07-3 (2026-11-12)

Mêmes commandes, même jeu, après L07-3 : `BM25Index` découpe l'index et la
requête par le même `tokenize` (`backend/core/text/normalize.ts` : mots
Unicode entiers, accents repliés, mots vides français, anglais et allemands
retirés des deux côtés, sauf un mot en capitales), et le bonus « mot-clé
exact » de `HybridSearch` ne vaut plus que pour un mot entier, cherché dans
le texte de l'extrait sans son préfixe « [Doc: titre | Section: …] ».

| retriever     | relevé         | recall@1 | recall@10 | hitRate@1 | hitRate@10 | MRR   |
|---------------|----------------|----------|-----------|-----------|------------|-------|
| `bm25`        | avant et après | 0,769    | 0,846     | 0,846     | 0,846      | 0,846 |
| `pdf-lexical` | avant L07-3    | 0,346    | 0,423     | 0,385     | 0,462      | 0,393 |
| `pdf-lexical` | après L07-3    | 0,885    | 1         | 1         | 1          | 1     |

Le `bm25` du banc ne bouge pas : il a son propre tokeniseur. Par question,
pour `pdf-lexical` (rang du premier pertinent · pertinents rendus dans le
top 10) :

| question                | cas                             | avant   | après   |
|-------------------------|---------------------------------|---------|---------|
| `fr-liege`              | accent                          | — · 0/2 | 1 · 2/2 |
| `fr-liege-sans-accent`  | accent tapé sans accent         | — · 0/2 | 1 · 2/2 |
| `fr-etat`               | accent parmi des mots vides     | 9 · 1/1 | 1 · 1/1 |
| `fr-revolution`         | accents                         | — · 0/1 | 1 · 1/1 |
| `fr-cia`                | sigle, sous-chaînes, mots vides | 1 · 1/2 | 1 · 2/2 |
| `fr-grenelle`           | témoin                          | 1 · 1/1 | 1 · 1/1 |
| `fr-verdun`             | témoin                          | 1 · 1/1 | 1 · 1/1 |
| `de-zurich`             | accent                          | — · 0/1 | 1 · 1/1 |
| `de-zurich-ohne-umlaut` | accent tapé sans accent         | — · 0/1 | 1 · 1/1 |
| `de-oesterreich`        | accent                          | — · 0/1 | 1 · 1/1 |
| `de-grossbritannien`    | ß                               | — · 0/1 | 1 · 1/1 |
| `de-gewerkschaften`     | témoin                          | 1 · 1/1 | 1 · 1/1 |
| `de-mauer`              | témoin                          | 1 · 1/1 | 1 · 1/1 |

- **Les mots accentués sont trouvés**, au rang 1, et aussi tapés sans accent
  (« Liege », « Zurich ») : l'index et la requête replient les accents de la
  même façon. « Großbritannien » est un seul mot (« ß » n'est plus un
  séparateur ; il n'est pas replié en « ss », un « Grossbritannien » suisse
  ne le trouverait pas).
- **`fr-etat` passe du rang 9 au rang 1** : « réforme » et « État » sont
  trouvés, et « de » n'est plus un terme de recherche.
- **`fr-cia` rend ses deux pertinents** (`guatemala-1`, puis `guatemala-2`) et
  rien d'autre : les neuf extraits qui contenaient « cia » en sous-chaîne ne
  sont plus candidats (les mots vides ne cherchent plus rien) ni favorisés
  (le bonus veut le mot entier « CIA »).
- Les quatre témoins ne bougent pas. **Aucune question ne recule.**
- `recall@1` reste sous 1 pour une seule raison : trois questions ont deux
  pertinents, et un top 1 n'en contient qu'un.

Après la revue de L07-3, les listes de mots vides ont changé : elles
contiennent les mots-outils des questions (« comment », « pendant »,
« during », « während »), qui sinon valaient un bonus « mot-clé exact », et
un mot vide s'y reconnaît accents compris (« maïs » n'est plus pris pour
« mais », ni « Ware » pour « wäre »). Le relevé, refait avec les mêmes
commandes, est identique question par question, pour `bm25` comme pour
`pdf-lexical` : aucune question du jeu ne contient ces mots. Ce que la
correction change est couvert par les tests de `HybridSearch`
(« Comment la CIA est-elle intervenue ? », et cinq variantes en français,
en anglais et en allemand).

## Recent related work (2026-05-07)

Testing with a real corpus (221 Tropy items, EEC Committee of Governors
minutes, ministral3:3B via Ollama) revealed two issues relevant to
benchmark design:

1. **Hallucination with small models**: 3B models supplement RAG context
   with general knowledge (famous names from the period not in the
   documents). Fixed via strict anti-hallucination system prompts across
   all layers (`formatContextAsSystemPrompt`, built-in modes,
   `DEFAULT_SYSTEM_PROMPTS`). The mode recommendation for
   `primary-source-analyst` suggests 8B+ parameters.

2. **OCR quality visibility**: added per-document and corpus-wide OCR
   quality reports (Tesseract confidence 0-100, chunk quality scores).
   This is important for benchmark design — low-confidence OCR chunks
   introduce noise into retrieval evaluation.

3. ~~**Query expansion gap**~~ — **closed 2026-07-18**: `TropyService` now
   reuses `expandQueryToText` (built-in dictionary +
   `rag.queryExpansionDictionary`), identity when no term matches. Primary
   sources and secondary sources expand queries the same way, so a French
   query no longer under-retrieves against OCR'd text.

## Note on the manuscript corpus (2026-07-25)

A fourth corpus has shipped since — the manuscript itself
([`manuscript-corpus.md`](manuscript-corpus.md)), with its own tables in
`brain.db`. It does **not** change the Path A gate: like the Obsidian vault,
it is a parallel store that `RetrievalService` reads at query time. It does
raise the cost of Path A slightly, since a unified `SourceDocument` surface
would now have three parallel stores to absorb rather than two.
