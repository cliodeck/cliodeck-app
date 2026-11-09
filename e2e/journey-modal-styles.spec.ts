/**
 * Une fenêtre modale a la même allure, quels que soient les panneaux ouverts avant elle (H1).
 *
 * Les règles de base des classes `modal-*` n'étaient écrites que dans la feuille de la fenêtre
 * OCR, chargée avec le panneau Sources primaires, à la demande : tant qu'il n'avait pas été
 * ouvert, le choix d'import d'un `.bib` et son récapitulatif s'affichaient sans voile, en bas de
 * la colonne de gauche, rognés. Dans l'autre sens, la feuille de la Méthodologie posait
 * `.modal-content` et `.modal-header` sans portée : une fois ouverte, elle décalait les autres
 * fenêtres ; et quand les Sources primaires venaient après elle, sa FAQ ne défilait plus.
 * L'ordre des feuilles chargées n'existe que dans l'app réelle : Vitest n'en montre rien.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';
import { makeTpy } from '../backend/integrations/tropy/__tests__/helpers/make-tpy';

const toClean: string[] = [];
let ollama: FakeOllama | null = null;

test.afterEach(async () => {
  await ollama?.close();
  ollama = null;
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, title: string, author: string, year: string) =>
  `@book{${id},\n  author = {${author}},\n  title = {${title}},\n  year = {${year}},\n}\n`;

interface Layout {
  projectJson: string;
  importBib: string;
  /** Une autre référence : un second « Fusionner » donne un récapitulatif de même forme que le premier. */
  importBib2: string;
  /** Un projet dont le `.bib` ne se lit pas : l'import ouvre la variante « premier import ». */
  badProjectJson: string;
  tpy: string;
}

function makeLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-modales-'));
  toClean.push(root);
  const project = join(root, 'Thèse');
  mkdirSync(project);
  const projectJson = join(project, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000d1',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bibliographySource: { type: 'file', filePath: 'bibliography.bib' },
    }),
  );
  writeFileSync(join(project, 'document.md'), '# Thèse\n\nUn paragraphe.\n');
  writeFileSync(
    join(project, 'bibliography.bib'),
    [entry('garde2000', 'Le temps des archives', 'Garde, Anne', '2000'), entry('martin2015', "Les dépôts d'archives", 'Martin, Anne', '2015')].join('\n'),
  );
  const importBib = join(root, 'import.bib');
  writeFileSync(importBib, entry('leroy2018', 'Lire les registres', 'Leroy, Paul', '2018'));
  const importBib2 = join(root, 'import-2.bib');
  writeFileSync(importBib2, entry('morel2021', 'Les grèves de 1955', 'Morel, Jeanne', '2021'));
  // Pas en UTF-8 : zéro référence lue, et le bandeau ; l'import passe alors par « Remplacer ».
  const bad = join(root, 'Illisible');
  mkdirSync(bad);
  const badProjectJson = join(bad, 'project.json');
  writeFileSync(
    badProjectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000d2',
      name: 'Illisible',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bibliographySource: { type: 'file', filePath: 'refs.bib' },
    }),
  );
  writeFileSync(join(bad, 'document.md'), '# Illisible\n\nUn autre paragraphe.\n');
  writeFileSync(join(bad, 'refs.bib'), Buffer.from('@book{a,\n  title = {Histoire de l\u00e9t\u00e9},\n}\n', 'latin1'));
  const tropyDir = join(root, 'tropy');
  mkdirSync(tropyDir);
  const photo = join(tropyDir, 'rapport.jpg');
  writeFileSync(photo, 'jpeg factice');
  const tpy = makeTpy(tropyDir, {
    projectId: 'tropy-modales',
    name: 'Grèves nantaises',
    items: [{ id: 10, title: 'Rapport du commissaire central', photos: [{ id: 11, path: photo }] }],
  });
  return { projectJson, importBib, importBib2, badProjectJson, tpy };
}

