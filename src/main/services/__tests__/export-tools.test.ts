/**
 * Trouver pandoc et xelatex : règles communes aux exports PDF et Word.
 *
 * Premier essai sous Windows : le bouton « Exporter » restait grisé alors que
 * pandoc et xelatex étaient installés. `which` n'y existe pas, et le PATH
 * étendu était recollé avec « : », qui coupe les lettres de lecteur.
 */
import { describe, it, expect } from 'vitest';
import { extendedToolPath, toolFinderCommand } from '../export-tools';

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
