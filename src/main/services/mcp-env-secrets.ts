/**
 * MCP env-secret routing (fusion 1.5).
 *
 * MCP stdio clients are typically invoked with API keys passed via the
 * `env` field on `MCPClientConfig`. Until 1.5 those values landed
 * verbatim in `.cliodeck/config.json` — i.e. on disk in plain text,
 * trivially readable by anyone with filesystem access. The audit log
 * already masked `env` values (see `backend/mcp-server/audit.ts`); this
 * module closes the same hole on the persisted config.
 *
 * Mechanism:
 *   - At `loadProject` time, scan every `mcpClients[].env` entry. Any
 *     value whose key looks like a secret (heuristic on the env name,
 *     matching `KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL` segments)
 *     and is not already a sentinel is moved into `secureStorage` under
 *     a stable per-project, per-client key. The on-disk config is
 *     rewritten with a `SECRET_SENTINEL` placeholder.
 *   - When a client is registered with the SDK manager, sentinels are
 *     resolved back to real values via `secureStorage.getKey`.
 *   - On `removeClient`, the corresponding secret is deleted to avoid
 *     orphans accumulating in the secret store.
 *
 * Portée par projet (S09-1-6). `secureStorage` est un magasin unique pour
 * toute l'app : rangés sous le seul nom du client, les secrets de deux projets
 * déclarant un client `europeana` étaient la même entrée. Charger l'un
 * écrasait la clé de l'autre, supprimer le client dans l'un l'effaçait. Chaque
 * projet porte donc un identifiant, `secrets_scope` dans `config.json`, créé
 * dans l'écriture qui range son premier secret, ou au premier chargement d'un
 * projet déjà migré. Si cette écriture échoue, ce qui a été rangé sous la portée
 * est retiré (`discardUnsavedScope`). La sentinelle ne change pas : l'empreinte
 * d'un serveur approuvé (`fingerprintClient`) non plus.
 *
 * Les clés d'avant, `mcp.client.<nom>.env.<VAR>`, sont lues en repli et
 * recopiées sous la portée, jamais supprimées : un autre projet, pas encore
 * rouvert, peut en dépendre. Elles restent jusqu'à « Révoquer toutes les clés ».
 * Le repli ne vaut que pour une clé absente de la portée, jamais pour une clé
 * présente mais illisible à ce lancement.
 *
 * Non-goals:
 *   - This is not a full vault. Values are encrypted at rest by
 *     `safeStorage` (Electron) when an OS keyring is available; we
 *     inherit `secureStorage`'s plaintext fallback warning otherwise.
 *   - Non-sensitive env vars (`NODE_ENV`, `PATH`, …) stay in
 *     `config.json` so debugging the workspace doesn't require
 *     decrypting anything.
 */

import { randomUUID } from 'node:crypto';
import type {
  MCPClientConfig as WorkspaceClientConfig,
  WorkspaceConfig,
} from '../../../backend/core/workspace/config.js';
import { secureStorage } from './secure-storage.js';

/** Marker value written into `config.json` in place of a real secret.
 *  No real env var is ever expected to equal this string, so resolve()
 *  can detect the placeholder unambiguously. */
export const SECRET_SENTINEL = '__cliodeck_secret__';

/** Heuristic: does this env-var name look like it carries a secret? */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i;

export function isSensitiveEnvVarName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Stable storage key for a given project/client/env triple. */
export function secretKeyFor(scope: string, clientName: string, envKey: string): string {
  return `mcp.project.${scope}.client.${clientName}.env.${envKey}`;
}

/** La clé d'avant la portée, commune à tous les projets : lue en repli, jamais écrite. */
export function legacySecretKeyFor(clientName: string, envKey: string): string {
  return `mcp.client.${clientName}.env.${envKey}`;
}

/**
 * Forme d'un `randomUUID` : la portée entre dans un chemin de clé à points du magasin, et
 * `config.json` peut venir d'ailleurs.
 */
const SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La portée des secrets du projet, ou `null` s'il n'en a pas (encore) une valide. */
export function secretsScopeOf(cfg: WorkspaceConfig): string | null {
  const scope = cfg.secrets_scope;
  return typeof scope === 'string' && SCOPE_PATTERN.test(scope) ? scope : null;
}

/** La portée du projet, créée dans `cfg` s'il n'en a pas : à appeler dans un mutateur de `updateWorkspaceConfig`. */
export function ensureSecretsScope(cfg: WorkspaceConfig): string {
  const known = secretsScopeOf(cfg);
  if (known) return known;
  const scope = randomUUID();
  cfg.secrets_scope = scope;
  return scope;
}