/** Un faux Ollama sur un port local : rien ne part vers un vrai serveur. */
async function start(): Promise<{ app: ElectronApplication; window: Page } | null> {
  ollama = await startFakeOllama('Réponse du faux modèle.');
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return null;
  }
  return { app: outcome.value.app, window: outcome.value.window };
}

const choose = (app: ElectronApplication, filePath: string) =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, filePath);

async function openProject(app: ElectronApplication, window: Page, layout: Layout): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await choose(app, layout.projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Un paragraphe', { timeout: 20_000 });
  await window.locator('#left-tab-bibliography').click();
  await expect(window.locator('.citation-card')).toHaveCount(2, { timeout: 15_000 });
}

/** « Importer fichier BibTeX », le fichier choisi : une bibliographie déjà là passe par le choix. */
async function openImportChoice(app: ElectronApplication, window: Page, layout: Layout, file = layout.importBib): Promise<void> {
  await window.locator('#left-tab-bibliography').click();
  await choose(app, file);
  await window.locator('button[title="Importer fichier BibTeX"]').click();
  await expect(window.locator('.bib-import-mode-modal')).toBeVisible({ timeout: 10_000 });
}

async function closeTop(window: Page, selector: string): Promise<void> {
  await window.keyboard.press('Escape');
  await expect(window.locator(selector)).toHaveCount(0, { timeout: 10_000 });
}

/** Le panneau Sources primaires, chargé à la demande, apporte ses feuilles de style. */
async function openPrimarySources(window: Page): Promise<void> {
  await window.locator('#left-tab-primary-sources').click();
  await expect(window.locator('.primary-sources-panel')).toBeVisible({ timeout: 15_000 });
}

async function openMethodology(page: Page): Promise<void> {
  // Même événement que l'entrée du menu Aide.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('show-methodology-modal')));
  await expect(page.locator('.methodology-modal')).toBeVisible({ timeout: 10_000 });
}

interface Geometry {
  viewport: { w: number; h: number };
  overlay: { position: string; left: number; top: number; width: number; height: number };
  box: { left: number; top: number; right: number; bottom: number; padding: string };
  headerPadding: string;
  bodyPadding: string;
}

/** Ce qu'on voit de la fenêtre : son voile, sa boîte, et les marges intérieures de son en-tête et de son corps. */
function geometry(page: Page, box: string): Promise<Geometry> {
  return page.evaluate((selector) => {
    const content = document.querySelector(selector) as HTMLElement;
    const overlay = content.parentElement as HTMLElement;
    const o = overlay.getBoundingClientRect();
    const r = content.getBoundingClientRect();
    const padding = (el: Element | null) => (el ? getComputedStyle(el).padding : 'absent');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      overlay: {
        position: getComputedStyle(overlay).position,
        left: Math.round(o.left),
        top: Math.round(o.top),
        width: Math.round(o.width),
        height: Math.round(o.height),
      },
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, padding: padding(content) },
      headerPadding: padding(content.querySelector(':scope > .modal-header')),
      bodyPadding: padding(content.querySelector(':scope > .modal-body')),
    };
  }, box);
}

/**
 * Le style calculé de chaque élément sous `selector`, repéré par sa place et ses classes : ce
 * qu'on en voit, sans le texte (un compteur qui passe de 3 à 4 ne change rien ici).
 */
function styleOf(page: Page, selector: string): Promise<Record<string, Record<string, string>>> {
  return page.evaluate((sel) => {
    const props = [
      'display', 'flex-direction', 'align-items', 'gap', 'padding', 'margin', 'font-size', 'font-weight',
      'text-transform', 'letter-spacing', 'color', 'background-color', 'border', 'border-radius', 'min-width',
    ];
    const out: Record<string, Record<string, string>> = {};
    const walk = (el: Element, key: string): void => {
      const cs = getComputedStyle(el);
      out[key] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      Array.from(el.children).forEach((child, i) => {
        const cls = (child.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).join('.');
        walk(child, `${key} > ${child.tagName.toLowerCase()}${cls ? `.${cls}` : ''}:${i}`);
      });
    };
    const root = document.querySelector(sel);
    if (root) walk(root, sel);
    return out;
  }, selector);
}

