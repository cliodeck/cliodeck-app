/**
 * Build a ProviderRegistry from a workspace v2 config (fusion step 4.6).
 *
 * The CLI runs outside Electron, so it can't reach the user-level
 * config-manager. Instead we read the `.cliodeck/v2/config.json` that
 * was written by the migrator (step 0.3) and whose `llm`/`embedding`
 * sections match the registry config shape directly.
 *
 * Falls back to sensible Ollama defaults for workspaces that haven't
 * configured providers yet — matches the app's first-run behavior.
 */

import {
  ProviderRegistry,
  type RegistryConfig,
} from '../../backend/core/llm/providers/registry.js';
import { readWorkspaceConfig } from '../../backend/core/workspace/config.js';

export async function buildRegistryFromWorkspace(
  workspaceRoot: string
): Promise<ProviderRegistry> {
  const cfg = await readWorkspaceConfig(workspaceRoot);
  const llm = cfg.llm ?? {
    provider: 'ollama',
    model: 'llama3.2',
    baseUrl: 'http://127.0.0.1:11434',
  };
  const embedding = cfg.embedding ?? {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimension: 768,
    baseUrl: 'http://127.0.0.1:11434',
  };
  return new ProviderRegistry({
    llm: {
      provider: llm.provider as RegistryConfig['llm']['provider'],
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
    },
    embedding: {
      provider: embedding.provider as RegistryConfig['embedding']['provider'],
      model: embedding.model,
      dimension: embedding.dimension,
      baseUrl: embedding.baseUrl,
      apiKey: embedding.apiKey,
    },
  });
}
