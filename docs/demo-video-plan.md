# Vidéo de démonstration — plan de tournage

> Cible : **2:00 max**, sans son, sous-titres seuls, personne à l'écran.
> État de référence : **v1.0.0-rc.4**. L'UI bougera — re-vérifier les libellés avant de tourner.

## 1. L'arbitrage de départ

Cent-vingt secondes n'achètent pas vingt fonctionnalités : elles en achètent **quatre, bien
racontées**. Le tour du propriétaire (Zotero, Tropy, Obsidian, MCP, recettes, livre, diaporama,
CLI) produit une vidéo que personne ne finit.

Squelette retenu : **le cycle de travail** — explorer → réfléchir → écrire → publier, qui est la
structure même de l'application (`WorkspaceModeBar`), donc la vidéo *est* le mode d'emploi. Mais
ce squelette est générique : tout logiciel d'écriture assistée raconte la même chose. D'où la
règle : **un différenciateur planté dans chaque acte** — traçabilité des citations, l'IA qui ne
fait que proposer, l'indexation locale, le journal d'usage IA.

Le « money shot » n'est pas le chat qui répond — tout le monde a déjà vu ça. Ce sont :

- le **clic sur une citation qui ouvre l'extrait exact de la source** (plan 7) ;
- la **modale où l'on refuse une proposition de l'IA** (plan 12).

Ces deux plans valent chacun leurs dix secondes.

## 2. Conducteur

