/**
 * Trouver pandoc et xelatex : règles communes aux exports PDF et Word.
 *
 * Premier essai sous Windows : le bouton « Exporter » restait grisé alors que
 * pandoc et xelatex étaient installés. `which` n'y existe pas, et le PATH
 * étendu était recollé avec « : », qui coupe les lettres de lecteur.
 */
import { describe, it, expect } from 'vitest';
import { extendedToolPath, findExternalTool, toolFinderCommand } from '../external-tools';

describe('toolFinderCommand', () => {
  it('cherche avec `where` sous Windows, `which` ailleurs', () => {
    expect(toolFinderCommand('win32')).toBe('where');
    expect(toolFinderCommand('darwin')).toBe('which');
    expect(toolFinderCommand('linux')).toBe('which');
  });
});

describe('extendedToolPath', () => {
  it('sous Windows, ne touche pas au PATH : pas de chemins Unix, pas de « : » qui couperait C:\\', () => {
    const windowsPath = 'C:\\Program Files\\Pandoc\;C:\\Windows\\system32';
    expect(extendedToolPath(windowsPath, 'win32')).toBe(windowsPath);
  });

  it('sur macOS, ajoute Homebrew et MacTeX devant le PATH, séparés par « : »', () => {
    const extended = extendedToolPath('/usr/bin', 'darwin');
    expect(extended.split(':')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Library/TeX/texbin',
      '/usr/texbin',
      '/opt/local/bin',
      '/usr/bin',
    ]);
  });

  it('n’ajoute pas deux fois un emplacement déjà présent', () => {
    expect(extendedToolPath('/opt/homebrew/bin:/usr/bin', 'darwin').split(':').filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('accepte un PATH vide', () => {
    expect(extendedToolPath('', 'win32')).toBe('');
    expect(extendedToolPath('', 'darwin').startsWith('/opt/homebrew/bin:')).toBe(true);
  });
});

describe('findExternalTool (#138)', () => {
  it('sous Windows, cherche l’exécutable `.exe` avec `where` et retient la première ligne', () => {
    const lignes = 'C:\\poppler\\bin\\pdftoppm.exe\r\nC:\\autre\\pdftoppm.exe\r\n';
    const appels: Array<{ finder: string; args: string[] }> = [];
    const trouve = findExternalTool('pdftoppm', {
      platform: 'win32',
      exists: (p) => p === 'C:\\poppler\\bin\\pdftoppm.exe',
      run: (finder, args) => {
        appels.push({ finder, args });
        return lignes;
      },
    });

    expect(trouve).toBe('C:\\poppler\\bin\\pdftoppm.exe');
    expect(appels).toEqual([{ finder: 'where', args: ['pdftoppm'] }]);
  });

  it('sous Windows, ne cherche pas dans les emplacements Unix', () => {
    const vus: string[] = [];
    findExternalTool('pdftoppm', {
      platform: 'win32',
      exists: (p) => {
        vus.push(p);
        return false;
      },
      run: () => '',
    });
    expect(vus.some((p) => p.startsWith('/opt/') || p.startsWith('/usr/'))).toBe(false);
  });

  it('sur macOS, trouve dans Homebrew sans rien lancer', () => {
    let lance = false;
    const trouve = findExternalTool('pdftoppm', {
      platform: 'darwin',
      exists: (p) => p === '/opt/homebrew/bin/pdftoppm',
      run: () => {
        lance = true;
        return '';
      },
    });
    expect(trouve).toBe('/opt/homebrew/bin/pdftoppm');
    expect(lance).toBe(false);
  });

  it('sur macOS, retombe sur `which` quand l’outil est ailleurs', () => {
    const trouve = findExternalTool('pandoc', {
      platform: 'darwin',
      exists: (p) => p === '/opt/pandoc/bin/pandoc',
      run: (finder) => (finder === 'which' ? '/opt/pandoc/bin/pandoc\n' : ''),
    });
    expect(trouve).toBe('/opt/pandoc/bin/pandoc');
  });

  it('rend null quand la commande de recherche échoue — outil absent', () => {
    expect(
      findExternalTool('pdftoppm', {
        platform: 'win32',
        exists: () => false,
        run: () => {
          throw new Error('Command failed: where pdftoppm');
        },
      }),
    ).toBeNull();
  });

  it('ignore un chemin annoncé mais inexistant', () => {
    expect(
      findExternalTool('pdftoppm', {
        platform: 'linux',
        exists: () => false,
        run: () => '/usr/bin/pdftoppm\n',
      }),
    ).toBeNull();
  });
});
