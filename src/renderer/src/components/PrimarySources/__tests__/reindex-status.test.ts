/**
 * Le message de la réindexation complète des sources primaires autour de la reconstruction de
 * l'index de recherche (H7, revue).
 *
 * Toutes les sources refaites, la reconstruction finale de l'index dure une centaine de secondes
 * sur 40 000 extraits : l'écran disait « 3 / 3 source(s), environ … extrait(s) à refaire.
 * L'assistant consulte les anciens extraits en attendant. », alors que tout était refait et que
 * les anciens extraits n'existaient plus. Et l'app quittée pendant cette reconstruction, la
 * relance la refaisait sans rien dire, la recherche sémantique ne trouvant aucun extrait d'ici là,
 * et la fin n'était jamais dite.
 *
 * Les vraies chaînes, dans les trois langues.
 */
import { describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import fr from '../../../../../../public/locales/fr/common.json';
import en from '../../../../../../public/locales/en/common.json';
import de from '../../../../../../public/locales/de/common.json';
import { describeReindexStatus } from '../reindex-status';

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

describe('réindexation complète : le message autour de la reconstruction de l’index', () => {
  it('en cours : les sources faites sur le total, et les extraits qui restent à refaire', async () => {
    const t = await translator('fr');
    const text = describeReindexStatus(t, { phase: 'running', done: 2, total: 3, chunks: 40648, waitingForSync: false }, 'fr');

    expect(text).toContain('2 / 3 source(s)');
    expect(text).toContain('à refaire');
    expect(text).toContain('anciens extraits');
  });

  it('toutes les sources refaites, pendant la reconstruction finale : plus rien « à refaire », ni « anciens extraits »', async () => {
    const t = await translator('fr');
    const text = describeReindexStatus(t, { phase: 'running', done: 3, total: 3, chunks: 40648, waitingForSync: false }, 'fr');

    expect(text).toContain('3 / 3 source(s) refaite(s)');
    expect(text).toContain('index de recherche');
    expect(text).not.toContain('à refaire');
    expect(text).not.toContain('anciens extraits');
  });

  it('l’index relu incomplet, plus aucune source à refaire : sa reconstruction est dite, avec les extraits qui y manquent, puis sa fin', async () => {
    const t = await translator('fr');

    const rebuilding = describeReindexStatus(t, { phase: 'rebuilding-index', missing: 40648 }, 'fr');
    expect(rebuilding).toContain('index de recherche des sources primaires');
    expect(rebuilding).toContain((40648).toLocaleString('fr'));
    expect(rebuilding).toContain('recherche sémantique');

    expect(describeReindexStatus(t, { phase: 'index-rebuilt' }, 'fr')).toContain('reconstruit');
  });

  it('les trois langues ont leurs chaînes, interpolées', async () => {
    for (const lng of ['fr', 'en', 'de'] as const) {
      const t = await translator(lng);
      const texts = [
        describeReindexStatus(t, { phase: 'running', done: 3, total: 3, chunks: 9, waitingForSync: false }, lng),
        describeReindexStatus(t, { phase: 'rebuilding-index', missing: 1234 }, lng),
        describeReindexStatus(t, { phase: 'index-rebuilt' }, lng),
      ];
      for (const text of texts) {
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/primarySources\.|\{\{/);
      }
      expect(texts[0]).toContain('3 / 3');
      expect(texts[1]).toContain((1234).toLocaleString(lng));
    }
  });
});
