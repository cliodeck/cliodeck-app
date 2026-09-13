import { describe, it, expect } from 'vitest';
import type { ZoteroItem } from '../ZoteroAPI';
import { zoteroItemToCitation, zoteroDate } from '../toCitation';

/**
 * Cas tirés d'une collection réelle, dont l'export sortait appauvri : ni
 * URL, ni DOI, ni pages ; un article du New York Times, un billet de blog,
 * une page web, deux preprints, une vidéo et un entretien tous en `@misc` ;
 * l'entretien et la vidéo sans aucun nom, faute de lire d'autres créateurs
 * que `author`.
 */

type Creator = { creatorType: string; firstName?: string; lastName?: string; name?: string };

function item(itemType: string, fields: Record<string, unknown>, creators: Creator[] = []): ZoteroItem {
  return {
    key: 'ITEM0001',
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: { key: 'ITEM0001', version: 0, itemType, creators, ...fields },
  } as ZoteroItem;
}

const author = (lastName: string, firstName: string): Creator => ({ creatorType: 'author', lastName, firstName });

describe('types de notice', () => {
  it('distingue un article de presse d’un article de revue', () => {
    const c = zoteroItemToCitation(
      item(
        'newspaperArticle',
        {
          title: 'A.I. Is Poised to Rewrite History. Literally.',
          publicationTitle: 'The New York Times',
          date: '2025-06-16 2025-06-16',
          url: 'https://www.nytimes.com/2025/06/16/magazine/ai-history.html',
          accessDate: '2025-06-20 08:12:33',
        },
        [author('Wasik', 'Bill')]
      ),
      'Wasik_2025'
    );

    expect(c.type).toBe('article');
    expect(c.journal).toBe('The New York Times');
    expect(c.customFields).toMatchObject({
      entrysubtype: 'newspaper',
      date: '2025-06-16',
      url: 'https://www.nytimes.com/2025/06/16/magazine/ai-history.html',
      urldate: '2025-06-20',
    });
  });

  it('marque un article de magazine', () => {
    const c = zoteroItemToCitation(
      item('magazineArticle', { title: 'When a black viking meets…', publicationTitle: 'Africa is a Country' }),
      'K'
    );
    expect(c.type).toBe('article');
    expect(c.customFields?.entrysubtype).toBe('magazine');
  });

  it('rattache un billet à son blog et une page à son site', () => {
    const billet = zoteroItemToCitation(
      item('blogPost', { title: 'Face à l’IA générative', blogTitle: "Atelier d'écologie politique" }),
      'K'
    );
    const page = zoteroItemToCitation(
      item('webpage', { title: 'Making history more accessible', websiteTitle: 'Europeana Pro' }),
      'K'
    );

    expect(billet.type).toBe('online');
    expect(billet.journal).toBe("Atelier d'écologie politique");
    expect(page.type).toBe('online');
    expect(page.journal).toBe('Europeana Pro');
  });

  it('donne à un preprint son dépôt et son identifiant', () => {
    const c = zoteroItemToCitation(
      item(
        'preprint',
        {
          title: 'Attention Is All You Need',
          repository: 'arXiv',
          archiveID: 'arXiv:1706.03762',
          DOI: '10.48550/arXiv.1706.03762',
          date: '2017-00-00 2017',
        },
        [author('Vaswani', 'Ashish')]
      ),
      'Vaswani_2017'
    );

    expect(c.type).toBe('online');
    expect(c.publisher).toBe('arXiv');
    expect(c.customFields).toMatchObject({ number: 'arXiv:1706.03762', doi: '10.48550/arXiv.1706.03762' });
    // Mois inconnu (`00`) : l'année suffit, pas de champ `date`.
    expect(c.customFields?.date).toBeUndefined();
  });

  it('place le recueil d’actes dans booktitle', () => {
    const c = zoteroItemToCitation(
      item('conferencePaper', {
        title: 'Retrieval augmented generation for historical newspapers',
        proceedingsTitle: 'Proceedings of JCDL 2024',
      }),
      'K'
    );
    expect(c.type).toBe('inproceedings');
    expect(c.booktitle).toBe('Proceedings of JCDL 2024');
    expect(c.journal).toBeUndefined();
  });

  it('donne à une thèse son université et sa nature', () => {
    const c = zoteroItemToCitation(
      item('thesis', { title: 'Une thèse', university: 'Université du Luxembourg', thesisType: 'Thèse de doctorat' }),
      'K'
    );
    expect(c.type).toBe('thesis');
    expect(c.publisher).toBe('Université du Luxembourg');
    expect(c.customFields?.type).toBe('Thèse de doctorat');
  });

  it('donne à un rapport son institution et son numéro', () => {
    const c = zoteroItemToCitation(
      item('report', { title: 'DAMMA Whitepaper', institution: 'Yale University', reportNumber: 'GSP-12', place: 'New Haven' }),
      'K'
    );
    expect(c.type).toBe('report');
    expect(c.publisher).toBe('Yale University');
    expect(c.customFields).toMatchObject({ number: 'GSP-12', address: 'New Haven' });
  });

  it('retombe sur @misc pour un type sans équivalent', () => {
    expect(zoteroItemToCitation(item('document', { title: 'Un document' }), 'K').type).toBe('misc');
  });
});

