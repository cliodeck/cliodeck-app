/**
 * Fusion chat service (phase 3.2, refactored to use `ChatEngine`).
 *
 * Drives a streamed Brainstorm chat through the typed `ProviderRegistry`
 * (built from the user-level `LLMConfig` via the cliodeck adapter), with
 * automatic `.cliohints` injection. Each session has an `AbortController`
 * the renderer can trigger via `cancel(sessionId)`.
 *
 * The LLM turn loop (streaming, tool-use agent, retrieval injection) lives
 * in `chat-engine.ts` so the eventual legacy chat migration can share it.
 * This file is now strictly the Electron/IPC transport layer + wiring
 * (provider registry, `.cliohints`, MCP tools, retrieval adapter).
 */

import { BrowserWindow, dialog } from 'electron';
import type { WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { configManager } from './config-manager.js';
import { manuscriptIndexService } from './manuscript-index-service.js';
import { projectManager } from './project-manager.js';
import {
  retrievalService,
  type ManuscriptMappedSearchResult,
  type MultiSourceSearchResult,
} from './retrieval-service.js';
import { mcpClientsService } from './mcp-clients-service.js';
import type { ToolDescriptor } from '../../../backend/core/llm/providers/base.js';
import { type RAGExplanation } from '../../../backend/types/chat-source.js';
import {
  runChatTurn,
  type ChatEngineRetriever,
  type ChatEngineRetrievalOptions,
  type ChatEngineSystemPromptConfig,
  type ChatEngineToolHandler,
} from './chat-engine.js';
import { modeService } from './mode-service.js';
import { historyService } from './history-service.js';
import { inspectToolResult } from './mcp-tool-guard.js';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import {
  decideCloudConsent,
  type ConsentPrompt,
} from '../../../backend/security/cloud-consent.js';
import { appendSecurityEvent } from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';

export interface BrainstormSource {
  /** `manuscrit` : extrait du texte de l'auteur, pas d'une source. */
  kind: 'archive' | 'bibliographie' | 'note' | 'manuscrit';
  sourceType: 'primary' | 'secondary' | 'vault' | 'manuscript';
  title: string;
  snippet: string;
  similarity: number;
  relativePath?: string;
  // Traceability fields (see renderer store for field docs).
  documentId?: string;
  pageNumber?: number;
  chunkOffset?: number;
  itemId?: string;
  imagePath?: string;
  notePath?: string;
  /** Manuscrit : chapitre d'origine. */
  chapterId?: string;
  lineNumber?: number;
}

/**
 * Lift RetrievalService hits into the wire-level `BrainstormSource` shape
 * used by the Brainstorm UI. Every hit carries enough information to
 * re-open its origin: the returned record is the single source of truth
 * for the citation click-through flow (`sources:open-pdf`,
 * `sources:reveal-tropy`, `sources:open-note`).
 */
export function hitsToSources(hits: MultiSourceSearchResult[]): BrainstormSource[] {
  return hits.map((h) => {
    const kind: BrainstormSource['kind'] =
      h.sourceType === 'primary'
        ? 'archive'
        : h.sourceType === 'vault'
          ? 'note'
          : 'bibliographie';
    const vaultSrc =
      h.sourceType === 'vault'
        ? (h.source as { relativePath?: string } | undefined)
        : undefined;
    const title = h.document.title || vaultSrc?.relativePath || 'Sans titre';

    const base: BrainstormSource = {
      kind,
      sourceType: h.sourceType,
      title,
      snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 400),
      similarity: h.similarity,
      relativePath: vaultSrc?.relativePath,
    };

    if (h.sourceType === 'secondary') {
      // SearchResult: chunk.documentId + chunk.pageNumber + chunk.startPosition.
      const chunk = h.chunk as unknown as {
        documentId?: string;
        pageNumber?: number;
        startPosition?: number;
      };
      base.documentId = chunk.documentId ?? h.document.id;
      base.pageNumber = chunk.pageNumber;
      base.chunkOffset = chunk.startPosition;
    } else if (h.sourceType === 'primary') {
      base.itemId = h.document.id ?? h.chunk.documentId;
    } else if (h.sourceType === 'vault') {
      base.notePath = vaultSrc?.relativePath;
    }

    return base;
  });
}

