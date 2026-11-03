/**
 * Lecture du manuscrit par un client MCP.
 *
 * Ce que ces tests protègent : qu'un client ne puisse pas lire autre chose
 * que le manuscrit (traversée de chemin, `context.md`, règles de maison),
 * qu'un chapitre long ne soit pas rendu tronqué en silence, et que l'ordre
 * d'un livre vienne du manifeste et non du nom des fichiers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { discoverManuscript, registerManuscriptTools } from '../tools/manuscript.js';
import { createCapturingServer } from './_helpers.js';
import { symlinkAvailable } from '../../__tests__/helpers/native-guards.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-manuscript-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('discoverManuscript', () => {
  it('finds the article file of a simple project', async () => {
    await fs.writeFile(path.join(tmp, 'document.md'), '# Titre\n\nDu texte.');
    const pieces = discoverManuscript(tmp);
    expect(pieces.map((p) => p.path)).toEqual(['document.md']);
    expect(pieces[0].kind).toBe('document');
  });

  it("takes a book's order from the manifest, not from the file names", async () => {
    // Le préfixe numérique des noms sert la lisibilité hors ClioDeck et n'a
    // aucune valeur d'autorité (backend/types/book.ts).
    await fs.mkdir(path.join(tmp, 'chapters'));
    await fs.writeFile(path.join(tmp, 'chapters', '01-alpha.md'), 'A');
    await fs.writeFile(path.join(tmp, 'chapters', '02-beta.md'), 'B');
    await fs.writeFile(
      path.join(tmp, 'project.json'),
      JSON.stringify({
        chapters: [
          { id: 'b', title: 'Beta', filePath: 'chapters/02-beta.md', order: 0 },
          { id: 'a', title: 'Alpha', filePath: 'chapters/01-alpha.md', order: 1 },
        ],
      })
    );
    expect(discoverManuscript(tmp).map((p) => p.title)).toEqual(['Beta', 'Alpha']);
  });

  it('survives a manifest entry whose file has disappeared', async () => {
    await fs.writeFile(
      path.join(tmp, 'project.json'),
      JSON.stringify({ chapters: [{ filePath: 'chapters/gone.md', order: 0, title: 'Envolé' }] })
    );
    await fs.writeFile(path.join(tmp, 'document.md'), 'x');
    expect(discoverManuscript(tmp).map((p) => p.path)).toEqual(['document.md']);
  });

  it('excludes context.md — the README promises it never reaches a client', async () => {
    await fs.writeFile(path.join(tmp, 'document.md'), 'x');
    await fs.writeFile(path.join(tmp, 'context.md'), 'consignes de projet');
    expect(discoverManuscript(tmp).map((p) => p.path)).not.toContain('context.md');
  });

  it('never descends into the rest of the project folder', async () => {
    // Un dossier de projet contient aussi les PDF de la bibliographie et
    // parfois un coffre Obsidian entier : la découverte ne doit pas ratisser.
    await fs.mkdir(path.join(tmp, 'vault'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'vault', 'note-privee.md'), 'secret');
    await fs.writeFile(path.join(tmp, 'document.md'), 'x');
    expect(discoverManuscript(tmp).map((p) => p.path)).toEqual(['document.md']);
  });

  it('offers no path that escapes the project', async () => {
    await fs.mkdir(path.join(tmp, 'chapters'));
    await fs.writeFile(path.join(tmp, 'chapters', '01-a.md'), 'A');
    await fs.writeFile(
      path.join(tmp, 'project.json'),
      JSON.stringify({
        chapters: [
          { filePath: '../../../../etc/passwd', order: 0, title: 'Traversée' },
          { filePath: 'chapters/01-a.md', order: 1, title: 'A' },
        ],
      })
    );
    // L'entrée hostile ne cite pas un .md : elle disparaît. Et comme
    // read_manuscript ne lit que ce que cette liste contient, un chemin
    // fabriqué ne désigne rien plutôt que d'être filtré.
    expect(discoverManuscript(tmp).map((p) => p.path)).toEqual(['chapters/01-a.md']);
  });

  it('refuses a manifest entry pointing at a .md outside the project', async () => {
    // Le cas dangereux n'est pas `../../etc/passwd` (pas un .md) mais un
    // markdown bien réel du disque de l'auteur. project.json voyage avec un
    // projet partagé : il est une entrée non fiable, pas une source sûre.
    const outside = path.join(tmp, '..', `journal-intime-${path.basename(tmp)}.md`);
    await fs.writeFile(outside, 'notes privées');
    try {
      await fs.writeFile(
        path.join(tmp, 'project.json'),
        JSON.stringify({
          chapters: [
            { filePath: `../${path.basename(outside)}`, order: 0, title: 'Exfiltration' },
          ],
        })
      );
      expect(discoverManuscript(tmp)).toEqual([]);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('reports the real size so a long piece cannot look complete', async () => {
    await fs.writeFile(path.join(tmp, 'document.md'), 'x'.repeat(50000));
    expect(discoverManuscript(tmp)[0].chars).toBe(50000);
  });
});

/**
 * Un projet reçu par git ou en zip conserve ses liens : `document.md` peut pointer vers
 * `~/.ssh/id_ed25519`. Le contrôle lexical ne le voit pas, et `read_manuscript` remettrait
 * le fichier au client MCP (mesuré : « SECRET-HORS-PROJET » lu).
 */
