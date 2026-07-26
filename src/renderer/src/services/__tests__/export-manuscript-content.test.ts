/**
 * Régression : exporter un article alors qu'`abstract.md` était ouvert
 * produisait un PDF contenant le résumé, sous le titre de l'article, sans
 * aucun avertissement. Le tampon de l'éditeur ne contient que le fichier
 * ouvert, et le panneau projet invite explicitement à ouvrir `abstract.md`
 * et `context.md`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  manuscriptFileName,
  resolveManuscriptContent,
} from '../export-manuscript-content';

const MANUSCRIT = '# Article\n\nLe corps de l’article.';
const RESUME = '# Résumé\n\nCeci n’est pas l’article.';

describe('manuscriptFileName', () => {
  it('associe chaque type de projet à son fichier', () => {
    expect(manuscriptFileName('article')).toBe('document.md');
    expect(manuscriptFileName('presentation')).toBe('slides.md');
  });
});

describe('resolveManuscriptContent', () => {
  it('lit le manuscrit sur le disque quand un AUTRE fichier est ouvert', async () => {
    // Le cœur du bug : abstract.md est ouvert, l'éditeur contient le résumé.
    const readFile = vi.fn().mockResolvedValue(MANUSCRIT);
    const result = await resolveManuscriptContent(
      '/p',
      'article',
      '/p/abstract.md',
      () => RESUME,
      readFile
    );

    expect(result).toEqual({ ok: true, content: MANUSCRIT, fromEditor: false });
    expect(readFile).toHaveBeenCalledWith('/p/document.md');
  });

  it('prend le texte VIVANT quand le manuscrit est le fichier ouvert', async () => {
    // Frappes non sauvegardées : elles doivent être exportées.
    const readFile = vi.fn().mockResolvedValue('version disque, périmée');
    const result = await resolveManuscriptContent(
      '/p',
      'article',
      '/p/document.md',
      () => 'version vivante, non sauvegardée',
      readFile
    );

    expect(result).toEqual({
      ok: true,
      content: 'version vivante, non sauvegardée',
      fromEditor: true,
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('prend slides.md vivant pour une présentation', async () => {
    // Avant, les présentations relisaient TOUJOURS le disque : tout ce qui
    // n'était pas encore sauvegardé était perdu à l'export.
    const readFile = vi.fn().mockResolvedValue('disque');
    const result = await resolveManuscriptContent(
      '/p',
      'presentation',
      '/p/slides.md',
      () => 'vivant',
      readFile
    );

    expect(result).toEqual({ ok: true, content: 'vivant', fromEditor: true });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('lit slides.md sur le disque quand un autre fichier est ouvert', async () => {
    const readFile = vi.fn().mockResolvedValue('les diapositives');
    const result = await resolveManuscriptContent(
      '/p',
      'presentation',
      '/p/context.md',
      () => 'le contexte',
      readFile
    );

    expect(result).toEqual({
      ok: true,
      content: 'les diapositives',
      fromEditor: false,
    });
    expect(readFile).toHaveBeenCalledWith('/p/slides.md');
  });

  it('lit le manuscrit sur le disque quand aucun fichier n’est ouvert', async () => {
    const readFile = vi.fn().mockResolvedValue(MANUSCRIT);
    const result = await resolveManuscriptContent(
      '/p',
      'article',
      null,
      () => '',
      readFile
    );

    expect(result).toEqual({ ok: true, content: MANUSCRIT, fromEditor: false });
  });

  it('signale le fichier manquant plutôt que d’exporter du vide', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await resolveManuscriptContent(
      '/p',
      'article',
      '/p/abstract.md',
      () => RESUME,
      readFile
    );

    expect(result).toEqual({ ok: false, missingFile: 'document.md' });
  });
});
