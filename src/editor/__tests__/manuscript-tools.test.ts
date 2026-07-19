import { describe, expect, it } from 'vitest';
import { renumberManuscript, renumberFootnotes } from '../footnote-tools';
import { collectCitationKeys } from '../citation-tools';

describe('renumberManuscript — numérotation continue', () => {
  const docs = [
    {
      key: 'ch1.md',
      content: '# Un\n\nTexte[^1] et suite[^2].\n\n[^1]: Première.\n[^2]: Deuxième.\n',
    },
    {
      key: 'ch2.md',
      content: '# Deux\n\nAutre note[^1].\n\n[^1]: Note du chapitre deux.\n',
    },
    {
      key: 'ch3.md',
      content: '# Trois\n\nEncore[^1] et[^2].\n\n[^1]: A.\n[^2]: B.\n',
    },
  ];

  it('poursuit la numérotation d’un chapitre à l’autre', () => {
    const out = renumberManuscript(docs, 'continuous');
    expect(out[0].content).toContain('Texte[^1] et suite[^2]');
    expect(out[1].content).toContain('Autre note[^3]');
    expect(out[1].content).toContain('[^3]: Note du chapitre deux.');
    expect(out[2].content).toContain('Encore[^4] et[^5]');
  });

  it('ne signale changed que pour les chapitres réellement modifiés', () => {
    const out = renumberManuscript(docs, 'continuous');
    expect(out.map((d) => d.changed)).toEqual([false, true, true]);
  });

  it('est idempotente', () => {
    const once = renumberManuscript(docs, 'continuous');
    const twice = renumberManuscript(
      once.map((d) => ({ key: d.key, content: d.content })),
      'continuous'
    );
    expect(twice.map((d) => d.content)).toEqual(once.map((d) => d.content));
    expect(twice.every((d) => !d.changed)).toBe(true);
  });

  it('préserve le reste du document octet pour octet', () => {
    const source = '# T\r\n\r\nNote[^1].\r\n\r\n[^1]: Corps.\r\n';
    const out = renumberManuscript(
      [{ key: 'a', content: 'x[^1]\n\n[^1]: y\n' }, { key: 'b', content: source }],
      'continuous'
    );
    expect(out[1].content).toBe('# T\r\n\r\nNote[^2].\r\n\r\n[^2]: Corps.\r\n');
  });

  it('laisse les identifiants libres intacts', () => {
    const out = renumberManuscript(
      [
        { key: 'a', content: 'x[^1]\n\n[^1]: un\n' },
        { key: 'b', content: 'y[^lester]\n\n[^lester]: libre\n' },
      ],
      'continuous'
    );
    expect(out[1].content).toContain('[^lester]');
    expect(out[1].changed).toBe(false);
  });

  it('ignore les notes des blocs de code', () => {
    const out = renumberManuscript(
      [
        { key: 'a', content: 'x[^1]\n\n[^1]: un\n' },
        {
          key: 'b',
          content: '```md\n[^99]: pas une note\n```\n\nvrai[^1]\n\n[^1]: deux\n',
        },
      ],
      'continuous'
    );
    expect(out[1].content).toContain('[^99]: pas une note'); // bloc intact
    expect(out[1].content).toContain('vrai[^2]');
  });
});

describe('renumberManuscript — numérotation par chapitre', () => {
  it('fait repartir chaque chapitre à 1', () => {
    const out = renumberManuscript(
      [
        { key: 'a', content: 'x[^3]\n\n[^3]: un\n' },
        { key: 'b', content: 'y[^7]\n\n[^7]: deux\n' },
      ],
      'per-chapter'
    );
    expect(out[0].content).toContain('x[^1]');
    expect(out[1].content).toContain('y[^1]');
  });
});

describe('renumberFootnotes — compatibilité document isolé', () => {
  it('garde son comportement historique et expose le prochain numéro', () => {
    const result = renumberFootnotes('a[^5] b[^9]\n\n[^5]: A\n[^9]: B\n');
    expect(result.content).toContain('a[^1] b[^2]');
    expect(result.changed).toBe(true);
    expect(result.nextNumber).toBe(3);
  });
});

describe('collectCitationKeys', () => {
  it('relève chaque clé d’un cluster', () => {
    const keys = collectCitationKeys('Texte [@lester1932; @clavert2013, p. 12].\n');
    expect(keys.map((k) => k.key)).toEqual(['lester1932', 'clavert2013']);
  });

  it('relève les citations nues', () => {
    expect(collectCitationKeys('Selon @lester1932, ceci.\n').map((k) => k.key)).toEqual([
      'lester1932',
    ]);
  });

  it('ignore les blocs de code et les adresses courriel', () => {
    const source = [
      '```md',
      '[@faux1932]',
      '```',
      '',
      'Écrire à frederic.clavert@uni.lu, citer [@vrai2013].',
      '',
    ].join('\n');
    expect(collectCitationKeys(source).map((k) => k.key)).toEqual(['vrai2013']);
  });

  it('renseigne les numéros de ligne', () => {
    const keys = collectCitationKeys('# T\n\n[@a1900]\n\ntexte\n\n[@b1910]\n');
    expect(keys.map((k) => [k.key, k.line])).toEqual([
      ['a1900', 3],
      ['b1910', 7],
    ]);
  });
});
