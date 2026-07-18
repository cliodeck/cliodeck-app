# Architecture de l'éditeur (CodeMirror 6)

> État post-migration (Phase 5, 2026-07). Genèse et décisions :
> [`PLAN_migration-editeur-cm6.md`](archive/PLAN_migration-editeur-cm6.md) ;
> journal du chantier : [`migration-cm6.md`](archive/migration-cm6.md) ;
> contrat propositionnel : [`editor-proposals.md`](editor-proposals.md).

## Principes

1. **Le markdown est la source de vérité.** L'éditeur charge une chaîne et
   restitue la même chaîne, modifiée par les seules éditions de
   l'utilisateur — jamais de sérialisation d'AST. Ouvrir puis sauvegarder
   sans modifier est l'identité octet par octet (test :
   `src/editor/__tests__/fidelity.test.ts` sur `test-fixtures/editor/`).
2. **Dialecte Pandoc Markdown** : notes `[^id]`, citations `[@clef]`
   (clusters, locators), frontmatter YAML, tables GFM.
3. **L'état vit dans CM6, pas dans React.** Aucun `value` contrôlé, aucun
   re-render à la frappe ; synchronisation debouncée (300 ms) vers le
   store, sauvegarde lisant l'éditeur vivant.
4. **Toute écriture IA passe par le contrat propositionnel** — règle
   détaillée dans `editor-proposals.md`.
5. **Zettlr (GPL-3.0) se lit, ne se copie pas.** Ses mécanismes (popup de
   note, rendu live) ont servi de référence de design ; toute
   l'implémentation est écrite ex nihilo. Vigilance en revue de PR sur
   toute similarité littérale.

## Modules

| Module | Rôle |
|:-------|:-----|
| `src/renderer/src/components/Editor/CodeMirrorEditor.tsx` | Wrapper React minimal : monte l'`EditorView`, pose la façade, câble extensions et callbacks (résolution d'images/citations, i18n, IPC insert-text, hook dev propositions). Recréé sur `filePath`/`documentVersion`, jamais sur `content`. |
| `src/editor/cm/fidelity.ts` | Contrat de fidélité : détection du séparateur de ligne (fichier uniformément CRLF → facet `lineSeparator: "\r\n"` ; sinon `"\n"`, les `\r` mixtes restant des caractères du document). **Ne pas modifier sans faire tourner le corpus.** |
| `src/editor/cm/live-render/` | Rendu live : `model.ts` (pur, descripteurs calculés sur `syntaxTree` × sélection, viewport uniquement), `plugin.ts` (ViewPlugin → décorations), `images.ts` (StateField des widgets bloc), `refresh.ts` (StateEffect de recalcul externe, ex. bibliographie chargée). |
| `src/editor/cm/scholarly/` | Comportements savants : infobulles note/citation, popup d'édition de note, navigation appel↔définition, autocomplétion `@`, frontmatter replié. Résolution et candidats **injectés** par le wrapper (le module ignore Zotero et les stores). |
| `src/editor/lezer-extensions/` | Extensions de parsing `Footnotes` et `PandocCitations` (`MarkdownConfig` officiel). Zéro import ClioDeck, doc en anglais : **destinées à une publication npm séparée sous MIT**. |
| `src/editor/proposals/` | Contrat propositionnel (Phase 4) : StateField des propositions, remapping/invalidation, adjudication annotée + événement journalisé. |
| `src/editor/cm/change-origin.ts` | Annotation `changeOrigin` de toute transaction + garde dev. |
| `src/editor/facade.ts` | `EditorFacade` : point de contact unique de l'app (Slides, IPC, store) avec l'éditeur. |
| `src/editor/footnote-tools.ts` | Outils purs : `nextFootnoteNumber`, `renumberFootnotes` (parse Lezer, jamais de regex sur le contenu brut). |
| `src/renderer/src/components/common/YamlEditor.tsx` | Petit éditeur CM6 YAML pour la config (recettes) — contrôlé simple, sans le contrat de fidélité. |

## Flux de données

```
frappe → EditorView (CM6) ──debounce 300 ms──▶ editorStore.content
                    │                          (DocumentStats, preview…)
                    │  isDirty immédiat ──▶ autosave (3 s)
saveFile ──▶ facade.getValue() ──IPC──▶ fs (jamais le miroir du store)
chargement ──▶ loadFile → documentVersion++ → recréation de la vue
IA ──▶ proposals.inject → adjudication → IPC proposals:adjudication
        ├─▶ brain.db  (history_proposal_events, contenus complets)
        └─▶ journal.db (proposal_adjudications, sans contenu)
```

## Invariants à ne pas casser

- Le rendu (live-render, scholarly, propositions affichées, frontmatter
  replié) ne modifie **jamais** le document ; toute édition passe par une
  transaction annotée.
- Le corpus `test-fixtures/editor/` est protégé par `.gitattributes
  -text` : aucun outil ne doit normaliser ses fins de ligne.
- Les modules de `src/editor/` n'importent rien de ClioDeck en dehors de
  ce dossier (dépendances injectées par le wrapper).