describe.skipIf(!symlinkAvailable)('liens symboliques', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  let outside = '';

  async function read(requested: string): Promise<string> {
    const { server, tools } = createCapturingServer();
    registerManuscriptTools(
      server as unknown as McpServer,
      { workspaceRoot: tmp } as unknown as MCPRuntimeConfig,
      { log: () => undefined } as unknown as MCPAccessLogger
    );
    const result = await tools.get('read_manuscript')!.handler({ path: requested });
    return result.content[0].text;
  }

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-dehors-'));
    await fs.writeFile(path.join(outside, 'journal.md'), SECRET);
  });
  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('document.md lié vers l’extérieur : ni listé, ni lisible', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), path.join(tmp, 'document.md'));

    expect(discoverManuscript(tmp)).toEqual([]);
    const text = await read('document.md');
    expect(text).toContain('unknown_piece');
    expect(text).not.toContain(SECRET);
  });

  it('un chapitre du manifeste lié vers l’extérieur : ni listé, ni lisible', async () => {
    await fs.mkdir(path.join(tmp, 'chapters'));
    await fs.writeFile(path.join(tmp, 'chapters', '01.md'), 'A');
    await fs.symlink(path.join(outside, 'journal.md'), path.join(tmp, 'chapters', '02.md'));
    await fs.writeFile(
      path.join(tmp, 'project.json'),
      JSON.stringify({
        chapters: [
          { filePath: 'chapters/01.md', order: 0, title: 'Un' },
          { filePath: 'chapters/02.md', order: 1, title: 'Annexe' },
        ],
      })
    );

    expect(discoverManuscript(tmp).map((p) => p.path)).toEqual(['chapters/01.md']);
    expect(await read('chapters/02.md')).not.toContain(SECRET);
  });

  it('`chapters` lié hors du projet : rien n’en sort', async () => {
    await fs.symlink(outside, path.join(tmp, 'chapters'));
    await fs.writeFile(
      path.join(tmp, 'project.json'),
      JSON.stringify({ chapters: [{ filePath: 'chapters/journal.md', order: 0, title: 'Journal' }] })
    );

    expect(discoverManuscript(tmp)).toEqual([]);
  });

  it('un lien interne reste accepté, et se lit', async () => {
    await fs.mkdir(path.join(tmp, 'brouillons'));
    await fs.writeFile(path.join(tmp, 'brouillons', 'texte.md'), 'Du texte.');
    await fs.symlink(path.join('brouillons', 'texte.md'), path.join(tmp, 'document.md'));

    expect(discoverManuscript(tmp).map((p) => p.path)).toEqual(['document.md']);
    expect(await read('document.md')).toContain('Du texte.');
  });

  it('une racine passée par un lien ne fait rien disparaître', async () => {
    await fs.writeFile(path.join(tmp, 'document.md'), 'Du texte.');
    const alias = `${tmp}-alias`;
    await fs.symlink(tmp, alias);
    try {
      expect(discoverManuscript(alias).map((p) => p.path)).toEqual(['document.md']);
    } finally {
      await fs.rm(alias, { force: true });
    }
  });
});
