# Instructions — Journal d'usage IA (ClioDeck)

> Fichier d'instructions pour Claude Code. À lire en entier avant de coder.
> Lire aussi `CLAUDE.md`, `docs/fusion-cliobrain-strategy.md` et les ADR existants avant toute décision d'architecture.

## 1. Contexte et intention

ClioDeck doit intégrer un **journal d'usage de l'inférence IA** à visée réflexive et éthique. L'objectif n'est **pas** la télémétrie ni l'optimisation de coûts : c'est un instrument de documentation de la pratique d'un historien, destiné à terme à être partiellement publié (carnet de recherche). Le journal doit permettre de répondre, semaine après semaine, à trois questions :

1. Quel volume d'inférence ai-je consommé, pour quelles tâches, sur quels corpus ?
2. Pour chaque *décision d'usage*, quelle alternative non-IA existait, et pourquoi a-t-elle été écartée ?
3. Rétrospectivement, l'usage valait-il son coût ?

### Distinction impérative avec le journal de recherche existant

ClioDeck comporte déjà un **journal de recherche**, qui journalise notamment les prompts : c'est un outil de travail pour l'utilisateur, au service de sa recherche. Le **journal d'usage IA** décrit ici est une fonctionnalité **différente et indépendante** : un instrument réflexif portant sur les volumes et les décisions d'usage, pas sur le contenu des échanges.

Conséquences :

- **Aucune fusion, aucune extension du journal de recherche.** Code, stockage, UI et exports séparés. Ne pas réutiliser ses tables ni son modèle de données.
- **Pas de journalisation des prompts** dans le journal d'usage IA. Les prompts relèvent du journal de recherche ; ici, seuls comptent volumes, contexte applicatif et annotations décisionnelles. Ce point est tranché, pas ouvert à discussion.
- La documentation (`docs/journal-usage-ia.md`) doit expliciter cette distinction pour éviter toute confusion chez les utilisateurs et les futurs contributeurs.

Principe directeur : **deux couches strictement séparées**.

- **Couche factuelle (automatique)** : capture des événements d'inférence, sans intervention de l'utilisateur.
- **Couche décisionnelle (manuelle)** : annotations quotidiennes de l'utilisateur, agrégées par *décision d'usage* et non par requête.

La couche automatique ne doit jamais rien inférer sur les intentions ; la couche manuelle ne doit jamais être obligatoire pour que l'app fonctionne.

## 2. Non-objectifs (v1)

- **Pas d'estimation carbone/énergie.** Les chiffres par requête sont invérifiables ; la v1 journalise des tokens et des durées, point. Prévoir seulement que le schéma n'interdise pas un enrichissement ultérieur.
- **Pas d'annotation par requête.** L'unité d'annotation est la décision d'usage (typiquement 1 à 4 par jour).
- **Pas d'envoi réseau.** Le journal est local-first, comme le reste de ClioDeck. Aucune donnée ne sort de la machine.
- **Pas de gamification, pas de score, pas de "budget" chiffré en v1.** Le jugement reste textuel.

## 3. Couche factuelle — capture automatique

### 3.1 Point d'insertion

Instrumenter la **couche de providers LLM typée** (registre des providers : Ollama, OpenAI-compatible, Anthropic, Mistral, Gemini), à l'endroit le plus central possible — idéalement un wrapper/middleware unique par lequel passent tous les appels de complétion **et** d'embeddings, quel que soit le backend. Ne pas instrumenter provider par provider si un point de passage commun existe ou peut être créé proprement.

Explorer le code pour localiser ce point ; si aucun point commun n'existe, en proposer un (décorateur du registre) plutôt que de dupliquer la logique dans chaque provider.

### 3.2 Événements à capturer

Pour chaque appel d'inférence ou d'embedding :

- horodatage (début), durée (ms)
- type d'appel : `completion` | `embedding`
- provider et modèle (ex. `ollama/gemma2:2b`, `anthropic/claude-…`)
- exécution locale ou cloud (booléen dérivé du provider)
- tokens prompt / tokens réponse quand l'API les fournit ; sinon estimation grossière (caractères/4) **marquée comme estimée** (champ `tokens_estimated: boolean`)
- contexte applicatif : mode ClioDeck (`brainstorm` | `write` | `analyze` | `export` | `recipe` | `mcp` | `cli`), identifiant du workspace/projet, et si disponible le corpus ou la recipe concernés
- identifiant de session (regroupement d'appels rapprochés dans le même mode — définir une heuristique simple, ex. fenêtre d'inactivité de 30 min)
- statut : succès / erreur