/** Au centre, sur un voile qui couvre toute la fenêtre de l'app, lisible en entier. */
function expectCentredOnVeil(g: Geometry): void {
  expect(g.overlay).toEqual({ position: 'fixed', left: 0, top: 0, width: g.viewport.w, height: g.viewport.h });
  expect(g.box.left).toBeGreaterThanOrEqual(0);
  expect(g.box.top).toBeGreaterThanOrEqual(0);
  expect(g.box.right).toBeLessThanOrEqual(g.viewport.w);
  expect(g.box.bottom).toBeLessThanOrEqual(g.viewport.h);
  expect(Math.abs(g.box.left - (g.viewport.w - g.box.right))).toBeLessThanOrEqual(1);
  expect(Math.abs(g.box.top - (g.viewport.h - g.box.bottom))).toBeLessThanOrEqual(1);
}

/** L'allure de référence : celle qu'avaient ces fenêtres une fois les Sources primaires ouvertes. */
function expectReferenceSpacing(g: Geometry): void {
  expect(g.box.padding).toBe('0px');
  expect(g.headerPadding).toBe('16px');
}

test.describe('Fenêtres modales : la même allure dans tous les ordres', () => {
  test('sans ouvrir les Sources primaires : le choix d’import et le récapitulatif s’ouvrent au centre, sur un voile', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await openProject(app, window, layout);

      await openImportChoice(app, window, layout);
      const choice = await geometry(window, '.bib-import-mode-modal');
      expectCentredOnVeil(choice);
      expectReferenceSpacing(choice);
      expect(choice.bodyPadding).toBe('16px');

      await window.locator('.import-option-btn.merge-btn').click();
      await expect(window.locator('.bib-import-summary-modal')).toBeVisible({ timeout: 10_000 });
      const summary = await geometry(window, '.bib-import-summary-modal');
      expectCentredOnVeil(summary);
      expectReferenceSpacing(summary);
      await closeTop(window, '.bib-import-summary-modal');
    } finally {
      await app.close();
    }
  });

  test('après la Méthodologie : le choix d’import garde son allure, sans les marges de la Méthodologie', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await openProject(app, window, layout);
      await openMethodology(window);
      await closeTop(window, '.methodology-modal');

      // Les marges d'abord : c'est ce que la feuille de la Méthodologie déplaçait.
      await openImportChoice(app, window, layout);
      const choice = await geometry(window, '.bib-import-mode-modal');
      expectReferenceSpacing(choice);
      expect(choice.bodyPadding).toBe('16px');
      expectCentredOnVeil(choice);
      await closeTop(window, '.bib-import-mode-modal');

      // Puis les Sources primaires : leur feuille ne rattrape pas ce que la Méthodologie a posé.
      await window.locator('#left-tab-primary-sources').click();
      await expect(window.locator('.primary-sources-panel')).toBeVisible({ timeout: 15_000 });
      await openImportChoice(app, window, layout);
      const again = await geometry(window, '.bib-import-mode-modal');
      expectReferenceSpacing(again);
      expectCentredOnVeil(again);
      await closeTop(window, '.bib-import-mode-modal');
    } finally {
      await app.close();
    }
  });

  test('Méthodologie, puis Sources primaires, puis Méthodologie : la FAQ défile encore à la molette', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await openProject(app, window, layout);
      await openMethodology(window);
      await closeTop(window, '.methodology-modal');
      // Le panneau, chargé à la demande, apporte sa feuille de style.
      await window.locator('#left-tab-primary-sources').click();
      await expect(window.locator('.primary-sources-panel')).toBeVisible({ timeout: 15_000 });

      await openMethodology(window);
      await window.locator('.methodology-modal .modal-nav button', { hasText: 'FAQ' }).click();
      const content = window.locator('.methodology-modal .modal-content');
      await expect(content.locator('.faq-item').first()).toBeVisible();
      // La FAQ dépasse la fenêtre : il y a de quoi défiler.
      const { scrollHeight, clientHeight } = await content.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
      expect(scrollHeight).toBeGreaterThan(clientHeight);
      await content.hover();
      await window.mouse.wheel(0, 600);
      await expect.poll(() => content.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);
      await closeTop(window, '.methodology-modal');
    } finally {
      await app.close();
    }
  });

  test('le récapitulatif d’un « Fusionner » et la barre de statistiques ont la même allure avant et après les Sources primaires', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await openProject(app, window, layout);
      await expect(window.locator('.document-stats .stat-item').first()).toBeVisible({ timeout: 10_000 });
      const statsBefore = await styleOf(window, '.document-stats');

      await openImportChoice(app, window, layout);
      await window.locator('.import-option-btn.merge-btn').click();
      await expect(window.locator('.bib-import-summary-modal')).toBeVisible({ timeout: 10_000 });
      const before = await styleOf(window, '.bib-import-summary-modal');
      expect(Object.keys(before).some((k) => k.includes('.stat-label'))).toBe(true);
      await closeTop(window, '.bib-import-summary-modal');

      // Leur feuille posait `.stat-item .stat-label` (capitales de 10 px), `.stat-item .stat-value`
      // (20 px) et `.btn-primary` (orange de l'OCR) sans portée : tout ce qui portait ces classes
      // changeait d'allure, jusqu'aux chiffres de la barre de l'éditeur, grossis et rognés.
      await openPrimarySources(window);
      expect(await styleOf(window, '.document-stats')).toEqual(statsBefore);

      await openImportChoice(app, window, layout, layout.importBib2);
      await window.locator('.import-option-btn.merge-btn').click();
      await expect(window.locator('.bib-import-summary-modal')).toBeVisible({ timeout: 10_000 });
      expect(await styleOf(window, '.bib-import-summary-modal')).toEqual(before);
      await closeTop(window, '.bib-import-summary-modal');
    } finally {
      await app.close();
    }
  });

  test('variante « premier import » : « Remplacer » et « Annuler » ont la même allure avant et après les Sources primaires', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await window.locator('#left-tab-projects').click();
      await choose(app, layout.badProjectJson);
      await window.locator('button[title="Ouvrir un projet"]').first().click();
      await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Un autre paragraphe', { timeout: 20_000 });

      await openImportChoice(app, window, layout);
      await expect(window.locator('.bib-import-mode-modal .modal-actions .btn-primary')).toBeVisible();
      const before = await styleOf(window, '.bib-import-mode-modal');
      await closeTop(window, '.bib-import-mode-modal');

      await openPrimarySources(window);
      await openImportChoice(app, window, layout);
      await expect(window.locator('.bib-import-mode-modal .modal-actions .btn-primary')).toBeVisible();
      expect(await styleOf(window, '.bib-import-mode-modal')).toEqual(before);
      await closeTop(window, '.bib-import-mode-modal');
    } finally {
      await app.close();
    }
  });

  test('témoin : la fenêtre de l’OCR des Sources primaires, au centre sur son voile', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const started = await start();
    if (!started) return;
    const { app, window } = started;
    try {
      await openProject(app, window, layout);
      await window.locator('#left-tab-primary-sources').click();
      const panel = window.locator('.primary-sources-panel');
      await choose(app, layout.tpy);
      await panel.locator('button[title="Ouvrir un projet Tropy"]').click();
      await expect(panel.locator('.project-name')).toHaveText('Grèves nantaises', { timeout: 20_000 });

      await panel.locator('button[title="Paramètres OCR"]').click();
      await expect(window.locator('.ocr-settings-modal')).toBeVisible({ timeout: 10_000 });
      const ocr = await geometry(window, '.ocr-settings-modal');
      expectCentredOnVeil(ocr);
      expectReferenceSpacing(ocr);
      expect(ocr.bodyPadding).toBe('16px');
      await closeTop(window, '.ocr-settings-modal');
    } finally {
      await app.close();
    }
  });
});
