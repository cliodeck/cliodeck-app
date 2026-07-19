# Fonctionnalité « livre » — bilan (2026-07-19)

> Analyse en lecture seule sur `main` @ `fa20191`. Références fichier:ligne
> vérifiées dans le code ; le comportement de pandoc a été vérifié
> empiriquement (pandoc 3.8) et non déduit.

## Verdict en une phrase

Le type « livre » est **une étiquette dans `project.json` plus un template
LaTeX**, lui-même cassé sur le point qui définit un livre : les chapitres.
L'API de chapitres existe côté code mais n'a jamais reçu d'interface, et
ne persiste rien.

## 1. Ce qui marche réellement

- Écrire un manuscrit long dans l'éditeur CM6 avec tout l'appareil savant
  (notes, citations Zotero, frontmatter, fidélité octet par octet) —
  rien ne dégrade jusqu'à ~200 000 mots.
- `abstract.md` et `context.md` créés d'office (`project-manager.ts:144-151`),
  le second alimentant le contexte de l'assistant.
- Assistant, RAG, journal, propositions adjudicables : disponibles, car
  aucun ne distingue le type de projet.
- Export PDF avec un template `book` réel : classe `book`,
  `\frontmatter` / `\tableofcontents` / `\mainmatter` / `\backmatter`,
  en-têtes recto/verso (`pdf-export.ts:193-266`).

## 2. Coquilles vides (code présent, inerte)

| Élément | État | Verdict |
|---|---|---|
| `getChapters()` (`project-manager.ts:343-362`) | stub : ignore le projectId, renvoie un chapitre fabriqué `{id:'main', filePath:'document.md'}` | **ment au store** — à finir ou supprimer |
| `Project.chapters?` (`project-manager.ts:45`) | déclaré, jamais écrit ni relu (ni `createProject`, ni `loadProject`, ni `saveProject`) | code mort / point d'ancrage |
| `addChapter`/`deleteChapter`/`reorderChapters`/`setCurrentChapter` (`projectStore.ts:57-62, 268-292`) | actions in-memory, **zéro appelant** dans tout le renderer | code mort : une API écrite avant une UI jamais venue |
| `if (project.type === 'book')` (`projectStore.ts:102-107`) | remplit le store du faux chapitre | inerte |
| `Chapter` | défini **deux fois** à l'identique (`projectStore.ts:19`, `project-manager.ts:48`) | duplication à unifier si le chantier se fait |

## 3. Bugs vérifiés

1. **L'export PDF d'un livre ne contient aucun chapitre.** ClioDeck fige
   `\documentclass{book}` dans son template maison sans passer la variable
   `documentclass` ni `--top-level-division=chapter` : pandoc retombe alors
   sur son défaut et émet `\section` pour un `#`. Vérifié :

   | Invocation | `# Titre` devient |
   |---|---|
   | template maison book, sans option (= ClioDeck) | `\section` |
   | même template + `--top-level-division=chapter` | `\chapter` |

   Conséquences en cascade : la table des matières ne liste que des
   sections, et les en-têtes recto/verso (`\leftmark`/`\rightmark`,
   alimentés par `\chaptermark`) restent **vides**.
2. **`\setcounter{secnumdepth}{0}`** (`pdf-export.ts:204`) supprime toute
   numérotation — pour un livre, c'est un choix éditorial discutable, et
   combiné au point 1 plus rien n'est numéroté.
3. **Le résumé est chargé puis jeté.** `abstract.md` est lu pour
   `article || book` (`pdf-export.ts:506`) et passé à pandoc, mais le
   template livre n'a pas de `$abstract$` (l'article, si — `:181-187`).
   Or le modal d'export **promet** aux projets livre que « le résumé sera
   automatiquement lu depuis abstract.md » (`PDFExportModal.tsx:269-273`).
4. **Word ignore le livre** : deux occurrences de `projectType` seulement
   (`word-export.ts:573, 677`), toutes deux `article || book`. Un livre
   exporté en Word est exactement un article — ni table des matières, ni
   saut de page par chapitre.

## 4. Ce qui manque pour écrire vraiment un livre

| Manque | Effort | L'architecture actuelle aide/gêne |
|---|---|---|
| **Chapitres multi-fichiers** (création, ordre, persistance, ouverture) | L | Aide : façade éditeur et `loadFile`/`saveFile` agnostiques du chemin ; `Chapter` et ses actions déjà écrits. Gêne : tout ce qui suppose « un projet = un `document.md` » (`projectStore:157`, `ProjectPanel:250-273`, les deux exporteurs, `saveProject:331`), plus l'assemblage à l'export |
| **Plan / outline navigable** | **S** | Très facile : `parseSlides` est le précédent exact d'un découpage par arbre Lezer, et `SlideNavigator` + le `PanelGroup` d'`EditorPanel` sont un panneau de plan **déjà écrit** — il suffit d'un `parseOutline(tree)` sur les titres et d'un montage non conditionné à `isPresentation` |
| **Chapitres réels + numérotation à l'export** | **S** | Techniquement trivial (bug 3.1) ; le choix du niveau de titre = chapitre vous appartient |
| **Front/back matter** (dédicace, remerciements, annexes, biblio en fin d'ouvrage) | M | Le template a déjà les blocs vides prêts ; côté fichiers, rejoint les chapitres |
| **Index** (`\index{}`, makeindex) | M/L | Le précédent des extensions Lezer rend le marquage + rendu live faisables ; la chaîne LaTeX est à ajouter |
| **Références croisées** (« voir chapitre 3 », figures) | M | Même famille que l'index ; dépend des chapitres |
| **Export Word de livre** (TOC, sauts de page, styles) | M | `word-export.ts` construit déjà ses sections docx à la main : ajout, pas refonte |
| **Tenue à 400 000 mots de la barre de stats** | **S** | Seul point mesuré comme dégradant : `DocumentStats` re-parse tout le document toutes les 300 ms (37 ms à 60 k mots, 165 ms à 400 k). Calcul incrémental ou throttle plus long |

## 5. Autres frictions relevées

- `saveProject` (`project-manager.ts:325-341`) écrit `document.md` en dur à
  côté du `project.json`.
- La liste de fichiers du panneau projet est codée en dur sur
  `document.md`/`abstract.md`/`context.md` (`ProjectPanel.tsx:250-273`) :
  des fichiers de chapitres créés à la main n'y apparaîtraient pas.
- i18n : une seule clé `project.types.book` dans les trois locales.
- **Aucun test** ne couvre le chemin livre.
