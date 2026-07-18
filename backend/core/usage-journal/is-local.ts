/**
 * Heuristique de localité d'un provider pour le champ `is_local` du journal.
 *
 * `ollama` est toujours local par convention produit (le consent banner couvre
 * le cas d'un Ollama distant). Un provider `openai-compatible` est local quand
 * son baseUrl pointe vers la machine (llama.cpp, LM Studio, vLLM en loopback) —
 * sans baseUrl on le considère cloud. Les autres providers sont cloud.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLocalProvider(providerId: string, baseUrl?: string): boolean {
  if (providerId === 'ollama') return true;
  if (providerId === 'openai-compatible' && baseUrl) {
    try {
      return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
    } catch {
      return false;
    }
  }
  return false;
}
