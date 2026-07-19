# ADR 0006 — Credential storage

Status: accepted — 2026-05-06
Context: ADR 0005 (threat model), Phase 4.1

## Context

ClioDeck stores API keys for LLM providers, Zotero credentials, MCP
client environment secrets, and potentially private API URLs. These must
not leak via workspace sharing, git commits, or prompt injection
exfiltration.

## Decision

### Storage mechanism

All secrets use Electron `safeStorage` (OS keychain: Keychain on macOS,
libsecret on Linux, DPAPI on Windows), accessed through the existing
`secureStorage` service.

#### Plaintext fallback — known limitation

`safeStorage.isEncryptionAvailable()` returns false on systems without a
usable keychain — typically a minimal Linux install with no libsecret /
gnome-keyring, or a headless session. In that case `secureStorage` **stores
the value in plaintext** in the app config store rather than refusing to
save (`secure-storage.ts`, `setSensitive`). The trade-off is deliberate:
refusing would leave the user unable to configure a provider at all.

Consequences the rest of this ADR must be read against:

- On such a system, the "never written to `config.json`" guarantee above
  degrades to "written to the app config store, unencrypted". The
  *workspace* is still clean — the file lives in the Electron userData
  directory, not in the project folder — so the "secrets never travel with
  the project folder" property (see *Workspace portability*) still holds.
- The user is not currently warned. Surfacing this in the Settings
  security section is tracked in `docs/status-and-remaining-work.md`
  (audit item 16); until then the only signal is the startup log line
  `Stored key: … (encrypted: false)`.
- Linux packaging should recommend installing libsecret so the nominal
  path applies (see `docs/linux-sandbox.md` for the neighbouring
  distribution caveats).

### Scope of protected fields

The following are routed to secureStorage (never written to `config.json`):

1. **LLM provider API keys** — fields matching `*APIKey` in `LLMConfig`
   (Claude, OpenAI, Mistral, Gemini).
2. **Zotero credentials** — `apiKey` in `ZoteroConfig`.
3. **MCP client env secrets** — any env var matching the heuristic
   `KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL` (existing sentinel
   `__cliodeck_secret__`).
4. **Private API URLs** — URLs in MCP client configs or provider configs
   that point to private/authenticated endpoints should be treated as
   sensitive when they contain credentials (e.g., basic auth in URL).
5. **Europeana API key** — stored via the same mechanism.

When a new MCP server is added by the user, any env field matching the
heuristic is automatically routed to secureStorage.

### Workspace portability

Secrets are bound to the machine's OS keychain. When a workspace is
copied to another machine (USB, sync, etc.), the user must reconfigure
their API keys on the new machine. This is the expected behavior —
secrets should never travel with the project folder.

### Revocation

A "Revoke all keys" button in Settings (Security section) will:
1. Delete all entries from secureStorage for the current workspace.
2. Clear in-memory cached credentials in all active services.
3. Reset provider states to `unconfigured`.
4. Log a `credential_revocation` event to `security-events.jsonl`.

This gives users a single-action response if they suspect a key leak.

## Consequences

- Zotero `apiKey` must be migrated from `config.json` to secureStorage
  (idempotent migration at project load, same pattern as MCP env secrets).
- The "Revoke all keys" button needs implementation in
  `SecurityConfigSection.tsx` + a new IPC handler.
- No export/import mechanism for credentials — deliberate simplicity.
