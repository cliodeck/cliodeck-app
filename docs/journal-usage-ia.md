# Journal d'usage IA

> Instrument réflexif de documentation de la pratique d'un·e historien·ne face à
> l'inférence IA. **Ce n'est pas de la télémétrie** ni un outil d'optimisation de coûts :
> c'est une matière destinée, à terme, à être partiellement publiée (carnet de recherche).

## 1. Intention

Le journal d'usage IA aide à répondre, semaine après semaine, à trois questions :

1. Quel volume d'inférence ai-je consommé, pour quelles tâches, sur quels corpus ?
2. Pour chaque *décision d'usage*, quelle alternative non-IA existait, et pourquoi
   a-t-elle été écartée ?
3. Rétrospectivement, l'usage valait-il son coût ?

Le jugement reste **textuel** : pas de score, pas de budget chiffré, pas de gamification.

## 2. Distinction avec le journal de recherche

ClioDeck comporte déjà un **journal de recherche** (`historyService`, tables `history_*`
dans `brain.db`) : un outil de travail qui journalise notamment les **prompts**, au
service de la recherche.

Le **journal d'usage IA** est une fonctionnalité **différente et indépendante** :

| | Journal de recherche | Journal d'usage IA |
|---|---|---|
| But | outil de travail | instrument réflexif / éthique |
| Contenu | prompts, échanges, opérations | volumes, contexte, décisions d'usage |
| Prompts | oui | **jamais** |
| Stockage | `brain.db` (`history_*`) | `journal.db` (séparé) |
| IPC | `history:*` | `usage:*` |
| UI | panneau Journal | modale menu Affichage (`Cmd/Ctrl+J`) |

Les deux couches ne partagent **ni tables, ni modèle de données, ni code**. Le journal
d'usage IA ne journalise **aucun prompt** : ce point est tranché.

## 3. Principe : deux couches strictement séparées

- **Couche factuelle (automatique)** — capture des événements d'inférence, sans
  intervention de l'utilisateur. Ne déduit jamais rien sur les intentions.
- **Couche décisionnelle (manuelle)** — annotations de l'utilisateur, agrégées par
  *décision d'usage* (typiquement 1 à 4 par jour), jamais par requête. Facultative :
  l'app fonctionne sans elle.

## 4. Couche factuelle — capture automatique

### Point d'insertion

La capture est posée sur la **couche de providers typée**, via un décorateur appliqué
dans `ProviderRegistry.getLLM()` / `getEmbedding()`
(`backend/core/llm/providers/instrument.ts`). Tous les appels de complétion (`chat`,
`complete`) et d'embedding (`embed`) y transitent — un seul point de passage, y compris
CLI et recipes. Le sink est posé par l'app au chargement d'un projet
(`usageJournalService.init`) et par le CLI headless (`initHeadlessJournal`, pour
`cliodeck recipe run` et `cliodeck search`). Best-effort : si le journal n'est pas
initialisé, le décorateur est inerte ; **une panne du journal ne fait jamais échouer un
appel LLM**.

### Événements capturés

Pour chaque appel : horodatage, durée, type (`completion` | `embedding` |
`embedding_batch`), provider et modèle, exécution locale ou cloud (`is_local` :
Ollama sur la machine, le modèle embarqué — llama.cpp dans le processus de l'app,
génération comme embeddings —, ou provider openai-compatible dont le baseUrl pointe en
loopback — llama.cpp, LM Studio ; le reste est compté cloud), tokens prompt/réponse
(réels quand l'API les fournit — Ollama, Anthropic, Gemini, openai-compatible ; Mistral
reste estimé à ~4 caractères/token, `tokens_estimated: true`), contexte applicatif
(mode, workspace, corpus, recipe), identifiant de session, statut.

Le **statut** est l'issue réelle de l'appel, lue sur le chunk terminal du fournisseur :

- `ok` — l'appel a abouti, y compris une réponse coupée par la limite de longueur ;
- `error` — le fournisseur a échoué (requête refusée, flux rompu, clé expirée…) ;
- `cancelled` — l'appel a été abandonné : « Arrêter », fermeture du projet, délai
  d'inactivité, résumé du compacteur arrêté avec le tour. Ni réussi, ni en panne.

`cancelled` est entré en rc.6 (L09-16) : **un script qui lit l'export en n'attendant que
`ok` ou `error` doit prévoir cette troisième valeur.** Les lignes écrites avant restent
telles quelles : un appel annulé y figure en `ok`, un embedding abandonné en `error`.
Un `embedding_batch` ne dit que `ok` ou `error` : une indexation abandonnée y compte
comme une panne.

Cas particuliers :

