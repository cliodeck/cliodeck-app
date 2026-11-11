---
name: verify
description: Vérifier un changement ClioDeck en pilotant l'app Electron réelle avec Playwright (lancement sur un userData temporaire, stub des dialogues natifs, captures, comparaison d'octets).
---

# Vérifier ClioDeck en pilotant l'app Electron

## Recette qui marche (2026-11)

**Jamais la vraie configuration de l'auteur** (`~/Library/Application Support/cliodeck/cliodeck-config.json`), ni son trousseau, ni ses vrais projets : l'app se lance comme `e2e/_helpers/launch.ts`, sur un userData temporaire.

1. **Build** : `npm run build` (~1 min). L'entrée main est `dist/src/main/index.js` ; `npm start` = `env -u ELECTRON_RUN_AS_NODE npx electron .`.
2. **userData temporaire, langue fixée** : un dossier neuf, hors du dépôt, avec un `cliodeck-config.json` écrit avant le lancement. Dans un userData neuf, l'app démarre en français (`DEFAULT_CONFIG.language`, valeur par défaut d'electron-store) ; la recette fixe quand même la langue, comme `E2E_LANGUAGE`, pour que les libellés attendus ne dépendent pas de ce défaut.
   ```js
   const userDataDir = fs.mkdtempSync(path.join(TMP, 'userdata-'));
   fs.writeFileSync(path.join(userDataDir, 'cliodeck-config.json'), JSON.stringify({ language: 'fr' }));
   ```
   Un réglage propre à la vérification s'écrit dans ce fichier-là, avant le lancement, ou passe par l'interface.
3. **Playwright est dans node_modules** (dépendance de développement, v1.59). Driver Node CJS, mêmes arguments que `launchApp` :
   ```js
   const { _electron } = require('playwright');
   const env = { ...process.env };
   delete env.ELECTRON_RUN_AS_NODE;
   const app = await _electron.launch({
     args: ['.', '--no-sandbox', '--use-mock-keychain', `--user-data-dir=${userDataDir}`],
     cwd: REPO,
     env,
   });
   const page = await app.firstWindow();
   // Electron 45 : la première page est le document vide de la fenêtre,
   // avant le `loadFile` de l'app (docs/empaquetage.md, « Electron 45 »).
   await page.waitForURL((u) => u.protocol === 'file:', { waitUntil: 'domcontentloaded' });
   ```
   `--use-mock-keychain` : sans lui, Electron peut rester bloqué sur le vrai trousseau. `--user-data-dir` : configuration, récents et dernier dossier des dialogues (`lastDialogDirectory`) s'écrivent dans le dossier temporaire.
   Lancer avec `NODE_PATH=<repo>/node_modules env -u ELECTRON_RUN_AS_NODE node driver.cjs`
   (l'env de dev exporte `ELECTRON_RUN_AS_NODE`, qui casse le lancement GUI).
4. **Dialogues natifs** : injectables côté processus main —
   ```js
   await app.evaluate(({ dialog }, p) => {
     dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
   }, fixturePath);
   ```
   À la fermeture, un tampon sans titre non vide, ou une écriture refusée, pose une question native : y répondre « Quitter sans enregistrer », sinon `app.close()` reste bloqué. Le main pose cette question dans la langue de la configuration (`t('unsavedLeave')`, `public/locales/*/menu.json`) : le bouchon reconnaît ce bouton dans les trois langues, pour qu'une vérification en anglais ou en allemand, ou un changement de langue en cours de route, se ferme encore. **À cette question-là seulement** : `dialog.showMessageBox` pose aussi le consentement à un envoi distant (`confirmCloudUsage`) et l'ajout d'un serveur MCP (`confirmMcpAdd`), dont le bouton 1 accepte. Pendant une vérification, ces deux questions restent refusées : le bouchon leur répond `cancelId`.
   ```js
   // « Quitter sans enregistrer » dans chaque langue, lu dans les fichiers que lit le main.
   const leaveLabels = ['fr', 'en', 'de'].map(
     (lang) => JSON.parse(fs.readFileSync(path.join(REPO, 'public/locales', lang, 'menu.json'), 'utf8')).unsavedLeave
   );
   await app.evaluate(({ dialog }, leaveLabels) => {
     const seen = (globalThis.__dialogsSeen = []);
     dialog.showMessageBox = async (...args) => {
       const o = args[args.length - 1];
       const leave = leaveLabels.includes(o.buttons?.[1]);
       const response = leave ? 1 : (o.cancelId ?? 0);
       seen.push({ message: o.message, buttons: o.buttons, response });
       return { response, checkboxChecked: false };
     };
   }, leaveLabels);
   ```
   Avant la fermeture, `app.evaluate(() => globalThis.__dialogsSeen)` dit quelles questions ont été posées et ce que le bouchon a répondu.
5. **Sélecteurs** : boutons toolbar par `button[title="..."]`, libellés français (`public/locales/fr/common.json`, section `toolbar` : « Ouvrir », « Enregistrer »…). Éditeur : `.codemirror-editor .cm-editor`.
6. Prévoir ~4 s d'attente après le `domcontentloaded` de l'app, celui que
   `waitForURL` attend (init des services) — pas celui du document vide.
7. **Raccourcis** : jamais de vrai Cmd+Maj+Q ni de Cmd+Ctrl+Q envoyé au système (sous macOS, « Fermer la session » et « Verrouiller l'écran »). Un raccourci de menu passe par le menu de l'app (`Menu.getApplicationMenu()` puis `item.click()`, dans `app.evaluate`) ou par `webContents.send`.
8. **Fin** : `app.close()` sous un délai, puis supprimer nommément le userData temporaire, les fixtures copiées et les projets de vérification (`fs.rmSync(userDataDir, { recursive: true })` sur le chemin gardé, jamais par motif). Une question de sortie que le bouchon ne reconnaît pas reçoit « Rester », et `app.close()` attendrait sans fin : passé le délai, l'app s'arrête par son PID, jamais par motif. Une fois `app.close()` lancé, `app.evaluate` échoue : lire `__dialogsSeen` avant.
   ```js
   const pid = app.process().pid;
   const closed = await Promise.race([
     app.close().then(() => true),
     new Promise((resolve) => setTimeout(resolve, 30_000, false).unref()),
   ]);
   if (!closed) {
     console.error('app.close() bloqué : une question de sortie est restée sans réponse');
     process.kill(pid, 'SIGKILL');
   }
   ```
9. **Contrôle** : `shasum -a 256 ~/Library/Application\ Support/cliodeck/cliodeck-config.json` avant le lancement et après la fin : identique.

## Flows qui valent la peine

- **Fidélité éditeur** : ouvrir une fixture de `test-fixtures/editor/` (copiée
  dans le scratchpad — la sauvegarde écrit dedans !), cliquer « Enregistrer » sans éditer,
  comparer les octets (`Buffer.equals`).
- **Édition** : taper au clavier, boutons Citation/Note de bas de page, raccourcis Meta+B,
  re-enregistrer, vérifier le contenu écrit sur disque.

## Pièges

- Ne jamais ouvrir les fixtures du repo directement : « Enregistrer » écrirait dedans.
- Les projets de vérification sont temporaires : créés (ou copiés) dans un dossier temporaire, jamais un vrai projet de l'auteur, et supprimés nommément à la fin.
- `window.electron.*` existe dans la page (contextBridge) mais les stores
  Zustand ne sont pas exposés — passer par l'UI réelle.
- L'app démarre sans projet, en mode « Écrire » : l'éditeur est utilisable directement,
  mais tout ce qui exige un projet (présentation, RAG) demande d'en charger un.
