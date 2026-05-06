# Fusion ClioBrain → ClioDeck avec les leçons de goose

> Document stratégique. Voir `fusion-cliobrain-implementation-plan.md` pour le plan d'implémentation détaillé.

## État des lieux

**ClioDeck** (base) : écriture WYSIWYG, RAG (HNSW+BM25), Zotero/Tropy, export Pandoc/LaTeX/Word, modes d'analyse (topic modeling, textométrie), OCR. Stack Electron/React/TS, Ollama, SQLite.

**ClioBrain** : assistant *brainstorming*, chat-driven. Apports uniques :
- **Obsidian** intégration profonde (`backend/core/obsidian/` : VaultReader, Parser, Indexer, Exporter — wikilinks, tags, frontmatter)
- **Graphe de connaissances** (`core/graph/` — Graphology, communautés Louvain)
- **NER** (`core/ner/`)
- **Serveur MCP déjà scaffoldé** (`backend/mcp/` : server, cli, tools, resources, prompts, logger)
- **Plan MCP éthique** remarquable : inactif par défaut, log JSONL de chaque appel, révocable

Les stacks sont **quasi identiques** → fusion techniquement peu coûteuse. Le vrai travail est conceptuel : articuler *brainstorming* (ClioBrain) et *écriture* (ClioDeck) dans un produit cohérent sans dilution.

## Principe directeur

ClioDeck reste le produit. On y absorbe ClioBrain comme **un mode de travail** (« Brainstorm ») en amont du mode « Write » existant. Le cycle historien devient : **Explorer → Brainstormer → Écrire → Exporter**, sur un même workspace, un même index, un même corpus.

## Leçons de goose retenues

1. **Abstraction Provider** — isoler chaque LLM derrière un trait unique (cf. `crates/goose/src/providers/base.rs` chez goose). Ajouter un modèle = ajouter un fichier, pas toucher au cœur.
2. **Recipes** — workflows YAML paramétrables et partageables. Cœur de différenciation pour la communauté DH.
3. **`.goosehints` → `.cliohints`** — contexte projet durable injecté dans tous les prompts.
4. **Context compaction automatique** — essentiel pour sessions longues.
5. **Séparation core / UI via OpenAPI** — permet CLI headless, tests, intégrations tierces.
6. **MCP comme protocole d'extension** — entrant ET sortant.
7. **Inspection de sécurité pluggable** — argument de défendabilité académique.
8. **Custom distros** (optionnel) — distributions institutionnelles préconfigurées.

## À ne pas copier de goose

