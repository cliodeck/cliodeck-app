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
| UI | panneau Journal | section Settings « Journal d'usage IA » |

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
CLI et recipes. Best-effort : si le journal n'est pas initialisé, le décorateur est
inerte ; **une panne du journal ne fait jamais échouer un appel LLM**.

### Événements capturés

Pour chaque appel : horodatage, durée, type (`completion` | `embedding` |
`embedding_batch`), provider et modèle, exécution locale ou cloud, tokens
prompt/réponse (réels quand l'API les fournit — Ollama, Anthropic, Gemini — sinon
estimés à ~4 caractères/token, `tokens_estimated: true`), contexte applicatif (mode,
workspace, corpus, recipe), identifiant de session, statut.

Cas particuliers :

- **Indexations en masse** — agrégées en un seul `embedding_batch` (compte de chunks +
  total de tokens) par run, via un scope ouvert aux trois frontières d'indexation (PDF,
  Obsidian, Tropy), plutôt qu'un événement par chunk.
- **Mode applicatif** — le mode (`explore|brainstorm|write|export`) vit dans le renderer ;
  il est miroité vers le main via `usage:set-mode`. Les contextes backend posent leur
  littéral (`recipe`, `cli`, `mcp`).

### Sessions

Découpage cosmétique (lisibilité du résumé), non contraignant : une session se ferme
après une **fenêtre d'inactivité de 30 min** (configurable) **ou** un changement de
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
journal_meta(key, value)                     -- schema_version
```

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
- Repérage des points d'insertion : [`docs/journal-usage-ia-reperage.md`](journal-usage-ia-reperage.md)
