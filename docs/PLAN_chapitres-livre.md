# Plan d'implémentation — chapitres multi-fichiers (projets « livre »)

**Objet** : faire du type `book` une vraie fonctionnalité — un manuscrit en
N fichiers, navigable, assemblé correctement à l'export.
**État des lieux préalable** : [`book-etat-des-lieux.md`](book-etat-des-lieux.md).
**Analyse** : deux investigations en lecture seule (hypothèse « un projet =
un `document.md` » ; chaîne aval) + vérifications empiriques pandoc 3.8.

Ce document fixe l'architecture et découpe le chantier en phases avec
critères d'acceptation. Il ne présume pas des arbitrages éditoriaux, listés
en fin de document et à trancher avant la Phase 2.

---

## 0. Décisions cadres

1. **Le fichier est l'unité de chapitre.** Un chapitre = un fichier
   markdown dans `chapters/`, éditable hors ClioDeck, versionnable dans
   git. Pas de base de données du manuscrit.
2. **`project.json` porte l'ordre et les titres**, les fichiers portent le
   texte. Un fichier présent sur disque mais absent du manifeste reste
   visible (« non rattaché ») plutôt qu'ignoré : on ne perd jamais du texte
   par désynchronisation.
3. **L'assemblage à l'export est un flux unique préfixé** (stratégie D
   ci-dessous), pas `--file-scope`, pas la concaténation naïve.
4. **Aucune migration destructive.** Un livre existant garde son
   `document.md` ; il devient le premier chapitre, en place, par un
   manifeste inféré — jamais déplacé ni découpé sans demande explicite.
5. **Le chantier commence par les verrous de sécurité** : tant que la
   bascule de fichier n'est pas sûre, multiplier les fichiers multiplie les
   pertes. (Fait : `fix/file-switch-data-loss`.)

---

## 1. Ce que les vérifications imposent

### 1.1 Assemblage à l'export — quatre stratégies mesurées

| Stratégie | Notes `[^1]` homonymes | Renvois entre chapitres | Bibliographie |
|---|---|---|---|
| A. N fichiers passés à pandoc | ❌ **corrompues** | ✅ | ✅ unique |
| B. Concaténation naïve | ❌ **corrompues** | ✅ | ✅ unique |
| C. N fichiers + `--file-scope` | ✅ | ❌ **cassés** | ✅ unique |
| **D. Flux unique + identifiants de notes préfixés à l'assemblage** | ✅ | ✅ | ✅ unique |

« Corrompues » n'est pas une figure de style : deux chapitres utilisant
chacun `[^1]` produisent **la même note** dans le PDF — le texte de la note
du chapitre 1 est remplacé par celui du chapitre 2. Pandoc émet un
avertissement que ClioDeck se contente de logger (`pdf-export.ts:795-797`).

**Conséquence** : la stratégie D est la seule qui préserve à la fois les
notes et les renvois. Elle exige de réécrire les identifiants de notes à
l'assemblage (`[^1]` du chapitre 3 → `[^ch3-1]`), ce que ClioDeck sait
faire proprement : les extensions Lezer localisent les nœuds
`FootnoteReference`/`FootnoteDefinition` exactement, sans regex
(précédent : `src/editor/footnote-tools.ts`).

### 1.2 Bugs à corriger en chemin (indépendants des chapitres)

| Bug | Fichier | Effet |
|---|---|---|
| `\documentclass{book}` figé dans le template sans `--top-level-division=chapter` | `pdf-export.ts:193-266` | **aucun `\chapter` dans le PDF** ; TOC réduite aux sections ; en-têtes recto/verso vides |
| `secnumdepth 0` | `pdf-export.ts:204` | rien n'est numéroté |
| `$abstract$` absent du template livre | `pdf-export.ts:193-266` vs `:506` | résumé chargé puis jeté, alors que le modal le promet |
| CitationEngine numérote ses notes à partir de 1 sans regarder l'existant | `citation-pipeline.ts:94,101` | une citation **écrase** une note manuelle homonyme (déjà faux dans un article, systématique dans un livre) |
| Notes manuelles mal mappées en Word | `word-export.ts:636, 800-809` | `[^N]` de l'auteur pointe vers une note de citation ou vers rien |
| Export lit le tampon de l'éditeur, pas le disque | `PDFExportModal.tsx:19,134` / `WordExportModal.tsx:19,126` | un livre s'exporterait amputé du chapitre ouvert |

