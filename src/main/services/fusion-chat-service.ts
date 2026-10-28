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
import { detectManuscriptIntent } from '../../../backend/core/rag/manuscript-intent.js';
import {
  normalizeStance,
  resolveManuscriptPolicy,
  shouldIncludeManuscript,
  type ManuscriptPolicy,
  type ManuscriptWording,
} from './manuscript-policy.js';
import type { ManuscriptStance } from '../../../backend/types/mode.js';
import { readingNotesIndexService } from './reading-notes-index-service.js';
import { projectManager } from './project-manager.js';
import {
  retrievalService,
  type ManuscriptMappedSearchResult,
  type MultiSourceSearchResult,
  type ReadingNoteMappedSearchResult,
  type SelectedDocumentLabel,
} from './retrieval-service.js';
import { mcpClientsService } from './mcp-clients-service.js';
import type { ToolDescriptor } from '../../../backend/core/llm/providers/base.js';
import { type RAGExplanation } from '../../../backend/types/chat-source.js';
import type { LLMConfig } from '../../../backend/types/config.js';
import {
  runChatTurn,
  type ChatEngineRetriever,
  type ChatEngineRetrievalOptions,
  type ChatEngineSystemPromptConfig,
  type ChatEngineToolHandler,
} from './chat-engine.js';
import { modeService } from './mode-service.js';
import { ContextCompressor } from '../../../backend/core/rag/ContextCompressor.js';
import { historyService } from './history-service.js';
import { inspectToolResult } from './mcp-tool-guard.js';
import { workspaceFiles } from '../../../backend/core/workspace/layout.js';
import {
  classifyProvider,
  cloudConsentRefusalMessage,
  decideCloudConsent,
  type ConsentPrompt,
} from '../../../backend/security/cloud-consent.js';
import { appendSecurityEvent } from '../../../backend/security/source-inspector.js';
import type { SecurityEvent } from '../../../backend/security/events.js';

export interface BrainstormSource {
  /**
   * `manuscrit` : extrait du texte de l'auteur, pas d'une source.
   * `lecture` : note de lecture de l'auteur sur une référence, pas la référence.
   */
  kind: 'archive' | 'bibliographie' | 'note' | 'manuscrit' | 'lecture';
  sourceType: 'primary' | 'secondary' | 'vault' | 'manuscript' | 'readingNotes';
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
  /**
   * Événements de l'inspecteur de sécurité attachés à CE chunk (#8) —
   * alimente le badge « source signalée » de la surface de chat. Absent
   * quand rien n'a été détecté.
   */
  securityEvents?: SecurityEvent[];
}

/**
 * Lift RetrievalService hits into the wire-level `BrainstormSource` shape
 * used by the Brainstorm UI. Every hit carries enough information to
 * re-open its origin: the returned record is the single source of truth
 * for the citation click-through flow (`sources:open-pdf`,
 * `sources:reveal-tropy`, `sources:open-note`).
 */
/** Indexe les événements de l'inspecteur par chunk (#8). */
function groupEventsByChunk(
  events: SecurityEvent[]
): Map<string, SecurityEvent[]> | undefined {
  if (events.length === 0) return undefined;
  const map = new Map<string, SecurityEvent[]>();
  for (const e of events) {
    const list = map.get(e.chunkId);
    if (list) list.push(e);
    else map.set(e.chunkId, [e]);
  }
  return map;
}

