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
