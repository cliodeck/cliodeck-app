# i18n fusion sections — review pour 1.4b

> Compagnon de la PR 1.4a. La 1.4a a extrait ~60 chaînes hardcodées des 5 composants
> fusion (`VaultConfigSection`, `WorkspaceHintsSection`, `RecipesSection`,
> `MCPClientsSection`, `RecipeRunModal`) vers les espaces de noms `vault.*`, `hints.*`,
> `recipes.*`, `mcp.*`, `recipeRun.*`. Le **français** est la langue source (relu par
> Frédéric en écrivant le code initial). L'**anglais** et l'**allemand** sont des
> premières passes — ce document liste les choix à valider.
>
> 1.4b consiste à parcourir cette liste, ajuster les valeurs dans
> `public/locales/{en,de}/common.json`, puis fermer la dette.

## Comment réviser

1. Ouvre les trois fichiers `public/locales/{fr,en,de}/common.json`.
2. Pour chaque clé listée ci-dessous, compare FR / EN / DE.
3. Si la traduction proposée est correcte → laisser tel quel.
4. Si elle ne correspond pas → éditer **directement** la valeur dans
   `en/common.json` ou `de/common.json`, sans toucher la clé ni le code.
5. Pas besoin de toucher aux composants TSX — les clés sont stables.

Astuce : `git diff public/locales/en/common.json` après édition ne touchera
que les valeurs, jamais la structure.

## Conventions transversales à valider

| Décision | FR | EN proposé | DE proposé | Note |
|---|---|---|---|---|
| Clé `vault.title` | « Vault Obsidian » | « Obsidian Vault » | « Obsidian-Vault » | Inversion FR/EN attendue |
| Marker error « Fusion API non exposée » | reste tel quel | « Fusion API not exposed by the preload. » | « Fusion-API nicht durch das Preload-Skript exponiert. » | Le mot *preload* est jargon Electron — le garder en EN, le traduire en DE ? |
| « Outils exposés » (MCP) | reste | « Tools exposed » | « Verfügbare Tools » | EN garde le passif technique ; DE choisit l'idiomatique « verfügbar » |
| Pluriel `_one` / `_other` | présent en FR | présent | présent | i18next gère le pluriel automatiquement via `count` |

## Points de validation par espace de nom

### `vault.*`

- `vault.title` — Vault Obsidian / Obsidian Vault / Obsidian-Vault.
  EN met l'adjectif avant ; DE soude avec un trait d'union (norme Duden).
- `vault.hint` — paragraphe explicatif. **Vérifier surtout** que la phrase
  d'EN « so the Brainstorm chat can cite your notes alongside your bibliography »
  reste fluide. Le « tu » FR est neutralisé en « your » EN / « Ihre »
  (vouvoiement) DE — cohérent avec le reste du fichier.
- `vault.buttons.reindex` — « Réindexer (force) » → « Reindex (force) ».
  Garder la parenthèse ou utiliser « Force reindex » ? J'ai gardé la première
  forme pour ne pas bouger la structure.
- `vault.report.skipped` — « ignoré » (FR) → « skipped » (EN) / « übersprungen » (DE).
  À vérifier au runtime quand le rapport apparaît : on a un genre/nombre qui
  marche en français en s'accordant avec « notes » implicite (« 3 notes
  ignorées »), mais en EN/DE ça reste neutre. Pas de problème grammatical.

### `hints.*`

- `hints.title` — « Contexte durable » / « Persistent context » / « Dauerhafter Kontext ».
  C'est ce qui apparaît à côté de `<code>.cliohints</code>` dans le titre de section.
- `hints.placeholder` — bloc multi-ligne avec un exemple en FR.
  J'ai adapté l'exemple en EN/DE pour qu'il soit cohérent dans chaque langue.
  À ajuster selon le ton souhaité (plus formel ? plus court ?).
- `hints.status.saved` — « ✓ enregistré » / « ✓ saved » / « ✓ gespeichert ».
  Confirmation transitoire (1.5 s).

### `recipes.*`

- Le hint introductif est éclaté en 5 morceaux (`hintIntro`,
  `hintBuiltinLabel`, `hintBuiltinSuffix`, `hintUserLabel`, `hintUserSuffix`)
  parce qu'il y a deux balises `<em>` au milieu du texte. **Si tu trouves
  ce découpage gênant**, on peut basculer sur `<Trans>` de react-i18next pour
  réinjecter le HTML — mais c'est un changement de pattern dans le projet
  (aucun autre composant n'utilise `<Trans>` aujourd'hui).
- `recipes.groups.builtin` / `recipes.groups.user` — restent en anglais dans
  les trois langues (« Builtin » / « User »). C'est cohérent avec la
  terminologie utilisée dans le code et dans `.cliodeck/v2/recipes/`. À
  changer si tu préfères « Système » / « Utilisateur » côté FR.
- `recipes.card.stepsCount` — pluriel automatique : `{{count}} étape` /
  `{{count}} étapes` côté FR, idem EN (`step` / `steps`), DE
  (`Schritt` / `Schritte`). Vérifier qu'i18next applique bien la règle
  plurielle via `count` (devrait, c'est l'API standard).

### `mcp.*`

- `mcp.title` — « Clients MCP » / « MCP Clients » / « MCP-Clients ». Format de
  trait d'union DE selon Duden (composés germano-techniques).