| # | t | Plan à l'écran | Sous-titre |
|---|---|---|---|
| 0 | 0:00–0:03 | App ouverte, projet chargé, léger zoom avant sur la barre des 4 modes | **ClioDeck — un atelier de recherche pour historien·nes** |
| 1 | 0:03–0:06 | Le curseur survole les 4 onglets sans cliquer | Explorer → Réfléchir → Écrire → Publier. Une seule application. |
| | | **Explorer** | |
| 2 | 0:06–0:13 | Mode Explorer › onglet Corpus, le graphe se dessine | Mon corpus : bibliographie PDF, archives Tropy, notes Obsidian. |
| 3 | 0:13–0:21 | Survol d'un nœud → une source primaire s'ouvre (photo d'archive OCRisée) | Sources primaires et secondaires restent distinguées. |
| 4 | 0:21–0:28 | Onglet Textométrie, une courbe apparaît | Tout est indexé localement, sur ma machine. |
| | | **Réfléchir** | |
| 5 | 0:28–0:34 | Mode Brainstorm, fin de frappe d'une question + Entrée | Je pose une question à mes sources. |
| 6 | 0:34–0:44 | Réponse qui se génère **(accéléré ×3)**, citations numérotées | La réponse vient de mes documents, pas du web. |
| 7 | 0:44–0:52 | Clic sur une citation → popover : extrait exact + document | Chaque affirmation renvoie à l'extrait qui l'a produite. |
| 8 | 0:52–1:00 | Clic « Envoyer vers l'écriture » → bascule en mode Écrire, le bloc atterrit | Une idée retenue part vers le manuscrit. |
| | | **Écrire** | |
| 9 | 1:00–1:08 | Frappe d'une phrase, rendu Markdown en direct (titre, gras) | Un éditeur Markdown qui se rend au fil de la frappe. |
| 10 | 1:08–1:17 | Frappe de `[@` → autocomplétion Zotero → citation ; puis note de bas de page éditée en place | Citations Zotero et notes de bas de page, dans le flux du texte. |
| 11 | 1:17–1:26 | Question à l'assistant : « qu'ai-je déjà écrit sur … ? » → extrait étiqueté *manuscrit* | L'assistant relit aussi ce que j'ai déjà écrit. |
| 12 | 1:26–1:33 | Une proposition arrive → modale d'adjudication → clic **Refuser** | L'IA ne fait que proposer. |
| 13 | 1:33–1:38 | Deuxième proposition → clic **Accepter**, le texte s'insère | Rien n'entre dans mon texte sans mon accord. |
| | | **Publier** | |
| 14 | 1:38–1:46 | Mode Export › carte PDF → modale → Exporter | Export PDF (Pandoc), Word, ou diaporama. |
| 15 | 1:46–1:52 | Le PDF s'ouvre : notes numérotées, bibliographie | Notes et bibliographie mises en forme. |
| | | **Clôture** | |
| 16 | 1:52–1:56 | Flash sur le journal d'usage IA (volumes) | Un journal de mon usage de l'IA : des volumes, jamais mes prompts. |
| 17 | 1:56–2:00 | Carte finale sur fond uni | **ClioDeck — local d'abord, libre (GPLv3)**<br>github.com/cliodeck/cliodeck-app |

### Ordre de sacrifice

Ça débordera. Couper dans cet ordre :

1. plan 4 (textométrie)
2. plan 9 (rendu live)
3. plan 16 (journal — le fondre dans la carte finale)
4. plan 3 (source primaire)

**Ne jamais couper 7, 12 et 13.** C'est la vidéo.

## 3. Préparation

**Le projet de démonstration.** Ne pas filmer la recherche en cours : droits sur les archives,
données non publiées, noms d'informateurs. Monter un projet `demo/` dédié — 5 à 8 PDF en accès
ouvert, 10 à 15 items Tropy issus d'un fonds numérisé public, un sujet cohérent. Bénéfice
secondaire : on pourra re-tourner à l'identique pour rc.5 quand l'UI aura bougé.

**Tout pré-indexer** — corpus, vault, manuscrit. Une barre de progression à l'écran, c'est trois
secondes perdues sur cent-vingt.

**Le modèle.** Pour le tournage, brancher un fournisseur cloud rapide (Claude, Mistral) même si le
discours est « local d'abord » — le plan 6 sera accéléré de toute façon. Un modèle local qui met
40 s à répondre rend le plan 11 intournable. Pré-chauffer avec une requête à blanc juste avant.

**Fenêtre et environnement.** Fenêtre fixée à **1280×800** (pas plein écran : le texte devient
illisible une fois redescendu en 1080p), Ne pas déranger activé, dock masqué, barre de menu
propre, **un seul thème du début à la fin**. Nommer projet et fichiers de façon plausible — un
`test2.md` dans l'arborescence ruine la crédibilité.

**Tourner en cinq prises séparées**, une par acte, jamais une traversée unique : on refait un acte
raté sans refaire les deux minutes. Devant chaque cible, **pause d'une seconde avant le clic**,
sinon l'œil ne suit pas le curseur.

**Outil.** Sur macOS, Screen Studio fait le zoom automatique et la mise en évidence des clics —
sans son ni voix, c'est ce qui remplace le pointage vocal. À défaut, OBS + zooms au montage.

## 4. Sous-titres

Une ligne, ~60 caractères, bande semi-opaque en bas, 3 à 5 s à l'écran, sans-serif large.

Alterner délibérément deux registres :

- **ce que je fais** — « je pose une question à mes sources » ;
- **ce que ça veut dire** — « rien n'entre dans mon texte sans mon accord ».

Ce sont les seconds que les gens retiennent.

L'app est trilingue : tourner une fois, exporter **deux versions au brûlage (FR et EN)** depuis le
même métrage. Une piste `.srt` séparée ne s'affiche pas sur la moitié des plateformes sociales.

## 5. Arbitrages ouverts

1. **Article ou livre ?** Le conducteur ci-dessus met en scène un projet *article* — le cas le plus
   universel. Un projet *livre* (navigateur de chapitres, renumérotation des notes d'un bout à
   l'autre) coûte ~15 s et parle surtout à qui rédige une thèse ou un ouvrage : plutôt une seconde
   vidéo que une compression de celle-ci.
2. **Le public.** Collègues historiens, communauté DH, ou financeurs ? Pour des financeurs,
   remonter le journal d'usage IA et l'éthique en acte II au lieu de la clôture.
3. **Le ton d'ouverture.** L'entrée retenue est sobre. Alternative plus mordante : ouvrir sur le
   plan 7 (la citation qui remonte à sa source) en préambule de 4 s, avant le titre — montrer la
   promesse avant de présenter le produit.

## 6. Hors champ (pour une autre vidéo)

Explicitement écartés faute de temps, pas faute d'intérêt : configuration des fournisseurs, MCP
(serveur et clients), ClioRecipes, intégration Obsidian, projets *livre*, export RevealJS, CLI
`bin/cliodeck`, inspecteur de sources / injection de prompt, `.cliohints` et `context.md`.