/** Ce client a-t-il un secret à ranger (valeur sensible en clair) ou à retrouver (sentinelle) ? */
export function clientHasSecrets(client: WorkspaceClientConfig): boolean {
  return Object.entries(client.env ?? {}).some(
    ([envKey, value]) =>
      value === SECRET_SENTINEL || (typeof value === 'string' && isSensitiveEnvVarName(envKey))
  );
}

/**
 * Mutates `client` in place: every sensitive env value that is not yet
 * a sentinel is moved to `secureStorage` and replaced by `SECRET_SENTINEL`.
 * Returns true iff any value was migrated (callers persist the config
 * only when migrations actually happened).
 */
export function migrateClientEnvSecrets(scope: string, client: WorkspaceClientConfig): boolean {
  if (!client.env) return false;
  let migrated = false;
  for (const [envKey, value] of Object.entries(client.env)) {
    if (typeof value !== 'string') continue;
    if (value === SECRET_SENTINEL) continue;
    if (!isSensitiveEnvVarName(envKey)) continue;
    secureStorage.setKey(secretKeyFor(scope, client.name, envKey), value);
    client.env[envKey] = SECRET_SENTINEL;
    migrated = true;
  }
  return migrated;
}

/**
 * La clé du projet, sinon l'ancienne clé globale, recopiée sous la portée sans être supprimée.
 * Sans portée (`config.json` n'a pas pu s'écrire), l'ancienne clé seule : jamais de serveur privé
 * de sa clé parce que la portée n'existe pas. Une recopie qui échoue n'empêche pas de la servir.
 *
 * Une clé du projet présente mais illisible à ce lancement (chiffrée par l'autre identité de l'app,
 * entrée « Safe Storage » recréée) reste la clé du projet : absente pour ce lancement, comme toute
 * clé illisible, et listée dans Réglages → Sécurité. L'ancienne clé n'est qu'un pont pour un projet
 * dont la clé n'a jamais été rangée sous sa portée, et elle peut être celle d'un autre projet : ni
 * servie à sa place, ni recopiée par-dessus, ce qui perdrait la clé du projet pour tous les lancements.
 */
function readSecret(scope: string | null, clientName: string, envKey: string): string {
  if (scope) {
    const key = secretKeyFor(scope, clientName, envKey);
    const own = secureStorage.getKey(key);
    if (own) return own;
    if (secureStorage.hasKey(key)) return '';
  }
  const legacy = secureStorage.getKey(legacySecretKeyFor(clientName, envKey));
  if (legacy && scope) {
    try {
      secureStorage.setKey(secretKeyFor(scope, clientName, envKey), legacy);
    } catch (err) {
      console.warn('[mcp-env-secrets] recopie de l’ancienne clé impossible:', err);
    }
  }
  return legacy;
}

/**
 * Returns a copy of `env` with all sentinels resolved against
 * `secureStorage`. Missing secrets are dropped (rather than passed as
 * empty strings) so a misconfigured client fails loudly inside the
 * MCP server rather than running with a blank credential.
 */
export function resolveClientEnvSecrets(
  scope: string | null,
  clientName: string,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [envKey, value] of Object.entries(env)) {
    if (value === SECRET_SENTINEL) {
      const resolved = readSecret(scope, clientName, envKey);
      if (resolved) out[envKey] = resolved;
      // else: drop — the MCP server should error rather than silently
      // run unauthenticated against a third-party API.
      continue;
    }
    out[envKey] = value;
  }
  return out;
}

/**
 * Delete every secret associated with a client in this project. Called from
 * `removeClient` so the secret store doesn't accumulate dead entries
 * once the user removes an MCP integration. L'ancienne clé globale reste :
 * un autre projet peut encore en dépendre.
 */
export function deleteClientEnvSecrets(scope: string, client: WorkspaceClientConfig): void {
  if (!client.env) return;
  for (const envKey of Object.keys(client.env)) {
    if (!isSensitiveEnvVarName(envKey)) continue;
    secureStorage.deleteKey(secretKeyFor(scope, client.name, envKey));
  }
}

/**
 * Retire les secrets rangés sous une portée née dans une écriture de `config.json` qui a échoué
 * (fichier en lecture seule, disque plein) : la portée n'y est pas, rien ne les relira, et chaque
 * nouvel essai en rangerait d'autres. La valeur en clair est restée là d'où elle venait
 * (`config.json`, ou le formulaire d'ajout) : rien n'est perdu. Ne jamais l'appeler sur une portée
 * déjà enregistrée, dont les secrets servent.
 */
export function discardUnsavedScope(scope: string, clients: readonly WorkspaceClientConfig[]): void {
  for (const client of clients) {
    try {
      deleteClientEnvSecrets(scope, client);
    } catch (err) {
      console.warn('[mcp-env-secrets] secrets d’une portée non enregistrée impossibles à retirer:', err);
    }
  }
}
