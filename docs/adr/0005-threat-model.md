# ADR 0005 — Threat model

Status: accepted — 2026-05-06

## Context

ClioDeck ingests heterogeneous content: PDFs from publishers, OCR'd
archival photos (Tropy), Obsidian notes, and results from external MCP
servers (Gallica, HAL, Europeana, user-configured). A clear threat model
is required to scope defensive measures and avoid over-engineering.

## Decision

### Adversary model

**Trusted**: the local user and their direct colleagues (workspace
sharing is assumed trustworthy — a colleague who shares a `.cliodeck/`
folder is not adversarial).

**Semi-trusted**: third-party MCP servers configured by the user. They
may expose tools that return hostile content (prompt injection, data
exfiltration attempts). Their tool outputs are treated as untrusted
content and pass through `SourceInspector` before LLM injection.

**Untrusted**: ingested documents (PDFs, OCR, notes, MCP search results).
They may contain adversarial instructions embedded in text. This is the
primary threat vector.

### Assets to protect

| Asset | Location | Threat |
|---|---|---|
| API keys (LLM providers, Europeana, Zotero) | Electron safeStorage (OS keychain) | Exfiltration via prompt injection |
| Research content (corpus, notes, drafts) | Local filesystem only | Unintended leakage to cloud providers |
| Session metadata (MCP logs, security events) | Local `.cliodeck/v2/` JSONL | Low value, integrity matters |

### Cloud boundary

ClioDeck is **local-first**. Research content never leaves the machine
unless the user explicitly configures a cloud LLM provider (or a
non-localhost Ollama instance).

When content is about to leave localhost:
- **Explicit per-session consent** is required: the user must acknowledge
  that chunks will be sent to the configured provider before the first
  message of each session.
- This applies to any provider whose URL is not `127.0.0.1` or `localhost`,
  including remote Ollama instances.
- The user remains solely responsible for data protection once they
  consent to cloud usage. ClioDeck's role is to make this decision
  visible and deliberate.

### Defense layers

1. **SourceInspector** (audit mode by default): scans RAG chunks for
   prompt injection patterns before LLM injection. Blocks `severity: high`
   patterns, warns on others.
2. **MCP tool-use policy**: read-only tools enabled by default,
   write tools require explicit opt-in per session.
3. **Credential isolation**: secrets in OS keychain, never in workspace
   files, never travel with the project folder.
4. **Electron sandbox**: renderer process sandboxed, preload whitelist
   restricts IPC surface.

## Consequences

- The cloud consent banner (4.3) must detect non-localhost URLs.
- MCP tool results must pass through SourceInspector.
- Workspace sharing is safe without additional encryption (secrets
  stay in the source machine's keychain).
- No anonymization/masking layer needed for v2 — the consent model
  places responsibility on the user.
