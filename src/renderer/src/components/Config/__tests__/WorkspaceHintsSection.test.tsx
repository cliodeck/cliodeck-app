// @vitest-environment jsdom
/**
 * La zone « Consignes de projet » face à l'éditeur qui tient le même fichier (S17-1-24).
 *
 * Chaque écriture effaçait l'autre : un paragraphe ajouté ici disparaissait à la frappe suivante
 * dans l'éditeur, qui réécrivait son ancien texte 3 s plus tard.
 *
 * Vraie section, vraie vue CM6, vrai autosave ; vrais handlers sur un vrai dossier (`real-main`).
 * Les délais sont attendus par leur résultat sur le disque, jamais par une durée.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installMain, main, passage } from '../../../services/__tests__/helpers/real-main';
import { CONTEXT_TEMPLATE } from '../../../../../../backend/core/hints/loader';
import { symlinkAvailable } from '../../../../../../backend/__tests__/helpers/native-guards';
import { CodeMirrorEditor } from '../../Editor/CodeMirrorEditor';
import { useAutoSave } from '../../../hooks/useAutoSave';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { WorkspaceHintsSection } from '../WorkspaceHintsSection';

// Vrai disque et vrai autosave : la CI est plus lente que ce poste.
vi.setConfig({ testTimeout: 30_000 });

// jsdom ne mesure rien, et CM6 journalise chaque échec de ses mesures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const ORIGINAL = '# Contexte\n\nDanzig, 1919-1939.\n';
const PARAGRAPH = 'Paragraphe ajouté dans les Réglages.';
const DEADLINE = { timeout: 15_000, interval: 10 };

let project: string;
let outside: string;
let contextMd: string;

const disk = () => fs.readFileSync(contextMd, 'utf8');
const zone = () => {
  const area = document.querySelector('textarea');
  if (!area) throw new Error('Pas de zone de texte');
  return area;
};
const saveButton = () => screen.getByTitle('hints.buttons.saveTitle') as HTMLButtonElement;

function setAutoSave(autoSave: boolean, autoSaveDelay = 3000): void {
  useEditorStore.setState((s) => ({ settings: { ...s.settings, autoSave, autoSaveDelay } }));
}

const AutoSaved: React.FC = () => {
  useAutoSave();
  return null;
};

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  if (!dom) throw new Error('Pas de vue CM6 montée');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('Vue CM6 introuvable');
  return view;
}

/** Une frappe réelle pour CM6 : annotée, en fin de document, et entrée dans l'historique. */
function typeAtEnd(text: string): void {
  const view = currentView();
  const end = view.state.doc.length;
  act(() => {
    view.dispatch({
      changes: { from: end, insert: text },
      selection: EditorSelection.cursor(end + text.length),
      annotations: Transaction.userEvent.of('input.type'),
    });
  });
}

async function openInEditor(filePath: string = contextMd): Promise<void> {
  await act(async () => {
    await useEditorStore.getState().loadFile(filePath);
  });
}

async function mountEditor(): Promise<void> {
  await act(async () => {
    render(
      <>
        <AutoSaved />
        <CodeMirrorEditor />
      </>
    );
  });
}

/** Ouvre les Réglages sur cette section, et attend qu'elle ait lu le fichier. */
async function openSettings(): Promise<void> {
  await act(async () => {
    render(<WorkspaceHintsSection />);
  });
  await act(async () => {
    fireEvent.click(screen.getByText('hints.title'));
  });
  await vi.waitFor(() => expect(loaded()).toBe(true), DEADLINE);
}

/** La section a répondu : texte chargé, ou motif affiché. */
function loaded(): boolean {
  return !zone().disabled || document.querySelector('[role="alert"]') !== null;
}

function editZone(value: string): void {
  fireEvent.change(zone(), { target: { value } });
}

async function pressSave(): Promise<void> {
  await act(async () => {
    fireEvent.click(saveButton());
  });
}

