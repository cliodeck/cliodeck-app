# Barre de statistiques du document — dettes connues

> Référence pour un futur lot de finition. Contexte : la barre (28 px sous
> l'éditeur, composant `src/renderer/src/components/Editor/DocumentStats.tsx`)
> a été réparée le 2026-07-17 (commit `80eb6dd`) — layout flex en mode CM6 et
> scoping CSS contre la collision de classes globales. Restent deux dettes
> antérieures à la migration CM6, hors périmètre de ce fix.

## 1. Libellés non internationalisés

Les libellés sont codés en dur en français dans le composant (`mots`,
`car.`, `car. esp.`, `par.`, `cit.`, `notes`) au lieu de passer par
`useTranslation('common')`. Un utilisateur en locale en/de voit du français.

**Fix attendu** : clés `stats.*` dans `public/locales/{fr,en,de}/common.json`
(⚠️ test de parité des locales — les trois fichiers ensemble).

## 2. Comptages en regex naïves

`DocumentStats.tsx` calcule mots/citations/notes par regex sur tout le
contenu :

- les `[@...]` et `[^n]` **dans les blocs de code** sont comptés comme
  citations/notes réelles (même famille de bugs que la numérotation de
  footnote corrigée en Phase 3b via le parse Lezer, cf. `nextFootnoteNumber`
  dans `src/editor/footnote-tools.ts` — réutiliser cette approche) ;
- le comptage de notes divise par 2 les occurrences de `[^\d]` (« chaque
  note apparaît deux fois ») : faux si un appel n'a pas de définition, si
  une note est appelée deux fois, ou pour les identifiants libres
  (`[^lester-danzig]`, non comptés du tout) ;
- le « nettoyage » markdown (headers, gras, liens) est approximatif — les
  chiffres de mots/caractères sont indicatifs, pas fiables pour un décompte
  éditorial (limite acceptable, à documenter dans l'UI le cas échéant).

**Fix attendu** : compter sur l'arbre Lezer (extensions `scholarlyMarkdown`
déjà en place) plutôt qu'en regex ; citations = nœuds `PandocCitation` hors
code, notes = paires `FootnoteReference`/`FootnoteDefinition` distinctes.

## Notes de layout (pour ne pas régresser)

- Autres panneaux définissant des `.stat-item`/`.stat-label` **globaux non
  scopés** : `PDFIndexPanel.css`, `PrimarySourceStats.css`,
  `BibliographyStats.css`, `TextometricsPanel.css`… Toute nouvelle règle de
  la barre doit rester scopée sous `.document-stats`.
- Le mode CM6 utilise `.editor-content-cm6` (colonne flex) ; les modes
  Milkdown/Monaco gardent leur layout historique (Milkdown est en
  `position: absolute` — gelé jusqu'à la Phase 5).