### 1.3 Pièges de l'existant (à traiter, sous peine de casse silencieuse)

- `saveProject` écrit **`document.md` en dur** (`project-manager.ts:331-333`).
- `createNewFile` met `filePath: null` (`editorStore.ts:240-246`) : « Nouveau »
  sortirait l'auteur du livre et couperait l'autosave.
- La liste de fichiers du panneau projet est **codée en dur** sur trois noms
  (`ProjectPanel.tsx:250-273`).
- `getChapters` est appelé avec `project.id`, absent des `project.json`
  écrits hors app (corrigé défensivement, mais l'identifiant retenu doit
  être le **chemin du projet**).
- `Chapter` est déclaré deux fois à l'identique (`projectStore.ts:19`,
  `project-manager.ts:48`) : à unifier dans un type partagé.
- Changer de chapitre détruit l'historique d'annulation, la position du
  curseur et fait **expirer les propositions IA** en attente.

---

## 2. Phases

### Phase 0 — Verrous de sécurité *(fait)*

Bascule de fichier sûre : sauvegarde du sortant avant chargement, garde de
propriété sur la vue CM6, ouverture de projet résiliente à l'échec des
chapitres. Branche `fix/file-switch-data-loss`, 3 tests de régression,
vérifié dans l'app.

### Phase 1 — Modèle et manifeste

- Type `Chapter` **partagé** (`src/shared/` ou `backend/types/`), importé
  par le main et le renderer ; suppression du doublon.
- `project.json` gagne `chapters: Chapter[]` (`{id, title, filePath, order}`)
  — **réellement écrit et relu** (`createProject`, `loadProject`,
  `saveProject`).
- `getChapters` cesse d'être un stub : lit le manifeste, résout les chemins
  relatifs au projet, ordonne, et **réconcilie avec le disque** (fichiers
  orphelins listés, manifeste réparé). Clé = chemin du projet, pas `id`.
- **Migration inférentielle** (pattern maison, cf. `autoMigrateWorkspace` et
  la conversion de chemins de `loadProject`) : un livre sans `chapters` en
  reçoit un, contenant son `document.md` existant, à l'ouverture ; réécriture
  du `project.json` ; idempotent, non fatal, jamais destructif.
- `saveProject` cesse d'écrire `document.md`.

*Acceptation* : ouvrir un livre existant le laisse intact et lui donne un
manifeste à un chapitre ; créer un livre neuf produit `chapters/01-….md` ;
tests de migration (avec/sans manifeste, fichier orphelin, projet sans `id`).

### Phase 2 — Écriture multi-chapitres

- **Panneau chapitres** dans `EditorPanel` : liste ordonnée, création,
  renommage, suppression (fichier conservé, sortie du manifeste),
  réordonnancement par glisser-déposer. Réutilise le `PanelGroup` et le
  patron du `SlideNavigator`.
- Bascule de chapitre : sauvegarde du sortant (Phase 0), **cache d'état par
  fichier** (`Map<filePath, EditorState>`) pour préserver l'annulation, le
  curseur et les propositions en attente.
- « Nouveau » = nouveau chapitre dans le livre ; le menu et les raccourcis
  suivent.
- Liste de fichiers du panneau projet dérivée du manifeste (+ front/back
  matter), fin du codage en dur.

*Acceptation* : écrire dans 3 chapitres, basculer sans perte (texte,
annulation, curseur), réordonner, fermer/rouvrir le projet et retrouver
l'état ; aucun fichier écrasé — test de non-régression du scénario Phase 0
étendu à N chapitres.

### Phase 3 — Vue d'ensemble du manuscrit

- **Plan (outline)** : `parseOutline(tree)` sur les titres — jumeau de
  `parseSlides` — et panneau de navigation. Deux niveaux : chapitres
  (manifeste) et titres internes (arbre).
- Fonctions transverses passant du fichier au livre : « Vérifier les
  citations » (concaténation en mémoire), statistiques (chapitre **et**
  total, cumul mis en cache par chapitre), **renumérotation des notes sur
  tout l'ouvrage** (atomique : tous les fichiers réécrits ou aucun).
- Recherche multi-chapitres (balayage des fichiers + panneau de résultats).

*Acceptation* : le plan reflète le manuscrit ; renuméroter produit un diff
propre sur les seuls fichiers concernés ; les compteurs distinguent chapitre
et ouvrage.

