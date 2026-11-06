/**
 * Heuristique de localité d'un provider pour le champ `is_local` du journal.
 *
 * `ollama` est local quand son hôte est la machine et que le modèle n'est
 * pas hébergé chez ollama.com (`gpt-oss:120b-cloud`, `qwen3.5:cloud`) : un
 * tel modèle passe par le démon local mais s'exécute ailleurs, et le journal
 * se publie (ADR 0007). Sans baseUrl, Ollama vise la machine. Un provider
 * `openai-compatible` est local quand son baseUrl pointe vers la machine
 * (llama.cpp, LM Studio, vLLM en loopback) — sans baseUrl on le considère
 * cloud. Les autres providers sont cloud.
 */

import { isOllamaCloudModel, LOCAL_HOSTS } from '../../security/cloud-consent.js';

function isLocalUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isLocalProvider(providerId: string, baseUrl?: string, model?: string): boolean {
  if (providerId === 'ollama') {
    return (!baseUrl || isLocalUrl(baseUrl)) && !isOllamaCloudModel(model);
  }
  if (providerId === 'openai-compatible' && baseUrl) return isLocalUrl(baseUrl);
  return false;
}
