# Changelog

All notable changes to ClioDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-rc.4] — 2026-07-25

Deuxième cycle d'audit (sécurité, robustesse du code, design), mené sur les
219 fichiers modifiés depuis la rc.3. Le fil conducteur des correctifs :
**ce que l'application affiche doit être ce que la source contient**, et
**ce que la documentation annonce doit être ce que le code fait**.

### Security

- **La fenêtre principale ne quitte plus l'application.** Seul
  `setWindowOpenHandler` était posé : il couvre `window.open` et
  `target=_blank`, pas la navigation du frame principal. Un lien cliqué dans
  une réponse de l'assistant — dont le contenu peut être dicté par un PDF,
  une archive Tropy, une note Obsidian ou un serveur MCP hostile — faisait
  naviguer la fenêtre, et le préload réinjecté livrait ses ~184 canaux IPC,
  dont la lecture et l'écriture de fichiers, à la page distante. Les liens
  web partent désormais vers le navigateur du système, le reste est refusé.
- **Les serveurs MCP déclarés dans un projet ne démarrent plus sans
  accord.** Le garde-fou existait (whitelist d'interpréteurs, dialogue natif,
  audit JSONL) mais n'était câblé que sur l'ajout manuel : ouvrir un projet
  partagé par un collègue exécutait la commande de son `config.json`, sans
  la moindre question. Le chargement passe maintenant par le même garde. Les
  accords sont mémorisés par empreinte (commande + arguments) dans le
  répertoire utilisateur de l'application — **jamais dans le workspace**,
  qu'un projet hostile pourrait s'auto-approuver ; modifier la commande d'un
  serveur déjà approuvé redemande l'autorisation.

### Fixed

- **Toute page de titre PDF était corrompue dès qu'un nom contenait `&`.**
  Les métadonnées étaient échappées pour LaTeX avant d'être passées à
  pandoc, qui les échappe lui-même : `Dupont & Fils` s'imprimait
  `Dupont \textbackslash& Fils`. Les dix caractères `\ & % $ # _ { } ~ ^`
  étaient touchés — donc le **résumé entier**, illisible dès la première
  esperluette. Le test verrouillait le comportement fautif ; il verrouille
  désormais le bon.
- **L'export d'un article pouvait produire le mauvais document.** Les
  modales prenaient le tampon de l'éditeur, qui contient le fichier
  *ouvert* — or le panneau projet invite à ouvrir `abstract.md` et
  `context.md`. Exporter depuis le résumé produisait un PDF contenant le
  résumé, sous le titre de l'article, sans un mot. Le manuscrit est
  maintenant résolu explicitement ; au passage, les présentations prennent
  le texte vivant de `slides.md` au lieu de le relire sur le disque, ce qui
  perdait les frappes non sauvegardées.
- **Les extraits montrés dans le panneau « Sources » ne venaient plus
  toujours de la source.** Le compresseur de contexte, actif par défaut,
  réécrit le contenu des extraits — et le panneau en tire son aperçu. Trois
  défauts cumulés : un **tableau markdown était pulvérisé** (son séparateur
  `|` servait aussi de frontière de phrase) puis recomposé en lignes qui
  n'avaient jamais existé ; des phrases prélevées loin les unes des autres
  étaient **collées sans marque de coupe**, donnant à lire une citation
  continue introuvable dans le document ; et le repli « garder les deux
  meilleures » les rendait **dans l'ordre du score**, réécrivant la
  chronologie. Les tableaux et blocs de code passent désormais entiers, les
  coupes sont signalées par `[…]`, et l'ordre du document est préservé.