- **Préchauffage du modèle** — à l'ouverture d'un projet, l'app charge le modèle
  d'embeddings de l'indexation par un appel (`warmup query`). Avec le moteur embarqué,
  elle charge aussi celui de la recherche, qui a son propre client llama.cpp, sans
  calculer aucun embedding. La première question n'attend donc pas ces chargements. Ce
  geste de l'app n'a pas de conséquence méthodologique pour l'auteur : il **n'est pas
  inscrit** (`runUnrecorded`, J11). Une indexation que l'ouverture lance d'elle-même
  (notes de lecture, sources primaires à refaire) s'inscrit comme toute indexation. Les
  23 termes du dictionnaire d'expansion FR↔EN, qui partaient aussi à l'ouverture du
  premier projet de chaque lancement, ne sont plus envoyés.
- **Repli Ollama → modèle embarqué** — en réglage `auto`, un appel est attribué au
  fournisseur qui a répondu (`embedded` quand Ollama est arrêté), pas à celui de la
  configuration, et sa localité se calcule pour lui : génération comme embeddings. Les
  lignes écrites avant restent attribuées à `ollama`, et leur `is_local` suit l'adresse
  d'Ollama, même pour un calcul du modèle embarqué.
- **Appel tombé ou annulé avant toute réponse** — rien de produit, aucun usage annoncé :
  l'événement ne porte aucun jeton (`tokens_estimated: false`). Le fournisseur n'a
  peut-être jamais reçu le prompt ; l'estimer inventait une consommation.
- **Indexations en masse** — agrégées en un seul `embedding_batch` (compte de chunks +
  total de tokens) par run, via un scope ouvert aux trois frontières d'indexation (PDF,
  Obsidian, Tropy), plutôt qu'un événement par chunk.
- **Projet de l'appel** — l'événement s'écrit à la fin de l'appel, mais il appartient au
  projet de son début : celui de l'opération qui l'a lancé, sinon celui du journal ouvert
  quand l'appel ou le lot a commencé. Posent leur projet à leur entrée : le tour de chat,
  la recette, l'indexation des PDF, du vault, du manuscrit et des notes de lecture, la
  synchro Tropy et l'analyse de similarité. Un appel lancé dans A et fini après
  l'ouverture de B n'entre pas dans le journal de B, qui se publie seul : il est perdu, et
  un avertissement le dit dans la console (S10-1-33). Le même dossier par un lien ou une
  autre casse reste le même projet.
- **Opération en plusieurs appels** — une opération qui enchaîne les appels sans s'arrêter
  à l'ouverture d'un autre projet (un livre réembarqué chapitre après chapitre, des notes
  indexées une à une) doit poser son projet à son entrée, par `runWithJournalContext`.
  Sinon, ses appels lancés après la bascule prennent le projet du journal alors ouvert, et
  entrent dans le journal de B sous la racine de B.
- **Mode applicatif** — le mode (`explore|brainstorm|write|export`) vit dans le renderer ;
  il est miroité vers le main via `usage:set-mode`. Les contextes backend posent leur
  littéral : `recipe` (runner, avec `recipeId` — il écrase le `cli` parent quand une
  recipe est lancée depuis le CLI, une recipe reste une recipe) et `cli` (commandes
  headless). Le contexte `mcp` et le kind `mcp_session` sont réservés dans le schéma ;
  la capture côté serveur MCP viendra plus tard.

### Adjudications de propositions IA (schéma v2 — éditeur CM6, Phase 4)

Quand l'éditeur affiche une proposition IA (contrat propositionnel, voir
`docs/editor-proposals.md`), chaque **adjudication** — `accepted` | `rejected` |
`modified`, plus les fins de vie sans jugement `invalidated` (édition humaine
sur le texte visé) et `expired` (fermeture du document) — est journalisée dans
une table dédiée `proposal_adjudications` : `{décision, catégorie, modèle,
tâche, horodatage, workspace}` et **rien d'autre**.

**Aucun contenu textuel n'entre dans le journal d'usage** — ni le texte
original, ni le texte proposé, ni la version finale : ces contenus relèvent du
journal de recherche (`history_proposal_events` dans `brain.db`). La
granularité est imposée par le typage (le type d'entrée du store ne possède
pas de champ de contenu), pas seulement par la discipline de l'appelant. Les
taux d'acceptation (par catégorie, par modèle, par période) sont calculés côté
journal (`summarizeAdjudications`), jamais côté éditeur.

### Sessions

Découpage cosmétique (lisibilité du résumé), non contraignant : une session se ferme
après une **fenêtre d'inactivité de 30 min** **ou** un changement de
workspace ; le changement de mode ne découpe pas. Les `session_id` sont persistés à
l'écriture ; l'agrégation les regroupe sans les redécouper.

## 5. Couche décisionnelle — annotation