const awaitSaved = () => vi.waitFor(() => expect(screen.getByText('hints.status.saved')).toBeTruthy(), DEADLINE);
const awaitMessage = (key: string) => vi.waitFor(() => expect(document.body.textContent).toContain(key), DEADLINE);

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-consignes-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-consignes-dehors-'));
  contextMd = path.join(project, 'context.md');
  passage.reset();
  installMain();
  main.projectPath = project;
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Danzig', path: project, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  });
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
  // Coupé par défaut : seule l'écriture que le test observe passe sur le disque.
  setAutoSave(false);
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null } as never);
  setAutoSave(true);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('context.md ouvert dans l’éditeur', () => {
  it('un paragraphe ajouté ici survit à la frappe suivante et à l’autosave', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openInEditor();
    await mountEditor();
    setAutoSave(true, 50);
    await openSettings();

    editZone(`${ORIGINAL}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitSaved();
    expect(disk()).toContain(PARAGRAPH);

    // L'éditeur porte le nouveau texte…
    await vi.waitFor(() => expect(currentView().state.doc.toString()).toContain(PARAGRAPH), DEADLINE);
    // … et l'autosave n'y écrit plus l'ancien.
    typeAtEnd('x');
    await vi.waitFor(() => expect(disk().endsWith('x')).toBe(true), DEADLINE);
    expect(disk()).toContain(PARAGRAPH);
    expect(disk()).toContain('Danzig');
  });

  it('un tampon modifié à l’ouverture des Réglages : la zone part de ce qui y est tapé, et rien ne se perd', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openInEditor();
    await mountEditor();
    typeAtEnd('Tapé à l’instant.\n');

    await openSettings();

    expect(zone().value).toContain('Tapé à l’instant.');

    editZone(`${zone().value}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitSaved();

    expect(disk()).toContain('Tapé à l’instant.');
    expect(disk()).toContain(PARAGRAPH);
    await vi.waitFor(() => expect(currentView().state.doc.toString()).toContain(PARAGRAPH), DEADLINE);
  });

  it('un tampon modifié après l’ouverture des Réglages : conflit signalé, et ni la frappe ni la zone ne se perdent', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openInEditor();
    await mountEditor();
    await openSettings();

    typeAtEnd('Tapé après.\n');
    editZone(`${ORIGINAL}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitMessage('hints.errors.conflict');

    // La frappe est sur le disque et dans l'éditeur ; le paragraphe reste dans la zone.
    expect(disk()).toContain('Tapé après.');
    expect(disk()).not.toContain(PARAGRAPH);
    expect(currentView().state.doc.toString()).toContain('Tapé après.');
    expect(zone().value).toContain(PARAGRAPH);
    expect(zone().disabled).toBe(false);
  });
});

describe('le fichier touché par un autre', () => {
  it('modifié dehors depuis l’ouverture : conflit, fichier inchangé, texte de la zone gardé', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openSettings();

    fs.writeFileSync(contextMd, `${ORIGINAL}\nAjouté dans un autre logiciel.\n`);
    editZone(`${ORIGINAL}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitMessage('hints.errors.conflict');

    expect(disk()).toBe(`${ORIGINAL}\nAjouté dans un autre logiciel.\n`);
    expect(zone().value).toContain(PARAGRAPH);
  });

  it('rouvrir les Réglages après un conflit repart du fichier à jour, et l’écriture aboutit', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openSettings();
    fs.writeFileSync(contextMd, 'Ajouté dehors.\n');
    editZone(PARAGRAPH);
    await pressSave();
    await awaitMessage('hints.errors.conflict');

    cleanup();
    await openSettings();

    expect(zone().value).toBe('Ajouté dehors.\n');
    editZone(`Ajouté dehors.\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitSaved();
    expect(disk()).toBe(`Ajouté dehors.\n${PARAGRAPH}\n`);
  });

  it('un autre projet ouvert depuis : rien n’y est écrit, et le motif n’est pas un conflit', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-consignes-autre-'));
    try {
      fs.writeFileSync(path.join(other, 'context.md'), ORIGINAL);
      await openSettings();

      main.projectPath = other;
      editZone(PARAGRAPH);
      await pressSave();
      await awaitMessage('hints.errors.projectChanged');

      expect(fs.readFileSync(path.join(other, 'context.md'), 'utf8')).toBe(ORIGINAL);
      expect(disk()).toBe(ORIGINAL);
      expect(zone().value).toBe(PARAGRAPH);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('pas de faux conflit', () => {
  it('enregistrer deux fois de suite sans rouvrir', async () => {
    fs.writeFileSync(contextMd, ORIGINAL);
    await openSettings();

    editZone('Première version.');
    await pressSave();
    await awaitSaved();
    editZone('Seconde version.');
    await pressSave();
    await vi.waitFor(() => expect(disk()).toBe('Seconde version.'), DEADLINE);

    expect(document.body.textContent).not.toContain('hints.errors');
  });

  it.each<[string, string]>([
    ['un BOM', '﻿# Contexte\n\nTexte.\n'],
    ['des fins de ligne CRLF', '# Contexte\r\n\r\nTexte.\r\n'],
    ['des fins de ligne mêlées', '# Contexte\r\n\nTexte.\n'],
    ['des accents composés (NFC)', '# Été\n\nÉvénements.\n'.normalize('NFC')],
    ['des accents décomposés (NFD)', '# Été\n\nÉvénements.\n'.normalize('NFD')],
    ['pas de saut de ligne final', '# Contexte\n\nTexte.'],
    ['le gabarit tel que le crée un projet neuf', CONTEXT_TEMPLATE],
    ['un fichier vide', ''],
  ])('avec %s : la zone s’enregistre, modifiée', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await openSettings();

    editZone(`${zone().value}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitSaved();

    expect(disk()).toContain(PARAGRAPH);
    expect(document.body.textContent).not.toContain('hints.errors');
  });

  it.each<[string, string]>([
    ['un BOM', '﻿# Contexte\n\nTexte.\n'],
    ['des fins de ligne CRLF', '# Contexte\r\n\r\nTexte.\r\n'],
    ['des fins de ligne mêlées', '# Contexte\r\n\nTexte.\n'],
    ['des accents décomposés (NFD)', '# Été\n\nÉvénements.\n'.normalize('NFD')],
    ['pas de saut de ligne final', '# Contexte\n\nTexte.'],
  ])('avec %s : enregistrer sans rien changer rend les mêmes octets', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await openSettings();

    await pressSave();
    await awaitSaved();

    expect(disk()).toBe(bytes);
  });

  it('un fichier absent à l’ouverture se crée', async () => {
    await openSettings();

    expect(zone().value).toBe('');
    editZone(PARAGRAPH);
    await pressSave();
    await awaitSaved();

    expect(disk()).toBe(PARAGRAPH);
  });

  it.each<[string, string]>([
    ['un BOM', '﻿# Contexte\n\nTexte.\n'],
    ['des fins de ligne CRLF', '# Contexte\r\n\r\nTexte.\r\n'],
    ['des fins de ligne mêlées', '# Contexte\r\n\nTexte.\n'],
    ['des accents décomposés (NFD)', '# Été\n\nÉvénements.\n'.normalize('NFD')],
    ['pas de saut de ligne final', '# Contexte\n\nTexte.'],
    ['le gabarit tel que le crée un projet neuf', CONTEXT_TEMPLATE],
  ])('avec %s : l’éditeur qui réécrit le fichier sans le modifier ne crée pas de conflit', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await openSettings();
    // La vraie vue CM6 relit le fichier et l'écrit telle quelle, une fois la zone ouverte.
    await openInEditor();
    await mountEditor();
    await act(async () => {
      await useEditorStore.getState().saveFile();
    });
    expect(disk()).toBe(bytes);

    editZone(`${zone().value}\n${PARAGRAPH}\n`);
    await pressSave();
    await awaitSaved();

    expect(disk()).toContain(PARAGRAPH);
  });
});

