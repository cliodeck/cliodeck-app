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
