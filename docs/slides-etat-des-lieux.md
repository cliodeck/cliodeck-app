# Présentations/slides — état des lieux (2026-07-18)

> Analyse en lecture seule sur `main` @ `69ca849`, cap fixé par Frédéric :
> **le même éditeur** pour les slides que pour les documents. Références
> fichier:ligne vérifiées dans le code.

## 1. Ce qui existe

- **La substitution est limitée au centre du mode write** : `App.tsx:107-113`
  passe `centerPanel = <SlideEditorPanel/>` à MainLayout pour un projet
  `presentation` — les modes Explore/Brainstorm/Export, l'AssistantChat,
  le journal et la bibliothèque restent intacts. La divergence est
  l'expérience d'édition elle-même.
- `SlideEditorPanel` (`:115-141`) : PanelGroup Navigator (22 %) +
  **CodeMirrorEditor** (le même composant CM6 que les documents, `:123`) +
  Preview + Génération IA. Toolbar propre (`:64-112`) : Save, +Section,
  +Slide, +Note, citation brute, Preview, IA, Export.
- **Manquent aux slides** vs EditorPanel : barre de stats (absente !),
  bouton note de bas de page, renumérotation, « Vérifier les citations »,
  Similarité, Nouveau/Ouvrir. **Présent par héritage** (même composant
  CM6) : tout le rendu live + scholarly (pastilles, autocomplete `@`,
  exposants, popup de note, propositions) — jamais pensé pour les slides.

## 2. Constats critiques

1. **Violation du contrat propositionnel (Phase 4)** : la génération IA
   applique son résultat par `editorFacade.setValue(streamedContent)`
   (remplacement TOTAL, `SlideGenerationPanel.tsx:115`) ou `appendText`
   (`:122`) — sans proposition adjudicable, avec origine `programmatic`
   par défaut, sans événement d'adjudication vers les journaux. Le
   panneau prédate la Phase 4 et a été rebranché sur la façade en P1 sans
   re-examen. `docs/editor-proposals.md` l'interdit explicitement.
2. **Collision `---`** : le rendu live affiche chaque séparateur de slide
   comme une règle horizontale décorative (`model.ts:305-312`) ; et un
   deck commençant par `---` est replié comme un **faux frontmatter**
   (`frontmatter.ts:41-55`). Inversement, un vrai frontmatter YAML dans
   `slides.md` est rendu **comme une slide** par la preview et l'export
   (aucun strip, grep vide dans `revealjs-export.ts`).
3. **Deux vérités markdown** : la preview utilise un mini-moteur markdown
   maison en JS inline (`revealjs-export.ts:192-…`, regex) qui diverge du
   rendu reveal réel de l'export. Sandbox iframe correct
   (`sandbox="allow-scripts"` sans `allow-same-origin`,
   `SlidePreviewPanel.tsx:73-77`).
4. **Navigator en regex** sur le miroir `content` (retard 300 ms,
   faux positif : `---` dans un bloc de code compte comme séparateur)
   alors que l'arbre Lezer est disponible — même famille de dettes que la
   barre de stats soldée via `document-stats.ts`.
5. **Zéro test** sur les 4 composants Slides, `slides-generation-service`
   et `revealjs-export` ; **zéro fixture slides** dans le corpus de
   fidélité.
6. Deux portes d'export (modal du panneau + carte ExportHub) pour les
   mêmes voies reveal.js (online/offline/pdf, config
   `reveal-config.json`) et Beamer (pandoc/xelatex).

## 3. Écarts au cap « même éditeur » (hiérarchisés)

| # | Écart | Effort | Nature |
|---|---|---|---|
| 1 | Fusionner SlideEditorPanel dans EditorPanel (toolbar contextuelle presentation ; Navigator/Preview/Génération en panneaux latéraux) — rend stats, notes, renumérotation, vérif citations aux slides | M | décision UX : disposition des panneaux |
| 2 | Génération IA → propositions adjudicables (remplacement = proposition 0..len ; append = proposition d'insertion) | S/M | découle de la règle Phase 4, pas de décision |
| 3 | Rendu live conscient des slides : `---` = frontière « Slide n » stylée (pas une HR), fix du faux-frontmatter | S | décision : apparence de la frontière |
| 4 | Navigator (et export) sur un helper Lezer partagé `parseSlides(tree)` + fixtures slides au corpus | S | découle du cap |
| 5 | Frontmatter YAML des decks : strippé de la preview/export ; potentiellement source de config reveal (titre/thème) | S | décision : rôle du frontmatter |
| 6 | Preview sur le vrai pipeline d'export + synchro slide active ↔ curseur | M | décision : priorité |
| 7 | Tests sur toute la chaîne | transversal | — |

Bug préexistant corrigé gratuitement par l'écart 4 : `parseSlides` casse
sur `---` dans les blocs de code. Hors scope noté : unifier les deux
portes d'export.
