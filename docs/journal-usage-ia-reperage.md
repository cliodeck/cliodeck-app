# Repérage — Journal d'usage IA

> Compte rendu d'exploration exigé par `docs/INSTRUCTIONS_journal-usage-ia.md` §6.1,
> à produire **avant** de coder. Liste les points d'insertion retenus et les pièges.
> Statut : rédigé en amont de la Phase 1.

## 1. Point de passage unique pour la capture

Tous les appels de complétion (`chat`, `complete`) et d'embedding (`embed`) transitent
par un **registre unique de providers** :

- `ProviderRegistry.getLLM()` — `backend/core/llm/providers/registry.ts:186-197`
- `ProviderRegistry.getEmbedding()` — `backend/core/llm/providers/registry.ts:199-210`

Les deux getters instancient paresseusement (et mémoïsent) le provider. **Aucun service
ne fabrique un provider hors du registre** : chaque service/handler passe par
`createRegistryFromClioDeckConfig(...)` puis `getLLM()`/`getEmbedding()`. Le chemin CLI
(`scripts/cli/registry-from-v2.ts`) construit `new ProviderRegistry(...)` directement,
mais passe **aussi** par les getters — donc un décorateur posé *dans* les getters
l'instrumente également.

**Décision : décorateur dans `getLLM()`/`getEmbedding()`.** Point de passage réellement
universel (streaming `chat`, non-streaming `complete`, `embed`), y compris CLI et recipes.

### Interfaces concernées (`backend/core/llm/providers/base.ts`)

- `LLMProvider.chat(messages, opts): AsyncIterable<ChatChunk>` — L133-157
- `LLMProvider.complete(prompt, opts): Promise<string>` — jette l'usage dans **tous** les providers
- `EmbeddingProvider.embed(texts, opts): Promise<number[][]>` — L159-172, **jamais d'usage**
- `ChatChunk.usage?` (promptTokens/completionTokens/totalTokens) présent **uniquement**
  sur le chunk terminal (`done: true`), quand le backend le fournit — L105-123

## 2. Tokens : réels vs estimés

| Provider | complétion (tokens API) | embeddings |
|---|---|---|
| Ollama | oui (`prompt_eval_count`/`eval_count`) | non |
| Anthropic | oui (`usage.input/output_tokens`) | pas d'embeddings |
| Gemini | oui (`usageMetadata`) | non |
| OpenAI-compatible | **non en pratique** (`stream_options.include_usage` non activé) | non |
| Mistral | hérite d'OpenAI-compatible → **non** | non |

Conséquences :
- **Embeddings : estimation `chars/4` systématique**, champ `tokens_estimated: true`.
- **Complétions OpenAI/Mistral : estimées** (sauf serveurs compat qui renvoient `usage`).
- `complete()` jette l'usage partout → **le décorateur ré-itère le `chat()` interne**
  pour récupérer les tokens, plutôt que d'appeler le `complete()` du provider.

## 3. Indexation en masse → un seul `embedding_batch`

Les trois pipelines bouclent `embed([unChunk])` **chunk par chunk** :

- PDF : `backend/core/pdf/PDFIndexer.ts:465-533` (frontière : `indexPDF`, par document)
- Obsidian : `backend/integrations/obsidian/ObsidianVaultIndexer.ts:69-199` (frontière :
  `indexAll` ; déjà 16-par-lot via `embedBatched` L288-300)
- Tropy : `src/main/services/tropy-service.ts:298-432` (frontière :
  `generateEmbeddingsForSources` ; renvoie déjà `{sourcesProcessed, chunksCreated}`)

Un décorateur au niveau `embed()` sur-émettrait (N événements/document). **Décision :
scope de batch** — les 3 fonctions-frontières ouvrent un scope ; le décorateur accumule
(compte de chunks + tokens estimés) et flush **un seul** `embedding_batch` à la fermeture.
Hors scope (embeddings de requête, fan-out query-expansion de
`secondary-retriever.ts:182-184`, warmup dictionnaire `retrieval-service.ts:368-394`) →
événement `embedding` simple.

## 4. Contexte applicatif (mode / workspace / corpus / recipe)

Le décorateur ne connaît que provider/modèle/tokens. Le reste passe par un
**`AsyncLocalStorage`** (main process) posé au point d'émission.

- **Workspace root** : `projectManager.getCurrentProjectPath()` —
  `src/main/services/project-manager.ts:63` (répertoire contenant `.cliodeck/`).
