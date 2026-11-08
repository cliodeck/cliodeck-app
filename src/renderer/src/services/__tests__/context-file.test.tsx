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

import { installMain, ipc, main, passage } from './helpers/real-main';
import { rememberConsentedPath } from '../../../../main/ipc/utils/user-consented-paths';
import { CONTEXT_TEMPLATE } from '../../../../../backend/core/hints/loader';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards';
import { CodeMirrorEditor } from '../../components/Editor/CodeMirrorEditor';
import { resetEditorStates } from '../../components/Editor/editor-state-memory';
import { useEditorStore, type BufferOutcome } from '../../stores/editorStore';
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

/** macOS et Windows : un seul fichier sous deux casses. Sous Linux, deux fichiers possibles. */
const caseInsensitive = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-casse-'));
  fs.writeFileSync(path.join(dir, 'sonde'), '');
  const insensitive = fs.existsSync(path.join(dir, 'SONDE'));
  fs.rmSync(path.join(dir, 'sonde'));
  fs.rmdirSync(dir);
  return insensitive;
})();

/**
 * Le cas de la casse n'existe que sous macOS : un fichier absent n'y a pas de chemin réel, et
 * `sameFile` ne pardonne pas sa casse. Windows la pardonne toujours (`file-identity.ts`) et
 * reconnaît le fichier dès la lecture ; Linux distingue deux fichiers.
 */
const macCaseScenario = process.platform === 'darwin' && caseInsensitive;

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
  resetEditorStates();
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
  // Le cache d'état survit au démontage de l'éditeur : il ne doit pas pour autant rendre l'ancien
  // texte après une écriture par les Réglages, que l'éditeur annonce repartir d'un état neuf.
  it('context.md ouvert, écrit par les Réglages : Cmd+Z ne ramène pas l’ancien texte, éditeur monté', async () => {
    await open();
    await mountEditor();
    typeAtEnd('Une frappe.\n');
    const hints = await read();

    expect((await saveOver(hints)).success).toBe(true);
    await awaitEditorText(WITH_PARAGRAPH);

    expect(undoDepth(currentView().state)).toBe(0);
    act(() => {
      expect(undo(currentView())).toBe(false);
    });
    expect(currentView().state.doc.toString()).toBe(WITH_PARAGRAPH);
  });

  it('context.md ouvert puis l’éditeur démonté par un changement de mode : Cmd+Z non plus', async () => {
    await open();
    await mountEditor();
    typeAtEnd('Une frappe.\n');
    const hints = await read();
    cleanup();
    expect(editor().editorFacade).toBeNull();

    expect((await saveOver(hints)).success).toBe(true);
    await vi.waitFor(() => expect(editor().content).toBe(WITH_PARAGRAPH), DEADLINE);

    await mountEditor();
    expect(currentView().state.doc.toString()).toBe(WITH_PARAGRAPH);
    expect(undoDepth(currentView().state)).toBe(0);
    act(() => {
      expect(undo(currentView())).toBe(false);
    });
    expect(currentView().state.doc.toString()).toBe(WITH_PARAGRAPH);
    expect(disk()).toBe(WITH_PARAGRAPH);
  });

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

/**
 * Le faux conflit empêcherait d'enregistrer un fichier que personne n'a touché. Le tampon ne porte
 * pas le BOM, et le disque ne change pas : le rechargement rend « inchangé », et rien d'autre ne
 * peut dire que ce tampon et ce qui vient de s'écrire sont un seul texte.
 */
