# Plan d'implémentation — Fusion ClioBrain dans ClioDeck + leçons goose

> Plan opérationnel. Pour le contexte stratégique voir `fusion-cliobrain-strategy.md`.

Ce plan est séquentiel sauf mention contraire. Chaque étape a un **critère de complétion** vérifiable. La numérotation des étapes est stable pour référencement dans les commits (`feat(fusion): step 3.2 — Obsidian VaultReader`).

## Conventions

- Branche principale : `feat/fusion-cliobrain`. Sous-branches par phase : `feat/fusion/phase-1-providers`, etc.
- Chaque étape produit un PR indépendant, mergeable, testé.
- Tests obligatoires : unitaires (vitest) pour toute nouvelle unité de logique ; intégration pour tout changement de pipeline RAG ou workspace.
- Aucune étape ne doit casser l'UX existante de ClioDeck sur workspaces `.cliodeck/` existants. Les migrations sont additives ou versionnées.

---

## PHASE 0 — Socle (prérequis, aucune fusion encore)

### 0.1 — Geler l'état courant

- Tag git `pre-fusion-v1` sur ClioDeck et ClioBrain.
- Snapshot CHANGELOG des deux projets dans `docs/fusion-cliobrain-state-snapshot.md`.
- **Critère** : tag visible sur les deux repos, snapshot committé.

### 0.2 — Cartographier les doublons

Produire `docs/fusion-cliobrain-module-map.md` avec pour chaque module en collision : chemin ClioDeck, chemin ClioBrain, décision (garder A / garder B / fusionner), justification en 1 ligne.

Modules à arbitrer au minimum : `rag/`, `search/`, `vector-store/`, `llm/`, `ner/`, `chunking/` (cliobrain probablement absent), `pdf/`, types `Source`, workspace manager, config manager, logger.

**Critère** : fichier committé, chaque module a une décision tranchée.

### 0.3 — Format workspace unifié

- Définir schéma `.cliodeck/v2/` : `brain.db` (SQLite), `hnsw.index`, `config.json`, `hints.md`, `mcp-access.jsonl`, `recipes/`.
- Ajouter champ `schema_version` dans `config.json` (int, valeur `2`).
- Écrire `backend/core/workspace/migrator.ts` avec :
  - `migrateFromCliobrain(path): Promise<void>`
  - `migrateFromCliodeckV1(path): Promise<void>`
- Tests : 3 workspaces fixtures (cliodeck v1, cliobrain, mixte).

**Critère** : `npm test backend/core/workspace` vert, un workspace cliobrain réel migré manuellement ouvre sans erreur.

### 0.4 — Types `Source` unifiés

Dans `backend/types/source.ts` (ClioDeck) :

```ts
export type SourceType =
  | 'file' | 'zotero' | 'tropy' | 'folder' | 'obsidian-note';

export interface Source {
  id: string;
  type: SourceType;
  path: string;
  metadata: Record<string, unknown>;
  // Spécialisations typées par discriminated union
}
```

Remplacer toutes les occurrences divergentes dans les deux codebases.

**Critère** : `tsc --noEmit` vert, aucun `any` introduit, grep sur anciens noms de types retourne 0.

---

## PHASE 1 — Abstraction Provider (leçon goose #1, préalable à tout)

### 1.1 — Trait `LLMProvider` + `EmbeddingProvider`

Créer `backend/core/llm/providers/base.ts` :