export function hitsToSources(
  hits: MultiSourceSearchResult[],
  securityEventsByChunk?: Map<string, SecurityEvent[]>
): BrainstormSource[] {
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

    const events = securityEventsByChunk?.get(h.chunk.id);
    if (events && events.length > 0) {
      base.securityEvents = events;
    }

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

/**
 * Extraits des notes de lecture → sources affichables. Le titre nomme la
 * référence commentée (`@clé — titre`) : c'est ce que l'auteur reconnaît, et
 * ce qui empêche de lire l'extrait comme une citation de l'ouvrage.
 */
export function readingNoteHitsToSources(
  hits: ReadingNoteMappedSearchResult[]
): BrainstormSource[] {
  return hits.map((h) => ({
    kind: 'lecture' as const,
    sourceType: 'readingNotes' as const,
    title: readingNoteLabel(h),
    snippet: h.chunk.content.replace(/\s+/g, ' ').slice(0, 400),
    similarity: h.similarity,
    relativePath: h.source.relativePath,
    notePath: h.source.relativePath,
    lineNumber: h.source.line,
  }));
}

function readingNoteLabel(h: ReadingNoteMappedSearchResult): string {
  const title = h.document.title && h.document.title !== h.source.relativePath ? h.document.title : null;
  return title ? `@${h.source.citekey} — ${title}` : `@${h.source.citekey}`;
}

/**
 * Les notes de lecture entrent-elles dans ce tour ?
 *
 * Elles sont le travail personnel de l'historien, plus intime que ses
 * sources publiées : un fournisseur distant ne les reçoit que si l'auteur
 * l'a accepté dans les réglages. Le consentement de session (ADR 0005) ne
 * suffit pas — il autorise l'envoi du tour, pas celui de ce corpus.
 */
export function shouldIncludeReadingNotes(opts: {
  enabled: boolean;
  isCloud: boolean;
  cloudConsent: boolean;
}): boolean {
  if (!opts.enabled) return false;
  return !opts.isCloud || opts.cloudConsent;
}

// La place du manuscrit dans un tour est une politique à part entière
// (`manuscript-policy.ts`) ; `shouldIncludeManuscript` y vit et reste
// exporté d'ici pour les appelants et les tests historiques.
export { shouldIncludeManuscript };

/** Ce que la recherche d'un tour laisse au journal, en plus des sources. */
interface TurnRetrievalRecord {
  includeManuscript: boolean;
  contextChars: {
    total: number;
    sources: number;
    manuscript: number;
    readingNotes: number;
  };
  /** La politique du manuscrit retenue pour ce tour, et ce qui l'a décidée. */
  manuscript: Pick<ManuscriptPolicy, 'stance' | 'wording' | 'slots' | 'reason'> & {
    requested?: boolean;
    recallIntent: boolean;
    recallMatch?: string;
  };
}
import {
  loadWorkspaceHints,
  prependAsSystemMessage,
} from '../../../backend/core/hints/loader.js';
import { guardWorkspaceHints } from './hints-guard.js';
import { createInactivityWatchdog } from './inactivity-watchdog.js';
import {
  applyChatModelOverride,
  createRegistryFromClioDeckConfig,
  isLocalOllamaGeneration,
  resolveActiveChatModel,
} from '../../../backend/core/llm/providers/cliodeck-config-adapter.js';
import { ContextCompactor } from '../../../backend/core/context-mgmt/compactor.js';
import {
  clampNumCtx,
  getContextWindow,
} from '../../../backend/core/llm/context-windows.js';
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

/** Langues dans lesquelles l'application sait écrire ses consignes (cf. `ModeLocalizedText`). */
export type PromptLanguage = 'fr' | 'en';

/**
 * Langue des consignes du tour : celle demandée par le renderer, sinon
 * `rag.systemPromptLanguage`, sinon le français. Tout était en français en
 * dur — texte du mode par défaut et bloc de contexte — quelle que soit la
 * langue choisie dans le panneau ou les réglages.
 */
export function resolvePromptLanguage(
  requested: string | undefined,
  configured: string | undefined
): PromptLanguage {
  if (requested === 'fr' || requested === 'en') return requested;
  return configured === 'en' ? 'en' : 'fr';
}

export interface FusionChatSystemPromptOptions {
  /** Mode id — resolved to text via `modeService.getModeManager()`. */
  modeId?: string;
  /** Free-form override; takes precedence over the resolved mode text. */
  customText?: string;
  /**
   * Langue des consignes que l'application écrit elle-même : texte du mode
   * quand `customText` est absent, et bloc de contexte de la recherche.
   * Absente, c'est `rag.systemPromptLanguage` des réglages qui s'applique.
   */
  language?: PromptLanguage;
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
  sourceType: 'primary' | 'secondary' | 'both' | 'vault' | 'manuscript';
  includeVault: boolean;
} {
  const st = options?.sourceType;
  // `manuscript` (palier 2) : le manuscrit seul, quand « Mon manuscrit » est
  // la seule case cochée. Jamais ramené à `both` — ce serait l'élargissement
  // silencieux que l'interface promet de ne jamais faire.
  const sourceType: 'primary' | 'secondary' | 'both' | 'vault' | 'manuscript' =
    st === 'vault' || st === 'primary' || st === 'secondary' || st === 'both' || st === 'manuscript'
      ? st
      : 'both';
  const includeVault =
    sourceType === 'vault' ? true : sourceType === 'manuscript' ? false : options?.includeVault === true;
  return { sourceType, includeVault };
}

/** Ce qui part au moteur pour un tour, une fois filtré par le fournisseur. */
export interface TurnOptions {
  temperature?: number;
  maxTokens?: number;
  numCtx?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  think?: boolean;
}

/**
 * Filtre les options d'un tour selon le fournisseur réellement appelé.
 *
 * Tout ce qui est propre à Ollama — fenêtre `num_ctx`, top-p, top-k,
 * pénalité de répétition — ne part que vers la génération Ollama locale.
 * La fenêtre a la particularité de servir aussi de budget au compacteur :
 * un fournisseur cloud ignore `num_ctx` dans la requête, mais une fenêtre
 * d'un million saisie pour Qwen restait appliquée à Claude (200K), la
 * compaction ne se déclenchait plus et les longues sessions finissaient
 * en erreur API (revue de la PR #84). Sans fenêtre venue du panneau, c'est
 * `llm.ollamaNumCtx` des réglages qui s'applique, sinon le défaut du
 * serveur Ollama (4 096 jetons quel que soit le modèle). Anthropic refuse
 * par ailleurs `temperature` et `top_p` ensemble sur les Claude récents.
 * La température, elle, vaut pour tous.
 */
export function resolveTurnOptions(
  cfg: LLMConfig,
  opts: ChatStartArgs['opts']
): TurnOptions {
  const local = isLocalOllamaGeneration(cfg);
  return {
    temperature: opts?.temperature,
    maxTokens: opts?.maxTokens,
    numCtx: local ? (opts?.numCtx ?? clampNumCtx(cfg.ollamaNumCtx)) : undefined,
    topP: local ? opts?.topP : undefined,
    topK: local ? opts?.topK : undefined,
    repeatPenalty: local ? opts?.repeatPenalty : undefined,
    think: local ? opts?.think : undefined,
  };
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
    /**
     * Modèle choisi dans le panneau du chat. Sa liste vient d'Ollama, donc
     * il n'est appliqué qu'à la génération Ollama locale
     * (`applyChatModelOverride`) ; un backend cloud ou le modèle embarqué
     * gardent le modèle des réglages.
     */
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * Override Ollama's `num_ctx` for this call. Useful for models with
     * a 128K/256K window that Ollama otherwise truncates to 2048 by
     * default. Ignored by cloud providers (fixed window per model).
     * Absent, c'est `llm.ollamaNumCtx` des réglages qui s'applique.
     */
    numCtx?: number;
    topP?: number;
    topK?: number;
    /** `repeat_penalty` d'Ollama ; n'est transmis qu'à la génération Ollama locale. */
    repeatPenalty?: number;
    /** `false` coupe le raisonnement d'un modèle pensant ; Ollama local seulement. */
    think?: boolean;
    /**
     * Délai d'inactivité du tour (curseur « Timeout » du panneau). Le tour
     * est interrompu après ce délai sans chunk, statut, source ni événement
     * d'outil — jamais pendant qu'une réponse continue d'arriver.
     */
    timeoutMs?: number;
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

    // --- Délai d'inactivité (curseur « Timeout » du panneau) -------------
    // Il ne borne pas la durée d'un tour : une réponse qui continue
    // d'arriver n'est jamais coupée. Il interrompt un tour dont plus rien ne
    // vient — modèle en chargement sans fin, outil MCP bloqué, connexion
    // morte — après `timeoutMs` sans chunk, statut, source ni événement
    // d'outil. Le curseur existait sans consommateur depuis la fusion.
    // Créé ici, ARMÉ seulement juste avant `runChatTurn` : entre les deux se
    // trouve le dialogue de consentement cloud, qui attend l'utilisateur et
    // non le modèle — armé trop tôt, le watchdog coupait le tour d'un
    // utilisateur parti réfléchir devant le dialogue (revue de la PR #84).
    const watchdog = createInactivityWatchdog({
      timeoutMs: args.opts?.timeoutMs,
      onTimeout: () => controller.abort(),
    });
    const timeoutError = (): { code: string; message: string } => ({
      code: 'timeout',
      message: `Aucune réponse du modèle depuis ${Math.max(
        1,
        Math.round((args.opts?.timeoutMs ?? 0) / 60_000)
      )} min : génération interrompue.`,
    });

    // --- Research journal accumulation ---------------------------------
    // Ported from legacy chat-service.logMessagesToHistory: record the
    // user turn + the assistant turn + a rag_query AI-operation so the
    // Journal panel keeps showing brainstorm/write exchanges after the
    // unified-chat cutover.
    const turnStartedAt = Date.now();
    let assistantText = '';
    let thinkingText = '';
    let recordedSources: BrainstormSource[] = [];
    let lastRetrieval: TurnRetrievalRecord | undefined;

    let registry;
    let activeModel: string;
    let cfg: ReturnType<typeof configManager.getLLMConfig>;
    try {
      // Le modèle du panneau de chat entre dans la configuration du tour
      // AVANT la construction du registre : c'est le seul chemin par lequel
      // il atteint le fournisseur. Il ne redescend pas dans `opts.model`
      // du moteur — le registre le porte déjà, et un fournisseur cloud ne
      // doit jamais voir un nom de modèle Ollama.
      cfg = applyChatModelOverride(
        configManager.getLLMConfig(),
        args.opts?.model
      );
      registry = createRegistryFromClioDeckConfig(cfg);
      activeModel = resolveActiveChatModel(cfg);
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
        const message = cloudConsentRefusalMessage(decision);
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
    const promptLang = resolvePromptLanguage(
      args.systemPrompt?.language,
      configManager.getRAGConfig().systemPromptLanguage
    );

    // Puits d'événements de sécurité, déclaré AVANT ses deux consommateurs
    // — le garde du contexte de projet juste en dessous, et celui des
    // résultats d'outils MCP plus bas. Le laisser près du second le rendait
    // inaccessible au premier : une `ReferenceError` de zone morte
    // temporelle, avalée par le `try/catch` des hints, aurait désactivé
    // `context.md` sans le moindre signe.
    //
    // Les serveurs MCP tiers sont « semi-trusted » (ADR 0005) : leurs
    // résultats sont du contenu non fiable, au même titre qu'un chunk RAG.
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

    // Workspace hints — prepend before handing off to the engine. The engine
    // puts the mode text above them and the retrieval block below them, just
    // before the conversation (chat-engine.ts, 2026-10).
    // Free-mode short-circuits hint injection to match legacy parity
    // (`chat-service.noSystemPrompt`): the caller wants a truly unprompted
    // conversation.
    if (projectPath && !freeMode) {
      try {
        const hints = await loadWorkspaceHints(projectPath);
        // `context.md` vit à la RACINE du projet : il voyage avec un dossier
        // partagé. Injecté en rôle `system`, il se retrouverait au-dessus des
        // consignes de l'application elle-même. Il passe donc par le même
        // garde que les résultats d'outils MCP — borne de taille et
        // inspection — au lieu d'être la dernière entrée non défendue.
        const guarded = guardWorkspaceHints(hints, {
          mode: retrievalService.getInspectorMode(),
          onEvent: emitSecurityEvent,
        });
        messages = prependAsSystemMessage(messages, guarded);
      } catch {
        // Hints absent / unreadable — proceed without them.
      }
    }

    const llm = registry.getLLM();

    // Options du tour (voir `resolveTurnOptions`). La fenêtre `num_ctx`
    // est transmise à Ollama ET sert de budget au compacteur, pour que les
    // deux parlent de la même fenêtre.
    const turnOpts = resolveTurnOptions(cfg, args.opts);
    const numCtx = turnOpts.numCtx;

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
      contextWindow: getContextWindow(activeModel, numCtx),
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
            const manuscriptOnly = sourceType === 'manuscript';
            const topK = options?.topK ?? configManager.getRAGConfig().topK;
            // Le manuscrit : ce que l'auteur a déjà écrit. Sa place dans le
            // tour est une politique (manuscript-policy.ts, palier 2) :
            // question de rappel > portée > case « Mon manuscrit » > posture
            // du mode de chat, résolue ici, côté main, à chaque tour.
            const recall = detectManuscriptIntent(lastUser);
            const manuscript = resolveManuscriptPolicy({
              enabled: manuscriptIndexService.isEnabled(),
              requested: options?.includeManuscript,
              sourceType,
              documentIds: options?.documentIds,
              collectionKeys: options?.collectionKeys,
              stance: await resolveManuscriptStance(args.systemPrompt?.modeId),
              recallIntent: recall.intent,
              topK,
            });
            // Cinquième corpus : les notes de lecture. Désactivable par
            // `rag.indexReadingNotes`, hors d'un fournisseur distant sans
            // `rag.readingNotesCloudConsent`, et hors de la portée
            // « manuscrit seul » — l'utilisateur a nommé ce qu'il interroge.
            const includeReadingNotes =
              !manuscriptOnly &&
              shouldIncludeReadingNotes({
                enabled: readingNotesIndexService.isEnabled(),
                isCloud: classifyProvider({ backend: cfg.backend, ollamaURL: cfg.ollamaURL })
                  .isCloud,
                cloudConsent: readingNotesIndexService.cloudConsent(),
              });
            // Manuscrit seul demandé mais écarté (index désactivé) : rien à
            // chercher ailleurs, et chercher quand même embarquerait la
            // question pour jeter les résultats sous une bande nulle.
            if (manuscriptOnly && !manuscript.include) return null;
            const { hits, manuscriptHits, readingNoteHits, stats, securityEvents } =
              await retrievalService.searchWithStats({
              query: lastUser,
              sourceType,
              includeVault,
              includeManuscript: manuscript.include,
              manuscriptSlots: manuscript.slots,
              includeReadingNotes,
              documentIds: options?.documentIds,
              collectionKeys: options?.collectionKeys,
              topK: options?.topK,
            });
            const ownHits = manuscriptHits ?? [];
            const noteHits = readingNoteHits ?? [];
            if (hits.length === 0 && ownHits.length === 0 && noteHits.length === 0) return null;

            // --- Compression du contexte (#28) --------------------------
            // ContextCompressor existait depuis la fusion sans aucun site
            // d'appel. Branché ici, entre la recherche et l'injection :
            // mode prioritaire (ragOverrides.enableContextCompression),
            // repli sur le réglage RAG global (défaut : activé). Le
            // compresseur est lui-même un no-op sous 10 k caractères.
            // IMPORTANT : prompt ET sources partent des MÊMES hits
            // compressés — les citations [N] du modèle doivent correspondre
            // au panneau de sources.
            let effectiveHits = hits;
            let compressionSlice: RAGExplanation['compression'] | undefined;
            let compressionMs: number | undefined;
            if (
              hits.length > 0 &&
              (await isCompressionEnabled(args.systemPrompt?.modeId))
            ) {
              const t0 = Date.now();
              const chunks = hits.map((h, i) => ({
                content: h.chunk.content,
                // Le VRAI document d'origine : la dédup du compresseur est
                // intra-document (les fenêtres de chunking qui se
                // chevauchent), un même passage cité par deux documents est
                // une corroboration à garder.
                documentId:
                  h.document.id ??
                  (h.chunk as { documentId?: string }).documentId ??
                  `hit-${i}`,
                documentTitle: h.document.title || '',
                pageNumber: (h.chunk as { pageNumber?: number }).pageNumber ?? 0,
                similarity: h.similarity,
                // Clé de correspondance vers le hit d'origine — opaque pour
                // le compresseur, qui la transporte telle quelle.
                key: String(i),
              }));
              const compressed = new ContextCompressor().compress(chunks, lastUser);
              compressionMs = Date.now() - t0;
              effectiveHits = compressed.chunks.map((c) => {
                const original = hits[Number(c.key)];
                // Seul le contenu du chunk est réécrit ; le discriminant
                // sourceType/document est préservé — le spread élargit
                // l'union, d'où le cast.
                return {
                  ...original,
                  chunk: { ...original.chunk, content: c.content },
                } as MultiSourceSearchResult;
              });
              compressionSlice = {
                enabled: true,
                originalChunks: compressed.stats.originalChunks,
                finalChunks: compressed.stats.compressedChunks,
                originalSize: compressed.stats.originalSize,
                finalSize: compressed.stats.compressedSize,
                reductionPercent: compressed.stats.reductionPercent,
                strategy: compressed.stats.strategy,
              };
            }

            // Les blocs sont construits séparément pour que leur taille soit
            // mesurée sur ce qui part vraiment : la part du manuscrit dans le
            // contexte se lit dans le panneau d'explication et le journal.
            // Une sélection de documents n'a pas de sens pour le manuscrit
            // seul : le renderer la garde quand la bibliographie est décochée,
            // et la ligne « recherche limitée à N documents » suivrait
            // « aucune source n'a été interrogée ».
            const scopeBlock = manuscriptOnly
              ? ''
              : formatSelectionScope(
                  options?.documentIds?.length ?? 0,
                  retrievalService.describeDocuments(options?.documentIds ?? []),
                  promptLang
                );
            // Manuscrit seul : pas d'en-tête « aucune source », qui dirait au
            // modèle que bibliographie et archives ont été interrogées en vain
            // alors qu'elles ne l'ont pas été ; la consigne du bloc manuscrit
            // porte alors le périmètre.
            const sourcesBlock = manuscriptOnly
              ? ''
              : formatContextAsSystemPrompt(effectiveHits, promptLang, {
                  ownBlocksFollow: ownHits.length + noteHits.length > 0,
                });
            const manuscriptBlock = formatManuscriptContext(ownHits, promptLang, manuscript.wording);
            const notesBlock = formatReadingNotesContext(noteHits, promptLang);
            const contextChars = {
              total:
                scopeBlock.length +
                sourcesBlock.length +
                manuscriptBlock.length +
                notesBlock.length,
              sources: sourcesBlock.length,
              manuscript: manuscriptBlock.length,
              readingNotes: notesBlock.length,
            };
            lastRetrieval = {
              includeManuscript: manuscript.include,
              contextChars,
              manuscript: {
                stance: manuscript.stance,
                wording: manuscript.wording,
                slots: manuscript.slots,
                reason: manuscript.reason,
                requested: options?.includeManuscript,
                recallIntent: recall.intent,
                recallMatch: recall.match,
              },
            };

            return {
              systemPrompt: scopeBlock + sourcesBlock + manuscriptBlock + notesBlock,
              sources: [
                ...hitsToSources(effectiveHits, groupEventsByChunk(securityEvents)),
                ...manuscriptHitsToSources(ownHits),
                ...readingNoteHitsToSources(noteHits),
              ],
              explanation: {
                search: { ...stats.search, contextChars },
                ...(compressionSlice ? { compression: compressionSlice } : {}),
                timing: {
                  ...stats.timing,
                  ...(compressionMs !== undefined ? { compressionMs } : {}),
                },
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
          // Le mode par défaut arrive sans `customText` : c'est ici que sa
          // langue se décide. `.fr` en dur rendait le sélecteur de langue
          // du panneau inerte pour ce mode.
          resolvedSystemText =
            mode?.systemPrompt?.[promptLang] ||
            mode?.systemPrompt?.fr ||
            mode?.systemPrompt?.en;
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
      watchdog.touch();
      await runChatTurn<BrainstormSource>({
        provider: llm,
        messages,
        signal: controller.signal,
        opts: turnOpts,
        tools,
        toolHandler,
        retriever,
        retrievalOptions: args.retrievalOptions,
        systemPrompt: systemPromptConfig,
        compactor,
        hooks: {
          onStatus: (status) => {
            watchdog.touch();
            safeSend('fusion:chat:status', { sessionId, status });
          },
          onChunk: (chunk) => {
            watchdog.touch();
            if (chunk.delta) assistantText += chunk.delta;
            if (chunk.thinking) thinkingText += chunk.thinking;
            sendChunk(chunk);
          },
          onDone: (chunk) => {
            watchdog.disarm();
            if (chunk.delta) assistantText += chunk.delta;
            // L'abandon déclenché par le délai d'inactivité arrive ici
            // comme un `cancelled` ordinaire : le renderer doit savoir que
            // ce n'est pas lui qui a annulé.
            if (watchdog.timedOut) {
              sendChunk({ delta: '', done: true, finishReason: 'error' }, timeoutError());
              return;
            }
            sendChunk(chunk);
          },
          onError: (err) => {
            watchdog.disarm();
            sendChunk(
              { delta: '', done: true, finishReason: 'error' },
              watchdog.timedOut ? timeoutError() : err
            );
          },
          onSources: (sources) => {
            watchdog.touch();
            recordedSources = sources as BrainstormSource[];
            safeSend('fusion:chat:context', { sessionId, sources });
          },
          onExplanation: (explanation: RAGExplanation) => {
            watchdog.touch();
            safeSend('fusion:chat:explanation', { sessionId, explanation });
          },
          onToolCallStart: (ev) => {
            watchdog.touch();
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
            watchdog.touch();
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
      watchdog.disarm();
      await registry.dispose().catch(() => undefined);
      console.log('[fusion-chat] turn done', {
        sessionId,
        sources: recordedSources.length,
        assistantChars: assistantText.length,
      });
      this.recordJournalEntry({
        userMessage: args.messages[args.messages.length - 1],
        assistantText,
        thinkingText,
        sources: recordedSources,
        durationMs: Date.now() - turnStartedAt,
        modeId: args.systemPrompt?.modeId,
        // Provider et modèle séparés — le champ composite "name (model)"
        // rendait `queryParams.model` ambigu dans le journal de recherche
        // (docs/chat-unification-etat-des-lieux.md §2.4).
        providerName: llm?.name ?? 'unknown',
        modelName: llm?.model ?? 'unknown',
        retrievalOptions: args.retrievalOptions,
        retrieval: lastRetrieval,
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
    /** Raisonnement d'un modèle pensant : conservé avec la réponse, à part. */
    thinkingText?: string;
    sources: BrainstormSource[];
    durationMs: number;
    modeId?: string;
    providerName: string;
    modelName: string;
    retrievalOptions?: ChatEngineRetrievalOptions;
    /** Absent quand la recherche n'a pas tourné (pas de projet, tour sans texte). */
    retrieval?: TurnRetrievalRecord;
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
        includeManuscript: entry.retrieval?.includeManuscript,
        documentIds: entry.retrievalOptions?.documentIds,
        collectionKeys: entry.retrievalOptions?.collectionKeys,
        modeId: entry.modeId ?? 'default-assistant',
      };

      // Part de chaque corpus dans ce que le modèle a lu : c'est la mesure
      // que `scripts/manuscript-share.mjs` agrège (docs/poids-du-manuscrit.md).
      const countBy = (type: BrainstormSource['sourceType'][]): number =>
        entry.sources.filter((s) => type.includes(s.sourceType)).length;
      const corpusCounts = {
        externalHits: countBy(['secondary', 'primary', 'vault']),
        manuscriptHits: countBy(['manuscript']),
        readingNoteHits: countBy(['readingNotes']),
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
          thinking: entry.thinkingText || undefined,
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
            ...corpusCounts,
            ...(entry.retrieval
              ? {
                  includeManuscript: entry.retrieval.includeManuscript,
                  contextChars: entry.retrieval.contextChars,
                  // Ce qui a décidé de la place du manuscrit : la détection
                  // d'intention s'audite après coup sur ces lignes.
                  manuscriptPolicy: entry.retrieval.manuscript,
                }
              : {}),
          },
          modelName: entry.modelName,
          modelParameters: { provider: entry.providerName },
          outputText: entry.assistantText,
          outputMetadata: {
            sources: serialisedSources ?? [],
            responseLength: entry.assistantText.length,
            ...(entry.thinkingText ? { thinkingLength: entry.thinkingText.length } : {}),
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
 * Bloc de contexte pour les passages du manuscrit. Séparé de celui des
 * sources : le modèle doit savoir qu'il lit le texte de l'auteur — s'y
 * appuyer comme sur une source ferait passer une hypothèse de travail pour
 * une preuve.
 *
 * Le format dit la même chose que la prose (2026-10) : un séparateur, une
 * numérotation `[M1]…` indépendante de celle des sources, et un libellé
 * `PASSAGE :` distinct du champ `EXTRAIT` que la règle des sources désigne
 * comme seule matière citable. Avant, la numérotation continuait celle des
 * sources et le libellé était le même : pour un petit modèle, deux indices de
 * forme plus forts que deux phrases de négation (docs/poids-du-manuscrit.md).
 */
export function formatManuscriptContext(
  hits: ManuscriptMappedSearchResult[],
  lang: PromptLanguage = 'fr',
  wording: ManuscriptWording = 'recall'
): string {
  if (hits.length === 0) return '';
  const SNIPPET_CHARS = 1500;
  const text = CONTEXT_TEXT[lang];
  // Trois consignes pour trois situations (manuscript-policy.ts) : rappeler
  // ce qui est écrit ; tenir le manuscrit en arrière-plan d'un brainstorm ;
  // ne répondre que de lui. « L'utilisateur », jamais « l'auteur » : les
  // sources portent un champ AUTEUR, et un bloc intitulé « texte de
  // l'auteur » se lisait comme le texte de l'auteur du livre interrogé.
  const header =
    wording === 'only'
      ? text.manuscriptOnly
      : wording === 'background'
        ? text.manuscriptBackground
        : text.manuscript;
  const lines: string[] = ['', ...header, ''];
  hits.forEach((h, i) => {
    const where = h.source.sectionTitle
      ? `${h.document.title ?? h.source.relativePath} — ${h.source.sectionTitle}`
      : (h.document.title ?? h.source.relativePath);
    const snippet = h.chunk.content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
    lines.push(`[M${i + 1}] ${where}`);
    lines.push(`PASSAGE : ${snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Bloc de contexte pour les notes de lecture. Séparé des sources, comme le
 * manuscrit : une note dit ce que l'auteur pense d'une référence, pas ce que
 * la référence dit. Le modèle doit pouvoir rendre la nuance — « d'après tes
 * notes sur Braudel… » — sans attribuer à l'ouvrage une lecture de l'auteur.
 */
export function formatReadingNotesContext(
  hits: ReadingNoteMappedSearchResult[],
  lang: PromptLanguage = 'fr'
): string {
  if (hits.length === 0) return '';
  const SNIPPET_CHARS = 1500;
  const lines: string[] = ['', ...CONTEXT_TEXT[lang].readingNotes, ''];
  hits.forEach((h, i) => {
    const snippet = h.chunk.content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
    lines.push(`[L${i + 1}] ${readingNoteLabel(h)}`);
    if (h.source.tags.length > 0) lines.push(`ÉTIQUETTES : ${h.source.tags.join(', ')}`);
    // `NOTE :`, pas `EXTRAIT :` — même raison que pour le manuscrit.
    lines.push(`NOTE : ${snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * La compression du contexte est-elle active pour ce tour ? (#28)
 * Priorité : override du mode (ragOverrides.enableContextCompression),
 * puis réglage RAG global (défaut : activé). Un mode irrésoluble retombe
 * sur le réglage global — jamais d'échec de tour pour un flag de confort.
 */
async function isCompressionEnabled(modeId?: string): Promise<boolean> {
  if (modeId) {
    try {
      const mode = await modeService.getModeManager().getMode(modeId);
      const override = mode?.ragOverrides?.enableContextCompression;
      if (override !== undefined) return override;
    } catch {
      // Mode irrésoluble : réglage global seul.
    }
  }
  return configManager.getRAGConfig().enableContextCompression !== false;
}

/**
 * Posture du mode de chat envers le manuscrit (`ragOverrides.manuscript`),
 * résolue côté main à partir de `systemPrompt.modeId` — jamais depuis la
 * copie du renderer, qui perd les surcharges d'un mode au relancement. Même
 * motif qu'`isCompressionEnabled` ; un mode irrésoluble vaut `recall`.
 */
async function resolveManuscriptStance(modeId?: string): Promise<ManuscriptStance> {
  if (!modeId) return 'recall';
  try {
    const mode = await modeService.getModeManager().getMode(modeId);
    return normalizeStance(mode?.ragOverrides?.manuscript);
  } catch {
    return 'recall';
  }
}

/**
 * Consignes du bloc de contexte, par langue. Seules les phrases sont
 * traduites : les étiquettes de champ (`TITRE`, `AUTEUR`, `EXTRAIT`,
 * `type : bibliographie`) restent telles quelles dans les deux langues —
 * les prompts système anglais (`SystemPrompts.ts`, modes) les nomment
 * ainsi, et un mode personnalisé peut en dépendre.
 */
interface ContextText {
  sources: string[];
  /** Ajouté à la règle des sources quand un bloc manuscrit ou notes suit. */
  ownBlocksFollow: string;
  noSources: string;
  /** Consigne de rappel : dire à l'utilisateur ce qu'il a déjà écrit. */
  manuscript: string[];
  /** Arrière-plan d'un brainstorm : ce qu'il pense déjà, à ne pas reformuler. */
  manuscriptBackground: string[];
  /** Portée « manuscrit seul » : on ne répond que de lui. */
  manuscriptOnly: string[];
  readingNotes: string[];
  colon: string;
  scopeOne: (named: string) => string[];
  scopeMany: (count: number, named: string) => string[];
}

const CONTEXT_TEXT: Record<PromptLanguage, ContextText> = {
  fr: {
    sources: [
      'Contexte extrait du corpus indexé (sources numérotées ci-dessous).',
      'RÈGLE : réponds UNIQUEMENT à partir des sources ci-dessous (champs TITRE, AUTEUR et EXTRAIT). Ne complète JAMAIS avec tes connaissances générales.',
      "Le TITRE d'un document fait partie intégrante de son contenu. Pour une question d'identification (« qu'est-ce que X ? » où X est un nom ou un acronyme), un TITRE qui contient X est une réponse valide que tu dois utiliser.",
      'Cite le numéro de la source [N] pour chaque affirmation.',
      "Si après lecture des TITRES et des EXTRAITS l'information est réellement absente, indique-le brièvement et avec tes propres mots (n'utilise aucune formule pré-écrite).",
    ],
    ownBlocksFollow:
      "Les blocs MANUSCRIT et NOTES DE LECTURE qui suivent les sources ne sont PAS des sources : leurs numéros [M…] et [L…] ne se citent jamais à l'appui d'une affirmation.",
    noSources:
      "Aucun extrait des sources interrogées (bibliographie, archives, notes) ne correspond à cette question. Si elle porte sur une source, dis-le. Les passages qui suivent, s'il y en a, sont le texte de l'utilisateur ou ses notes de lecture : ne les présente JAMAIS comme le contenu d'une source.",
    manuscript: [
      "--- MANUSCRIT DE L'UTILISATEUR (hors sources) ---",
      "Passages du MANUSCRIT EN COURS : le texte que l'utilisateur est lui-même en train d'écrire. Ce n'est PAS une source, et les numéros [M…] ne désignent aucun des documents numérotés ci-dessus.",
      "Sers-t'en pour une seule chose : lui dire ce qu'il a déjà écrit — répétition, oubli, contradiction — en disant « dans ton manuscrit ». Toute affirmation sur le passé s'appuie sur une source [N], jamais sur un passage [M]. N'attribue JAMAIS son contenu à une source ni à l'auteur d'une source.",
    ],
    manuscriptBackground: [
      "--- CE QUE L'UTILISATEUR A DÉJÀ ÉCRIT (repères, hors sources) ---",
      "Passages de son MANUSCRIT EN COURS : ils disent ce qu'il pense déjà. Ce ne sont PAS des sources, et les numéros [M…] ne désignent aucun des documents numérotés ci-dessus.",
      "TA TÂCHE avec ces passages : propose ce que les sources [N] permettent de dire et que ces passages ne disent pas encore. Ne reformule aucun d'eux en idée nouvelle et ne les compte jamais à l'appui d'une hypothèse. Si une idée recoupe l'un d'eux, dis-le en une ligne (« déjà dans ton manuscrit, [M1] ») et passe à la suivante.",
    ],
    manuscriptOnly: [
      "PÉRIMÈTRE : l'utilisateur interroge uniquement son MANUSCRIT EN COURS — le texte qu'il est lui-même en train d'écrire. Aucune source n'a été interrogée pour ce tour, et la règle « réponds à partir des sources » ne s'applique pas.",
      "Réponds à partir des passages [M…] ci-dessous, en situant chacun (chapitre, section), en signalant les répétitions et les contradictions entre passages. Ne présente rien comme une source, et n'attribue rien à un autre auteur que l'utilisateur.",
    ],
    readingNotes: [
      "Extraits des NOTES DE LECTURE de l'utilisateur (son commentaire d'une référence, pas la référence elle-même).",
      "Présente-les comme ses notes (« d'après tes notes sur @clé »). N'attribue JAMAIS leur contenu à l'ouvrage commenté : pour citer l'ouvrage, appuie-toi sur la source.",
    ],
    colon: ' : ',
    scopeOne: (named) => [
      `PÉRIMÈTRE : l'utilisateur a limité cette recherche à un seul document de sa bibliographie${named}.`,
      "Quand il parle du « livre », du « texte », de « l'article » ou de « l'auteur » sans autre précision, il s'agit de ce document — jamais de son propre manuscrit.",
    ],
    scopeMany: (count, named) => [
      `PÉRIMÈTRE : l'utilisateur a limité cette recherche à ${count} documents de sa bibliographie${named}.`,
      "Quand il parle des « livres », des « textes » ou des « auteurs » sans autre précision, il s'agit de ces documents — jamais de son propre manuscrit.",
    ],
  },
  en: {
    sources: [
      'Context retrieved from the indexed corpus (numbered sources below).',
      'RULE: answer ONLY from the sources below (TITRE, AUTEUR and EXTRAIT fields). NEVER supplement with your general knowledge.',
      'A document\'s TITRE is part of its content. For an identification question ("what is X?" where X is a name or acronym), a TITRE that contains X is a valid answer that you must use.',
      'Cite the source number [N] for each claim.',
      'If after reading the TITRE and EXTRAIT fields the information is genuinely absent, say so briefly in your own words (do not use any pre-written formula).',
    ],
    ownBlocksFollow:
      'The MANUSCRIPT and READING NOTES blocks that follow the sources are NOT sources: their [M…] and [L…] numbers are never cited in support of a claim.',
    noSources:
      "No excerpt from the searched sources (bibliography, archives, notes) matches this question. If it is about a source, say so. The passages that follow, if any, are the user's own text or their reading notes: NEVER present them as the content of a source.",
    manuscript: [
      "--- THE USER'S MANUSCRIPT (not a source) ---",
      'Passages from the MANUSCRIPT IN PROGRESS: the text the user is writing themselves. It is NOT a source, and the [M…] numbers refer to none of the numbered documents above.',
      'Use them for one thing only: telling the user what they have already written — repetition, omission, contradiction — saying "in your manuscript". Every claim about the past rests on a source [N], never on an [M] passage. NEVER attribute their content to a source or to the author of a source.',
    ],
    manuscriptBackground: [
      '--- WHAT THE USER HAS ALREADY WRITTEN (landmarks, not sources) ---',
      'Passages from their MANUSCRIPT IN PROGRESS: they say what the user already thinks. They are NOT sources, and the [M…] numbers refer to none of the numbered documents above.',
      'YOUR TASK with these passages: propose what the sources [N] allow you to say and that these passages do not say yet. Never rephrase one of them as a new idea and never count them in support of a hypothesis. If an idea overlaps one of them, say so in one line ("already in your manuscript, [M1]") and move on.',
    ],
    manuscriptOnly: [
      'SCOPE: the user is querying only their MANUSCRIPT IN PROGRESS — the text they are writing themselves. No source was searched for this turn, and the rule "answer from the sources" does not apply.',
      'Answer from the [M…] passages below, locating each one (chapter, section) and pointing out repetitions and contradictions between passages. Present nothing as a source, and attribute nothing to any author other than the user.',
    ],
    readingNotes: [
      "Excerpts from the user's READING NOTES (their commentary on a reference, not the reference itself).",
      'Present them as their notes ("according to your notes on @key"). NEVER attribute their content to the work commented on: to cite the work, rely on the source.',
    ],
    colon: ': ',
    scopeOne: (named) => [
      `SCOPE: the user has restricted this search to a single document of their bibliography${named}.`,
      'When they mention "the book", "the text", "the article" or "the author" without further detail, they mean this document — never their own manuscript.',
    ],
    scopeMany: (count, named) => [
      `SCOPE: the user has restricted this search to ${count} documents of their bibliography${named}.`,
      'When they mention "the books", "the texts" or "the authors" without further detail, they mean these documents — never their own manuscript.',
    ],
  },
};

/** Au-delà, la sélection n'est plus « un livre » : on donne le compte, pas la liste. */
const SELECTION_SCOPE_MAX_TITLES = 5;

/**
 * Dit au modèle que l'utilisateur a restreint la recherche à des documents
 * choisis, et lesquels. Sans cette ligne, « ce livre » ou « l'auteur » n'ont
 * pas de référent. Jusqu'en 2026-10 le manuscrit — alors toujours interrogé —
 * arrivait dans le même contexte et le modèle prenait le texte de
 * l'utilisateur pour le livre sélectionné ; `shouldIncludeManuscript`
 * l'écarte désormais d'une recherche restreinte, et la ligne garde son rôle :
 * nommer le référent.
 *
 * `selectedCount` vient de la sélection, `documents` de ce qui a pu être
 * retrouvé en base : les deux peuvent différer (document supprimé depuis).
 */
export function formatSelectionScope(
  selectedCount: number,
  documents: SelectedDocumentLabel[],
  lang: PromptLanguage = 'fr'
): string {
  if (selectedCount === 0) return '';
  const text = CONTEXT_TEXT[lang];
  const complete = documents.length === selectedCount;
  // Une entrée bibliographique à plusieurs pièces jointes (PDF annoté +
  // original) est UNE ligne dans la liste du panneau mais plusieurs
  // identifiants : c'est l'ouvrage que l'on compte et que l'on nomme.
  const labels = [
    ...new Set(
      documents.map((d) => {
        const by = [d.author, d.year].filter(Boolean).join(', ');
        return by ? `« ${d.title} » (${by})` : `« ${d.title} »`;
      })
    ),
  ];
  const count = complete ? labels.length : selectedCount;
  const named =
    complete && count <= SELECTION_SCOPE_MAX_TITLES ? `${text.colon}${labels.join(' ; ')}` : '';
  return [...(count === 1 ? text.scopeOne(named) : text.scopeMany(count, named)), '', ''].join(
    '\n'
  );
}

export function formatContextAsSystemPrompt(
  hits: MultiSourceSearchResult[],
  lang: PromptLanguage = 'fr',
  opts: {
    /**
     * Vrai quand un bloc manuscrit ou notes de lecture suit : la règle des
     * sources le dit alors explicitement. Jamais émis à vide — annoncer un
     * bloc absent est un bruit qu'un petit modèle peut suivre.
     */
    ownBlocksFollow?: boolean;
  } = {}
): string {
  const text = CONTEXT_TEXT[lang];
  // Aucune source mais des extraits du manuscrit ou des notes de lecture :
  // l'en-tête « réponds UNIQUEMENT à partir des sources ci-dessous » serait
  // suivi du seul texte de l'utilisateur, que le modèle prendrait pour elles.
  if (hits.length === 0) return text.noSources;
  const SNIPPET_CHARS = 1500;
  const DOC_HEADER_RE = /^\[Doc:[^\]]*\]\s*/;

  const lines: string[] = [
    ...text.sources,
    ...(opts.ownBlocksFollow ? [text.ownBlocksFollow] : []),
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
