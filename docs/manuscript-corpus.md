# Le manuscrit comme corpus RAG

> Item 25 des audits ([`audits-2026-07-19.md`](audits-2026-07-19.md)).
> Quatrième corpus, à côté des PDF de bibliographie, des archives Tropy et
> du vault Obsidian.

## Le manque

`RetrievalService` ne connaissait que des sources **externes**. Le texte que
l'historien écrit lui-même n'était regardé par personne : l'assistant ne
pouvait pas répondre à « qu'ai-je déjà écrit sur Danzig ? », et le panneau
affichait « No indexed documents » devant un auteur qui avait son manuscrit
sous les yeux. C'est dans un livre que le manque est le plus criant —
passé quelques chapitres, on ne garde plus tout en tête.

## Ce qui est en place

| Pièce | Rôle |
|---|---|
| `backend/core/rag/manuscript-chunker.ts` | Découpage pur d'un chapitre en chunks |
| `backend/core/vector-store/ManuscriptStore.ts` | Store SQLite + FTS5, tables `manuscript_*` dans `brain.db` |
| `src/main/services/manuscript-index-service.ts` | Indexation incrémentale, best-effort |
| `src/main/ipc/handlers/manuscript-handlers.ts` | `manuscript:index`, `manuscript:stats` |
| `RetrievalService` | Quatrième corpus, opt-in `includeManuscript` |

## Décisions de conception

**Le disque fait foi, l'indexation se déclenche après sauvegarde.**
L'alternative — lire l'éditeur vivant — ferait dépendre l'index d'un état
renderer transitoire et rendrait l'incrémental indécidable : quelle
empreinte pour un texte non encore écrit ? En indexant ce qui est
enregistré, l'index décrit exactement ce que l'auteur a validé, et le
service reste utilisable hors interface (CLI, tests).

**Incrémental par empreinte de contenu, chapitre par chapitre.** Un
manuscrit de 400 000 mots ne se réembarque pas à chaque sauvegarde : seul
un chapitre dont le SHA-256 a changé est réindexé. Un test compte les
appels au fournisseur pour le prouver — la deuxième passe sur un texte
inchangé en fait **zéro**.

**Découpage par l'arbre, texte épuré avant embedding.** `parseOutline`
donne les vraies sections (un `#` dans un bloc de code n'en ouvre pas une),
et `extractProseText` retire la syntaxe : un embedding de `[@lester1932]`
n'apprend rien. Le **corps** d'une note de bas de page, lui, est du texte
de l'auteur et reste indexé. Une section réduite à son seul titre est
ignorée : elle produirait un extrait sans contenu.

**Best-effort, jamais bloquant.** Un fournisseur d'embeddings absent
(Ollama éteint) laisse l'index en l'état et n'interrompt rien. Aucune
erreur d'indexation ne remonte comme une erreur d'application.

**Un chapitre détaché sort de l'index.** Sinon l'assistant citerait un
texte que l'auteur a retiré de son manuscrit.

**Aucune clé nouvelle dans `workspace/layout.ts`** (CLAUDE.md §4) : les
tables vivent dans le `brain.db` déjà existant, comme celles du vault.

## Séparation des corpus — et sa limite actuelle

Un extrait du manuscrit porte `sourceType: 'manuscript'` et une source
typée (`kind: 'manuscript-chapter'`, chemin, titre de section, ligne).
L'auteur doit pouvoir savoir qu'il **se cite lui-même** plutôt qu'une
archive : c'est une exigence intellectuelle, pas une finition.

**Limite : les extraits du manuscrit sortent par un canal séparé**
(`RetrievalSearchResult.manuscriptHits`) et non dans `hits`. Raison :
`hitsToSources` (`fusion-chat-service.ts`) mappe `sourceType` sur un union
plus étroit (`'primary' | 'secondary' | 'vault'`) et attribue un `kind`
parmi `'archive' | 'bibliographie' | 'note'`. Verser le manuscrit dans
`hits` sans élargir ces types le ferait étiqueter « bibliographie » —
exactement la confusion que l'on veut éviter.

Pour l'intégrer au contexte de l'assistant, il reste donc à :

1. élargir `BrainstormSource` (déclaré dans `fusion-chat-service.ts`, et
   reflété dans `chatStore.ts`, `preload/index.ts`, `chat-source.ts`) avec
   `sourceType: 'manuscript'` et un `kind: 'manuscrit'` ;
2. ajouter la branche correspondante dans `hitsToSources` ;
3. passer `includeManuscript: true` depuis le renderer et fusionner
   `manuscriptHits` dans le contexte.

Tant que ce n'est pas fait, aucun extrait de manuscrit ne peut atteindre
`hitsToSources` : `includeManuscript` n'est positionné nulle part.

## Reste à faire

- **Déclenchement automatique après sauvegarde** : le service et ses canaux
  IPC existent, mais rien n'appelle encore `manuscript:index` à l'écriture
  d'un fichier. Le point d'accroche naturel est le handler
  `editor:save-file`.
- **Exposition UI** : état de l'index, bouton de réindexation, et le
  réglage `rag.indexManuscript` (déjà lu par le service) dans les
  préférences.
- **Coût réel non mesuré** : l'incrémental est vérifié par comptage
  d'appels, mais la durée d'une indexation complète avec un vrai modèle
  d'embedding sur un manuscrit long reste à mesurer.
- Changer de modèle d'embedding invalide l'index (dimensions et espaces
  différents) : `reindexAll()` existe pour ça, aucun déclencheur ne
  l'appelle encore.
