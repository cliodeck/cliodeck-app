# Bilan du chantier « livre » (2026-07-19)

> Récapitulatif de bout en bout du chantier des chapitres multi-fichiers.
> Architecture courante : [`book-architecture.md`](book-architecture.md).
> Bilan de l'état antérieur : [`book-etat-des-lieux.md`](archive/book-etat-des-lieux.md).
> Plan exécuté : [`archive/PLAN_chapitres-livre.md`](archive/PLAN_chapitres-livre.md).

## Point de départ

Le type `book` était **une étiquette dans `project.json` plus un modèle
LaTeX**, lui-même cassé sur ce qui définit un livre : les chapitres. Une API
de chapitres existait dans le code — champ `Project.chapters`, actions
`addChapter`/`reorderChapters`, canal IPC — sans avoir jamais reçu
d'interface : zéro appelant dans le renderer, rien de persisté,
`getChapters()` fabriquant un chapitre imaginaire. Aucun test ne couvrait
cette chaîne.

## Les cinq phases

| Phase | Commit | Livré |
|---|---|---|
| 0 | `285380c` (mergé) | Verrous de sécurité : la bascule de fichier détruisait le fichier d'arrivée |
| 1 | `ceffab7` | Type partagé `backend/types/book.ts`, manifeste persisté, réconciliation disque, réglages d'ouvrage |
| 2 | `04c62da` | `ChapterNavigator`, cache d'état par chapitre (annulation, curseur, défilement préservés) |
| 3 | `3a3add5` | `parseOutline` et plan navigable, renumérotation des notes et statistiques à l'échelle de l'ouvrage, citations vérifiées sur tout le livre |
| 4 | `5ccce9f` | Assembleur (stratégie D), PDF à vrais chapitres, Word de livre, bibliographie unique ou par chapitre, tirage d'un chapitre |
| 5 | `e332466` | Chapitre identifiable dans le journal de recherche (migration v3→v4), architecture documentée, plan archivé |

## Le fait qui a commandé l'architecture

Vérifié empiriquement (pandoc 3.8), pas déduit : **deux chapitres utilisant
chacun `[^1]` produisent la même note dans le document imprimé** — le texte
de la note du chapitre 1 est remplacé par celui du chapitre 2, avec un
simple avertissement que ClioDeck se contentait de journaliser.

Quatre stratégies d'assemblage mesurées :

| Stratégie | Notes homonymes | Renvois entre chapitres |
|---|---|---|
| N fichiers passés à pandoc, ou concaténation | corrompues | ✅ |
| `--file-scope` | ✅ | cassés |
| **Flux unique + identifiants de notes préfixés** | ✅ | ✅ |

D'où l'assembleur : un flux unique où les identifiants de notes sont
préfixés par chapitre via l'arbre Lezer. Vérifié sur un PDF réel — les deux
notes homonymes y apparaissent distinctes et correctes.

## Sept bugs corrigés en chemin

Quatre touchaient les projets existants, pas seulement les livres à venir :

1. **La bascule de fichier détruisait le fichier d'arrivée** : taper dans un
   fichier puis cliquer un autre écrasait le second avec le contenu du
   premier, et perdait la frappe. Reproduit puis corrigé (`285380c`).
2. **Tout document contenant un bloc de code échouait à l'export PDF**
   (`Environment Shaded undefined`) — articles compris.
3. **Une citation écrasait une note manuelle homonyme** : le moteur
   numérotait sans regarder les notes existantes ; le texte de l'auteur
   disparaissait à l'export.
4. **`doc.toString()` normalise les CRLF en LF** (contrairement à
   `sliceDoc`) : un fichier uniformément CRLF aurait été converti à la
   première sauvegarde, en violation du contrat de fidélité. Toute lecture
   destinée au disque passe désormais par `readDocText()`.
5. Le résumé fuyait son titre dans le PDF (`\# Résumé` imprimé
   littéralement) : le filtre ne connaissait que le mot accentué.
6. Un projet livre sans `id` refusait de s'ouvrir — l'échec d'une liste de
   chapitres accessoire emportait le chargement entier.
7. Le nœud de titre de Lezer englobe le `\r` d'un fichier CRLF : réaligner
   un titre convertissait sa ligne.

## État

**1 049 tests** (contre 922 au début du chantier), sur une chaîne qui n'en
avait aucun. Parité i18n fr/en/de vérifiée (28 clés `book.*`).

## Angle mort de la « suite verte »

Les gardes `skipIf` de `native-guards.ts` sautent les suites SQLite quand
`better-sqlite3` est compilé pour l'ABI Electron — l'état normal d'un poste
de dev. En recompilant pour l'ABI Node, **8 échecs réels apparaissent**
(migrateur de workspace ×4, outils MCP ×3, migration CLI ×1), vérifiés
présents à l'identique sur `main` et donc antérieurs à ce chantier. Détail
et remède dans [`status-and-remaining-work.md`](status-and-remaining-work.md).

## Ce qui reste

- **Recherche multi-chapitres** — écartée en Phase 3 ;
  `manuscriptStore.readManuscript()` fournit déjà la matière.
- **Index (`\index{}`) et références croisées typées** — même famille
  technique que notes et citations : extension Lezer + résolution à
  l'assemblage.
- **Word n'honore pas `noteStyle`/`noteNumbering`** : ces réglages ne
  pilotent que la voie LaTeX.
- **Les propositions IA expirent à la bascule** de chapitre — limite
  assumée en Phase 2.
- **Indexation du manuscrit dans le RAG** : rien ne regarde le texte en
  cours d'écriture — c'est dans un livre que ça manquerait le plus.
- Cosmétique : en-tête courant des pages d'annexes portant le titre du
  chapitre précédent ; titre du chapitre actif tronqué sur panneau étroit.
