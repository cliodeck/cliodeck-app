/**
 * Le filet de sortie : ce que le renderer répond, combien de temps on l'attend, et quand
 * on demande à l'auteur.
 *
 * `electron` est simulé : la vraie fenêtre et le vrai renderer sont dans
 * `e2e/journey-window-close.spec.ts`. Ici, ce que l'e2e ne peut pas forcer de façon sûre : le
 * délai exact, la réponse absente, la fenêtre détruite au mauvais moment.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

const electron = vi.hoisted(() => ({
  ipcMain: null as unknown as NodeJS.EventEmitter,
  showMessageBox: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  electron.ipcMain = new Emitter();
  electron.showMessageBox = vi.fn();
  return {
    ipcMain: electron.ipcMain,
    dialog: { showMessageBox: electron.showMessageBox },
    app: { isPackaged: false, getAppPath: () => resolve(__dirname, '../../..') },
  };
});

import type { BrowserWindow } from 'electron';
import { flushRenderer, guardWindowClose, mayLeaveRenderer, type FlushReport } from '../renderer-flush';
import { loadMenuTranslations, setLanguage } from '../i18n';

const DELAY = 4000;

class FakeWindow extends EventEmitter {
  destroyed = false;
  contentsDestroyed = false;
  crashed = false;
  minimized = false;
  /** Ce que répond le renderer : rien par défaut, comme s'il était bloqué. */
  answer: FlushReport | null = null;
  sent: string[] = [];
  closed = 0;
  restored = 0;
  shown = 0;
  webContents = {
    isDestroyed: () => this.contentsDestroyed,
    isCrashed: () => this.crashed,
    send: (channel: string) => {
      if (this.contentsDestroyed) throw new Error('Object has been destroyed');
      this.sent.push(channel);
      if (this.answer) {
        const report = this.answer;
        queueMicrotask(() => electron.ipcMain.emit('app:flush-done', {}, report));
      }
    },
  };
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore = () => {
    this.restored += 1;
  };
  show = () => {
    this.shown += 1;
  };
  close = () => {
    this.closed += 1;
  };
  asWindow = () => this as unknown as BrowserWindow;
}

/** Ce que fait Electron à la croix : un événement `close` que l'écouteur peut annuler. */
function pressClose(win: FakeWindow): { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  win.emit('close', event);
  return event;
}

const answerDialog = (response: number) => electron.showMessageBox.mockResolvedValue({ response });