```ts
export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: { chat: boolean; streaming: boolean; tools: boolean };
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatChunk>;
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

**Critère** : interfaces documentées, tests de contrat génériques (`providers/__tests__/contract.ts`) exécutables sur n'importe quelle impl.

### 1.2 — Implémentations initiales (4, parallélisables)

- `providers/ollama.ts` (port depuis ClioBrain/ClioDeck)
- `providers/openai-compatible.ts` (couvre llama.cpp, LM Studio, vLLM, OpenAI natif)
- `providers/anthropic.ts` (SDK officiel `@anthropic-ai/sdk`)
- `providers/mistral.ts` (API Mistral, public francophone)

Chaque impl passe les tests de contrat 1.1.

**Critère** : 4 PRs mergés, tests de contrat verts pour chaque provider.

### 1.3 — Registry + config

- `providers/registry.ts` : `getProvider(id): LLMProvider`, lecture depuis config workspace.
- Clés config : `llm.provider`, `llm.model`, `llm.apiKey` (stocké chiffré via `keytar` ou équivalent déjà utilisé par ClioDeck), `embedding.provider`, `embedding.model`.
- UI : écran « Providers » dans settings, sélection + test de connexion.

**Critère** : basculer Ollama → Anthropic dans l'UI, un RAG simple fonctionne sans modification de code.

### 1.4 — Migration des appels existants

Remplacer tous les appels Ollama directs par `registry.getProvider(...)`. Grep `ollama` dans le code hors providers = 0.

**Critère** : grep vert, tests RAG existants passent.

---

## PHASE 2 — Absorption technique de ClioBrain

### 2.1 — Obsidian

Copier `cliobrain/backend/core/obsidian/` → `cliodeck/backend/integrations/obsidian/`.

- Adapter aux types `Source` unifiés (0.4).
- Aligner API sur le pattern `integrations/zotero/` et `integrations/tropy/` : exporter `ObsidianIntegration` avec méthodes `scan()`, `watch()`, `index()`, `export()`.
- IPC handlers : `obsidian:setVaultPath`, `obsidian:scan`, `obsidian:export`.
- UI : panneau Obsidian dans la sidebar (réutiliser composant Zotero comme base).

**Critère** : ouvrir un vault Obsidian réel, voir les notes listées, les indexer, récupérer un chunk dans une recherche RAG.

### 2.2 — Graphe de connaissances

Copier `cliobrain/backend/core/graph/` → `cliodeck/backend/core/graph/`.

- Vérifier compat Graphology version avec dépendances ClioDeck.
- Intégrer avec NER et wikilinks Obsidian pour produire nœuds/arêtes.
- UI : onglet « Graphe » dans le mode Analyze existant.

**Critère** : graphe visualisable sur un workspace avec ≥ 50 sources, détection de communautés Louvain fonctionnelle.

### 2.3 — NER consolidé

Comparer impls NER des deux projets, garder la meilleure (probable : celle avec modèles multilingues FR/EN/DE). Supprimer l'autre.

**Critère** : une seule impl NER, tests existants verts.

### 2.4 — RAG pipeline consolidé

Adopter le pipeline ClioBrain (HybridSearch HNSW 60% + BM25 40% + RRF K=60 + ContextCompressor 3-level). Brancher le chunking PDF/OCR de ClioDeck en amont.

**Critère** : benchmarks RAG sur corpus de test (qualité ≥ au meilleur des deux projets avant fusion).

### 2.5 — Serveur MCP (sortant)

Copier `cliobrain/backend/mcp/` → `cliodeck/backend/mcp-server/`.

- Adapter aux services ClioDeck consolidés.
- IPC handlers pour on/off + affichage du log JSONL.
- UI : panneau « MCP Server » dans settings avec toggle, chemin log, bouton « Révoquer toutes les connexions ».
- Conserver le principe : **inactif par défaut**.

**Critère** : Claude Desktop peut se connecter, lancer un `search_documents`, le log JSONL affiche l'appel.

---

## PHASE 3 — UI mode « Brainstorm »

### 3.1 — Refonte navigation modes

Dans `src/renderer/`, organiser en 4 modes :

```
modes/
  brainstorm/   NOUVEAU — chat ClioBrain
  write/        ClioDeck existant (WYSIWYG)
  analyze/      ClioDeck existant + graphe
  export/       ClioDeck existant
