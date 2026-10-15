# Stratégie de communauté pour ClioDeck : exemples vérifiés et enseignements pour un développeur académique seul

Les faits confirment l'essentiel de la stratégie esquissée : un cadrage restrictif d'abord, puis un petit cercle de testeurs, et une ouverture publique tardive. Ils la corrigent toutefois sur deux points. D'abord, les « unités de contribution périphériques » sur le modèle de Zotero ne sont pas gratuites : elles exigent une capacité de relecture que Zotero lui-même peine à fournir. Ensuite, un public visé de chercheurs n'ira pas à un outil qui n'a pas de structure institutionnelle derrière lui. Le cas ArtCraft/PhotoCraft (septembre-octobre 2026) montre en temps réel ce qui arrive quand on ouvre trop tôt : en dix jours, environ 1 230 tickets, dont la plupart portent sur des fonctions que le projet comptait déjà comme présentes.\[1\]\[2\]

## TL;DR

- **Ne pas ouvrir les contributions de code et ne pas chercher la visibilité maintenant.** PhotoCraft a reçu environ 1 230 tickets en dix jours. Ses propres documents reconnaissent que la plupart visent des fonctions déjà comptées comme présentes. SQLite (« open source, not open contribution ») et Litestream (fermé aux contributions « pour ma santé mentale ») sont des précédents légitimes pour un CONTRIBUTING restrictif.
- **La soutenabilité des outils d'humanités numériques qui ont duré vient d'abord d'une structure, pas d'une foule de contributeurs.** C'est le cas de Zotero, Omeka et Tropy, adossés à Digital Scholar (fondée en 2009), et d'OpenRefine, financé par des subventions CZI successives. Voyant Tools montre le risque inverse : la dépendance à une seule personne a forcé une refonte en consortium après le décès de Stéfan Sinclair en 2020.
- **Pour ClioDeck, l'objectif réaliste est « validation par les pairs + légitimité pour un financement ».** Cela passe par 5 à 10 co-testeurs historiens, des études de cas documentées, et un rapprochement explicite avec l'écosystème Tropy/Zotero, dont le C²DH est déjà co-développeur. L'adoption de masse et les contributions de code ne sont pas des objectifs réalistes.

## Key Findings

1. **ArtCraft est un contre-exemple direct de l'étape 3 prématurée.** Le dépôt PhotoCraft a été créé le 30 septembre 2026.\[3\]\[4\] Le 15 octobre 2026, il comptait 61,5 k étoiles, 10,6 k forks, environ 1,1 k tickets ouverts et 661 PR ouvertes.\[5\] Brandon Thomas a reconnu publiquement : « I needed to seed a community that could help contribute bug reports and PRs ».\[1\]\[6\]
2. **Deux des chiffres fournis sont à corriger.** Les « 1 230 tickets » sont des tickets *déposés* depuis la première version, pas des tickets *ouverts* : 579 étaient ouverts le 10 octobre 2026, selon le document du projet lui-même.\[2\] Le chiffre de « 189 contributeurs au 10 octobre » n'a pas pu être confirmé ; les sources divergent entre 31 et 278 selon le périmètre.\[3\]\[4\]\[7\]
3. **Le modèle « traducteurs et styles » de Zotero fonctionne, mais il coûte.** La documentation de Zotero indique que « over 10,000 additional styles can be found in the Zotero Style Repository ». En revanche, des bénévoles signalent qu'une PR de traducteur peut attendre « des mois ».\[8\] Le 5 mars 2021, Dan Stillman (équipe Zotero) écrivait sur le forum : « We have a huge backlog of open translator pull requests, and we need to clear the queue… That will be the first order of business for our new developer starting in May. »
4. **Obsidian a dû automatiser la relecture de son écosystème de greffons.** Selon le billet de kepano « The future of Obsidian plugins » (blog Obsidian, 12 mai 2026), il existe « more than 4,000 plugins and themes », et le nouveau système a permis de « process over 2,300 queued submissions in the last few days », l'équipe expliquant que les agents de codage allongeaient la file.
5. **Les projets à mainteneur quasi unique durent quand le mainteneur y travaille à plein temps et vit de dons.** C'est le cas de Calibre, où Kovid Goyal fait plus de deux fois plus de commits que les 67 autres contributeurs réunis.\[9\] Ce n'est pas la situation d'un chercheur seul.
6. **La littérature confirme la précarité.** Selon le rapport Tidelift « 2024 State of the Open Source Maintainer » (437 répondants), 60 % des mainteneurs ne sont pas payés (16 % de bénévoles qui ne veulent pas l'être, 44 % qui « would appreciate getting paid ») et 60 % ont arrêté ou envisagé d'arrêter, dont 22 % qui ont effectivement arrêté. Le rapport Ithaka S+R de Maron et Pickle (2014), fondé sur 126 entretiens, montre que la soutenabilité des projets d'humanités numériques dépend du soutien de l'institution d'accueil au-delà de la phase de lancement, quand le soutien par subventions « drops by almost half ».

## Details

### Cadre d'analyse : quatre objectifs, quatre stratégies

La typologie de Nadia Eghbal (*Working in Public*, Stripe Press, 2020) classe les projets selon deux axes, la croissance des utilisateurs et celle des contributeurs :\[10\]\[11\]

- **fédérations** : beaucoup des deux (Rust, Linux) ;\[10\]
- **clubs** : beaucoup de contributeurs, peu d'utilisateurs (Astropy) ;\[10\]
- **stades** : beaucoup d'utilisateurs, peu de contributeurs (Babel) ;\[12\]
- **jouets** : peu des deux.

Son argument central : la majorité des projets ne sont pas des « bazars » collaboratifs. Ce sont des stades où un petit noyau filtre une forte demande d'attention.\[11\]\[13\] Le projet NetBox se présente d'ailleurs explicitement comme un « stade » dans son CONTRIBUTING.md.\[14\]

**Transposition à ClioDeck.** ClioDeck est aujourd'hui un « jouet » au sens d'Eghbal, sans connotation péjorative. Les deux trajectoires plausibles sont :

- le **club** : un petit groupe d'historiens-utilisateurs qui deviennent contributeurs parce qu'ils partagent le contexte ;\[15\]
- le **stade** : beaucoup d'utilisateurs passifs, ce qui serait ingérable seul.

Le club correspond aux objectifs « validation par les pairs » et « légitimité pour un financement ». Le stade correspond à l'objectif « adoption », qu'il faut écarter tant que le code est destiné à être réécrit.

*Roads and Bridges* (Ford Foundation, 2016), du même auteur, documente le travail invisible des infrastructures numériques. Il n'a pas été revérifié en source primaire dans cette recherche.

### 1. ArtCraft / Crafting Apps (storytold, Brandon Thomas), septembre-octobre 2026

**Origine.** ArtCraft, anciennement Storyteller.ai, est une société d'Atlanta fondée par Brandon Thomas (@echelon sur GitHub), qui exploite aussi FakeYou.\[16\]\[17\] L'organisation GitHub « storytold » date de janvier 2021.\[17\] Fin septembre 2026, la société publie en open source (MIT/Apache-2.0) sept applications en Rust qui imitent la suite Adobe (PhotoCraft, VectorCraft, FilmCraft, etc.), écrites avec l'aide de Claude Opus 5.5.\[18\]\[19\] Suivent des clones d'Office (GridCraft, DeckCraft, WordCraft).\[20\] Le premier commit de PhotoCraft, « init repo », date du 30 septembre 2026.\[19\]

**Stratégie communautaire annoncée.** Les citations Hacker News proviennent d'extraits de moteur de recherche, la page étant inaccessible au moment de la vérification.

- Thomas, vers le 1er octobre 2026 : « These are still super early alpha… I'll need lots of help. (Anyone want to join me? I'll pay stipends and bug bounties.) ».\[21\]
- Interrogé sur une publication jugée prématurée : « I needed to seed a community that could help contribute bug reports and PRs », puis « This effort needs a community to climb the quality and parity gradients ».\[6\]
- Une réponse citée par la newsletter The Synthesis : « you cannot possibly just say out loud that you're using people ».\[1\] Les dates exactes de ces deux derniers échanges ne sont pas vérifiées.

