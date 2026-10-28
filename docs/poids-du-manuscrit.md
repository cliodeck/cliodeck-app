# Le poids du manuscrit dans les réponses de l'assistant

> Analyse du 2026-10-28, à partir d'un constat de l'auteur en mode
> Brainstorm : le texte en cours d'écriture (article, diapositives,
> chapitres) prend trop de place dans les réponses. Complète
> [`manuscript-corpus.md`](manuscript-corpus.md), qui décrit le corpus
> lui-même. **Document vivant** : la section « Décisions » est mise à jour
> à mesure que les paliers sont livrés.

## Le constat

Le manuscrit a été rattaché à l'assistant en rc.4 (commit `177c9a3`) pour
qu'une question comme « qu'ai-je déjà écrit sur Danzig ? » obtienne une
réponse. Le remède a été dimensionné pour un corpus qui n'arrivait
*jamais* ; il n'a jamais été dimensionné pour un corpus qui arrive
*toujours*. En Brainstorm, où l'on cherche précisément à sortir de son
propre texte, l'assistant renvoie à l'auteur sa propre synthèse — un écho,
pas une ouverture.

Tout ce qui suit a été vérifié dans le code, pas supposé. Aucune mesure de
cosinus par corpus n'existe dans le dépôt : la « similarité de soi à soi »
(le manuscrit est écrit dans la langue et le vocabulaire de la question)
reste une hypothèse ; les garanties structurelles ci-dessous, elles, sont
des faits.

## Ce qui se passe aujourd'hui

### Le manuscrit est toujours interrogé

Un seul point d'inclusion, dans la fermeture `retriever` de
`fusion-chat-service.ts` : `includeManuscript = manuscriptIndexService.isEnabled()`.
Il ne regarde ni le mode d'espace de travail (Explorer / Brainstorm /
Écrire), ni le mode de chat, ni les trois cases « Bibliographie / Sources
primaires / Notes », ni une recherche restreinte à des documents choisis.
L'indication du panneau « Recherche dans : Bibliographie, Sources
primaires, Notes » est donc fausse. Le seul interrupteur — Réglages →
expert → « Indexer le manuscrit » — coupe aussi l'indexation, donc le cas
d'usage « qu'ai-je déjà écrit ? ».

### Le quota est un plancher sans plafond