/**
 * Extraits du manuscrit → sources affichables. Le corpus manuscrit sort par
 * un canal séparé de `RetrievalService` (il ne partage pas la forme des
 * documents externes) ; ici il rejoint les autres, avec un `kind` distinct :
 * l'auteur doit voir quand une réponse s'appuie sur son propre texte plutôt
 * que sur une source.
 */
export function manuscriptHitsToSources(
  hits: ManuscriptMappedSearchResult[]
): BrainstormSource[] {
  return hits.map((h) => ({
    kind: 'manuscrit' as const,
    sourceType: 'manuscript' as const,
    title: h.source.sectionTitle
      ? `${h.document.title ?? h.source.relativePath} — ${h.source.sectionTitle}`
      : (h.document.title ?? h.source.relativePath),
    snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 400),
    similarity: h.similarity,
    relativePath: h.source.relativePath,
    notePath: h.source.relativePath,
    lineNumber: h.source.line,
    chapterId: h.source.chapterId,
  }));
}
import {
  loadWorkspaceHints,
  prependAsSystemMessage,
} from '../../../backend/core/hints/loader.js';
import {
  createRegistryFromClioDeckConfig,
  resolveActiveChatModel,
} from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import { ContextCompactor } from '../../../backend/core/context-mgmt/compactor.js';
import { getContextWindow } from '../../../backend/core/llm/context-windows.js';
import type {
  ChatChunk,
  ChatMessage,
} from '../../../backend/core/llm/providers/base.js';

/**
 * RAG filter/tuning bag carried from the renderer into the retriever. Same
 * fields as the legacy `EnrichedRAGOptions` but reduced to what actually
 * matters cross-cutting: scoping and topK. Vault opt-in is implicit via
 * `sourceType === 'vault'` (or caller keeps the Brainstorm default of
 * primary+secondary+vault).
 */
export interface FusionChatRetrievalOptions {
  documentIds?: string[];
  collectionKeys?: string[];
  sourceType?: 'primary' | 'secondary' | 'both' | 'vault';
  /** Opt-in to Obsidian vault alongside primary/secondary. Ignored when
   *  `sourceType === 'vault'` (vault-only). */
  includeVault?: boolean;
  topK?: number;
}

export interface FusionChatSystemPromptOptions {
  /** Mode id — resolved to text via `modeService.getModeManager()`. */
  modeId?: string;
  /** Free-form override; takes precedence over the resolved mode text. */
  customText?: string;
  /**
   * Free-mode switch (legacy parity with `chat-service.noSystemPrompt`).
   * When true — or when `modeId === 'free-mode'` — the service injects NO
   * system prompt: no `.cliohints`, no resolved mode text, no custom text.
   * The outgoing message list contains only the caller-supplied messages.
   */
  noPrompt?: boolean;
}

/**
 * True when the caller asked for free-mode (no system prompt at all).
 * Centralised so the hints-skip branch and the mode-resolution-skip branch
 * stay in sync.
 */
/**
 * Pure adapter: translate an engine-level `ChatEngineRetrievalOptions` into
 * the narrower argument bag `RetrievalService.searchWithStats` understands.
 *
 * Honors the full 7-case truth table from `getResolvedSourceType`
 * (ragQueryStore.ts:190-209):
 *   biblio only          → { sourceType: 'secondary', includeVault: false }
 *   primary only         → { sourceType: 'primary',   includeVault: false }
 *   notes only           → { sourceType: 'vault',     includeVault: true  }
 *   biblio + primary     → { sourceType: 'both',      includeVault: false }
 *   biblio + notes       → { sourceType: 'secondary', includeVault: true  }
 *   primary + notes      → { sourceType: 'primary',   includeVault: true  }
 *   all three            → { sourceType: 'both',      includeVault: true  }
 *
 * For the vault-only case we also force `includeVault = true` (redundant but
 * explicit: `retrieval-service` already treats `sourceType === 'vault'` as
 * vault-only regardless of the flag).
 *
 * When the caller omits `includeVault` entirely — which shouldn't happen on
 * the renderer path since `useChatSettingsProjection` always resolves both
 * fields — we default to `false` (strict) EXCEPT for vault-only, preserving
 * the "never silently widen the scope" invariant the UI contract relies on.
 */