**Financement.** Selon des sources secondaires concordantes (Digital Trends, CineD, The Synthesis du 13 octobre 2026), le développement des applications gratuites est financé par la vente de crédits pour des modèles d'IA d'image et de vidéo. Les tarifs affichés vont de 10 à 60 dollars par mois.\[1\]\[18\] Thomas affirme que la société « just passed $5M annualized recurring revenue » ; ce chiffre n'est vérifié par aucun tiers. Il affirme aussi : « We're not going to add tracking or monetization to the Adobe tools. »\[1\] Le message Reddit original n'a pas été consulté.

**Effets observés (PhotoCraft), relevés le 15 octobre 2026 sur la page du dépôt :**

- 61,5 k étoiles, 10,6 k forks, 264 observateurs ;\[5\]
- environ 1,1 k tickets ouverts, 661 PR ouvertes, 2 370 commits ;\[5\]
- des relevés antérieurs, probablement en cache, donnaient 908 tickets et 555 PR, ce qui montre une croissance très rapide.\[22\]

**Étoiles.** Le chiffre « environ 55 000 » est daté et dépassé : 57 663 le 14 octobre selon un article de presse, 61,5 k le 15 octobre.\[5\]\[19\]

**Tickets.** Le document du projet `docs/target-app-parity.md`, daté du 10 octobre 2026, écrit : « That estimate counted feature surface and was far too optimistic: about 1,230 issues have been filed since the first release (579 open on 2026-10-10), most of them against features already counted as present. »\[2\] Le README précise : « Every Photoshop menu item is wired to a command (docs/parity-checklist.md), but that measures wiring, not behaviour. »\[5\] L'autoévaluation la plus récente donne une couverture fonctionnelle d'environ 76 % et un état « prêt pour un vrai travail » d'environ 45 %.\[23\]\[24\]

**Contributeurs.** Le chiffre de 189 au 10 octobre n'a pas pu être confirmé. Les données disponibles :

| Source | Chiffre | Périmètre / date |
|---|---|---|
| Notes de version 0.7.0 | 31 contributeurs communautaires | 183 PR fusionnées et 146 tickets fermés, depuis la 0.2.0\[7\] |
| Autre page de version | « echelon, vbasky, and 69 other contributors » | une version\[7\] |
| Agrégateur Repoburst | 239 | —\[4\] |
| Agrégateur star-history | 278 | —\[3\] |
| Digital Trends | 230 comptes distincts hors Thomas | sept dépôts, au 9 octobre\[25\] |

À retenir : quelques dizaines de contributeurs réguliers, et plusieurs centaines de comptes ayant contribué au moins une fois.

**AGENTS.md / CLAUDE.md.** Le fichier `AGENTS.md`, intitulé « guide for AI agents and contributors », impose :\[22\]

- des règles strictes : « Never crash », aucun `unwrap()`, « Tests are the gate », salle blanche vis-à-vis du code propriétaire ;\[22\]
- une organisation du travail des agents en parallèle ;\[22\]
- un mécanisme de crédit des contributeurs humains et des modèles (Co-Authored-By).\[22\]\[26\]

