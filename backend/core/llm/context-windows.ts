/**
 * Per-model context-window lookup (fusion step 1.3).
 *
 * `ContextCompactor` needs to know the active model's context window to
 * decide when a conversation crosses the compaction threshold. Each
 * provider's typed `LLMProvider` exposes its `name` and is given a model
 * name at construction; this small table maps known models (matched by
 * substring on the model name, case-insensitive) to their documented
 * window sizes.
 *
 * Unknown models fall back to a conservative `DEFAULT_CONTEXT_WINDOW`,
 * which intentionally triggers compaction earlier than strictly needed
 * — better than hiding the saturation issue we currently have on long
 * brainstorm sessions (the bug `chat-engine.ts:80` reserved the
 * `compressing` phase for, never wired until now).
 *
 * Patterns are intentionally ordered most-specific-first: the first
 * match wins, so `claude-opus-4-7` resolves before the broader
 * `claude-opus-4` rule, etc.
 *
 * Refresh policy: this table lives in code on purpose — adding a new
 * model is a one-line PR with explicit reviewer eyes on the value.
 * For per-workspace overrides (a researcher running a non-standard
 * llama build with a tuned `num_ctx`), `getContextWindow` accepts an
 * `override` argument that takes precedence over the table.
 */

export const DEFAULT_CONTEXT_WINDOW = 8192;

interface Entry {
  pattern: RegExp;
  window: number;
}

const TABLE: readonly Entry[] = [
  // Anthropic Claude (4.x family + recent 3.x)
  { pattern: /claude-opus-4/i, window: 200_000 },
  { pattern: /claude-sonnet-4/i, window: 200_000 },
  { pattern: /claude-haiku-4/i, window: 200_000 },
  { pattern: /claude-3-?5-sonnet/i, window: 200_000 },
  { pattern: /claude-3/i, window: 200_000 },

  // OpenAI / OpenAI-compatible
  // GPT-6 : « 1,050,000 context window » (fiche de gpt-6-luna, « 1.05M » pour toute la famille sur
  // la page des modèles d'OpenAI, lues le 2026-11-13).
  { pattern: /gpt-6/i, window: 1_050_000 },
  { pattern: /gpt-5/i, window: 256_000 },
  { pattern: /gpt-4\.1/i, window: 1_000_000 },
  { pattern: /gpt-4o/i, window: 128_000 },
  { pattern: /gpt-4-turbo/i, window: 128_000 },
  { pattern: /gpt-4/i, window: 8_192 },
  { pattern: /gpt-3\.5/i, window: 16_385 },

  // Mistral
  { pattern: /mistral-large/i, window: 128_000 },
  { pattern: /mistral-small/i, window: 128_000 },
  { pattern: /mistral-medium/i, window: 32_000 },
  { pattern: /codestral/i, window: 256_000 },
  { pattern: /mixtral/i, window: 32_000 },
  // Local Ollama mistral / mistral-nemo (typically 32k or 128k builds);
  // pick a safe middle ground.
  { pattern: /mistral/i, window: 32_000 },

  // Google Gemini
  // Gemini 3 (3.1 Pro, 3.5 Flash-Lite, 3.6 et 3.8 Flash) : « Input token limit 1,048,576 » sur la
  // fiche de chaque modèle (lues le 2026-11-13). Sans cette entrée, la règle `/gemini/` de repli
  // donnait 32 000 et le compacteur résumait bien trop tôt.
  { pattern: /gemini-3/i, window: 1_048_576 },
  { pattern: /gemini-2\.5/i, window: 1_000_000 },
  { pattern: /gemini-2/i, window: 1_000_000 },
  { pattern: /gemini-1\.5-pro/i, window: 2_000_000 },
  { pattern: /gemini-1\.5/i, window: 1_000_000 },
  { pattern: /gemini/i, window: 32_000 },

  // Llama family (Meta + Ollama)
  { pattern: /llama-?3\.3/i, window: 131_072 },
  { pattern: /llama-?3\.[12]/i, window: 131_072 },
  { pattern: /llama-?3/i, window: 8_192 },
  { pattern: /llama-?2/i, window: 4_096 },

  // Qwen
  // Qwen 3.5 : 256K natifs, extensibles vers 1M (YaRN) — 256K est le
  // budget que le compacteur suppose quand l'utilisateur n'a rien fixé.
  { pattern: /qwen-?3\.5/i, window: 262_144 },
  { pattern: /qwen-?3/i, window: 131_072 },
  { pattern: /qwen-?2\.5/i, window: 32_768 },
  { pattern: /qwen-?2/i, window: 32_768 },

  // Other common open-weight models served via Ollama
  // Gemma 4: MoE (~4B active per token); 26B build advertises 256K but
  // 128K is the stability sweet spot per Google's model card.
  { pattern: /gemma-?4/i, window: 131_072 },
  // Gemma 3: 128K for 4B / 12B / 27B (1B caps at 32K — accept the
  // pattern-level overstatement so the compactor errs on the side of
  // never firing too early; a too-small slot is caught by Ollama).
  { pattern: /gemma-?3/i, window: 131_072 },
  { pattern: /gemma-?2/i, window: 8_192 },
  { pattern: /phi-?3/i, window: 4_096 },
  { pattern: /nomic-embed/i, window: 8_192 }, // embedding (irrelevant but listed for completeness)
];

