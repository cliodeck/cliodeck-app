# CSL Citation Integration — Status & Remaining Work

**Status:** scaffold complete. Core engine is wired and tested; editor + export integration is pending.

## What landed

- **Package:** `citeproc` (CommonJS `citeproc-js`) installed as a direct dependency.
- **Styles / locales** in `resources/csl/`:
  - `chicago-note-bibliography.csl` (real CSL, 243 KB) — note-bibliography style.
  - `modern-language-association.csl` (real CSL, MLA 9th) — author-page fallback.
    - Note: the plan asked for MHRA, but MHRA is not present in the root of the
      `citation-style-language/styles` repo under that name. If MHRA is a hard
      requirement, drop an `mhra.csl` into `resources/csl/` and it becomes
      available automatically via `CitationEngine.listStyles()`.
  - `locales-en-US.xml`, `locales-fr-FR.xml`.
- **Engine:** `backend/core/citation/CitationEngine.ts`
  - Lazy-loads styles + locales from `resources/csl/`.
  - `formatCitation(items, styleId, locale)` returns `{ footnotes, bibliography }`.
  - Locale fallback to `en-US` on unknown languages.
- **Zotero → CSL-JSON adapter:** `backend/core/citation/citationFromZotero.ts`
  - `citationToCSL(c: Citation)` maps the ClioDeck BibTeX-derived
    `Citation` shape (`backend/types/citation.ts`) to CSL-JSON.
  - `parseBibTeXAuthors()` handles `"Last, First and Last2, First2"` lists.
- **Tests:** `backend/core/citation/__tests__/CitationEngine.test.ts` — 3
  passing tests covering Chicago output for 1 book + 1 article, the
  BibTeX→CSL conversion, and author parsing.
  Run: `npx vitest run backend/core/citation/__tests__/CitationEngine.test.ts`.

## What remains to wire

1. **Markdown editor (`src/renderer/src/components/Editor/`)**
   - Add an `@key` autocomplete popup in `MarkdownEditor.tsx` /
     `MilkdownEditor.tsx` backed by the bibliography service
     (`backend/core/bibliography-service.ts`). On selection, insert
     a `[@bibKey]` marker at the caret. Same format Pandoc uses — good
     for round-tripping.
   - Visual pill / hover-card showing the formatted footnote preview
     (call `CitationEngine.formatCitation` in the renderer via a new
     IPC handler, e.g. `citation:preview`).

2. **IPC plumbing**
   - New handler file `src/main/ipc/handlers/citation-handlers.ts`
     exposing `citation:listStyles`, `citation:format(items, style, locale)`,
     `citation:preview(key, style, locale)`.
   - Bind in `src/preload/index.ts` as `window.electron.citation.*`.

3. **Export pipeline (`src/main/services/pdf-export.ts`, `word-export.ts`,
   `WordExportModal`)**
   - Before rendering: scan the Markdown AST for `[@key]` tokens
     (regex `/\[@([A-Za-z0-9_:-]+)\]/g` is enough for a first pass;
     switch to an AST visitor once Milkdown exposes one).
   - Resolve keys via `bibliography-service`, convert with
     `citationsToCSL`, call `CitationEngine.formatCitation`.
   - For PDF/Word: replace each `[@key]` with a numbered footnote marker
     and append the bibliography as a final section. For Word, use
     real footnote fields via the docx library already in use.

4. **Settings UI**
   - New `CitationStyleSection.tsx` under `src/renderer/src/components/Config/`
     letting the user pick style + locale from `CitationEngine.listStyles()`.
     Persist in `.cliodeck/v2/config.json` (schema bump not required; add
     `citation: { style, locale }` optional field).

5. **Bundled resources for packaging**
   - `resources/csl/` is outside `src/` and `backend/`. Add it to the
     `extraResources` / `files` section of `electron-builder.yml`
     (or the equivalent packager config) so styles ship with the app.
   - At runtime, resolve via `process.resourcesPath` in production and
     `path.resolve(__dirname, ...)` in dev. The constructor already
     accepts a custom `resourcesRoot` — inject the right one from main.

6. **More styles**
   - Once the plumbing is in place, shipping additional `.csl` files
     is cost-free. Good first set for historians: Chicago author-date,
     APA 7, MLA 9, Harvard (Cite-them-Right), a French-localised
     Chicago (`chicago-notes-bibliography-fr.csl` exists upstream).

## Known limitations of the current scaffold

- `formatCitation` produces one footnote per item. It does not yet merge
  multiple keys into a single note (`[@a; @b]` Pandoc-style) — add a
  second entry point that takes citation clusters when the editor
  integration lands.
- No ibid. / short-title state across a document. citeproc-js supports
  this via `processCitationCluster`; the current wrapper uses the simpler
  `makeCitationCluster` path. Upgrade when implementing the export pass.
- `Citation.customFields` key names are read lower-case (`doi`, `url`,
  `pages`, `address`, `isbn`, `volume`, `issue`/`number`). If the
  BibTeX parser uppercases any of these, normalise there rather than
  duplicating cases here.