- **Mode applicatif** : ⚠️ `workspaceModeStore.ts` (`explore|brainstorm|write|export`)
  est **renderer-only, localStorage**, invisible du main. Stratégie retenue :
  **miroir + override backend** — le renderer pousse le mode courant via IPC
  `usage:set-mode` à chaque changement ; les contextes backend (`recipe`/`mcp`/`cli`)
  posent leur littéral au point d'émission. (L'instruction dit `analyze` ; l'app dit
  `explore` — même chose, on garde le terme de l'app.)
- Deux notions de « mode » coexistent : `modeService`/`modeStore` (preset d'assistant LLM,
  `default-assistant`…) ≠ `workspaceModeStore` (navigation 4-modes). C'est le **second**
  qui nous intéresse.

## 5. Log MCP existant — référencer, ne pas dupliquer

`.cliodeck/mcp-access.jsonl` — deux écrivains, un contrat (`redactForAudit`) :
- serveur : `backend/mcp-server/logger.ts` (`MCPAccessEvent`, `backend/mcp-server/events.ts`)
- client : `src/main/services/mcp-clients-service.ts:78-90` (`MCPClientEvent`)

Session délimitée positionnellement par `server_started`→`server_stopped` (pas de
champ session-id). **Décision : un événement de synthèse `mcp_session`** dans le journal,
référençant le fichier + plage (offset/lignes) — pas de copie de contenu. Priorité basse.

## 6. Stockage — `.cliodeck/journal.db` séparé

DB **distincte de `brain.db`** (instructions §3.3 : copiable/archivable/publiable
indépendamment). Chemin calculé via `workspaceFiles(root).root` (le répertoire
`.cliodeck/`) **sans modifier `layout.ts`** (fichier protégé, CLAUDE.md §4).

Idiome `better-sqlite3` calqué sur `backend/core/history/HistoryManager.ts` :
`CREATE TABLE IF NOT EXISTS`, table `journal_meta` clé-valeur avec `schema_version`,
migrations gardées `if (version < N)`, `randomUUID()`, timestamps ISO. Écritures
**non bloquantes** (buffer + flush débouncé, `try/catch` avaleur) : une panne du journal
ne fait **jamais** échouer un appel LLM.

## 7. Surfaces d'intégration (chemins exacts)

- **Collision de nommage** : `journalStore.ts` / `components/Journal/` / IPC `history:*`
  sont **déjà** le *journal de recherche* (`history_ai_operations` = prompts, dans
  `brain.db`). Le journal d'usage IA utilise un espace **distinct** :
  DB `journal.db`, IPC `usage:*`, store `usageJournalStore`, dossier `UsageJournal/`.
  Le CLI reste `cliodeck journal` (pas de collision).
- **Service** : `src/main/services/usage-journal-service.ts` (modèle `history-service.ts`) ;
  `init`/`close` câblés dans `src/main/ipc/handlers/project-handlers.ts` (`project:load`
  ~L98, `project:close` ~L138).
- **IPC** : chaque `*-handlers.ts` exporte `setupXHandlers()`, enregistré dans
  `src/main/ipc/index.ts`. Idiome : `ipcMain.handle`, `validate(ZodSchema, raw)`,
  `successResponse`/`errorResponse` (`src/main/ipc/utils/`). Preload : bloc `usage: {…}`
  avant `contextBridge.exposeInMainWorld('electron', api)` (`src/preload/index.ts`).
- **CLI** : `scripts/cliodeck-cli.ts` route vers `scripts/cli/*.ts` (parser maison
  `scripts/cli/args.ts`, flag `--workspace`). ⚠️ **ABI** : le CLI tourne en system-node
  (`--experimental-strip-types`) ; ouvrir `journal.db` (natif) y casse
  `NODE_MODULE_VERSION`. **Décision : wrapper Electron-node** `bin/cliodeck-journal`
  (idiome `bin/cliodeck-mcp`, `ELECTRON_RUN_AS_NODE=1`).
- **Renderer** : `stores/usageJournalStore.ts` (modèle `journalStore.ts`),
  `components/UsageJournal/UsageJournalPanel.tsx`, extension de `RightPanelView`
  (`workspaceModeStore.ts`) + `MainLayout.tsx` ; section Config optionnelle.

## Ordre d'implémentation

Conforme aux instructions §6 : (1) ce repérage → (2) schéma + service + hook →
(3) agrégation + `journal today` → (4) annotation CLI → (5) exports →
(6) UI renderer → (7) docs/ADR/tests/CHANGELOG. Un commit par étape.