Point critique : les normes partagées résident dans un dépôt `craftrules` **non public**, et les contributeurs extérieurs doivent « demander à un mainteneur », ce qui a suscité un ticket de protestation (#493).\[22\]\[27\]\[28\] Aucun fichier CLAUDE.md n'a été trouvé. Aucune politique explicite de refus des PR, ni d'interdiction des PR rédigées par une IA, n'a été trouvée.

**Ce qui a marché.** Un volume brut de signalements et de correctifs, et une visibilité énorme.

**Ce qui a échoué.** Plusieurs choses :

- une métrique de parité trompeuse, qui compte le câblage et non le comportement ;\[5\]
- une file de tickets et de PR qui dépasse toute capacité humaine de tri ;
- des documents contradictoires : le ticket #997 relève que la feuille de route déclare des outils manquants que la grille d'évaluation marque comme faits ;\[29\]
- une perception publique d'« utilisation » des bénévoles.\[1\]

**Enseignement pour ClioDeck : non transposable, sauf comme avertissement.** ArtCraft dispose d'une entreprise, de revenus revendiqués et d'une équipe, et il est quand même submergé. Un développeur seul l'est dès quelques dizaines de tickets. Trois enseignements se transposent :

- un statut honnête dans le README ne suffit pas si la publicité précède la maturité ;
- les étoiles ne mesurent rien d'utile, ce qui confirme le point (f) ;
- un AGENTS.md est utile pour cadrer les contributions assistées par IA, mais seulement s'il est public et complet.

### 2. Zotero

**Origine et financement.**

- Créé au Center for History and New Media (aujourd'hui RRCHNM) de George Mason University. Lancement de la bêta 1.0 le 5 octobre 2006.\[30\]
- Financements initiaux : IMLS (subvention « SmartFox »), Andrew W. Mellon Foundation, Alfred P. Sloan Foundation.\[30\]\[31\]
- Dan Cohen, co-fondateur, raconte (newsletter du 6 octobre 2026) qu'il a fallu « cinq ans, pas cinq minutes » pour produire un premier prototype. L'équipe initiale réunissait plusieurs historiens, dont Roy Rosenzweig, et des développeurs, dont Simon Kornblith et Dan Stillman, toujours développeur principal. Cohen revendique « plus de 20 millions » d'utilisateurs, chiffre non vérifié indépendamment.\[30\]

**Gouvernance et modèle économique.**

- La Corporation for Digital Scholarship (Digital Scholar) a été créée en 2009 par des membres du RRCHNM pour assurer la soutenabilité et le soutien commercial des projets.\[32\]
- Selon le RRCHNM, elle est financièrement responsable de Zotero depuis 2013. Depuis 2021, toute l'équipe est employée par Digital Scholar (Wikipédia, source secondaire).\[32\]\[33\]
- Le stockage payant (Zotero File Storage) est présenté par le projet CSL comme « the preferred way to donate to Zotero ».\[34\]

**Contributions : noyau ou périphérie.**

- *Styles CSL.* Selon la documentation de Zotero, « over 10,000 additional styles can be found in the Zotero Style Repository ». Dès janvier 2008, Zotero 1.0.2 inaugurait un dépôt d'une cinquantaine de styles, presque tous contribués par un seul bénévole, Julian Onions.\[35\] Les dépôts CSL sont maintenus par deux bénévoles identifiés, Sebastian Karcher et Brenton Wiernik.\[34\]
- *Traducteurs.* Ils sont contribués par PR sur `zotero/translators` et relus par les développeurs ou par des bénévoles expérimentés.\[36\] Zotero refuse les tickets GitHub pour le support et renvoie vers ses forums.\[37\] Les traducteurs sont des fichiers JavaScript isolés, à fort impact pour l'utilisateur, testables indépendamment.
- *Noyau.* Il reste aux mains de l'équipe salariée.

**Ce qui a échoué ou coince.**

- En novembre 2024, un bénévole écrit sur le forum : « the Zotero translators suffer from a shortage of human resources for PR reviews… It can take months ».\[8\]
- Le 5 mars 2021, Dan Stillman (équipe Zotero) reconnaissait sur le forum : « We have a huge backlog of open translator pull requests, and we need to clear the queue… That will be the first order of business for our new developer starting in May. » Sur le même fil, Sebastian Karcher notait que « translator review is a major bottleneck » et que, le code étant livré à des centaines de milliers d'utilisateurs, l'équipe ne peut pas « skimp on the review process ».
- En octobre 2025, une PR de traducteur largement produite avec Codex (environ 80 heures de travail) a été refusée comme « just not mergeable ». Le contributeur s'est demandé publiquement si Zotero « veut des contributions ».\[38\]
- La page des PR de traducteurs comptait 181 PR ouvertes et 2 256 fermées en décembre 2025.\[39\]

**Enseignement pour ClioDeck : partiellement transposable.** Le modèle d'unités périphériques fonctionne quand l'unité est petite, isolée, testable, et que son format est documenté et stable (CSL est un standard indépendant). Il contredit toutefois une lecture naïve de l'étape 2 : chaque unité contribuée crée une charge de relecture, et même une équipe salariée n'y suffit pas. L'arrivée de contributions générées par IA aggrave cette charge. Pour ClioDeck, il faut donc un format d'extension stable avant d'inviter quiconque, ce qui est impossible si la réécriture est prévue. Il faut aussi des tests automatiques qui font l'essentiel de la relecture.

### 3. Tropy et Omeka

**Tropy.**

- Financement Mellon annoncé par Sean Takats le 2 octobre 2015 pour deux ans, en codirection avec Stephen Robertson. Lancement en 2017 depuis le RRCHNM.\[40\]\[41\]
- Selon la fiche Invest in Open Infrastructure, Digital Scholar développe Tropy de manière indépendante depuis 2024.\[40\]
- Le site tropy.org indique que Tropy est développé conjointement par le RRCHNM, le **C²DH (Luxembourg)** et Digital Scholar.\[42\]
- Fonctionnement financé par des subventions Mellon, des contrats avec des projets partenaires de Digital Scholar (Sourcery, Omeka) et des dons. La page de dons formule clairement le besoin de financer « developer time ».\[43\]
- Système de plugins d'export documenté (JSON-LD, CSV, Omeka S).\[42\]
- Le rapport annuel 2024 de Digital Scholar mentionne un financement Mellon de 750 000 dollars ; l'extrait consulté ne permet pas d'établir avec certitude à quel projet il se rattache.\[44\]

**Omeka.**

- Indépendant sous l'égide de Digital Scholar depuis 2016.\[45\]
- Omeka.net, l'hébergement payant, a accueilli « nearly 83K users and over 50K sites ». Ses revenus ont contribué directement aux salaires de l'équipe.\[45\]
- Les greffons populaires ont été portés vers Omeka S grâce à des financements Mellon, IMLS et NEH.\[45\]
- Digital Scholar dit repérer les besoins dans les forums, les discussions et les tickets GitHub. Elle soutient l'IA uniquement par des greffons optionnels (« opt-in plugins — but nothing by default »), Tropy développant par exemple un service de transcription.\[46\]

**Difficulté de soutenabilité.** Le passage de Tropy du RRCHNM à Digital Scholar en 2024 et le recours à des contrats croisés montrent que même un projet bien financé doit changer de structure porteuse. Invest in Open Infrastructure parle d'un champ où trop de projets peinent à franchir l'écart « between initial grant funding and genuine sustainability ».\[46\]

**Enseignement pour ClioDeck : transposable, et c'est sans doute le levier le plus important.** ClioDeck intègre Tropy, et le C²DH est déjà co-développeur de Tropy.\[42\] La voie la plus réaliste vers la légitimité et le financement ne passe pas par une communauté propre. Elle passe par un positionnement explicite dans cet écosystème : connecteurs, cas d'usage partagés, discussion avec l'équipe Tropy et Digital Scholar. Le principe « IA en greffon optionnel, jamais par défaut » de Digital Scholar est aussi un précédent direct pour la couche MCP optionnelle de ClioDeck.\[46\]

### 4. Projets à mainteneur unique ou presque

**Calibre (Kovid Goyal).**

- Commencé en 2006 sous le nom libprs500, pour faire fonctionner le lecteur Sony PRS-500 sous Linux, avec l'aide des forums MobileRead.
- LWN (2025) : depuis la version 7.0.0, en environ 15 mois, Goyal a fait 1 479 commits, plus de deux fois le total des 67 autres contributeurs. Il n'existe aucun document de gouvernance.\[9\]
- LWN (2011) : sorties hebdomadaires. Goyal travaille à plein temps grâce aux dons (« Donations are essential to my being able to work full-time on calibre ») complétés par du conseil.\[47\] Il a aujourd'hui un Patreon.\[48\]
- Les greffons sont distribués via MobileRead. Quand Calibre 8.12 a cassé plusieurs greffons utilisant lxml (octobre 2025), ce sont des bénévoles qui ont publié les correctifs.\[49\]

*Enseignement : non transposable tel quel.* Calibre montre qu'un projet à décideur unique peut durer vingt ans, mais grâce à un engagement à plein temps financé par les utilisateurs. Ce qui se transpose : un forum communautaire distinct du dépôt, et des greffons maintenus par des tiers qui absorbent une partie de la demande.

**Zettlr (Hendrik Erz).**

- Commencé en 2017 par un doctorant en sociologie.\[50\]\[51\]
- Le site officiel indique : « Zettlr is maintained to 95 percent by one single guy… this includes the translation service, the API, this website, the documentation and the forum ».\[52\]
- En juillet 2024, Erz a annoncé un comité de pilotage de trois personnes, tout en précisant : « I still carry the entire responsibility and accountability for the project » (LWN).\[51\]
- Financement : Patreon, PayPal, GitHub Sponsors (7 sponsors visibles sur la page GitHub Sponsors au moment de la consultation), Ko-fi. Les notes de version récentes évoquent des coûts de serveurs qui ont « skyrocketed ».\[50\]\[53\]\[54\]\[55\]

*Enseignement : très transposable, comme avertissement.* C'est l'analogue le plus proche de ClioDeck : un chercheur seul, Electron/TypeScript, un public académique, du local-first. Zettlr a réussi l'adoption, mais au prix d'un mainteneur qui porte seul le site, le forum, la documentation et les traductions, avec des dons modestes. Si l'objectif est la recherche et non le produit, c'est exactement la trajectoire à éviter.

**Voyant Tools (Stéfan Sinclair et Geoffrey Rockwell).**

- Descendant de HyperPo (2000) et de Voyeur ; Voyant 2.0 tourne depuis 2016.\[56\]
- Sinclair est décédé le 6 août 2020. Son dépôt a été archivé avec la mention « With the passing of Stéfan Sinclair, this repository has been archived ».\[57\]\[58\]
- Rockwell (juillet 2025) : « Sinclair had the skills and love of programming to maintain Voyant in between the grants when other developers could be hired ». D'où la création d'un consortium international avec un comité communautaire.\[59\]
- Le chiffre d'environ 200 000 utilisateurs provient d'une source secondaire et n'est pas vérifié.\[60\]

*Enseignement : transposable, et central.* Le « facteur bus » égal à 1 est le vrai risque, plus que le manque de contributeurs. Un consortium ou un partenariat institutionnel se prépare *avant* la crise. Pour ClioDeck, une documentation d'architecture et des décisions consignées valent davantage que des contributeurs extérieurs.

**OpenRefine.**

- Né chez Metaweb (Freebase Gridworks), racheté par Google en 2010, puis remis à la communauté en octobre 2012.\[61\]\[62\]
- En 2014, le projet fonctionnait « relying only on volunteer » et rédigeait sa première gouvernance.\[62\]
- Il a ensuite reposé sur des subventions : Google News Initiative (100 000 dollars, 2018), Chan Zuckerberg Initiative EOSS (200 000 dollars pour 2020, puis 310 100 dollars pour EOSS-5, prolongé jusqu'en décembre 2025), Wikimedia et NFDI. Code for Science & Society est son parrain fiscal.\[61\]\[63\]\[64\]\[65\]\[66\]
- La subvention de 2019 avait explicitement pour objectif de « grow the community of OpenRefine contributors by reaching out to seasoned users ».\[65\]
- Fin 2025, le projet a atteint la fin de cinq ans de soutien EOSS.\[67\] Sa capacité à remplacer ce financement n'est pas établie à la date de ce document.

*Enseignement : transposable pour la phase « financement ».* Les bailleurs financent explicitement l'élargissement des contributeurs à partir d'utilisateurs aguerris, ce qui correspond à l'étape 1 de ClioDeck. Mais la dépendance aux subventions successives reste fragile.

**Obsidian.** Ce n'est pas un logiciel open source : le dépôt `obsidian-releases` le précise.\[68\] L'écosystème de greffons communautaires est en revanche massif. Le 12 mai 2026, l'équipe annonçait :

- plus de 4 000 greffons et thèmes, et plus de 120 millions de téléchargements ;\[69\]
- une revue manuelle par « our small team » devenue intenable : « As coding agents accelerate the creation of plugins, the review queue was only getting longer » ;\[69\]
- un passage à une revue automatisée qui a permis de « process over 2,300 queued submissions in the last few days ».

Des développeurs décrivaient auparavant une file d'environ 58 pages ou de sept mois.\[70\]\[71\]

*Enseignement : transposable comme mise en garde sur l'étape 2.* Une API d'extension réussie engendre une file de relecture. Même une entreprise rentable a dû automatiser. Pour l'extension par MCP, ClioDeck devrait viser des serveurs MCP *tiers* que les utilisateurs installent sous leur propre responsabilité, sans catalogue relu par le mainteneur.

**Pandoc, AntConc, Logseq, Quarto, Hypothesis, Mirador/IIIF.** Ces cas n'ont pas pu être vérifiés en sources primaires dans le cadre de cette recherche. Aucun chiffre n'est donc avancé. À documenter séparément avant publication si on veut les citer : rôle de John MacFarlane et nombre de contributeurs de Pandoc ; modèle gratuiciel et développement solo d'AntConc ; financement de Logseq ; statut non lucratif d'Hypothesis.

### 5. Études sur la soutenabilité et l'épuisement

**Ithaka S+R, Maron et Pickle (18 juin 2014), *Sustaining the Digital Humanities: Host Institution Support beyond the Start-Up Phase*.**

- Étude financée par le NEH : 126 entretiens (« 126 interviews were conducted in the landscape and deep-dive phases »), avec une analyse approfondie de quatre campus (Columbia, Brown, Indiana Bloomington, Wisconsin-Madison).
- Elle décrit trois modèles de soutien institutionnel : service, laboratoire et réseau.\[72\]
- Pour ClioDeck, cela signifie que la question de la soutenabilité se pose au C²DH et à l'Université du Luxembourg : qui hébergera, documentera et maintiendra après la subvention ? Elle ne se pose pas sur GitHub.

**Project Bamboo (Mellon, 2008-2012).**

- Infrastructure pour les humanités : 1,4 million de dollars pour la seule phase de planification, arrêtée à la demande de Mellon en décembre 2012.\[73\]
- Quinn Dombrowski y voit un « strategic failure » : l'architecture de services « failed to connect with scholars ».\[74\] Il était devenu clair que les chercheurs jugeaient « the emphasis on tools and services was misplaced ».\[73\]\[75\]\[76\]
- C'est l'argument le plus fort *en faveur* de l'étape 1 : écouter un petit nombre de chercheurs réels avant de construire de l'infrastructure.

**Tidelift, *2024 State of the Open Source Maintainer* (437 répondants, juillet-août 2024).**

- 60 % des mainteneurs se décrivent comme amateurs non payés (16 % qui ne veulent pas être payés, 44 % qui « would appreciate getting paid »), chiffre identique à 2023 ; 61 % des bénévoles non payés maintiennent leur projet seuls.
- 60 % ont arrêté ou envisagé d'arrêter, dont 22 % qui disent « Yes, I have quit ».
- 78 % des amateurs non payés y consacrent dix heures ou moins par semaine.\[77\]
- Cela confirme l'intérêt d'un plafond horaire explicite.

### 6. Contre-exemples et stratégies restreintes

- **Submergés par la demande :** ArtCraft (voir ci-dessus), la file de greffons d'Obsidian avant mai 2026, et le retard des PR de traducteurs Zotero.
- **Fragilisés après financement ou après perte d'une personne :** Project Bamboo (arrêt), Voyant (passage forcé au consortium) ; OpenRefine sort d'un cycle de cinq ans de financement CZI fin 2025.
- **« Co-testeurs » ou « design partners » :** aucun cas vérifié et documenté en sources primaires dans les humanités numériques n'a été trouvé. Les éléments les plus proches sont indirects. Zotero est né de cinq ans de conversations au sein d'une communauté restreinte d'historiens-développeurs (récit de Dan Cohen).\[30\] Bamboo a échoué faute d'écouter les chercheurs.\[76\] L'étape 1 est donc *plausible et cohérente* avec ces récits, mais pas démontrée par une étude.

### 7. Précédents pour une politique de contribution restrictive

- **SQLite.** La page de droits d'auteur dit : « SQLite is open-source… But SQLite is not open-contribution. »\[78\] Et : « the project does not accept patches from random people on the internet ». Une procédure existe (affidavit de mise dans le domaine public) mais n'est « not normally worth the effort » pour les petits changements.\[79\]
- **Litestream (Ben Johnson).** À la sortie, en janvier 2021, le README disait : « Similar to SQLite, Litestream is open source but closed to contributions… As the author of BoltDB, I found that accepting and maintaining third party patches contributed to my burn out… I've made the decision to keep this project closed to contributions for my own mental health and long term viability of the project. »\[80\] La politique a ensuite été assouplie, au plus tard en mai 2022 : « this policy is overly broad and has prevented small, easily testable patches… Litestream is now open to code contributions for bug fixes only. Features carry a long-term maintenance burden ».\[81\] Johnson rappelle que « Only five percent of the effort to actually get something shipped is writing the code ».\[82\]
- **Zotero.** Refus des tickets GitHub pour le support, renvoi aux forums, et refus de PR de faible qualité.\[37\]\[38\]

**Enseignement : directement transposable.** Un CONTRIBUTING du type « PR non acceptées pour l'instant ; signalements, retours et études de cas bienvenus » est un choix reconnu et défendable. Le précédent Litestream suggère d'annoncer d'emblée la condition d'assouplissement, par exemple « correctifs de bugs acceptés après la réécriture ».

## Recommendations

1. **Choisir un objectif principal et l'écrire dans le README.** Objectif recommandé : « validation par les pairs et préparation d'un financement ». L'adoption et la contribution de code sont explicitement hors champ.
2. **Étape 0, à faire maintenant (environ deux jours de travail) :**
   - un README avec un statut « expérimental, non utilisable en production, un seul mainteneur » ;
   - un CONTRIBUTING sur le modèle SQLite/Litestream, avec la condition future d'ouverture ;
   - une licence et des versions étiquetées ;
   - GitHub Discussions plutôt que Discord ;
   - un plafond horaire public, par exemple « je réponds le vendredi ».
   - Ajouter aussi un **AGENTS.md public**, dans le style PhotoCraft mais sans normes privées. Il servira à la fois aux agents IA et à la future réécriture.
3. **Étape 1 :** 5 à 10 co-testeurs choisis (historiens, si possible des utilisateurs de Tropy/Zotero), avec une grille de retours et un point mensuel. Mesurer : tâches de recherche réellement accomplies, abandons, temps d'installation.
4. **Ouvrir un dialogue avec l'équipe Tropy (C²DH, Digital Scholar)** avant tout effort de visibilité. C'est le meilleur levier de légitimité et le plus proche institutionnellement.
5. **Étape 2, seulement après la réécriture et seulement si la demande existe :**
   - des unités qui n'exigent pas de relecture du noyau : études de cas, corpus d'évaluation, gabarits ;
   - des serveurs MCP tiers sans catalogue officiel.
   - Ne pas créer de « dépôt de connecteurs » relu par le mainteneur : Zotero et Obsidian montrent le coût d'un tel dépôt.
6. **Étape 3 :** pas d'annonce publique (HN, Reddit, Mastodon large) avant une installation en un clic et un cas d'usage complet documenté. ArtCraft montre ce qui arrive sinon.
7. **Critères d'arrêt ou de pivot fondés sur l'usage.** Exemples : moins de 3 co-testeurs actifs après 6 mois ; aucun cas d'usage publié ; plafond horaire dépassé trois mois de suite. Ne pas utiliser les étoiles.
8. **Réduire le facteur bus dès maintenant** (leçon de Voyant) : documentation d'architecture, journal de décisions, scripts de construction reproductibles. C'est aussi ce qu'un audit financé demandera.

## Caveats

- **Sources ArtCraft.** Les citations Hacker News viennent d'extraits de moteurs de recherche, la page étant bloquée. Le message Reddit original et getartcraft.com n'ont pas été consultés en entier. Les données sur le financement par crédits viennent de la presse et le chiffre de revenus n'est pas vérifié.
- **Chiffres GitHub.** Les compteurs évoluent d'heure en heure et divergent entre sources (cache, agrégateurs). Ils sont datés ici au 15 octobre 2026 et doivent être relevés à nouveau avant publication.
- **Chiffres d'usage.** Les nombres d'utilisateurs (Zotero « plus de 20 millions », Voyant « environ 200 000 ») sont des affirmations de parties prenantes ou de sources secondaires.
- **Cas non vérifiés.** Pandoc, AntConc, Logseq, Quarto, Hypothesis et Mirador/IIIF n'ont pas été vérifiés et ne doivent pas être cités sans recherche complémentaire. *Roads and Bridges* (Ford Foundation, 2016) n'a pas été revérifié en source primaire.
- **Design partners.** Aucune étude empirique sur les stratégies de co-testeurs restreints dans les outils académiques n'a été trouvée. L'étape 1 repose sur une inférence raisonnable, pas sur une preuve.
- **Liens.** La liste des sources et des liens sera ajoutée par la passe de citation.

## Sources

1. [The Muscle Memory](https://thesynthesisai.substack.com/p/the-muscle-memory)
2. [photocraft/docs/target-app-parity.md at main · storytold/photocraft](https://github.com/storytold/photocraft/blob/main/docs/target-app-parity.md)
3. [storytold/photocraft - 56.8k Stars · Global Rank #416](https://www.star-history.com/storytold/photocraft/)
4. [storytold/photocraft — Repoburst](https://www.repoburst.com/repo/storytold/photocraft)
5. [GitHub - storytold/photocraft: PhotoCraft: An open-source, photo editor written by scratch in pure Rust](https://github.com/storytold/photocraft)
6. [ArtCraft Apps](https://news.ycombinator.com/item?id=49958850)
7. [Releases · storytold/photocraft](https://github.com/storytold/photocraft/releases)
8. [Creating a New Style - Zotero Forums](https://forums.zotero.org/discussion/119842/)
9. [Catching up with calibre \[LWN.net\]](https://lwn.net/Articles/1015226/)
10. [project-types.github.io](https://project-types.github.io/)
11. [Working in Public by Nadia Eghbal: Summary & Discussion Questions](https://superbook.ai/books/working-in-public)
12. [Working in Public: The Making and Maintenance of Open Source Software by Nadia Eghbal](https://blas.com/working-in-public/)
13. [Working in Public: The Making and Maintenance of Modern Open Source Software — Nadia Eghbal](https://inigomedina.co/library/work/eghbal-working-in-public)
14. [netbox/CONTRIBUTING.md at main · netbox-community/netbox](https://github.com/netbox-community/netbox/blob/main/CONTRIBUTING.md)
15. [Working in Public: The Making and Maintenance of Open Source Software Summary, Quote & Book Review](https://www.befreed.ai/book/working-in-public-by-nadia-eghbal)
16. [echelon (Brandon Thomas) · GitHub](https://github.com/echelon)
17. [ArtCraft: official social media accounts — Verified Handles](https://verifiedhandles.org/ArtCraft)
18. [ArtCraft Releases Free Open-Source Adobe Alternatives](https://www.cined.com/artcraft-releases-free-open-source-adobe-alternatives-filmcraft-for-premiere-pro-effectcraft-for-after-effects-written-in-rust-with-ai/)
19. [Developer Releases Seven Free Adobe Clones Built With Claude Opus 5.5](https://pasqualepillitteri.it/en/news/21619/free-adobe-clones-artcraft-claude-opus-5-5)
20. [Creator of free Adobe clones unveils open-source Microsoft Office Excel, PowerPoint, and Word replications — Autodesk tools and other subscription-based services may come next](https://www.tomshardware.com/software/microsoft-office/creator-of-free-adobe-clones-unveils-open-source-microsoft-office-excel-powerpoint-and-word-replications-autodesk-tools-and-other-subscription-based-services-may-come-next)
21. [Haha, I wasn't ready to post this to HN. It's not anywhere close to ready. But t...](https://news.ycombinator.com/item?id=49959605)
22. [photocraft/AGENTS.md at main · storytold/photocraft](https://github.com/storytold/photocraft/blob/main/AGENTS.md)
23. [photocraft/ROADMAP.md at main · storytold/photocraft](https://github.com/storytold/photocraft/blob/main/ROADMAP.md)
24. [Progress docs standard: ROADMAP, target-app parity, gaps, per-dimension parity docs by echelon · Pull Request #2696 · storytold/photocraft](https://github.com/storytold/photocraft/pull/2696)
25. [The Adobe clones are real, but so is the work left to finish them - Digital Trends](https://www.digitaltrends.com/computing/artcraft-free-adobe-clones-have-promise-but-are-they-ready/)
26. [docs: clarify task reading and performance reporting by ha1des · Pull Request #2174 · storytold/photocraft · GitHub](https://github.com/storytold/photocraft/pull/2174)
27. [docs: craftrules is not public — say so instead of linking it (#493) by bfenty · Pull Request #779 · storytold/photocraft](https://github.com/storytold/photocraft/pull/779)
28. [fix(docs): contributor docs send readers to \`storytold/craftrules\`, which returns 404 to the public · Issue #493 · storytold/photocraft](https://github.com/storytold/photocraft/issues/493)
29. [fix(docs): the roadmap calls the Pencil, Mixer Brush and Patch tools missing although the scorecard marks them done · Issue #997 · storytold/photocraft](https://github.com/storytold/photocraft/issues/997)
30. [The Slow Formation of Durable Software](https://newsletter.dancohen.org/archive/the-slow-formation-of-durable-software/)
31. [Zotero](https://www.zotero.org/about/)
32. [Corporation for Digital Scholarship](https://en.wikipedia.org/wiki/Corporation_for_Digital_Scholarship)
33. [Zotero](https://rrchnm.org/portfolio-item/zotero/)
34. [About - Citation Style Language](https://citationstyles.org/about/)
35. [Zotero Blog » CSL](https://www.zotero.org/blog/category/csl/)
36. [Zotero Translators](https://www.zotero.org/support/dev/translators)
37. [GitHub - zotero/translators: Zotero Translators · GitHub](https://github.com/zotero/translators)
38. [Does Zotero even want people to contribute and support it? - Zotero Forums](https://forums.zotero.org/discussion/comment/501480/)
39. [Pull requests · zotero/translators · GitHub](https://github.com/zotero/translators/pulls)
40. [Solution: Tropy](https://infrafinder.investinopen.org/solutions/tropy)
41. [Hello Tropy (soon) - Quintessence of Ham](https://quintessenceofham.org/2015/10/02/hello-tropy-soon/)
42. [Explore your research photos](https://tropy.org/)
43. [Donations FAQ](https://tropy.org/donations-faq.html)
44. [1 Annual Report 2024](https://digitalscholar.org/assets/downloads/Annual-Report-2024.pdf)
45. [Omeka - Project](https://omeka.org/about/project/)
46. [Building Open Infrastructure That Lasts: A Spotlight on Digital Scholar](https://investinopen.org/blog/digital-scholar-building-infrastructure/)
47. [An interview with Kovid Goyal of calibre \[LWN.net\]](https://lwn.net/Articles/456076/)
48. [A thank you to Kovid Goyal - MobileRead Forums](https://www.mobileread.com/forums/showthread.php?p=4456377)
49. [Several plugins no longer work in Calibre 8.12 · Issue #131 · kiwidude68/calibre\_plugins](https://github.com/kiwidude68/calibre_plugins/issues/131)
50. [Sponsor @nathanlesage on GitHub Sponsors · GitHub](https://github.com/sponsors/nathanlesage)
51. [Zettlr: note-taking and publishing with Markdown \[LWN.net\]](https://lwn.net/Articles/984502/)
52. [History](https://www.zettlr.com/history)
53. [Download](https://www.zettlr.com/download)
54. [Supporters](https://www.zettlr.com/supporters)
55. [Releases · Zettlr/Zettlr](https://github.com/Zettlr/Zettlr/releases)
56. [Text Analysis Tools and Infrastructure in 2024 and Beyond](https://odh.byu.edu/wp-content/uploads/Rockwell-Voyant.pdf)
57. [GitHub - sgsinclair/Voyant · GitHub](https://github.com/sgsinclair/Voyant)
58. [In Memoriam: Stéfan Sinclair (1972-2020) - McGill Reporter](https://reporter.mcgill.ca/in-memoriam-stefan-sinclair-1972-2020/)
59. [Building a Sustainable Consortium](https://voyant-tools.info/2025/07/24/building-a-sustainable-consortium/)
60. [Critical Review of Voyant Tools](https://shannonmels.com/year-i/digital-humanities/critical-review-of-voyant-tools/)
61. [OpenRefine Project History](https://openrefine.org/openrefine_history)
62. [A Governance Model for OpenRefine](https://openrefine.org/blog/2014/04/27/a_governance_model_for_OpenRefine.html)
63. [Funding](https://openrefine.org/funding)
64. [OpenRefine funded to improve its reproducibility](https://openrefine.org/blog/2022/12/30/eoss5)
65. [OpenRefine funded by the Chan Zuckerberg Initiative as an Essential Open Source Software for Science](https://openrefine.org/blog/2019/11/14/2019-11-14)
66. [\[Closed\] Help us write OpenRefine's new documentation](https://openrefine.org/blog/2020/04/23/documentation-hire.html)
67. [OpenRefine in 2025: A Year in Review](https://openrefine.org/blog/2025/12/17/year-in-review-2025)
68. [obsidian releases](https://github.com/dimava/obsidian-releases)
69. [The future of Obsidian plugins](https://obsidian.md/blog/future-of-plugins/)
70. [Recurrent: Why does it take so long to review plugins? What's the usual time it takes to review a new plugin? How long does it take to review a plugin? - Page 2 - Devs: Plugins & API - Obsidian Forum](https://forum.obsidian.md/t/recurrent-why-does-it-take-so-long-to-review-plugins-whats-the-usual-time-it-takes-to-review-a-new-plugin-how-long-does-it-take-to-review-a-plugin/107899?page=2)
71. [May 10, 2026 - Jim Mitchell](https://jimmitchell.org/2026/05/10/99/)
72. [Sustaining the Digital Humanities - Ithaka S+R](https://sr.ithaka.org/publications/sustaining-the-digital-humanities/)
73. [Index of DH Conferences - "What ever happened to Project Bamboo?"](https://dh-abstracts.library.virginia.edu/works/1805)
74. [Data: Bamboo and scholarly narratives - Quinn Daedal](https://quinndaedal.com/projects/project-bamboo/data/bamboo-and-scholarly-narratives/)
75. [What Ever Happened to Project Bamboo?](https://escholarship.org/uc/item/6jq660tm)
76. [Towards a Taxonomy of Failure - Quinn Dombrowski](https://quinndombrowski.com/blog/2019/01/30/towards-taxonomy-failure/)
77. [2024-tidelift-state-of-the-open-source-maintainer-report-.pdf](https://assets-eu-01.kc-usercontent.com/ef593040-b591-0198-9506-ed88b30bc023/d325a56f-05be-4379-bfd1-ee4776fcad41/2024-tidelift-state-of-the-open-source-maintainer-report-.pdf)
78. [The open/closed equilibrium · GitHub](https://github.com/readme/podcast/open-closed-equilibrium)
79. [SQLite Copyright](https://sqlite.org/copyright.html)
80. [Can't stop, won't stop, GameStop. \[The Stack Overflow Podcast\]](https://www.devshows.dev/podcasts/the-stack-overflow-podcast/cant-stop-wont-stop-gamestop)
81. [github.com-benbjohnson-litestream\_-\_2022-05-10\_14-48-49 : benbjohnson : Free Download, Borrow, and Streaming : Internet Archive](https://archive.org/details/github.com-benbjohnson-litestream_-_2022-05-10_14-48-49)
82. [Non-code contributions are the secret to open source success · GitHub](https://github.com/readme/featured/open-source-non-code-contributions)
