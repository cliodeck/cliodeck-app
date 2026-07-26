# ADR 0005 — Threat model

Status: accepted — 2026-05-06

## Context

ClioDeck ingests heterogeneous content: PDFs from publishers, OCR'd
archival photos (Tropy), Obsidian notes, and results from external MCP
servers (Gallica, HAL, Europeana, user-configured). A clear threat model
is required to scope defensive measures and avoid over-engineering.

## Decision

### Adversary model

**Trusted**: the local user and their direct colleagues (workspace
sharing is assumed trustworthy — a colleague who shares a `.cliodeck/`
folder is not adversarial).

**Semi-trusted**: third-party MCP servers configured by the user. They
may expose tools that return hostile content (prompt injection, data
exfiltration attempts). Their tool outputs are treated as untrusted
content and pass through `SourceInspector` before LLM injection.

**Untrusted**: ingested documents (PDFs, OCR, notes, MCP search results).
They may contain adversarial instructions embedded in text. This is the
primary threat vector.

### Assets to protect

| Asset | Location | Threat |
|---|---|---|
| API keys (LLM providers, Europeana, Zotero) | Electron safeStorage (OS keychain) | Exfiltration via prompt injection |
| Research content (corpus, notes, drafts) | Local filesystem only | Unintended leakage to cloud providers |
| Session metadata (MCP logs, security events) | Local `.cliodeck/` JSONL | Low value, integrity matters |

### Cloud boundary

ClioDeck is **local-first**. Research content never leaves the machine
unless the user explicitly configures a cloud LLM provider (or a
non-localhost Ollama instance).

When content is about to leave localhost:
- **Explicit per-session consent** is required: the user must acknowledge
  that chunks will be sent to the configured provider before the first
  message of each session.
- This applies to any provider whose URL is not `127.0.0.1` or `localhost`,
  including remote Ollama instances.
- The user remains solely responsible for data protection once they
  consent to cloud usage. ClioDeck's role is to make this decision
  visible and deliberate.

### Defense layers

1. **SourceInspector** (**`warn` mode by default** — see the 2026-07-26
   amendment): scans RAG chunks for prompt injection patterns before LLM
   injection.
2. **MCP tool-use policy**: read-only tools enabled by default,
   write tools require explicit opt-in per session.
3. **Credential isolation**: secrets in OS keychain, never in workspace
   files, never travel with the project folder.
4. **Electron sandbox**: renderer process sandboxed, preload whitelist
   restricts IPC surface.

## Consequences

- The cloud consent banner (4.3) must detect non-localhost URLs.
- MCP tool results must pass through SourceInspector.
- Workspace sharing is safe without additional encryption (secrets
  stay in the source machine's keychain).
- No anonymization/masking layer needed for v2 — the consent model
  places responsibility on the user.

---

## Amendement du 2026-07-26 — audit de la rc.4

Quatre points, tous relevés en confrontant ce document au code.

### Le mode par défaut est `warn`, pas `audit`

`DEFAULT_INSPECTOR_MODE = 'warn'` dans `backend/security/source-inspector.ts`.
En mode `warn`, `findBlockingEvent` rend `null` inconditionnellement :
**aucun extrait n'est jamais écarté**, ni pour le RAG, ni pour les
résultats d'outils MCP. Le texte ci-dessus annonçait `audit`.

C'est un arbitrage **assumé**, pas un oubli, et il tient à la nature du
métier : une source primaire — correspondance, discours, tract, journal
intime — contient légitimement des impératifs qui ressemblent aux motifs
recherchés. Écarter par défaut reviendrait à amputer des témoignages
authentiques, ce qui serait pire que le risque évité pour un corpus que
l'historien a lui-même constitué.

**Conséquence pratique** : `audit` est le minimum pour un corpus de
provenance tierce — vault Obsidian importé, PDF téléchargés en masse,
serveurs MCP non contrôlés. Le réglage est dans les Préférences, section
« Inspection des sources ».

### `context.md` passe désormais par l'inspecteur

Ce document exigeait que « MCP tool results must pass through
SourceInspector ». Il ne disait rien du contexte de projet — lequel est
injecté en rôle `system`, donc plus haut encore dans la hiérarchie de
confiance. Or `context.md` vit à la racine du projet et voyage avec un
dossier partagé. C'était la dernière entrée non défendue ; elle passe
maintenant par le même garde, borne de taille comprise.

### Les embeddings cloud demandent un consentement

Le modèle de menace place la responsabilité sur l'utilisateur « par le
modèle de consentement ». Encore faut-il qu'on le lui demande : le garde
n'était câblé que sur le chat, tandis qu'indexer avec `useCloudEmbeddings`
envoyait l'intégralité du corpus — PDF, transcriptions, notes, manuscrit —
sans un mot. Le consentement est demandé au moment de cocher l'option,
c'est-à-dire au moment de la décision, plutôt que dans le chemin
d'indexation qui tourne en arrière-plan et ne doit jamais bloquer.

Au passage, le consentement vaut désormais pour **un** fournisseur nommé :
`consentedProvider()` existait mais n'était jamais comparé, si bien
qu'accepter un envoi vers Mistral ouvrait les envois vers Anthropic dès
que l'utilisateur changeait de backend.

### `pdfjs-dist` reste en 3.11.174 — décision, pas oubli

`npm audit` signale CVE-2024-4367 (CVSS 8.8, exécution de JavaScript à
l'ouverture d'un PDF piégé). **Elle n'est pas atteignable ici** : le point
vulnérable est `getPathGenerator`, appelé uniquement par le rendu canvas.
ClioDeck n'appelle jamais `page.render()` — seulement `getPage()` et
`getTextContent()` — et l'extraction tourne de surcroît dans un processus
fils isolé.

La version 4 abandonne le chemin CommonJS `legacy/build/pdf.js` que
`pdf-extract-worker.ts` charge par `require()`. Le bump imposerait donc de
réécrire l'amorçage de l'ingestion PDF. Fait en pleine RC, ce serait
prendre un risque réel sur le chemin d'entrée du corpus pour supprimer un
risque nul. **À faire en rc.5**, avec la vérification qui va avec.