Une **décision d'usage** comporte : date, workspace, `task` (description courte),
`alternative` (l'alternative non-IA, éventuellement « aucune raisonnable »),
`justification` (pourquoi elle a été écartée), `verdict`
(`worth_it | not_worth_it | unsure | pending`) + note optionnelle.

Le **rattachement session→décision est entièrement manuel** : l'utilisateur associe
lui-même les sessions du jour à ses décisions. Une session non rattachée reste visible
comme telle — c'est la matière de la section « violations ».

### Brouillons issus des rejets de propositions (v2)

Au rejet d'une proposition IA, l'éditeur propose — de façon échantillonnée
(1 rejet sur 5, jamais deux fois de suite) — un champ « pourquoi ? » optionnel.
La note saisie est stockée dans `decision_drafts` comme **brouillon** de la
couche décisionnelle : elle n'est **jamais** promue automatiquement en
décision d'usage (la sémantique de `usage_decisions` — tâche/alternative/
justification/verdict — reste intacte). C'est l'utilisateur qui, le cas
échéant, s'en servira comme point de départ d'une annotation quotidienne.

## 6. Stockage (`.cliodeck/journal.db`)

Base **SQLite séparée** de `brain.db`, volontairement : le journal doit pouvoir être
copié, archivé et publié indépendamment de l'outil qu'il documente. Écritures non
bloquantes (buffer + flush débouncé). Migration prévue dès la v1 (table `journal_meta`,
`schema_version`).

```
inference_events(id, session_id, at, duration_ms, kind, provider, model, is_local,
                 prompt_tokens, completion_tokens, total_tokens, tokens_estimated,
                 chunk_count, mode, workspace, corpus, recipe_id, status, ref)
usage_decisions(id, date, workspace, task, alternative, justification, verdict, verdict_note)
session_decision(session_id, decision_id)   -- rattachement manuel
proposal_adjudications(id, at, decision, category, model, task, workspace)  -- v2, sans contenu
decision_drafts(id, at, category, model, task, note, status)                -- v2, brouillons
journal_meta(key, value)                     -- schema_version (courante : 2)
```

Migration v1 → v2 : purement additive (deux nouvelles tables) ; les données
v1 ne sont pas touchées.

## 7. Interfaces

### CLI (`bin/cliodeck-journal`)

Le CLI tourne sous le Node embarqué d'Electron (ABI de better-sqlite3) — comme
`bin/cliodeck-mcp`.

```
bin/cliodeck-journal today  --workspace <path> [--annotate | --no-annotate]
bin/cliodeck-journal week   --workspace <path>
bin/cliodeck-journal export --workspace <path> [--format md|jsonl|csv]
                            [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--anonymize]
```

- `today` affiche le résumé du jour puis, si le terminal est interactif, invite à
  annoter les décisions (verdict à une lettre, sessions par indices). Objectif : moins
  de deux minutes pour une journée normale.
- `export` écrit sur la sortie standard (rediriger avec `>`).

### UI

Menu **Affichage → « Journal d'usage IA »** (raccourci `Cmd/Ctrl+J`) ouvre une modale
dédiée : résumé du jour ventilé, formulaire à trois champs + verdict, rattachement des
sessions par cases à cocher, et un **badge discret** « N à annoter » quand des sessions
substantielles ne sont couvertes par aucune décision. Aucune notification intrusive. Le
journal est un rituel récurrent, volontairement hors des Settings (qui servent à
configurer).

## 8. Export pour publication

Le **Markdown** est le livrable central : structuré par semaine, il présente les
tableaux de volumes (par mode, par provider, local vs cloud, corpus), la liste des
décisions avec leurs quatre champs, et une section **« violations »** — les sessions
substantielles non annotées. *Le journal rend visibles ses propres trous plutôt que de
les masquer.* L'option `--anonymize` remplace les noms de corpus et de workspaces par des
alias stables (`corpus-A`, `workspace-A`…).

Formats JSONL (une ligne par enregistrement) et CSV (une ligne par événement) sont
fournis pour re-traitement.

## 9. Non-objectifs (v1)

- Pas d'estimation carbone/énergie (chiffres par requête invérifiables) ; le schéma ne
  l'interdit pas pour plus tard.
- Pas d'annotation par requête (l'unité est la décision d'usage).
- Pas d'envoi réseau (local-first).
- Pas de score ni de budget chiffré.

## 10. Références

- ADR [`docs/adr/0007-usage-journal-separate-db-and-provider-hook.md`](adr/0007-usage-journal-separate-db-and-provider-hook.md)
- Repérage des points d'insertion : [`docs/archive/journal-usage-ia-reperage.md`](archive/journal-usage-ia-reperage.md)
