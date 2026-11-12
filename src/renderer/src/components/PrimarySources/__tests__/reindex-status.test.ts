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

/**
 * La réindexation qu'un changement de modèle d'embeddings fait proposer (L06-9, Q29) n'est pas celle
 * d'une mise à jour : elle n'a lieu qu'une fois confirmée, les anciens extraits ne servent plus la
 * recherche par le sens, et, interrompue, elle ne reprend pas seule. Les messages de H7 disaient
 * l'inverse (« une seule fois, après une mise à jour », « l'assistant consulte les anciens
 * extraits », « elle reprendra … là où elle s'est arrêtée »).
 */
describe('réindexation pour un nouveau modèle : ses propres messages (Q29)', () => {
  const cause = 'model-change' as const;

  it('en cours : ni « après une mise à jour », ni « anciens extraits » ; transcriptions gardées, et l’interruption dite', async () => {
    const t = await translator('fr');
    const text = describeReindexStatus(t, { phase: 'running', cause, done: 2, total: 3, chunks: 40648, waitingForSync: false }, 'fr') ?? '';

    expect(text).toContain('nouveau modèle de recherche sémantique');
    expect(text).toContain('2 / 3 source(s)');
    expect(text).toContain(`${(40648).toLocaleString('fr')} extrait(s) à refaire`);
    expect(text).toContain('Les transcriptions sont gardées');
    expect(text).toContain("l'OCR n'est pas refait");
    expect(text).toContain('proposée de nouveau à la prochaine ouverture');
    expect(text).not.toContain('mise à jour');
    expect(text).not.toContain('anciens extraits');
  });

  it('arrêtée : les sources restantes, et la proposition qui revient, jamais « elle reprendra là où elle s’est arrêtée »', async () => {
    const t = await translator('fr');
    for (const reason of ['no-embedding-provider', 'embedding-failed'] as const) {
      const text = describeReindexStatus(t, { phase: 'stopped', cause, reason, total: 3, remaining: 2 }, 'fr') ?? '';
      expect(text).toContain('nouveau modèle');
      expect(text).toContain('2 source(s) restent à réindexer');
      expect(text).toContain('proposée de nouveau');
      expect(text).not.toContain('là où elle s');
    }
  });

  it('finie, et les trois langues', async () => {
    for (const lng of ['fr', 'en', 'de'] as const) {
      const t = await translator(lng);
      const texts = [
        describeReindexStatus(t, { phase: 'running', cause, done: 1, total: 3, chunks: 9, waitingForSync: true }, lng),
        describeReindexStatus(t, { phase: 'running', cause, done: 3, total: 3, chunks: 9, waitingForSync: false }, lng),
        describeReindexStatus(t, { phase: 'stopped', cause, reason: 'embedding-failed', total: 3, remaining: 2 }, lng),
        describeReindexStatus(t, { phase: 'stopped', cause, reason: 'no-embedding-provider', total: 3, remaining: 2 }, lng),
        describeReindexStatus(t, { phase: 'done', cause, total: 3 }, lng),
      ];
      for (const text of texts) {
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/primarySources\.|\{\{/);
      }
      // Pas le texte de la réindexation d'une mise à jour.
      expect(texts[4]).not.toBe(describeReindexStatus(t, { phase: 'done', total: 3 }, lng));
    }
  });

  it('l’index qui passe à la dimension du modèle choisi : ni « pas été enregistré à la dernière fermeture », ni « tous les extraits », qu’il ne retrouve pas tant que d’autres sont à réindexer', async () => {
    const t = await translator('fr');
    const rebuilding = describeReindexStatus(t, { phase: 'rebuilding-index', cause, missing: 40648 }, 'fr') ?? '';
    expect(rebuilding).toContain('a changé dans les Paramètres');
    expect(rebuilding).toContain(`${(40648).toLocaleString('fr')} extrait(s)`);
    expect(rebuilding).toContain('que par leurs mots');
    expect(rebuilding).not.toContain('dernière fermeture');
    const rebuilt = describeReindexStatus(t, { phase: 'index-rebuilt', cause }, 'fr') ?? '';
    expect(rebuilt).toContain('reconstruit');
    expect(rebuilt).not.toContain('tous les extraits');

    for (const lng of ['fr', 'en', 'de'] as const) {
      const tl = await translator(lng);
      for (const status of [
        { phase: 'rebuilding-index', cause, missing: 12 },
        { phase: 'index-rebuilt', cause },
      ] as const) {
        const text = describeReindexStatus(tl, status, lng);
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/primarySources\.|\{\{/);
        expect(text).not.toBe(describeReindexStatus(tl, { ...status, cause: undefined }, lng));
      }
    }
  });
});