/**
 * Resolve a context window for the given model name.
 *
 * @param modelName  Free-form model identifier (provider's `model` field).
 * @param override   Optional per-workspace override; takes precedence over
 *                   the table when > 0.
 */
export function getContextWindow(
  modelName: string | undefined,
  override?: number
): number {
  if (typeof override === 'number' && override > 0) {
    return override;
  }
  if (!modelName) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  for (const { pattern, window } of TABLE) {
    if (pattern.test(modelName)) {
      return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Fenêtre du contexte llama.cpp que crée le moteur embarqué (`EmbeddedLLMClient`), quel que soit
 * le modèle : les Qwen 2.5 en annoncent 32 768, mais le contexte réellement alloué fait 4 096
 * jetons (décision Q36, vérifiée sur un Mac Intel sous macOS 12). Une seule source pour le client,
 * le compacteur et le plafond d'extraits (S05-1-16) : le compacteur supposait 32 768 et ne protégeait
 * jamais la fenêtre réelle.
 */
export const EMBEDDED_CONTEXT_SIZE = 4096;

/**
 * Longueur de réponse qu'un appel au moteur embarqué réserve dans sa fenêtre : celle demandée, un
 * quart de la fenêtre par défaut, jamais plus de la moitié. Sans cette borne, une recette qui
 * demandait 4 000 jetons rendait le budget d'entrée négatif, et chaque appel était refusé.
 */
export function embeddedReplyTokens(window: number, maxTokens?: number): number {
  const asked = maxTokens !== undefined && maxTokens > 0 ? maxTokens : Math.floor(window / 4);
  return Math.min(asked, Math.floor(window / 2));
}

/**
 * Jetons d'entrée (consignes, extraits et question) qu'un appel au moteur embarqué peut envoyer :
 * la fenêtre, moins un dixième pour le gabarit de conversation et la marge de décalage de
 * llama.cpp, moins la réponse (`embeddedReplyTokens`). Au-delà, node-llama-cpp coupe la fin de la
 * question ou lève « Failed to compress chat history ».
 */
export function embeddedInputBudget(window: number, maxTokens?: number): number {
  return window - Math.floor(window / 10) - embeddedReplyTokens(window, maxTokens);
}

/**
 * Nombre d'extraits qui tiennent dans le budget d'entrée d'une fenêtre : 650 jetons pour les
 * consignes du mode et la question, 480 par extrait de 1 500 caractères (3,35 caractères par
 * jeton, mesuré en français). 4 extraits à 4 096, 9 à 8 192 ; jamais moins d'un. C'est un
 * plafond pour la recherche : des consignes plus longues (indications du projet, mode bavard) ou
 * un texte qui se découpe mal (OCR) en laissent passer moins, et le tour retire alors, avant de les
 * montrer, les extraits que le modèle ne lirait pas (`fusion-chat-service`, L08-4).
 */
export function maxExtractsForWindow(window: number): number {
  return Math.max(1, Math.floor((embeddedInputBudget(window) - 650) / 480));
}

/**
 * Bornes de sécurité pour `num_ctx` (fenêtre demandée à Ollama par appel).
 *
 * Elles ne décrivent PAS ce qu'un modèle sait faire — c'est la longueur
 * déclarée par Ollama (`/api/show`, cf. `ollama-model-info.ts`) qui le dit —
 * mais seulement ce qui est absurde : sous 512 jetons un seul extrait RAG ne
 * tient plus ; au-delà de 2 M on est hors de tout modèle servi par Ollama.
 * L'ancien plafond de 262 144 interdisait les fenêtres d'un million de
 * jetons des Qwen 3.5, alors que le modèle les accepte : la borne doit
 * rester une garde, jamais une politique.
 */
export const NUM_CTX_MIN = 512;
export const NUM_CTX_MAX = 2_097_152;

/**
 * Normalise une valeur `num_ctx` venue de l'utilisateur (IPC, config).
 * Renvoie `undefined` pour « laisser Ollama décider » : absent, non fini,
 * zéro/négatif (convention « 0 = défaut du modèle » du renderer) ou hors
 * bornes. Un flottant est tronqué : Ollama attend un entier.
 */
export function clampNumCtx(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < NUM_CTX_MIN || raw > NUM_CTX_MAX) return undefined;
  return Math.floor(raw);
}
