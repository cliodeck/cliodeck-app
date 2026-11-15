// @vitest-environment jsdom
/**
 * Une session réparée montre une durée estimée, jamais une durée mesurée (J18).
 *
 * L'app n'a pas fermé la session (sortie d'avant L03-9, plantage, arrêt forcé) : à la réouverture,
 * `closeOrphanSessions` la ferme à son dernier événement et marque ses métadonnées
 * `endedBy: 'repair'`. Le Journal ne lisait pas la marque et affichait « 90 min » comme pour une
 * session fermée par l'app. Vraies traductions, vrai panneau.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const i18n = vi.hoisted(() => ({ instance: null as null | import('i18next').i18n }));

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const de = (await import('../../../../../../public/locales/de/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr }, de: { common: de } },
    interpolation: { escapeValue: false },
  });
  i18n.instance = instance;
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { JournalPanel } from '../JournalPanel';
import { useJournalStore } from '../../../stores/journalStore';

/** Deux sessions de 90 minutes : l'une fermée par l'app, l'autre réparée à la réouverture. */
function showSessions(): HTMLElement {
  useJournalStore.setState({
    sessions: [
      {
        id: 'reparee',
        projectPath: '/projet',
        startedAt: new Date('2026-11-10T09:00:00Z'),
        endedAt: new Date('2026-11-10T10:30:00Z'),
        totalDurationMs: 90 * 60_000,
        eventCount: 4,
        metadata: { platform: 'darwin', endedBy: 'repair' },
      },
      {
        id: 'mesuree',
        projectPath: '/projet',
        startedAt: new Date('2026-11-09T09:00:00Z'),
        endedAt: new Date('2026-11-09T10:30:00Z'),
        totalDurationMs: 90 * 60_000,
        eventCount: 4,
        metadata: { platform: 'darwin' },
      },
    ],
    loading: false,
    hideEmptySessions: false,
  });
  return render(<JournalPanel />).container;
}

const durations = (container: HTMLElement): Array<string | null> =>
  [...container.querySelectorAll('.session-duration')].map((node) => node.textContent);

afterEach(async () => {
  cleanup();
  await i18n.instance?.changeLanguage('fr');
});

describe('JournalPanel : la durée d’une session réparée', () => {
  it('en français : « durée estimée » pour la session réparée, la durée seule pour l’autre', () => {
    const container = showSessions();

    expect(durations(container)).toEqual(['90 min (durée estimée)', '90 min']);
  });

  it('en allemand', async () => {
    await i18n.instance?.changeLanguage('de');
    const container = showSessions();

    expect(durations(container)).toEqual(['90 min (geschätzte Dauer)', '90 min']);
  });

  it('l’infobulle dit pourquoi la durée est estimée', () => {
    const container = showSessions();

    const [repaired, measured] = [...container.querySelectorAll('.session-duration')];
    expect(repaired.getAttribute('title')).toBe(
      "L'app n'a pas fermé cette session : sa fin est fixée à son dernier événement enregistré."
    );
    expect(measured.getAttribute('title')).toBeNull();
  });
});
