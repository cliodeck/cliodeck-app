/**
 * Ce qui a empêché une passe Tropy, dit dans la langue de l'interface (L06-9) : après un changement
 * de modèle d'embeddings, la synchro n'écrit rien (`embedding-space-changed`), et une transcription
 * écrite n'est pas indexée. Le message dit pourquoi, avec les deux dimensions, et le geste qui
 * règle l'écart : le bouton « Réindexer » du panneau, dont le nom est vérifié ici.
 *
 * Les vraies chaînes, dans les trois langues.
 */
import { describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import fr from '../../../../../../public/locales/fr/common.json';
import en from '../../../../../../public/locales/en/common.json';
import de from '../../../../../../public/locales/de/common.json';
import { describeNotIndexed, describeSyncIssue } from '../sync-issues';

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

const issue = { code: 'embedding-space-changed', sources: 2, expected: 768, actual: 1024 } as const;

describe('sources primaires : le modèle d’embeddings a changé', () => {
  it('synchro : les sources non indexées, les deux dimensions, et le bouton qui règle l’écart', async () => {
    const t = await translator('fr');
    const text = describeSyncIssue(t, issue);

    expect(text).toContain('2 source(s) enregistrée(s), pas encore indexée(s)');
    expect(text).toContain('1024 dimensions');
    expect(text).toContain('768');
    expect(text).toContain('rien n\'a été écrit');
    expect(text).toContain(`« ${t('primarySources.reembed.action')} »`);
  });

  it('transcription écrite : pas « le modèle n’a pas répondu », mais le changement de modèle', async () => {
    const t = await translator('fr');
    const text = describeNotIndexed(t, 'embedding-space-changed');

    expect(text).toContain('a changé');
    expect(text).not.toContain("n'a pas répondu");
    expect(text).toContain(`« ${t('primarySources.reembed.action')} »`);
  });

  it('les trois langues ont leurs chaînes, interpolées, et nomment leur propre bouton', async () => {
    for (const lng of ['fr', 'en', 'de'] as const) {
      const t = await translator(lng);
      const action = t('primarySources.reembed.action');
      for (const text of [describeSyncIssue(t, issue), describeNotIndexed(t, 'embedding-space-changed')]) {
        expect(text).not.toMatch(/primarySources\.|\{\{/);
        expect(text).toContain(action);
      }
    }
  });
});