describe('créateurs qui tiennent lieu d’auteur', () => {
  it('nomme les personnes interviewées', () => {
    const c = zoteroItemToCitation(
      item('interview', { title: 'Autour de la Pensée sauvage' }, [
        { creatorType: 'interviewee', lastName: 'Lévi-Strauss', firstName: 'Claude' },
        { creatorType: 'interviewee', lastName: 'Ricoeur', firstName: 'Paul' },
        { creatorType: 'interviewer', lastName: 'Domenach', firstName: 'Jean-Marie' },
      ]),
      'K'
    );
    expect(c.author).toBe('Lévi-Strauss, Claude and Ricoeur, Paul');
  });

  it('nomme le réalisateur d’une vidéo, même hors du rôle principal du schéma', () => {
    // Le schéma Zotero attend `creator` ; la notice réelle dit `director`.
    const c = zoteroItemToCitation(
      item('videoRecording', { title: 'Wulf Kansteiner: Historical dialogue' }, [
        { creatorType: 'director', name: 'MAKINGHISTORIES' },
      ]),
      'K'
    );
    expect(c.type).toBe('video');
    expect(c.author).toBe('MAKINGHISTORIES');
  });

  it('préfère le rôle principal quand plusieurs sont présents', () => {
    const c = zoteroItemToCitation(
      item('videoRecording', { title: 'Documentaire' }, [
        { creatorType: 'director', lastName: 'Réalisatrice', firstName: 'A.' },
        { creatorType: 'creator', lastName: 'Autrice', firstName: 'B.' },
      ]),
      'K'
    );
    expect(c.author).toBe('Autrice, B.');
  });

  it('nomme le programmeur d’un logiciel', () => {
    const c = zoteroItemToCitation(
      item('computerProgram', { title: 'What Do AIs Know About History?', company: 'GitHub' }, [
        { creatorType: 'programmer', lastName: 'Hutchinson', firstName: 'Daniel' },
      ]),
      'K'
    );
    expect(c.type).toBe('software');
    expect(c.author).toBe('Hutchinson, Daniel');
    expect(c.publisher).toBe('GitHub');
  });
});

describe('localisateurs d’un article de revue', () => {
  it('exporte volume, numéro, pages et DOI', () => {
    const c = zoteroItemToCitation(
      item(
        'journalArticle',
        {
          title: 'Digital Doping for Historians',
          publicationTitle: 'History and Theory',
          volume: '61',
          issue: '4',
          pages: '119-133',
          DOI: '10.1111/hith.12278',
        },
        [author('Kansteiner', 'Wulf')]
      ),
      'Kansteiner_2022'
    );
    expect(c.customFields).toEqual({
      volume: '61',
      number: '4',
      pages: '119-133',
      doi: '10.1111/hith.12278',
    });
  });

  it('n’écrit pas de date de consultation sans URL', () => {
    const c = zoteroItemToCitation(item('journalArticle', { title: 'T', accessDate: '2025-01-01 10:00:00' }), 'K');
    expect(c.customFields?.urldate).toBeUndefined();
  });
});

describe('zoteroDate', () => {
  it('garde le jour et le mois connus', () => {
    expect(zoteroDate('2025-06-16 2025-06-16')).toBe('2025-06-16');
    expect(zoteroDate('2025-06-00 juin 2025')).toBe('2025-06');
  });

  it('se tait quand seule l’année est connue ou que la saisie n’est pas ISO', () => {
    expect(zoteroDate('2017-00-00 2017')).toBeUndefined();
    expect(zoteroDate('June 16, 2025')).toBeUndefined();
    expect(zoteroDate(undefined)).toBeUndefined();
  });
});

describe('URL à accolades', () => {
  it('est encodée dès la conversion, telle que le fichier la relira', () => {
    // Cas réel : le site du JDH livre à Zotero un gabarit non rempli.
    const c = zoteroItemToCitation(
      item('journalArticle', {
        title: 'Mapping the Latent Past',
        url: 'https://journalofdigitalhistory.org/en/article/${import.meta.env.VITE_BASEURL}',
      }),
      'K'
    );
    expect(c.customFields?.url).toBe('https://journalofdigitalhistory.org/en/article/$%7Bimport.meta.env.VITE_BASEURL%7D');
  });
});
