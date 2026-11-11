/**
 * Les dialogues natifs du démarrage, simulés avant que le main de l'app ne s'exécute.
 *
 * Chargé par `-r` (comme le chargeur de Playwright) : un message posé dans `whenReady`, avant que
 * le pilote puisse appeler `app.evaluate`, irait sinon à l'écran et attendrait une réponse. Ce
 * module ne fait que remplacer `dialog.showMessageBox` et `dialog.showErrorBox`, et écrire ce qu'ils
 * ont reçu dans le fichier que nomme `CLIODECK_E2E_STARTUP_DIALOGS` : le code de l'app n'a aucune
 * branche réservée aux tests.
 *
 * `launchApp` remplace ensuite `showMessageBox` par la réponse à la question de sortie.
 */
const { appendFileSync } = require('node:fs');
const { dialog } = require('electron');

const log = process.env.CLIODECK_E2E_STARTUP_DIALOGS;

if (log) {
  dialog.showMessageBox = async (...args) => {
    const options = args[args.length - 1] || {};
    appendFileSync(
      log,
      `${JSON.stringify({ kind: 'message', type: options.type, message: options.message, detail: options.detail })}\n`,
    );
    return { response: 0, checkboxChecked: false };
  };
  dialog.showErrorBox = (title, content) => {
    appendFileSync(log, `${JSON.stringify({ kind: 'error', title, content })}\n`);
  };
}