- `mcp.hint` — long paragraphe. **Vérifier surtout** que la mention « tool-use »
  reste lisible en EN/DE. C'est un terme de l'API LLM, je l'ai gardé tel quel.
- `mcp.form.transportStdio` / `mcp.form.transportSse` — parenthèses
  explicatives traduites :
  - FR : « stdio (processus local) » / « sse (HTTP SSE distant) »
  - EN : « stdio (local process) » / « sse (remote HTTP SSE) »
  - DE : « stdio (lokaler Prozess) » / « sse (entfernter HTTP-SSE) »
- `mcp.buttons.save` — « Enregistrer & démarrer » / « Save & start » /
  « Speichern & starten ». L'esperluette est conservée partout.
- `mcp.tools.summary` — pluriel auto via `count` : « Outil exposé » / « Outils
  exposés », idem EN/DE.

### `recipeRun.*`

- `recipeRun.log.*` — les **lignes du journal** (`▶ Run started — {recipe}`,
  `… step {stepId} ({kind})`, etc.) sont **gardées en anglais** dans les trois
  langues. Raison : ces logs sont produits par le runner avec des `kind`
  fixés au niveau du code (`run_started`, `step_ok`, `step_failed`...). Les
  traduire serait incohérent avec les logs côté backend qui sont déjà en
  anglais (côté serveur MCP, audit, etc.). Si tu veux les francisser
  uniquement dans l'UI, c'est faisable mais ça crée un écart UI / fichier de
  log.
- `recipeRun.result.ok` — « Terminé. Journal : » / « Done. Log: » /
  « Fertig. Protokoll: ». L'espace insécable français devant les deux-points
  a été retiré pour cohérence cross-langues — à mettre si tu y tiens.
- `recipeRun.sections.outputs` — pluriel auto.

## Décisions globales à arbitrer (1.4b)

1. **Tutoyer ou vouvoyer en EN ?**
   La FR utilise « tu » dans les hints (`vault.hint`, `recipes.hintIntro`...).
   En EN c'est neutre (« you » couvre les deux). En DE j'ai utilisé « Sie »
   (vouvoiement, conservateur pour un outil pro). À retoucher si tu
   préfères tutoyer en DE.

2. **« Builtin » / « User » à traduire ?**
   Aujourd'hui ils restent en anglais dans les trois langues. Si tu veux
   localiser, modifier `recipes.groups.builtin` et `recipes.groups.user`
   dans `fr/common.json` ET les composants ne changent pas (c'est juste de
   la valeur).

3. **Les logs du runner (`recipeRun.log.*`) à traduire ?**
   Aujourd'hui : non, gardés en anglais partout. Si tu veux franciser/
   germaniser l'UI sans toucher aux logs disque, on pourrait dériver deux
   séries : `log.uiPrefix` (✓/✗/▶) et `log.message` (traduisible). Mais
   ça complique le code pour un gain d'usage limité — la ligne ressemble à
   un log technique et l'utilisateur n'attend probablement pas de
   traduction.

4. **Audit du reste de `common.json` ?**
   L'audit a relevé des suspicions hors fusion :
   - `chat.brainstorm.workspaceHints` est identique en FR et EN
     (« Workspace hints »). Probablement non traduit côté FR.
   - DE est globalement à ~80 % du contenu FR/EN sur d'autres sections
     (`editor`, fin de `chat.brainstorm`, `analyze`, `exportHub`,
     `workspaceMode`).
   Ces points sont **hors périmètre 1.4** mais pourraient mériter une 1.4c
   ou un ticket distinct.

## Structure des fichiers après 1.4a

```
public/locales/
├── fr/common.json    1156 → ~1300 lignes (FR : langue source, valide)
├── en/common.json    1156 → ~1300 lignes (EN : à relire pour 1.4b)
└── de/common.json    ~954 → ~1100 lignes (DE : à relire — le reste de
                                            la dette DE pré-existe à 1.4)
```

Aucun composant n'a maintenant de chaîne hardcodée pour ces 5 sections.
Si une nouvelle chaîne apparaît, elle doit passer par les espaces de noms
créés (ou un nouveau si nécessaire).

## Comment tester l'UI dans une autre langue

Au runtime, ClioDeck choisit la langue via `i18n.changeLanguage()`. Pour
basculer en EN ou DE le temps de la review :

```bash
# Méthode 1 : changer la langue système.
LANG=en_US.UTF-8 npm start
LANG=de_DE.UTF-8 npm start

# Méthode 2 (plus précise) : éditer temporairement i18n.ts pour forcer la
# langue, ouvrir Settings → naviguer dans les 5 sections, valider visuellement.
```

## Checklist 1.4b

- [ ] Relire `vault.*` (EN, DE)
- [ ] Relire `hints.*` (EN, DE) — surtout le placeholder multi-ligne
- [ ] Relire `recipes.*` (EN, DE) — décider si « Builtin/User » se traduisent
- [ ] Relire `mcp.*` (EN, DE) — vérifier que les termes techniques (`stdio`,
      `sse`, `tool-use`, `MCP`) restent en anglais
- [ ] Relire `recipeRun.*` (EN, DE) — décider si les logs du runner se
      traduisent
- [ ] Smoke test UI dans chaque langue : ouvrir Settings, naviguer dans les
      5 sections, vérifier qu'aucune clé brute (`vault.errors.noProject`)
      ne s'affiche
- [ ] (Optionnel) tracer les écarts hors fusion dans un ticket dédié
