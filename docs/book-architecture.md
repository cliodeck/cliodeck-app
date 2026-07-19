# Architecture « livre » — manuscrits à chapitres

> Document vivant : l'état de l'architecture livrée par le chantier
> chapitres (phases 1 à 5, juillet 2026). Le plan exécuté est archivé dans
> [`archive/PLAN_chapitres-livre.md`](archive/PLAN_chapitres-livre.md), le
> bilan qui l'a motivé dans [`book-etat-des-lieux.md`](book-etat-des-lieux.md).

## 1. Le modèle : un manifeste, des fichiers

Un projet `book` n'a **pas de `document.md`**. Son texte vit dans des
fichiers markdown — `chapters/01-introduction.md`, etc. — et `project.json`
porte le **manifeste** qui les ordonne :

```jsonc
{
  "type": "book",
  "chapters": [
    { "id": "c1", "title": "Introduction", "filePath": "chapters/01-introduction.md",
      "order": 0, "kind": "chapter" }
  ],
  "book": { "noteStyle": "footnote", "noteNumbering": "continuous",
            "bibliography": "single", "numberChapters": true,
            "numberSections": false }
}
```

Types partagés main/renderer : [`backend/types/book.ts`](../backend/types/book.ts)
(`Chapter`, `ResolvedChapter`, `UnattachedFile`, `BookSettings`,
`DEFAULT_BOOK_SETTINGS`, `normalizeBookSettings`).

`Chapter.kind` distingue le corps (`chapter`, numéroté) de l'appareil
(`front` : préface, dédicace ; `back` : annexes, sources) — c'est ce qui
place chaque pièce à l'export.

### Réconciliation manifeste ↔ disque

`getChapters` (main) ne se contente pas de lire le manifeste :

- un fichier référencé mais absent du disque est marqué `missing` — **jamais
  retiré silencieusement** ;
- un `.md` trouvé dans le projet mais absent du manifeste remonte comme
  **non rattaché** (`UnattachedFile`), avec une suggestion de titre ;
- `abstract.md`, `context.md` et `document.md` ne comptent pas comme
  chapitres non rattachés (pièces connues).

Le panneau affiche les non-rattachés et propose de les rejoindre : **on ne
perd jamais de texte par désynchronisation**. La clé d'accès est le **chemin
du projet**, jamais un `id` (nombre de `project.json` n'en ont pas ; c'est ce
qui rendait certains livres inouvrables avant le chantier).

Garde anti-évasion des deux côtés (main et renderer) : une entrée pointant
hors du dossier projet est ignorée en lecture et rejetée en écriture.

## 2. Écrire : bascule sans perte

Un seul document est vivant à la fois dans l'éditeur. La bascule de chapitre
repose sur deux mécanismes, l'un **impératif**, l'autre confortable :

1. **Les gardes de sécurité** (posées avant le chantier, cf. la note de
   correctif) : `loadFile` sauvegarde le fichier sortant avant de charger le
   suivant — et **refuse d'ouvrir le suivant si cette sauvegarde échoue** ;
   la vue CM6 retient `ownFilePath` et n'écrit plus dans le store si un autre
   document a pris la place. Sans elles, changer de chapitre écrasait le
   fichier d'arrivée avec le contenu du précédent.
2. **Le cache d'état** ([`src/editor/cm/state-cache.ts`](../src/editor/cm/state-cache.ts)) :
   document, sélection, historique d'annulation et défilement traversent la
   bascule. Revenir sur un chapitre permet d'annuler une frappe faite avant
   de l'avoir quitté. Cache borné (LRU 24), vidé au changement de projet.
   **Règle de fraîcheur : le disque fait foi** — un état n'est restauré que
   si son texte correspond exactement au fichier rechargé (modifié hors de
   ClioDeck ⇒ état neuf).

Limite assumée : les **propositions IA en attente expirent** à la bascule
(événement `expired` journalisé). Les ressusciter produirait deux événements
contradictoires pour un même identifiant.

## 3. Voir le manuscrit

- **Plan** : [`src/editor/outline.ts`](../src/editor/outline.ts) —
  `parseOutline` lit les titres sur l'arbre Lezer (un `#` dans un bloc de
  code n'est pas un titre), jumeau de `parseSlides`. Le `ChapterNavigator`
  affiche deux niveaux : chapitres du manifeste et titres internes ; cliquer
  un titre d'un chapitre fermé bascule dessus **et** pose le curseur.
- **Fonctions à l'échelle de l'ouvrage** (`manuscriptStore`) : statistiques
  (chapitre **et** total), vérification des citations sur tout le livre,
  renumérotation des notes sur tout le manuscrit.
