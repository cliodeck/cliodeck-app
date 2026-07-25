# Source traceability — Brainstorm citation click-through

> Updated 2026-07-25: a **fourth** source type has shipped (the manuscript).
> Unlike the other three it does *not* hand off to the OS — it navigates in-app.
> See "The manuscript route" below.

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
  └── fusion-chat-service.manuscriptHitsToSources()   (separate channel)
        └── manuscript        → { relativePath, lineNumber, chapterId }
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

## The manuscript route — in-app, not via the OS

The manuscript corpus ([`manuscript-corpus.md`](manuscript-corpus.md)) produces
sources with `sourceType: 'manuscript'` and `kind: 'manuscrit'`, carrying
`relativePath`, `lineNumber` and `chapterId`. It is the only corpus that lives
**inside the project**, so it is the only one that does not hand off to the OS:
`src/renderer/src/services/open-manuscript-source.ts` switches the workspace to
**Write** mode, loads the chapter, and places the cursor.

**Why not just reuse `sources:open-note`.** That channel resolves its
`relativePath` against the **configured Obsidian vault**, which is the wrong
root for a chapter living under the project folder — it would open a different
file, or nothing. Widening `SourcePopover`'s `canOpen` to admit `manuscript`
without adding this route would therefore have been a bug, not a fix: the
`else` branch of `handleOpen` falls through to exactly that channel. Nor is an
external editor the right destination — the chapter is already editable in
ClioDeck.

Three properties the route holds:

- **The switch stays safe.** It goes through `editorStore.loadFile`, which saves
  the outgoing file before loading the next and refuses to load if that save
  fails (the book chantier's phase-0 lock). Following a citation cannot lose
  unsaved keystrokes.
- **An already-open chapter is not reloaded** — only the cursor moves. Going
  through `loadFile` again would rebuild the view and discard that chapter's
  undo history.
- **Escape guard.** A path leaving the project folder is refused. The main-side
  guard (`manuscript-assembler.ts`) uses Node's `path`, unavailable in the
  renderer, so this one reasons on the string — and on **segments**, so a file
  legitimately named `notes..anciennes.md` is not mistaken for a traversal.

Mode switching is deliberate: the popover can be open in Brainstorm (full chat)
where no editor is visible, and "Ouvrir la source" must do something visible.

Tests: `src/renderer/src/services/__tests__/open-manuscript-source.test.ts`.

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