### Phase 4 — Assemblage et exports

- **Assembleur partagé** (main) : lit les chapitres dans l'ordre, préfixe
  les identifiants de notes par chapitre (stratégie D, via les extensions
  Lezer), insère les séparateurs de niveau chapitre, ajoute front/back
  matter. Une seule implémentation pour PDF et Word — les deux modales
  cessent de lire le tampon de l'éditeur.
- **PDF** : `--top-level-division=chapter`, `secnumdepth` revu, `$abstract$`
  ajouté ; `\frontmatter`/`\backmatter` alimentés.
- **Word** : une `section` docx par chapitre (saut de page), table des
  matières, styles de titre ; correction du mappage des notes manuelles.
- **CitationEngine** : numérotation des notes à partir du maximum existant
  (bug indépendant, mais bloquant pour un livre).
- Recettes : step `export` acceptant le livre entier ou une liste, et
  transmettant le vrai `projectType` (aujourd'hui `'article'` en dur).

*Acceptation* : un livre de 3 chapitres, chacun avec ses `[^1]`, ses
citations et un renvoi croisé, produit un PDF avec chapitres numérotés, TOC,
notes correctes et bibliographie unique ; le même en Word ; **aucun
avertissement pandoc de note dupliquée**.

### Phase 5 — Journaux et finitions

- `history_proposal_events` gagne une colonne `file_path` (migration
  additive v3→v4) : une adjudication devient rattachable à un chapitre —
  `history_document_operations` le fait déjà gratuitement.
- Journal d'usage : le chapitre n'entre **pas** dans la couche factuelle
  (pas de chemin de fichier) ; `task` peut porter `write:chapter`.
- i18n fr/en/de, documentation (`docs/book-architecture.md`), CHANGELOG.

---

## 3. Ce que l'architecture actuelle offre

- **La façade éditeur** et `loadFile`/`saveFile` sont agnostiques du chemin :
  rien à réécrire pour ouvrir un autre fichier.
- **`parseSlides` + `SlideNavigator`** sont le patron exact d'un plan et
  d'un panneau de navigation — la Phase 3 est largement du réemploi.
- **Les extensions Lezer** rendent la réécriture d'identifiants de notes
  sûre (nœuds exacts, pas de regex, blocs de code ignorés).
- **Le pattern de migration maison** (détection par le contenu, garde
  idempotente, échec non fatal) s'applique tel quel au manifeste.
- **Le contrat propositionnel** couvre déjà toute écriture IA : rien de
  spécifique aux chapitres, sinon le cache d'état pour ne pas faire expirer
  les propositions à chaque bascule.

## 4. Hors périmètre (mais adjacent)

- **Indexation du manuscrit** dans le RAG (« qu'ai-je écrit sur Danzig au
  chapitre 3 ? ») : rien ne regarde le texte en cours aujourd'hui — c'est
  précisément dans un livre que ça manquerait le plus. **L**, à part.
- **Index** (`\index{}`, makeindex) et **références croisées** typées :
  même famille technique que les notes et citations (extension Lezer +
  résolution à l'export), à traiter après les chapitres.
- `getProjectContext()` (`pdf-service.ts:406-424`) lit `context.md` et
  **n'a aucun appelant** : code mort à supprimer ou à brancher.

## 5. Arbitrages éditoriaux (à trancher avant la Phase 2)

1. **Niveau de titre = chapitre** : `#` dans le fichier, ou titre porté par
   le manifeste et corps en `##` ?
2. **Numérotation** : chapitres numérotés ? sections numérotées ?
3. **Notes** : numérotation continue sur l'ouvrage ou repartant à 1 par
   chapitre ?
4. **Bibliographie** : unique en fin d'ouvrage (natif) ou par chapitre
   (`biblatex refsection`) ?
5. **Renvois entre chapitres** nécessaires ? (Si oui — et le plan le
   suppose — la stratégie D est obligatoire.)
6. **Front/back matter** : quelles pièces, dans quel ordre, chacune
   fichier ?
7. **Ordre** : porté par le nom de fichier (`01-…`) ou par le manifeste
   seul ?
8. **`abstract.md` dans un livre** : quatrième de couverture ou vestige à
   retirer ?
9. **Export d'un chapitre isolé** (tirage de travail) en plus du livre
   entier ?
10. **Livres existants** : `document.md` laissé tel quel (défaut proposé),
    ou découpage assisté aux `#` sur demande explicite ?
