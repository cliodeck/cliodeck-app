# Campagne de tests de la rc.6

> Plan du cycle rc.6 : **aucune nouvelle fonctionnalité**, des tests humains
> aussi intenses que le permet un testeur unique (≈ 1 h par jour), et la
> migration `pdfjs-dist` (#77, faite : 5.7, PR #110). Suivi au jour le jour : le ticket
> « Campagne de tests rc.6 » ; chaque défaut trouvé devient un ticket
> étiqueté `rc6-test`.

## Pourquoi cette forme

Presque tous les défauts du cycle rc.5 ont été trouvés **en travaillant sur
un vrai projet**, et presque tous étaient **silencieux** : 221 documents pour
55 PDF, un OCR de 24 h jeté, une bibliographie à 70/69/67 entrées. Rien ne
plantait ; le résultat était faux et plausible. La campagne vise donc ces
défauts-là, et répartit le travail :

- **la machine** fait ce qui est mécanique — cliquer, relancer, compter,
  comparer (tests e2e Playwright, bilan de santé, comparaison d'extraction) ;
- **le testeur** juge ce que seul un historien peut juger — fidélité d'une
  réponse à sa source, justesse d'une bibliographie, sens d'un parcours.

## Périmètre de la rc.6

1. **#77 — `pdfjs-dist` 3.11 → 5.7 — fait (PR #110)**, en début de cycle pour
   que toute la campagne le couvre. Sur 44 PDF réels, texte identique
   caractère pour caractère hors espaces ; un test garde l'invariant « jamais
   de `page.render()` ». Au passage, le worker d'extraction tourne sur le Node
   d'Electron : sans Node installé sur la machine, aucun PDF ne s'indexait.
2. **Dettes de sécurité déjà listées** (`status-and-remaining-work.md` §2) :
   n° 17 (consentement cloud vérifié côté renderer seulement), n° 16 (pas
   d'avertissement quand les clés tombent en clair) ; n° 18 (validation IPC) si
   le temps le permet.
3. **Restes de la rc.5** : re-mesure des extraits sans embedding (144 relevés
   en mai 2026). Linux arm64 n'est plus fourni (décision du 2026-09-15 : très
   peu d'utilisateurs, et un binaire construit hors arm64 y embarque un
   `hnswlib-node` de la mauvaise architecture).

Tout le reste — y compris une idée excellente trouvée en testant — va au
cycle suivant.

## Calendrier (≈ 4 semaines)

| Semaine | Développement | Testeur (1 h/jour) |
|---|---|---|
| 1 | pdfjs 5.7 (fait) ; bilan de santé ; e2e étendus → build **rc.6-beta** | sur la **rc.5** publiée : missions 1 (Mac et Linux) et 9 ; recrutement des collègues |
| 2–3 | tri et corrections au fil de l'eau, une beta par lot | une mission par jour sur la rc.6-beta : 2 à 8, puis 10 ; mission 3 aussi sur Linux |
| 4 | corrections finales, build candidat | repasse accélérée (≈ 20 min par mission) ; séances collègues |

## Règles

1. **Toujours sur une copie** pour les missions destructrices (6, 10) et pour
   tout ce qui tourne sur une beta : dupliquer le dossier du projet, travailler
   sur la copie. Le projet vivant reste sur la dernière version publiée.
2. **Ne rien rédiger pendant une séance.** Une ligne et une capture dans un
   dossier suffisent ; la note se fait à la fin (modèle ci-dessous).
3. **Le tri n'est pas au testeur** : reproduction, ticket, test de
   non-régression et correction sont du côté développement.
4. **Chaque défaut corrigé reçoit un test** qui échouait avant la correction.

## Le bilan de santé d'un projet

Script en lecture seule, à lancer **après chaque séance** sur le projet
utilisé :

```
npm run project:health -- /chemin/vers/le/projet        # lisible
npm run project:health -- /chemin/vers/le/projet --json # pour joindre à un ticket
```

Il vérifie des invariants — ce qui doit être égal l'est-il ?

- PDF présents sur le disque = documents dans `brain.db`, **un par fichier**,
  et le fichier de chaque document existe encore ;
- aucun extrait sans embedding, dans aucun corpus, aucun extrait orphelin,
  aucun document sans extrait ;
- clés du `.bib` uniques et acceptables par pandoc ; fiches de métadonnées
  rattachées à une entrée existante ;
- une seule ligne par projet Tropy lié, et chaque source transcrite a
  **encore** ses extraits ;
- chaque note de lecture et chaque pièce du manuscrit est indexée, à
  l'empreinte du texte présent sur le disque ;
- les index HNSW correspondent aux extraits de la base.

Il ne lit pas Zotero : la comparaison « collection Zotero = `.bib` » reste à
faire à l'œil pendant la mission 2.

Trois niveaux : `✓` l'invariant tient, `⚠` un écart — pas forcément un bug,
mais il faut une explication, et le script en propose une quand elle est
connue —, `·` une information. Le code de sortie vaut 1 s'il reste un écart.

**Lecture seule stricte** : la base est ouverte en mode `immutable`, donc sans
même créer les fichiers `-wal` / `-shm` à côté. On peut le lancer sur le projet
vivant sans rien risquer.

## Les tests e2e (machine)

`npm run test:e2e` lance l'application réelle (Playwright + Electron) sur cinq
parcours, en une dizaine de secondes : démarrage, barre des modes, réglages en
mode expert, **extraction d'un PDF par le worker isolé** et **texte tapé puis
enregistré qui atteint `document.md`**. Les deux derniers couvrent les chemins
où des données ont déjà été perdues.

La CI ne les exécute pas (pas d'affichage) : c'est ainsi que deux d'entre eux
sont restés rouges des mois. À lancer donc en local après tout changement
d'interface, et au moins une fois avant chaque beta.

## Modèle de note de séance

Un commentaire sur le ticket de suivi :

```
Mission n° — titre · build (rc.5 / rc.6-beta.N) · OS · projet (copie de …)
Fait : …
Surpris par : …
Cassé : … (captures jointes)
Bilan de santé : propre / écarts : …
```

## Les missions

Classées par risque : défaut silencieux ou perte de données × fréquence
d'usage × ampleur des changements depuis la rc.4. Chaque mission dit **ce
qu'il faut faire**, **ce qui doit être vrai** et **ce que seul le testeur peut
juger**.

### 1. Installation neuve

*Mac (compte macOS vierge, créé pour l'occasion) et Linux x86_64.*

- Télécharger le DMG / l'AppImage depuis la page de release (pas une copie
  locale : la quarantaine doit s'appliquer).
- Premier lancement : Gatekeeper, demande d'accès au trousseau (Mac).
- Sans Ollama : télécharger le modèle embarqué depuis les réglages, créer un
  projet article, écrire un paragraphe, poser une question.

**Doit être vrai** : aucune alerte « développeur non identifié » ; aucune
étape nécessitant le terminal ; un message compréhensible à chaque attente.
**À juger** : un historien qui découvre l'app s'en sortirait-il seul ? Noter
chaque endroit où l'on hésite.

### 2. Zotero sur la collection la plus désordonnée

- Synchroniser une collection réelle avec sous-collections, doublons, livres
  dirigés, articles de presse, pages web.
- Modifier une notice dans Zotero, en retirer une de la collection,
  resynchroniser.
- Citer cinq références dans un texte, exporter en PDF.

**Doit être vrai** : bilan de santé Zotero = `.bib` = fiches ; une
resynchronisation immédiate ne trouve rien à changer ; la suppression demande
confirmation ; pandoc accepte le `.bib`.
**À juger** : la bibliographie imprimée est-elle *juste* (auteurs, directeurs,
titres courts, URL, DOI, types) ?

### 3. PDF : indexer, réindexer, supprimer

*Mac, puis Linux x86_64. Couvre directement la migration pdfjs 5.7 et le
worker sur le Node d'Electron — c'est aussi la première exécution réelle
d'une app x86_64 depuis ce changement.*

- Indexer une dizaine de PDF variés : scanné, OCRisé, colonnes, notes de bas
  de page, non latin, protégé, très long.
- En réindexer trois ; en supprimer deux ; relancer l'app ; rechercher.

**Doit être vrai** : N fichiers = N documents ; aucun extrait orphelin après
suppression ; la recherche ne renvoie jamais un document supprimé.
**À juger** : l'extrait cité correspond-il au passage de la page ? Le texte
d'un PDF difficile est-il lisible ?

### 4. Tropy

Le corpus réel ne permet pas de relancer un OCR en une heure : dans
`AnalyseDDF`, les 25 sources sont des volumes entiers des *Documents
diplomatiques français* (770 à 1 142 pages, 2 à 3 millions de caractères chacun,
40 648 extraits). La mission se joue donc en deux temps. ClioDeck n'ouvre le
`.tpy` qu'en **lecture seule** : une copie du projet ClioDeck peut se
synchroniser sur le vrai projet Tropy sans rien y écrire.

#### 4a. Le grand corpus ne perd rien

*Copie du dossier `AnalyseDDF` (≈ 410 Mo), liée au vrai `ddf_archives.tropy`,
sans rien modifier dans Tropy.*

- Bilan de santé avant : noter sources, transcriptions, extraits.
- Resynchroniser sans rien changer ; quitter l'app ; relancer ; resynchroniser.
- Poser trois questions dont la réponse est dans un volume précis.

**Doit être vrai** : la resynchronisation ne relance **aucun** OCR (elle doit
durer des secondes, pas des heures) ; 25 sources, 25 transcriptions, 40 648
extraits avant comme après ; une seule ligne de projet Tropy à la fin (la
copie actuelle en a deux, héritées de synchronisations sous la rc.4 — la
première synchronisation doit les fondre).
**À juger** : l'assistant cite-t-il le bon volume, la bonne page ?

#### 4b. Le cycle OCR sur un mini-projet

*Un projet Tropy créé pour l'occasion : 3 à 5 documents de quelques pages
chacun (scans ou photos), et un projet ClioDeck neuf qui le lie.*

- Synchroniser avec OCR ; quitter ; relancer ; resynchroniser.
- Modifier un item dans Tropy (métadonnée, puis ajout d'une photo),
  resynchroniser.
- Relancer l'OCR sur une seule source.
- **Tuer l'app pendant un OCR**, relancer, resynchroniser.

**Doit être vrai** : chaque transcription survit aux relances ; seule la source
modifiée est retraitée ; un OCR vide n'écrase pas une transcription existante ;
après l'arrêt brutal, rien n'est à moitié écrit (une source a sa transcription
et ses extraits, ou elle est reprise).
**À juger** : qualité des transcriptions, pertinence des sources retrouvées
par l'assistant.

### 5. Fidélité des réponses

- Préparer **dix questions dont la réponse est connue** et localisable dans le
  corpus (sources secondaires, primaires, notes, manuscrit).
- Les poser avec un modèle local, puis avec un modèle cloud.

**Doit être vrai** : chaque citation renvoie à un extrait existant ; le
corpus d'origine est correctement étiqueté (`manuscrit` jamais présenté comme
bibliographie).
**À juger** — le cœur de la campagne : la citation est-elle réelle, fidèle,
bien attribuée ? La réponse invente-t-elle ? Compter, sur dix : exactes,
approximatives, fausses.

### 6. Livre et exports

*En copie.*

- Créer, renommer, réordonner des chapitres ; notes de bas de page dans
  plusieurs chapitres.
- **Tuer l'app** (Moniteur d'activité / `kill -9`) juste après avoir tapé une
  phrase, relancer.
- Exporter en PDF et en Word, avec notes de bas de page puis de fin.

**Doit être vrai** : la phrase tapée avant l'arrêt brutal est là, ou l'app
dit clairement ce qui a été perdu ; aucune note ne prend le texte d'une autre
dans l'export ; aucun paragraphe ne manque.
**À juger** : l'export est-il présentable tel quel pour un éditeur ?

### 7. Notes de lecture et cinquième corpus

- Écrire des notes de lecture sur cinq références, avec étiquettes.
- Interroger l'assistant sur leur contenu ; basculer vers un modèle cloud
  sans consentement, puis avec.

**Doit être vrai** : sans consentement, aucune note ne part vers le cloud ;
une note modifiée est réindexée ; les tags Zotero restent en lecture seule.
**À juger** : l'assistant retrouve-t-il ce qui a été noté, et le distingue-t-il
de la source elle-même ?

### 8. Modèles locaux

- Un gros modèle (proche de la limite mémoire), un modèle pensant (Qwen 3.x),
  une très longue question.
- Couper le réseau / arrêter Ollama en pleine réponse.

**Doit être vrai** : aucune attente muette ; le raisonnement s'affiche ; une
panne produit un message, pas un blocage.
**À juger** : les messages d'attente et d'erreur sont-ils compréhensibles pour
un non-informaticien ?

### 9. Serveur MCP

- Installer l'extension dans Claude Desktop (bouton en un clic), activer
  quelques outils, interroger le corpus depuis Claude Desktop.
- Faire de même avec la commande Claude Code.

**Doit être vrai** : un outil désactivé est invisible du client ; la lecture
du manuscrit n'est possible qu'après activation.
**À juger** : l'utilité réelle depuis l'extérieur.

### 10. Mauvais traitements

*En copie, uniquement.*

- Ouvrir une copie d'un projet créé avec la rc.3 ou la rc.4.
- Renommer ou déplacer le dossier du projet, puis le rouvrir.
- Tuer l'app pendant une indexation PDF, puis pendant une synchronisation.
- Noms de fichiers en Unicode, espaces, apostrophes typographiques.

**Doit être vrai** : migration sans perte ; reprise propre après arrêt brutal ;
bilan de santé propre ou écarts expliqués.

## Séances avec des collègues

Un regard neuf trouve ce que le concepteur contourne sans le voir. 30 minutes,
une personne à la fois.

**Préparation** : un Mac ou un PC avec la version à tester installée, un
compte Zotero ou un petit `.bib` à disposition, ces trois tâches imprimées :

1. Créer un projet pour un article et y importer sa bibliographie.
2. Ajouter deux PDF et demander à l'assistant ce qu'ils disent d'un thème
   choisi par la personne.
3. Écrire un paragraphe qui cite une référence, puis l'exporter.

**Règles d'observation** : la personne pense à voix haute ; l'observateur
**n'aide pas** et ne corrige pas — il note chaque hésitation, fausse piste et
formulation incomprise, avec l'heure. S'il y a blocage complet au bout de
trois minutes, on passe à la tâche suivante (et le blocage est le résultat).

**Cinq questions à la fin** :

1. Qu'est-ce qui vous a le plus gêné ?
2. À quel moment avez-vous douté de ce que l'application affichait ?
3. Qu'attendiez-vous qui ne s'est pas produit ?
4. Utiliseriez-vous l'assistant pour un vrai travail ? Pourquoi ?
5. Qu'expliqueriez-vous à un collègue avant qu'il l'essaie ?

## Critères de sortie de la rc.6

- toutes les missions jouées au moins une fois sur un build contenant pdfjs 5.7,
  et repassées sur le build candidat ;
- **zéro** ticket `rc6-test` ouvert de type perte de données ou résultat faux
  silencieux ;
- bilan de santé propre (ou écarts expliqués) sur les projets réels utilisés ;
- suites vitest, `test:integration` et e2e vertes ;
- chaque défaut corrigé couvert par un test.
