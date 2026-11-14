/**
 * Les dossiers d'images du projet, tels que pandoc peut les lire dans `--resource-path` (L07-2).
 *
 * Pandoc découpe cette liste sur `path.delimiter` (`:` sous macOS et Linux, `;` sous Windows) : un
 * projet nommé « Les archives : une histoire » y devenait deux dossiers inexistants, et ses images
 * disparaissaient de l'export PDF ou Word, avec une réserve qui conseillait de les placer dans le
 * dossier du projet, où elles étaient déjà. Un tel dossier passe par un lien créé dans le dossier
 * de travail de l'export, et ce lien est retiré avant que le dossier de travail parte : une
 * suppression récursive ne doit jamais pouvoir passer par lui dans le projet.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { removeResourceLinks, stageResourcePaths } from '../export-project-files.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cliodeck-ressources-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Un projet et un dossier de travail neufs ; `name` est le nom du dossier du projet. */
function setup(name: string): { project: string; workDir: string } {
  const base = mkdtempSync(join(root, 'p-'));
  const project = join(base, name);
  mkdirSync(join(project, 'chapters'), { recursive: true });
  writeFileSync(join(project, 'plan.png'), 'image');
  const workDir = join(base, 'travail');
  mkdirSync(workDir);
  return { project, workDir };
}

describe('stageResourcePaths', () => {
  it('un dossier sans séparateur passe tel quel, sans lien', async () => {
    const { project, workDir } = setup('Mon projet');

    const staged = await stageResourcePaths([join(project, 'chapters'), project], workDir);

    expect(staged).toEqual({ paths: [join(project, 'chapters'), project], links: [], warnings: [] });
  });

  it('un dossier dont le chemin contient le séparateur passe par un lien du dossier de travail, sous un nom relatif', async () => {
    const { project, workDir } = setup(`Les archives ${delimiter} une histoire`);

    const staged = await stageResourcePaths([join(project, 'chapters'), project], workDir);

    expect(staged.warnings).toEqual([]);
    expect(staged.paths).toEqual(['res-0', 'res-1']);
    expect(staged.paths.join(delimiter).split(delimiter)).toEqual(['res-0', 'res-1']);
    expect(staged.links).toEqual([join(workDir, 'res-0'), join(workDir, 'res-1')]);
    // Pandoc tourne dans le dossier de travail : c'est de là qu'il résout ces noms.
    expect(staged.paths.map((p) => realpathSync(resolve(workDir, p)))).toEqual([
      realpathSync(join(project, 'chapters')),
      realpathSync(project),
    ]);
  });

  it('un lien qui ne se crée pas : le dossier est écarté, et la réserve dit pourquoi ses images manquent', async () => {
    const { project, workDir } = setup(`Les archives ${delimiter} une histoire`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const staged = await stageResourcePaths([project], workDir, async () => {
      throw Object.assign(new Error('jonction refusée'), { code: 'EPERM' });
    });

    expect(staged).toEqual({
      paths: [],
      links: [],
      warnings: [{ code: 'export.imageFolderUnreachable', params: { dir: project, char: delimiter } }],
    });
    warn.mockRestore();
  });
});

describe('removeResourceLinks', () => {
  it('retire les liens sans toucher à ce qu’ils désignent', async () => {
    const { project, workDir } = setup(`Les archives ${delimiter} une histoire`);
    const staged = await stageResourcePaths([project], workDir);

    expect(await removeResourceLinks(staged.links)).toBe(true);

    expect(existsSync(join(workDir, 'res-0'))).toBe(false);
    expect(readFileSync(join(project, 'plan.png'), 'utf8')).toBe('image');
  });

  it('un lien déjà parti n’est pas un échec', async () => {
    const { workDir } = setup('Mon projet');
    expect(await removeResourceLinks([join(workDir, 'res-0')])).toBe(true);
  });

  it('ce qui n’est pas un lien n’est pas retiré : faux, et le dossier de travail doit rester', async () => {
    const { project } = setup('Mon projet');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await removeResourceLinks([project])).toBe(false);

    expect(readFileSync(join(project, 'plan.png'), 'utf8')).toBe('image');
    warn.mockRestore();
  });
});