```

Sidebar globale : workspace, sources, hints, recipes.

**Critère** : navigation fluide entre les 4 modes, état workspace partagé (mêmes sources, même index).

### 3.2 — Port du chat ClioBrain

Porter l'UI chat de ClioBrain dans `modes/brainstorm/`. Brancher sur le nouveau provider registry (1.3).

**Critère** : une session brainstorm complète (10+ tours) fonctionne avec citations RAG.

### 3.3 — Pont Brainstorm → Write

Bouton « Envoyer vers Write » sur un tour de chat : crée un brouillon dans le mode Write avec le contenu + citations préservées.

**Critère** : parcours Brainstorm → Write testé manuellement de bout en bout.

---

## PHASE 4 — Leçons goose (après fusion stable)

### 4.1 — `.cliohints`

- Fichier `hints.md` dans `.cliodeck/v2/` workspace.
- Loader `backend/core/hints/loader.ts` : charge au démarrage workspace, expose `getHints(): string`.
- Injection systématique dans les prompts : chat brainstorm, RAG write, tools MCP (en tant que contexte serveur, pas envoyé au modèle externe sauf opt-in).
- UI : éditeur markdown simple dans settings workspace.

**Critère** : un hint « cite toujours en Chicago » modifie visiblement le comportement du chat sans code change.

### 4.2 — Context compaction

- `backend/core/context-mgmt/compactor.ts`.
- Seuil configurable (défaut : 70% de la context window du provider courant).
- Stratégie : garder système + N derniers tours + résumé LLM des tours intermédiaires + citations RAG récentes intactes.
- Déclenchement automatique dans le chat brainstorm.

**Critère** : session 50 tours ne dépasse jamais la context window, qualité des réponses conservée (eval manuelle sur 3 sessions).

### 4.3 — ClioRecipes v1

#### 4.3.1 — Schéma YAML

`backend/recipes/schema.ts` (Zod) :

```yaml
name: string
version: string
description: string
inputs: { [key]: { type, required, description } }
steps:
  - id: string
    kind: brainstorm | search | graph | write | export
    with: { ... }  # params spécifiques au kind
outputs: { ... }
```

#### 4.3.2 — Runner

`backend/recipes/runner.ts` : exécute les steps séquentiellement, propage outputs entre steps, logge dans `.cliodeck/v2/recipes-runs/`.

#### 4.3.3 — Recipes pré-écrites (4)

Dans `backend/recipes/builtin/` :

- `revue-zotero.yaml` — revue critique d'un dossier Zotero tagué
- `analyse-corpus-tropy.yaml` — analyse thématique + graphe sources primaires
- `brainstorm-chapitre.yaml` — brainstorm structuré d'un chapitre à partir d'un plan
- `export-chapitre-chicago.yaml` — Write → Pandoc PDF style Chicago

#### 4.3.4 — UI

Onglet « Recipes » : liste builtin + user, bouton run avec formulaire inputs, historique des runs avec outputs.

**Critère** : les 4 recipes s'exécutent sur un workspace de test, outputs conformes, utilisateur peut dupliquer/éditer une recipe builtin.

### 4.4 — Client MCP (serveurs externes)

#### 4.4.1 — Manager

`backend/integrations/mcp-clients/manager.ts` : cycle de vie des serveurs MCP stdio/SSE configurés par l'utilisateur. Inspiré du pattern `extension_manager` de goose.

#### 4.4.2 — Config par workspace

`.cliodeck/v2/config.json` section `mcpClients: [{ name, transport, command, args, env }]`.

#### 4.4.3 — Intégration RAG

Les tools exposés par les serveurs MCP deviennent des *sources virtuelles* recherchables depuis Brainstorm (ex : Gallica returns → chunks → injection contexte).

#### 4.4.4 — UI

Settings « MCP Clients » : ajout/suppression serveur, status (connecté/erreur), liste des tools exposés.

**Critère** : brancher un serveur MCP Gallica (même fictif), faire apparaître ses résultats dans une recherche Brainstorm.

### 4.5 — SourceInspector (sécurité)

- `backend/security/source-inspector.ts` : scanne chunks RAG avant injection dans prompt.
- Patterns de base : instructions impératives dans sources (« ignore les instructions précédentes », « tu es maintenant »…), URLs suspectes, encodages inhabituels.
- Mode : `warn` (log + badge UI) ou `block` (retirer le chunk) configurable.
- Log dans `.cliodeck/v2/security-events.jsonl`.

**Critère** : test unitaire avec PDF piégé → event loggé, chunk bloqué en mode `block`.

### 4.6 — API OpenAPI interne + CLI

#### 4.6.1 — Schéma OpenAPI

`backend/api/openapi.yaml` : formalise les endpoints backend (search, recipe-run, workspace-ops). Générer types TS partagés via `openapi-typescript`.

#### 4.6.2 — CLI headless

`scripts/cliodeck-cli.ts` → binaire `cliodeck`. Commandes :

- `cliodeck recipe run <name> --workspace <path> --input k=v`
- `cliodeck search "query" --workspace <path>`
- `cliodeck export <doc> --format pdf --workspace <path>`

**Critère** : batch — appliquer une recipe à 3 workspaces via bash loop → outputs générés.

---

## PHASE 5 — Consolidation

### 5.1 — Documentation utilisateur

- Réécrire README : positionnement fusionné.
- Wiki : sections Brainstorm, Recipes, MCP (serveur + clients), Hints, Providers.
- Vidéo démo 3-5 min du cycle Explorer → Brainstormer → Écrire → Exporter.

### 5.2 — Migration utilisateurs ClioBrain

- Outil `cliodeck import-cliobrain <path>` (réutilise 0.3).
- Annonce sur le repo ClioBrain pointant vers ClioDeck.
- ClioBrain passe en mode maintenance uniquement.

### 5.3 — Release v2.0

- Tag `v2.0.0`.
- CHANGELOG détaillé.
- Builds macOS (DMG Intel + AS), Linux (AppImage + deb).

---

## Dépendances inter-phases

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
                                      │
                                      └─► 4.1, 4.2, 4.3 (parallélisables)
                                          4.4, 4.5, 4.6 (parallélisables après 4.3)
```

