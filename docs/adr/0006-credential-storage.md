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
