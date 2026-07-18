# Unification du chat — état des lieux (2026-07-18)

> Investigation menée en lecture seule sur `main` en vue d'une décision.
> Toutes les affirmations sont référencées fichier:ligne (état du code au
> commit `0fb699d`).

## 0. La découverte qui change le problème

**Il n'y a plus deux moteurs de chat.** La prémisse « `chat-engine.ts` =
legacy encore actif » (CLAUDE.md §2) est périmée : la déduplication
moteur/IPC/store a eu lieu à l'étape 4b de la fusion, et le vieux
`chat-service.ts` a été supprimé. Ce qui reste dupliqué est **la coquille
UI** — l'étape 5 du plan de fusion, « deprecated until step 5 »
(`ChatInterface.tsx:29-30`), jamais exécutée.

État réel :

- **Un seul moteur** : `chat-engine.ts` est le cœur *extrait* de
  fusion-chat-service (en-tête `chat-engine.ts:1-21`), sans dépendance
  Electron — boucle d'agent tool-use (maxTurns 6, `:223`), injection
  retrieval par hook fail-soft (`:254-294`), compaction par itération
  (`:379-396`). Unique appelant : `fusion-chat-service.ts:479`.
- **Une seule famille IPC** : `fusion:chat:start/cancel` + événements
  chunk/status/context/explanation/tool-call (`fusion-handlers.ts:289-352`,
  préload `index.ts:889-996`). Les handlers legacy `chat:send`/`chat:onStream`
  n'existent plus (grep : zéro occurrence).
- **Un seul store** : `useChatStore` (« Unified chat store (fusion step
  4b) », `chatStore.ts:2`) — messages non persistés.
- **Un seul câblage de réglages** : `useChatSettingsProjection`, appelé par
  les deux surfaces (`ChatInterface.tsx:46`, `BrainstormChat.tsx:88`).
- **Deux coquilles** sur ce moteur unique, via le même hook
  `useBrainstormChat` :
  - `ChatInterface` (« AI Assistant ») — panneau droit des modes
    **explore/write/export** (`MainLayout.tsx:304`, défauts
    `workspaceModeStore.ts:33-38`), masqué en brainstorm (`!isBrainstorm`) ;
  - `BrainstormChat` — centre du mode **brainstorm** uniquement
    (`BrainstormPanel.tsx:193-196`).

Conséquence troublante pour l'utilisateur : **c'est la même conversation**
(même store) affichée dans deux habillages différents selon le mode.

## 1. Le différentiel entre les deux coquilles

| Capacité | ChatInterface (droite) | BrainstormChat (centre) |
|---|---|---|
| RAG multi-sources, filtres, modes IA, compaction, explanation | oui (identique — même pipeline) | oui |
| Rendu des sources | `SourceCard` via `RAGMessageExtras` | `SourcePopover` (traçabilité clic-source) |
| **Consentement cloud (ADR 0005)** | **NON — aucun garde-fou** (`ChatInterface.tsx:112-122` appelle `send()` directement) | oui (`BrainstormChat.tsx:126-149` + CloudConsentDialog) |
| Badges tool-use MCP | non (pipeline oui, UI non) | oui |
| NER inline | non | oui (toggle, `:321-330`) |
| Envoi vers l'éditeur (→ propositions Phase 4) | non | oui (`sendToWrite`, `:90-107`) |
| Starter prompts | non | oui (`:151-155`) |
| ModeSelector | toujours visible (`:179`) | seulement si settings ouverts (`:331`) |
| ContextGraph adjacent | non | oui (lit le store partagé) |

Ni l'une ni l'autre n'offre : historique UI persistant (les messages
meurent au relancement ; seul le journal de recherche persiste),
régénération d'une réponse.

## 2. Constats critiques (indépendants de la décision)

1. **Trou de consentement cloud** : le garde ADR 0005 n'existe que dans la
   coquille Brainstorm, côté renderer. Le même prompt envoyé depuis le
   panneau AI Assistant (modes explore/write/export) part vers un provider
   cloud **sans dialogue de consentement**. Aucune vérification côté main
   (`grep consent fusion-chat-service|fusion-handlers` : vide). À corriger
   quel que soit le choix d'UI — idéalement dans le chemin partagé (hook ou
   main), pas dans une coquille.
2. **Migration localStorage morte** : `runLegacyLocalStorageMigration`
   écrit `cliodeck-chat-v2` que rien ne relit (`chatStore.ts:161-210`).
3. `hitsToUnifiedSources` (`fusion-chat-service.ts:68-70`) : préparé pour le
   « future merged chat renderer » — l'étape 5 était anticipée côté main.
4. Champ `model` ambigu dans le journal de recherche : reçoit la chaîne
   composite `name (model)` (`fusion-chat-service.ts:555,585`).
5. **Risque d'unification** : les deux coquilles appellent chacune
   `useBrainstormChat()` qui pose ses listeners (`useBrainstormChat.ts:109-182`).
   Jamais montées simultanément aujourd'hui ; toute unification qui les
   ferait coexister provoquerait un double-dispatch dans le store partagé.
6. CLAUDE.md §2 (« chat-engine.ts — legacy RAG chat, still active ») est
   trompeur et à corriger.

## 3. Impact de suppression de `ChatInterface` (option coquille unique)

Fichiers morts : `ChatInterface.tsx/.css`, `RAGMessageExtras.tsx`,
`SourceCard.tsx/.css` + leurs suites de tests (3). Aucun canal IPC
orphelin. i18n : sous-ensemble des clés `chat.*` (aiAssistant,
readyState…). `RightPanelView` : la valeur `'chat'` doit être re-cablée
vers la nouvelle coquille (migration du store persisté
`cliodeck-workspace-mode`, pattern existant `workspaceModeStore.ts:64-82`).
**La seule vraie perte fonctionnelle à compenser : un chat accessible sans
quitter les modes explore/write/export** — poser une question RAG à côté de
l'éditeur est un usage central.

## 4. Options de décision

**A. Coquille unique (recommandée)** — finir l'étape 5 de la fusion :
`BrainstormChat` (renommé en composant neutre, ex. `AssistantChat`) devient
la seule coquille, montée au centre en brainstorm ET dans le panneau droit
des trois autres modes (variante compacte : starters/NER/ContextGraph
paramétrables). On gagne : consentement partout, une seule traçabilité de
sources (SourcePopover), badges MCP partout, `sendToWrite` → propositions
**depuis le mode write** (le cas d'usage le plus naturel !), une UX
cohérente. Points de vigilance : double-listeners (§2.5), migration
`RightPanelView`, densité du panneau droit.

**B. Deux coquilles assumées, deltas corrigés** — garder un assistant
« léger » à droite et le chat riche au centre, mais : garde de consentement
déplacée dans le chemin partagé, rendu de sources unifié, chip de mode
harmonisé. Moins de churn, mais la dette UX « même conversation, deux
visages » demeure et chaque évolution future se paie deux fois.

Dans les deux cas : corriger le consentement (§2.1) immédiatement, purger la
migration morte (§2.2), mettre CLAUDE.md à jour (§2.6).
