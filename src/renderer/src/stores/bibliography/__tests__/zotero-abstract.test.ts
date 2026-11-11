/**
 * Le résumé d'une notice Zotero (`abstractNote`) arrive dans la fiche et dans la recherche du
 * panneau (J3). Le panneau le lit par `abstractOf` (G5), dans le champ `abstract` du `.bib` relu :
 * `toCitation` doit l'écrire là, et l'exporteur puis le parseur doivent le rendre intact.
 */
import { describe, it, expect } from 'vitest';
import { abstractOf } from '../citationAbstract';
import { zoteroItemToCitation } from '../../../../../../backend/integrations/zotero/toCitation';
import type { ZoteroItem } from '../../../../../../backend/integrations/zotero/ZoteroAPI';
import { BibTeXExporter } from '../../../../../../backend/core/bibliography/BibTeXExporter';
import { BibTeXParser } from '../../../../../../backend/core/bibliography/BibTeXParser';

const notice = (abstractNote: string): ZoteroItem =>
  ({
    key: 'AAA',
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key: 'AAA',
      version: 0,
      itemType: 'journalArticle',
      title: 'Digital Doping for Historians',
      creators: [{ creatorType: 'author', lastName: 'Kansteiner', firstName: 'Wulf' }],
      date: '2022',
      abstractNote,
    },
  }) as ZoteroItem;

/** Notice Zotero → `.bib` écrit → `.bib` relu, comme à la synchronisation puis à l'ouverture. */
const throughBib = (abstractNote: string) => {
  const written = new BibTeXExporter().exportToString([zoteroItemToCitation(notice(abstractNote), 'Kansteiner_2022')]);
  const [reread] = new BibTeXParser().parse(written);
  return { written, reread };
};

describe('résumé venu de Zotero, lu par la fiche après un aller-retour par le .bib', () => {
  it('abstractOf rend le résumé de Zotero', () => {
    const { reread } = throughBib('Un article sur l’IA et le métier d’historien.');
    expect(abstractOf(reread)).toBe('Un article sur l’IA et le métier d’historien.');
    expect(reread.notes).toBeUndefined();
  });

  it('accolades, caractères spéciaux et sauts de ligne : le texte revient, les blancs réduits', () => {
    const raw =
      'Sur {les} archives} : 50 % des cas & d’autres_choses, #1, $2, ~3, C:\\dossier\\, « guillemets », contact@example.org.\n\n' +
      'Second paragraphe,\u00a0avec une espace insécable.';
    const { written, reread } = throughBib(raw);

    // Écrit comme un champ libre, échappé : jamais en `note` (L05-7).
    expect(written).toContain('abstract = {Sur \\{les\\} archives\\} : 50 \\% des cas \\& d’autres\\_choses');
    expect(written).not.toContain('note =');
    expect(abstractOf(reread)).toBe(raw.replace(/[ \n]+/g, ' '));
  });
});
