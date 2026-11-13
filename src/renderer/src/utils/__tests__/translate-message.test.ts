/**
 * `translateMessage`, le seul traducteur des messages codés (A11, L09-2), avec les vraies
 * locales, dans les trois langues.
 */
import { describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import fr from '../../../../../public/locales/fr/common.json';
import en from '../../../../../public/locales/en/common.json';
import de from '../../../../../public/locales/de/common.json';
import { translateMessage } from '../translate-message';
import { IpcError, unwrapIpc } from '../ipc-outcome';

async function translator(
  lng: 'fr' | 'en' | 'de',
  extra: Record<string, unknown> = {}
): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    resources: {
      fr: { common: { ...fr, ...extra } },
      en: { common: en },
      de: { common: de },
    },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as TFunction;
}

describe('translateMessage', () => {
  it.each([
    ['fr', "ClioDeck n'a reçu aucune réponse à cette demande."],
    ['en', 'ClioDeck received no answer to this request.'],
    ['de', 'ClioDeck hat auf diese Anfrage keine Antwort erhalten.'],
  ] as const)('un code connu, relatif à messages.*, donne sa phrase en %s', async (lng, expected) => {
    const t = await translator(lng);

    expect(translateMessage(t, { code: 'errors.noResponse' })).toBe(expected);
    // Une cause brute ne prend pas la place d'une phrase traduite.
    expect(translateMessage(t, { code: 'errors.noResponse', message: 'undefined' })).toBe(expected);
  });

  it('interpole les paramètres du code', async () => {
    const t = await translator('fr', {
      messages: { demo: { segments: '{{failed}} passage(s) sur {{total}} non analysé(s)' } },
    });

    expect(translateMessage(t, { code: 'demo.segments', params: { failed: 2, total: 9 } })).toBe(
      '2 passage(s) sur 9 non analysé(s)'
    );
  });

  it("un code sans clé rend la cause brute, puis le statut, puis le code : jamais rien", async () => {
    const t = await translator('fr');

    expect(translateMessage(t, { code: 'errors.unexpected', message: 'ENOSPC: no space left' })).toBe(
      'ENOSPC: no space left'
    );
    expect(translateMessage(t, { code: 'export.step', status: 'Conversion avec pandoc...' })).toBe(
      'Conversion avec pandoc...'
    );
    expect(translateMessage(t, { code: 'errors.inconnu' })).toBe('errors.inconnu');
    expect(translateMessage(t, { message: 'sans code' })).toBe('sans code');
  });

  it("traduit l'IpcError que lève unwrapIpc", async () => {
    const t = await translator('de');
    let caught: unknown = null;
    try {
      unwrapIpc<{ success?: boolean }>(undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IpcError);
    expect(translateMessage(t, caught as IpcError)).toBe(
      'ClioDeck hat auf diese Anfrage keine Antwort erhalten.'
    );
  });
});