`retrieval-quota.ts` réserve 30 % des places dès qu'un extrait du manuscrit
franchit le seuil, puis laisse **le reste du manuscrit concourir** pour les
autres places. Sa docstring (« il n'en prend jamais plus que son quota »)
dit le contraire du code et du test « laisse le manuscrit prendre plus que
son quota s'il gagne au mérite ». Le message du commit d'origine est
explicite : « un plancher, pas un plafond ».

| Situation | Part du manuscrit dans les places |
|---|---|
| Espace Brainstorm, mode de chat par défaut, topK 10 | au moins 3 sur 10, sans borne supérieure |
| Mode de chat « Brainstorming », topK 20 | au moins 6 sur 20, sans borne supérieure |
| Curseur des réglages à topK 1 | 1 sur 1 |
| Sources faibles (repli cross-langue) contre manuscrit confiant | 10 sur 10 |

La dernière ligne est le pire cas et il est courant : la bibliographie
garde trois extraits de repli sous le seuil (`CROSS_LANGUAGE_FALLBACK`), le
manuscrit n'en garde aucun mais franchit le seuil facilement ; le tri
commun donne tout au manuscrit, puis `formatContextAsSystemPrompt` annonce
« Aucun extrait des sources interrogées » et le modèle brainstorme sur le
seul texte de l'auteur.

### Le seuil est réglé pour un autre corpus

Le 0,12 global a été abaissé pour des questions en français contre des PDF
en anglais (`backend/types/config.ts`). Le manuscrit est dans la langue de
la question, noté par un cosinus **exhaustif et exact** sur tous ses
extraits (`ManuscriptStore.search`) : il franchit 0,12 par construction à
presque chaque tour, et la réserve est consommée à chaque tour. L'ADR 0001
(amendement du 2026-09-14) promettait « un seuil par corpus, assumé » ; il
n'existe pas. Nuance relevée à la vérification : le contrat de score joue
plutôt *contre* le manuscrit (sa branche lexicale FTS5 est un ET de tous
les mots de la question, là où BM25 est un OU). Le poids vient des places
garanties, pas de scores gonflés.

### L'espace Brainstorm n'est pas le mode « Brainstorming »

L'espace Brainstorm fait tourner le mode de chat `default-assistant`
(topK 10, règle « réponds UNIQUEMENT à partir des sources »). Le mode
intégré « Brainstorming » (prompt divergent, topK 20) est un opt-in caché
derrière le bouton de réglages du chat ; son topK ne survit pas à un
relancement (`modeStore` ne réapplique pas les surcharges,
`ragQueryStore.resetToDefaults` réécrit topK) ; et quatre de ses six
`ragOverrides` — `similarityThreshold`, `sourceType`, `useGraphContext`,
`summaryGeneration` — n'atteignent rien. Le mode d'espace n'est jamais
transmis à main avec le tour.

### Le format du prompt contredit sa prose

- Les extraits du manuscrit portent le même libellé `EXTRAIT :` que la
  règle des sources désigne comme seule matière légitime (« champs TITRE,
  AUTEUR et EXTRAIT »), et leur numérotation `[M n]` continue celle des
  sources.
- L'en-tête du bloc est fait de trois négations et d'une permission,
  sans tâche. Un petit modèle lit « voici d'autres documents, avec des
  réserves ».
- `chat-engine.ts` insère le bloc de contexte **au-dessus** du prompt de
  mode, à l'inverse de ce que dit son propre commentaire : le modèle lit
  10 à 20 k caractères d'extraits avant de connaître son rôle, et le
  manuscrit est la dernière matière lue avant la question.
- Le prompt « Brainstorming » dit « explorer les documents fournis » et
  « indique les sources qui l'inspirent » sans jamais nommer le
  manuscrit : les extraits `[M]` sont, de son point de vue, des documents
  fournis.
- La compression du contexte s'applique aux seules sources externes ; le
  bloc manuscrit part entier.
- D'un tour à l'autre, une réponse qui a paraphrasé le manuscrit reste
  dans la fenêtre (quatre tours gardés tels quels par le compacteur)
  pendant qu'un nouveau bloc manuscrit arrive : l'écho se cumule à
  l'échelle de la session.

### Les citations sont indexées comme la prose de l'auteur

`extractProseText` retire la syntaxe mais garde le contenu des blocs de
citation (`>`) et le corps des notes de bas de page. Un passage cité d'un
PDF revient donc comme source `[N]` *et* comme manuscrit `[M]`, sans
dédoublonnage entre corpus (celui du compresseur est intra-document). Les
notes de référence rédigées à la main renvoient en outre les noms d'auteurs
et les titres de la bibliographie dans le corpus manuscrit.

### L'utilisateur ne voit rien de tout cela

L'en-tête de la liste compte les extraits du manuscrit sous « Sources
(N) » ; le badge affiche le mot brut `manuscrit`, non traduit, avec la
même teinte que la bibliographie ; le panneau « Comment cette réponse a
été générée » ne compte que les sources externes ; les `outcomes` par
corpus sont calculés à chaque tour puis jetés.

## Ce qui a été écarté, et pourquoi

- **Un seuil relatif à la distribution du manuscrit (μ + k·σ).** La part
  admise dépend du nombre d'extraits, pas de la pertinence : inerte sur un
  livre (des dizaines d'extraits passent), muet sur un article (aucun). Et
  dépendant du modèle d'embedding.
- **Raccourcir les extraits.** Le volume par extrait est déjà comparable
  entre corpus (1 500 caractères plafonnés contre 1 200 à 1 500 pour un
  PDF) ; c'est le nombre et la place qui comptent.
- **Un seuil absolu plus haut pour le manuscrit.** Le transport (un seuil
  par corpus) vaut la peine ; la valeur, non calibrée, recréerait la panne
  d'avant rc.4 sur un autre modèle d'embedding. À calibrer après mesure.
- **Un résumé « déjà traité » par section à la place des extraits.** Casse
  la correspondance prompt ↔ liste des sources, et réduit un `slides.md`
  sans titres à une seule ligne. Différé, derrière une politique
  explicite.

## Décisions (2026-10-28)

Tranchées par l'auteur du projet :

1. **Dans l'espace Brainstorm, le manuscrit est absent par défaut.** Il
   revient si l'utilisateur coche « Mon manuscrit » ou pose une question
   de rappel (« qu'ai-je déjà écrit sur… »). Le signalement des répétitions
   en brainstorm est sacrifié sciemment au profit de l'ouverture.
2. **L'espace Brainstorm propose le mode de chat « Brainstorming »** par
   une bannière refermable dont le refus est mémorisé. Les deux magasins
   restent indépendants.
3. **Le réembarquement complet déclenché par le changement de découpage
   (palier 3) est automatique**, avec un compte rendu visible dans la
   section « Corpus manuscrit » des réglages.
4. **Le script de mesure est livré mais pas exécuté** sur un projet réel
   dans ce cycle.

Constantes retenues, faute de mesure : une **bande** de 20 % des places
(plancher et plafond), au moins une place quand le manuscrit a quelque
chose à dire, zéro quand topK vaut 1 ; une question de rappel porte la
bande à `min(topK, 6)` ; la portée « manuscrit seul » lui donne tout.

## Les trois paliers

### Palier 1 — structurel, indépendant du modèle

Ce palier tient sur un modèle local de 8 milliards de paramètres parce
qu'il change des comptes et des places, pas des consignes.

- **Mesurer d'abord.** `scripts/manuscript-share.mjs` lit
  `history_chat_messages.sources_json` dans `brain.db` — qui porte déjà,
  par extrait, le corpus et la similarité, avec `mode_id` — et donne la
  part du manuscrit par réponse et par mode, plus un histogramme de
  similarité par corpus. À lancer par `scripts/electron-node.mjs` (ABI
  Electron de better-sqlite3).
- **Le quota devient une bande.** Plafond *dans* le topK, pas en plus :
  le curseur garde son sens et le prompt ne grossit pas. Les tests « gagne
  au mérite » et « ne dépasse jamais le quota » sont réécrits ; celui qui
  garde le manuscrit atteignable quand la bibliographie sature reste le
  garde-fou de rc.4.
- **Une portée restreinte exclut le manuscrit.** Documents choisis,
  collection, ou notes seules : l'utilisateur a dit de quoi il parle. Le
  paragraphe « PÉRIMÈTRE » cesse d'être une rustine.
- **Le prompt dit ce que son format dit.** Libellé `PASSAGE :` distinct,
  numérotation `[M1]…` indépendante, séparateur visible, une phrase
  positive qui donne la tâche du bloc, une clause dans la règle des sources
  seulement quand un bloc suit ; le prompt « Brainstorming » nomme le
  manuscrit et dit qu'il n'étaye rien. La pile système est remise dans
  l'ordre documenté : prompt de mode, hints, puis contexte, le bloc
  manuscrit en dernier.
- **La part devient visible.** « Sources (7) · Manuscrit (3) » dans
  l'en-tête, badge traduit à teinte neutre (et les deux couleurs codées en
  dur du CSS remplacées par des jetons de thème), comptes par corpus et part
  des caractères du contexte dans le panneau d'explication, et dans
  l'entrée du journal de recherche.

**État (2026-10-28) : livré.** Constantes posées faute de mesure :
`MANUSCRIPT_QUOTA_RATIO = 0,2`, soit 2 places sur 10, 4 sur 20, 1 dès que
deux places existent, 0 quand topK vaut 1 ; `RetrievalQuery.manuscriptSlots`
permet à l'appelant d'imposer la largeur (le palier 2 s'en sert). Mesure :
`npm run rag:manuscript-share -- /chemin/du/projet [--since AAAA-MM-JJ]
[--json]`, qui lit la base en lecture seule (`immutable`) et imprime la part
par réponse et par mode de chat, puis l'histogramme de similarité par corpus
— tronqué par le bas, puisque seuls les extraits retenus pour le prompt sont
journalisés. Le panneau d'explication montre « Par corpus : Bibliographie 5 ·
Archives 2 · Notes (vault) non interrogé · Manuscrit 2 · Notes de lecture 0 »
et « Contexte : 12.4k caractères, dont manuscrit 3.0k (24 %) » ; l'en-tête
de la liste sépare « Sources (N) · Manuscrit (N) » ; le badge est traduit et
neutre. Le journal de recherche enregistre `includeManuscript`, les comptes
par corpus et les caractères du contexte dans `inputMetadata` de l'opération
`rag_query`. Limite assumée jusqu'au palier 2 : en mode Écrire, « qu'ai-je
déjà écrit sur X ? » n'obtient que la bande (2 passages sur 10) tant que
l'intention de rappel n'est pas détectée.

### Palier 2 — l'utilisateur décide

- **Une quatrième case « Mon manuscrit »** à côté des trois autres, à
  trois états : coché, décoché, ou « selon l'espace » (Brainstorm : non ;
  Écrire et Explorer : oui). Une puce hors du panneau dit ce qui est
  réellement interrogé — le panneau est caché derrière le bouton de
  réglages, et une case que personne ne voit ne sert à rien.
- **La portée « manuscrit seul »** — le dorsal l'accepte déjà
  (`corporaInScope`), le schéma IPC et le renderer la refusent — avec son
  propre en-tête et un repli de trois extraits pour que « qu'ai-je déjà
  écrit ? » ne tombe jamais sur une réponse de culture générale.
- **Une posture par mode de chat, résolue côté main** à partir de
  `systemPrompt.modeId`, comme `isCompressionEnabled` le fait déjà :
  `ragOverrides.manuscript: 'off' | 'background' | 'recall'`. Les quatre
  champs inertes de `ModeRAGOverrides` sont retirés ; les fichiers de mode
  qui les portent encore sont acceptés et ignorés.
- **La bannière** de l'espace Brainstorm vers le mode « Brainstorming »,
  et le nom du mode de chat actif visible dans l'en-tête du chat.
- **L'intention de rappel, déterministe et trilingue** (`backend/core/rag/
  manuscript-intent.ts`) : verbes de rappel à la première personne
  (« qu'ai-je déjà écrit », « ai-je déjà traité », « what have I written »,
  « habe ich schon geschrieben »), jamais un simple possessif — « des
  angles pour mon chapitre sur Danzig » est une question sur les sources —
  et jamais un titre de chapitre. Un raté retombe sur le comportement par
  défaut, jamais sur le silence. L'intention détectée est journalisée.

Préséance, du plus fort au plus faible : intention de rappel explicite >
portée « manuscrit seul » > portée restreinte par l'utilisateur (documents,
collection, notes seules) > case cochée par l'utilisateur ou défaut de
l'espace > posture du mode de chat > bande par défaut.

**État (2026-10-28) : livré.** La politique est une fonction pure,
`resolveManuscriptPolicy` (`src/main/services/manuscript-policy.ts`),
résolue côté main à chaque tour ; la posture du mode vient de
`ragOverrides.manuscript` lue par `systemPrompt.modeId`, comme la
compression. Largeurs : rappel `min(topK − 1, 6)` ; arrière-plan
`min(bande, 2)` ; manuscrit seul `topK`, avec un repli de trois passages
sous le seuil (`CorpusSearchOptions.sole`) pour que la question ne tombe
jamais sur une réponse de culture générale. Le mode « Brainstorming » est en
`background`, le mode libre en `off`, les six autres en `recall` par défaut ;
`sourceType`, `useGraphContext`, `similarityThreshold` et `summaryGeneration`
sont retirés de `ModeRAGOverrides` (un fichier de mode qui les porte est
accepté et ignoré). La détection d'intention (`backend/core/rag/
manuscript-intent.ts`) est journalisée avec la politique retenue dans
`inputMetadata.manuscriptPolicy` de l'opération `rag_query`. Côté
interface : la case « Mon manuscrit » (tri-état, défaut selon l'espace) et la
ligne « Recherche : … » toujours visible, la portée « manuscrit seul » quand
elle est la seule cochée, la bannière de l'espace Brainstorm et le nom du mode
de chat dans l'en-tête.

### Palier 3 — n'indexer que ce que l'auteur a écrit

- Les blocs de citation sortent du texte embarqué du manuscrit ; les corps
  de notes de moins de 25 mots (références) aussi ; les notes longues
  restent dans le flux de leur section. L'option est passée par le seul
  indexeur du manuscrit : **les notes de lecture gardent leurs
  citations**, c'en est le propos.
- Une version de découpage entre dans l'empreinte de contenu, sinon rien
  ne se réindexe (l'empreinte porte sur le texte brut, pas sur le texte
  extrait). Le réembarquement qui suit est entier ; son coût sur le
  fournisseur embarqué reste à mesurer et doit être rendu visible.
- Plus tard, si la mesure montre des doublons résiduels (citations en
  ligne, chapitres non réindexés) : une passe de recouvrement inter-corpus
  au moment du tour, et une diversité par section.

**État (2026-10-28) : livré.** `extractProseText` accepte deux options
(`dropBlockquotes`, `minFootnoteWords`) que `chunkManuscriptChapter(…,
{ dropQuotations: true })` pose, et que seul l'indexeur du manuscrit passe ;
les statistiques du document et les notes de lecture ne changent pas.
`CHUNKER_VERSION = 2` (`manuscript-chunker.ts`) entre dans l'empreinte de
chaque chapitre : la première passe après mise à jour réembarque tout le
manuscrit, à la sauvegarde suivante ou par « Réindexer », et la section
« Corpus manuscrit » affiche désormais la dernière passe (réindexées,
inchangées, retirées, échecs, durée). Non mesuré : la durée de cette passe
sur le fournisseur embarqué pour un livre long — à relever sur un projet réel
avant la prochaine version.

## Au-delà du manuscrit

- **Les notes de lecture ont la même structure** : toujours actives, dans
  la langue de l'auteur, cosinus exhaustif, sans quota, sans case. Une fois
  le manuscrit borné, elles deviennent le corpus suivant « trop fort ». La
  bonne unité de conception est « les corpus à la voix de l'auteur »
  (manuscrit, notes de lecture, vault) face aux corpus de sources. Chantier
  suivant.
- **Le mode libre** (`free-mode`) injecte le bloc manuscrit sans aucun
  prompt système : la pire posture pour se citer soi-même. Toute politique
  par mode doit le couvrir.
- **Défauts de documentation** à corriger avec le premier palier : la
  docstring de `retrieval-quota.ts` ; les commentaires d'ordre des messages
  dans `chat-engine.ts` et `fusion-chat-service.ts` ; l'affirmation de
  CLAUDE.md selon laquelle `ChatMessageMeta.ragCitation` marque les messages
  de contexte — rien ne le pose jamais, le compacteur protège ces messages
  parce qu'ils sont `system` ; la section « Reste à faire » de
  `manuscript-corpus.md`, qui liste encore l'exposition dans l'interface
  alors que `ManuscriptCorpusSection` existe.
