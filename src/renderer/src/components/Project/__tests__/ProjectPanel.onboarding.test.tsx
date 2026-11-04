// @vitest-environment jsdom
/**
 * « Rejouer l'assistant de démarrage » sur un `context.md` écrit à la main (S17-1-0, décision Q6).
 *
 * Le bouton réécrivait le fichier d'un bloc : deux pages de consignes remplacées par le texte
 * généré, sans question ni copie, et l'échec d'écriture fermait l'assistant sans un mot.
 *
 * Vrais panneau, assistant et éditeur ; vrais handlers sur un vrai dossier (`real-main`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installMain, main, passage } from '../../../services/__tests__/helpers/real-main';
import { CONTEXT_TEMPLATE, loadWorkspaceHints } from '../../../../../../backend/core/hints/loader';
import { symlinkAvailable } from '../../../../../../backend/__tests__/helpers/native-guards';
import { ProjectPanel } from '../ProjectPanel';
import { useDialogStore } from '../../../stores/dialogStore';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

// Vrai disque et plusieurs allers-retours par test : la CI est plus lente que ce poste.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('../../Config/ActionsSection', () => ({ ActionsSection: () => null }));
vi.mock('../ZoteroProjectSettings', () => ({ ZoteroProjectSettings: () => null }));
vi.mock('../CSLSettings', () => ({ CSLSettings: () => null }));
vi.mock('../RevealJsConfig', () => ({ RevealJsConfig: () => null }));

const IS_ROOT = process.getuid?.() === 0;
const AUTHOR_TEXT =
  '# Danzig\n\nProblématique : la ville libre, 1919-1939.\n\nConventions de citation : Chicago.\n\nHistoriographie : à reprendre.\n';
const TOPIC = 'Ports baltes';
const LEGACY_TEMPLATE =
  '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. Ce contexte sera utilisé pour améliorer les réponses de l\'assistant IA.\n\nExemple : "Cette recherche porte sur l\'impact de l\'intelligence artificielle dans l\'éducation supérieure, avec un focus particulier sur la taxonomie de Bloom et les stratégies pédagogiques actives."';

const dialogs = () => useDialogStore.getState();
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let project: string;
let outside: string;
let contextMd: string;

function openProject(dir: string): void {
  main.projectPath = dir;
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Danzig',
      path: dir,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    loadRecentProjects: async () => undefined,
    loadState: { kind: 'idle' },
  } as never);
}

const wizardOpen = () => document.querySelector('.onboarding-wizard') !== null;

async function renderPanel(): Promise<void> {
  await act(async () => {
    render(<ProjectPanel />);
  });
}

/** Les gestes de l'auteur, jusqu'au dernier écran de l'assistant. */
async function answerQuestions(topic: string = TOPIC): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('project.reopenOnboarding'));
  });
  fireEvent.change(screen.getByPlaceholderText('onboarding.topicPlaceholder'), { target: { value: topic } });
  for (let step = 0; step < 3; step += 1) {
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.next'));
    });
  }
}

async function pressFinish(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('onboarding.finish'));
  });
}

async function replayAssistant(topic: string = TOPIC): Promise<void> {
  await answerQuestions(topic);
  await pressFinish();
}

const awaitConfirm = () => vi.waitFor(() => expect(dialogs().confirmOpen).toBe(true), { timeout: 10_000, interval: 5 });
const awaitAlert = () => vi.waitFor(() => expect(dialogs().alertOpen).toBe(true), { timeout: 10_000, interval: 5 });
const awaitClosed = () => vi.waitFor(() => expect(wizardOpen()).toBe(false), { timeout: 10_000, interval: 5 });
const doneScreen = () => screen.queryByText('onboarding.doneMessage');
const awaitDoneScreen = () => vi.waitFor(() => expect(doneScreen()).not.toBeNull(), { timeout: 10_000, interval: 5 });

/** C'est écrit : l'assistant le dit, et c'est l'auteur qui le ferme. */
async function closeDoneScreen(): Promise<void> {
  await awaitDoneScreen();
  await act(async () => {
    fireEvent.click(screen.getByText('onboarding.startWorking'));
  });
  expect(wizardOpen()).toBe(false);
}

async function answerConfirm(accept: boolean): Promise<void> {
  await act(async () => {
    dialogs().resolveConfirm(accept);
  });
}