describe('document ouvert, écrire le texte lu sans rien y changer', () => {
  it.each<[string, string]>([
    ['un BOM', `\uFEFF${ORIGINAL}`],
    ['un BOM et des fins de ligne CRLF', `\uFEFF${ORIGINAL.replace(/\n/g, '\r\n')}`],
    ['des fins de ligne CRLF', ORIGINAL.replace(/\n/g, '\r\n')],
    ['pas de saut de ligne final', ORIGINAL.trimEnd()],
  ])('avec %s : pas de conflit, et les mêmes octets', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await open();
    await mountEditor();
    const hints = await read();
    expect(hints.raw).toBe(bytes);

    const saved = await saveOver(hints, hints.raw);

    expect(saved.success).toBe(true);
    expect(fs.readFileSync(contextMd)).toEqual(Buffer.from(bytes, 'utf8'));
    expect(editor().isDirty).toBe(false);
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

/**
 * Les `times` prochaines lectures de l'éditeur sont périmées à leur arrivée : un verrou se pose
 * et se lève pendant qu'elles lisent, comme une renumérotation éclair. `loadFile` rend alors
 * `superseded`, sans avoir rien remplacé.
 */
function supersedeNextLoads(times: number): void {
  let left = times;
  passage.editorLoad = async (filePath) => {
    const response = await ipc('editor:load-file', filePath);
    if (left > 0) {
      left -= 1;
      act(() => {
        editor().setSwitchLock('book.renumberInProgress');
        editor().setSwitchLock(null);
      });
    }
    return response;
  };
}

/**
 * Le rechargement qui suit l'écriture n'a pas abouti, et l'éditeur montre toujours ce fichier
 * (BT1-2, C38). Il passait pour suivi : l'ancien texte restait à l'écran, propre, et la frappe
 * suivante l'écrivait par-dessus le paragraphe des Réglages, sans un mot.
 */
describe('le rechargement n’aboutit pas, et l’éditeur montre toujours context.md', () => {
  it('remplacé une fois pendant sa lecture : relu, et la frappe suivante garde le paragraphe', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    supersedeNextLoads(1);

    const saved = await saveOver(hints);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });

    expect(saved.success).toBe(true);
    expect(disk()).toBe(`${WITH_PARAGRAPH}x`);
    expect(currentView().state.doc.toString()).toBe(`${WITH_PARAGRAPH}x`);
  });

  it('remplacé encore à la relecture : le conflit se dit, et rien ne reste à écrire par-dessus en silence', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    supersedeNextLoads(2);

    const saved = await saveOver(hints);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    // Le disque porte ce que l'éditeur montre : la frappe suivante n'efface rien que la section
    // ait annoncé comme enregistré, et le texte des Réglages est resté dans leur zone.
    expect(disk()).toBe(currentView().state.doc.toString());
    expect(editor().isDirty).toBe(false);
  });

  // macOS : un fichier absent n'a pas de chemin réel, et `sameFile` ne pardonne pas sa casse. La
  // lecture ne voit donc pas que l'éditeur le tient : la zone part de rien, et l'éditeur garde seul
  // tout l'ancien texte. Le reconnaître une fois écrit puis le recharger effaçait ce texte partout.
  // Les deux tests qui suivent le rejouent tel quel ; ceux d'après, sur tout système.
  it.runIf(macCaseScenario)('ouvert sous une autre casse puis supprimé dehors : le texte que tenait l’éditeur reste, et le conflit se dit', async () => {
    const shouted = path.join(base, 'PROJET', 'CONTEXT.MD');
    await rememberConsentedPath(shouted);
    await open(shouted);
    await mountEditor();
    fs.rmSync(contextMd);
    const hints = await read();
    expect(hints.raw).toBe('');

    const saved = await saveOver(hints, `${hints.raw}Paragraphe des Réglages.\n`);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(disk()).toBe(ORIGINAL);
    expect(currentView().state.doc.toString()).toBe(ORIGINAL);
    expect(editor().isDirty).toBe(false);
  });

  it.runIf(macCaseScenario)('ouvert sous une autre casse, vide, puis supprimé dehors : rien à garder, le tampon suit', async () => {
    fs.writeFileSync(contextMd, '');
    const shouted = path.join(base, 'PROJET', 'CONTEXT.MD');
    await rememberConsentedPath(shouted);
    await open(shouted);
    await mountEditor();
    fs.rmSync(contextMd);
    const hints = await read();

    const saved = await saveOver(hints, `${hints.raw}Paragraphe des Réglages.\n`);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });

    expect(saved.success).toBe(true);
    expect(disk()).toBe('Paragraphe des Réglages.\nx');
  });

  /**
   * Le mécanisme du cas de la casse, sur tout système et donc en CI : `sameFile` ne reconnaît le
   * fichier ouvert qu'une fois qu'il existe de nouveau.
   */
  function recognizedOnlyOnceWritten(): void {
    let written = false;
    passage.afterHintsWrite = async () => {
      written = true;
    };
    passage.sameFile = (a, b) => (written ? ipc('fs:same-file', a, b) : Promise.resolve(false));
  }

  it('reconnu ouvert seulement une fois écrit : le texte que tenait l’éditeur reste, et le conflit se dit', async () => {
    await open();
    await mountEditor();
    fs.rmSync(contextMd);
    recognizedOnlyOnceWritten();
    const hints = await read();
    expect(hints.raw).toBe('');

    const saved = await saveOver(hints, `${hints.raw}Paragraphe des Réglages.\n`);

    expect(saved).toMatchObject({ success: false, error: 'context_conflict' });
    expect(disk()).toBe(ORIGINAL);
    expect(currentView().state.doc.toString()).toBe(ORIGINAL);
    expect(editor().isDirty).toBe(false);
  });

  it('reconnu ouvert seulement une fois écrit, éditeur vide : rien à garder, le tampon suit', async () => {
    fs.writeFileSync(contextMd, '');
    await open();
    await mountEditor();
    fs.rmSync(contextMd);
    recognizedOnlyOnceWritten();
    const hints = await read();

    const saved = await saveOver(hints, `${hints.raw}Paragraphe des Réglages.\n`);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });

    expect(saved.success).toBe(true);
    expect(disk()).toBe('Paragraphe des Réglages.\nx');
  });

  /**
   * L'auteur ouvre `target` pendant la relecture de context.md, et cette ouverture lit plus
   * lentement : elle est encore en route quand la relecture revient chassée par elle. Rend la
   * demande de l'auteur, avec l'erreur d'une ouverture qui échoue comme issue.
   */
  function openDuringReload(target: string): () => Promise<BufferOutcome | unknown> {
    let userOpen: Promise<BufferOutcome | unknown> | undefined;
    let reloadRead: Promise<unknown> | undefined;
    passage.editorLoad = async (filePath) => {
      if (filePath === contextMd && !userOpen) {
        userOpen = editor()
          .loadFile(target)
          .catch((error: unknown) => error);
        reloadRead = ipc('editor:load-file', filePath);
        return reloadRead;
      }
      if (filePath === target) {
        // Après tout ce que la relecture enchaîne à son retour, sans attendre de délai.
        await reloadRead;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return ipc('editor:load-file', filePath);
    };
    return async () => {
      if (!userOpen) throw new Error('aucune ouverture lancée pendant la relecture');
      return userOpen;
    };
  }

  // La relecture relancée aussitôt chassait à son tour l'ouverture de l'auteur : l'éditeur restait
  // sur context.md, et l'autre document ne s'ouvrait pas, sans un mot.
  it('une ouverture lancée pendant la relecture aboutit, et le paragraphe reste sur le disque', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    const userOpen = openDuringReload(documentMd);

    const saved = await saveOver(hints);

    expect(await userOpen()).toEqual({ status: 'replaced' });
    expect(editor().filePath).toBe(documentMd);
    expect(saved.success).toBe(true);
    expect(disk()).toBe(WITH_PARAGRAPH);
    await open(contextMd);
    await awaitEditorText(WITH_PARAGRAPH);
  });

  it('une ouverture qui échoue pendant la relecture : context.md est relu après elle', async () => {
    await open();
    await mountEditor();
    const hints = await read();
    const userOpen = openDuringReload(path.join(project, 'absent.md'));

    const saved = await saveOver(hints);
    typeAtEnd('x');
    await act(async () => {
      await editor().saveFile();
    });

    expect(await userOpen()).toBeInstanceOf(Error);
    expect(saved.success).toBe(true);
    expect(editor().filePath).toBe(contextMd);
    expect(disk()).toBe(`${WITH_PARAGRAPH}x`);
  });

  it('context.md ouvert dans l’éditeur pendant l’écriture : le tampon suit, sans faux conflit', async () => {
    await open(documentMd);
    await mountEditor();
    const hints = await read();
    passage.beforeHintsWrite = () => open(contextMd);

    const saved = await saveOver(hints);

    expect(saved.success).toBe(true);
    expect(disk()).toBe(WITH_PARAGRAPH);
    await awaitEditorText(WITH_PARAGRAPH);
  });
});

