# Audit ClioDeck — Synthèse des 3 agents

## Agent Frontend

### Points forts
- Architecture Zustand bien pensée (11 stores par domaine)
- Design system CSS solide avec thèmes clair/sombre et mode densité
- i18n fonctionnel (FR/EN/DE) avec i18next
- Hooks customs de qualité (`useAutoSave`, `useIPCWithTimeout`)
- Éditeur WYSIWYG/Source avec autocomplétion de citations

### Points critiques
| Priorité | Problème | Impact |
|----------|----------|--------|
| **Critique** | Aucun lazy loading (`React.lazy`) | Tout chargé au démarrage |
| **Critique** | Accessibilité quasi inexistante | Aucun `aria-label`, focus trap, etc. |
| **Critique** | 112 `alert()`/`confirm()` natifs | UX cassée, non traduit |
| **Critique** | Preload non typé (`any` partout) | Aucune sécurité de type sur l'IPC |
| **Important** | 2 composants sur ~60 utilisent `memo()` | Re-renders massifs |
| **Important** | `bibliographyStore.ts` = 983 lignes | Trop monolithique |
| **Important** | Textes hardcodés en français dans le code | i18n incomplet |
| **Important** | 0 test frontend | Aucune couverture |

### Métriques clés
- 90+ occurrences de `any`, 0 tests, 0 `React.lazy`, 2 `memo()` sur ~60 composants

---

## Agent Backend

### Points forts
- Architecture modulaire `backend/core/` bien découpée
- Recherche hybride HNSW + BM25 avec RRF de qualité pro
- HNSWVectorStore robuste (validation, écriture atomique, reconstruction auto)
- Intégration Zotero duale (API + SQLite local) avec pattern Strategy
- Compression de contexte RAG intelligente (3 niveaux)

### Points critiques
| Priorité | Problème | Impact |
|----------|----------|--------|
| **Critique** | `@ts-nocheck` dans 5 services critiques | ~2500+ lignes sans vérification de types |
| **Critique** | Handlers filesystem sans validation de chemins | Lecture/écriture arbitraire |
| **Critique** | Preload expose `ipcRenderer` directement | Contourne le modèle de sécurité |
| **Important** | `sendMessage()` = ~550 lignes | Méthode ingérable |
| **Important** | `VectorStore.ts` = ~1254 lignes | Trop de responsabilités |
| **Important** | Validation Zod inconsistante (~40% des handlers) | Surface d'attaque ouverte |
| **Important** | 355 occurrences de `any` | Typage fragile |
| **Important** | 0 test backend | Aucune couverture |
| **Important** | ~1274 `console.log/warn/error` sans logging structuré | Pas de niveaux, pas de rotation |

### Métriques clés
- 5 fichiers `@ts-nocheck`, 355 `any`, duplications (cosineSimilarity, chunkText, interfaces Citation/Tropy)

---

## Agent Sécurité

### Points forts
- `contextIsolation: true` et `nodeIntegration: false` correctement configurés
- Validation Zod sur les handlers critiques
- `spawn` au lieu de `exec` pour les sous-processus (anti-injection)
- Console filter en production
- HTTPS pour les API externes, pas de clés hardcodées

### Vulnérabilités identifiées

| Sévérité | # | Problème |
|----------|---|----------|
| **CRITIQUE** | C1 | `ipcRenderer.on/send` exposés sans filtrage de channels — un XSS permet l'envoi de messages IPC arbitraires |
| **Haute** | H1-H2 | XSS via `dangerouslySetInnerHTML` sans DOMPurify (MarkdownPreview + MessageBubble) |
| **Haute** | H3-H4 | Accès filesystem illimité + path traversal (aucun scoping au projet) |
| **Haute** | H5 | `shell:openExternal` sans validation de protocole |
| **Haute** | H6-H7 | Clés API en clair dans electron-store, exposées via `config:get-all` |
| **Haute** | H8 | Aucune Content Security Policy |
| **Haute** | H9 | Handlers Zotero sans validation Zod |
| **Moyenne** | M1-M8 | Sandbox non activé, entitlements macOS permissifs, dépendances non épinglées |

---

## Convergences entre les 3 rapports

Les trois agents convergent sur **5 problèmes transversaux majeurs** :

1. **Le preload est le talon d'Achille** — Non typé (frontend), expose `ipcRenderer` directement (backend + sécurité), c'est la porte d'entrée de toutes les vulnérabilités
2. **Absence totale de tests** — 0 test frontend, 0 test backend
3. **Typage dégradé** — `@ts-nocheck` sur les services critiques + 355+ `any` backend + 90+ `any` frontend
4. **Validation IPC incomplète** — ~40% des handlers sans validation Zod, filesystem totalement ouvert
5. **XSS potentiel** — `dangerouslySetInnerHTML` sans sanitization, pas de CSP

---

## Plan d'action recommandé (par priorité)

### Immédiat (sécurité)
1. Remplacer l'exposition générique d'`ipcRenderer` par une liste blanche de channels
2. Ajouter `DOMPurify` sur tous les `dangerouslySetInnerHTML`
3. Implémenter le scoping filesystem (restreindre au répertoire projet)
4. Ajouter une CSP restrictive dans `index.html`
5. Valider les URLs dans `shell:openExternal` (protocoles `http/https` uniquement)

### Court terme (qualité & robustesse)
6. Retirer les `@ts-nocheck` des 5 services (commencer par `config-manager.ts`)
7. Étendre la validation Zod à tous les handlers IPC
8. Sécuriser le stockage des clés API avec `safeStorage`
9. Remplacer les `alert()`/`confirm()` par des composants modaux
10. Ajouter les premiers tests (stores, VectorStore, HybridSearch)

### Moyen terme (performance & maintenabilité)
11. Implémenter `React.lazy` + `Suspense` pour les composants lourds
12. Ajouter `React.memo`/`useMemo`/`useCallback` sur les composants critiques
13. Décomposer `sendMessage()`, `VectorStore.ts`, `bibliographyStore.ts`
14. Mettre en place un logging structuré
15. Améliorer l'accessibilité (ARIA, focus trap, etc.)
