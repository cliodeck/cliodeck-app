/**
 * Dossier de départ des dialogues de fichiers.
 *
 * L'enjeu : depuis Electron 43, un dialogue sans `defaultPath` s'ouvre dans
 * « Téléchargements » et le système ne retient plus le dernier dossier. Sans
 * cette mémoire, chaque ouverture de projet repart du mauvais endroit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { resolveDialogDefaultPath, directoryToRemember } from '../dialog-default-path.js';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cliodeck-dialog-'));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('dossier de départ des dialogues', () => {
  it('rouvre le dernier dossier quand rien n’est demandé', async () => {
    const last = await tempDir();
    expect(await resolveDialogDefaultPath(undefined, last)).toBe(last);
  });

  it('place un nom de fichier seul dans le dernier dossier', async () => {
    const last = await tempDir();
    expect(await resolveDialogDefaultPath('document.md', last)).toBe(path.join(last, 'document.md'));
  });

  it('ne touche pas à un chemin absolu : l’appelant sait où il veut aller', async () => {
    const last = await tempDir();
    const wanted = path.join(await tempDir(), 'export.pdf');
    expect(await resolveDialogDefaultPath(wanted, last)).toBe(wanted);
  });

  it('sans dernier dossier, laisse la demande telle quelle', async () => {
    expect(await resolveDialogDefaultPath(undefined, undefined)).toBeUndefined();
    expect(await resolveDialogDefaultPath('document.md', undefined)).toBe('document.md');
  });

  it('ignore un dernier dossier disparu', async () => {
    const gone = path.join(await tempDir(), 'disque-debranche');
    expect(await resolveDialogDefaultPath(undefined, gone)).toBeUndefined();
    expect(await resolveDialogDefaultPath('document.md', gone)).toBe('document.md');
  });

  it('ignore un dernier « dossier » qui est en fait un fichier', async () => {
    const file = path.join(await tempDir(), 'notes.md');
    await writeFile(file, '');
    expect(await resolveDialogDefaultPath(undefined, file)).toBeUndefined();
  });
});

describe('dossier à retenir après un choix', () => {
  it('retient le dossier du fichier choisi', () => {
    const file = path.resolve('/projets/these/chapitre.md');
    expect(directoryToRemember(file)).toBe(path.dirname(file));
  });

  it('retient le parent d’un dossier choisi : c’est lui que le dialogue affichait', () => {
    const project = path.resolve('/projets/these');
    expect(directoryToRemember(project)).toBe(path.dirname(project));
  });
});
