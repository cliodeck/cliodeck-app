# Archival metadata for primary sources — implementation status

## Why

For historians, a primary source without its **cote** (call number), **fonds**,
**repository** and **producer** is not citable. The legacy schema stored only
generic Dublin Core-ish fields (`archive`, `collection`, `creator`, `date`) on
`PrimarySourceItem`, which is not enough to generate footnotes, reveal.js
slides, or RAG citations that an archivist would accept.

This work makes archival metadata **first-class** on Tropy-backed sources.

## What shipped (this PR)

1. **Type contract** — `backend/types/archival-metadata.ts`
   - `ArchivalMetadata` interface with eight optional, historian-oriented
     fields: `repository`, `fonds`, `callNumber`, `producer`,
     `productionDate`, `productionPlace`, `accessRestrictions`,
     `physicalDescription`.
   - `archivalFromTropyMetadata(raw, item?)` — maps a Tropy DC property bag
     (already flattened by `TropyReader.extractPropertyName`) onto the struct.
     Precedence: explicit archival keys > DC terms > item-level fallback.
     Returns `undefined` when nothing is known.
   - `formatArchivalCitation(meta)` — renders a compact "producer (date),
     cote, fonds, repository" string for RAG / export use.

2. **Domain wiring**
   - `PrimarySourceItem` (TropyReader) and `PrimarySourceDocument`
     (PrimarySourcesVectorStore) now carry an optional `archival` field.
   - `TropySync.syncItem` calls `archivalFromTropyMetadata` on every item and
     stores the result alongside the existing generic metadata bag.

3. **Persistence**
   - SQLite `primary_sources` table gains a nullable `archival_metadata TEXT`
     column (JSON-encoded).
   - **Soft migration**: a `PRAGMA table_info` probe in `createTables` runs
     `ALTER TABLE ... ADD COLUMN archival_metadata TEXT` on pre-existing
     databases. Default value is `NULL`, so legacy rows stay valid; they get
     populated on the next Tropy sync.
   - `saveSource` / `rowToDocument` round-trip the JSON payload.

4. **Tests** — `backend/types/__tests__/archival-metadata.test.ts`
   - 7 passing cases covering the DC mapping, item-level fallback,
     empty-string rejection, explicit-key precedence, citation formatting.

## What's still to do

These items were out of scope for this PR but are the natural follow-ups:

- [ ] **UI**: `<ArchivalMetadataView source={src}/>` in
      `src/renderer/src/components/`, plugged into the source detail panel
      (Tropy page, search hit expansion). Read-only v1; an edit form is a
      later v2 (needs write-path into `vectorStore.updateSource`).
- [ ] **RAG injection**: in `retrieval-service.ts` / `fusion-chat-service.ts`,
      when a chunk's parent source has `archival`, include
      `formatArchivalCitation(...)` in the system-prompt block so the LLM
      quotes the cote verbatim instead of paraphrasing the title.
- [ ] **Editable fields**: `updateSource` currently whitelists a fixed set
      of columns — extend it to accept `archival` (and emit one UPDATE on
      the JSON column). IPC handler + preload binding required.
- [ ] **Export**: Word / reveal.js / markdown exporters should consume the
      archival struct when emitting footnotes (currently they stitch
      `creator/date/archive`).
- [ ] **Zod schema**: once the shape is stable, add a `zod` validator and
      call it on ingestion so malformed template bags are caught early.
- [ ] **Tropy templates**: document which Tropy templates map cleanly
      (e.g. `https://tropy.org/v1/templates/archive`) and which need custom
      mapping. Consider a per-template override table.
- [ ] **SQLite migration test**: spin up a pre-migration DB fixture in
      `backend/core/vector-store/__tests__/` to assert the `ALTER TABLE`
      idempotency.
- [ ] **i18n keys**: `public/locales/{fr,en}/common.json` entries for each
      archival field label.
