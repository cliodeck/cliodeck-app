// @vitest-environment jsdom
/**
 * La bande de la recherche nomme les corpus en cause (H5), et un corpus dont l'index se construit
 * se dit « indexation en cours », jamais « échec » (E3).
 *
 * La bande disait « La recherche de sources a échoué. » sans dire où : seule la ligne « Par corpus »,
 * repliée, nommait le corpus. Pendant une reconstruction des index, la bibliographie y valait
 * « échec ». Vrai panneau, vraies locales : le simulacre commun rend la clé seule, et ne verrait ni
 * l'interpolation ni le pluriel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { i18n as I18n } from 'i18next';

const h = vi.hoisted(() => ({ i18n: null as I18n | null }));

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
  h.i18n = instance;
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { ExplanationPanel } from '../ExplanationPanel';
import type { RAGExplanation } from '../../../stores/chatStore';

type Corpus = NonNullable<RAGExplanation['search']['corpora']>[number];
type Source = Corpus['source'];

const ok = (source: Source, count = 0): Corpus => ({ source, attempted: true, ok: true, hitCount: count, selectedCount: count });
const failed = (source: Source): Corpus => ({ source, attempted: true, ok: false, hitCount: 0, selectedCount: 0 });
const indexing = (source: Source): Corpus => ({ ...failed(source), indexing: true });
const notSearched = (source: Source): Corpus => ({ source, attempted: false, ok: false, hitCount: 0, selectedCount: 0 });

function explanation(
  retrievalStatus: RAGExplanation['search']['retrievalStatus'],
  corpora: Corpus[]
): RAGExplanation {
  return {
    search: {
      query: 'q',
      totalResults: 0,
      searchDurationMs: 12,
      cacheHit: false,
      sourceType: 'both',
      documents: [],
      corpora,
      ...(retrievalStatus ? { retrievalStatus } : {}),
    },
    llm: { provider: 'ollama', model: 'faux', contextWindow: 8192, temperature: 0.2, promptSize: 1000 },
    timing: { searchMs: 12, generationMs: 0, totalMs: 12 },
  };
}

async function inLanguage(lng: 'fr' | 'en' | 'de'): Promise<void> {
  await act(async () => {
    await h.i18n?.changeLanguage(lng);
  });
}

const band = (): HTMLElement => screen.getByRole('status');

afterEach(async () => {
  cleanup();
  await h.i18n?.changeLanguage('fr');
});

describe('la bande de la recherche nomme les corpus en échec (H5)', () => {
  it('recherche en échec : la bande nomme chaque corpus tombé, pas ceux restés à 0 ni ceux non interrogés', () => {
    render(
      <ExplanationPanel
        explanation={explanation('failed', [failed('secondary'), ok('primary'), failed('vault'), notSearched('manuscript')])}
      />
    );
    expect(band().textContent).toBe('La recherche de sources a échoué. Corpus en échec : Bibliographie, Notes (vault).');
    expect(band().getAttribute('data-status')).toBe('failed');
  });

  it('panne partielle : la bande nomme le corpus tombé', () => {
    render(<ExplanationPanel explanation={explanation('partial', [failed('primary'), ok('secondary', 3)])} />);
    expect(band().textContent).toBe(
      'Certaines recherches ont échoué ; les sources peuvent être incomplètes. Corpus en échec : Archives.'
    );
  });

  it.each([
    ['en', 'Source search failed. Failed corpus: Bibliography.', 'Source search failed. Failed corpora: Bibliography, Reading notes.'],
    ['de', 'Die Quellensuche ist fehlgeschlagen. Fehlgeschlagenes Korpus: Bibliografie.', 'Die Quellensuche ist fehlgeschlagen. Fehlgeschlagene Korpora: Bibliografie, Lesenotizen.'],
  ] as const)('%s : singulier et pluriel', async (lng, one, many) => {
    await inLanguage(lng);
    render(<ExplanationPanel explanation={explanation('failed', [failed('secondary')])} />);
    expect(band().textContent).toBe(one);
    cleanup();
    render(<ExplanationPanel explanation={explanation('failed', [failed('secondary'), failed('readingNotes')])} />);
    expect(band().textContent).toBe(many);
  });

  it('témoin : aucune panne, aucune source pertinente : la bande d’avant, sans corpus nommé', () => {
    render(<ExplanationPanel explanation={explanation('empty', [ok('secondary'), ok('vault')])} />);
    expect(band().textContent).toBe('Aucune source pertinente trouvée.');
  });
});

describe('un corpus dont l’index se construit : « indexation en cours » (E3)', () => {
  it('ligne « Par corpus » : « indexation en cours », jamais « échec »', () => {
    render(<ExplanationPanel explanation={explanation('empty', [indexing('secondary'), ok('primary')])} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('explanation-corpus-secondary').textContent).toBe('Bibliographie indexation en cours');
    expect(screen.getByTestId('explanation-corpora').textContent).not.toContain('échec');
  });

  it('bande : aucune panne dite, le corpus en indexation nommé', () => {
    render(<ExplanationPanel explanation={explanation('empty', [indexing('secondary'), ok('primary')])} />);
    expect(band().textContent).toBe(
      'Aucune source pertinente trouvée. Corpus en cours d’indexation, pas encore interrogé : Bibliographie.'
    );
    expect(band().textContent).not.toMatch(/échou/);
  });

  it('d’autres corpus ont répondu : la bande le dit quand même, comme une information', () => {
    render(<ExplanationPanel explanation={explanation(undefined, [indexing('secondary'), ok('primary', 2)])} />);
    expect(band().textContent).toBe('Corpus en cours d’indexation, pas encore interrogé : Bibliographie.');
    expect(band().getAttribute('data-status')).toBe('indexing');
  });

  it.each([
    ['en', 'Bibliography indexing in progress', 'Corpus being indexed, not searched yet: Bibliography.'],
    ['de', 'Bibliografie Indizierung läuft', 'Korpus wird indiziert, noch nicht abgefragt: Bibliografie.'],
  ] as const)('%s', async (lng, line, text) => {
    await inLanguage(lng);
    render(<ExplanationPanel explanation={explanation(undefined, [indexing('secondary'), ok('primary', 2)])} />);
    expect(band().textContent).toBe(text);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('explanation-corpus-secondary').textContent).toBe(line);
  });
});
