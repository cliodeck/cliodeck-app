# Plan d'implémentation — Migration de la couche d'écriture vers CodeMirror 6

**Projet : ClioDeck** (Electron + React + TypeScript)
**Objet : remplacement de Milkdown (et de Monaco pour la prose) par CodeMirror 6 en rendu live, façon Obsidian/Zettlr.**

Ce document est destiné à guider l'implémentation (y compris par un agent de code). Il fixe les décisions d'architecture, découpe le chantier en phases avec critères d'acceptation, et liste les points d'arbitrage restants.

---

## 0. Décisions cadres (tranchées, non ouvertes à discussion)

1. **Le texte markdown est la source de vérité.** L'éditeur ne sérialise jamais : il charge une chaîne, décore, sauvegarde la même chaîne modifiée par les seules éditions de l'utilisateur. Aucun AST intermédiaire avec perte. Corollaire : ouvrir puis sauvegarder un document sans le modifier doit produire un fichier **identique octet par octet**.
2. **Dialecte cible : Pandoc Markdown** — notes de bas de page (`[^1]`), citations (`[@clef]`, `@clef`), frontmatter YAML, tables GFM. Cohérent avec l'intégration Zotero et l'export Pandoc.
3. **Milkdown est gelé immédiatement** : aucune nouvelle fonctionnalité, aucun correctif non critique. Il est retiré en Phase 5.
4. **Monaco sort du chemin de la prose — et cela inclut les Slides.** État réel du code : Monaco est l'éditeur « source » actuel de la prose (`MarkdownEditor.tsx`), et **toute la chaîne Slides pilote directement l'instance Monaco partagée** via `editorStore.monacoEditor` (`SlideGenerationPanel`, `SlideNavigator`, `SlidePreviewPanel`, `SlideEditorPanel` — `getSelection`, `executeEdits`, `revealLineInCenter`, `onDidChangeModelContent`). Retirer Monaco de la prose casse les Slides : leur rebranchement sur une façade éditeur-agnostique fait partie du chantier (Phase 1). Monaco sert aussi à l'éditeur de recettes YAML (`RecipeEditor.tsx`) ; il passe à CM6 + `@codemirror/lang-yaml` en Phase 5, où Monaco est retiré entièrement (arbitrage 6, tranché).
5. **Contrat propositionnel** : toute intervention future de l'IA dans l'éditeur passe par une API unique de propositions atomiques adjudicables (accepter/rejeter/modifier), chaque adjudication étant journalisée. Ce contrat est implémenté en Phase 4 **même en l'absence de toute fonctionnalité IA** : c'est un verrou d'architecture.
6. **Partition des traces** (reprend la séparation déjà tranchée pour les deux journaux) :
   - **Journal de recherche** : événements complets (segments de texte, contenu des propositions, prompts).
   - **Journal d'usage IA** : agrégats décisionnels sans contenu (volumes, taux d'acceptation par catégorie/modèle/tâche, annotations décisionnelles manuelles). Aucun prompt, aucun extrait de texte. Code, stockage, UI et exports séparés, comme spécifié dans INSTRUCTIONS_journal-usage-ia.md.
7. **Zettlr (GPL-3.0) se lit, ne se copie pas.** Son code (TypeScript, Electron, CM6) est la référence d'architecture pour les notes, citations et le rendu live. Toute copie de code entraînerait les obligations de la GPL sur ClioDeck. S'inspirer des mécanismes, réécrire l'implémentation. Documenter cette règle dans CONTRIBUTING.

---

## Phase 0 — Inventaire et harnais de non-régression

**Objectif : savoir exactement ce qu'on remplace et pouvoir prouver qu'on ne casse rien.**

L'essentiel de l'inventaire est déjà établi (exploration du 16/07/2026) ; le consigner dans `docs/migration-cm6.md` et le vérifier :

