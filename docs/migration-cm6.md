# Migration éditeur CM6 — inventaire et suivi (Phase 0)

> Document de travail du chantier défini par [`PLAN_migration-editeur-cm6.md`](PLAN_migration-editeur-cm6.md).
> Inventaire établi le 2026-07-16 par lecture du code ; à corriger ici si le code bouge avant la fin du chantier.

## 1. Inventaire de l'existant

### 1.1 Milkdown (mode WYSIWYG)

- **Un seul point d'instanciation** : `src/renderer/src/components/Editor/MilkdownEditor.tsx` — `new Crepe({...})` avec la seule feature `Placeholder` configurée explicitement (les autres features Crepe — toolbar de sélection, slash menu, block handle, blocs de code CodeMirror — sont actives par défaut), puis `crepe.editor.use(gfm)` pour les footnotes.
- **Sortie** : listener `markdownUpdated` → `editorStore.setContent(markdown)`, garde anti-boucle `isInternalUpdate`.
- **Entrée externe** : `useEffect` sur `content` → `replaceAll(content)` (`@milkdown/utils`), comparaison via ref `lastSyncedContent`. **Anti-pattern identifié** : c'est exactement la boucle de resynchronisation React→éditeur que le wrapper CM6 doit interdire.
- **Recréation complète de l'éditeur à chaque changement de `filePath`** (destroy + create).
- **Référence partagée** : `useEditorStore.setState({ milkdownEditor: crepe.editor })`.
- Commandes : `editorStore.insertFormatting` (bold/italic/lien/citation/table/quote/footnote — insertion de markdown brut à la sélection), `insertFootnoteAtPosition` (mapping heuristique position-plein-texte → position-markdown, fragile), `insertDraftAtCursor` (Brainstorm), `safeEditorAction` (no-op si non prêt).
- CSS : `MilkdownEditor.css` (~21 Ko) + thème Crepe. Dossier `plugins/` vide (aucun plugin custom).
- Dépendances : `@milkdown/crepe` ^7.18.0, `@milkdown/kit` ^7.18.0, `prosemirror-state` (transitif).

### 1.2 Monaco (mode source + Slides + recettes)

- **Prose source** : `src/renderer/src/components/Editor/MarkdownEditor.tsx` — `@monaco-editor/react` (`^4.6.0`), `defaultLanguage="markdown"`, `onChange → setContent`. Raccourcis : Cmd+B/I/L, Cmd+' (citation), Cmd+Shift+T/F/Q (table/footnote/quote). Completion provider markdown déclenché sur `[@`.
- **Slides — couplage critique** : les quatre panneaux pilotent l'instance Monaco partagée via `editorStore.monacoEditor` :
  - `SlideGenerationPanel.tsx` — insertion/streaming de contenu IA (`executeEdits`) ;
  - `SlideNavigator.tsx` — navigation par ligne (`revealLineInCenter`) ;
  - `SlidePreviewPanel.tsx` — `onDidChangeModelContent` ;
  - `SlideEditorPanel.tsx` — `getSelection`.
  → la **façade éditeur-agnostique** de la Phase 1 remplace ces accès directs.
- **Recettes YAML** : `Config/RecipeEditor.tsx` (`language="yaml"`) → passe à CM6 + `@codemirror/lang-yaml` en Phase 5 (arbitrage 6).

### 1.3 Persistance (aucune modification du modèle de données requise)

- Fichiers `.md` sur disque : `<projet>/document.md` ou `slides.md` (création au chargement projet si absent — `projectStore.ts`).
- Chaîne complète : `editorStore.loadFile/saveFile` → `window.electron.editor.*` (préload) → IPC `editor:load-file` / `editor:save-file` (`src/main/ipc/handlers/editor-handlers.ts`) → `fs/promises.readFile/writeFile` en UTF-8. La sauvegarde journalise l'opération dans l'historique (`logDocumentOperation`).
- Canal d'insertion : IPC `editor:insert-text` → événement `editor:insert-text-command` vers le renderer ; enrobe le texte de marqueurs `<!-- cliodeck-gen mode="…" model="…" date="…" -->` si `metadata.modeId`.
- Autosave : `useAutoSave` (debounce 3 s, conditionné à `settings.autoSave` + `isDirty` + `filePath` non nul).
- **Consommateurs de `editorStore.content` à chaque frappe** (à alimenter par la sync debouncée CM6→store, Phase 1) : `useAutoSave` (via `isDirty`), `DocumentStats`, preview Slides, « Vérifier les citations ».

