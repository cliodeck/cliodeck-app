/**
 * Un dialogue de fichier rouvre le dossier du choix précédent.
 *
 * Jusqu'à Electron 42, le système s'en chargeait. Depuis Electron 43, un
 * dialogue sans `defaultPath` s'ouvre dans « Téléchargements » : c'est
 * l'application qui retient le dernier dossier (`dialog-default-path.ts`).
 * Les tests unitaires couvrent le calcul ; ici on vérifie ce que le dialogue
 * natif reçoit réellement, et que la mémoire survit dans la configuration.
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

interface SeenOptions {
  defaultPath?: string;
}

type DialogProbe = { __seenOpen?: SeenOptions[]; __seenSave?: SeenOptions[] };

type DialogBridge = {
  electron: {
    dialog: {
      openFile: (options: object) => Promise<unknown>;
      saveFile: (options: object) => Promise<unknown>;
    };
  };
};

function makeProject(): { dir: string; projectJson: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dialogue-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Projet E2E dialogue',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Titre\n\nTexte du projet.\n');
  return { dir, projectJson };
}

test('un dialogue rouvre le dossier du dernier fichier choisi', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    // Les dialogues natifs bloqueraient le test : on répond à leur place, en
    // notant les options que l'application leur passe.
    await app.evaluate(({ dialog }, filePath) => {
      const probe = globalThis as DialogProbe;
      probe.__seenOpen = [];
      probe.__seenSave = [];
      dialog.showOpenDialog = async (...args: unknown[]) => {
        probe.__seenOpen?.push(args[args.length - 1] as SeenOptions);
        return { canceled: false, filePaths: [filePath] };
      };
      dialog.showSaveDialog = async (...args: unknown[]) => {
        probe.__seenSave?.push(args[args.length - 1] as SeenOptions);
        return { canceled: true, filePath: '' };
      };
    }, projet.projectJson);

    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du projet', {
      timeout: 20_000,
    });

    // Deuxième ouverture, sans dossier demandé : celui du projet est proposé.
    await window.evaluate(() =>
      (window as unknown as DialogBridge).electron.dialog.openFile({ properties: ['openFile'] }),
    );
    // Enregistrement avec un nom de fichier seul : il est placé dans ce dossier.
    await window.evaluate(() =>
      (window as unknown as DialogBridge).electron.dialog.saveFile({ defaultPath: 'export.md' }),
    );

    const seen = await app.evaluate(() => {
      const probe = globalThis as DialogProbe;
      return { open: probe.__seenOpen ?? [], save: probe.__seenSave ?? [] };
    });

    // Premier lancement, rien de retenu : Electron choisit.
    expect(seen.open[0]?.defaultPath).toBeUndefined();
    expect(seen.open[1]?.defaultPath).toBe(projet.dir);
    expect(seen.save[0]?.defaultPath).toBe(join(projet.dir, 'export.md'));

    // La mémoire est dans la configuration : elle survit à la fermeture.
    const config = JSON.parse(readFileSync(join(userDataDir, 'cliodeck-config.json'), 'utf8')) as {
      lastDialogDirectory?: string;
    };
    expect(config.lastDialogDirectory).toBe(projet.dir);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});