export function resolveRetrievalArgs(options?: ChatEngineRetrievalOptions): {
  sourceType: 'primary' | 'secondary' | 'both' | 'vault';
  includeVault: boolean;
} {
  const st = options?.sourceType;
  const sourceType: 'primary' | 'secondary' | 'both' | 'vault' =
    st === 'vault' || st === 'primary' || st === 'secondary' || st === 'both'
      ? st
      : 'both';
  const includeVault =
    sourceType === 'vault' ? true : options?.includeVault === true;
  return { sourceType, includeVault };
}

export function isFreeMode(sp: FusionChatSystemPromptOptions | undefined): boolean {
  if (!sp) return false;
  if (sp.noPrompt === true) return true;
  if (sp.modeId === 'free-mode' || sp.modeId === 'free') return true;
  return false;
}

export interface ChatStartArgs {
  webContents: WebContents;
  messages: ChatMessage[];
  /** Optional caller-supplied id; otherwise generated. */
  sessionId?: string;
  opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * Override Ollama's `num_ctx` for this call. Useful for models with
     * a 128K/256K window that Ollama otherwise truncates to 2048 by
     * default. Ignored by cloud providers (fixed window per model).
     */
    numCtx?: number;
  };
  /** Filters forwarded to `RetrievalService`. */
  retrievalOptions?: FusionChatRetrievalOptions;
  /** System-prompt override (mode / custom text). */
  systemPrompt?: FusionChatSystemPromptOptions;
  /**
   * Opt-in/opt-out filter on the MCP tool catalog (fusion 2.5). Tool
   * names are namespaced — `${clientName}__${bareToolName}` — exactly as
   * they appear in the wire format the model sees. When the array is
   * provided, only tools whose namespaced name appears in it are sent
   * to the model. When `undefined`, every `ready` tool is sent
   * (legacy behaviour, preserved for callers that haven't been updated).
   */
  enabledTools?: string[];
}

export interface ChatStreamEnvelope {
  sessionId: string;
  chunk: ChatChunk;
  /** When present, terminal envelope carrying a fatal error message. */
  error?: { code: string; message: string };
}

class FusionChatService {
  private active = new Map<string, AbortController>();

  /**
   * Kick off a streamed chat. Returns synchronously with the sessionId;
   * chunks arrive on `webContents.send('fusion:chat:chunk', envelope)`.
   */
  start(args: ChatStartArgs): string {
    const sessionId = args.sessionId ?? randomUUID();
    const controller = new AbortController();
    this.active.set(sessionId, controller);

    // Fire and forget — the stream pumps chunks via webContents.
    void this.pump(sessionId, controller, args)
      .catch((e) => {
        // Unhandled errors inside pump() would otherwise be swallowed by
        // the fire-and-forget pattern; surface them so we see the root cause.
        console.error('[fusion-chat] pump crashed', sessionId, e);
      })
      .finally(() => {
        this.active.delete(sessionId);
      });

    return sessionId;
  }

  /**
   * Fenêtre de dialogue pour le consentement distant, ou `null` quand il n'y
   * a pas d'interface (tests, headless) — auquel cas la politique est le
   * refus, cf. `decideCloudConsent`.
   */
  private consentPrompt(): ConsentPrompt | null {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    return {
      showMessageBox: (options) => dialog.showMessageBox(win, options as never),
    };
  }

