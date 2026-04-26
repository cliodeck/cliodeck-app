# Plan d'implémentation post-fusion ClioBrain

**Date** : 2026-04-24
**Branche** : `feat/fusion-cliobrain` (5 commits ahead of origin)
**Sources** : audit croisé backend / frontend / sécurité / design — voir §1.
**Document annexe** : `docs/actions-frederic.md` — étapes où ton intervention personnelle est requise.

---

## 1. Synthèse des quatre audits

### 1.1 Backend

La fusion est **structurellement faite** : provider abstraction (`backend/core/llm/providers/base.ts`), parity harness (`backend/core/llm/providers/__tests__/parity.test.ts`), MCPClientManager avec state machine typée (`backend/integrations/mcp-clients/manager.ts`), ChatEngine extrait (`backend/core/chat/chat-engine.ts`). Les ADRs 0001-0004 documentent les arbitrages réels.

**Gaps principaux** :
- **Step 1.4 incomplet** : `OllamaClient.ts` (1104 LOC legacy) et `LLMProviderManager.ts` (532 LOC) coexistent avec la registry. `pdf-service.ts:40,92` tient les trois chemins en parallèle.
- **`ContextCompactor` écrit mais jamais câblé** (`backend/core/context-mgmt/compactor.ts`, 213 LOC, tests OK). `chat-engine.ts:80` réserve la phase `compressing` sans l'utiliser. Sessions longues saturent en silence.
- **`SourceInspector` écrit mais jamais câblé** (`backend/security/source-inspector.ts`). La défense prompt-injection promise est dormante.
- **`searchEuropeana` scaffoldé mais pas enregistré** dans `server.ts`.
- **`retrieval-service.ts:515-707`** — `searchSecondary` fait query expansion FR→EN + cache embeddings + mean pooling + hybrid HNSW+BM25 + fallback threshold en 192 LOC. À extraire dans un `SecondaryRetriever` avant le Path A swap.
- **`backend/mcp-server/tools/` — zéro test** (9 fichiers, 1791 LOC exposés à des clients externes).
- **Recipes** : seul `format: pdf` câblé dans l'export step, pas de kind `brainstorm`.
- **21 tests préexistants cassés** (better-sqlite3 + Ollama live) pollue le signal CI.

### 1.2 Frontend / React

Le socle UI de la fusion est en place : `WorkspaceModeBar` commute entre 4 modes, `BrainstormPanel` + `BrainstormChat` utilisent `ChatSurface` et le chat unifié `fusion:chat:*`. Les stores Zustand "pur domaine" sont minces et cohérents.

**Gaps principaux** :
- **`chatStore.ts:235,254` utilise `require('./modeStore')` en ESM** — ne fait jamais rien en prod, donc `modeId` est toujours `undefined` sur les messages Brainstorm.
- **8 doubles-casts `window as unknown as { electron?: { fusion?: ... } }`** dans les sections fusion parce que `ElectronAPI` ne couvre pas `fusion.*` au niveau du type.
- **i18n absente** sur les 5 sections fusion (VaultConfigSection, WorkspaceHintsSection, RecipesSection, MCPClientsSection, RecipeRunModal).
- **107 `any` dans le renderer** (notamment `hooks/useIPCWithTimeout.ts`, `stores/similarityStore.ts`, `modeStore.ts`) — violation de la règle §3 « no any ».
- **92 couleurs codées en dur** dans les `.tsx` inline styles (ErrorFallback.tsx bootstrappé à mort, ZoteroConfigSection.tsx, LLMConfigSection.tsx).
- **Inline-styles omniprésents dans tout le code fusion** — `BrainstormChat.tsx:198-249` = 60 lignes de style.
- **Pont Brainstorm→Write** : bouton *Send to Write* insère en queue sans ancrage au curseur ni retour Write→Brainstorm.
- **Recipes UI** : `RecipesSection.tsx:128` affiche "Recettes (lecture seule)". Pas de duplication, d'édition, d'historique.
- **MCP clients UI** : `MCPClientsSection.tsx:180-186` se décrit comme « l'intégration au chat Brainstorm arrive dans une vague suivante ». Tool-use MCP non exposé dans Brainstorm.
- **276 `console.*`** dans le renderer pollue la console prod.
- **Composants géants hérités** : `CorpusExplorerPanel.tsx` (1072 lignes), `RAGConfigSection.tsx` (912).

