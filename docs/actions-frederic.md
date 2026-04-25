# Actions Frédéric — pas-à-pas des interventions humaines

**Contexte** : document annexe de `docs/plan-post-fusion.md`. Ici, *uniquement* les étapes où ton intervention personnelle est nécessaire — parce qu'elles relèvent d'une décision produit, d'un input disciplinaire, d'une obtention de clé/certificat, ou d'un arbitrage que je ne peux pas prendre à ta place.

**Règle** : pour chaque item, je te donne **pourquoi** on te sollicite, **quoi décider / fournir**, **quand** (avant quelle phase), et **combien de temps** ça risque de prendre. L'ordre suit la roadmap, donc tu peux lire de haut en bas et agir au fur et à mesure.

---

## Phase 0 — À faire avant toute implémentation

### A1. Retirer `--no-sandbox` de `npm start`
- **Pourquoi** : `package.json:35` lance Electron avec `--no-sandbox`, ce qui annule le `sandbox: true` du `webPreferences`. Faille HIGH — un dev qui `npm start` puis démontre à un chercheur montre une app non-sandboxée. Le jour où cette ligne atterrit dans un script d'install, c'est catastrophique.
- **À décider** : ok pour retirer et accepter une friction éventuelle en dev Linux (le setuid chrome-sandbox n'existe pas toujours par défaut sur certaines distros). Si problème, on peut documenter un workaround par-profil dans `docs/dev-setup.md` au lieu de mettre le hack dans `package.json`.
- **Quand** : maintenant, avant Phase 0.
- **Temps** : 2 minutes pour ta décision. Si tu valides, je fais la modif et teste.
- **Référence** : Plan Phase 0 item 0.2.

### A2. Mode par défaut du `SourceInspector` : `warn` ou `block` ?
- **Pourquoi** : `SourceInspector` détecte les patterns de prompt-injection dans les chunks RAG entrants (PDFs, notes Obsidian, items Tropy). Trois modes possibles :
  - `warn` : laisse passer, consigne l'événement dans `security-events.jsonl`, affiche un badge dans l'UI.
  - `block` : rejette le chunk avant injection dans le prompt LLM.
  - `audit` : hybride, bloque seulement si `severity === 'high'`.
- **Tension spécifique à ta discipline** : les sources historiques primaires *peuvent légitimement* contenir des directives impératives (correspondances, discours politiques, journaux intimes, correspondance Zola/Dreyfus, tracts). `block` à l'aveugle rejettera à tort des chunks légitimes.
- **À décider** : choix du défaut. **Recommandation** : `warn` par défaut, `block` opt-in pour utilisateur averti, option `audit` sur `severity: 'high'` si tu veux un compromis.
- **Quand** : avant Phase 0.4.
- **Temps** : décision 10 minutes une fois que tu as relu 2-3 patterns détectés (je peux te montrer un exemple).
- **Référence** : Plan Phase 0 item 0.4.

### A3. Obtenir une clé API Europeana (gratuite)
- **Pourquoi** : `searchEuropeana.ts` est écrit mais pas enregistré parce qu'il faut une clé `wskey`. Gratuit, 10 req/s par clé, 1 minute d'inscription.
- **Quoi faire** : aller sur <https://pro.europeana.eu/pages/get-api>, créer un compte, noter la clé.
- **Quand** : avant Phase 0.7.
- **Temps** : 5 minutes.
- **Une fois obtenue** : tu me donnes la clé, je la stocke via `secureStorage` et j'enregistre le tool dans `server.ts`. Ne **jamais** la coller dans un commit ou dans `config.json`.
- **Référence** : Plan Phase 0 item 0.7.

---

## Phase 1 — Compléter la fusion technique

### A4. Upgrade Electron 28 → 34+ : budget temps pour tester UX post-upgrade
- **Pourquoi** : Electron 28 = Chromium ~120 (sorti fin 2023) + Node 18 EOL. En avril 2026, c'est des années de CVE non patchées sur une app qui ingère PDF / OCR / HTML.
- **Risques connus de l'upgrade** :
  - `better-sqlite3`, `hnswlib-node`, `node-llama-cpp` doivent être rebuildés contre la nouvelle ABI Electron.
  - Le comportement de `contextBridge` / `webContents` peut avoir évolué (rare mais possible).
  - Milkdown / Monaco peuvent se comporter différemment avec un V8 plus récent.
- **À fournir** : 1 à 3 sessions de test manuel end-to-end après l'upgrade — ouvrir un projet, brainstormer, écrire, exporter, indexer Tropy, tester les 5 providers LLM.
- **Quand** : Phase 1.1.
- **Temps** : 2-4 heures réparties sur 2-3 jours.
- **Référence** : Plan Phase 1 item 1.1.

### A5. Validation impact suppression `OllamaClient.ts` + `LLMProviderManager.ts`
- **Pourquoi** : ces deux fichiers (1636 LOC cumulées) sont du code legacy qui devrait disparaître pour respecter la promesse « registry provider unique ». Mais ils sont utilisés par `DocumentSummarizer`, `TropySync`, `NERService`, `similarity-service`, `pdf-service`. La migration est large.
- **À décider / tester** :
  1. Lancer les workflows concrets qui utilisent ces services : indexer un PDF, synchroniser un projet Tropy, générer un résumé, lancer NER sur corpus.
  2. Valider que le routage via la registry donne des résultats équivalents (pas d'hallucinations nouvelles, pas de régression de qualité).
  3. Si régression détectée → on garde un compat layer temporaire ou on investigue.
- **Quand** : Phase 1.2.
- **Temps** : 1 session de 1-2h de test après ma migration (je te liste les cas à tester).
- **Référence** : Plan Phase 1 item 1.2.

### A6. Décider des contextes par modèle pour `ContextCompactor`
- **Pourquoi** : le compactor sait quand compresser, il a besoin de savoir combien — c'est-à-dire le `contextWindow` de chaque modèle. Question : où stocker cette table ?
  - **Option A** : hardcodée dans `backend/core/llm/providers/*.ts` avec `capabilities.contextWindow` (charge maintenance pour toi à chaque sortie de modèle).
  - **Option B** : exposée dans `.cliodeck/v2/config.json` pour édition utilisateur (plus flexible, mais exposé à des erreurs).
  - **Option C** : hardcoded avec override possible via config (compromis).
- **Valeurs indicatives à couvrir** : Claude Opus 4.7 (1M), Sonnet 4.6 (200k ou 1M), GPT-4o / 5 (128k), Mistral Large (128k), Gemini 2.0 (2M), Llama 3.2 (8k), Qwen 2.5 (32k-128k selon variante).
- **À décider** : A, B, ou C.
- **Quand** : Phase 1.3.
- **Temps** : 15 minutes de décision ; si Option A je fais une PR avec la table et tu relis.
- **Référence** : Plan Phase 1 item 1.3.

### A7. Valider les traductions EN des 5 sections fusion
- **Pourquoi** : `VaultConfigSection`, `WorkspaceHintsSection`, `RecipesSection`, `MCPClientsSection`, `RecipeRunModal` ont toutes leurs labels en français dur dans le code. Je vais générer les clés `common.json` EN, mais j'aurai besoin que tu relises — plusieurs termes sont du jargon ClioDeck (ex. « Détacher un vault » vs « Unlink vault »).
- **À fournir** : 1 relecture des ~40-60 nouvelles clés EN, corrections éventuelles.
- **Quand** : Phase 1.4.
- **Temps** : 30-45 minutes.
- **Référence** : Plan Phase 1 item 1.4.

### A8. OK pour migration automatique des secrets MCP au prochain `loadProject`
- **Pourquoi** : actuellement, `.cliodeck/v2/config.json` contient `mcpClients[].env[*]` en plaintext. Un historien qui aurait configuré un serveur MCP Transkribus avec son token l'a en clair dans un fichier potentiellement committé dans un repo Git du projet.
- **À décider** : acceptes-tu que l'app migre *automatiquement* au prochain chargement du projet (déplacement des env vars de `config.json` vers `secureStorage`, remplacement par des refs nommées), avec un toast informant l'utilisateur ? Alternative : obliger une action manuelle (« Migrer les secrets ») — plus explicite mais crée de la friction.
- **Quand** : Phase 1.5.
- **Temps** : 5 minutes de décision.
- **Référence** : Plan Phase 1 item 1.5.

### A9. Calibration Ollama tool-use par modèle
- **Pourquoi** : ADR 0004 reconnaît que `ollama.ts` force `capabilities.tools = false` pour tous les modèles, ce qui est grossier : `qwen2.5` et `llama3.1` 70B tiennent correctement le tool-use, pas les petits modèles. On veut une whitelist par modèle.
- **À fournir** : liste des modèles Ollama que *tu utilises réellement* (pas théoriquement) + pour chacun, tester si le tool-use tient sur un scénario Brainstorm simple (« cherche "Dreyfus" dans ma biblio » → doit appeler `search_documents`).
- **Quand** : Phase 1.8.
- **Temps** : 1h de test pour ~4-5 modèles.
- **Référence** : Plan Phase 1 item 1.8.

---

## Phase 2 — Identité du mode Brainstorm (décisions produit majeures)

### A10. Positionnement : Explorer vs Brainstorm vs Analyze
- **Pourquoi** : le doc stratégique (`docs/fusion-cliobrain-strategy.md:20`) décrit un cycle **Explorer → Brainstormer → Écrire → Exporter**. Mais `WorkspaceModeBar` a **Brainstorm / Write / Analyze / Export**. *Explorer* est invisible, et *Analyze* (textométrie/topics/similarité) s'y est substitué — deux concepts différents confondus dans la même case.
- **Options** :
  - **(a) Renommer Brainstorm → Explorer**, redéfinir son périmètre pour couvrir la phase amont du cycle. Garder *Analyze* comme mode outillé DH.
  - **(b) Ajouter un 5ᵉ mode Explorer** entre Brainstorm et Analyze. Plus fidèle au narratif mais plus d'UI à maintenir.
  - **(c) Accepter l'écart** et mettre à jour le doc stratégique pour refléter 4 modes **Brainstorm / Write / Analyze / Export**.
- **Recommandation du design spécialiste** : (a) — la plus parcimonieuse, mais elle impacte ta communication externe sur le positionnement.
- **À décider** : (a), (b), (c).
- **Quand** : avant Phase 2 (bloquant).
- **Temps** : 30 minutes de réflexion, idéalement discutée avec 1-2 historiens de ton réseau.
- **Référence** : Plan Phase 2 item 2.1.

### A11. Ambition du mode Brainstorm : que porte-t-on de ClioBrain ?
- **Pourquoi** : Brainstorm actuel = chat RAG stylé. Il ne délivre pas la promesse de la fusion (un utilisateur ClioBrain perd notes/idées/tags/relations contre juste « un chat »). Quelles features ClioBrain garder ?
- **Liste à shortlister** :
  1. **Objet idée/note persistant** — avec titre, tags, liens, origine (chat/import Obsidian/manuel).
  2. **Vue *board* / canvas 2D** — placement spatial des idées.
  3. **Graphe de connaissances dans Brainstorm** (pas seulement Analyze).
  4. **Tags et backlinks visibles** dans les sources.
  5. **NER highlighté** dans les réponses du chat.
  6. **Import complet des vaults Obsidian** avec tags comme entités de 1ʳᵉ classe.
- **À décider** : shortlist MVP pour v2.0 + items reportés à v2.1. Recommandation minimaliste : (1) + (3) + (4) pour la première vague, (2) + (5) + (6) pour la suivante.
- **Quand** : avant Phase 2.3 (le store `ideaStore` dépend de cette décision).
- **Temps** : 1-2h de réflexion + démarche idéalement avec un ex-utilisateur ClioBrain pour test utilisateur qualitatif.
- **Référence** : Plan Phase 2 item 2.2.

### A12. MCP tool-use dans Brainstorm : auto vs opt-in
- **Pourquoi** : quand un serveur MCP est `ready` (Gallica, HAL, Zotero local, serveur tiers), doit-il automatiquement proposer ses tools dans le chat Brainstorm ? Ou l'utilisateur active manuellement par tool ?
- **Tension** : auto-activate = puissant mais opaque (le modèle peut appeler un tool que l'utilisateur n'attendait pas) ; opt-in = explicite mais frictionnel.
- **Options** :
  - **(a) Auto-enable tous les tools `ready`** — l'utilisateur voit une liste et peut désactiver.
  - **(b) Opt-in par tool** — case à cocher, désactivé par défaut.
  - **(c) Auto-enable par *kind* de tool** (recherche ok par défaut, écriture/réseau opt-in).
- **Recommandation** : (c) — lecture seule automatique, écriture opt-in.
- **Quand** : Phase 2.5.
- **Temps** : 20 minutes.
- **Référence** : Plan Phase 2 item 2.5.

### A13. Pont Brainstorm → Write : où s'insère le draft ?
- **Pourquoi** : le bouton *Send to Write* appène actuellement le bloc en queue du document. Pas d'ancrage au curseur, pas d'undo, pas de retour Write→Brainstorm.
- **Options** :
  - **(a) Insertion à la position du curseur** dans l'éditeur Write.
  - **(b) Append en fin de document** (comportement actuel).
  - **(c) Panneau « Brouillons brainstorm »** en marge de l'éditeur — l'utilisateur glisse-dépose quand il veut.
- **Tension** : (a) = utile mais effet-de-bord surprenant si le curseur n'est pas visible ; (b) = simple mais sous-exploite la fonctionnalité ; (c) = le plus propre mais demande plus d'UI.
- **Recommandation** : (c) pour la cohérence UX, avec fallback (a) si le panneau est fermé.
- **À décider** : (a), (b), ou (c).
- **Quand** : Phase 2.6.
- **Temps** : 15 minutes.
- **Référence** : Plan Phase 2 item 2.6.

### A14. Forme d'édition des Recipes
- **Pourquoi** : les Recipes builtin sont en YAML dans `backend/recipes/builtin/*.yaml`. Côté UI, on doit permettre de dupliquer et éditer. Trois formes possibles :
  - **(a) Monaco avec validation YAML + Zod schema** — puissant pour power-user, intimidant pour chercheur non-technique.
  - **(b) Formulaire champ-par-champ** généré depuis le schéma — zéro friction pour non-technique, limitant pour power-user.
  - **(c) Texte simple (textarea) + preview** — compromis minimaliste.
- **Impact** : ~2 semaines de travail selon l'option, (a) > (c) > (b).
- **À décider** : (a), (b), (c) — dépend directement de ton persona cible (voir A17).
- **Quand** : Phase 2.7.
- **Temps** : 30 minutes.
- **Référence** : Plan Phase 2 item 2.7.

### A15. Niveau d'alarme `SourceInspector` dans l'UI
- **Pourquoi** : une fois `SourceInspector` câblé (A2), il génère des événements `security-events.jsonl`. Comment les surfacer dans l'UI ?
- **Options** :
  - **(a) Bannière intrusive** dans le chat quand une source est flaggée.
  - **(b) Badge discret** à côté de la source concernée + lien vers l'onglet Sécurité.
  - **(c) Tiroir Sécurité silencieux** — aucun effet sur le flow chat, l'utilisateur va voir s'il veut.
- **Tension** : (a) protège l'utilisateur non-averti mais casse la lecture ; (c) respecte le flow mais l'utilisateur ignore probablement ; (b) est l'équilibre.
- **Recommandation** : (b) pour la v2.0.
- **Quand** : Phase 2.8.
- **Temps** : 10 minutes.
- **Référence** : Plan Phase 2 item 2.8.

### A16. Contenu pédagogique first-run
- **Pourquoi** : aujourd'hui, ouverture d'une instance fraîche → mur blanc. On veut un onboarding guidé.
- **À fournir** :
  - **3-5 prompts exemples** adaptés à un historien (ex. « Résume les articles de ma biblio sur *sujet X* », « Compare les approches de *auteur A* et *auteur B* », « Liste les entités citées dans mon corpus Tropy »).
  - **Un fichier `hints.md` modèle** (1 page max) — exemple réaliste de consignes de projet : style de citation, langue de réponse, focus disciplinaire.
  - **Une recipe d'introduction** — quelque chose qui montre la puissance sans noyer.
- **Pourquoi toi** : tu es le seul à avoir la légitimité disciplinaire historienne pour que ces exemples sonnent juste.
- **Quand** : Phase 2.9 / 2.10.
- **Temps** : 2-3 heures, idéalement réparties sur 2 sessions (rédaction puis relecture).
- **Référence** : Plan Phase 2 items 2.9, 2.10.

---

## Phase 3 — Qualité de code, accessibilité, polish

### A17. Persona cible prioritaire (arbitrage qui conditionne tout Settings)
- **Pourquoi** : le Settings a 378 lignes / 15 sections. Il sert aujourd'hui deux personas contradictoires :
  - **Persona A** : chercheur non-technique, veut écrire son article.
  - **Persona B** : power-user DH, veut HNSW + Louvain + MCP clients + tune chunking.
- **L'arbitrage détermine** : hiérarchie du Settings, niveau de jargon exposé, existence d'un mode « avancé », formulaire vs éditeur YAML pour Recipes (A14).
- **Options** :
  - **(a) Persona A prioritaire**, B accessible via « Paramètres avancés » (rideau).
  - **(b) Persona B prioritaire**, Settings complet visible — l'historien non-tech n'y touche pas.
  - **(c) Deux modes** explicites (« Paramètres simples » / « Paramètres experts »).
- **Recommandation** : (a) — ClioDeck promet une app pour historiens, pas pour DH engineers.
- **Quand** : Phase 3.4.
- **Temps** : 1h de réflexion.
- **Référence** : Plan Phase 3 item 3.4.

### A18. Status toasts : bloquants ou non ?
- **Pourquoi** : `notificationStore` + `<StatusToast>` va unifier les retours (vault indexed, recipe done, MCP reconnected). Certaines erreurs sont critiques (provider LLM down), d'autres transitoires (reconnexion MCP).
- **À décider** : doit-il y avoir des toasts bloquants (modale prenant le focus) pour les erreurs critiques, ou tout reste non-bloquant (disparaît après N secondes) ?
- **Recommandation** : tout non-bloquant, avec un bouton « Détails » qui ouvre un tiroir pour les erreurs critiques. Les modales bloquantes cassent le flow.
- **Quand** : Phase 3.5.
- **Temps** : 10 minutes.
- **Référence** : Plan Phase 3 item 3.5.

### A19. Déduplication Corpus Explorer
- **Pourquoi** : `CorpusExplorer` est monté à deux endroits : panneau droit (`MainLayout.tsx:278-312`) et mode Analyze (`AnalyzePanel.tsx:44`). Potentiellement visible deux fois simultanément. C'est hérité, pas volontaire.
- **À décider** : le garder côté **panneau droit** (toujours accessible) ou côté **mode Analyze** (cohérent avec le narratif) ?
- **Recommandation** : mode Analyze uniquement. Aligné avec le narratif, un seul endroit.
- **Quand** : Phase 3.6.
- **Temps** : 5 minutes.
- **Référence** : Plan Phase 3 item 3.6.

### A20. Dictionnaire FR→EN pour query expansion — public cible ?
- **Pourquoi** : `retrieval-service.ts:153-161` a 7 termes pédagogiques hardcodés (`taxonomie de bloom`, `zone proximale de développement`, etc.) pour l'expansion FR→EN. Ça sent le corpus-pédagogie, pas l'histoire générale.
- **À décider** :
  - **(a)** Corriger avec un dictionnaire spécifique histoire (« affaire Dreyfus » → « Dreyfus affair », etc.).
  - **(b)** Exposer en config workspace (`.cliohints`) — chaque projet a son lexique.
  - **(c)** Supprimer — laisser le modèle faire l'expansion.
- **Recommandation** : (b) — plus générique, pédagogiquement intéressant (l'historien peut ajouter ses termes).
- **Quand** : Phase 3.12.
- **Temps** : 20 minutes de décision + éventuellement rédaction d'une liste initiale.
- **Référence** : Plan Phase 3 item 3.12.

### A21. TTL rotation des logs d'audit
- **Pourquoi** : `mcp-access.jsonl` et `security-events.jsonl` croissent sans bornage. Sur un projet historien (5-10 ans), ça peut gonfler.
- **Options de TTL par défaut** : 30 jours / 90 jours / 365 jours / indéfini.
- **À décider** : valeur par défaut + option utilisateur.
- **Recommandation** : 90 jours par défaut, configurable 30-365, avec purge manuelle possible.
- **Quand** : Phase 3.14.
- **Temps** : 5 minutes.
- **Référence** : Plan Phase 3 item 3.14.

### A22. Terminologie « Workspace hints »
- **Pourquoi** : actuellement « Workspace hints » apparaît en anglais dans l'UI française. `.cliohints` est le nom technique du fichier.
- **À décider** : traduction FR ?
  - **(a)** « Consignes de projet » (instructif, clair)
  - **(b)** « Mémento » (concis, plus chaleureux)
  - **(c)** « Contexte projet » (neutre)
  - **(d)** Garder « Hints » (jargon ClioDeck, fait partie de l'identité produit)
- **Recommandation** : (a) pour clarté vs non-tech.
- **Quand** : Phase 3.15.
- **Temps** : 5 minutes.
- **Référence** : Plan Phase 3 item 3.15.

---

## Phase 4 — Release readiness

### A23. Décisions produit pour ADR 0005-0007
Trois ADRs à rédiger :

**ADR 0005 — Threat model**
- Actifs à protéger : corpus privé, hints, clés API, notes Obsidian.
- Adversaires pris en compte : contenu tiers hostile (PDF/note/MCP tool), provider cloud non-fiable.
- **Limites explicitement hors-scope** : (à décider)
  - Laptop volé — le disque n'est pas chiffré par ClioDeck ; OS-level.
  - Session OS partagée — hors scope.
  - Dépôt Git public qui committe `.cliodeck/v2/config.json` — partiel (secrets déjà via `secureStorage`).
- **À décider** : valider ces limites, en ajouter / retirer.

**ADR 0006 — Credential storage**
- Aujourd'hui : `secureStorage` via `safeStorage` Electron avec fallback plaintext loggé.
- **À décider** : politique d'acceptation du fallback plaintext (devrait-on refuser ? demander à l'utilisateur ?) + migration des workspaces existants (A8).

**ADR 0007 — Code signing & release supply chain**
- **À décider** : on signe ou non les builds macOS / Windows / Linux pour v2.0 ? (voir A24)

- **Quand** : Phase 4.1.
- **Temps** : 2-3 heures pour lire les brouillons que je ferai et valider / amender.
- **Référence** : Plan Phase 4 item 4.1.

### A24. Signature et notarization — budget et comptes
- **Pourquoi** : sans signature, les OS affichent des warnings (macOS : « app non vérifiée »), ce qui bloque l'adoption par les DSI universitaires.
- **Coûts annuels** :
  - **macOS** : compte développeur Apple = 99 USD/an.
  - **Windows** : certificat Authenticode EV ou standard = 300-500 USD/an selon CA.
  - **Linux AppImage** : clé GPG (gratuit mais à gérer).
- **À décider** : budget pour v2.0 ? Si oui, créer les comptes et fournir les certificats. Si non, assumer le warning OS dans la comm.
- **Quand** : Phase 4.2 (c'est le long pole — 1-2 semaines d'aller-retour avec Apple/CA).
- **Temps** : 2-4 heures étalées sur plusieurs jours pour les comptes + fourniture.
- **Référence** : Plan Phase 4 item 4.2.

### A25. Bandeau « provider cloud » — décision produit
- **Pourquoi** : un historien qui active Anthropic / OpenAI / Mistral / Gemini voit, sans avertissement, ses chunks RAG (qui peuvent contenir des sources primaires sensibles : témoignages, correspondances privées, archives non diffusées) partir vers un serveur tiers. La promesse « local-first » est affaiblie sans indicateur visible.
- **Options** :
  - **(a) Bandeau à chaque start de chat** avec provider non-local.
  - **(b) Badge dans le header du chat** (discret).
  - **(c) Option « workspace local-only »** qui interdit les providers cloud.
  - **(d) Tout ensemble** — (b) par défaut + (c) disponible + (a) au premier lancement.
- **Recommandation** : (d).
- **À décider** : (a)/(b)/(c)/(d).
- **Quand** : Phase 4.3.
- **Temps** : 15 minutes.
- **Référence** : Plan Phase 4 item 4.3.

### A26. Corpus « gold standard » pour benchmark RAG Path A
- **Pourquoi** : ADR 0001 gate le swap Obsidian→store principal sur un benchmark quantitatif. La mécanique CLI existe (`rag-benchmark`), il manque le corpus.
- **À fournir** :
  - 30 à 100 requêtes réelles que *tu poses vraiment* à ton corpus.
  - Pour chacune, 3 à 10 documents pertinents annotés (IDs de PDF / notes / items Tropy qui *devraient* remonter).
  - Idéalement avec un score de pertinence (1-5).
- **Format** : JSONL ou CSV, on définit la structure quand tu me dis sur quel sous-corpus tu veux benchmarquer.
- **Pourquoi toi** : c'est un travail d'historien, pas d'ingénieur. Seul ton jugement disciplinaire peut dire « ce doc est pertinent pour cette question ».
- **Quand** : Phase 4.4 (tout le fin de cycle).
- **Temps** : 8-15 heures étalées — c'est la plus grosse charge temps de ta part dans tout ce document.
- **Référence** : Plan Phase 4 item 4.4.

---

## Récapitulatif

Tu as 26 points d'intervention, répartis comme suit (hors A24 qui est largement budget/admin) :

| Phase | Nb d'interventions | Total temps estimé |
|---|---|---|
| Phase 0 | 3 (A1-A3) | ~30 min + 5 min de démarche clé Europeana |
| Phase 1 | 6 (A4-A9) | ~6-8 heures dont 3h de tests applicatifs |
| Phase 2 | 7 (A10-A16) | ~6-10 heures dont 2-3h de rédaction pédagogique |
| Phase 3 | 6 (A17-A22) | ~2 heures de décisions |
| Phase 4 | 4 (A23-A26) | 15-25 heures dont 8-15h corpus gold standard |

**Total estimé côté Frédéric** : 30 à 45 heures réparties sur ~4 mois.

**Bloquants par phase** (si non-fait, la phase s'arrête) :
- Phase 0 : **A2** (SourceInspector mode)
- Phase 1 : **A4** (Electron upgrade test), **A5** (validation suppression legacy)
- Phase 2 : **A10** (positionnement), **A11** (ambition Brainstorm) — les deux plus structurants
- Phase 3 : **A17** (persona) — conditionne la refonte Settings
- Phase 4 : **A26** (corpus gold) — gate le swap RAG

**Non-bloquants mais à ne pas oublier** : tout le reste, notamment A16 (contenu pédagogique) qui peut se préparer dès que tu as un moment, indépendamment du calendrier technique.