- **Milkdown** : un seul point d'instanciation, `MilkdownEditor.tsx` (Crepe + preset GFM pour les footnotes). Sortie : listener `markdownUpdated` → `editorStore.setContent` ; entrée : `replaceAll` sur changement externe ; **recréation complète de l'éditeur à chaque changement de `filePath`**. Commandes : `editorStore.insertFormatting` (bold/italic/lien/citation/table/quote/footnote), `insertFootnoteAtPosition`, `insertDraftAtCursor` (Brainstorm), canal IPC `editor:insert-text`.
- **Monaco** : éditeur source de la prose (`MarkdownEditor.tsx` — raccourcis Cmd+B/I/L, Cmd+', Cmd+Shift+T/F/Q ; completion provider `[@`), moteur des quatre panneaux Slides (via `editorStore.monacoEditor`), éditeur de recettes YAML.
- **Persistance** (confirmée simple, aucune modification du modèle de données) : fichiers `.md` (`<projet>/document.md` ou `slides.md`), chaîne brute via IPC `editor:load-file` / `editor:save-file` (`editor-handlers.ts`), pivot `editorStore.content` (Zustand), autosave debouncé 3 s (`useAutoSave`, conditionné à `isDirty` + `filePath`).
- **Fonctionnalités à ne pas perdre** (checklist de parité pour P2/P3) : autocomplete citations `[@` (composant partagé `CitationAutocomplete.tsx`), navigation bidirectionnelle référence↔définition de footnote avec flash, « Vérifier les citations », stats document, raccourcis de formatage, bascule de mode par projet (`project.defaultEditor`).
- Constituer un **corpus de documents de test** (dossier `test-fixtures/editor/`) couvrant : notes de bas de page multiples et imbriquées dans des paragraphes, citations pandoc avec préfixe/locator, **clusters `[@a; @b]`**, frontmatter YAML, tables, listes de tâches, blocs de code avec langues, liens et images, caractères non-ASCII (allemand, français — corpus Lester oblige), fins de ligne mixtes, **et les artefacts des documents réels existants : échappements Milkdown (`\[@clef\]`) et marqueurs de provenance `<!-- cliodeck-gen ... -->`**.
- Écrire le test de fidélité : `charger(doc) → sauvegarder() === doc` pour tout le corpus. Ce test échoue par construction avec Milkdown si le corpus contient des notes : le documenter comme justification de la migration (le hack `unescapeCitations` de `pdf-export.ts`, qui répare les échappements de Milkdown à l'export, est une pièce à conviction supplémentaire).

**Critère d'acceptation :** inventaire écrit dans `docs/migration-cm6.md` ; corpus et test de fidélité en place (le test tournera à vide jusqu'à la Phase 1).

---

## Phase 1 — Socle CM6 minimal (remplacement sec)

**Objectif : un éditeur markdown « source » fonctionnel, branché sur la persistance existante, sans rendu live.**

- Dépendances : `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@codemirror/lang-markdown`, `@lezer/markdown`.
- **Intégration React : wrapper maison minimal.** Un composant qui monte `EditorView` dans un ref, détruit la vue au démontage, et expose une API impérative restreinte (getValue, setValue, focus, dispatch). L'état vit dans CM6, pas dans React ; interdire tout re-render React déclenché par la frappe. Éviter les wrappers React tiers lourds : la surface d'API dont ClioDeck a besoin est petite et le contrat propositionnel (Phase 4) exigera un accès direct au dispatch.
- **Synchronisation CM6 ↔ store (décision d'architecture, à trancher ici et pas plus tard).** Aujourd'hui `editorStore.content` est mis à jour à chaque frappe et quatre consommateurs en dépendent : `useAutoSave` (via `isDirty`), `DocumentStats`, la preview Slides, « Vérifier les citations ». Choix retenu : **synchronisation debouncée CM6 → store** (updateListener CM6 qui pousse `content` + `isDirty` avec debounce court, ~300 ms), le store cessant d'être la vérité à la frappe près pour devenir un miroir « assez frais ». La sauvegarde (`saveFile`, autosave) lit la valeur **directement depuis l'éditeur** (getValue), jamais le miroir. Aucun `value` contrôlé par React (cf. risque 2).
- **Façade éditeur-agnostique pour les Slides.** Remplacer l'accès direct à `editorStore.monacoEditor` par une petite interface (`getSelection`, `replaceRange`, `revealLine`, `onContentChange`) implémentée par Monaco (existant) et par le wrapper CM6. Rebrancher les quatre panneaux Slides sur cette façade. C'est le prix d'entrée de la migration : sans elle, activer CM6 casse les Slides.
- Configuration de base : historique, keymaps standard, recherche, numérotation optionnelle, `EditorView.lineWrapping`, thème clair/sombre aligné sur ClioDeck (tokens de `index.css`).
- Parser : `markdown()` de `@codemirror/lang-markdown` avec les extensions GFM (tables, task lists, strikethrough) activées.
- Brancher la persistance existante (chargement/sauvegarde de chaînes). Activer le test de fidélité de la Phase 0 : il doit passer sur tout le corpus.
- **Flag et articulation avec la bascule existante.** Il existe déjà une bascule wysiwyg/source par projet (`project.defaultEditor` + toolbar d'`EditorPanel`). Pendant la transition, CM6 est un **troisième mode** derrière le flag `editor.engine = "cm6" | "milkdown"` : `engine=milkdown` conserve la paire actuelle (Milkdown/Monaco), `engine=cm6` remplace les deux modes par l'éditeur CM6 unique (le rendu live de la Phase 2 rendant la distinction wysiwyg/source obsolète). La bascule wysiwyg/source disparaît avec le flag en Phase 5.
- Reprendre les raccourcis de formatage existants (Cmd+B/I/L, Cmd+', Cmd+Shift+T/F/Q) en keymap CM6 dès cette phase : c'est de la parité à bas coût.

**Critère d'acceptation :** on peut ouvrir, éditer et sauvegarder tout document du corpus ; test de fidélité vert ; aucune régression de persistance ni d'autosave ; les Slides fonctionnent à l'identique sur les deux moteurs via la façade.

---

## Phase 2 — Rendu live (le cœur « éditeur d'Obsidian »)

**Objectif : masquer la syntaxe hors de la ligne active, rendre la mise en forme visuellement, sans jamais toucher au texte sous-jacent.**

C'est la phase la plus délicate. Principe : un `ViewPlugin` parcourt l'arbre syntaxique (`syntaxTree(state)`) sur le viewport et produit des décorations ; les marqueurs de syntaxe sont masqués (`Decoration.replace`) **sauf** quand la sélection ou le curseur intersecte le nœud concerné (règle de révélation à la ligne/nœud actif).

Ordre d'implémentation, en incréments livrables :

1. **Inline de base** : titres (taille/graisse, masquage des `#`), emphase et gras (masquage des `*`/`_`), code inline, barré.
2. **Liens** : rendu du texte seul, URL masquée, ouverture par clic modifié (Cmd/Ctrl+clic) ; images rendues en widget bloc sous la ligne.
3. **Blocs** : citations (`>` stylé), règles horizontales, cases à cocher cliquables (le clic édite le texte source via une transaction, jamais le DOM directement).
4. **Blocs de code** : coloration par langue via les modes CM6 existants.

Contraintes techniques :

- Décorations recalculées de manière **incrémentale** (viewport + `update.docChanged`/`update.selectionSet`), jamais de re-parse complet du document à la frappe. Lezer est incrémental par conception ; s'appuyer dessus.
- Performance cible : frappe fluide sur un document de 50 000 mots (tester avec un chapitre long du corpus Lester converti).
- Aucun HTML injecté depuis le contenu sans échappement (les widgets construisent du DOM, pas du innerHTML).

**Critère d'acceptation :** expérience de type Obsidian sur les éléments 1–4 ; test de fidélité toujours vert (le rendu live ne modifie jamais le document) ; pas de dégradation de performance perceptible sur document long.

---

## Phase 3 — Fonctions savantes : notes de bas de page et citations

**Objectif : le différenciateur académique — la raison d'être de la migration.**

### 3a. Parsing (le principal inconnu technique du chantier)

`@lezer/markdown` ne parse **pas** les notes de bas de page ni les citations pandoc nativement. Deux voies, à évaluer dans cet ordre :

1. Chercher une extension Lezer existante et maintenue pour les footnotes (l'écosystème en a produit ; vérifier licence et état de maintenance).
2. À défaut, **écrire deux petites extensions Lezer** sur le modèle des extensions officielles (`Table`, `TaskList`, `Strikethrough` sont elles-mêmes des extensions — le mécanisme `MarkdownConfig` est fait pour ça) :
   - `FootnoteReference` (`[^id]`) et `FootnoteDefinition` (`[^id]: ...` en bloc) ;
   - `PandocCitation` (`[@clef]`, `[@clef, p. 12]`, `@clef` nu, avec préfixe/suffixe/locator). **Les clusters `[@a; @b]` font partie du périmètre v1** : le pipeline d'export les gère déjà (`CLUSTER_RE` dans `citation-pipeline.ts`) — un parseur qui les ignorerait ferait diverger rendu live et export. Préfixe/suffixe libres peuvent attendre une v2.

Isoler ces extensions dans un module dédié (`src/editor/lezer-extensions/`) avec leurs propres tests de parsing : elles seront **publiées en paquets npm séparés sous licence MIT après la Phase 3**, une fois l'API stabilisée par l'usage réel (arbitrage 4, tranché). Écrire le code comme du code publiable dès le départ : pas d'import ClioDeck dans le module.

### 3b. Comportements

- **Notes** : appel rendu en exposant ; contenu de la note affiché en infobulle au survol de l'appel ; Cmd/Ctrl+clic sur l'appel ouvre un **popup d'édition en place** de la définition (comportement Zettlr, éprouvé) ; commande + raccourci d'insertion de note (création de l'appel + de la définition en fin de document, curseur dans la définition ; **identifiants numériques `[^1]`** — arbitrage 3, tranché) ; renumérotation **manuelle uniquement** (commande « renuméroter les notes »), jamais silencieuse, jamais proposée à l'export (arbitrage 2, tranché) — on ne réécrit pas le document dans le dos de l'utilisateur.
- **Citations** : autocomplétion déclenchée par `@`. Le canal en place est **`useBibliographyStore().citations` côté renderer** (alimenté par `bibliography-service`, qui lit `zotero.sqlite` en direct ou l'API web Zotero), avec un composant d'autocomplete **déjà partagé entre les deux éditeurs actuels** : `CitationAutocomplete.tsx`. Réutiliser ce store et ce composant (ou brancher les mêmes données sur `@codemirror/autocomplete`) — ne créer ni second accès Zotero, ni export CSL JSON intermédiaire, ni passage par MCP. Rendu en « pastille » avec référence résolue (Auteur Année) au survol — la résolution existe : `bibliographyService.getByCitationKey` ; les clés non résolues sont signalées visuellement (soulignement) sans bloquer, en cohérence avec « Vérifier les citations ».
- **Frontmatter YAML** : replié par défaut, éditable en source au clic.

**Critère d'acceptation :** insertion, édition, survol et navigation des notes fonctionnels ; autocomplétion de citations depuis Zotero ; extensions Lezer couvertes par des tests de parsing dédiés ; test de fidélité vert (y compris renumérotation : la commande produit un diff propre et rien d'autre).

---

## Phase 4 — Contrat propositionnel et journalisation

**Objectif : implémenter le verrou d'architecture avant toute fonctionnalité IA d'écriture.**

### 4a. Traçage d'origine des transactions

- Définir une **annotation CM6** `changeOrigin` apposée sur toute transaction : valeurs `human-input`, `paste`, `ai-proposal-accepted`, `ai-proposal-modified`, `programmatic` (renumérotation, formatage automatique...).
- Par défaut, les transactions de frappe sont `human-input` ; toute API programmatique de ClioDeck **doit** poser son annotation (l'absence d'annotation lève un warning en dev).
- **Rattraper les voies d'écriture existantes.** Deux chemins insèrent déjà du texte dans l'éditeur en contournant tout contrat : le canal IPC `editor:insert-text` (insertion de citations depuis la bibliographie, texte généré balisé `<!-- cliodeck-gen ... -->` si `metadata.modeId`) et `insertDraftAtCursor` (drafts Brainstorm). Les deux doivent poser leur annotation dès 4a (`programmatic` pour l'insertion de citation ; l'insertion de contenu IA migre vers l'API de propositions en 4b). L'annotation `changeOrigin` rend les marqueurs HTML `<!-- cliodeck-gen -->` redondants pour le futur : cesser d'en produire une fois 4b en place, mais les tolérer à la lecture (les documents existants en contiennent — le corpus de la Phase 0 les couvre).

### 4b. API de propositions (le contrat)

Module `src/editor/proposals/` exposant l'unique voie d'entrée pour l'IA :

```ts
interface Proposal {
  id: string;
  range: { from: number; to: number };   // positions dans le doc
  category: string;                       // ex. "brievete", "reformulation", "correction"
  original: string;                       // texte courant du range
  proposed: string;                       // texte proposé
  source: { model: string; task: string };// modèle et tâche applicative
  createdAt: string;                      // ISO 8601
}
```

- Affichage : décoration inline de type diff (texte proposé en regard, style distinct), boutons/raccourcis accepter (Tab ou clic) / rejeter (Échap ou clic) / modifier (ouvre le texte proposé en édition avant application).
- L'adjudication dispatch une transaction annotée (`ai-proposal-accepted` / `-modified`) et émet un **événement d'adjudication** : `{proposalId, decision: accepted|rejected|modified, latence, catégorie, modèle, tâche, timestamp}` + contenus (original/proposé/final).
- **Remapping** : les propositions en attente suivent les éditions du document via le mapping de positions CM6 ; une proposition dont le range est invalidé par une édition humaine est automatiquement retirée (événement `invalidated`). À la fermeture du document, les propositions en attente sont **abandonnées avec un événement `expired` journalisé** — pas de persistance ni de restauration (arbitrage 5, tranché).
- Annotation de rejet **optionnelle** : au rejet, offrir un champ d'une ligne (« pourquoi ? »), non bloquant, échantillonné — **1 rejet sur 5, jamais deux fois de suite** (arbitrage 1, tranché).

### 4c. Routage vers les journaux

**Attention : aucun des deux journaux n'accepte aujourd'hui un événement d'adjudication — les extensions de schéma font partie du volume de cette phase.**

- **Journal de recherche** : l'événement complet, contenus inclus. État du code : `HistoryManager` (`brain.db`, tables `history_*`) stocke déjà des opérations IA avec contenus (`history_ai_operations` : `input_text`/`output_text`), mais son `operationType` est un union fermé (`rag_query | summarization | citation_extraction | topic_modeling`). Extension requise : nouveau type d'opération (ou table dédiée) pour les adjudications, avec migration de schéma.
- **Journal d'usage IA (couche factuelle automatique)** : uniquement `{decision, catégorie, modèle, tâche, timestamp}` — aucun contenu textuel. État du code : le schéma factuel (`inference_events`, `InferenceKind = completion | embedding | embedding_batch | mcp_session`) n'a ni kind adjudication ni champs `decision`/`catégorie`/`tâche`. Extension requise : nouveau kind ou table dédiée dans `journal.db`, bump de `SCHEMA_VERSION` + migration gardée (`UsageJournalStore.migrate`). **Amender `INSTRUCTIONS_journal-usage-ia.md` en conséquence** (son §3.2 fige la liste des événements v1 à completion/embedding) — le document de spec et le schéma évoluent dans le même commit. Les agrégats (taux d'acceptation par catégorie/modèle/période) sont calculés côté journal d'usage (`aggregate.ts`), pas côté éditeur.
- **Journal d'usage IA (couche décisionnelle manuelle)** : les annotations de rejet échantillonnées y sont proposées comme brouillons d'entrées, jamais insérées automatiquement. La table `usage_decisions` existe (`{task, alternative, justification, verdict}`) et est la bonne cible, mais sa sémantique de `verdict` (`worth_it | not_worth_it | unsure | pending`) ne correspond pas telle quelle à un « pourquoi du rejet » : petit design à faire (champ dédié ou nouvelle valeur), sans casser les entrées existantes.
- Respect strict de la séparation existante : deux émetteurs distincts, aucun couplage de schéma entre les deux journaux. L'émission côté usage IA passe par le canal en place (`recordInference`/sink du main), pas par un nouvel IPC renderer→main d'événements arbitraires.

**Critère d'acceptation :** une proposition factice (injectée par un script de dev, sans aucun modèle) peut être affichée, acceptée, rejetée, modifiée ; les événements arrivent dans les bons journaux avec la bonne granularité ; une édition humaine sur un range proposé invalide proprement la proposition ; documentation du contrat dans `docs/editor-proposals.md` avec la règle : **aucune fonctionnalité IA d'écriture ne contourne cette API**.

---

## Phase 5 — Retrait de Milkdown et consolidation

- Supprimer le flag `editor.engine`, la bascule wysiwyg/source (`project.defaultEditor`, toolbar), les dépendances Milkdown, le code mort associé (dont le mapping heuristique de positions de `editorStore.insertFormatting`/`insertFootnoteAtPosition`, rendu inutile par l'accès direct aux positions CM6).
- **Retirer Monaco entièrement** (arbitrage 6, tranché) : passer `RecipeEditor.tsx` à CM6 + `@codemirror/lang-yaml` ; supprimer `@monaco-editor/react`. Gain de bundle significatif.
- **Supprimer le hack `unescapeCitations`** de `pdf-export.ts` : il ne répare que les échappements produits par Milkdown ; CM6 n'échappe rien. Garder une passe de nettoyage ponctuelle si des documents utilisateurs contiennent encore `\[@clef\]`.
- Passe de tests complète : fidélité, parsing (extensions Lezer), propositions, Slides, performance document long.
- Mettre à jour `docs/` : architecture de l'éditeur, dialecte supporté, contrat propositionnel, règle GPL/Zettlr.
- Entrée de changelog expliquant la migration et ses raisons (intégrité des notes de bas de page, texte comme source de vérité, contrat de traçabilité).

**Critère d'acceptation :** plus aucune référence à Milkdown ni à Monaco dans le code ni le lockfile ; CI verte.

---

## Ordre, dépendances, volume

- Phases strictement séquentielles : 0 → 1 → 2 → 3 → 4 → 5, à l'exception de **3a (extensions Lezer) qui peut démarrer en parallèle de la Phase 2** — c'est l'inconnu technique principal, le dérisquer tôt.
- Chaque phase se termine par un commit/PR autonome avec ses tests. Pas de PR fleuve.
- Volumes indicatifs (ordre de grandeur, pas engagement) : P0 est petite (l'inventaire est largement fait) ; **P1 n'est plus petite** — la façade Slides et la décision de synchronisation store en font une phase moyenne ; P2 est le gros morceau UI ; P3a est le risque technique ; P4 est du design d'API **plus deux extensions de schéma de journaux avec migrations** — le code éditeur reste modeste, le code journaux ne l'est pas tout à fait.
- Note dépendances : CodeMirror 6 est déjà présent dans l'arbre en transitif (via Crepe, pour ses blocs de code) — les phases 1–4 n'ajoutent pas de dépendance lourde nouvelle ; les dépendances `@codemirror/*` deviennent simplement directes.

## Risques identifiés

1. **Extensions Lezer footnotes/citations** : si l'écriture s'avère plus coûteuse que prévu, solution de repli en P3 : parser les notes par une passe regex sur le viewport pour le rendu (infobulle, exposant) sans nœud syntaxique dédié — dégradé mais fonctionnel, et remplaçable ensuite.
2. **Boucles de rendu React/CM6** : le wrapper doit être le seul point de contact ; interdire `value` contrôlé par React. Point de vigilance concret : le `useEffect` de resynchronisation sur `content` du MilkdownEditor actuel est exactement l'anti-pattern à ne pas reproduire.
3. **Sur-ambition du rendu live** : Obsidian représente des années de polissage. Le « bon niveau » est défini par les critères d'acceptation de P2/P3, pas par la parité avec Obsidian.
4. **GPL** : relecture de PR attentive à toute similarité littérale avec le code de Zettlr.
5. **Régression Slides** : les quatre panneaux Slides sont couplés à l'API Monaco ; toute erreur dans la façade (Phase 1) casse une fonctionnalité que la migration ne visait pas. Tests de non-régression Slides dès la Phase 1, sur les deux moteurs tant que le flag existe.

## Points d'arbitrage — tranchés par Frédéric le 2026-07-16

Aucun point ouvert ne subsiste ; l'implémenteur applique ce qui suit sans re-discussion.

1. **Échantillonnage des annotations de rejet** : demander le « pourquoi » sur **1 rejet sur 5, jamais deux fois de suite**. Paramètre interne ajustable à l'usage, pas exposé dans les réglages pour l'instant.
2. **Renumérotation des notes** : **commande manuelle uniquement**. Pas de proposition à l'export — Pandoc renumérote de toute façon au rendu, la renumérotation source est purement cosmétique.
3. **Identifiants de notes** : les commandes d'insertion produisent des **identifiants numériques** (`[^1]`). Les identifiants libres restent parsés et pleinement fonctionnels.
4. **Extensions Lezer** : **publication npm en paquets séparés, licence MIT** (celle de l'écosystème CodeMirror/Lezer), **après la Phase 3** — une fois l'API stabilisée par l'usage réel dans ClioDeck, pas avant.
5. **Propositions non adjudiquées à la fermeture** : **abandon avec événement `expired` journalisé**. Pas de persistance ni de restauration à la réouverture (un `.md` peut être modifié hors app entre-temps ; une proposition périmée se regénère).
6. **Monaco** : **retrait complet en Phase 5**. `RecipeEditor.tsx` passe à CM6 + `@codemirror/lang-yaml` ; suppression de `@monaco-editor/react`.
