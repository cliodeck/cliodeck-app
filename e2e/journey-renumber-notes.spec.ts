/**
 * Renuméroter les notes d'un livre où une note a été insérée à la main sous un
 * numéro déjà pris (BT1-3), dans la vraie app.
 *
 * L'auteur insère une note entre deux paragraphes et lui donne le numéro de sa
 * place, déjà porté par la note suivante. La correspondance par numéro
 * répondait « Les notes sont déjà numérotées dans l'ordre. » ; à l'export,
 * pandoc ne garde que la dernière définition d'un numéro, et le texte de
 * l'autre note disparaissait du Word.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { launchApp } from './_helpers/launch';
import { pandocAvailable } from '../backend/__tests__/helpers/native-guards';

const FIRST = '# Premier\n\nTexte[^1] et suite[^2].\n\n[^1]: NOTE-UN.\n[^2]: NOTE-DEUX.\n';
// Numérotation continue déjà juste, sauf la note ajoutée sous le numéro 4.
const SECOND =
  '# Second\n\nUn[^3].\n\nAjout[^4].\n\n[^4]: NOTE-AJOUTEE.\n\nDeux[^4] trois[^5].\n\n' +
  '[^3]: NOTE-TROIS.\n[^4]: NOTE-QUATRE.\n[^5]: NOTE-CINQ.\n';
const SECOND_RENUMBERED =
  '# Second\n\nUn[^3].\n\nAjout[^4].\n\n[^4]: NOTE-AJOUTEE.\n\nDeux[^5] trois[^6].\n\n' +
  '[^3]: NOTE-TROIS.\n[^5]: NOTE-QUATRE.\n[^6]: NOTE-CINQ.\n';
// Définition collée au paragraphe : pandoc l'imprime en clair, ce n'est pas une note.
const THIRD = '# Troisième\n\nFin[^6].\n[^6]: collée au paragraphe.\n';

interface Book {
  dir: string;
  projectJson: string;
  chapter: (n: 1 | 2 | 3) => string;
}

function makeBook(withThird: boolean): Book {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-notes-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'));
  const chapter = (n: 1 | 2 | 3) => join(dir, 'chapters', `0${n}.md`);
  writeFileSync(chapter(1), FIRST);
  writeFileSync(chapter(2), SECOND);
  if (withThird) writeFileSync(chapter(3), THIRD);
  // Une bibliographie : c'est elle qui fait passer l'export Word par pandoc.
  writeFileSync(
    join(dir, 'references.bib'),
    '@book{dupont2020,\n  author = {Dupont, Jean},\n  title = {Un titre},\n  year = {2020},\n}\n',
  );
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000031',
      name: 'Livre notes',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bibliographySource: { type: 'file', filePath: 'references.bib' },
      book: { noteNumbering: 'continuous' },
      chapters: [
        { id: 'c1', title: 'Premier', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Second', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
        ...(withThird
          ? [{ id: 'c3', title: 'Troisième', filePath: 'chapters/03.md', order: 2, kind: 'chapter' }]
          : []),
      ],
    }),
  );
  return { dir, projectJson, chapter };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editorOf = (window: Page) => window.locator('.codemirror-editor .cm-content');
const renumberButton = (window: Page) => window.locator('button[title="Renuméroter les notes"]').first();
const alertOf = (window: Page) => window.locator('#alert-dialog-message');

test('livre : une note insérée sous un numéro déjà pris devient une note distincte, et ce qui reste sans lien est dit', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook(true);

  try {
    await openProject(app, window, book.projectJson);
    await expect(editorOf(window)).toContainText('Premier', { timeout: 20_000 });

    await renumberButton(window).click();
    const alert = alertOf(window);
    await expect(alert).toContainText('Notes renumérotées dans 2 chapitre(s).', { timeout: 10_000 });
    await expect(alert).not.toContainText('déjà numérotées');
    // La définition collée, que pandoc imprimerait en clair, est nommée avec son chapitre.
    await expect(alert).toContainText('Définition collée au paragraphe qui la précède : [^7] (« Troisième »).');
    await expect(alert).toContainText('Ajoutez une ligne vide avant');
    await window.locator('.alert-dialog-btn-ok').click();

    expect(readFileSync(book.chapter(2), 'utf8')).toBe(SECOND_RENUMBERED);
    expect(readFileSync(book.chapter(3), 'utf8')).toBe(THIRD.replaceAll('[^6]', '[^7]'));
    expect(readFileSync(book.chapter(1), 'utf8')).toBe(FIRST);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.dir, { recursive: true, force: true });
  }
});

test('livre renuméroté puis exporté en Word par pandoc : chaque texte de note y est une fois', async () => {
  test.skip(!pandocAvailable(), 'pandoc absent : l’export Word par pandoc n’est pas vérifiable ici.');
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeBook(false);

  try {
    await openProject(app, window, book.projectJson);
    await expect(editorOf(window)).toContainText('Premier', { timeout: 20_000 });

    await renumberButton(window).click();
    await expect(alertOf(window)).toContainText('Notes renumérotées dans 1 chapitre(s).', { timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();
    expect(readFileSync(book.chapter(2), 'utf8')).toBe(SECOND_RENUMBERED);

    await window.locator('button[title="Exporter en Word"]').first().click();
    await window.locator('.pdf-export-footer .btn-export').click();
    await expect(window.locator('.export-success')).toBeVisible({ timeout: 60_000 });

    const zip = new PizZip(readFileSync(join(book.dir, 'Livre notes.docx')));
    const plain = (name: string): string => (zip.file(name)?.asText() ?? '').replace(/<[^>]+>/g, '');
    const footnotes = plain('word/footnotes.xml');
    for (const note of ['NOTE-UN', 'NOTE-DEUX', 'NOTE-TROIS', 'NOTE-AJOUTEE', 'NOTE-QUATRE', 'NOTE-CINQ']) {
      expect(footnotes.split(note).length - 1, note).toBe(1);
    }
    expect(plain('word/document.xml')).not.toContain('[^');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.dir, { recursive: true, force: true });
  }
});
