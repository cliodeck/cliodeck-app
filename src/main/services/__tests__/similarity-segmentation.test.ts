/**
 * Découpage en phrases du chercheur de similarité (S13-1-7).
 *
 * Chaque abréviation de la liste devenait une expression sans limite de mot, appliquée sans
 * égard à la casse : « M. » prenait la fin de « Potsdam. », « ed. » celle de « signed. », « op. »
 * celle de « trop. ». Le point disparaissait dans un marqueur, et la phrase suivante était
 * fusionnée. La restauration réinjectait la dernière forme vue de chaque abréviation (« M. Dupont »
 * devenait « m. Dupont »), et les lignes se comptaient sur le texte à marqueurs, sans les
 * séparateurs perdus : elles dérivaient d'une ligne par phrase.
 *
 * Vrai service. La recherche, l'état des corpus et le projet courant sont simulés : ce qui compte
 * ici, ce sont les segments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ projectPath: null as string | null }));

vi.mock('../pdf-service.js', () => ({
  pdfService: {
    search: async () => [],
    getIndexFreshness: () => ({ documentCount: 1, chunkCount: 1, lastIndexedAt: null, rebuildDue: false }),
  },
}));
vi.mock('../tropy-service.js', () => ({ tropyService: { getIndexFreshness: () => null } }));
vi.mock('../project-manager.js', () => ({ projectManager: { getCurrentProjectPath: () => h.projectPath } }));

import { similarityService } from '../similarity-service.js';

const sentences = (text: string) => similarityService.segmentText(text, 'sentence');
const contents = (text: string) => sentences(text).map((s) => s.content);

describe('découpage en phrases — une abréviation ne prend pas la fin d’un mot (S13-1-7)', () => {
  it.each([
    ['« Potsdam. » (M.)', 'Les Alliés se réunissent à Potsdam. Truman y rencontre Staline.', [
      'Les Alliés se réunissent à Potsdam.',
      'Truman y rencontre Staline.',
    ]],
    ['« signed. » (ed.)', 'The treaty was signed. It changed everything.', [
      'The treaty was signed.',
      'It changed everything.',
    ]],
    ['« trop. » (op.)', 'C’est trop. On continue.', ['C’est trop.', 'On continue.']],
    ['« 4 000 m. » : un m minuscule n’est pas « M. »', 'Le sommet culmine à 4 000 m. Les alpinistes y montent.', [
      'Le sommet culmine à 4 000 m.',
      'Les alpinistes y montent.',
    ]],
  ])('%s', (_name, text, expected) => {
    expect(contents(text)).toEqual(expected);
  });

  it('« M. Dupont » garde sa capitale, et sa phrase reste entière', () => {
    expect(contents('M. Dupont arrive. Il vient de Potsdam. Fin du récit ici.')).toEqual([
      'M. Dupont arrive.',
      'Il vient de Potsdam.',
      'Fin du récit ici.',
    ]);
  });
});

describe('découpage en phrases — les abréviations restent des abréviations', () => {
  it('« p. 12 » ne coupe pas', () => {
    const found = contents('Voir Braudel, p. 12 et suivantes. La suite vient ensuite.');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('p. 12 et suivantes');
  });

  it('« vol. II, » : un numéro de volume en chiffres romains ne coupe pas', () => {
    const found = contents('Voir Braudel, vol. II, p. 45. La suite vient ensuite.');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('vol. II, p. 45');
  });

  // Revue de L11-3 : seul « vol. II, » était testé, la virgule cachait le cas. L'ancien découpage
  // (main) gardait ces renvois entiers ; la première réécriture les coupait après l'abréviation.
  it.each([
    ['« vol. IV de »', 'Lavisse, Histoire de France, vol. IV de l’édition Hachette. La suite vient.', [
      'Lavisse, Histoire de France, vol. IV de l’édition Hachette.',
      'La suite vient.',
    ]],
    ['« chap. III et »', 'Voir chap. III et la conclusion. La suite vient.', [
      'Voir chap. III et la conclusion.',
      'La suite vient.',
    ]],
    ['« p. xiv. » : une page liminaire en minuscules', 'Voir la préface, p. xiv. La suite vient.', [
      'Voir la préface, p. xiv.',
      'La suite vient.',
    ]],
    ['« pp. xii-xv »', 'Voir l’introduction, pp. xii-xv et la note. La suite vient.', [
      'Voir l’introduction, pp. xii-xv et la note.',
      'La suite vient.',
    ]],
    ['« Bd. II des »', 'Siehe Müller, Bd. II des Werkes. Der Band ist vergriffen.', [
      'Siehe Müller, Bd. II des Werkes.',
      'Der Band ist vergriffen.',
    ]],
  ])('un chiffre romain suivi d’un blanc ne coupe pas : %s', (_name, text, expected) => {
    expect(contents(text)).toEqual(expected);
  });

  it('« He said no. I left. » : devant le pronom « I », « no » finit la phrase', () => {
    expect(contents('He said no. I left.')).toEqual(['He said no.', 'I left.']);
    expect(contents('He said no. I, for one, left.')).toEqual(['He said no.', 'I, for one, left.']);
  });

  it('« C’était un vol. » : devant autre chose qu’un nombre, « vol » est un mot', () => {
    expect(contents('C’était un vol. Il fut puni.')).toEqual(['C’était un vol.', 'Il fut puni.']);
  });

  it('en capitales, un mot fait de lettres romaines n’est pas un numéro : « vol. IL FUT »', () => {
    expect(contents('C’était un vol. IL FUT PUNI.')).toEqual(['C’était un vol.', 'IL FUT PUNI.']);
  });

  it('latin et renvois, toujours : « cf. », « i.e. », « op. cit. », « ibid. »', () => {
    const found = contents(
      'Les ligues, i.e. les mouvements nationalistes, défilent (cf. Soucy, op. cit. Ibid. 12). La police charge.'
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('(cf. Soucy, op. cit. Ibid. 12)');
  });

  it('« etc. » devant une minuscule ne coupe pas', () => {
    const found = contents('Des fusils, des sabres, etc. furent saisis. La suite vient ensuite.');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('etc. furent saisis');
  });

  it('« etc. » devant une capitale finit la phrase', () => {
    expect(contents('On saisit des fusils, des sabres, etc. Le préfet fit rapport.')).toEqual([
      'On saisit des fusils, des sabres, etc.',
      'Le préfet fit rapport.',
    ]);
  });
});

describe('découpage en phrases — allemand', () => {
  it('« z. B. » et « z.B. » ne coupent pas', () => {
    expect(contents('Viele Quellen, z. B. die Akten des Auswärtigen Amts, fehlen. Der Rest ist verloren.')).toEqual([
      'Viele Quellen, z. B. die Akten des Auswärtigen Amts, fehlen.',
      'Der Rest ist verloren.',
    ]);
    expect(contents('Viele Quellen, z.B. die Akten, fehlen. Der Rest ist verloren.')).toHaveLength(2);
  });

  it('« S. 12 », « Nr. 5 », « Bd. 3 » devant un nombre ne coupent pas ; « Nr. 5. » finit la phrase', () => {
    expect(contents('Siehe Müller, Bd. 3, S. 12 und Nr. 5. Der Band ist vergriffen.')).toEqual([
      'Siehe Müller, Bd. 3, S. 12 und Nr. 5.',
      'Der Band ist vergriffen.',
    ]);
  });

  it('« vgl. », « Hg. », « bzw. » ne coupent pas', () => {
    expect(contents('Vgl. Schmidt, Hg. Meier, bzw. Die Neuauflage von 1990. Sie ist vergriffen.')).toEqual([
      'Vgl. Schmidt, Hg. Meier, bzw. Die Neuauflage von 1990.',
      'Sie ist vergriffen.',
    ]);
  });

  // Revue de L11-3 : la date et le siècle s'écrivent avec un ordinal (« 9. », « 19. »).
  it.each([
    ['« Am 9. November »', 'Am 9. November 1989 fiel die Mauer. Danach kam die Einheit.', [
      'Am 9. November 1989 fiel die Mauer.',
      'Danach kam die Einheit.',
    ]],
    ['« am 14. Juli »', 'Er kam am 14. Juli in Paris an. Dann ging er.', [
      'Er kam am 14. Juli in Paris an.',
      'Dann ging er.',
    ]],
    ['« im 19. Jh. entstand »', 'Im 19. Jh. entstand die Bewegung. Sie wuchs schnell.', [
      'Im 19. Jh. entstand die Bewegung.',
      'Sie wuchs schnell.',
    ]],
    ['« im 18. Jahrhundert »', 'Im 18. Jahrhundert wuchs die Stadt. Sie wurde reich.', [
      'Im 18. Jahrhundert wuchs die Stadt.',
      'Sie wurde reich.',
    ]],
    ['« seit dem 1. Mai »', 'Seit dem 1. Mai wird gestreikt. Die Lage ist ernst.', [
      'Seit dem 1. Mai wird gestreikt.',
      'Die Lage ist ernst.',
    ]],
    ['« Berlin, den 9. November »', 'Berlin, den 9. November 1989. Lieber Freund, die Mauer ist offen.', [
      'Berlin, den 9. November 1989.',
      'Lieber Freund, die Mauer ist offen.',
    ]],
    ['« Ende 19. Jh. » : le siècle, sans article', 'Gegen Ende 19. Jh. entstand die Bewegung. Sie wuchs schnell.', [
      'Gegen Ende 19. Jh. entstand die Bewegung.',
      'Sie wuchs schnell.',
    ]],
  ])('un ordinal de date ou de siècle ne coupe pas : %s', (_name, text, expected) => {
    expect(contents(text)).toEqual(expected);
  });

  // Deuxième revue de L11-3 : « April », « August », « September », « November » s'écrivent aussi
  // en anglais, et « Mai » ouvre une phrase française (« Mai 68 »). Un mois ne fait un ordinal du
  // nombre qui le précède qu'après une préposition ou un article allemands (« am », « vom »,
  // « den »…), comme sur `main` ailleurs.
  it.each([
    ['un renvoi de page, puis « Mai 68 »', 'Voir Dupont, op. cit., p. 45. Mai 68 marque une rupture.', [
      'Voir Dupont, op. cit., p. 45.',
      'Mai 68 marque une rupture.',
    ]],
    ['un renvoi de page, puis « August 1914 »', 'See Smith, p. 12. August 1914 marked a turning point.', [
      'See Smith, p. 12.',
      'August 1914 marked a turning point.',
    ]],
    ['un résultat de vote, puis « November »', 'The vote was 52 to 48. November elections followed soon after.', [
      'The vote was 52 to 48.',
      'November elections followed soon after.',
    ]],
    ['un âge, puis « Mai 68 »', 'Il avait 20. Mai 68 arriva ensuite.', ['Il avait 20.', 'Mai 68 arriva ensuite.']],
    ['« S. 12. », puis « Juli 1914 », en allemand', 'Siehe Müller, S. 12. Juli 1914 brachte die Krise.', [
      'Siehe Müller, S. 12.',
      'Juli 1914 brachte die Krise.',
    ]],
  ])('un nombre qui finit une phrase devant un mois, sans préposition allemande, coupe : %s', (_name, text, expected) => {
    expect(contents(text)).toEqual(expected);
  });

  it('« Jh. » comme « etc. » : devant une capitale, il finit la phrase', () => {
    expect(contents('Die Bewegung entstand im 19. Jh. Danach wuchs sie.')).toEqual([
      'Die Bewegung entstand im 19. Jh.',
      'Danach wuchs sie.',
    ]);
  });

  it('un nombre qui finit une phrase devant un autre mot qu’un mois ou un siècle coupe', () => {
    expect(contents('The quote is on page 12. The rest follows.')).toEqual([
      'The quote is on page 12.',
      'The rest follows.',
    ]);
  });

  it('« usw. » comme « etc. » : devant une minuscule ne coupe pas, devant une capitale si', () => {
    expect(contents('Äpfel, Birnen usw. wurden verkauft. Dann kam der Winter.')).toHaveLength(2);
    expect(contents('Er kaufte Äpfel, Birnen usw. Dann kam der Winter.')).toEqual([
      'Er kaufte Äpfel, Birnen usw.',
      'Dann kam der Winter.',
    ]);
  });
});

describe('découpage en phrases — les lignes sont celles du texte', () => {
  const FOUR_LINES = [
    'Première phrase de la ligne une.',
    'Deuxième phrase de la ligne deux.',
    'Troisième phrase de la ligne trois.',
    'Quatrième phrase de la ligne quatre.',
  ];

  it('quatre phrases sur quatre lignes : lignes 0, 1, 2, 3', () => {
    const found = sentences(FOUR_LINES.join('\n'));
    expect(found.map((s) => [s.startLine, s.endLine])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('une phrase sur deux lignes, après un paragraphe : ses deux lignes', () => {
    const found = sentences('Un paragraphe.\n\nUne phrase\nsur deux lignes. Une autre suit.');
    expect(found.map((s) => [s.content, s.startLine, s.endLine])).toEqual([
      ['Un paragraphe.', 0, 0],
      ['Une phrase\nsur deux lignes.', 2, 3],
      ['Une autre suit.', 3, 3],
    ]);
  });

  describe('un document CRLF analysé', () => {
    let project = '';
    beforeEach(() => {
      project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarite-phrases-'));
      fs.mkdirSync(path.join(project, '.cliodeck'));
      h.projectPath = project;
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      h.projectPath = null;
      fs.rmSync(project, { recursive: true, force: true });
    });

    it('ses lignes sont celles de l’éditeur, sans \\r', async () => {
      const results = await similarityService.analyzeDocument(
        FOUR_LINES.join('\r\n'),
        { granularity: 'sentence', useReranking: false, useContextualEmbedding: false },
        undefined,
        path.join(project, 'document.md')
      );
      expect(results.map((r) => r.segment.startLine)).toEqual([0, 1, 2, 3]);
      expect(results.map((r) => r.segment.content)).toEqual(FOUR_LINES);
    });
  });
});
