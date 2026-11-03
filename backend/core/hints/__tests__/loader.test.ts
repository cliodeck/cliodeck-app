import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  CONTEXT_FILE,
  CONTEXT_TEMPLATE,
  extractContextContent,
  loadWorkspaceHints,
  prependAsPrompt,
  prependAsSystemMessage,
  writeWorkspaceHints,
} from '../loader.js';
import { workspaceFiles } from '../../workspace/layout.js';
import { ensureWorkspaceDirectories } from '../../workspace/layout.js';
import type { ChatMessage } from '../../llm/providers/base.js';
import { symlinkAvailable } from '../../../__tests__/helpers/native-guards.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-hints-'));
  await ensureWorkspaceDirectories(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Workspace hints loader (4.1)', () => {
  it('reports absent when no context file exists', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
    // context.md est désormais la face visible et la cible d'écriture.
    expect(h.sourcePath).toContain(CONTEXT_FILE);
  });

  it('reports absent for an empty/whitespace-only hints.md', async () => {
    await writeWorkspaceHints(tmp, '\n   \n');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.raw).not.toBe('');
    expect(h.normalized).toBe('');
  });

  it('loads user-authored context, heading stripped', async () => {
    await writeWorkspaceHints(
      tmp,
      '# Contexte du projet\n\nCite en Chicago author-date.\n\n'
    );
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.normalized).toBe('Cite en Chicago author-date.');
  });

  it('prependAsPrompt is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(prependAsPrompt('Analyse X', h)).toBe('Analyse X');
  });

  it('prependAsPrompt wraps the prompt when hints present', async () => {
    await writeWorkspaceHints(tmp, 'Langue: français.');
    const h = await loadWorkspaceHints(tmp);
    const out = prependAsPrompt('Analyse X', h);
    expect(out).toContain('Langue: français.');
    expect(out).toContain('Analyse X');
    expect(out.indexOf('Langue: français.')).toBeLessThan(
      out.indexOf('Analyse X')
    );
  });

  it('prependAsSystemMessage is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(prependAsSystemMessage(msgs, h)).toBe(msgs);
  });

  it('prependAsSystemMessage prepends a fresh system message', async () => {
    await writeWorkspaceHints(tmp, 'Cite en Chicago.');
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Help' },
    ];
    const out = prependAsSystemMessage(msgs, h);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Cite en Chicago.');
    expect(out[1]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[1]);
  });

  // --- context.md face visible, hints.md hérité ---

  it('n’injecte RIEN pour un context.md jamais édité', async () => {
    // Le gabarit porte ses instructions dans un commentaire HTML : un
    // fichier neuf ne doit rien apprendre au modèle.
    await writeWorkspaceHints(tmp, CONTEXT_TEMPLATE);
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
  });

  it('n’injecte pas l’ancien gabarit des projets déjà créés', async () => {
    await writeWorkspaceHints(
      tmp,
      '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. ' +
        'Ce contexte sera utilisé pour améliorer les réponses de l’assistant IA.\n\n' +
        'Exemple : "Cette recherche porte sur l’impact de l’intelligence artificielle."'
    );
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
  });

  it('lit encore .cliodeck/hints.md et concatène les deux sources', async () => {
    await fs.writeFile(workspaceFiles(tmp).hints, 'Toujours en Chicago.', 'utf8');
    await writeWorkspaceHints(tmp, '# Contexte\n\nDanzig, 1919-1939.');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.sources.context.present).toBe(true);
    expect(h.sources.legacyHints.present).toBe(true);
    // context.md d'abord (le sujet), puis les directives héritées.
    expect(h.normalized).toBe('Danzig, 1919-1939.\n\nToujours en Chicago.');
  });

  it('fonctionne avec le seul hints.md hérité', async () => {
    await fs.writeFile(workspaceFiles(tmp).hints, 'Langue : français.', 'utf8');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.normalized).toBe('Langue : français.');
  });

  it('extractContextContent retire commentaires et titre de tête', () => {
    expect(extractContextContent('# Titre\n\n<!-- note -->\nCorps.')).toBe('Corps.');
    expect(extractContextContent('<!-- tout est commenté -->')).toBe('');
  });
});

/**
 * Un projet reçu garde ses liens : `context.md` peut pointer vers un fichier de l'auteur,
 * et ce contexte part en message `system` à chaque tour, sans qu'on ait rien demandé.
 */
describe.skipIf(!symlinkAvailable)('un fichier de contexte en lien symbolique', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  const JOURNAL = `# Journal\n\n${SECRET} : texte privé.\n`;
  let outside = '';
  const contextMd = () => path.join(tmp, CONTEXT_FILE);
  const hintsMd = () => workspaceFiles(tmp).hints;

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-hints-dehors-'));
    await fs.writeFile(path.join(outside, 'journal.md'), JOURNAL);
  });

  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('context.md lié hors du projet : rien n’est lu, ni pour le modèle ni pour l’interface', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
    expect(h.raw).toBe('');
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });

  it('.cliodeck/hints.md lié hors du projet : pareil', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), hintsMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });

  it('`.cliodeck` lié hors du projet : son hints.md n’est pas lu', async () => {
    await fs.rm(path.join(tmp, '.cliodeck'), { recursive: true });
    await fs.writeFile(path.join(outside, 'hints.md'), JOURNAL);
    await fs.symlink(outside, path.join(tmp, '.cliodeck'));

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });

  it('l’une liée dehors, l’autre ordinaire : l’ordinaire reste', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());
    await fs.writeFile(hintsMd(), 'Cite en Chicago.');

    const h = await loadWorkspaceHints(tmp);

    expect(h.normalized).toBe('Cite en Chicago.');
    expect(h.normalized).not.toContain(SECRET);
  });

  it('un lien qui reste dans le projet continue de marcher', async () => {
    await fs.writeFile(path.join(tmp, 'notes-contexte.md'), 'Langue : français.');
    await fs.symlink('notes-contexte.md', contextMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.normalized).toBe('Langue : français.');
    expect(h.raw).toBe('Langue : français.');
  });

  it('une racine passée par un lien ne fait rien perdre', async () => {
    await writeWorkspaceHints(tmp, 'Langue : français.');
    const alias = `${tmp}-alias`;
    await fs.symlink(tmp, alias);
    try {
      expect((await loadWorkspaceHints(alias)).normalized).toBe('Langue : français.');
    } finally {
      await fs.rm(alias);
    }
  });

  it('écrire ne suit pas le lien : le fichier extérieur reste intact, et le refus se dit', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());

    await expect(writeWorkspaceHints(tmp, 'Écrasé.')).rejects.toThrow(/sort du projet/);

    expect(await fs.readFile(path.join(outside, 'journal.md'), 'utf8')).toBe(JOURNAL);
  });

  it('écrire ne crée rien à l’autre bout d’un lien cassé', async () => {
    await fs.symlink(path.join(outside, 'cree-dehors.md'), contextMd());

    await expect(writeWorkspaceHints(tmp, 'Écrasé.')).rejects.toThrow(/sort du projet/);

    await expect(fs.access(path.join(outside, 'cree-dehors.md'))).rejects.toThrow();
  });

  it('écrire à travers un lien interne reste possible', async () => {
    await fs.writeFile(path.join(tmp, 'notes-contexte.md'), 'Avant.');
    await fs.symlink('notes-contexte.md', contextMd());

    await writeWorkspaceHints(tmp, 'Après.');

    expect(await fs.readFile(path.join(tmp, 'notes-contexte.md'), 'utf8')).toBe('Après.');
  });
});
