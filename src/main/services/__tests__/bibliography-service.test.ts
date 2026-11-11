/**
 * Un `.bib` absent ou illisible n'est pas une bibliographie vide (S07-1-11).
 *
 * `BibTeXParser.parseFile` avalait l'erreur de lecture et rendait `[]` : `bibliography:load` et
 * `load-with-metadata` répondaient succès avec 0 citation, le panneau se montrait vide sans un
 * mot, et l'import suivant remplaçait sans proposer la fusion. Le singleton du main, qui résout
 * les citations des exports, devenait vide lui aussi. Vrais fichiers, vrai service.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bibliographyService, rewriteProjectBibliography } from '../bibliography-service.js';
import { BibTeXParser } from '../../../../backend/core/bibliography/BibTeXParser.js';
import { BibTeXExporter } from '../../../../backend/core/bibliography/BibTeXExporter.js';
import { pandocAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const IS_ROOT = process.getuid?.() === 0;

let dir = '';
const GARDE = '@book{Garde_2000,\n  title = {Le temps des archives},\n  year = {2000},\n}\n';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-bib-service-'));
  const good = path.join(dir, 'bonne.bib');
  fs.writeFileSync(good, GARDE);
  await bibliographyService.loadFromFile(good);
});

afterEach(() => {
  const locked = path.join(dir, 'verrouille.bib');
  if (fs.existsSync(locked)) fs.chmodSync(locked, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

const loadedIds = () => bibliographyService.getCitations().map((c) => c.id);

describe('bibliographyService.loadFromFile', () => {
  it('absent : lève au lieu de rendre une liste vide, et le singleton reste en l’état', async () => {
    await expect(bibliographyService.loadFromFile(path.join(dir, 'renomme.bib'))).rejects.toMatchObject({
      code: 'bib-missing',
    });
    expect(loadedIds()).toEqual(['Garde_2000']);
  });

  it.skipIf(IS_ROOT)('droits retirés (EACCES) : illisible, et le singleton reste en l’état', async () => {
    const locked = path.join(dir, 'verrouille.bib');
    fs.writeFileSync(locked, GARDE.replace('Garde_2000', 'Autre_1999'));
    fs.chmodSync(locked, 0o000);

    await expect(bibliographyService.loadFromFile(locked)).rejects.toMatchObject({ reason: 'permission' });
    expect(loadedIds()).toEqual(['Garde_2000']);
  });

  it('pas en UTF-8 : illisible, pas relu avec des caractères de remplacement', async () => {
    const latin1 = path.join(dir, 'latin1.bib');
    fs.writeFileSync(latin1, Buffer.from('@book{Etat,\n  title = {L’État},\n}\n', 'latin1'));

    await expect(bibliographyService.loadFromFile(latin1)).rejects.toMatchObject({ reason: 'encoding' });
    expect(loadedIds()).toEqual(['Garde_2000']);
  });

  it('les entrées que le parseur a laissées sont rendues avec les autres', async () => {
    const partial = path.join(dir, 'partielle.bib');
    fs.writeFileSync(partial, `${GARDE}\n@misc{entretien_dupont,\n  note = {Entretien},\n}\n`);

    const result = await bibliographyService.loadFromFile(partial);

    expect(result.citations.map((c) => c.id)).toEqual(['Garde_2000']);
    expect(result.unreadKeys).toEqual(['entretien_dupont']);
  });
});

/**
 * Une arobase hors des entrées, juste avant l'une d'elles (J2) : « % voir aussi @Garde2000 », une
 * adresse, un `@comment(…)`. Le parseur la collait au type de l'entrée, et la synchronisation ou la
 * fusion réécrivaient « @univ-paris.example » sur une ligne, « @book{Garde2000, » sur la suivante :
 * pandoc refusait le fichier. Vrai parseur, vrai exporteur, vraie réécriture.
 */