Cas particuliers :

- **Indexations d'embeddings en masse** : agréger en un seul événement de type `embedding_batch` avec compte de chunks et total de tokens, pas un événement par chunk.
- **Serveur MCP** : il existe déjà un log JSONL d'accès. Ne pas le dupliquer ; ajouter dans le journal un événement de synthèse par session MCP qui référence le log JSONL existant.
- **ClioRecipes** : tagger les appels avec l'identifiant de la recipe.

### 3.2 bis Adjudications de propositions IA (amendement Phase 4 du plan CM6, 2026-07-17)

> Amendement au périmètre v1 ci-dessus, requis par le contrat propositionnel de
> l'éditeur (plan `PLAN_migration-editeur-cm6.md`, Phase 4 ; spec côté éditeur :
> `docs/editor-proposals.md`). La liste des événements v1 (completion/embedding)
> reste inchangée par ailleurs.

Quand une proposition IA est adjudiquée dans l'éditeur, la couche factuelle
capture : `{décision (accepted|rejected|modified|invalidated|expired),
catégorie, modèle, tâche, horodatage, workspace}` — **sans aucun contenu
textuel** (ni original, ni proposé, ni final, ni prompt). Les contenus vont au
journal de recherche, conformément à la distinction impérative du §1.

- Table **dédiée** `proposal_adjudications` (schema v2), PAS un nouveau kind
  d'`inference_events` : une adjudication n'est pas un appel d'inférence
  (aucune colonne provider/tokens n'aurait de sens) et l'union `InferenceKind`
  reste fermé.
- La granularité est imposée par le **typage** (le type d'entrée du store n'a
  pas de champ de contenu), pas seulement par l'omission à l'écriture.
- Les agrégats (taux d'acceptation par catégorie/modèle/période) sont calculés
  côté journal (`summarizeAdjudications`), jamais côté éditeur. Les
  `invalidated`/`expired` (fins de vie sans jugement) sont exclus du
  dénominateur du taux d'acceptation.

### 3.3 Stockage

- Base **SQLite séparée** : `.cliodeck/journal.db` (via better-sqlite3, comme le reste). Séparée de `brain.db` volontairement : le journal doit pouvoir être copié, archivé et publié indépendamment de l'outil qu'il documente.
- Deux tables principales : `inference_events` (couche factuelle) et `usage_decisions` (couche décisionnelle), plus une table de liaison `session_decision` (le rattachement est manuel, voir §7, mais son résultat doit être persisté). Depuis le schema v2 (Phase 4 CM6) : `proposal_adjudications` (couche factuelle, §3.2 bis) et `decision_drafts` (brouillons de la couche décisionnelle, §7).
- Écritures asynchrones et non bloquantes ; **une panne du journal ne doit jamais faire échouer un appel LLM** (try/catch autour de la journalisation, log d'erreur silencieux).
- Prévoir la migration de schéma dès la v1 (table `journal_meta` avec version).

## 4. Couche décisionnelle — annotation quotidienne

### 4.1 Modèle de données (`usage_decisions`)

Une décision d'usage comporte :

- date, workspace
- `task` : description libre courte de la tâche (ex. « ré-indexation corpus Lester après ajout de 40 documents »)
- `alternative` : quelle alternative non-IA existait (texte libre, peut être « aucune raisonnable »)
- `justification` : pourquoi l'alternative a été écartée
- `verdict` : jugement rétrospectif — enum courte (`worth_it` | `not_worth_it` | `unsure` | `pending`) + champ texte libre optionnel
- rattachement aux sessions de la journée : **manuel uniquement** — sélection par l'utilisateur dans la liste des sessions du jour, éditable a posteriori

### 4.2 Interface

Deux voies, les deux en v1 :

1. **CLI headless** (prioritaire, plus simple) : commande `cliodeck journal` avec sous-commandes :
   - `cliodeck journal today` — résumé de la journée (n appels, tokens ventilés par provider/mode/corpus, sessions détectées) puis invite interactive pour annoter les décisions ;
   - `cliodeck journal week` — synthèse hebdomadaire ;
   - `cliodeck journal export --format md|jsonl|csv [--from --to]` — export.
2. **UI minimale dans l'app** : un panneau « Journal » accessible depuis les Settings ou un onglet discret ; affiche le résumé du jour et un formulaire à trois champs + verdict. Pas plus. Aucune notification intrusive ; au maximum un badge discret si des sessions du jour ne sont couvertes par aucune décision.

Règle d'ergonomie non négociable : **l'annotation d'une journée normale doit prendre moins de deux minutes.** Si un choix de design allonge ce temps, il est mauvais.

### 4.3 Export pour publication

L'export Markdown est le livrable le plus important : il doit produire un document lisible par des collègues historiens, structuré par semaine, avec :

- tableau synthétique des volumes (par mode, par provider, local vs cloud)
- liste des décisions avec leurs quatre champs
- section « violations » : sessions substantielles non couvertes par une annotation (le journal doit rendre visibles ses propres trous, pas les masquer)

Option `--anonymize` : remplace les noms de corpus/workspaces par des alias stables (`corpus-A`, etc.).

## 5. Contraintes techniques

- Respecter les conventions du repo (TypeScript strict, structure Electron main/renderer existante, Zustand côté renderer, IPC typé).
- La capture vit côté **main process** (c'est là que passent les appels providers) ; l'UI ne fait que lire via IPC.
- Tests : unités sur le schéma et l'agrégation de sessions (vitest, comme le reste) ; un test e2e minimal sur `cliodeck journal today` si l'infra e2e le permet sans coût excessif.
- Documentation : une page wiki-ready `docs/journal-usage-ia.md` expliquant le modèle deux-couches, le schéma SQLite, et la philosophie (réflexivité, pas télémétrie). Rédiger un ADR (`docs/adr/`) pour le choix « base séparée + hook au niveau du registre de providers ».
- Mettre à jour le README (section Key features) et le CHANGELOG.

## 6. Ordre d'implémentation suggéré

1. Exploration du code : localiser le registre de providers, le pipeline d'embeddings, le log MCP existant, l'infrastructure CLI. Produire un court compte rendu (fichier `docs/journal-usage-ia-reperage.md`) **avant** de coder, listant les points d'insertion retenus.
2. Schéma SQLite + module de journalisation (main process) + hook providers.
3. Agrégation de sessions + `cliodeck journal today`.
4. Annotation interactive CLI.
5. Export Markdown/JSONL/CSV.
6. UI minimale renderer.
7. Docs, ADR, tests, CHANGELOG.

Chaque étape = commits séparés référencés au plan, dans l'esprit du workflow du fusion-branch.

## 7. Points tranchés (ne pas rouvrir)

- **Découpage en sessions** : heuristique simple en v1 — fenêtre d'inactivité de 30 minutes **ou** changement de workspace ferme la session ; les changements de mode ne découpent pas. Ce découpage est purement cosmétique (lisibilité du résumé quotidien), non contraignant, et sera ajusté empiriquement après quelques semaines d'usage. Rendre la fenêtre d'inactivité configurable (paramètre, défaut 30 min), sans UI dédiée en v1.
- **Rattachement sessions→décisions : entièrement manuel.** Aucune heuristique de rattachement automatique. L'utilisateur associe lui-même, lors de l'annotation, les sessions du jour à ses décisions d'usage (sélection dans une liste). Une session non rattachée reste visible comme telle — c'est la matière de la section « violations » de l'export.
- **Brouillons de rejet (amendement Phase 4 CM6) : jamais promus automatiquement.** Les annotations de rejet échantillonnées dans l'éditeur (« pourquoi ? », 1 rejet sur 5, jamais deux fois de suite — arbitrage 1 du plan CM6) sont stockées dans `decision_drafts` comme brouillons. La sémantique de `usage_decisions` (tâche/alternative/justification/verdict) reste intacte ; la promotion d'un brouillon en décision est un geste explicite de l'utilisateur (UI hors périmètre Phase 4).
