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
- **Client MCP** (leçon goose) : ClioDeck consomme serveurs MCP externes (Gallica, HAL, Isidore, Europeana, Transkribus). Pattern `extension_manager` goose.

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

## Le pari stratégique

La fusion réussie transforme ClioDeck d'**assistant d'écriture historien** en **environnement de recherche historien complet**, couvrant le cycle Explorer/Brainstormer/Écrire/Exporter. Les quatre extensions (providers, recipes, MCP entrant/sortant, hints) sont les trous où la communauté DH viendra planter des choses — exactement la leçon méta de goose.

**Ligne rouge** : ClioDeck reste un outil d'écriture d'historien. Le mode Brainstorm sert l'écriture ; il ne devient pas un produit autonome. Sinon on aura fusionné deux apps pour en obtenir trois.
