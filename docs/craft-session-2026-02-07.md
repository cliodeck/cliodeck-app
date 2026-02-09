# Session Claude Code -- Projet CRAFT (FNR CORE 2026)

**Date :** 7 février 2026
**Outil :** Claude Code (Claude Opus 4.6) dans VS Code
**Projet :** Demande de financement FNR CORE pour CRAFT (Collaborative Reflection on AI Futures in Textual Practices for Historians)
**Dépôt :** `2026_CORE_CRAFT`

---

## Contexte

Le projet CRAFT vise à étudier comment l'IA transforme les pratiques d'écriture des historiens et à développer ClioDeck comme plateforme pédagogiquement transparente pour l'écriture historienne assistée par IA. Cette session a utilisé Claude Code comme atelier de recherche pour préparer la description du projet (project description) destinée au FNR CORE 2026.

Le document de départ (`document.md`) était un brouillon mêlant français et anglais, avec un état de l'art incomplet et une structure à améliorer. La bibliographie existante (`bibliography.bib`, ~30 références) et les PDFs du corpus (`PDFs/`) servaient de base.

## Architecture agent

Six sous-agents spécialisés ont été configurés dans `.claude/agents/` :

| Agent | Modèle | Rôle dans cette session |
|-------|--------|------------------------|
| `etat-de-lart` | Sonnet | Cartographie du champ (AI et histoire) |
| `methodologie` | Opus | Cadre épistémologique et protocole |
| `budget-impact` | Sonnet | Work packages FNR CORE |
| `redacteur-academique` | Opus | Question de recherche, réécriture complète, intégration des révisions |
| `relecteur-critique` | Opus | Simulation de peer review FNR |
| `analyste-sources` | Opus | Non utilisé dans cette session |

## Chronologie des opérations

### Phase 1 -- Production parallèle des documents de travail

Trois agents lancés en parallèle (en arrière-plan) :

1. **etat-de-lart** -- Analyse du corpus PDF et de bibliography.bib pour produire un état de l'art structuré en 7 thématiques (débat IA/histoire, herméneutique, RAG, computer vision, pratiques discrètes, écosystème d'outils, contribution de CRAFT).
   - **Output :** `docs/etat-de-lart.md`

2. **methodologie** -- Cadre épistémologique articulant Goody/Levinson, Clavert/Muller, herméneutique numérique. Protocole concret pour les 3 phases. Réflexion ClioDeck vs Claude Code. Dimension réflexive (mise en abyme).
   - **Output :** `docs/methodologie.md`

3. **budget-impact** -- 5 work packages (Management, Exploration, Développement, Test, Communication) pour FNR CORE 3 ans. Budget ~571K EUR. Équipe : PI 50% FTE + postdoc 36 mois + développeur 24 mois (M10-M34).
   - **Output :** `docs/workpackages.md`

**Problème rencontré :** Les agents en arrière-plan n'avaient pas les permissions Bash pour créer le dossier `docs/` ni y écrire. Solution : l'agent principal a créé le dossier et écrit les fichiers à partir des outputs des agents (via `TaskOutput`).

### Phase 2 -- Question de recherche

4. **redacteur-academique** -- Rédaction de la question de recherche, des sous-questions (SQ1-SQ4) et des hypothèses (H1-H3), en s'appuyant sur l'état de l'art produit en Phase 1.
   - **Output :** `docs/question-recherche.md`

### Phase 3 -- Réécriture du document principal

5. **redacteur-academique** (deuxième invocation) -- Réécriture complète de `document.md` en intégrant les quatre documents de `docs/`. Sauvegarde préalable dans `document~.md`.
   - Le document est passé d'un brouillon décousu à un texte structuré de ~288 lignes suivant le format FNR CORE (sections 1.1-1.5, WP1-WP5, Risk Management, Outputs, Participants).
   - Marqueurs `[REF NEEDED]` conservés pour Star (boundary objects) et Fickers (herméneutique numérique).
   - Commentaires HTML `<!-- PI: ... -->` pour les points nécessitant l'intervention du PI.

### Phase 4 -- Relecture critique

