/**
 * Le message d'un export arrêté par la limite de durée : les minutes viennent du
 * résultat rendu par le main, jamais d'un nombre écrit dans les locales.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import i18next, { type TFunction } from 'i18next';
import fr from '../../../../../../public/locales/fr/common.json';
import en from '../../../../../../public/locales/en/common.json';
import de from '../../../../../../public/locales/de/common.json';
import { exportErrorMessage } from '../export-error';
import { translateMessage } from '../../../utils/translate-message';

async function translator(lng: 'fr' | 'en' | 'de'): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr }, en: { common: en }, de: { common: de } },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as TFunction;
}

describe('exportErrorMessage', () => {
  it('traduit export_timed_out avec les minutes transportées par le résultat', () => {
    const t = vi.fn((key: string) => `traduit:${key}`);

    const message = exportErrorMessage(
      t,
      { error: 'Export arrêté', errorCode: 'export_timed_out', timeLimitMinutes: 15 },
      'repli'
    );

    expect(message).toBe('traduit:export.timedOut');
    expect(t).toHaveBeenCalledWith('export.timedOut', { minutes: 15 });
  });

  it('laisse les autres erreurs telles quelles, et le repli quand il n’y en a pas', () => {
    const t = vi.fn((key: string) => key);

    expect(exportErrorMessage(t, { error: 'xelatex a échoué' }, 'repli')).toBe('xelatex a échoué');
    expect(exportErrorMessage(t, {}, 'repli')).toBe('repli');
    expect(t).not.toHaveBeenCalled();
  });
});

/**
 * L07-2 : une image que pandoc ne sait pas convertir fait échouer l'export PDF. L'échec arrive avec
 * son code (relatif à `messages.*`) : l'auteur lit quelle image et quoi faire, pas la sortie de
 * xelatex (« Package svg Error: File `schema_svg-tex.pdf' is missing »).
 */
describe.each(['fr', 'en', 'de'] as const)('échec d’une image, en %s', (lng) => {
  it.each([
    ['export.imageNeedsRsvgConvert', 'images/schema.svg', 'rsvg-convert'],
    ['export.imageNotConverted', 'images/photo.webp', 'PNG'],
  ])('%s nomme l’image et dit quoi faire', async (errorCode, file, hint) => {
    const t = await translator(lng);

    const message = exportErrorMessage(
      t,
      { error: 'Pandoc failed with code 43:\n! Package svg Error', errorCode, errorParams: { file } },
      'repli'
    );

    expect(message).toContain(file);
    expect(message).toContain(hint);
    expect(message).not.toContain('Pandoc failed');
  });

  it('une image introuvable, au singulier comme au pluriel', async () => {
    const t = await translator(lng);
    const one = translateMessage(t, { code: 'export.imagesNotFound', params: { files: 'images/a.png', count: 1 } });
    const two = translateMessage(t, {
      code: 'export.imagesNotFound',
      params: { files: 'images/a.png, images/b.png', count: 2 },
    });

    expect(one).toContain('images/a.png');
    expect(two).toContain('images/a.png, images/b.png');
    expect(one).not.toBe(two.replace('images/a.png, images/b.png', 'images/a.png'));
  });

  it('un logo de présentation introuvable : nommé, et dit exporté sans lui', async () => {
    const t = await translator(lng);
    const issue = { code: 'export.beamerImageNotFound', params: { file: 'images/logo.png' } };

    const message = translateMessage(t, issue);

    expect(message).toContain('images/logo.png');
    expect(message).not.toBe('messages.export.beamerImageNotFound');
  });

  it('un dossier d’images que pandoc ne peut pas lire : nommé, avec le caractère en cause', async () => {
    const t = await translator(lng);
    const issue = {
      code: 'export.imageFolderUnreachable',
      params: { dir: '/Users/h/Les archives : une histoire', char: ':' },
    };

    const message = translateMessage(t, issue);

    expect(message).toContain('/Users/h/Les archives : une histoire');
    expect(message).toMatch(/[«“„]\s?:\s?[»”“]/);
    expect(message).not.toBe('messages.export.imageFolderUnreachable');
  });
});

describe.each(['fr', 'en', 'de'])('locale %s', (language) => {
  it('dit le nombre de minutes par la variable, sans l’écrire en dur', () => {
    const file = join(process.cwd(), 'public', 'locales', language, 'common.json');
    const locale = JSON.parse(readFileSync(file, 'utf8')) as { export: { timedOut?: string } };

    expect(locale.export.timedOut).toContain('{{minutes}}');
    expect(locale.export.timedOut).not.toMatch(/\d/);
  });
});
