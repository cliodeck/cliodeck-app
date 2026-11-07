/**
 * Un `.bib` absent ou illisible n'est pas une bibliographie vide (S07-1-11).
 *
 * `BibTeXParser.parseFile` avalait l'erreur de lecture et rendait `[]` : `bibliography:load` et
 * `load-with-metadata` répondaient succès avec 0 citation, le panneau se montrait vide sans un
 * mot, et l'import suivant remplaçait sans proposer la fusion. Le singleton du main, qui résout
 * les citations des exports, devenait vide lui aussi. Vrais fichiers, vrai service.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bibliographyService } from '../bibliography-service.js';

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
