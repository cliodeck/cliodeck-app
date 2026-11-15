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

  it('« C’était un vol. » : devant autre chose qu’un nombre, « vol » est un mot', () => {
    expect(contents('C’était un vol. Il fut puni.')).toEqual(['C’était un vol.', 'Il fut puni.']);
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