async function closeAlert(): Promise<void> {
  await act(async () => {
    dialogs().closeAlert();
  });
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-assistant-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-assistant-dehors-'));
  contextMd = path.join(project, 'context.md');
  passage.reset();
  installMain();
  openProject(project);
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    editorFacade: null,
    switchLock: null,
    bufferDetached: false,
  } as never);
});

afterEach(async () => {
  cleanup();
  useProjectStore.setState({ currentProject: null, loadState: { kind: 'idle' } });
  useEditorStore.setState({ filePath: null, content: '', isDirty: false, editorFacade: null } as never);
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  while (dialogs().alertOpen) dialogs().closeAlert();
  await fs.promises.chmod(contextMd, 0o644).catch(() => undefined);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('rejouer l’assistant quand context.md porte un texte', () => {
  it('confirmer : le texte de l’auteur reste, suivi de la section générée', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    expect(dialogs().confirmMessage).toBe('onboarding.appendConfirm');
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.startsWith(AUTHOR_TEXT.trimEnd())).toBe(true);
    expect(written).toContain('## Research Topic');
    expect(written).toContain(TOPIC);
    expect(written.indexOf('Historiographie')).toBeLessThan(written.indexOf(TOPIC));
    // Le contexte part au modèle avec les deux textes.
    const { normalized } = await loadWorkspaceHints(project);
    expect(normalized).toContain('Problématique');
    expect(normalized).toContain(TOPIC);
  });

  it('refuser : fichier identique à l’octet, et l’assistant garde ce qui a été répondu', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    const before = fs.statSync(contextMd).mtimeMs;
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(false);
    await settle();

    expect(fs.readFileSync(contextMd, 'utf8')).toBe(AUTHOR_TEXT);
    expect(fs.statSync(contextMd).mtimeMs).toBe(before);
    expect(wizardOpen()).toBe(true);
    expect(doneScreen()).toBeNull();

    // Il change d'avis : ses réponses sont toujours là.
    await pressFinish();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();
    expect(fs.readFileSync(contextMd, 'utf8')).toContain(TOPIC);
  });

  it('fermer l’assistant après avoir refusé n’écrit rien', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(false);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.skipSetup'));
    });
    await awaitClosed();

    expect(fs.readFileSync(contextMd, 'utf8')).toBe(AUTHOR_TEXT);
  });

  it.each<[string, string]>([
    ['du texte dans un commentaire HTML', '<!-- Ne jamais citer Wikipédia. Toujours en Chicago. -->\n'],
    ['des titres seuls', '# Ma thèse\n'],
    ['le gabarit au titre retouché', CONTEXT_TEMPLATE.replace('Contexte du projet', 'Contexte de ma thèse')],
    ['le gabarit au commentaire retouché', CONTEXT_TEMPLATE.replace('sujet, période', 'Danzig, 1919-1939')],
    ['le gabarit d’une version antérieure', LEGACY_TEMPLATE],
  ])('%s : rien ne part au modèle, mais il y a de quoi demander', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(false);
    await settle();
    expect(fs.readFileSync(contextMd, 'utf8')).toBe(bytes);

    await pressFinish();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.startsWith(bytes.trimEnd())).toBe(true);
    expect(written).toContain(TOPIC);
    // Ajouter à un fichier jusque-là inerte doit servir à quelque chose.
    expect((await loadWorkspaceHints(project)).normalized).toContain(TOPIC);
  });

  it('CRLF : la section suit les fins de ligne du fichier, et le BOM reste', async () => {
    const bytes = '﻿# Danzig\r\n\r\nProblématique.\r\n';
    fs.writeFileSync(contextMd, bytes);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.startsWith('﻿# Danzig\r\n\r\nProblématique.\r\n\r\n')).toBe(true);
    expect(written).toContain(TOPIC);
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('rejouer deux fois avec les mêmes réponses n’ajoute pas deux fois la section', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();
    const once = fs.readFileSync(contextMd, 'utf8');

    await replayAssistant();
    await closeDoneScreen();

    expect(dialogs().confirmOpen).toBe(false);
    expect(fs.readFileSync(contextMd, 'utf8')).toBe(once);
  });

  it('d’autres réponses : une seconde section, après confirmation', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    await replayAssistant('Hanse tardive');
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written).toContain(TOPIC);
    expect(written).toContain('Hanse tardive');
  });

  it('un double clic sur Terminer ne pose qu’une question et n’ajoute qu’une section', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await answerQuestions();
    const finish = screen.getByText('onboarding.finish');
    await act(async () => {
      fireEvent.click(finish);
      fireEvent.click(finish);
    });
    await awaitConfirm();
    expect(dialogs().queue).toHaveLength(1);
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.split('## Research Topic')).toHaveLength(2);
  });

  it('le fichier change pendant la question : conflit, le texte de l’autre reste, et les réponses aussi', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    fs.writeFileSync(contextMd, `${AUTHOR_TEXT}\nAjouté ailleurs.\n`);
    await answerConfirm(true);
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('hints.reasons.conflict');
    expect(fs.readFileSync(contextMd, 'utf8')).toBe(`${AUTHOR_TEXT}\nAjouté ailleurs.\n`);
    expect(wizardOpen()).toBe(true);

    await closeAlert();
    await pressFinish();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();
    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written).toContain('Ajouté ailleurs.');
    expect(written).toContain(TOPIC);
  });

  it('un autre projet s’ouvre pendant la question : rien n’y est écrit', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-assistant-autre-'));
    try {
      fs.writeFileSync(path.join(other, 'context.md'), AUTHOR_TEXT);
      await renderPanel();

      await replayAssistant();
      await awaitConfirm();
      main.projectPath = other;
      await answerConfirm(true);
      await awaitAlert();

      expect(dialogs().alertMessage).toContain('hints.reasons.projectChanged');
      expect(fs.readFileSync(path.join(other, 'context.md'), 'utf8')).toBe(AUTHOR_TEXT);
      expect(fs.readFileSync(contextMd, 'utf8')).toBe(AUTHOR_TEXT);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('context.md ouvert et modifié dans l’éditeur : ce qui y est tapé compte, et le tampon suit', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await useEditorStore.getState().loadFile(contextMd);
    useEditorStore.getState().setContent(`${AUTHOR_TEXT}\nTapé à l’instant.\n`);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written).toContain('Tapé à l’instant.');
    expect(written).toContain(TOPIC);
    expect(useEditorStore.getState().content).toBe(written);
    expect(useEditorStore.getState().isDirty).toBe(false);
  });
});