  cancel(sessionId: string): boolean {
    const c = this.active.get(sessionId);
    if (!c) return false;
    c.abort();
    return true;
  }

  private async pump(
    sessionId: string,
    controller: AbortController,
    args: ChatStartArgs
  ): Promise<void> {
    const safeSend = (channel: string, payload: unknown): void => {
      try {
        if (!args.webContents.isDestroyed()) {
          args.webContents.send(channel, payload);
        }
      } catch {
        // Renderer gone — abandon silently.
      }
    };
    const sendChunk = (chunk: ChatChunk, error?: { code: string; message: string }): void => {
      const envelope: ChatStreamEnvelope = { sessionId, chunk };
      if (error) envelope.error = error;
      safeSend('fusion:chat:chunk', envelope);
    };

    // --- Research journal accumulation ---------------------------------
    // Ported from legacy chat-service.logMessagesToHistory: record the
    // user turn + the assistant turn + a rag_query AI-operation so the
    // Journal panel keeps showing brainstorm/write exchanges after the
    // unified-chat cutover.
    const turnStartedAt = Date.now();
    let assistantText = '';
    let recordedSources: BrainstormSource[] = [];

    let registry;
    let activeModel: string;
    let cfg: ReturnType<typeof configManager.getLLMConfig>;
    try {
      cfg = configManager.getLLMConfig();
      registry = createRegistryFromClioDeckConfig(cfg);
      activeModel = args.opts?.model ?? resolveActiveChatModel(cfg);
    } catch (e) {
      sendChunk(
        { delta: '', done: true, finishReason: 'error' },
        {
          code: 'config_error',
          message: e instanceof Error ? e.message : String(e),
        }
      );
      return;
    }

    // --- Consentement d'envoi distant (ADR 0005) -------------------------
    // La garde vit ici, et non plus seulement dans le renderer : le main est
    // le seul à savoir quel fournisseur va réellement être appelé. Une
    // nouvelle surface d'envoi qui oublierait le dialogue est arrêtée ici.
    // Sans fenêtre (headless), on refuse plutôt que de supposer.
    try {
      const decision = await decideCloudConsent(
        { backend: cfg.backend, ollamaURL: cfg.ollamaURL },
        this.consentPrompt()
      );
      if (decision.allowed === false) {
        const { providerName, reason } = decision;
        const message =
          reason === 'no-interface'
            ? `Envoi vers ${providerName} refusé : aucun consentement accordé pour cette session.`
            : `Envoi vers ${providerName} annulé.`;
        await registry.dispose().catch(() => undefined);
        sendChunk(
          { delta: '', done: true, finishReason: 'error' },
          { code: 'cloud_consent_required', message }
        );
        return;
      }
    } catch (e) {
      await registry.dispose().catch(() => undefined);
      sendChunk(
        { delta: '', done: true, finishReason: 'error' },
        {
          code: 'cloud_consent_error',
          message: e instanceof Error ? e.message : String(e),
        }
      );
      return;
    }

    let messages = args.messages;
    const projectPath = projectManager.getCurrentProjectPath();
    const freeMode = isFreeMode(args.systemPrompt);

    // Workspace hints — prepend before handing off to the engine so the
    // engine's retrieval-injected system message stacks on top cleanly.
    // Free-mode short-circuits hint injection to match legacy parity
    // (`chat-service.noSystemPrompt`): the caller wants a truly unprompted
    // conversation.
    if (projectPath && !freeMode) {
      try {
        const hints = await loadWorkspaceHints(projectPath);
        messages = prependAsSystemMessage(messages, hints);
      } catch {
        // Hints absent / unreadable — proceed without them.
      }
    }

    const llm = registry.getLLM();

    // Build a context compactor (fusion 1.3) sized to the active chat
    // model. Engine runs `compactor.compact(messages)` at the start of
    // each agent-loop iteration; long brainstorm sessions stop
    // saturating the provider's window without the renderer or the
    // user touching anything. `keepRecentTurns` left at the default
    // (4) — historians referencing earlier exchanges expect the last
    // few questions to stay verbatim, the older middle gets a faithful
    // third-person summary.
    const compactor = new ContextCompactor({
      llm,
      // When the caller explicitly sized `num_ctx` for this turn, honour
      // that as the compaction budget — otherwise the compactor would
      // assume the model's full advertised window and let the prompt
      // overflow the smaller per-call allocation.
      contextWindow: getContextWindow(activeModel, args.opts?.numCtx),
      summarizeOptions: {
        // Lower temperature for the summary call to stay faithful.
        temperature: 0,
      },
    });

    // --- Assemble MCP tool catalog + dispatcher ---------------------------
    const toolScope = new Map<string, string>(); // namespaced tool name → client name
    const tools: ToolDescriptor[] = [];
    // Optional opt-in/opt-out filter from the renderer (fusion 2.5).
    // `undefined` keeps legacy behaviour (every `ready` tool is sent);
    // an explicit set narrows to user-enabled tools.
    const enabledToolFilter = args.enabledTools
      ? new Set(args.enabledTools)
      : null;
    if (llm.capabilities.tools) {
      for (const client of mcpClientsService.list()) {
        if (client.state !== 'ready') continue;
        for (const t of client.tools) {
          const namespaced = `${client.name}__${t.name}`;
          if (enabledToolFilter && !enabledToolFilter.has(namespaced)) continue;
          toolScope.set(namespaced, client.name);
          tools.push({
            name: namespaced,
            description: `[${client.name}] ${t.description ?? ''}`.trim(),
            parameters:
              (t.inputSchema as Record<string, unknown>) ??
              ({ type: 'object', properties: {} } as Record<string, unknown>),
          });
        }
      }
    }

    // Les serveurs MCP tiers sont « semi-trusted » (ADR 0005) : leurs
    // résultats sont du contenu non fiable, au même titre qu'un chunk RAG.
    // Ils passent donc par le SourceInspector et par une borne de taille
    // avant d'atteindre le contexte du modèle — lequel dispose d'outils
    // réels et boucle jusqu'à `maxTurns`.
    const securityLogPath = projectPath
      ? workspaceFiles(projectPath).securityEventsLog
      : null;
    const emitSecurityEvent = securityLogPath
      ? (e: SecurityEvent) => {
          void appendSecurityEvent(securityLogPath, e).catch((err) => {
            console.warn('[fusion-chat] security event log failed:', err);
          });
        }
      : undefined;

    const toolHandler: ChatEngineToolHandler = {
      async call(name, toolArgs) {
        const clientName = toolScope.get(name);
        if (!clientName) {
          return {
            ok: false,
            error: { code: 'unknown_tool', message: `No client owns tool ${name}` },
          };
        }
        const bare = name.slice(clientName.length + 2); // strip "clientName__"
        const raw = await mcpClientsService.callTool(clientName, bare, toolArgs);
        return inspectToolResult(raw, {
          toolName: name,
          mode: retrievalService.getInspectorMode(),
          onEvent: emitSecurityEvent,
        });
      },
    };

    // --- Retrieval adapter -------------------------------------------------
    // Note: SourceInspector runs inside retrieval-service.search() — chunks
    // are already filtered by the configured mode (warn/audit/block) before
    // hits reach this adapter.
    const retriever: ChatEngineRetriever<BrainstormSource> | undefined = projectPath
      ? {
          async search(lastUser, options?: ChatEngineRetrievalOptions) {
            // Strict routing per the 7-case truth table (see
            // `resolveRetrievalArgs`). `retrieval-service` natively
            // short-circuits `sourceType === 'vault'` to Obsidian only.
            const { sourceType, includeVault } = resolveRetrievalArgs(options);
            // Le manuscrit est un quatrième corpus : ce que l'auteur a déjà
            // écrit. Désactivable par `rag.indexManuscript`.
            const includeManuscript = manuscriptIndexService.isEnabled();
            const { hits, manuscriptHits, stats } = await retrievalService.searchWithStats({
              query: lastUser,
              sourceType,
              includeVault,
              includeManuscript,
              documentIds: options?.documentIds,
              collectionKeys: options?.collectionKeys,
              topK: options?.topK,
            });
            const ownHits = manuscriptHits ?? [];
            if (hits.length === 0 && ownHits.length === 0) return null;
            return {
              systemPrompt:
                formatContextAsSystemPrompt(hits) + formatManuscriptContext(ownHits, hits.length),
              sources: [...hitsToSources(hits), ...manuscriptHitsToSources(ownHits)],
              explanation: {
                search: stats.search,
                timing: stats.timing,
              },
            };
          },
        }
      : undefined;

    // --- System-prompt composition ----------------------------------------
    // Precedence (legacy parity):
    //   1. explicit customText (UI `useCustomSystemPrompt` + `customSystemPrompt`)
    //   2. resolved mode text (modeId → ResolvedMode.systemPrompt.fr by default)
    //   3. nothing — fall back to whatever the provider / registry defaults do
    // `.cliohints` were already prepended above and sit *below* the system
    // override inside the message list.
    let resolvedSystemText: string | undefined;
    let systemPromptConfig: ChatEngineSystemPromptConfig | undefined;
    if (freeMode) {
      // Free-mode: engine must NOT inject any system message. Leave
      // `systemPromptConfig` undefined so `runChatTurn` skips its
      // customText branch entirely.
      resolvedSystemText = undefined;
      systemPromptConfig = undefined;
    } else {
      resolvedSystemText = args.systemPrompt?.customText;
      if (!resolvedSystemText && args.systemPrompt?.modeId) {
        try {
          const mode = await modeService
            .getModeManager()
            .getMode(args.systemPrompt.modeId);
          // Default to the FR prompt — matches the `chat-service` default.
          // Renderer can pass `customText` if it wants a different locale.
          resolvedSystemText = mode?.systemPrompt?.fr || mode?.systemPrompt?.en;
        } catch (e) {
          console.warn('[fusion-chat] mode resolution failed:', e);
        }
      }
      systemPromptConfig =
        resolvedSystemText || args.systemPrompt?.modeId
          ? {
              customText: resolvedSystemText,
              modeId: args.systemPrompt?.modeId,
            }
          : undefined;
    }

    try {
      await runChatTurn<BrainstormSource>({
        provider: llm,
        messages,
        signal: controller.signal,
        opts: args.opts,
        tools,
        toolHandler,
        retriever,
        retrievalOptions: args.retrievalOptions,
        systemPrompt: systemPromptConfig,
        compactor,
        hooks: {
          onStatus: (status) => {
            safeSend('fusion:chat:status', { sessionId, status });
          },
          onChunk: (chunk) => {
            if (chunk.delta) assistantText += chunk.delta;
            sendChunk(chunk);
          },
          onDone: (chunk) => {
            if (chunk.delta) assistantText += chunk.delta;
            sendChunk(chunk);
          },
          onError: (err) =>
            sendChunk({ delta: '', done: true, finishReason: 'error' }, err),
          onSources: (sources) => {
            recordedSources = sources as BrainstormSource[];
            safeSend('fusion:chat:context', { sessionId, sources });
          },
          onExplanation: (explanation: RAGExplanation) => {
            safeSend('fusion:chat:explanation', { sessionId, explanation });
          },
          onToolCallStart: (ev) => {
            // Preserve the legacy IPC shape (bareTool without client prefix,
            // sessionId-scoped callId) for the renderer.
            const clientName = toolScope.get(ev.name);
            const bareTool = clientName ? ev.name.slice(clientName.length + 2) : ev.name;
            safeSend('fusion:chat:tool-call', {
              sessionId,
              callId: `${sessionId}-${ev.callId}`,
              name: bareTool,
              status: 'started',
              startedAt: ev.startedAt,
            });
          },
          onToolCallEnd: (ev) => {
            const clientName = toolScope.get(ev.name);
            const bareTool = clientName ? ev.name.slice(clientName.length + 2) : ev.name;
            safeSend('fusion:chat:tool-call', {
              sessionId,
              callId: `${sessionId}-${ev.callId}`,
              name: bareTool,
              status: 'done',
              durationMs: ev.durationMs,
              ok: ev.ok,
              errorMessage: ev.errorMessage,
            });
          },
        },
      });
    } finally {
      await registry.dispose().catch(() => undefined);
      console.log('[fusion-chat] turn done', {
        sessionId,
        sources: recordedSources.length,
        assistantChars: assistantText.length,
      });
      this.recordJournalEntry({
        userMessage: args.messages[args.messages.length - 1],
        assistantText,
        sources: recordedSources,
        durationMs: Date.now() - turnStartedAt,
        modeId: args.systemPrompt?.modeId,
        // Provider et modèle séparés — le champ composite "name (model)"
        // rendait `queryParams.model` ambigu dans le journal de recherche
        // (docs/chat-unification-etat-des-lieux.md §2.4).
        providerName: llm?.name ?? 'unknown',
        modelName: llm?.model ?? 'unknown',
        retrievalOptions: args.retrievalOptions,
      });
    }
  }

