/**
 * Le filet de sortie : le renderer écrit le document avant que l'éditeur soit détruit.
 *
 * `before-quit` arrêtait proprement le topic modeling mais ne touchait pas à l'éditeur, et
 * aucun `beforeunload` n'existait côté renderer : `Cmd+Q` dans les trois secondes suivant
 * une frappe perdait le texte, et sans autosave la perte n'était pas bornée. Même classe de
 * perte que la bascule de projet (#37). La croix, `Cmd+W` et `Cmd+R` détruisent l'éditeur
 * de la même façon : tous passent ici.
 *
 * Borné dans le temps : un renderer bloqué ne doit jamais empêcher de quitter. Mieux vaut
 * perdre la sauvegarde que la fenêtre ne se ferme pas.
 */
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { FlushOutcome, FlushReport } from '../../backend/types/flush-report.js';
import { t } from './i18n.js';

export type { FlushReport };

const FLUSH_TIMEOUT_MS = 4000;
/** L'ordre des boutons du dialogue : `Rester` est aussi la réponse d'Échap et d'Entrée. */
const STAY_BUTTON = 0;
/** Ce que le renderer peut répondre : `timeout` et `no-window` ne se disent que de ce côté. */
const RENDERER_OUTCOMES: readonly FlushOutcome[] = ['clean', 'saved', 'failed', 'untitled'];

// Une seule fenêtre principale à la fois. Une croix et `Cmd+Q` coup sur coup sont deux
// gestes pour une seule question : ni deux écritures, ni deux dialogues.
let flushInFlight: Promise<FlushReport> | null = null;
let decisionInFlight: Promise<boolean> | null = null;

/**
 * `lifecycle.flushDone` est exposé à la page, et rien ne garantit ce qu'elle envoie. Un accusé
 * illisible n'est pas un texte écrit : il se dit comme une écriture ratée, et l'auteur tranche.
 */
function readRendererReport(ack: unknown): FlushReport {
  const { outcome, error, stillWriting } = (ack ?? {}) as Partial<FlushReport>;
  if (!outcome || !RENDERER_OUTCOMES.includes(outcome)) {
    return { outcome: 'failed', error: 'Accusé du renderer illisible' };
  }
  const report: FlushReport = typeof error === 'string' ? { outcome, error } : { outcome };
  if (outcome === 'failed' && stillWriting === true) report.stillWriting = true;
  return report;
}

/** Une écriture encore en cours n'est pas un échec : elle peut aboutir si l'auteur reste. */
function leaveQuestion(report: FlushReport): string {
  if (report.outcome === 'untitled') return 'unsavedUntitledMessage';
  return report.stillWriting ? 'unsavedSaveSlowMessage' : 'unsavedSaveFailedMessage';
}

function askRendererToFlush(win: BrowserWindow | null, timeoutMs: number): Promise<FlushReport> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) {
    return Promise.resolve({ outcome: 'no-window' });
  }
  const contents = win.webContents;

  return new Promise((resolve) => {
    let received = false;
    const onReceived = (): void => {
      received = true;
    };
    const finish = (report: FlushReport): void => {
      clearTimeout(timer);
      ipcMain.removeListener('app:flush-received', onReceived);
      ipcMain.removeListener('app:flush-done', onDone);
      resolve(report);
    };
    const onDone = (_event: unknown, ack: unknown): void => finish(readRendererReport(ack));
    // Le plafond d'écriture du renderer tombe avant ce délai, mais une page occupée ou une
    // machine chargée peut le retarder. Une page qui a reçu la demande vit : son texte n'est
    // pas réputé écrit, et seule une page qui n'a rien reçu est bloquée.
    const timer = setTimeout(
      () => finish(received ? { outcome: 'failed', error: 'Réponse du renderer en retard' } : { outcome: 'timeout' }),
      timeoutMs
    );

    ipcMain.once('app:flush-received', onReceived);
    ipcMain.once('app:flush-done', onDone);
    try {
      contents.send('app:flush-before-quit');
    } catch {
      finish({ outcome: 'no-window' });
    }
  });
}

/** Demande au renderer d'écrire le document ouvert, et rend ce qu'il en est advenu. */
export function flushRenderer(
  win: BrowserWindow | null,
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<FlushReport> {
  flushInFlight ??= askRendererToFlush(win, timeoutMs).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function decideToLeave(win: BrowserWindow | null, timeoutMs: number): Promise<boolean> {
  const report = await flushRenderer(win, timeoutMs);
  console.log(`💾 [Quit] flush éditeur : ${report.outcome}${report.error ? ` (${report.error})` : ''}`);

  // Un renderer bloqué, ou plus de fenêtre : personne à qui demander, on part. Seul un texte
  // qu'on sait non écrit retient, et une écriture qui traîne en est un.
  if (report.outcome !== 'failed' && report.outcome !== 'untitled') return true;
  if (!win || win.isDestroyed()) return true;

  // Sous macOS, le dialogue est une feuille de la fenêtre : réduite ou masquée, elle ne
  // se verrait pas, et la sortie semblerait bloquée.
  if (win.isMinimized()) win.restore();
  win.show();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t(leaveQuestion(report)),
    buttons: [t('unsavedStay'), t('unsavedLeave')],
    defaultId: STAY_BUTTON,
    cancelId: STAY_BUTTON,
    noLink: true,
  });
  return response !== STAY_BUTTON;
}

/**
 * Écrit le document, et rend vrai si le renderer peut être détruit. Un tampon sans titre
 * non vide, ou une écriture ratée, le demandent à l'auteur : rend faux s'il préfère rester.
 * Ne rejette jamais : une décision impossible ne retient ni la fenêtre ni la sortie.
 */
export function mayLeaveRenderer(
  win: BrowserWindow | null,
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<boolean> {
  decisionInFlight ??= decideToLeave(win, timeoutMs)
    .catch((error: unknown) => {
      console.warn('⚠️ [Quit] décision de sortie impossible :', error);
      return true;
    })
    .finally(() => {
      decisionInFlight = null;
    });
  return decisionInFlight;
}

/**
 * La fenêtre n'attend pas `before-quit` pour se fermer : sous Windows et Linux, la croix
 * met `mainWindow` à nul avant lui, et sous macOS, elle ne quitte pas du tout. La fermeture
 * attend donc le filet, puis repart une seule fois. Le passage est propre à cette fenêtre :
 * celle que le Dock recrée sous macOS repose la question.
 */
export function guardWindowClose(win: BrowserWindow): void {
  let cleared = false;
  let deciding = false;

  win.on('close', (event) => {
    if (cleared) return;
    event.preventDefault();
    if (deciding) return;
    deciding = true;
    void mayLeaveRenderer(win).then((leave) => {
      deciding = false;
      if (!leave || win.isDestroyed()) return;
      cleared = true;
      win.close();
    });
  });
}
