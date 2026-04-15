# Archive MCP connectors — design

**Status**: Gallica shipped (end-to-end). Europeana scaffolded. Archives
nationales + Transkribus at the design stage.

**Why**: a ClioDeck differentiator over "ChatGPT + Zotero" is built-in,
authenticated access to the archives that historians actually use. These
live inside the MCP server as tools so they are available to every MCP
client (Brainstorm mode, Claude Desktop, Cursor…) and benefit from the
shared audit log (`.cliodeck/v2/mcp-access.jsonl`).

---

## 1. Gallica (BnF) — shipped

- Tool: `search_gallica` in `backend/mcp-server/tools/searchGallica.ts`
- Endpoint: `https://gallica.bnf.fr/SRU`
  (CQL over Dublin Core, XML SRW response)
- Auth: **none** (public)
- Rate limit: **5 req/s per IP** (BnF public documentation).
  Acceptable without throttling because the tool is interactive: the
  model issues one call per turn. If batch / recipe use-cases land,
  wrap with a token-bucket.
- Parser: minimal regex-based tag scanner, fails closed (returns `[]`)
  on unexpected shapes. Deliberately zero-dependency — an XML library
  would be overkill for five Dublin Core fields.
- Status: **built-in, enabled by default**.

## 2. Europeana — scaffolded

- Tool: `search_europeana` in `backend/mcp-server/tools/searchEuropeana.ts`
  (not yet registered — waits on key-resolution plumbing)
- Endpoint: `https://api.europeana.eu/record/v2/search.json`
- Auth: free API key (`wskey=…`), one per user, obtainable at
  <https://pro.europeana.eu/pages/get-api>
- Rate limit: 10 req/s per key (unofficial; Europeana throttles but
  rarely publishes limits)
- Payload is already JSON — no XML parsing.
- TODO: resolve API key from `secureStorage` at tool-call time (not
  at registration time), surface a clear "missing key" error so the
  model can guide the user to Settings → Archives.

## 3. Archives nationales (France) — research needed

The SIA (Système d'information archivistique) public search lives at
<https://www.siv.archives-nationales.culture.gouv.fr>. As of 2026-04,
**no public REST API** exists. Options, ranked by cost/value:

1. **Wait for an API**. The FranceArchives portal (aggregator) published
   an EAD-XML dump via <https://www.data.gouv.fr> but no real-time
   search endpoint. Track status quarterly.
2. **FranceArchives OpenSearch feed** — <https://francearchives.fr>
   exposes an OpenSearch description. Limited to the aggregator's
   metadata (no AN full inventory) but requires no auth. Viable as a
   first approximation; label the tool `search_francearchives` to be
   honest about coverage.
3. **Scraping SIV** — fragile, ToS-grey, and the HTML is heavy JS. Not
   recommended as a shipped default.

**Decision**: scaffold `search_francearchives` next (OpenSearch, no
auth), and document SIA as a known gap rather than pretend we cover it.

## 4. Transkribus — deferred

Transkribus is not a search API — it's an **HTR service**
(handwritten-text recognition). The relevant flow is:

1. User uploads a document image (PNG/JPEG/PDF).
2. Tool submits to <https://transkribus.eu/TrpServer/rest/> with
   Bearer auth (JWT, obtainable via `/auth/login`).
3. HTR job runs asynchronously — poll `/jobs/{id}` until `FINISHED`.
4. Fetch PAGE-XML or plain-text result.

**Cost**: Transkribus charges per 1000 characters recognised
("credits"). Not free. Users configure their own account; we never hold
billing.

**Shape of the tool**: probably **two** tools rather than one:
- `transkribus_submit_htr({ imagePath, model }) → { jobId }`
- `transkribus_get_htr({ jobId }) → { status, text?, pageXml? }`

This matches the async reality and lets the model drive polling with
its own patience budget rather than blocking the MCP call for minutes.

**Dependency**: ClioDeck does not currently expose file uploads to MCP
tools. We need a small shared helper that resolves a workspace-relative
path to bytes and guards against path traversal. Block on that before
implementing.

---

## 5. "Built-in connector" concept — pre-configuration

Current MCP client config (`WorkspaceConfig.mcpClients`) is
user-authored: the historian writes command/url/env themselves. That
friction is wrong for the archives catalogue, which should feel curated.

**Proposed extension** (not yet implemented):

```ts
// backend/mcp-server/builtin-connectors.ts
export interface BuiltinConnector {
  id: 'gallica' | 'europeana' | 'francearchives' | 'transkribus';
  label: string;            // i18n key
  requiresApiKey: boolean;
  apiKeyStorageKey?: string; // for secureStorage
  enabledByDefault: boolean;
  docsUrl: string;
}
```

- Gallica: `enabledByDefault: true`, `requiresApiKey: false`.
- Europeana, Transkribus: `requiresApiKey: true`, off by default,
  enabled once the user saves a key in Settings → Archives.
- FranceArchives: `enabledByDefault: true`, `requiresApiKey: false`.

Tools register themselves against the running MCP server at startup;
the connector registry is the UI-facing surface (what the user sees
and toggles in `ConfigPanel`).

### UI: Settings → Archives

New `ArchivesConfigSection.tsx` next to `LLMConfigSection.tsx`:

- Lists each builtin with: name, description, docs link, status badge
  (active / disabled / missing key).
- Toggle to enable/disable.
- Password-style input for keys when `requiresApiKey`, saved via
  `secureStorage` (same path as provider keys).
- Shows last-call status pulled from `mcp-access.jsonl` (green /
  yellow / red) — reuses the audit log we already ship.

### Persistence

- Builtin toggles: `WorkspaceConfig.builtinConnectors: Record<id, { enabled: boolean }>`
- Keys: `secureStorage` under `mcp.<id>.apiKey` (never in
  `config.json`).
- Default on project load: if the config omits a builtin, fall back to
  the registry's `enabledByDefault`.

---

## 6. Testing strategy

- **Unit**: mock `fetch`, snapshot parsers on real (captured) API
  samples stored under `backend/mcp-server/__tests__/fixtures/`. Don't
  hit live endpoints in CI.
- **Integration (local, manual)**: a `scripts/live-probe-archives.ts`
  harness exercises every connector against the real API. Not wired
  to CI (flaky networks, rate limits).
- **Audit**: every tool call writes one line to `mcp-access.jsonl`.
  That's the user-facing trace when Brainstorm uses an archive — the
  UI can render it later.
