// @vitest-environment jsdom
/**
 * `saveContextFile` et l'éditeur qui tient le même fichier (S17-1-24).
 *
 * Vraie vue CM6, vrais stores, vrais handlers sur un vrai dossier (`real-main`). L'autosave est
 * coupé : les écritures observées sont celles que le test déclenche, et une frappe « pendant
 * l'écriture » arrive à l'instant précis où elle compte, sans dépendre d'un délai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import type { TFunction } from 'i18next';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installMain, main, passage } from './helpers/real-main';
import { rememberConsentedPath } from '../../../../main/ipc/utils/user-consented-paths';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import {
  appendToContext,
  contextFailureText,
  readContextFile,
  saveContextFile,
  type ContextHints,
} from '../context-file';

vi.setConfig({ testTimeout: 30_000 });

// jsdom ne mesure rien, et CM6 journalise chaque échec de ses mesures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const ORIGINAL = '# Contexte\n\nDanzig, 1919-1939.\n';
const WITH_PARAGRAPH = `${ORIGINAL}\nParagraphe des Réglages.\n`;
const DEADLINE = { timeout: 15_000, interval: 10 };

let base: string;
let project: string;
let contextMd: string;
let documentMd: string;

const editor = () => useEditorStore.getState();
const disk = () => fs.readFileSync(contextMd, 'utf8');

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>('.cm-editor');
  if (!dom) throw new Error('Pas de vue CM6 montée');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('Vue CM6 introuvable');
  return view;
}

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

async function open(filePath: string = contextMd): Promise<void> {
  await act(async () => {
    await editor().loadFile(filePath);
  });
}

async function mountEditor(): Promise<void> {
  await act(async () => {
    render(<CodeMirrorEditor />);
  });
}

async function read(): Promise<ContextHints> {
  const res = await readContextFile();
  if (!res.success) throw new Error(res.error);
  return res.hints;
}

/** Depuis les Réglages : le texte lu à l'ouverture, puis l'écriture. */
async function saveOver(hints: ContextHints, markdown: string = WITH_PARAGRAPH) {
  let result: Awaited<ReturnType<typeof saveContextFile>> | undefined;
  await act(async () => {
    result = await saveContextFile(markdown, {
      expectedRaw: hints.raw,
      sourcePath: hints.sourcePath,
      projectPath: main.projectPath ?? '',
    });
  });
  if (!result) throw new Error('saveContextFile n’a rien rendu');
  return result;
}

const awaitEditorText = (text: string) =>
  vi.waitFor(() => expect(currentView().state.doc.toString()).toBe(text), DEADLINE);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-contexte-'));
  project = path.join(base, 'projet');
  fs.mkdirSync(project);
  contextMd = path.join(project, 'context.md');
  documentMd = path.join(project, 'document.md');
  fs.writeFileSync(contextMd, ORIGINAL);
  fs.writeFileSync(documentMd, '# Manuscrit\n');
  main.projectPath = project;
  passage.reset();
  installMain();
  useProjectStore.setState({
    currentProject: { id: 'p1', name: 'Danzig', path: project, type: 'article', createdAt: new Date(), lastOpenedAt: new Date() },
  });
  useEditorStore.setState((s) => ({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    settings: { ...s.settings, autoSave: false },
  }));
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  useEditorStore.setState((s) => ({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
    settings: { ...s.settings, autoSave: true },
  }));
  fs.rmSync(base, { recursive: true, force: true });
});