describe('ce qu’on ne sait pas écrire se dit, et le bouton le respecte', () => {
  it('pas en UTF-8 : motif affiché, zone et bouton désactivés, fichier intact', async () => {
    const latin1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
    fs.writeFileSync(contextMd, latin1);

    await openSettings();

    await awaitMessage('hints.reasons.notUtf8');
    expect(zone().value).toBe('');
    expect(zone().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(fs.readFileSync(contextMd)).toEqual(latin1);
  });

  it('un dossier à sa place : motif affiché, bouton désactivé', async () => {
    fs.mkdirSync(contextMd);

    await openSettings();

    await awaitMessage('hints.reasons.unreadable');
    expect(saveButton().disabled).toBe(true);
  });

  it.skipIf(!symlinkAvailable)('lien qui sort du projet : dit tel quel, et rien d’écrit dehors', async () => {
    const journal = path.join(outside, 'journal.md');
    fs.writeFileSync(journal, 'Texte privé.');
    fs.symlinkSync(journal, contextMd);

    await openSettings();

    await awaitMessage('hints.reasons.outsideProject');
    expect(document.body.textContent).not.toContain('conflict');
    expect(zone().value).toBe('');
    expect(saveButton().disabled).toBe(true);
    expect(fs.readFileSync(journal, 'utf8')).toBe('Texte privé.');
  });
});