6. **relecteur-critique** -- Simulation d'un évaluateur FNR CORE exigeant. A lu `document.md`, `bibliography.bib` et les guidelines FNR CORE.
   - **Output :** `docs/relecture-critique.md`
   - **Verdict :** Révisions majeures
   - **5 faiblesses majeures identifiées :** tension ethnographie/développement logiciel, faisabilité technique sous-estimée, protocole comparatif insuffisant, sections incomplètes, taille d'échantillon non justifiée
   - **12 questions d'évaluateur simulées**

### Phase 5 -- Intégration des révisions

Discussion PI / agent principal sur les faiblesses identifiées. Trois décisions prises :

- **Faiblesse 1 (tension ethno/dev) :** ClioDeck est un *instrument*, pas le but. Analogie avec le détecteur en physique expérimentale.
- **Faisabilité technique :** Définir un MVP (éditeur + RAG Zotero + transparence + journal). Mentionner le POC existant (2 mois de vibe coding par le PI). Plan B explicite.
- **Protocole comparatif :** 4 instruments standardisés (questionnaire, grille d'observation, entretiens, journaux). Comparaison intra-groupe en Phase 3 (ClioDeck vs outil commercial). Section "Methodological honesty".

7. **redacteur-academique** (troisième invocation) -- Intégration des trois points dans `document.md` :
   - Nouveau paragraphe ligne 127 (ClioDeck = instrument)
   - Lignes 131-135 (MVP, POC, fallback)
   - Lignes 145-161 (nouvelle sous-section "Comparative protocol")
   - Mise à jour du tableau Risk Management ligne 239

## Fichiers produits

| Fichier | Description | Statut |
|---------|-------------|--------|
| `document.md` | Description du projet (version révisée) | En cours -- sections 5.2, 5.3 à compléter par le PI |
| `document~.md` | Sauvegarde du brouillon original | Archive |
| `docs/etat-de-lart.md` | État de l'art structuré | Document de travail |
| `docs/methodologie.md` | Cadre méthodologique | Document de travail |
| `docs/workpackages.md` | Work packages et budget | Document de travail |
| `docs/question-recherche.md` | Question et sous-questions de recherche | Document de travail |
| `docs/relecture-critique.md` | Relecture critique simulée | Document de travail |

## Points restants à traiter

- [ ] Compléter les sections 5.2 (IPR) et 5.3 (projets en cours du PI)
- [ ] Résoudre les `[REF NEEDED]` : Star (1989) pour boundary objects, Fickers pour herméneutique numérique
- [ ] Compléter les noms des doctorants (section 5.4 : "Andrew, Cecile")
- [ ] Confirmer le partenaire allemand
- [ ] Rédiger l'abstract
- [ ] Vérifier la référence Levinson (`@levinson_technologies_nodate`)
- [ ] Justifier la taille d'échantillon (12-18 par workshop) par la littérature méthodologique
- [ ] Envisager un article méthodologique soumis plus tôt (M18-M20 plutôt que M36)
- [ ] Traiter les faiblesses mineures de la relecture (langue des workshops, budget salarial, SQ3, Tropy/RAG, accessibilité)

## Observations sur le processus

Cette session illustre directement la dimension réflexive du projet CRAFT : un projet sur l'IA dans l'écriture historienne qui utilise lui-même l'IA pour sa propre rédaction. Quelques observations :

1. **L'orchestration d'agents spécialisés** permet un travail parallèle efficace, mais la coordination reste manuelle (pas de mécanisme de dépendance entre agents).

2. **Les agents ne peuvent pas écrire de fichiers en mode arrière-plan** (permissions Bash refusées). L'agent principal doit servir d'intermédiaire.

3. **Le relecteur critique a identifié des faiblesses réelles** que le rédacteur n'avait pas anticipées (protocole comparatif, MVP, faisabilité). Le passage par une simulation de peer review a significativement amélioré le document.

4. **Les choix intellectuels du PI restent déterminants** : la décision de mentionner le POC, l'insistance sur ClioDeck comme vecteur de discussion plutôt que produit, le choix du protocole de comparaison intra-groupe -- ces orientations ont été décidées par le PI, pas générées par l'IA.

5. **Le document final est un hybride** : structure et formulation largement produites par les agents, orientations épistémologiques et décisions stratégiques du PI. La question Q7 du relecteur ("how much of the intellectual contribution is the PI's, and how much is the AI's?") est pertinente et devra être adressée honnêtement dans le dossier.

---

*Document généré le 7 février 2026 dans le cadre du protocole de documentation réflexive du projet CRAFT.*