/**
 * Le rechargement recrée la vue en haut du fichier : le paragraphe ajouté à la fin d'un long
 * `context.md` restait hors de l'écran, et l'éditeur semblait ne pas l'avoir (BT1-2, C38).
 */
describe('après le rechargement, la première ligne changée est amenée à l’écran', () => {
  const LONG = `# Contexte\n\n${Array.from({ length: 80 }, (_, i) => `Ligne ${i + 1} des consignes.`).join('\n')}\n`;
  const ADDED = 'Paragraphe des Réglages.';

  it('le curseur est sur la ligne ajoutée, et le focus reste où il était', async () => {
    fs.writeFileSync(contextMd, LONG);
    await open();
    await mountEditor();
    const hints = await read();
    // La zone des Réglages, par-dessus l'éditeur : elle garde le focus.
    const zone = document.body.appendChild(document.createElement('textarea'));
    zone.focus();

    const saved = await saveOver(hints, `${LONG}\n${ADDED}\n`);

    expect(saved.success).toBe(true);
    await vi.waitFor(() => {
      const { state } = currentView();
      expect(state.doc.lineAt(state.selection.main.head).text).toBe(ADDED);
    }, DEADLINE);
    expect(document.activeElement).toBe(zone);
    zone.remove();
  });

  // Paramètres ouverts depuis Brainstormer : l'éditeur n'est pas monté. L'attente de la façade
  // s'arrêtait au bout de 2 s, et le retour en Écriture ouvrait la vue en haut du fichier.
  it('éditeur démonté par un changement de mode, remonté plus de 2 s après : la ligne ajoutée y est amenée', async () => {
    fs.writeFileSync(contextMd, LONG);
    await open();
    await mountEditor();
    const hints = await read();
    cleanup();
    expect(editor().editorFacade).toBeNull();

    const saved = await saveOver(hints, `${LONG}\n${ADDED}\n`);
    expect(saved.success).toBe(true);
    // L'auteur reste dans l'autre mode au-delà de ces 2 s : c'est le scénario, pas une attente.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await mountEditor();

    await vi.waitFor(() => {
      const { state } = currentView();
      expect(state.doc.lineAt(state.selection.main.head).text).toBe(ADDED);
    }, DEADLINE);
  });

  it('un autre document a pris la place avant le retour de l’éditeur : rien ne s’y déplace', async () => {
    fs.writeFileSync(contextMd, LONG);
    await open();
    await mountEditor();
    const hints = await read();
    cleanup();

    expect((await saveOver(hints, `${LONG}\n${ADDED}\n`)).success).toBe(true);
    await open(documentMd);
    await mountEditor();

    expect(currentView().state.doc.toString()).toBe('# Manuscrit\n');
    expect(currentView().state.selection.main.head).toBe(0);
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

/**
 * Le disque se dit vide, l'éditeur tient encore tout le texte. Pris tel quel, rien ne protégeait
 * ce texte : l'assistant écrivait sans demander, et le rechargement remplaçait le tampon.
 */
describe('readContextFile, quand le disque n’a plus le texte que tient l’éditeur', () => {
  it.each<[string, () => void]>([
    ['supprimé dehors', () => fs.rmSync(contextMd)],
    ['vidé dehors', () => fs.writeFileSync(contextMd, '')],
    ['remis au gabarit dehors', () => fs.writeFileSync(contextMd, CONTEXT_TEMPLATE)],
  ])('%s, tampon propre : le texte repart sur le disque, et il y a de quoi demander', async (_label, change) => {
    await open();
    await mountEditor();
    change();

    const hints = await read();

    expect(hints.raw).toBe(ORIGINAL);
    expect(hints.sources.context.blank).toBe(false);
    expect(disk()).toBe(ORIGINAL);
    expect(currentView().state.doc.toString()).toBe(ORIGINAL);
    expect(editor().isDirty).toBe(false);
  });

  it('supprimé dehors, et le tampon ne s’écrit pas : l’échec remonte, et le texte reste dans l’éditeur', async () => {
    await open();
    await mountEditor();
    fs.rmSync(contextMd);
    passage.editorSave = async () => ({ success: false, error: 'ENOSPC: no space left on device' });

    const res = await readContextFile();

    expect(res).toMatchObject({ success: false, error: 'ENOSPC: no space left on device' });
    expect(fs.existsSync(contextMd)).toBe(false);
    expect(currentView().state.doc.toString()).toBe(ORIGINAL);
  });

  it.each<[string, string]>([
    ['vide', ''],
    ['le gabarit', CONTEXT_TEMPLATE],
  ])('%s sur le disque comme dans l’éditeur : rien ne s’écrit', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await open();
    await mountEditor();
    const before = fs.statSync(contextMd).mtimeMs;

    const hints = await read();

    expect(hints.sources.context.blank).toBe(true);
    expect(fs.statSync(contextMd).mtimeMs).toBe(before);
  });

  it('changé dehors, tampon propre : le disque fait foi, et il n’est pas réécrit', async () => {
    await open();
    await mountEditor();
    fs.writeFileSync(contextMd, 'Écrit dans un autre logiciel.\n');

    const hints = await read();

    expect(hints.raw).toBe('Écrit dans un autre logiciel.\n');
    expect(disk()).toBe('Écrit dans un autre logiciel.\n');
  });

  it('supprimé dehors, éditeur vide : le fichier ne renaît pas', async () => {
    fs.writeFileSync(contextMd, '');
    await open();
    await mountEditor();
    fs.rmSync(contextMd);

    const hints = await read();

    expect(hints.sources.context.blank).toBe(true);
    expect(fs.existsSync(contextMd)).toBe(false);
  });

  it('éditeur vide, gabarit remis dehors : un tampon vide n’a rien à sauver, et n’efface rien', async () => {
    fs.writeFileSync(contextMd, '');
    await open();
    await mountEditor();
    fs.writeFileSync(contextMd, CONTEXT_TEMPLATE);

    await read();

    expect(disk()).toBe(CONTEXT_TEMPLATE);
  });

  it('devenu illisible dehors : l’éditeur ne le réécrit pas', async () => {
    const latin1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
    await open();
    await mountEditor();
    fs.writeFileSync(contextMd, latin1);

    const hints = await read();

    expect(hints.sources.context.unreadable).toEqual({ reason: 'encoding' });
    expect(fs.readFileSync(contextMd)).toEqual(latin1);
  });

  it('un autre document ouvert : context.md supprimé ne renaît pas', async () => {
    await open(documentMd);
    await mountEditor();
    fs.rmSync(contextMd);

    const hints = await read();

    expect(hints.sources.context.blank).toBe(true);
    expect(fs.existsSync(contextMd)).toBe(false);
    expect(fs.readFileSync(documentMd, 'utf8')).toBe('# Manuscrit\n');
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
