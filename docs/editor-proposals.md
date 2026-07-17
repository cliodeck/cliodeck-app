# Contrat propositionnel de l'éditeur

> Phase 4 du plan CM6 ([`PLAN_migration-editeur-cm6.md`](PLAN_migration-editeur-cm6.md)).
> Code : `src/editor/proposals/` (contrat + UI), `src/editor/cm/change-origin.ts` (traçage d'origine).

**AUCUNE FONCTIONNALITÉ IA D'ÉCRITURE NE CONTOURNE CETTE API.** Toute
intervention de l'IA dans le document passe par une proposition atomique
adjudicable — accepter / rejeter / modifier — et chaque adjudication est
journalisée. C'est un verrou d'architecture, implémenté avant toute
fonctionnalité IA d'écriture, et opposable en revue de PR.

## 1. Origine des transactions (4a)

Toute transaction CM6 qui modifie le document porte une origine
(`changeOrigin`, annotation) :

| Valeur | Sens |
|---|---|
| `human-input` | frappe, suppression, déplacement, undo/redo (dérivés des userEvents) |
| `paste` | collage, drop |
| `ai-proposal-accepted` | application d'une proposition acceptée |
| `ai-proposal-modified` | application d'une proposition modifiée |
| `programmatic` | toute édition médiée par l'app : insertion de citation/IPC, formatage toolbar, toggle checkbox, renumérotation, popup de note… |

La frappe est dérivée automatiquement ; **toute API programmatique DOIT
poser son annotation** (les méthodes de la façade l'appliquent par défaut).
En dev, une garde (`changeOriginGuard`) signale toute transaction sans
origine résoluble.

Les marqueurs HTML `<!-- cliodeck-gen … -->` sont rendus obsolètes par ce
traçage : l'éditeur CM6 n'en produit plus (le contenu IA devient une
proposition) ; les documents existants qui en contiennent sont tolérés tels
quels, et les éditeurs hérités Monaco/Milkdown (gelés jusqu'à la Phase 5)
continuent de les produire à l'identique, reconstruits côté renderer.

## 2. La proposition (4b)

```ts
interface Proposal {
  id: string;
  range: { from: number; to: number }; // from === to : insertion
  category: string;                    // 'brainstorm-draft', 'ai-insert', 'test'…
  original: string;                    // texte courant du range ('' si insertion)
  proposed: string;
  source: { model: string; task: string };
  createdAt: string;                   // ISO 8601 → latence d'adjudication
}
```

Cycle de vie :

- **Affichage** : original barré (teinte danger) + proposé en encart (teinte
  accent) avec ✓ / ✗ / ✎. Insertion pure : pas de barré.
- **Accepter** (✓ ou Tab au curseur) : le range est remplacé par `proposed`,
  transaction annotée `ai-proposal-accepted`.
- **Modifier** (✎) : édition du texte proposé en place, application annotée
  `ai-proposal-modified`, l'événement porte `final`.
- **Rejeter** (✗ ou Échap au curseur) : retrait sans édition. **Annotation de
  rejet échantillonnée** (arbitrage 1) : 1 rejet sur 5 — jamais deux de
  suite — ouvre un champ « pourquoi ? » optionnel et non bloquant (Entrée
  envoie, Échap/clic ailleurs passe).
- **Remapping** : les ranges suivent les éditions du document
  (`changes.mapPos`). Toute édition qui **touche** un range en attente —
  humaine, collage, ou programmatique (ex. renumérotation) — retire la
  proposition avec un événement `invalidated` : un range dont le contenu a
  changé n'est plus adjudicable tel quel.
- **Expiration** (arbitrage 5) : à la fermeture du document (destruction de
  la vue), les propositions en attente émettent `expired` — pas de
  persistance, pas de restauration.

Entrées dans le contrat aujourd'hui :

- drafts Brainstorm (`insertDraftAtCursor`, catégorie `brainstorm-draft`) ;
- contenu IA du canal IPC `editor:insert-text` (`metadata.modeId` présent,
  catégorie `ai-insert`) ;
- hook de dev `window.__cliodeckProposals.inject({ proposed: '…', … })`,
  exposé par l'éditeur CM6 — injection d'une proposition factice sans aucun
  modèle (critère d'acceptation de la phase, vérification pilotée).

## 3. Journalisation (4c)

Chaque adjudication émet un événement, envoyé au main via
`window.electron.proposals.recordAdjudication` (IPC
`proposals:adjudication`), qui le route vers **deux journaux, deux
granularités, aucun couplage de schéma** :

```ts
interface ProposalAdjudicationEvent {
  proposalId: string;
  decision: 'accepted' | 'rejected' | 'modified' | 'invalidated' | 'expired';
  category: string;
  model: string;
  task: string;
  latencyMs: number;
  at: string;               // ISO 8601
  original?: string;        // ┐ contenus : JOURNAL DE RECHERCHE UNIQUEMENT
  proposed?: string;        // │ (brain.db, history_*) — jamais écrits au
  final?: string;           // │ journal d'usage IA
  rejectionNote?: string;   // ┘ → brouillon de la couche décisionnelle
}
```

- **Journal de recherche** (`brain.db`) : l'événement complet, contenus inclus.
- **Journal d'usage IA** (`journal.db`) : `{decision, category, model, task,
  at}` **sans aucun contenu textuel** ; les agrégats (taux d'acceptation par
  catégorie/modèle/période) sont calculés côté journal.
- **Couche décisionnelle manuelle** : les `rejectionNote` échantillonnées
  sont proposées comme brouillons d'entrées, jamais insérées automatiquement.

Côté renderer, l'émission est **défensive**
(`src/renderer/src/components/Editor/proposals-ipc.ts`) : l'absence du
binding ne bloque jamais l'adjudication elle-même.

## 4. Ce que ça interdit concrètement

- Écrire du texte généré dans le document via la façade, le store, ou une
  transaction directe depuis une fonctionnalité IA : **non** — `propose()`.
- Ajouter un nouveau canal IPC qui insère du contenu IA sans passer par une
  proposition : **non**.
- Émettre des contenus (extraits, prompts) vers le journal d'usage IA :
  **non** — c'est le rôle du journal de recherche.