### 1.3 Sécurité

Le code a **un threat model implicite cohérent** : non-hostile user, hostile content. Les briques défensives sont bien pensées (Electron webPreferences durci, preload whitelist, path-validator double-check, `mcp-add-guard.ts`, audit log redacted). Mais **les meilleures défenses ne sont pas câblées**.

**Vulnérabilités classées** :

| Sévérité | Problème | Fichiers |
|---|---|---|
| HIGH | `SourceInspector` écrit mais jamais câblé — prompt injection par contenu tiers reste possible | `backend/security/source-inspector.ts`, `retrieval-service.ts`, `fusion-chat-service.ts` |
| HIGH | `npm start` lance Electron avec `--no-sandbox`, annule `sandbox: true` | `package.json:35` |
| HIGH | Puppeteer lancé `--no-sandbox` pour export PDF + markdown non sanitizé avant `page.setContent` | `backend/export/PDFExporter.ts:41,56,92` |
| HIGH | **Electron 28 obsolète** — Chromium ~120, Node 18 EOL. Plusieurs années de CVE non patchées. | `package.json:109` |
| MED | Puppeteer duplique un Chromium entier (~400 MB) + 2ᵉ surface d'attaque — remplacer par `webContents.printToPDF` | `package.json:80` |
| MED | Mistral/Gemini manquent dans `SENSITIVE_KEYS` — stockés en clair | `src/main/services/secure-storage.ts:15-19` |
| MED | `mcpClients[].env[*]` écrit en plaintext dans `config.json` | `src/main/services/mcp-clients-service.ts` |
| MED | `mcp-access.jsonl` / `security-events.jsonl` sans rotation | `backend/mcp-server/logger.ts` |
| LOW | DOMPurify manquant sur les previews citeproc | `CitationStyleSection.tsx:177,182` |
| LOW | `searchEuropeana` code mort latent | `backend/mcp-server/tools/searchEuropeana.ts` |
| LOW | YAML frontmatter injection théorique dans export Word | `src/main/services/word-export.ts:463-476` |

**ADRs sécurité manquantes** : aucun ADR sur threat model, storage des secrets, contrat audit log, signature/notarization des builds.

### 1.4 Design / UX

**L'incohérence stratégique principale** : le doc stratégique parle du cycle `Explorer → Brainstormer → Écrire → Exporter`, mais la barre de modes est `Brainstorm / Write / Analyze / Export`. *Explorer* a disparu au profit d'*Analyze* (deux concepts différents). Première surface que voit l'utilisateur = première rupture avec le narratif.

**Le risque majeur du plan s'est matérialisé à l'envers** : le plan craignait un « couplage Brainstorm/Write qui dilue l'identité ». Résultat : Brainstorm est tellement peu différencié du Chat classique **qu'il n'a pas d'identité**. Pas d'objet « idée » persistant, pas de graphe dans Brainstorm (relégué à Analyze), pas de tags/backlinks surfacés comme entités de première classe. Un utilisateur ClioBrain migrant perd son vocabulaire (notes, idées, relations) contre un « chat stylé ».

**Autres dettes design** :
- **Information architecture** : 3 niveaux concurrents (modes + panels + sous-onglets) sans fil d'Ariane. Settings = 15 sections empilées, 378 lignes.
- **Corpus Explorer monté deux fois** : panneau droit ET mode Analyze — potentiellement visibles simultanément.
- **Mur blanc au démarrage** : placeholder « Éditeur Markdown (Monaco Editor) » en dur, non-i18n, pas d'onboarding.
- **Empty state Brainstorm** : une phrase. Pas de prompts types, pas d'exemples.
- **Accessibilité** : pas de `:focus-visible` global, pas de skip-link, icônes `strokeWidth={1}` (contraste faible).
- **Tokens CSS enfreints** partout (`#fff` en dur, palette indigo Tailwind parachutée, bootstrap bleu hérité).
- **Jargon technique exposé** : « Workspace hints » en anglais dans le FR, « Reconstruire les index HNSW depuis la base SQLite » dans l'UI utilisateur final.
- **Feedback fragile** : erreurs en `console.error + alert`, pas de toast global persistant.
- **ExportHub** ne sait pas quel document exporter — commit récent le confirme (« Recipe export step ignores document_id input », CLAUDE.md §6).