describe('l’écran de fin de l’assistant', () => {
  it('ne vient qu’une fois le fichier écrit, et reste jusqu’à ce que l’auteur le ferme', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    let release: () => void = () => undefined;
    passage.beforeHintsWrite = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await settle();

    // L'écriture est retenue : rien à annoncer encore.
    expect(doneScreen()).toBeNull();
    expect(fs.readFileSync(contextMd, 'utf8')).toBe(AUTHOR_TEXT);

    await act(async () => {
      release();
    });
    await awaitDoneScreen();
    expect(fs.readFileSync(contextMd, 'utf8')).toContain(TOPIC);
    expect(wizardOpen()).toBe(true);
    // Il n'y a plus rien à passer.
    expect(screen.queryByText('onboarding.skipSetup')).toBeNull();

    await closeDoneScreen();
  });

  it('rouvrir ensuite repart de la première question', async () => {
    await renderPanel();

    await replayAssistant();
    await closeDoneScreen();
    await act(async () => {
      fireEvent.click(screen.getByText('project.reopenOnboarding'));
    });

    expect(screen.getByPlaceholderText('onboarding.topicPlaceholder')).not.toBeNull();
    expect(doneScreen()).toBeNull();
  });
});

describe('context.md ouvert et propre, puis supprimé dehors : l’éditeur tient encore le texte', () => {
  it('confirmer : la question est posée, et les deux textes sont là, dans le fichier et l’éditeur', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await useEditorStore.getState().loadFile(contextMd);
    fs.rmSync(contextMd);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(true);
    await closeDoneScreen();

    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.startsWith(AUTHOR_TEXT.trimEnd())).toBe(true);
    expect(written).toContain(TOPIC);
    expect(useEditorStore.getState().content).toBe(written);
  });

  it('refuser : l’assistant n’écrit rien, et le texte de l’éditeur reste', async () => {
    fs.writeFileSync(contextMd, AUTHOR_TEXT);
    await useEditorStore.getState().loadFile(contextMd);
    fs.rmSync(contextMd);
    await renderPanel();

    await replayAssistant();
    await awaitConfirm();
    await answerConfirm(false);
    await settle();

    expect(fs.readFileSync(contextMd, 'utf8')).toBe(AUTHOR_TEXT);
    expect(useEditorStore.getState().content).toBe(AUTHOR_TEXT);
    expect(wizardOpen()).toBe(true);
  });
});