- **Le corpus manuscrit atteint enfin l'assistant.** Il était indexé à
  chaque sauvegarde, mais ne remontait jamais : ses extraits portaient un
  score RRF (maximum ≈ 0,016) là où les autres corpus portent un cosinus
  filtré à 0,12, et le `slice(0, topK)` s'appliquait au tri global. Dès que
  la bibliographie rendait dix extraits, « qu'ai-je déjà écrit sur X ? »
  restait sans réponse — l'historien payait le calcul sans rien recevoir. Le
  cosinus réel est désormais publié (le store l'exposait déjà) et une part
  des places est réservée au manuscrit quand il a quelque chose à dire. Les
  canaux `manuscript:index` et `manuscript:stats`, enregistrés côté main
  mais absents du préload, sont exposés.
- **Un chapitre pouvait disparaître définitivement de l'index du
  manuscrit.** L'empreinte du chapitre était écrite *avant* ses chunks : un
  échec en cours de route laissait un hash committé sans contenu, et la
  passe suivante sautait le chapitre comme « inchangé ». L'écriture est
  maintenant transactionnelle. `ManuscriptStore` — cinquième writer de
  `brain.db`, oublié par le correctif des quatre autres — reçoit son
  `busy_timeout`, et le store n'est plus fermé sous une passe d'indexation
  en vol (le défaut que le service PDF avait corrigé et que celui-ci
  rejouait).
- **La modale des réglages OCR était en anglais en français comme en
  allemand** : ses huit clés n'existaient dans aucune des trois locales, le
  repli s'appliquait donc partout. Le test de parité ne pouvait pas le
  voir — il compare les fichiers de traduction entre eux, et la clé manquait
  des trois côtés. C'est la porte d'entrée de l'OCR Tropy, geste central du
  travail sur sources primaires.
- **Détacher un vault supprimait son index local sans confirmation**, alors
  que l'infobulle du bouton l'annonçait et qu'un index volumineux est long à
  reconstruire. Une confirmation nomme désormais ce qui est perdu — et
  rappelle que les notes Obsidian, elles, ne sont pas touchées.
- **`Cmd+Q` juste après une frappe perdait le texte.** `before-quit` arrêtait
  les services mais ne touchait pas à l'éditeur, et aucun `beforeunload`
  n'existait côté renderer ; sans autosave, la perte n'était pas bornée. Le
  processus principal demande maintenant au renderer d'écrire avant de sortir
  et attend son accusé — quatre secondes au plus, un renderer bloqué ne devant
  jamais empêcher de quitter. La décision d'écrire compare le texte **vivant**
  au miroir du store : la synchronisation CM6 → store étant debouncée,
  `isDirty` est encore faux au moment précis où le travail risque d'être
  perdu. Même classe de perte que #37, à la sortie plutôt qu'à la bascule.
- **Le verrou entre renumérotation et export n'était consulté que dans un
  sens** : rien n'empêchait de renuméroter pendant un export déjà lancé, dont
  l'assemblage lit les chapitres plusieurs secondes durant. Le manuscrit était
  alors réécrit sous l'assemblage en cours — le scénario même que le correctif
  de la rc.3 prétendait fermer (#30). Au passage, son rollback « atomique » ne
  restaurait que le tampon de l'éditeur pour le chapitre ouvert, alors que
  l'aller avait écrit sur le disque.
- **Toute la section Configuration RAG était en français littéral** — une
  centaine de libellés, descriptions et repères de réglage qu'aucun anglophone
  ni germanophone ne pouvait lire. Le split #57 n'avait pas créé cette dette
  mais l'avait recopiée verbatim dans deux fichiers neufs, qui n'appelaient
  donc jamais `t()`. Idem pour le sélecteur de style de citation.
- **21 clés manquaient dans les trois locales à la fois**, dont une modale
  entière : l'import de transcriptions Transkribus, quinze clés, intégralement
  en repli anglais. Elles ont été trouvées en confrontant les appels `t()` du
  code aux fichiers de traduction — contrôle qu'un **test** effectue
  désormais, là où le test de parité ne peut structurellement rien voir. Le
  même contrôle a levé un défaut d'une autre nature : `t('similarity.help')`
  visait un objet, et i18next rend alors la clé elle-même ; l'infobulle du
  panneau Similarités affichait littéralement « similarity.help ».
- **18 modales sur 20 ne se fermaient pas avec `Échap`**, alors que le hook
  idoine existait et n'était branché que sur deux dialogues. Il exigeait que
  sa ref soit attachée à un conteneur avant de traiter la moindre touche : une
  modale qui l'appelait sans câbler la ref restait insensible, sans le moindre
  signe. `Échap` n'en dépend plus. La modale de progression reste
  volontairement non fermable.
- **Le focus initial des confirmations partait sur « Confirmer ».** Ce
  dialogue sert aux actions destructrices, et la purge du journal en demande
  deux d'affilée : deux `Entrée` successifs suffisaient à tout effacer. Le
  geste par défaut est désormais celui qui ne détruit rien.

### Ajouté depuis la rc.3

- **Livre** — modale des réglages de l'ouvrage (#24) ; verrou entre
  renumérotation des notes et exports (#30) ; assemblage du manuscrit avant
  le branchement pandoc (#19).
- **Brainstorm** — panneau de brouillons vers le mode Écriture (#7).
- **Corpus et RAG** — `ContextCompressor` câblé dans le chemin de retrieval
  (#28), puis réparé pour le français et dédupliqué par document (#57) ;
  filtre de collections branché sur Similarity et Tropy (#21) ; « All
  collections » scopé à la collection du projet (#2) ; « All documents »
  dédupliqué par entrée bibliographique (#3) ; toggle « nœuds auteurs » du
  graphe de connaissances (#22).
- **Sources primaires** — bouton OCR manuel par source (#23).
- **Journal** — purge du journal de recherche (#16), avec double
  confirmation ; attribution correcte après bascule de chapitre ou de
  projet (#40, #31, #39).
- **Sécurité** — badge sur les sources signalées dans le chat (#8).
- **Configuration** — section Embeddings, provider et modèle embarqué (#18) ;
  sélecteur mort « Embedding strategy » retiré (#17).
- **Éditeur** — polices de prose dans le sélecteur (#12) ; vrai toggle
  gras/italique, wrap et unwrap au lieu d'un placeholder (#10).
- **Robustesse à la bascule de projet** — sauvegarde du document sortant
  (#37) ; attente des indexations PDF en vol avant fermeture du store (#38) ;
  démontage du watcher et du store Tropy (#34) ; scope de l'événement de
  progression du vault (#35) ; `busy_timeout` et WAL explicite sur les
  writers de `brain.db` (#29) ; collections Zotero écrites dans le bon
  projet (#33) et collection d'import réellement mémorisée (#9, #20).
- **Correctifs divers** — `brain.db` n'est plus supprimé entier au détachement
  d'un vault (#27) ; entrées BibTeX sans auteur ne sont plus rejetées
  silencieusement (#32) ; filtre par tags lisible (#11) ; `Cmd+W` sur macOS
  et liens d'aide corrigés (#25, #26) ; `context.md` nourrit enfin
  l'assistant ; modèle embarqué remis en service.
- **Outillage** — configuration ESLint, `npm run lint` fonctionne (#36) ;
  suite de tests exécutée sur l'ABI Node en CI ; `RAGConfigSection` scindé,
  912 lignes en trois fichiers (#57) ; licence GPLv3 déclarée partout.

### Connu, non corrigé dans cette RC

- **75 chaînes françaises codées en dur subsistent hors de la Configuration
  RAG**, dont 48 dans trois autres sections des réglages (sécurité, LLM,
  éditeur). Le test anti-français du dépôt ne balaye toujours que
  `components/Export/` ; le nouveau test de clés, lui, ne voit que les
  chaînes qui passent déjà par `t()`.
- **Les embeddings cloud ne passent par aucun consentement**, alors
  qu'indexer envoie l'intégralité du corpus au fournisseur. Réglage opt-in.
- **Le piège de focus n'est actif que là où la ref est câblée** : `Échap`
  ferme désormais toutes les modales, mais le `Tab` peut encore sortir de
  la modale sur celles qui n'attachent pas la ref du hook.
- **Trois panneaux flottants, trois conventions de superposition** :
  Similarités (`fixed`, z-index 1000), Brouillons (`absolute`, z-index 40)
  et la recherche manuscrit (docké). Ouvrir les deux premiers en même temps
  masque le second, sans que rien ne l'indique.
- **Le corpus manuscrit n'a toujours pas d'interface** : il atteint
  l'assistant depuis cette RC, mais rien n'affiche l'état de l'index, ne
  propose de le reconstruire, ni n'expose `rag.indexManuscript`.
- **`macOS` : signature et notarisation** toujours bloquées sur un certificat
  Apple Developer ID ([#75](https://github.com/cliodeck/cliodeck-app/issues/75)).

## [1.0.0-rc.3] — 2026-07-19

Candidat de version 1, préparé après trois audits (sécurité, interface,
cohérence du code) menés sur l'ensemble de l'application.

### Security

- Les **résultats d'outils MCP** passent désormais par `SourceInspector` et
  sont bornés en taille avant d'atteindre le contexte du modèle. Un serveur
  MCP tiers hostile pouvait jusqu'ici injecter des instructions dans un
  agent disposant d'outils réels — c'était le vecteur nº 1 du modèle de
  menace (ADR 0005), décrit mais non défendu.
- **Chargement et sauvegarde de documents contraints** par le validateur de
  chemins : un renderer compromis ne peut plus lire `~/.ssh` ni écrire hors
  du projet. L'ouverture légitime d'un fichier extérieur reste possible via
  une route consentie — seul le processus principal inscrit au registre les
  chemins qu'il a lui-même proposés dans un dialogue natif.
- **Injection de commande supprimée** dans l'export reveal.js : plus aucun
  shell n'est invoqué.
- **Répertoires temporaires nettoyés en cas d'échec d'export.** Un export
  PDF raté laissait le manuscrit assemblé complet et sa bibliographie en
  clair dans `/tmp` ; trois répertoires de ce type ont été trouvés et
  supprimés lors du correctif.
- ADR 0006 complété : le repli en clair des clés d'API quand le trousseau
  système est indisponible est désormais documenté comme limitation connue.

### Fixed

- **« Vérifier les citations » donnait deux résultats différents** selon
  qu'on passait par le bouton ou par le menu, ce dernier gardant une version
  qui comptait les `[@…]` des blocs de code et ne voyait qu'un chapitre. Les
  deux portes appellent la même logique.
- **La migration de workspace échouait silencieusement** sur un fichier
  `.db` corrompu : better-sqlite3 ouvre paresseusement, l'erreur survenait
  hors du bloc protégé. Faiblesse révélée par des tests qui ne tournaient
  jamais.
- **8 tests dormants réparés** et leur cause racine éliminée (une constante
  de troncature dupliquée six fois dans les outils MCP).
- Les modales d'export PDF et Word étaient **entièrement en français codé en
  dur** : un utilisateur anglophone ou germanophone recevait une boîte de
  dialogue française au moment d'exporter son travail. Un test empêche
  désormais la récidive — le test de parité des locales ne pouvait pas voir
  ce défaut, puisqu'il compare des fichiers de traduction entre eux.
- Anneau de focus immédiat sur les contrôles (il se dessinait en fondu,
  donc absent au moment où l'œil en a besoin) ; `prefers-reduced-motion`
  respecté pour la première fois (230 transitions le ignoraient).
- Messages d'erreur en langage d'usage : le détail technique part en
  console, l'utilisateur reçoit une phrase actionnable.
- Mode livre : liste de chapitres en double supprimée du panneau projet,
  titre du chapitre actif ne se tronque plus, total d'ouvrage qualifié.

### Changed

- L'écran d'accueil invite à créer ou ouvrir un projet au lieu d'afficher
  « No indexed documents » comme message principal.
- L'assistant de démarrage peut être rejoué depuis le panneau du projet.
- Code mort retiré : 8 méthodes du préload sans consommateur, une entrée de
  menu « Statistiques du document » qui ne faisait rien.

## [1.0.0-rc.3] — chapitres de livre (branche `feat/livre-chapitres`)

> Détail du chantier livré dans la rc.3, conservé séparément pour sa valeur
> d'explication. La section était restée marquée « Unreleased » après le tag.

### Added — les livres s'écrivent enfin en chapitres

Le type de projet « livre » n'était qu'une étiquette dans `project.json`
plus un modèle LaTeX : l'API de chapitres existait dans le code mais
n'avait jamais reçu d'interface et ne persistait rien. Un manuscrit se
rédigeait donc dans un unique fichier monolithique. Bilan de départ :
`docs/archive/book-etat-des-lieux.md` ; plan exécuté :
`docs/archive/PLAN_chapitres-livre.md` ; architecture livrée :
`docs/book-architecture.md`.

- **Manifeste de chapitres** dans `project.json` : un chapitre est un
  fichier, l'ordre et les titres sont persistés. La réconciliation
  manifeste ↔ disque signale les fichiers manquants et propose de
  rattacher ceux trouvés hors manifeste — on ne perd jamais de texte par
  désynchronisation.
- **Panneau de chapitres** : création, renommage, réordonnancement,
  retrait du manifeste sans effacer le fichier. Basculer d'un chapitre à
  l'autre préserve le texte, le curseur et **l'historique d'annulation**.
- **Plan du manuscrit** à deux niveaux (chapitres et titres internes),
  lu sur l'arbre de syntaxe : un `#` dans un bloc de code n'est pas un
  titre.
- **Fonctions à l'échelle de l'ouvrage** : renumérotation des notes sur
  tout le manuscrit (atomique — tous les fichiers réécrits ou aucun),
  vérification des citations sur tout le livre, statistiques distinguant
  le chapitre de l'ouvrage.
- **Réglages d'ouvrage** : notes de bas de page, de fin de chapitre ou de
  fin d'ouvrage ; numérotation continue ou repartant à chaque chapitre ;
  bibliographie unique ou par chapitre ; numérotation des titres.
- **Exports** : assemblage du manuscrit avec préfixage des identifiants de
  notes par chapitre — sans quoi deux chapitres utilisant chacun `[^1]`
  produisaient **la même note** dans le document final, le texte du
  premier disparaissant en silence. PDF avec chapitres réellement
  numérotés et table des matières, Word avec une section par chapitre,
  table des matières et sauts de page, et tirage d'un chapitre isolé.

### Fixed — trois bugs qui touchaient aussi les articles

- **Tout document contenant un bloc de code échouait à l'export PDF**
  (« Environment Shaded undefined ») : les modèles LaTeX ne déclaraient
  pas les macros de coloration de pandoc.
- **Une citation écrasait une note manuelle homonyme** : le moteur
  numérotait ses notes sans regarder celles déjà présentes, et le texte
  de l'auteur disparaissait du document exporté.
- **Changer de fichier détruisait le fichier d'arrivée** : il était
  écrasé par le contenu du précédent, dont les dernières frappes étaient
  par ailleurs perdues.

Corrigés en chemin : le résumé qui imprimait son propre titre
(`\# Résumé`) dans le PDF, les notes manuelles mal mappées en Word, et
deux normalisations de fins de ligne CRLF qui violaient la fidélité
octet par octet.

## [1.0.0-rc.3] — éditeur CodeMirror 6 (branche `feat/editor-cm6`)

> Détail du chantier livré dans la rc.3, conservé séparément pour sa valeur
> d'explication. La section était restée marquée « Unreleased » après le tag.

### Changed — l'éditeur d'écriture migre vers CodeMirror 6

La paire Milkdown (WYSIWYG) / Monaco (source) est remplacée par un
éditeur CodeMirror 6 unique en rendu live, façon Obsidian/Zettlr. Plan
et journal du chantier : `docs/archive/PLAN_migration-editeur-cm6.md` et
`docs/archive/migration-cm6.md` ; architecture : `docs/editor-architecture.md`.

Les raisons de la migration :

- **Intégrité du document.** Le texte markdown est la source de vérité :
  l'éditeur ne sérialise jamais — ouvrir puis sauvegarder sans modifier
  produit un fichier identique **octet par octet** (fins de ligne CRLF ou
  mixtes comprises ; corpus de non-régression `test-fixtures/editor/`).
  Milkdown resérialisait via ProseMirror : échappements parasites
  (`\[@clef\]`), notes réécrites, blancs normalisés.
- **L'appareil savant en natif.** Notes de bas de page (exposants,
  infobulle, popup d'édition en place, renumérotation manuelle) et
  citations Pandoc (pastilles, clusters `[@a; @b]`, locators,
  autocomplétion `@` depuis Zotero, clés non résolues signalées) sont
  parsées par deux extensions Lezer maison (`src/editor/lezer-extensions/`,
  destinées à une publication MIT séparée).
- **Traçabilité de l'écriture IA.** Toute transaction porte une origine
  (`changeOrigin`) et toute intervention IA passe par le contrat
  propositionnel (`docs/editor-proposals.md`) : propositions atomiques
  acceptées/rejetées/modifiées, adjudications journalisées dans les deux
  journaux (recherche : contenus complets ; usage IA : agrégats sans
  contenu).

### Removed

- Milkdown (`@milkdown/crepe`, `@milkdown/kit`), Monaco
  (`@monaco-editor/react`) et la bascule WYSIWYG/source — y compris le
  réglage « éditeur par défaut » des projets et des Réglages.
- L'éditeur YAML des recettes passe aussi à CodeMirror (`lang-yaml`).
- Le correctif d'export `unescapeCitations` (PDF et Word) : il réparait
  les échappements produits par Milkdown. Les anciens documents
  contenant encore des `\[@clef\]` ne sont **pas** réécrits
  automatiquement — un chercher-remplacer manuel (`\[@` → `[@`,
  `\]` → `]` dans les citations) suffit, l'éditeur préserve désormais
  le fichier tel quel.

## [1.0.0-rc.2] — fusion ClioBrain (branche `feat/fusion-cliobrain`)

> Livré dans la rc.2. La section portait un numéro `2.0.0` et la mention
> « Unreleased », tous deux périmés : la fusion est bien dans la ligne 1.0.

Absorbs [ClioBrain](https://github.com/inactinique/cliobrain) into
ClioDeck as the **Brainstorm** mode. One app now covers the whole
historian cycle — *Explorer → Brainstormer → Écrire → Exporter* — on a
shared workspace, sources, and index.

See [`docs/archive/fusion-cliobrain-strategy.md`](docs/archive/fusion-cliobrain-strategy.md)
and [`docs/archive/fusion-cliobrain-implementation-plan.md`](docs/archive/fusion-cliobrain-implementation-plan.md)
for the full rationale and step-by-step plan. Commit messages in the
fusion branch reference the step numbers defined there.

### Added

#### Workspace layout (flat)
- All workspace artifacts live flat under `.cliodeck/`: `config.json`
  with `schema_version: 2`, `hints.md`, `mcp-access.jsonl`,
  `security-events.jsonl`, `recipes/`, `recipes-runs/`,
  `obsidian-vectors.db`, alongside the pre-fusion SQLite stores
  (`vectors.db`, `primary-sources.db`, `history.db`, `hnsw.index`).
- `migrateWorkspaceToFlat` auto-migrates two legacy layouts on project
  load: the in-flight `.cliodeck/v2/*` subdir produced by earlier fusion
  commits, and the pre-fusion v1 `.cliodeck/` without `config.json`.
  Both promotions are idempotent and additive — failures don't block
  load.
- Returns a typed `MigrationReport` (partial-success first-class per the
  claw-code engineering guidelines): `copied`, `skipped` with typed
  reason, `warnings`.

#### Typed LLM provider layer
- `LLMProvider` / `EmbeddingProvider` interfaces with a typed
  `ProviderState` state machine (never a boolean `connected`).
- Five providers: Ollama, OpenAI-compatible (llama.cpp, LM Studio, vLLM,
  OpenAI native), Anthropic, Mistral, Gemini.
- `ProviderRegistry` with open factory map; new providers plug in via
  `registerLLMProvider` without touching call sites.
- Mock-replay parity harness (`npm run test:provider-parity`) comparing
  every provider's normalised output on a shared fixture set.
- Legacy bridges: `createRegistryFromLegacyConfig` (cliobrain
  `LLMProviderConfig`) and `createRegistryFromClioDeckConfig` (cliodeck
  user-level `LLMConfig`).
- Every existing LLM call site (`DocumentSummarizer`, `NERService`,
  `TropySync`, `SimilarityService`, `SlidesGenerationService`,
  `ChatService`, `PDFService`) now has an additive setter to route
  through the registry while preserving the legacy path.

#### Brainstorm mode
- Four-mode top-level navigation (Brainstorm / Write / Analyze /
  Export), persisted across sessions, defaulting to Write on first
  launch so existing UX is unchanged.
- Streamed chat composer — Cmd/Ctrl+Enter to send, animated streaming
  cursor, cancel button, reset — built on the typed provider
  registry with automatic `.cliohints` injection.
- **Send to Write** on each completed assistant turn — formats the
  message as a Markdown draft block (wrapped in HTML-comment
  markers for later scripted extraction) and appends to the editor,
  preserving RAG citations as `**Sources**` lists.
- Workspace scaffold panel showing hints, Obsidian vault status, and
  recipe list from the new IPC bridge.

#### Knowledge management
- **Obsidian vault integration** — `ObsidianVaultReader`,
  `ObsidianMarkdownParser`, `ObsidianVaultExporter` ported; new
  `ObsidianVaultIndexer` + `ObsidianVaultStore` run a parallel
  SQLite+FTS5 index at `.cliodeck/obsidian-vectors.db` with hybrid
  search (brute-force cosine + FTS5 BM25, RRF K=60).
- **Knowledge graph** — Graphology-based community detection ported,
  `GraphData` / `GraphNode` / `GraphEdge` types unified with existing
  NER types.
- **NER consolidated** — kept the richer ClioDeck impl (chunking,
  deduplication, query-specific extraction, multi-format JSON
  parsing) and added ClioBrain's multilingual prompts (fr / en / de)
  + `CONCEPT` entity type.

#### Platform features
- **`.cliohints`** — durable workspace context (`hints.md`) injected
  into every prompt via `prependAsSystemMessage` /
  `prependAsPrompt`. Never leaked to external MCP tools unless the
  user opts in per-tool.
- **Context compaction** — threshold-based middle-of-conversation
  summarisation that keeps system turns + N most recent turns intact
  and preserves RAG citation messages verbatim.
- **ClioRecipes v1** — YAML workflows with zod-validated schema, a
  runner producing JSONL event logs (events over scraped prose), four
  builtin recipes (Zotero review, Tropy analysis, chapter brainstorm,
  Chicago export).
- **MCP server (outbound)** — `backend/mcp-server/` exposes the
  Obsidian vault over stdio to Claude Desktop / Cursor. Inactive by
  default — refuses to start unless `mcpServer.enabled: true` in the
  workspace config. Typed `MCPAccessEvent` JSONL audit log.
- **MCP clients (inbound)** — `MCPClientManager` consumes external
  MCP servers with typed lifecycle state machine, one-shot silent
  recovery on subprocess crash, partial-success reporting
  (`listReady()`).
- **SourceInspector** — scans RAG chunks for prompt-injection
  patterns before they reach the prompt. `warn` / `block` modes,
  typed `SecurityEvent` JSONL log. Threat model is explicit:
  defends against malicious *sources*, not a compromised local LLM.

#### AI usage journal (journal d'usage IA)
- Reflexive, ethics-oriented record of AI inference use — **not telemetry**,
  and strictly separate from the research journal (`history_*`): it logs
  volumes and usage *decisions*, never prompts.
- Two layers: a **factual** layer captured automatically via a decorator on
  the provider registry (`getLLM()`/`getEmbedding()`) covering completions,
  embeddings, recipes and the headless CLI (`recipe run`, `search` — sink set
  by `initHeadlessJournal`; MCP-side capture is reserved in the schema and
  lands later); and a **decisional** layer of manual daily annotations
  (task / non-AI alternative / justification / verdict).
- Bulk indexing aggregated into one `embedding_batch` per run; tokens real
  when the API reports them (Ollama, Anthropic, Gemini, OpenAI-compatible),
  else estimated (chars/4, flagged). `is_local` covers Ollama and
  OpenAI-compatible backends on loopback (llama.cpp, LM Studio). Non-blocking
  writes — a journal failure never fails a call.
- Separate SQLite store `.cliodeck/journal.db` (so it can be archived and
  published independently), tables `inference_events`, `usage_decisions`,
  `session_decision`, `journal_meta`.
- CLI `cliodeck journal today|week|export` via `bin/cliodeck-journal`
  (Electron-node wrapper for the native better-sqlite3 ABI), with interactive
  annotation and Markdown / JSONL / CSV export (`--anonymize` for stable
  aliases). Markdown is structured by week with a "violations" section for
  substantial un-annotated sessions.
- Minimal UI: a dedicated modal opened from the **View menu** (« Journal
  d'usage IA », `Cmd/Ctrl+J`) — daily summary + annotation form + discreet
  badge. Workspace mode mirrored to the main process so events are tagged
  with the real mode.
- ADR 0007; see `docs/journal-usage-ia.md`.

#### Headless CLI
- `cliodeck recipe list [--workspace]`
- `cliodeck recipe run <name> --workspace <path> [--input k=v …]`
- `cliodeck search "query" --workspace <path> [--topK 10]`
- `cliodeck hints show|set --workspace <path>`
- `cliodeck import-cliobrain <workspace> [--overwrite] [--name <label>]`
- `cliodeck rag-benchmark --corpus <docs.json> --queries <queries.json>`
- `cliodeck-journal today|week|export --workspace <path>` (separate binary)
- Both binaries are `bin/` wrappers running under the Electron-embedded Node
  (native better-sqlite3 / hnswlib ABI). `recipe run` and `search` record
  their inference in the AI usage journal (`mode: cli`).
- Unix-convention exit codes (0 / 1 / 2).

#### RAG preparation (2.4a gate)
- `SourceDocument` / `SourceChunk` additive generalisation of
  `PDFDocument` / `DocumentChunk` with conversion helpers.
- `backend/core/rag/benchmark.ts` — pipeline-agnostic benchmark
  harness (recall@K, MRR, latency percentiles, before/after diff).
  Gates the future vector-store unification swap per ADR 0001.

#### UI + integration polish (post-initial-fusion work)
- **Unified chat UI** — shared `ChatSurface` component drives both the
  legacy RAG chat and the Brainstorm chat. Same message bubble,
  composer, and send-key (Cmd/Ctrl+Enter) in both modes.
- **Brainstorm wired to RAG** — extracted `RetrievalService` from
  `pdf-service`. Brainstorm chat now hits the full hybrid pipeline
  (HNSW + BM25 over PDFs, Tropy primaries, optionally Obsidian vault)
  and streams retrieval hits to the renderer for display as source
  cards below each assistant turn.
- **Settings additions** — editor for `.cliohints`, read-only recipes
  browser with a "Run" button, Obsidian vault config (pick / index /
  re-index / unlink with progress), opt-in toggle to include the
  vault in the legacy chat too.
- **More LLM backends** — UI selector + adapter routing for Anthropic
  Claude, OpenAI, Mistral, and Google Gemini (new `GeminiProvider` +
  `GeminiEmbeddingProvider` with dedicated contract tests). API keys
  flow through the existing secureStorage keyring.
- **Cloud embeddings** — `useCloudEmbeddings` flag routes embeddings
  to the same cloud provider (Gemini / OpenAI / Mistral) instead of
  Ollama, for users without a local Ollama.
- **Recipe execution** — `fusion:recipes:run` IPC streams `RunEvent`
  payloads; settings modal renders inputs form, live event log,
  outputs panel. Real step handlers wired: search →
  `retrievalService`, graph → `KnowledgeGraphBuilder`, export →
  `pdfExportService` (Pandoc). Brainstorm/write steps use the LLM
  via the provider registry.
- **Theme alignment** — new fusion UIs (BrainstormPanel, ChatSurface,
  WorkspaceModeBar) now use the real dark-theme tokens (`--bg-app`,
  `--text-primary`, `--color-accent`, `--color-danger`) instead of
  hardcoded light fallbacks.

### Developer experience

- 250+ new tests covering every module introduced by the fusion, with
  fake factories / in-memory stores so live backends are optional.
- `pre-fusion-v1` git tag marks the state before the absorption began.
- Commit messages reference step numbers from the implementation plan,
  keeping the narrative traceable.

### Known limitations of v2.0

- Full `PDFDocument` → `SourceDocument` rename across the vector-store
  surface (Path A of ADR 0001) is gated on a gold-standard benchmark
  run; the type scaffold and harness ship now, the swap ships when
  the benchmark confirms no quality regression.
- MCP server ships one tool (`search_obsidian`); Zotero / Tropy /
  graph / entity-context tools arrive in follow-up commits.
- MCP clients: the `WorkspaceConfig.mcpClients` schema is in place but
  no runtime lifecycle (spawning, tool exposure to the LLM, settings
  UI) yet — tracked as a follow-up milestone.
- Recipe `export` step reads the project's `document.md` only; the
  `document_id` input is accepted but ignored until multi-document
  projects land.

## [1.0.0-beta.2] - 2025-01-20

### Added

#### Zotero Integration
- **Bidirectional sync** with Zotero library - detect additions, modifications, and deletions
- **Three conflict resolution strategies**: Remote Wins, Local Wins, Manual selection
- **Zotero groups support** for shared libraries
- **Collections filtering** for targeted RAG queries
- **Batch PDF download** from Zotero attachments

#### Bibliography Management
- **Bibliography statistics dashboard** with 4 interactive tabs (Overview, Authors, Publications, Timeline)
- **Tags and metadata system** with custom fields support
- **BibTeX export** with full metadata preservation
- **Orphan PDF detection and cleanup** with archive option (safe) or delete (permanent)
- **Modified PDF detection** with MD5 hash comparison and re-indexation prompts

#### Editor
- **Milkdown WYSIWYG editor** replaces Monaco Editor for better markdown editing experience
- **Toggle between WYSIWYG and raw markdown** modes
- **Improved footnote styling** in both dark and light themes

#### Vector Store & RAG
- **Enhanced vector store** with improved chunking strategies
- **Zotero collections integration** for refined RAG queries
- **Embedding strategy selector** (nomic-fallback, mxbai-only, custom)

#### UI/UX
- **Project opening progress indicator**
- **Unified bibliography panel** (removed separate PDFs tab - all PDF management through Zotero workflow)
- **Improved light theme** CSS fixes

### Changed

- **Renamed ClioDesk to ClioDeck** throughout the project
- **Relative paths** in project.json files for better portability
- **Updated AI models** configuration
- **Improved translations** for French, English, and German

### Fixed

- Multiple Zotero collections synchronization bugs
- Milkdown light theme rendering issues
- Document re-indexation for already indexed files
- CSS issues in light mode
- BERTopic installation process
- Various bibliography management bugs

## [1.0.0-beta.1] - 2024-12-XX

### Added

- Initial beta release
- RAG-powered research assistant
- Zotero integration (import)
- PDF indexing and semantic search
- Ollama and Claude LLM support
- Embedded Qwen model option
- Project management (Article, Book, Presentation)
- PDF and Word export
- Dark/Light theme support
- French, English, German localization