---

## 2. Points de convergence entre les 4 audits

Ces items apparaissent chez plusieurs spécialistes — forte priorité car doublement vus.

| Sujet | Agents qui le signalent | Criticité cumulée |
|---|---|---|
| **SourceInspector à câbler** | Backend, Sécurité, Design, Frontend | **Critique** — code écrit dormant, défense annoncée mais inactive |
| **Identité du mode Brainstorm (objet idée, graphe in-place)** | Frontend, Design | **Haute** — la fusion ne délivre pas sa promesse |
| **MCP tool-use dans Brainstorm** | Backend, Frontend, Design | **Haute** — état affiché mais pas exploité |
| **Électron 28 + Puppeteer `--no-sandbox`** | Sécurité seul, mais impact transverse | **Haute** — surface d'attaque cumulée |
| **i18n fusion + terminologie** | Frontend, Design | **Haute** — rend l'app incomplète côté EN |
| **Onboarding / empty states** | Design (principal), Frontend (implicite) | **Haute** — bloquant pour l'adoption |
| **Purge legacy LLM (OllamaClient + LLMProviderManager)** | Backend | **Haute** — code fantôme qui retient les refactors |
| **Settings reorganization** | Design, Frontend (implicite via 378 lignes) | **Moyenne** — pas critique mais frictionnel |
| **ADRs sécurité + signature builds** | Sécurité | **Moyenne** — conditionne la distribution institutionnelle |

---

## 3. Roadmap

Quatre phases, ordonnées par criticité. Chaque phase a un gate : si elle n'est pas bouclée, la suivante ne peut pas commencer (ou alors avec un risque produit non-trivial).

Notation :
- **[S/M/L]** = effort estimé (Small ≤ 1 jour, Medium 1-3 jours, Large 3+ jours)
- **[USER]** = intervention de Frédéric requise — détails dans `docs/actions-frederic.md`
- Référence fichier : `file:L` = ligne de départ

### Phase 0 — Stopper l'hémorragie (≈ 1 semaine)

Bugs actifs, failles critiques, promesses dormantes. Rien de nouveau, que du débogage.