/** Laisse passer les réponses déjà prêtes, sans faire avancer le délai. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  electron.showMessageBox.mockReset();
  answerDialog(0);
  loadMenuTranslations();
  setLanguage('fr');
});

afterEach(async () => {
  // Une demande restée en vol ne doit pas déteindre sur le test suivant.
  await vi.advanceTimersByTimeAsync(DELAY);
  vi.useRealTimers();
  electron.ipcMain.removeAllListeners();
});

describe('flushRenderer', () => {
  it.each<FlushReport>([
    { outcome: 'clean' },
    { outcome: 'saved' },
    { outcome: 'untitled' },
    { outcome: 'failed', error: 'EACCES' },
    { outcome: 'failed', error: 'lent', stillWriting: true },
  ])('rend le rapport du renderer tel quel : $outcome', async (report) => {
    const win = new FakeWindow();
    win.answer = report;
    await expect(flushRenderer(win.asWindow())).resolves.toEqual(report);
    expect(win.sent).toEqual(['app:flush-before-quit']);
  });

  it('un renderer muet : rien avant 4 s, puis `timeout`', async () => {
    const win = new FakeWindow();
    let report: FlushReport | null = null;
    void flushRenderer(win.asWindow()).then((r) => {
      report = r;
    });

    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(report).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toEqual({ outcome: 'timeout' });
  });

  it('un renderer vivant, en retard sur son propre plafond : au délai, `failed`, et pas `timeout`', async () => {
    const win = new FakeWindow();
    let report: FlushReport | null = null;
    void flushRenderer(win.asWindow()).then((r) => {
      report = r;
    });
    electron.ipcMain.emit('app:flush-received');

    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(report).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toMatchObject({ outcome: 'failed' });
    expect((report as unknown as FlushReport).error).toBeTruthy();
  });

  it('la réponse du renderer vaut toujours mieux que le délai : son rapport est rendu tel quel', async () => {
    const win = new FakeWindow();
    const report = flushRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-received');
    electron.ipcMain.emit('app:flush-done', {}, { outcome: 'saved' });

    await expect(report).resolves.toEqual({ outcome: 'saved' });
    expect(electron.ipcMain.listenerCount('app:flush-received')).toBe(0);
  });

  it('la demande finie, sa réception ne vaut pas pour la suivante', async () => {
    const win = new FakeWindow();
    const first = flushRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-received');
    await vi.advanceTimersByTimeAsync(DELAY);
    await expect(first).resolves.toMatchObject({ outcome: 'failed' });
    expect(electron.ipcMain.listenerCount('app:flush-received')).toBe(0);

    const second = flushRenderer(win.asWindow());
    await vi.advanceTimersByTimeAsync(DELAY);
    await expect(second).resolves.toEqual({ outcome: 'timeout' });
    expect(electron.ipcMain.listenerCount('app:flush-received')).toBe(0);
  });

  it('plus de fenêtre, fenêtre ou page détruite, page plantée : personne à qui demander, et aucune attente', async () => {
    await expect(flushRenderer(null)).resolves.toEqual({ outcome: 'no-window' });

    const destroyed = new FakeWindow();
    destroyed.destroyed = true;
    await expect(flushRenderer(destroyed.asWindow())).resolves.toEqual({ outcome: 'no-window' });

    const contentsGone = new FakeWindow();
    contentsGone.contentsDestroyed = true;
    await expect(flushRenderer(contentsGone.asWindow())).resolves.toEqual({ outcome: 'no-window' });

    const crashed = new FakeWindow();
    crashed.crashed = true;
    await expect(flushRenderer(crashed.asWindow())).resolves.toEqual({ outcome: 'no-window' });
    expect(crashed.sent).toEqual([]);
  });

  it('la page disparaît juste avant l’envoi : `no-window`, sans attendre le délai', async () => {
    const win = new FakeWindow();
    const send = win.webContents.send;
    win.webContents.send = () => {
      throw new Error('Object has been destroyed');
    };
    await expect(flushRenderer(win.asWindow())).resolves.toEqual({ outcome: 'no-window' });
    win.webContents.send = send;
  });

  it('deux demandes pendant qu’une est en vol : un seul envoi, et le même rapport', async () => {
    const win = new FakeWindow();
    const first = flushRenderer(win.asWindow());
    const second = flushRenderer(win.asWindow());
    expect(win.sent).toHaveLength(1);

    electron.ipcMain.emit('app:flush-done', {}, { outcome: 'saved' });

    await expect(first).resolves.toEqual({ outcome: 'saved' });
    await expect(second).resolves.toEqual({ outcome: 'saved' });
  });

  it('la demande finie, la suivante repart, y compris après un délai dépassé', async () => {
    const win = new FakeWindow();
    const first = flushRenderer(win.asWindow());
    await vi.advanceTimersByTimeAsync(DELAY);
    await expect(first).resolves.toEqual({ outcome: 'timeout' });

    win.answer = { outcome: 'clean' };
    await expect(flushRenderer(win.asWindow())).resolves.toEqual({ outcome: 'clean' });
    expect(win.sent).toHaveLength(2);
  });

  it.each<[string, unknown]>([
    ['sans rapport', undefined],
    ['nul', null],
    ['un nombre', 42],
    ['une chaîne', 'saved'],
    ['un objet vide', {}],
    ['un résultat inconnu', { outcome: 'parti' }],
    ['`timeout`, que seul le main peut dire', { outcome: 'timeout' }],
    ['`no-window`, que seul le main peut dire', { outcome: 'no-window' }],
  ])('un accusé illisible (%s) : le texte n’est pas réputé écrit, `failed`', async (_name, ack) => {
    const win = new FakeWindow();
    const report = flushRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-done', {}, ack);

    const read = await report;
    expect(read.outcome).toBe('failed');
    expect(read.error).toBeTruthy();
  });

  it('une erreur qui n’est pas un texte ne change rien au résultat, et ne va pas plus loin', async () => {
    const win = new FakeWindow();
    const report = flushRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-done', {}, { outcome: 'saved', error: { nope: true } });

    await expect(report).resolves.toStrictEqual({ outcome: 'saved' });
  });

  it('deux accusés pour une demande : le second ne vaut pas pour la demande suivante', async () => {
    const win = new FakeWindow();
    const first = flushRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-done', {}, { outcome: 'clean' });
    electron.ipcMain.emit('app:flush-done', {}, { outcome: 'failed', error: 'en retard' });
    await expect(first).resolves.toEqual({ outcome: 'clean' });

    expect(electron.ipcMain.listenerCount('app:flush-done')).toBe(0);
  });
});

describe('mayLeaveRenderer', () => {
  it('un renderer vivant, en retard sur son propre plafond : on demande à l’auteur', async () => {
    const win = new FakeWindow();
    answerDialog(0);
    const leave = mayLeaveRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-received');
    await vi.advanceTimersByTimeAsync(DELAY);

    await expect(leave).resolves.toBe(false);
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it.each<FlushReport>([{ outcome: 'clean' }, { outcome: 'saved' }])(
    'rapport $outcome : on part sans rien demander',
    async (report) => {
      const win = new FakeWindow();
      win.answer = report;
      await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(true);
      expect(electron.showMessageBox).not.toHaveBeenCalled();
    }
  );

  it('renderer muet : après le délai, on part sans rien demander', async () => {
    const win = new FakeWindow();
    const decision = mayLeaveRenderer(win.asWindow());
    await vi.advanceTimersByTimeAsync(DELAY);
    await expect(decision).resolves.toBe(true);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });

  it('plus de fenêtre : on part sans rien demander', async () => {
    await expect(mayLeaveRenderer(null)).resolves.toBe(true);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });

  it.each<[FlushReport, string]>([
    [{ outcome: 'untitled' }, 'sans titre'],
    [{ outcome: 'failed', error: 'EACCES: permission denied' }, 'pas pu être enregistré'],
  ])('rapport %j : le dialogue, et Rester garde la fenêtre', async (report, phrase) => {
    const win = new FakeWindow();
    win.answer = report;
    answerDialog(0);

    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(false);

    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, options] = electron.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(options.message).toContain(phrase);
    expect(options.buttons).toEqual(['Rester', 'Quitter sans enregistrer']);
    // Échap et Entrée restent du côté du texte.
    expect(options.cancelId).toBe(0);
    expect(options.defaultId).toBe(0);
    // Le texte du système n'apprend rien à l'historien : il va au journal.
    expect(JSON.stringify(options)).not.toContain('EACCES');
  });

  it('écriture encore en cours (lente, pas en échec) : un texte à part, mot pour mot, et les mêmes boutons (D7)', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'failed', error: "L'écriture n'a pas répondu à temps", stillWriting: true };
    answerDialog(0);

    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(false);

    const [, options] = electron.showMessageBox.mock.calls[0];
    expect(options.message).toBe(
      "L'enregistrement prend du temps, si vous quittez maintenant, vos modifications seront perdues"
    );
    expect(options.buttons).toEqual(['Rester', 'Quitter sans enregistrer']);
    expect(options.cancelId).toBe(0);
    expect(options.defaultId).toBe(0);
  });

  it('témoin : un vrai échec garde son texte, sans « prend du temps »', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'failed', error: 'EACCES' };
    await mayLeaveRenderer(win.asWindow());
    const [, options] = electron.showMessageBox.mock.calls[0];
    expect(options.message).toContain('pas pu être enregistré');
    expect(options.message).not.toContain('prend du temps');
  });

  it.each([
    ['en', 'taking a while'],
    ['de', 'dauert'],
  ] as const)('écriture encore en cours, %s : le texte est traduit', async (language, phrase) => {
    setLanguage(language);
    const win = new FakeWindow();
    win.answer = { outcome: 'failed', stillWriting: true };
    await mayLeaveRenderer(win.asWindow());
    const [, options] = electron.showMessageBox.mock.calls[0];
    expect(options.message).toContain(phrase);
  });

  it('Quitter sans enregistrer laisse partir', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    answerDialog(1);
    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(true);
  });

  it.each([
    ['en', 'Stay', 'Quit without saving', 'untitled'],
    ['de', 'Bleiben', 'Beenden ohne Speichern', 'unbenannte'],
  ] as const)('le dialogue parle la langue de l’interface : %s', async (language, stay, leave, phrase) => {
    setLanguage(language);
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    await mayLeaveRenderer(win.asWindow());
    const [, options] = electron.showMessageBox.mock.calls[0];
    expect(options.buttons).toEqual([stay, leave]);
    expect(options.message).toContain(phrase);
  });

  it('une fenêtre réduite revient avant la question : une feuille sur une fenêtre réduite ne se voit pas', async () => {
    const win = new FakeWindow();
    win.minimized = true;
    win.answer = { outcome: 'untitled' };
    await mayLeaveRenderer(win.asWindow());
    expect(win.restored).toBe(1);
    expect(win.shown).toBe(1);
  });

  it('la fenêtre a disparu pendant l’écriture ratée : plus personne à qui demander', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'failed', error: 'x' };
    const decision = mayLeaveRenderer(win.asWindow());
    win.destroyed = true;
    await expect(decision).resolves.toBe(true);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });

  it('deux demandes en vol : un seul envoi, un seul dialogue, et la même réponse pour les deux', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    answerDialog(0);
    const first = mayLeaveRenderer(win.asWindow());
    const second = mayLeaveRenderer(win.asWindow());

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(win.sent).toHaveLength(1);
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('un accusé sans rapport : la question, et Quitter part', async () => {
    const win = new FakeWindow();
    answerDialog(1);
    const decision = mayLeaveRenderer(win.asWindow());
    electron.ipcMain.emit('app:flush-done', {}, undefined);

    await expect(decision).resolves.toBe(true);
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.showMessageBox.mock.calls[0][1].message).toContain('pas pu être enregistré');
  });

  it('une décision qui lève ne retient personne, et ne bloque pas la demande suivante', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    const healthy = win.isDestroyed;
    let calls = 0;
    win.isDestroyed = () => {
      calls += 1;
      if (calls > 1) throw new Error('Object has been destroyed');
      return false;
    };
    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(true);

    win.isDestroyed = healthy;
    win.answer = { outcome: 'clean' };
    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(true);
    expect(win.sent).toHaveLength(2);
  });

  it('le dialogue qui échoue n’empêche jamais de partir', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    electron.showMessageBox.mockRejectedValue(new Error('pas de dialogue'));
    await expect(mayLeaveRenderer(win.asWindow())).resolves.toBe(true);
  });
});

describe('guardWindowClose', () => {
  it('la fermeture attend le filet : annulée d’abord, puis relancée une fois, et le second passage n’est plus retenu', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'saved' };
    guardWindowClose(win.asWindow());

    expect(pressClose(win).prevented).toBe(true);
    expect(win.closed).toBe(0);
    await settle();

    expect(win.closed).toBe(1);
    expect(pressClose(win).prevented).toBe(false);
    expect(win.sent).toHaveLength(1);
  });

  it('Rester : la fenêtre reste, et la fermeture suivante redemande', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    answerDialog(0);
    guardWindowClose(win.asWindow());

    expect(pressClose(win).prevented).toBe(true);
    await settle();
    expect(win.closed).toBe(0);

    expect(pressClose(win).prevented).toBe(true);
    await settle();
    expect(win.closed).toBe(0);
    expect(win.sent).toHaveLength(2);
    expect(electron.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('une deuxième croix pendant l’attente : annulée, sans deuxième demande ni deuxième fermeture', async () => {
    const win = new FakeWindow();
    guardWindowClose(win.asWindow());

    expect(pressClose(win).prevented).toBe(true);
    expect(pressClose(win).prevented).toBe(true);
    expect(win.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(win.closed).toBe(1);
  });

  it('un accusé sans rapport ne coince pas la croix : la question, Rester redemande, Quitter ferme', async () => {
    const win = new FakeWindow();
    answerDialog(0);
    guardWindowClose(win.asWindow());

    expect(pressClose(win).prevented).toBe(true);
    electron.ipcMain.emit('app:flush-done', {}, undefined);
    await settle();
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.closed).toBe(0);

    // Rien ne reste derrière lui : la croix suivante repose la question au renderer.
    answerDialog(1);
    expect(pressClose(win).prevented).toBe(true);
    expect(win.sent).toHaveLength(2);
    electron.ipcMain.emit('app:flush-done', {}, undefined);
    await settle();
    expect(electron.showMessageBox).toHaveBeenCalledTimes(2);
    expect(win.closed).toBe(1);
  });

  it('une décision qui lève ne coince pas la croix : la fenêtre part', async () => {
    const win = new FakeWindow();
    win.answer = { outcome: 'untitled' };
    guardWindowClose(win.asWindow());
    const healthy = win.isDestroyed;
    let calls = 0;
    win.isDestroyed = () => {
      calls += 1;
      if (calls === 2) throw new Error('Object has been destroyed');
      return healthy();
    };

    expect(pressClose(win).prevented).toBe(true);
    await settle();
    expect(win.closed).toBe(1);
  });

  it('un renderer muet ne retient la fenêtre que 4 s', async () => {
    const win = new FakeWindow();
    guardWindowClose(win.asWindow());
    pressClose(win);

    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(win.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(win.closed).toBe(1);
  });

  it('la fenêtre détruite pendant l’attente : pas de fermeture sur un objet mort', async () => {
    const win = new FakeWindow();
    guardWindowClose(win.asWindow());
    pressClose(win);
    win.destroyed = true;
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(win.closed).toBe(0);
  });

  it('chaque fenêtre a son passage : celle que le Dock recrée n’hérite pas de la précédente', async () => {
    const first = new FakeWindow();
    first.answer = { outcome: 'clean' };
    guardWindowClose(first.asWindow());
    pressClose(first);
    await settle();
    expect(first.closed).toBe(1);

    const second = new FakeWindow();
    second.answer = { outcome: 'clean' };
    guardWindowClose(second.asWindow());
    expect(pressClose(second).prevented).toBe(true);
    await settle();
    expect(second.closed).toBe(1);
    expect(second.sent).toHaveLength(1);
  });
});
