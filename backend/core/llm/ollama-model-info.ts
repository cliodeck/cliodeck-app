/**
 * Ce qu'Ollama sait d'un modèle installé (`POST /api/show`).
 *
 * La longueur de contexte n'est plus une table codée en dur dans le panneau
 * de chat — elle était fausse dès qu'un modèle n'y figurait pas
 * (`qwen3.5:35b` retombait sur 4 096 jetons alors qu'il en accepte près
 * d'un million). Ollama expose la valeur d'entraînement dans
 * `model_info["<arch>.context_length"]` ; c'est elle qui sert de repère à
 * l'utilisateur, qui reste libre de demander plus ou moins.
 *
 * Le parseur est pur et testé ; l'appel réseau est isolé dans
 * `fetchOllamaModelInfo` avec un `fetch` injectable.
 */

export interface OllamaModelInfo {
  /** Nom tel que demandé (`qwen3.5:35b`). */
  model: string;
  /**
   * Longueur de contexte d'entraînement déclarée par les métadonnées GGUF
   * (`<arch>.context_length`). Absente quand Ollama ne la publie pas.
   */
  contextLength?: number;
  /**
   * `num_ctx` inscrit dans le Modelfile, quand l'auteur du modèle en a fixé
   * un. C'est la fenêtre qu'Ollama applique si l'appel n'en précise pas.
   */
  modelfileNumCtx?: number;
  /** Architecture GGUF (`qwen3`, `llama`, `gemma3`…). */
  architecture?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  /** `capabilities` d'Ollama ≥ 0.7 (`completion`, `tools`, `vision`, `thinking`…). */
  capabilities?: string[];
  /**
   * Octets de cache KV par jeton de contexte, f16, d'après les métadonnées
   * GGUF (`block_count`, `attention.head_count_kv`, dimensions de tête).
   * Absent quand une métadonnée manque. Surestime les architectures
   * hybrides (couches récurrentes), sous-estime les tampons de calcul :
   * c'est un ordre de grandeur pour prévenir, pas une mesure.
   */
  kvBytesPerToken?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : undefined;
}

function kvBytesPerToken(
  modelInfo: Record<string, unknown>,
  arch: string
): number | undefined {
  const blocks = asPositiveInt(modelInfo[`${arch}.block_count`]);
  const kvHeads = asPositiveInt(modelInfo[`${arch}.attention.head_count_kv`]);
  const heads = asPositiveInt(modelInfo[`${arch}.attention.head_count`]);
  const embedding = asPositiveInt(modelInfo[`${arch}.embedding_length`]);
  const keyLen =
    asPositiveInt(modelInfo[`${arch}.attention.key_length`]) ??
    (heads && embedding ? Math.floor(embedding / heads) : undefined);
  const valueLen = asPositiveInt(modelInfo[`${arch}.attention.value_length`]) ?? keyLen;
  if (!blocks || !kvHeads || !keyLen || !valueLen) return undefined;
  // K et V, en f16 (2 octets), pour chaque couche et chaque tête KV.
  return blocks * kvHeads * (keyLen + valueLen) * 2;
}

/**
 * Extrait les champs utiles de la réponse brute de `/api/show`.
 * Tolérant : chaque champ manquant ou mal formé est simplement absent.
 */
export function parseOllamaShowResponse(
  model: string,
  raw: unknown
): OllamaModelInfo {
  const info: OllamaModelInfo = { model };
  const body = asRecord(raw);
  if (!body) return info;

  const modelInfo = asRecord(body.model_info);
  if (modelInfo) {
    const arch = modelInfo['general.architecture'];
    if (typeof arch === 'string' && arch) info.architecture = arch;
    // La clé est préfixée par l'architecture (`qwen3.context_length`) : on
    // cherche d'abord celle de l'architecture déclarée, puis n'importe
    // quelle clé `*.context_length` — certains builds déclarent une
    // architecture générique.
    if (info.architecture) {
      info.kvBytesPerToken = kvBytesPerToken(modelInfo, info.architecture);
    }
    const preferred = info.architecture
      ? asPositiveInt(modelInfo[`${info.architecture}.context_length`])
      : undefined;
    if (preferred !== undefined) {
      info.contextLength = preferred;
    } else {
      for (const [key, value] of Object.entries(modelInfo)) {
        if (!key.endsWith('.context_length')) continue;
        const n = asPositiveInt(value);
        if (n !== undefined) {
          info.contextLength = n;
          break;
        }
      }
    }
  }

  // `parameters` est le texte du Modelfile (`num_ctx 32768\nstop "<|im_end|>"`).
  if (typeof body.parameters === 'string') {
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(body.parameters);
    if (m) info.modelfileNumCtx = asPositiveInt(m[1]);
  }

  const details = asRecord(body.details);
  if (details) {
    if (typeof details.family === 'string' && details.family) {
      info.family = details.family;
    }
    if (typeof details.parameter_size === 'string' && details.parameter_size) {
      info.parameterSize = details.parameter_size;
    }
    if (
      typeof details.quantization_level === 'string' &&
      details.quantization_level
    ) {
      info.quantizationLevel = details.quantization_level;
    }
  }

  if (Array.isArray(body.capabilities)) {
    const caps = body.capabilities.filter(
      (c): c is string => typeof c === 'string'
    );
    if (caps.length) info.capabilities = caps;
  }

  return info;
}

/**
 * Interroge `POST /api/show` et renvoie les métadonnées du modèle.
 * Lève sur erreur réseau ou HTTP : l'appelant décide du repli.
 */
export async function fetchOllamaModelInfo(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<OllamaModelInfo> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/show`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `model` est la clé actuelle ; `name` reste lue par les Ollama < 0.3.
    body: JSON.stringify({ model, name: model }),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/show returned HTTP ${res.status} for ${model}`);
  }
  return parseOllamaShowResponse(model, await res.json());
}