| # | Type | Effort | Description | [USER] |
|---|---|---|---|---|
| 0.1 | Frontend | S | Remplacer `require('./modeStore')` par import ESM — `modeId` est actuellement toujours `undefined` en prod dans Brainstorm | Non |
| 0.2 | Sécurité | S | Retirer `--no-sandbox` de `npm start` (`package.json:35`) | Oui — accepter friction dev Linux ([A1](actions-frederic.md#a1)) |
| 0.3 | Sécurité | M | Sanitize markdown avant `page.setContent` Puppeteer + CSP HTML export | Non |
| 0.4 | Sécurité + Backend | M | Câbler `SourceInspector` dans `retrieval-service.ts` + `fusion-chat-service.ts` + sink vers `security-events.jsonl` | Oui — choix mode `warn`/`block` ([A2](actions-frederic.md#a2)) |
| 0.5 | Sécurité | S | Ajouter `mistralAPIKey`, `geminiAPIKey` à `SENSITIVE_KEYS` | Non |
| 0.6 | Frontend | S | Typer `window.electron.fusion.*` dans `ElectronAPI` (élimine 8 doubles-casts) | Non |
| 0.7 | Backend | S | Enregistrer `searchEuropeana` dans `server.ts` | Oui — obtenir clé API Europeana ([A3](actions-frederic.md#a3)) |

**Gate Phase 0** : `tsc --noEmit` toujours à 0, tests passent, `npm audit` remonte à 0 Electron CVE HIGH+ (prérequis upgrade Phase 1).

### Phase 1 — Compléter la fusion *technique* (≈ 2-3 semaines)

Les gaps du plan `fusion-cliobrain-implementation-plan.md` qui étaient marqués faits mais ne le sont pas, et les éléments tuyaux/plomberie restants.

| # | Type | Effort | Description | [USER] |
|---|---|---|---|---|
| 1.1 | Sécurité | L | ✅ Upgrade Electron 28 → 40.9.2 (commits `e6ee7d7` + `414f188`) ; rebuilds natifs validés (better-sqlite3 12, hnswlib-node 3, canvas 3 via overrides) ; CVE HIGH+ Electron purgées | Fait |
| 1.2 | Backend | M | ✅ Step 1.4 finalisé : `OllamaClient.ts` (1104 LOC) + `LLMProviderManager.ts` (532 LOC) + bridge.ts supprimés ; tous les consommateurs (similarity, slides, retrieval, tropy, NER, summarizer, pdf, config-handlers) sur `ProviderRegistry` typé. Polling redondant de `/api/tags` éliminé | Fait |
| 1.3 | Backend | M | ✅ `ContextCompactor` câblé dans `chat-engine.ts` ; table `getContextWindow(model)` couvre Claude/GPT/Mistral/Gemini/Llama/Qwen/Gemma/Phi (commit `30a137c`) | Fait |
| 1.4a | Frontend | M | ✅ Refactor des 5 composants fusion vers `t()` ; nouveaux espaces de noms `vault.*`, `hints.*`, `recipes.*`, `mcp.*`, `recipeRun.*` créés en FR (langue source), EN et DE (premières passes) ; ~60 chaînes extraites | Fait |
| 1.4b | Frontend | S | Relire/valider les traductions EN + DE — checklist dans `docs/i18n-fusion-1.4b-review.md` | Oui — relecture EN/DE ([A7](actions-frederic.md#a7)) |
| 1.5 | Sécurité | M | ✅ Routage `mcpClients[].env[*]` → `secureStorage` (sentinel `__cliodeck_secret__` + heuristique `KEY/TOKEN/SECRET/PASSWORD/PASS/CREDENTIAL`) ; migration idempotente au `loadProject` (commit `1f9817f`) | Fait |
| 1.6 | Sécurité | L | ✅ Suppression de `backend/export/PDFExporter.ts` (dead code) + désinstallation `puppeteer` (53 paquets transitifs supprimés, ~400 MB) ; le seul vrai consommateur Chromium-PDF (revealjs-export) utilisait déjà `webContents.printToPDF` | Fait |
| 1.7 | Backend | M | ✅ Enveloppe typée `{ hits, outcomes }` pour `retrievalService.search` — partial-success first-class (principe 6.3) ; facade `pdf-service` préserve la forme aplatie pour l'IPC `pdf:search` (commit `31958a9`) | Fait |
| 1.8 | Backend | M | 🔬 Recherche documentaire faite (incl. mise à jour ministral-3 + Llama 4) — voir `docs/research-ollama-tools-1.8.md`. Whitelist révisée : `ministral-3:8b`, `qwen3:8b`, `ministral-3:14b`, `qwen3:14b`, `mistral-nemo` (fallback), `qwen3:32b`. **Famille Llama 3 et 4 retirées** (formats tool-call non standards, et Llama 4 dépasse 32 GB de RAM). Reste à implémenter : map `model → tools-capable`, normaliseur `arguments` (object vs string, issue #6002), détection version Ollama pour streaming tools. | Oui — décider whitelist finale + implémenter ([A9](actions-frederic.md#a9)) |
| 1.9 | Backend | M | ✅ Tests pour les 7 outils MCP non couverts (`searchEuropeana`, `searchObsidian`, `searchTropy`, `searchZotero`, `searchDocuments`, `entityContext`, `graphNeighbors`) — 54 nouveaux cas, 100% des outils exposés ont désormais une suite. Helper `_helpers.ts` mutualise capture du `McpServer.tool()` + fixtures sqlite éphémères. Script `npm run test:integration` rebuild better-sqlite3 pour Node ABI puis le restore | Fait |

**Gate Phase 1** : la promesse goose #1 (« ajouter un provider = un fichier ») est vraie sans concession ; aucun `OllamaClient` hors backup de git history ; Electron ≥ 34 ; tous les secrets sensibles passent par `secureStorage`.

### Phase 2 — Identité du mode Brainstorm (≈ 3-6 semaines)

La fusion ne délivre sa valeur promise que si Brainstorm devient *plus qu'un chat*. C'est la phase où l'on porte réellement ClioBrain.

| # | Type | Effort | Description | [USER] |
|---|---|---|---|---|
| 2.1 | Design | S | Arbitrer mode *Explorer* vs *Brainstorm* vs *Analyze* — aligner barre sur narratif stratégique | Oui — décision de positionnement ([A10](actions-frederic.md#a10)) |
| 2.2 | Design | S | Décider ambition : quelles features ClioBrain garder (idées, tags, backlinks, graphe in-place, canvas) | Oui — shortlist MVP ([A11](actions-frederic.md#a11)) |
| 2.3 | Frontend + Design | L | Introduire objet « Idée/Note » persistant (titre, tags, liens, origine de chat) + store `ideaStore` + vue *board* | Non — une fois 2.2 arbitré |
| 2.4 | Frontend + Design | M | Afficher le graphe de connaissances dans Brainstorm (panneau latéral recalculé au fur des tours) | Non |
| 2.5 | Frontend | M | Surface tool-use MCP dans le chat Brainstorm — tools `ready` injectés dans `fusion:chat:start` | Oui — UX opt-in vs auto-enable ([A12](actions-frederic.md#a12)) |
| 2.6 | Frontend | M | Améliorer pont Brainstorm → Write : insertion au curseur, undo, badge persistant | Oui — où s'insère le draft ([A13](actions-frederic.md#a13)) |
| 2.7 | Frontend + Design | L | UI Recipes v1 : dupliquer builtin, éditer YAML, historique des runs (lire `recipes-runs/*.jsonl`) | Oui — forme d'édition (monaco/form/text) ([A14](actions-frederic.md#a14)) |
| 2.8 | Frontend + Design | M | Surface Sécurité (événements `security-events.jsonl`) — onglet Settings avec stats par `kind`/`severity` | Oui — niveau d'alarme UX ([A15](actions-frederic.md#a15)) |
| 2.9 | Design | S | Onboarding first-run : écran si `recentProjects.length===0` + tour guidé 4 étapes | Oui — contenu pédagogique ([A16](actions-frederic.md#a16)) |
| 2.10 | Design | S | Empty state Brainstorm enrichi (3 prompts exemples historiens + lien vers hints) | Oui — rédaction exemples ([A16](actions-frederic.md#a16)) |

**Gate Phase 2** : un utilisateur ClioBrain v1 retrouve ses objets fondamentaux dans Brainstorm ; un utilisateur ClioDeck découvre une valeur ajoutée distincte du Chat classique.

### Phase 3 — Qualité de code, accessibilité, polish (≈ 2-4 semaines)

Dette accumulée. Peut tourner en parallèle de Phase 2 si bandwidth le permet.

| # | Type | Effort | Description | [USER] |
|---|---|---|---|---|
| 3.1 | Frontend | M | Extraire inline-styles fusion vers `.css` dédiés (notamment `BrainstormChat.css`) | Non |
| 3.2 | Frontend + Design | S | Purge couleurs hardcodées dans `.tsx` (92 occurrences) — introduire tokens `--color-success-bg`, `--color-warning-bg` | Non |
| 3.3 | Design | S | `:focus-visible` global + skip-link + audit contraste icônes | Non |
| 3.4 | Design | S | Refonte Settings : sidebar catégorisée + recherche au lieu de 15 sections empilées | Oui — arbitrage persona target ([A17](actions-frederic.md#a17)) |
| 3.5 | Frontend | M | `notificationStore` + composant `<StatusToast>` — unifier retours (vault, recipe, MCP, RAG) | Oui — comportement bloquant vs non ([A18](actions-frederic.md#a18)) |
| 3.6 | Design | S | Déduplication `CorpusExplorer` — panneau droit OU mode Analyze, pas les deux | Oui — choix architecture ([A19](actions-frederic.md#a19)) |
| 3.7 | Design | M | Status bar persistante (bas de fenêtre) : état MCP / vault / indexation | Non |
| 3.8 | Frontend | S | Éradiquer les 107 `any` (hooks/useIPCWithTimeout, similarityStore, modeStore) | Non |
| 3.9 | Frontend | S | Remplacer 276 `console.*` par `utils/logger.ts` | Non |
| 3.10 | Frontend | S | State machine typée pour `projectStore.loadProject` (idle / loading / ready / failed) | Non |
| 3.11 | Backend | L | Décomposer `retrieval-service.ts:515-707 (searchSecondary)` en `SecondaryRetriever` testé | Non |
| 3.12 | Backend | S | Sortir `ACADEMIC_TERMS_FR_TO_EN` de `retrieval-service.ts:153` vers config workspace | Oui — public cible ([A20](actions-frederic.md#a20)) |
| 3.13 | Sécurité | S | DOMPurify sur previews citeproc | Non |
| 3.14 | Sécurité | S | Rotation mensuelle + gzip `mcp-access.jsonl` et `security-events.jsonl` | Oui — TTL par défaut ([A21](actions-frederic.md#a21)) |
| 3.15 | Design | S | Traduire « Workspace hints » en FR (« Consignes de projet » ou « Mémento ») | Oui — terme à valider ([A22](actions-frederic.md#a22)) |
| 3.16 | Frontend | L | Découper `CorpusExplorerPanel.tsx` (1072 lignes) en 3-4 sous-composants | Non |

### Phase 4 — Release readiness (≈ 1-2 semaines + infra)

| # | Type | Effort | Description | [USER] |
|---|---|---|---|---|
| 4.1 | Sécurité | M | ADR 0005 threat model ; ADR 0006 credential storage ; ADR 0007 code signing | Oui — décisions produit ([A23](actions-frederic.md#a23)) |
| 4.2 | Sécurité | L | Signature macOS + notarization, Authenticode Windows, AppImage signing | Oui — comptes + budget ([A24](actions-frederic.md#a24)) |
| 4.3 | Sécurité | S | Bandeau UI « ce chat sort vers provider cloud » quand provider ≠ Ollama/embedded | Oui — décision produit ([A25](actions-frederic.md#a25)) |
| 4.4 | Backend | L | Path A benchmark + swap : `EnhancedVectorStoreRetriever`, unifier vault dans le store principal | Oui — fournir corpus gold standard ([A26](actions-frederic.md#a26)) |
| 4.5 | Backend | S | Isoler les 21 tests cassés (better-sqlite3 / Ollama live) derrière un tag `integration` | Non |

---

## 4. Matrice complète des TODOs

Voir tableaux par phase ci-dessus. Total : **~64 items** dont :
- 7 Phase 0 (3 avec intervention user)
- 9 Phase 1 (5 avec intervention)
- 10 Phase 2 (8 avec intervention — phase hautement produit)
- 16 Phase 3 (6 avec intervention)
- 5 Phase 4 (5 avec intervention — décisions produit et budget)

Sous-total d'items nécessitant Frédéric : **27 points d'intervention**, détaillés dans `docs/actions-frederic.md`.

---

## 5. Ce que ça donne, en résumé

1. **Phase 0 est incompressible** — ce sont des bugs actifs en prod (`modeId=undefined`), des failles qui reposent sur des défenses écrites mais dormantes, et des fuites de clés API sur disque. À faire en premier, sans débat.
2. **Phase 1 complète la fusion promise par les commits** — OllamaClient legacy, compactor, Electron upgrade. Sans ça, le code garde un pied dans la version pré-fusion.
3. **Phase 2 est la phase produit** — c'est là qu'on décide ce qu'est vraiment Brainstorm. C'est aussi celle qui réclame le plus de ton temps en décisions non-techniques.
4. **Phase 3 est de la dette ingénierie + accessibilité** — peut tourner en parallèle si tu as un backup dev.
5. **Phase 4 conditionne la distribution institutionnelle** — sans signature, les universités refuseront de recommander ClioDeck à leurs chercheurs.

**Pour l'estimation de temps** : en solo et temps partiel, Phase 0+1 = ~6 semaines ; Phase 2 = ~8 semaines ; Phase 3 = 4 semaines qui peuvent se glisser dedans. Phase 4 dépend du calendrier release.

**Tes points d'intervention chronologiques** → `docs/actions-frederic.md`.