describe('l’éditeur suit ce qui vient de s’écrire', () => {
  it('context.md ouvert : le tampon porte le nouveau texte, et rien ne reste à écrire', async () => {
    await open();
    await mountEditor();
    const hints = await read();

    const saved = await saveOver(hints);

    expect(saved.success).toBe(true);
    expect(disk()).toBe(WITH_PARAGRAPH);
    await awaitEditorText(WITH_PARAGRAPH);
    expect(editor().content).toBe(WITH_PARAGRAPH);
    expect(editor().isDirty).toBe(false);
    // Le fichier vient de s'écrire : la barre d'état ne dit pas « Non enregistré ».
    expect(editor().lastSavedAt).not.toBeNull();
  });

  it('la frappe suivante garde le paragraphe', async () => {
    await open();
    await mountEditor();

    await saveOver(await read());
    await awaitEditorText(WITH_PARAGRAPH);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });

    expect(disk()).toBe(`${WITH_PARAGRAPH}x`);
  });

  it('un BOM reste sur le disque, sans entrer dans l’éditeur', async () => {
    fs.writeFileSync(contextMd, `﻿${ORIGINAL}`);
    await open();
    await mountEditor();
    const hints = await read();
    expect(hints.raw.startsWith('﻿')).toBe(true);

    const saved = await saveOver(hints, `﻿${WITH_PARAGRAPH}`);

    expect(saved.success).toBe(true);
    expect(disk()).toBe(`﻿${WITH_PARAGRAPH}`);
    await awaitEditorText(WITH_PARAGRAPH);
  });

  it('l’annulation est vidée : Cmd+Z ne ramène pas l’ancien texte, et rien ne se réécrit', async () => {
    await open();
    await mountEditor();
    typeAtEnd('Frappe d’avant.\n');
    await act(async () => {
      await editor().saveFile();
    });
    expect(undoDepth(currentView().state)).toBeGreaterThan(0);
    const hints = await read();

    await saveOver(hints);
    await awaitEditorText(WITH_PARAGRAPH);

    expect(undoDepth(currentView().state)).toBe(0);
    act(() => {
      expect(undo(currentView())).toBe(false);
    });
    expect(currentView().state.doc.toString()).toBe(WITH_PARAGRAPH);
    expect(editor().isDirty).toBe(false);
    expect(disk()).toBe(WITH_PARAGRAPH);
  });

  it('un autre document ouvert reste ouvert, et le retour sur context.md repart du disque', async () => {
    await open();
    await mountEditor();
    typeAtEnd('Frappe d’avant.\n');
    await open(documentMd);
    const version = editor().documentVersion;
    const hints = await read();

    await saveOver(hints);

    expect(editor().filePath).toBe(documentMd);
    expect(editor().documentVersion).toBe(version);

    // Son état mémorisé, annulation comprise, ne revient pas sur un texte périmé.
    await open(contextMd);
    await awaitEditorText(WITH_PARAGRAPH);
    expect(undoDepth(currentView().state)).toBe(0);
  });

  it('passer à un autre document pendant l’écriture : il n’est pas rouvert dessus', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    passage.afterHintsWrite = () => open(documentMd);

    const saved = await saveOver(hints);

    expect(saved.success).toBe(true);
    expect(editor().filePath).toBe(documentMd);
    expect(disk()).toBe(WITH_PARAGRAPH);
  });

  it('un changement de projet commencé pendant l’écriture garde la main', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    passage.afterHintsWrite = async () => {
      await act(async () => {
        await editor().replaceBuffer({ kind: 'detach' }, 'project-switch');
      });
    };

    const saved = await saveOver(hints);

    expect(saved.success).toBe(true);
    expect(editor().bufferDetached).toBe(true);
    expect(editor().filePath).toBeNull();
    expect(disk()).toBe(WITH_PARAGRAPH);
  });
});

describe('savoir si context.md est le document ouvert', () => {
  it('à la casse près : ouvert par un chemin d’une autre casse, le tampon suit', async () => {
    const shouted = path.join(base, 'PROJET', 'CONTEXT.MD');
    if (!fs.existsSync(shouted)) return; // Ce disque distingue la casse : deux fichiers, rien à prouver.
    await rememberConsentedPath(shouted);
    await open(shouted);
    await mountEditor();
    expect(editor().filePath).toBe(shouted);

    await saveOver(await read());

    await awaitEditorText(WITH_PARAGRAPH);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });
    expect(disk()).toBe(`${WITH_PARAGRAPH}x`);
  });

  it.skipIf(!symlinkAvailable)('racine passant par un lien : le tampon suit', async () => {
    const alias = path.join(base, 'alias');
    fs.symlinkSync(project, alias);
    main.projectPath = alias;
    // Ouvert sous le chemin réel, alors que le main désigne le projet par son lien.
    await rememberConsentedPath(contextMd);
    await open(contextMd);
    await mountEditor();
    const hints = await read();
    expect(hints.sourcePath).toBe(path.join(alias, 'context.md'));

    const saved = await saveOver(hints);

    expect(saved.success).toBe(true);
    await awaitEditorText(WITH_PARAGRAPH);
    expect(disk()).toBe(WITH_PARAGRAPH);
  });
});

describe('une frappe pendant la séquence ne se perd pas', () => {
  it('entre l’écriture et le rechargement : la frappe reste, sur le disque aussi, et le conflit se dit', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    passage.afterHintsWrite = async () => typeAtEnd('K');

    const saved = await saveOver(hints);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(currentView().state.doc.toString()).toBe(`${ORIGINAL}K`);
    expect(disk()).toBe(`${ORIGINAL}K`);
    expect(editor().isDirty).toBe(false);
  });

  it('entre l’écriture de l’éditeur et celle du fichier : pareil', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    passage.beforeHintsWrite = async () => typeAtEnd('K');

    const saved = await saveOver(hints);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(currentView().state.doc.toString()).toBe(`${ORIGINAL}K`);
    expect(disk()).toBe(`${ORIGINAL}K`);
  });

  it('tapée avant l’écriture : conflit, rien d’écrit par-dessus, et la frappe sur le disque', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    typeAtEnd('K');

    const saved = await saveOver(hints);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(disk()).toBe(`${ORIGINAL}K`);
    expect(currentView().state.doc.toString()).toBe(`${ORIGINAL}K`);
  });

  it('tampon verrouillé par une renumérotation : il garde son texte, et le fichier le suit', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    useEditorStore.setState({ switchLock: 'book.renumberInProgress' });

    const saved = await saveOver(hints);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(disk()).toBe(ORIGINAL);
    expect(currentView().state.doc.toString()).toBe(ORIGINAL);
  });

  it('le tampon ne s’écrit pas : rien n’est écrit par-dessus, et il garde sa frappe', async () => {
    await open();
    await mountEditor();
    typeAtEnd('K');
    const hints = await ipcRead();
    passage.editorSave = async () => ({ success: false, error: 'ENOSPC: no space left on device' });

    const saved = await saveOver(hints);

    expect(saved.success).toBe(false);
    expect(disk()).toBe(ORIGINAL);
    expect(currentView().state.doc.toString()).toBe(`${ORIGINAL}K`);
    expect(editor().isDirty).toBe(true);
  });
});