### 1.4 Checklist de parité fonctionnelle

À couverture égale ou supérieure en fin de chantier :

- [ ] Autocomplete citations sur `[@` (composant partagé `CitationAutocomplete.tsx`, données `useBibliographyStore().citations`)
- [ ] Insertion de citation depuis la bibliographie (`CitationCard` → IPC `editor:insert-text`)
- [ ] Insertion/streaming de drafts Brainstorm (`insertDraftAtCursor`)
- [ ] Insertion de footnote + navigation bidirectionnelle appel↔définition (avec flash)
- [ ] Raccourcis de formatage (Cmd+B/I/L, Cmd+', Cmd+Shift+T/F/Q)
- [ ] « Vérifier les citations » (clés manquantes/dupliquées vs bibliographie)
- [ ] Stats document (`DocumentStats`)
- [ ] Autosave
- [ ] Les quatre panneaux Slides (via la façade)
- [ ] Thème clair/sombre (tokens `index.css`)

### 1.5 Pourquoi Milkdown ne peut pas passer le test de fidélité

Milkdown est un éditeur ProseMirror : le markdown est parsé en AST à l'ouverture et **resérialisé** à chaque `markdownUpdated`. Conséquences observées dans les documents réels :

- échappements parasites (`\[@clef\]`) que l'export doit réparer (`unescapeCitations`, `pdf-export.ts`) ;
- normalisation des fins de ligne, des blancs significatifs et de la syntaxe (le round-trip n'est pas l'identité) ;
- mapping de positions heuristique pour les footnotes.

Le contrat CM6 (« l'éditeur ne sérialise jamais ») rend le test trivial par construction : `EditorState` stocke le texte, les décorations ne touchent pas au document.

## 2. Corpus et harnais de fidélité

- Corpus : [`test-fixtures/editor/`](../test-fixtures/editor/) — 11 fixtures couvrant notes (multiples, imbriquées, identifiants libres), citations pandoc (locator, clusters `[@a; @b]`, préfixe/suffixe, nue, clé non résolue), frontmatter YAML, tables GFM, task lists, blocs de code (langues, tildes, indenté), liens/images (inline, référence, autolien), non-ASCII (fr/de/pl, guillemets typographiques), fins de ligne mixtes CRLF+LF, blancs significatifs (saut dur `␣␣\n`, tabulation finale, pas de saut final), artefacts Milkdown (`\[@clef\]`, `<!-- cliodeck-gen -->`).
- **`.gitattributes` marque `test-fixtures/editor/** -text`** : git ne doit jamais normaliser les fins de ligne du corpus. Ne pas ouvrir ces fichiers avec un éditeur/formateur qui les réécrirait.
- Harnais : [`src/editor/__tests__/fidelity.test.ts`](../src/editor/__tests__/fidelity.test.ts) — tests d'intégrité du corpus (verts dès la Phase 0) + boucle `charger(doc) → sauvegarder() === doc` sur un registre `ENGINES`, vide jusqu'à la Phase 1 (`it.todo`).
- `src/editor/` est le foyer des modules éditeur prévus par le plan (`lezer-extensions/`, `proposals/`) : hors du build main (`tsconfig.node.json` ne l'inclut pas), typé par le tsconfig racine, importable depuis le renderer (précédent : imports `@backend`).

## 3. Suivi des phases

| Phase | État | PR / commit |
|:------|:-----|:------------|
| 0 — Inventaire + harnais | **faite** (ce document) | branche `feat/editor-cm6` |
| 1 — Socle CM6 + façade Slides | à faire | |
| 2 — Rendu live | à faire | |
| 3a — Extensions Lezer (‖ P2) | à faire | |
| 3b — Notes + citations | à faire | |
| 4 — Contrat propositionnel + journaux | à faire | |
| 5 — Retrait Milkdown/Monaco | à faire | |