describe('rejouer l’assistant quand context.md ne porte rien de l’auteur', () => {
  it('absent : il se crée, sans question', async () => {
    await renderPanel();

    await replayAssistant();
    await closeDoneScreen();

    expect(dialogs().confirmOpen).toBe(false);
    expect(fs.readFileSync(contextMd, 'utf8')).toContain(TOPIC);
  });

  it.each<[string, string]>([
    ['vide', ''],
    ['le gabarit tel que le crée un projet neuf', CONTEXT_TEMPLATE],
    ['le gabarit et des blancs de fin', `${CONTEXT_TEMPLATE}\n  \n`],
  ])('%s : remplacé, sans question', async (_label, bytes) => {
    fs.writeFileSync(contextMd, bytes);
    await renderPanel();

    await replayAssistant();
    await closeDoneScreen();

    expect(dialogs().confirmOpen).toBe(false);
    const written = fs.readFileSync(contextMd, 'utf8');
    expect(written.startsWith('# Danzig\n')).toBe(true);
    expect(written).not.toContain('Décrivez ici');
    expect(written).toContain(TOPIC);
  });
});

describe('quand ça n’aboutit pas, l’assistant le dit et garde les réponses', () => {
  it.skipIf(IS_ROOT)('l’écriture échoue : message, assistant ouvert, et un nouvel essai aboutit', async () => {
    fs.writeFileSync(contextMd, CONTEXT_TEMPLATE);
    fs.chmodSync(contextMd, 0o444);
    await renderPanel();

    await replayAssistant();
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('onboarding.writeError');
    expect(wizardOpen()).toBe(true);
    expect(doneScreen()).toBeNull();
    expect(fs.readFileSync(contextMd, 'utf8')).toBe(CONTEXT_TEMPLATE);

    await closeAlert();
    fs.chmodSync(contextMd, 0o644);
    await pressFinish();
    await closeDoneScreen();
    expect(fs.readFileSync(contextMd, 'utf8')).toContain(TOPIC);
  });

  it('le canal lui-même échoue : pareil', async () => {
    fs.writeFileSync(contextMd, CONTEXT_TEMPLATE);
    passage.beforeHintsWrite = async () => {
      throw new Error('canal rompu');
    };
    await renderPanel();

    await replayAssistant();
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('onboarding.writeError');
    expect(wizardOpen()).toBe(true);
  });

  it('pas en UTF-8 : message, aucune question, fichier intact', async () => {
    const latin1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
    fs.writeFileSync(contextMd, latin1);
    await renderPanel();

    await replayAssistant();
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('hints.reasons.notUtf8');
    expect(dialogs().confirmOpen).toBe(false);
    expect(fs.readFileSync(contextMd)).toEqual(latin1);
    expect(wizardOpen()).toBe(true);
  });

  it.skipIf(!symlinkAvailable)('lien qui sort du projet : dit tel quel, ni conflit ni fichier à créer', async () => {
    const journal = path.join(outside, 'journal.md');
    fs.writeFileSync(journal, 'Texte privé.');
    fs.symlinkSync(journal, contextMd);
    await renderPanel();

    await replayAssistant();
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('hints.reasons.outsideProject');
    expect(dialogs().alertMessage).not.toContain('conflict');
    expect(dialogs().confirmOpen).toBe(false);
    expect(fs.readFileSync(journal, 'utf8')).toBe('Texte privé.');
    expect(fs.lstatSync(contextMd).isSymbolicLink()).toBe(true);
    expect(wizardOpen()).toBe(true);
  });

  it.skipIf(!symlinkAvailable)('lien cassé qui sort du projet : pas pris pour un fichier absent à créer', async () => {
    const elsewhere = path.join(outside, 'cree-dehors.md');
    fs.symlinkSync(elsewhere, contextMd);
    await renderPanel();

    await replayAssistant();
    await awaitAlert();

    expect(dialogs().alertMessage).toContain('hints.reasons.outsideProject');
    expect(fs.existsSync(elsewhere)).toBe(false);
  });
});