/** La lecture nue, sans écrire d'abord le tampon. */
async function ipcRead(): Promise<ContextHints> {
  const res = (await window.electron.fusion.hints.read()) as { success: boolean; hints: ContextHints };
  return res.hints;
}

describe('readContextFile', () => {
  it('écrit d’abord le tampon de context.md : ce qui est tapé fait partie du texte lu', async () => {
    await open();
    await mountEditor();
    typeAtEnd('Tapé.\n');

    const hints = await read();

    expect(hints.raw).toBe(`${ORIGINAL}Tapé.\n`);
    expect(disk()).toBe(`${ORIGINAL}Tapé.\n`);
  });

  it('ne touche pas au tampon d’un autre document', async () => {
    await open(documentMd);
    await mountEditor();
    typeAtEnd('Tapé.\n');

    const hints = await read();

    expect(hints.raw).toBe(ORIGINAL);
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Manuscrit\n');
    expect(editor().isDirty).toBe(true);
  });

  it('le tampon ne s’écrit pas : l’échec remonte, sans lever', async () => {
    await open();
    await mountEditor();
    typeAtEnd('K');
    passage.editorSave = async () => ({ success: false, error: 'ENOSPC: no space left on device' });

    const res = await readContextFile();

    expect(res).toMatchObject({ success: false, error: 'ENOSPC: no space left on device' });
  });
});

describe('appendToContext', () => {
  const SECTION = '# Danzig\n\n## Research Topic\n\nPorts baltes\n';

  it('à la suite du texte, séparé par une ligne vide', () => {
    expect(appendToContext('Consignes.\n\n\n', SECTION)).toBe(`Consignes.\n\n${SECTION}`);
    expect(appendToContext('Sans saut final.', SECTION)).toBe(`Sans saut final.\n\n${SECTION}`);
  });

  it('dans les fins de ligne d’un fichier CRLF, et sans toucher au BOM', () => {
    const out = appendToContext('﻿Consignes.\r\n', SECTION);

    expect(out).toBe(`﻿Consignes.\r\n\r\n${SECTION.replace(/\n/g, '\r\n')}`);
  });

  it('un fichier aux fins de ligne mêlées reçoit des LF, comme l’éditeur le lit', () => {
    expect(appendToContext('Un\r\nDeux\nTrois\n', SECTION)).toBe(`Un\r\nDeux\nTrois\n\n${SECTION}`);
  });

  it('la section déjà là : le texte tel quel', () => {
    const once = appendToContext('Consignes.\n', SECTION);
    expect(appendToContext(once, SECTION)).toBe(once);
    const crlf = appendToContext('Consignes.\r\n', SECTION);
    expect(appendToContext(crlf, SECTION)).toBe(crlf);
    // Sans son saut de ligne final non plus : l'auteur a pu le retirer.
    expect(appendToContext(once.trimEnd(), SECTION)).toBe(once.trimEnd());
  });
});

describe('contextFailureText', () => {
  const t = ((key: string) => key) as unknown as TFunction;

  it.each<[string, string | undefined, string]>([
    ['context_conflict', undefined, 'hints.reasons.conflict'],
    ['context_outside_project', undefined, 'hints.reasons.outsideProject'],
    ['context_project_changed', undefined, 'hints.reasons.projectChanged'],
    ['context_unreadable', 'encoding', 'hints.reasons.notUtf8'],
    ['context_unreadable', 'permission', 'hints.reasons.unreadable'],
    ['context_unreadable', 'not-a-file', 'hints.reasons.unreadable'],
    ['no_project', undefined, 'hints.errors.noProject'],
    ['EACCES: permission denied', undefined, 'hints.reasons.writeFailed'],
  ])('%s (%s) : %s', (error, reason, key) => {
    expect(contextFailureText(t, { error, reason })).toBe(key);
  });
});
