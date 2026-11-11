/**
 * Le lanceur des tests e2e ne décide rien à la place de l'auteur (J16).
 *
 * `launchApp` remplace `dialog.showMessageBox` pour que la question de sortie ne bloque pas
 * `app.close()`. Il répondait 1 à **toute** question : le consentement à un envoi distant
 * (`confirmCloudUsage`) et l'ajout d'un serveur MCP (`confirmMcpAdd`) passent par la même fonction,
 * et leur bouton 1 accepte. Un test acceptait donc en silence un envoi hors de la machine, ou le
 * lancement d'une commande. Seule la question de sortie reçoit désormais la réponse choisie ;
 * toute autre reçoit `cancelId`.
 */

import { test, expect, type ElectronApplication } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerLeaveDialog, launchApp, leaveDialogs } from './_helpers/launch';

const LOCALES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const menuTexts = (language: string) =>
  JSON.parse(readFileSync(join(LOCALES, language, 'menu.json'), 'utf8')) as Record<string, string>;

/** La question de sortie telle que la pose `renderer-flush.ts`, dans une langue donnée. */
function leaveQuestion(language: string) {
  const texts = menuTexts(language);
  return {
    type: 'warning',
    message: texts.unsavedUntitledMessage,
    buttons: [texts.unsavedStay, texts.unsavedLeave],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Les boutons de `confirmCloudUsage` : le bouton 1 envoie. */
const CLOUD_CONSENT = {
  type: 'warning',
  buttons: ['Annuler', 'Envoyer vers ce service'],
  defaultId: 0,
  cancelId: 0,
  title: 'Envoi vers un service distant',
  message: 'Envoyer vos données à Anthropic ?',
  detail: 'Le contenu de la conversation sera transmis à Anthropic, hors de votre machine.',
};

/** Pose une question au `dialog` du main, comme le fait l'app, et rend la réponse du bouchon. */
const ask = (app: ElectronApplication, options: Record<string, unknown>) =>
  app.evaluate(async ({ dialog }, o) => (await dialog.showMessageBox(o as never)).response, options);

test('le bouchon ne dit oui qu’à la question de sortie : toute autre question reçoit cancelId', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, userDataDir } = outcome.value;

  try {
    // Reconnue dans les trois langues : une vérification en anglais ou en allemand se ferme encore.
    for (const language of ['fr', 'en', 'de']) expect(await ask(app, leaveQuestion(language))).toBe(1);
    expect(await ask(app, CLOUD_CONSENT)).toBe(0);
    expect(await ask(app, { message: 'Trois choix', buttons: ['Garder', 'Remplacer', 'Annuler'], cancelId: 2 })).toBe(2);
    expect(await ask(app, { message: 'Sans cancelId', buttons: ['Annuler', 'Accepter'] })).toBe(0);

    // `answerLeaveDialog` ne change que la réponse à la question de sortie.
    await answerLeaveDialog(app, 'stay');
    expect(await ask(app, leaveQuestion('fr'))).toBe(0);
    expect(await ask(app, CLOUD_CONSENT)).toBe(0);
    await answerLeaveDialog(app, 'leave');
    expect(await ask(app, CLOUD_CONSENT)).toBe(0);
    expect(await ask(app, leaveQuestion('de'))).toBe(1);

    // Le journal garde chaque question, et la réponse donnée.
    const seen = await leaveDialogs(app);
    expect(seen.map(({ message, response }) => [message, response])).toEqual([
      [menuTexts('fr').unsavedUntitledMessage, 1],
      [menuTexts('en').unsavedUntitledMessage, 1],
      [menuTexts('de').unsavedUntitledMessage, 1],
      [CLOUD_CONSENT.message, 0],
      ['Trois choix', 2],
      ['Sans cancelId', 0],
      [menuTexts('fr').unsavedUntitledMessage, 0],
      [CLOUD_CONSENT.message, 0],
      [CLOUD_CONSENT.message, 0],
      [menuTexts('de').unsavedUntitledMessage, 1],
    ]);
    expect(seen[3].buttons).toEqual(CLOUD_CONSENT.buttons);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('ajouter un serveur MCP par le vrai canal : la question est refusée, rien n’est ajouté', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window: page, userDataDir } = outcome.value;

  try {
    // Sans projet ouvert : accepté, l'ajout échouerait plus loin (« No project loaded ») sans rien
    // lancer. Refusé, le handler le dit.
    const res = await page.evaluate(() =>
      window.electron.fusion.mcp.add({ name: 'temoin', transport: 'stdio', command: 'node', args: ['--version'] }),
    );
    expect(res).toMatchObject({ success: false, error: 'mcp_add_rejected:user_cancelled' });
    const seen = await leaveDialogs(app);
    expect(seen).toEqual([{ message: 'Add MCP server "temoin"?', buttons: ['Cancel', 'Add MCP server'], response: 0 }]);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