- **Performance** : le store cache le *dérivé* (plan + compteurs par
  chapitre), pas le texte, et ne recalcule jamais à la frappe — le bilan
  mesurait 165 ms de parse à 400 000 mots.

**Règle transverse** : le **chapitre ouvert vient toujours de l'éditeur
vivant** (`getLiveContent`), jamais du disque, sinon les frappes non
sauvegardées seraient ignorées par la renumérotation et les compteurs.

La renumérotation est **atomique** : les textes sont calculés d'abord (une
fonction pure), puis écrits ; si une écriture échoue, les précédentes sont
restaurées. Un chapitre déjà correct n'est pas réécrit.

## 4. Assembler : pourquoi la stratégie retenue

[`src/main/services/manuscript-assembler.ts`](../src/main/services/manuscript-assembler.ts)
produit un **flux markdown unique** à partir des chapitres. Le choix n'est
pas esthétique : il vient d'une mesure. Quatre stratégies ont été testées
avec pandoc sur deux chapitres utilisant **chacun** `[^1]` :

| Stratégie | Notes homonymes | Renvois entre chapitres |
|---|---|---|
| N fichiers passés à pandoc | ❌ **corrompues** | ✅ |
| Concaténation naïve | ❌ **corrompues** | ✅ |
| `--file-scope` | ✅ | ❌ **cassés** (ancre préfixée par le fichier appelant) |
| **Flux unique + identifiants préfixés** | ✅ | ✅ |

« Corrompues » : les deux notes rendent le texte de la seconde — le contenu
du chapitre 1 disparaît, avec un simple avertissement pandoc. D'où le
préfixage des identifiants de notes par chapitre (`[^1]` du ch. 3 →
`[^ch3-1]`), fait **sur l'arbre Lezer** pour ne pas toucher aux `[^99]` des
blocs de code.

`AssembleOptions` accepte `liveOverrides` (le chapitre ouvert),
`scope: 'book' | {chapterId}` (tirage de travail), et `transformChapter`
(crochet utilisé par la bibliographie par chapitre).

## 5. Exporter

**PDF/LaTeX** ([`pdf-export.ts`](../src/main/services/pdf-export.ts)) :
`--top-level-division=chapter` (sans quoi un `#` devient une `\section` :
c'est le bug qui privait les livres de chapitres), `secnumdepth` piloté par
`numberChapters`/`numberSections`, `$abstract$` rendu,
`\frontmatter`/`\backmatter` alimentés selon `Chapter.kind`.

Réglages consommés :

| Réglage | Effet |
|---|---|
| `noteStyle: footnote` | notes de bas de page (natif pandoc) |
| `noteStyle: endnote-chapter` \| `endnote-book` | paquet `endnotes`, `\theendnotes` après chaque chapitre ou avant `\backmatter` |
| `noteNumbering: per-chapter` | compteur remis à zéro à chaque chapitre |
| `bibliography: single` | une bibliographie de fin (natif citeproc) |
| `bibliography: per-chapter` | citeproc exécuté **par pièce** (~0,85 s/chapitre) ; repli documenté sur `single` si inapplicable |

**Word** ([`word-export.ts`](../src/main/services/word-export.ts)) : une
section docx par chapitre (saut de page), table des matières, liminaires.
Les notes manuelles de l'auteur ont leur propre espace d'identifiants,
disjoint de celui du moteur de citations.

**Recettes** : le step `export` assemble le livre entier à défaut de
`document_id`, et transmet le vrai type de projet.

## 6. Journaux

- **Journal de recherche** (`brain.db`) : `history_proposal_events` porte
  `file_path` depuis le **schéma v4** — une adjudication de proposition IA
  est rattachable à son chapitre. `history_document_operations` le faisait
  déjà.
- **Journal d'usage IA** (`journal.db`) : **aucun chemin de fichier**, jamais.
  La couche factuelle reste sans contenu ni chemin (cf.
  [`INSTRUCTIONS_journal-usage-ia.md`](INSTRUCTIONS_journal-usage-ia.md)) ;
  le `filePath` reçu par le handler s'arrête au journal de recherche.

## 7. Points d'extension

- **Recherche multi-chapitres** : non livrée (panneau de résultats + modèle
  de rafraîchissement propres). `manuscriptStore.readManuscript()` fournit
  déjà la matière.
- **Index** (`\index{}`) et **références croisées typées** : même famille
  technique que les notes et citations — une extension Lezer plus une
  résolution à l'assemblage.
- **Word et les réglages de notes** : `noteStyle`/`noteNumbering` ne pilotent
  aujourd'hui que la voie LaTeX.
- **Indexation du manuscrit dans le RAG** : rien ne regarde le texte en
  cours d'écriture ; c'est dans un livre que ça manquerait le plus.
