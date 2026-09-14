# Notes de lecture, étiquettes du projet et tags Zotero

> État : implémenté (septembre 2026). Code : `backend/core/bibliography/readingNotes.ts`,
> `src/renderer/src/stores/bibliography/referenceTags.ts`, `readingNotesSlice.ts`.

## Le principe : qui possède quoi

Une référence porte deux sortes d'informations, qui ne vivent pas au même endroit.

| Ce qui appartient à… | Contenu | Où | Dans ClioDeck |
|---|---|---|---|
| **Zotero** | métadonnées, tags, notes Zotero | bibliothèque Zotero, recopiés à la synchronisation (`.bib` pour les métadonnées, `.cliodeck/bibliography-metadata.json` pour tags et notes) | lecture seule |
| **Le projet** | étiquettes du projet, note de lecture | `reading-notes/<clé>.md` | éditable |

Rien de ce qui appartient au projet ne va dans le `.bib` : le fichier voyage (revue, co-auteur, dépôt), et son champ `note` est un champ bibliographique, que biblatex imprime.

La fenêtre « Modifier les métadonnées » a été retirée : elle éditait tags, mots-clés, notes et champs BibTeX **sans rien enregistrer**. Ses usages ont chacun trouvé leur place : étiquettes et notes de lecture dans la fiche, métadonnées bibliographiques dans Zotero.

## Tags Zotero

- Lus avec leur type : `automatic: true` pour un tag importé par Zotero depuis les métadonnées d'un éditeur (type 1 dans la base Zotero). Mesuré sur une collection réelle : 77 tags automatiques distincts pour 5 posés à la main.
- **Automatiques masqués par défaut**, dans la fiche comme dans le filtre ; une case « Afficher les tags automatiques de Zotero » les révèle. La préférence est gardée par poste.
- Comparés à chaque synchronisation : un tag ajouté dans Zotero arrive dans ClioDeck. Le champ `tags` qu'écrivaient les versions précédentes dans le `.bib` est retiré à la synchronisation suivante.

## Notes Zotero

Notes enfants de la notice, lues à la synchronisation (la base locale ne les lisait pas du tout), réduites en texte, affichées en lecture seule dans la fiche. Une lecture qui échoue garde les notes déjà connues.

## Notes de lecture

Un fichier Markdown par référence, dans `reading-notes/` à la racine du projet — visible, lisible sans ClioDeck, ouvrable dans Obsidian.

```markdown
---
citekey: Braudel_1949
zotero_key: ABCD1234
title: La Méditerranée
tags:
  - chapitre-2
---

# Braudel, Fernand — La Méditerranée (1949)

Texte libre.
```

- **Créée à la demande** (bouton « Nouvelle note » de la fiche, ou ajout d'une étiquette), ouverte dans l'éditeur.
- **Retrouvée par `zotero_key`** d'abord, par `citekey` ensuite : le nom du fichier n'est qu'une commodité, qu'on peut changer à la main.
- **Étiquettes du projet** : la clé `tags` du front matter (celle que lit Obsidian). ClioDeck la réécrit sans toucher au corps ni aux clés ajoutées à la main ; les dates saisies restent telles quelles.
- **Clé de citation refaite** par la synchronisation : la note suit (front matter, et nom du fichier s'il n'a pas été changé à la main).
- **Jamais supprimée**, même quand la référence sort de la bibliographie.
- Un front matter illisible est signalé, jamais réécrit, et ne donne pas lieu à une seconde note créée à côté.

## Pour plus tard : remontée vers Zotero

Non implémentée, volontairement, mais préparée : chaque note connaît la clé Zotero de sa notice, et les étiquettes du projet restent distinctes des tags Zotero. Une remontée passerait par l'**API web de Zotero** avec une clé autorisée en écriture — jamais par la base locale, que Zotero interdit d'écrire. Elle pousserait `tags` comme tags Zotero et le corps de la note comme note enfant. Il faudrait alors décider des conflits (étiquette retirée dans Zotero mais présente dans la note) : c'est ce choix, et non le stockage, qui fera le travail.

## Pistes

- Proposer les notes de lecture comme corpus de l'assistant, comme le manuscrit.
- Signaler les notes orphelines (référence sortie de la bibliographie).