  /**
   * Ported from legacy chat-service.logMessagesToHistory (step 5 deletion).
   * Fail-soft: the chat round-trip must not crash because the journal
   * manager is unavailable or the project was closed mid-turn.
   */
  private recordJournalEntry(entry: {
    userMessage: ChatMessage | undefined;
    assistantText: string;
    sources: BrainstormSource[];
    durationMs: number;
    modeId?: string;
    providerName: string;
    modelName: string;
    retrievalOptions?: ChatEngineRetrievalOptions;
  }): void {
    try {
      const hm = historyService.getHistoryManager();
      if (!hm) return;
      const userText =
        typeof entry.userMessage?.content === 'string'
          ? entry.userMessage.content
          : '';
      if (!userText && !entry.assistantText) return;

      const queryParams = {
        model: entry.modelName,
        provider: entry.providerName,
        topK: entry.retrievalOptions?.topK,
        sourceType: entry.retrievalOptions?.sourceType,
        includeVault: entry.retrievalOptions?.includeVault,
        documentIds: entry.retrievalOptions?.documentIds,
        collectionKeys: entry.retrievalOptions?.collectionKeys,
        modeId: entry.modeId ?? 'default-assistant',
      };

      const serialisedSources =
        entry.sources.length > 0
          ? entry.sources.map((s) => ({
              documentId: s.documentId ?? s.itemId ?? s.notePath ?? '',
              documentTitle: s.title,
              pageNumber: s.pageNumber,
              similarity: s.similarity,
              sourceType: s.sourceType,
            }))
          : undefined;

      if (userText) {
        hm.logChatMessage({
          role: 'user',
          content: userText,
          queryParams,
        });
      }
      if (entry.assistantText) {
        hm.logChatMessage({
          role: 'assistant',
          content: entry.assistantText,
          sources: serialisedSources,
          queryParams,
        });
      }

      if (entry.sources.length > 0 && entry.assistantText) {
        hm.logAIOperation({
          operationType: 'rag_query',
          durationMs: entry.durationMs,
          inputText: userText,
          inputMetadata: {
            topK: entry.retrievalOptions?.topK,
            sourceType: entry.retrievalOptions?.sourceType,
            sourcesFound: entry.sources.length,
          },
          modelName: entry.modelName,
          modelParameters: { provider: entry.providerName },
          outputText: entry.assistantText,
          outputMetadata: {
            sources: serialisedSources ?? [],
            responseLength: entry.assistantText.length,
          },
          success: true,
        });
      }
    } catch (e) {
      console.warn('[fusion-chat] journal logging failed (non-fatal)', e);
    }
  }
}

