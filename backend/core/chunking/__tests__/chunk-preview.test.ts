/**
 * L'aperçu d'un extrait, sur la carte d'une recommandation et dans le prompt de reclassement
 * (S13-2-0).
 *
 * Il valait les 200 premiers caractères du contenu brut : le préfixe « [Doc: <titre>] », puis le
 * recouvrement, soit la fin de l'extrait précédent (médianes mesurées sur trois bases réelles :
 * 69 à 86 caractères d'en-tête, 348 à 369 de recouvrement). Dans 9 cas sur 10, aucun caractère du
 * passage trouvé.
 *
 * Les extraits d'essai imitent ceux de `AdaptiveChunker` : en-tête, ligne vide, quatre phrases de
 * recouvrement (« R1 » à « R4 »), puis dix-huit phrases propres (« P1 » à « P18 »).
 */
import { describe, expect, it } from 'vitest';
import { chunkPreview } from '../chunk-preview';

const overlapSentence = (n: number) => `Le recouvrement R${n} reprend la fin de l’extrait précédent sur la Ruhr.`;
const ownSentence = (n: number) => `La Haute Autorité examine le dossier P${n} des houillères lorraines en séance.`;

const chunk = (own: (n: number) => string = ownSentence) =>
  '[Doc: Les syndicats européens face à la CECA, 1950-1957]\n\n' +
  [1, 2, 3, 4].map(overlapSentence).join(' ') +
  ' ' +
  Array.from({ length: 18 }, (_, i) => own(i + 1)).join(' ');

const cited = (letter: 'P' | 'R', text: string) =>
  [...text.matchAll(new RegExp(`\\b${letter}(\\d+)\\b`, 'g'))].map((m) => Number(m[1]));

describe('chunkPreview — le passage, sans l’en-tête', () => {
  it('requête dans une autre langue : la fenêtre du milieu, sans un mot du recouvrement', () => {
    const preview = chunkPreview(chunk(), 'What did the trade unions say about the coal pool?');

    expect(preview).not.toContain('[Doc:');
    expect(cited('R', preview)).toEqual([]);
    const own = cited('P', preview);
    expect(own.length).toBeGreaterThan(0);
    // Le milieu des dix-huit phrases propres, pas leur début ni leur fin.
    expect(Math.min(...own)).toBeGreaterThan(3);
    expect(Math.max(...own)).toBeLessThan(16);
  });

  it('les mots de la requête attirent la fenêtre, accents repliés', () => {
    const text = chunk((n) =>
      n === 15
        ? 'La conférence de Messine relance la construction européenne en juin 1955.'
        : ownSentence(n)
    );

    expect(chunkPreview(text, 'Apres la conference de Messine')).toContain('La conférence de Messine relance');
  });

  it('tronqué : commence à une phrase et le dit par « … » aux deux bouts', () => {
    const preview = chunkPreview(chunk(), 'What did the trade unions say about the coal pool?');

    expect(preview).toMatch(/^… La Haute Autorité examine le dossier P\d+ /);
    expect(preview.endsWith(' …')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(240 + 4);
  });

  it('un titre qui contient « ] » : l’en-tête part en entier', () => {
    const content = '[Doc: Les colonies [1830-1962] | Section: Introduction]\n\nL’Algérie est conquise à partir de 1830.';

    expect(chunkPreview(content, 'Algérie')).toBe('L’Algérie est conquise à partir de 1830.');
  });

  it('un extrait plus court que maxChars : rendu entier, blancs réduits', () => {
    const content = '[Doc: Titre]\n\nUn extrait court,\nsur deux lignes.';

    expect(chunkPreview(content, 'extrait')).toBe('Un extrait court, sur deux lignes.');
    const long = chunk();
    expect(chunkPreview(long, 'Ruhr', long.length)).toBe(
      long.slice(long.indexOf('\n\n') + 2).replace(/\s+/g, ' ')
    );
  });

  // Revue de L11-3 : le premier mot comptait comme un début de phrase. Sans autre fin de phrase
  // (un OCR de télégrammes, un registre) et sans mot de la requête, la fenêtre 0 l'emportait sur
  // celle du milieu : l'en-tête « Titre: … Date: … » de la source primaire, donc le titre une
  // deuxième fois.
  it('sans ponctuation ni mot de la requête : la fenêtre du milieu, pas le début', () => {
    const content =
      'Titre: Télégrammes du préfet\nDate: 1934-02-06\nArchive: AN F7 13305\n\n' +
      Array.from({ length: 60 }, (_, n) => `ARRIVEE TROUPES SECTEUR ${n} CALME SIGNALE PREFET STOP`).join(' ');

    const preview = chunkPreview(content, 'Was the strike widespread?');

    expect(preview).not.toContain('Titre:');
    expect(preview.startsWith('… ')).toBe(true);
    const sectors = [...preview.matchAll(/SECTEUR (\d+)/g)].map((m) => Number(m[1]));
    expect(sectors.length).toBeGreaterThan(0);
    expect(Math.min(...sectors)).toBeGreaterThan(20);
    expect(Math.max(...sectors)).toBeLessThan(40);
  });

  it('sans en-tête (source primaire) : le texte tel quel', () => {
    expect(chunkPreview('Titre: Rapport du préfet\nArchive: AN F7', 'préfet')).toBe(
      'Titre: Rapport du préfet Archive: AN F7'
    );
  });
});