describe('rewriteProjectBibliography — une arobase hors des entrées', () => {
  const GARDE2000 = '@book{Garde2000,\n  title = {Le temps des archives},\n  year = {2000},\n}\n';
  const LEDUC1990 = '@book{Leduc1990,\n  title = {Le carnet},\n  year = {1990},\n}\n';
  const COMMENT = '% voir aussi @Garde2000 pour le contexte';
  const ADDRESS = '%% Tenu par jean.dupont@univ-paris.example';
  const PARENS = '@comment(à revoir : pagination de Leduc1990)';
  const bibPath = () => path.join(dir, 'biblio.bib');

  /** Ce qu'écrivent la synchronisation et la fusion : les entrées réécrites depuis les citations, et ce qui n'en est pas. */
  async function rewritten(original: string): Promise<{ entries: string; written: string }> {
    fs.writeFileSync(bibPath(), original);
    const entries = new BibTeXExporter().exportToString(new BibTeXParser().parse(original));
    await rewriteProjectBibliography(dir, bibPath(), entries, { keepOutsideEntries: true });
    return { entries, written: fs.readFileSync(bibPath(), 'utf8') };
  }

  it.each([COMMENT, ADDRESS, PARENS])('« %s » juste avant la première entrée : la ligne reste en tête, à l’octet, et chaque entrée commence par @book{', async (line) => {
    const { entries, written } = await rewritten(`${line}\n${GARDE2000}\n${LEDUC1990}`);

    expect(entries.match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@book{Leduc1990,']);
    expect(written).toBe(`${line}\n\n${entries}`);
  });

  it('« % voir aussi @Garde2000 » entre deux entrées : la ligne passe en fin, entière, et chaque entrée commence par @book{', async () => {
    const { entries, written } = await rewritten(`${GARDE2000}\n${COMMENT}\n${LEDUC1990}`);

    expect(entries.match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@book{Leduc1990,']);
    expect(written).toBe(`${entries.trimEnd()}\n\n${COMMENT}\n`);
  });

  // pandoc 3.13 refuse un `@comment(…)` entre parenthèses, déjà dans le fichier d'origine (mesuré) :
  // ce cas n'est pas le sien.
  describe.skipIf(!pandocAvailable())('le vrai pandoc', () => {
    it.each([
      ['un commentaire % avant la première entrée', `${COMMENT}\n${GARDE2000}\n${LEDUC1990}`],
      ['une adresse dans l’en-tête', `${ADDRESS}\n\n${GARDE2000}\n${LEDUC1990}`],
      ['un commentaire % entre deux entrées', `${GARDE2000}\n${COMMENT}\n${LEDUC1990}`],
    ])('%s : pandoc lit le fichier réécrit, deux livres', async (_name, original) => {
      await rewritten(original);

      const run = spawnSync('pandoc', ['-f', 'biblatex', '-t', 'csljson', bibPath()], { encoding: 'utf8' });

      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      const items = JSON.parse(run.stdout) as Array<{ id: string; type: string }>;
      expect(items.map((item) => [item.id, item.type])).toEqual([
        ['Garde2000', 'book'],
        ['Leduc1990', 'book'],
      ]);
    });

    // Limite connue de J2, laissée à la décision de l'auteur. Un `.bib` déjà réécrit avant J2 porte
    // un débris de la ligne coupée : « @univ-paris.example » (avant H2 : seul en tête ; depuis H2 :
    // après le début de la ligne), ou « @Garde2000 pour le contexte » devant l'entrée. Relu, chaque
    // entrée retrouve son type ; le débris est du texte hors des entrées, repris à l'octet comme le
    // veut H2, et pandoc le refuse encore. Retiré à la main, le fichier passe.
    it.each([
      ['réécrit avant H2', '@univ-paris.example', (debris: string) => `${debris}\n\n${GARDE2000}\n${LEDUC1990}`],
      ['réécrit depuis H2', '@univ-paris.example', (debris: string) => `%% Tenu par jean.dupont\n\n${debris}\n\n${GARDE2000}\n${LEDUC1990}`],
      ['un commentaire coupé', '@Garde2000 pour le contexte', (debris: string) => `% Bibliographie\n\n${GARDE2000}\n\n${debris}\n${LEDUC1990}\n% voir aussi\n`],
    ])('un .bib abîmé avant J2 (%s) : les entrées retrouvent leur type, le débris reste, et pandoc le refuse encore', async (_name, debris, damaged) => {
      const { entries, written } = await rewritten(damaged(debris));

      expect(entries.match(/^@.*$/gm)).toEqual(['@book{Garde2000,', '@book{Leduc1990,']);
      expect(written.split('\n')).toContain(debris);
      const refused = spawnSync('pandoc', ['-f', 'biblatex', '-t', 'csljson', bibPath()], { encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(debris);

      fs.writeFileSync(bibPath(), written.split('\n').filter((line) => line !== debris).join('\n'));
      const repaired = spawnSync('pandoc', ['-f', 'biblatex', '-t', 'csljson', bibPath()], { encoding: 'utf8' });
      expect(repaired.status).toBe(0);
      expect((JSON.parse(repaired.stdout) as Array<{ id: string }>).map((item) => item.id)).toEqual(['Garde2000', 'Leduc1990']);
    });
  });
});