export const fusionChatService = new FusionChatService();

/**
 * Render a set of retrieval hits as a system-prompt block.
 *
 * Each hit is structured (TITRE / AUTEUR / EXTRAIT) so the model can
 * treat the document title as first-class grounded content — a model
 * that sees `[Doc: ...]` inline in a chunk body tends to dismiss it as
 * metadata and refuse to answer identification questions ("What is X?")
 * even when X is literally the paper's title. The redundant
 * `[Doc: ... | Section: ...]` prefix the chunker prepends is stripped
 * from the extract for the same reason.
 *
 * Snippet length bumped from 800 → 1500 chars so a single chunk has
 * enough prose for the model to ground a definition.
 */
/**
 * Bloc de contexte pour les extraits du manuscrit. Séparé de celui des
 * sources : le modèle doit savoir qu'il lit le texte de l'auteur — s'y
 * appuyer comme sur une source ferait passer une hypothèse de travail pour
 * une preuve. La numérotation continue celle des sources.
 */
function formatManuscriptContext(
  hits: ManuscriptMappedSearchResult[],
  offset: number
): string {
  if (hits.length === 0) return '';
  const SNIPPET_CHARS = 1500;
  const lines: string[] = [
    '',
    "Extraits du MANUSCRIT EN COURS (texte de l'auteur, pas une source).",
    "Tu peux t'y référer pour rappeler ce qui a déjà été écrit, signaler une répétition ou une contradiction. Ne le cite JAMAIS comme une preuve : ce n'est pas une source.",
    '',
  ];
  hits.forEach((h, i) => {
    const where = h.source.sectionTitle
      ? `${h.document.title ?? h.source.relativePath} — ${h.source.sectionTitle}`
      : (h.document.title ?? h.source.relativePath);
    const snippet = h.chunk.content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
    lines.push(`[M${offset + i + 1}] ${where}`);
    lines.push(`EXTRAIT : ${snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}

function formatContextAsSystemPrompt(hits: MultiSourceSearchResult[]): string {
  const SNIPPET_CHARS = 1500;
  const DOC_HEADER_RE = /^\[Doc:[^\]]*\]\s*/;

  const lines: string[] = [
    'Contexte extrait du corpus indexé (sources numérotées ci-dessous).',
    "RÈGLE : réponds UNIQUEMENT à partir des sources ci-dessous (champs TITRE, AUTEUR et EXTRAIT). Ne complète JAMAIS avec tes connaissances générales.",
    "Le TITRE d'un document fait partie intégrante de son contenu. Pour une question d'identification (« qu'est-ce que X ? » où X est un nom ou un acronyme), un TITRE qui contient X est une réponse valide que tu dois utiliser.",
    "Cite le numéro de la source [N] pour chaque affirmation.",
    "Si après lecture des TITRES et des EXTRAITS l'information est réellement absente, indique-le brièvement et avec tes propres mots (n'utilise aucune formule pré-écrite).",
    '',
  ];
  hits.forEach((h, i) => {
    const title = h.document.title || h.document.id || 'Sans titre';
    const kind =
      h.sourceType === 'primary'
        ? 'archive'
        : h.sourceType === 'vault'
          ? 'note'
          : 'bibliographie';

    const author =
      h.sourceType !== 'vault' ? (h.document.author as string | undefined) : undefined;
    const year =
      h.sourceType === 'secondary'
        ? ((h.document as { year?: string }).year as string | undefined)
        : undefined;
    const page =
      h.sourceType === 'secondary'
        ? (h.chunk as { pageNumber?: number }).pageNumber
        : undefined;

    const rawSnippet = h.chunk.content
      .replace(DOC_HEADER_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNIPPET_CHARS);

    lines.push(`[${i + 1}] type : ${kind}`);
    lines.push(`TITRE : ${title}`);
    if (author || year) {
      lines.push(`AUTEUR : ${[author, year].filter(Boolean).join(', ')}`);
    }
    lines.push(page ? `EXTRAIT (p. ${page}) :` : 'EXTRAIT :');
    lines.push(rawSnippet);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