- Surface providers x40 (commencer à 3-4).
- Sub-agents (pas pertinent pour l'écriture historienne).
- ACP (résout un problème qu'on n'a pas).
- Recipe scanner/malware check (overkill pour ce public).

## Plan de fusion

### Phase 0 — Socle commun (prérequis)

1. **Unifier la couche Workspace** : format unique `.cliodeck/` versionné, avec migration depuis `.cliobrain/`.
2. **Unifier les types `Source`** : union `file | zotero | tropy | folder | obsidian-note`.
3. **Résoudre les doublons** : RAG ClioBrain (plus récent, ContextCompressor 3-level, RRF K=60) ; chunking et PDF ClioDeck (plus mûrs, OCR).

### Phase 1 — Absorber ClioBrain dans ClioDeck

| Module ClioBrain | Destination ClioDeck | Note |
|---|---|---|
| `core/obsidian/` | `backend/integrations/obsidian/` | Aligner sur pattern Zotero/Tropy |
| `core/graph/` | `backend/core/graph/` | Remplace/complète `backend/core/analysis` |
| `core/ner/` | `backend/core/ner/` | Fusion — garder la meilleure impl |
| `backend/mcp/` | `backend/mcp/` | Tel quel |
| Chat + mode brainstorm | Mode « Brainstorm » UI | À côté des modes analyse existants |

### Phase 2 — Leçons goose appliquées

- **Provider abstraction** : `backend/core/llm/providers/` avant fusion. Impls : Ollama, OpenAI-compatible, Anthropic, Mistral.
- **`.cliohints`** : fichier par workspace, injecté dans tous les prompts.
- **ClioRecipes** : YAML workflows combinant Brainstorm → Write → Export. Matérialise le pont.
- **Context compaction** : seuil tokens, résumé auto tours anciens, conservation citations RAG.
- **API OpenAPI interne** : contrat formalisé backend ↔ renderer → CLI headless.
- **`SourceInspector`** : scan prompt injection dans chunks RAG entrants.

### Phase 3 — MCP à double sens

- **Serveur MCP** (héritage ClioBrain) : corpus local → Claude Desktop/Code.
- **Client MCP** (leçon goose) : ClioDeck consomme des serveurs MCP tiers configurés par l'utilisateur (stdio/SSE). Pattern `extension_manager` goose.
- **Connecteurs d'archives intégrés** : Gallica, Europeana, FranceArchives, Transkribus, HAL — exposés comme *outils* de notre propre serveur MCP (`backend/mcp-server/tools/`), pas comme serveurs MCP externes. Voir `docs/archive-mcp-connectors.md`.

## Architecture cible

```
cliodeck/
  backend/
    core/
      llm/providers/        ← NOUVEAU (leçon goose #1)
      rag/                  ← ClioBrain (meilleur)
      graph/                ← ClioBrain
      ner/                  ← fusion
      search/, vector-store/, chunking/, pdf/  ← ClioDeck
    integrations/
      zotero/, tropy/       ← ClioDeck existant
      obsidian/             ← ClioBrain absorbé
      mcp-clients/          ← NOUVEAU (serveurs MCP externes)
    mcp-server/             ← ClioBrain absorbé (serveur sortant)
    recipes/                ← NOUVEAU
    hints/                  ← NOUVEAU (.cliohints)
    context-mgmt/           ← NOUVEAU
    security/               ← NOUVEAU (SourceInspector)
    api/                    ← NOUVEAU (OpenAPI interne)
    export/                 ← ClioDeck (Pandoc/LaTeX)
  src/renderer/
    modes/
      brainstorm/           ← ClioBrain UI
      write/                ← ClioDeck UI (cœur)
      analyze/              ← ClioDeck
      export/               ← ClioDeck
    recipes/                ← NOUVEAU
```

## Principes d'ingénierie transversaux (leçons de claw-code)

Principes à appliquer partout où un composant externe, long-lived ou asynchrone est introduit (MCP clients, providers LLM, intégrations Zotero/Tropy/Obsidian, serveur MCP sortant).

1. **State machine explicite pour tout worker** — chaque serveur MCP, chaque provider, chaque intégration expose un état typé (`unconfigured | spawning | handshaking | ready | degraded | failed | stopped`) plutôt qu'un booléen `connected`. L'UI affiche l'état réel avec son `lastError` et `lastReadyAt`.
2. **Events over scraped prose** — logs et reporting sont des événements typés (discriminated unions TS), pas du texte à reparser. S'applique au log MCP sortant, aux events de sécurité, aux rapports de scan d'intégration.
3. **Partial success first-class** — aucun composant ne retourne « tout OK » ou « tout KO ». Un scan de vault Obsidian rapporte N notes indexées + M notes ignorées avec raison. 3 serveurs MCP sur 5 opérationnels = mode dégradé visible, pas erreur globale.
4. **Auto-recovery : oui pour l'infra, non pour le contenu** — un retry silencieux est acceptable sur Ollama/embedding/MCP déconnecté (pannes non-destructives). **Jamais** sur recipe execution, modifications de corpus, export : l'historien est devant l'écran, on ne change pas les choses dans son dos.
5. **Harness de parité par mock-replay** pour la couche Provider — chaque impl LLM passe N scénarios scriptés (chat, tool call, streaming, embedding) contre un mock HTTP. Garantit l'équivalence *fonctionnelle*, pas seulement la conformité d'interface.

## Ce qu'on ne retient pas de claw-code

- Pilotage headless par Discord (ClioDeck est interactif).
- Triptyque multi-agents Architect/Executor/Reviewer (voix unique pour l'historien).
- LSP client (hors sujet pour de l'écriture).
- Policy engine exécutable pour merge/rebase (ClioDeck gère du texte, pas du code).
- Philosophie « clawable » (optimiser pour agents) : ClioDeck optimise d'abord pour l'humain.

## Le pari stratégique

La fusion réussie transforme ClioDeck d'**assistant d'écriture historien** en **environnement de recherche historien complet**, couvrant le cycle Explorer/Brainstormer/Écrire/Exporter. Les quatre extensions (providers, recipes, MCP entrant/sortant, hints) sont les trous où la communauté DH viendra planter des choses — exactement la leçon méta de goose.

**Ligne rouge** : ClioDeck reste un outil d'écriture d'historien. Le mode Brainstorm sert l'écriture ; il ne devient pas un produit autonome. Sinon on aura fusionné deux apps pour en obtenir trois.
