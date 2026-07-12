# ADR 0007 — Journal d'usage IA : base séparée + hook au registre de providers

Status: accepted — 2026-07-12
Context: fonctionnalité « journal d'usage IA » réflexif (voir
`docs/INSTRUCTIONS_journal-usage-ia.md`)

## Contexte

ClioDeck doit intégrer un journal d'usage de l'inférence IA à visée réflexive et
éthique — un instrument de documentation de la pratique, destiné à être partiellement
publié, distinct de toute télémétrie. Deux décisions de structure conditionnent le reste.

**Où capturer ?** Les appels d'inférence partent d'une dizaine de services et handlers.
Instrumenter chacun serait fragile et à re-faire pour tout futur service. Mais tous
obtiennent leur provider via `ProviderRegistry.getLLM()` / `getEmbedding()`, et aucun
service ne fabrique un provider hors du registre — y compris les chemins CLI et recipes.

**Où stocker ?** Le reste du workspace converge vers `brain.db` consolidé (ADR 0001).
Le journal, lui, doit pouvoir être copié, archivé et publié indépendamment de l'outil
qu'il documente.

Contraintes tranchées en amont : aucune fusion avec le journal de recherche existant
(`history_*`, qui journalise les prompts) ; aucun prompt journalisé ici ; une panne du
journal ne doit jamais faire échouer un appel LLM.

## Décision

1. **Hook au niveau du registre.** Un décorateur (`instrument.ts`) enveloppe les
   providers retournés par `getLLM()` / `getEmbedding()`. Il ré-émet les chunks de
   `chat()`, lit l'usage sur le chunk terminal (fallback estimation chars/4),
   ré-implémente `complete()` en consommant le `chat()` interne (les providers y jettent
   l'usage), et compte les `embed()`. Le contexte applicatif (mode, workspace, corpus,
   recipe) transite par un `AsyncLocalStorage` posé aux points d'émission ; un scope de
   batch agrège les indexations en masse en un seul `embedding_batch`.

2. **Base SQLite séparée `.cliodeck/journal.db`**, distincte de `brain.db`, avec ses
   propres tables (`inference_events`, `usage_decisions`, `session_decision`,
   `journal_meta`), son espace IPC (`usage:*`), son store renderer et son CLI.

3. **Écritures non bloquantes** (buffer + flush débouncé), toute erreur avalée.

## Conséquences

- **Un seul point d'instrumentation** couvre complétions (streaming et non), embeddings,
  CLI et recipes. Ajouter un service ne demande aucun travail de journalisation.
- **Le journal est un artefact autonome** : un fichier `journal.db` copiable/publiable
  sans embarquer l'index ni l'historique de recherche.
- **Séparation stricte** avec le journal de recherche : pas de confusion possible entre
  « ce que l'historien a fait » et « la comptabilité réflexive de ses usages IA ».

### Compromis (honnêtes)

- **Le décorateur ré-implémente `complete()`.** Il consomme le `chat()` interne du
  provider au lieu d'appeler `provider.complete()`, pour récupérer les tokens que tous
  les providers jettent. C'est fidèle aujourd'hui (les 5 providers implémentent
  `complete()` exactement ainsi, Mistral héritant d'OpenAI-compatible) — mais un futur
  provider dont le `complete()` divergerait du `chat()` produirait une sortie différente.
  À revérifier à chaque nouveau provider.
- **Tokens souvent estimés.** Les embeddings n'exposent jamais d'usage ; OpenAI-compatible
  et Mistral n'activent pas `stream_options.include_usage`. Ces cas sont marqués
  `tokens_estimated: true` (chars/4). Activer `include_usage` donnerait des chiffres réels
  mais toucherait le contrat provider — repoussé.
- **Deux bases à gérer.** `journal.db` vit à côté de `brain.db` ; c'est un fichier de plus
  à sauvegarder/migrer, assumé pour l'indépendance de publication.
- **Le mode applicatif est miroité, pas source de vérité.** Il vit dans le renderer
  (localStorage) et est poussé vers le main via `usage:set-mode` ; entre le démarrage et
  le premier miroir, des événements peuvent être taggés `unknown`.
- **Découpage en sessions cosmétique.** Fenêtre d'inactivité de 30 min ou changement de
  workspace ; heuristique volontairement simple, à ajuster empiriquement.

## Références

- `docs/journal-usage-ia.md` — modèle deux-couches, schéma, philosophie.
- `docs/journal-usage-ia-reperage.md` — repérage des points d'insertion.
- ADR 0001 — consolidation `brain.db` (dont le journal se démarque volontairement).
- ADR 0004 — abstraction providers (contrat que le décorateur enveloppe sans modifier).
