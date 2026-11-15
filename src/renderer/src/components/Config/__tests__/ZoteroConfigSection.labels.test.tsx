// @vitest-environment jsdom
/**
 * Paramètres → Zotero, mode API : les deux champs portent leur libellé traduit (G4).
 *
 * « User ID » et « API Key » étaient écrits en dur, en anglais, au milieu d'une section française
 * ou allemande ; le test des chaînes en dur les tenait pour « un choix, pas un oubli ». Les clés
 * `zotero.userId` et `zotero.apiKey` existaient pourtant dans les trois langues. Vraies traductions,
 * vrai composant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const i18n = vi.hoisted(() => ({ instance: null as null | import('i18next').i18n }));

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const en = (await import('../../../../../../public/locales/en/common.json')).default;
  const de = (await import('../../../../../../public/locales/de/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr }, en: { common: en }, de: { common: de } },
    interpolation: { escapeValue: false },
  });
  i18n.instance = instance;
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { ZoteroConfigSection, type ZoteroConfig } from '../ZoteroConfigSection';

const config: ZoteroConfig = { mode: 'api', userId: '123456', apiKey: 'secret', autoSync: false, dataDirectory: '' };

/** Les libellés des champs du mode API, dans l'ordre de la section. */
async function apiLabels(lng: 'fr' | 'en' | 'de'): Promise<string[]> {
  await i18n.instance?.changeLanguage(lng);
  // Dépliée : la section est repliée par défaut.
  render(<ZoteroConfigSection config={config} onChange={() => undefined} />);
  fireEvent.click(screen.getByText('Zotero'));
  return [screen.getByDisplayValue('123456'), screen.getByDisplayValue('secret')].map(
    (input) => input.closest('.config-field')?.querySelector('label')?.textContent ?? ''
  );
}

afterEach(() => {
  cleanup();
});

describe('ZoteroConfigSection : les libellés du mode API', () => {
  it('en français', async () => {
    expect(await apiLabels('fr')).toEqual(['ID utilisateur', 'Clé API']);
  });

  it('en allemand', async () => {
    expect(await apiLabels('de')).toEqual(['Benutzer-ID', 'API-Schlüssel']);
  });

  it('témoin : en anglais, les mêmes mots qu’avant', async () => {
    expect(await apiLabels('en')).toEqual(['User ID', 'API Key']);
  });
});
