# Source traceability — Brainstorm citation click-through

## Why

Academic trust in a RAG system collapses the moment a user cannot verify
where an extract comes from. For ClioDeck's Brainstorm mode that means:
for every chunk injected into the LLM prompt, the user must be able to
open the original source — the PDF at the right page, the Tropy archive
photo, or the Obsidian note — in at most one click.

## Data flow

```
RetrievalService hit
  └── fusion-chat-service.hitsToSources()
        ├── secondary (PDF)   → { documentId, pageNumber, chunkOffset }
        ├── primary   (Tropy) → { itemId }
        └── vault   (Obsidian)→ { notePath, lineNumber }
  └── IPC: fusion:chat:context → BrainstormSource[]
  └── Renderer store (brainstormChatStore.BrainstormSource)
  └── <SourcePopover> → window.electron.sources.*
        ├── sources:open-pdf     (documentId, pageNumber)
        ├── sources:reveal-tropy (itemId)
        └── sources:open-note    (relativePath, lineNumber)
```

## IPC surface

All handlers return `{ success: boolean, error?: string, ... }`.

| Channel                 | Args                          | Current behaviour                                                                 |
|-------------------------|-------------------------------|-----------------------------------------------------------------------------------|
| `sources:open-pdf`      | `documentId`, `pageNumber?`   | Resolves the PDF path via `pdfService.getDocument`, opens via `shell.openPath`.    |
| `sources:reveal-tropy`  | `itemId`                      | Looks up the Tropy source, reveals the first photo in the OS file manager.         |
| `sources:open-note`     | `relativePath`, `lineNumber?` | Resolves against the configured vault, opens via `obsidian://` then falls back.    |

## Known limitations (scaffold state)

- `shell.openPath` on Linux/macOS does not honour `#page=N`. The PDF
  opens at page 1. The handler returns a `file://…#page=N` URI that the
  renderer could hand to `shell.openExternal` when a browser-based
  viewer is preferable.
- Tropy has no public URL scheme (`tropy://…`) yet, so we fall back to
  revealing the underlying photo file. When upstream adds deep links,
  swap `revealTropyItem` to `shell.openExternal('tropy://…')`.
- Obsidian's `obsidian://open` URI supports `vault` + `file` but does
  not support a line anchor. `lineNumber` is preserved end-to-end for
  when it does.
- The `BrainstormSource` fields are all optional — legacy envelopes
  (missing `documentId`, etc.) still round-trip; the UI simply disables
  the "Ouvrir la source" button with an inline hint.

## Testing

Unit tests for the popover live in
`src/renderer/src/components/Brainstorm/__tests__/SourcePopover.test.tsx`.
They mock `window.electron.sources` and assert the right IPC is called
with the right args per source type. A follow-up integration test on
the handlers themselves should stub `pdfService` / `tropyService` /
`fs`.
