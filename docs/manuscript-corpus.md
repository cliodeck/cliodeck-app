# Le manuscrit comme corpus RAG

> Item 25 des audits ([`archive/audits-2026-07-19.md`](archive/audits-2026-07-19.md)).
> Quatrième corpus, à côté des PDF de bibliographie, des archives Tropy et
> du vault Obsidian. **Document vivant** — état au 2026-07-25.

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
| `src/main/ipc/handlers/editor-handlers.ts` | Déclenche l'indexation **après sauvegarde** (best-effort, si le corpus est activé) |
| `RetrievalService` | Quatrième corpus, opt-in `includeManuscript` |
| `fusion-chat-service.ts` | Pose `includeManuscript` et verse les extraits dans les sources affichées (`manuscriptHitsToSources`) |

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

## Séparation des corpus

Un extrait du manuscrit porte `sourceType: 'manuscript'` et, au niveau
`RetrievalService`, une source typée (`kind: 'manuscript-chapter'`, chemin,
titre de section, ligne). L'auteur doit pouvoir savoir qu'il **se cite
lui-même** plutôt qu'une archive : c'est une exigence intellectuelle, pas une
finition.

Les extraits du manuscrit sortent par un **canal séparé**
(`RetrievalSearchResult.manuscriptHits`) et non dans `hits`. Ce n'est plus
une limite mais le mécanisme même de la séparation : `manuscriptHitsToSources`
les convertit en sources affichables en leur donnant le `kind: 'manuscrit'`
côté interface, et un **bloc de contexte distinct** les présente à
l'assistant, séparé de celui des sources externes. Verser le manuscrit dans
`hits` l'aurait fait étiqueter « bibliographie » — exactement la confusion que
l'on veut éviter.

L'union `BrainstormSource` (`fusion-chat-service.ts`, reflétée dans
`chatStore.ts`, `preload/index.ts`, `chat-source.ts`) porte donc
`sourceType: 'primary' | 'secondary' | 'vault' | 'manuscript'` et
`kind: 'archive' | 'bibliographie' | 'note' | 'manuscrit'`.

## Reste à faire

- **Exposition UI** : état de l'index, bouton de réindexation, et le
  réglage `rag.indexManuscript` (déjà lu par le service, défaut activé)
  dans les préférences. L'utilisateur n'a aujourd'hui aucun moyen de voir
  ni de piloter ce corpus depuis l'interface.
- **Coût réel non mesuré** : l'incrémental est vérifié par comptage
  d'appels, mais la durée d'une indexation complète avec un vrai modèle
  d'embedding sur un manuscrit long reste à mesurer.
- Changer de modèle d'embedding invalide l'index (dimensions et espaces
  différents) : `reindexAll()` existe pour ça, aucun déclencheur ne
  l'appelle encore.

**Livré depuis la rédaction de cette note** : le déclenchement automatique
après sauvegarde (`editor-handlers.ts`, best-effort et silencieux) et le
câblage complet jusqu'à l'assistant (`includeManuscript` posé par
`fusion-chat-service` quand le corpus est activé).