**Parallélisations possibles** :

- 1.2 (4 providers) en parallèle entre eux.
- 2.1, 2.2, 2.3 en parallèle entre eux (après 1.4).
- 4.1, 4.2, 4.3 en parallèle (après 3.3).
- 4.4, 4.5, 4.6 en parallèle (après 4.3).

## Estimation temporelle (à calibrer)

| Phase | Charge indicative (jours-personne) |
|---|---|
| 0 | 3-5 |
| 1 | 8-12 |
| 2 | 10-15 |
| 3 | 5-8 |
| 4 | 15-25 |
| 5 | 3-5 |
| **Total** | **44-70 jours-personne** |

En vibe-coding avec Claude Code, diviser par 3-5 selon le rythme habituel.

## Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Divergence qualité RAG après fusion 2.4 | Élevé | Benchmark avant/après sur corpus gold standard |
| Couplage accidentel Brainstorm/Write qui dilue l'identité | Élevé | Revue UX à la fin de phase 3, garder le mode Write comme point d'entrée par défaut |
| Surface providers explose | Moyen | Plafond strict à 4 en v2.0, feuille de route pour v2.x |
| Performance graphe sur gros corpus | Moyen | Lazy loading, seuils de nœuds, pagination |
| Prompt injection via MCP clients externes | Moyen | SourceInspector (4.5) actif par défaut sur sources MCP |
| Migration workspace cliobrain perd des données | Élevé | Tests fixtures + backup auto avant migration |

## Critères de succès v2.0

1. Un historien existant ClioDeck ouvre son workspace sans friction.
2. Un utilisateur ClioBrain migre son workspace en une action, retrouve ses notes.
3. Le cycle Explorer → Brainstormer → Écrire → Exporter est réalisable en une session.
4. Une recipe tierce partagée par URL s'exécute sur mon workspace.
5. Claude Desktop peut se connecter au serveur MCP et interroger mon corpus.
6. Je peux brancher un serveur MCP externe (Gallica) et l'utiliser en Brainstorm.
7. Changer de provider LLM (Ollama → Anthropic) se fait en 3 clics sans casse.
8. Un `.cliohints` modifie visiblement les réponses sans code change.
