// @vitest-environment jsdom
/**
 * La porte de l'éditeur : tout remplacement du document passe par `replaceBuffer`.
 *
 * Chaque chemin qui remplaçait le document avait sa propre idée de ce qu'il fallait
 * écrire d'abord : `loadFile` écrivait le sortant sauf s'il se rouvrait lui-même,
 * `createNewFile` n'écrivait rien, et un tampon sans titre partait sans question.
 *
 * Vrais stores (éditeur et dialogues). Sont simulés le disque, derrière l'IPC, et la
 * façade de la vue, réduite au texte vivant : la vraie vue a ses tests à part
 * (`CodeMirrorEditor.buffer.test.tsx`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EditorFacade } from '@/editor/facade';
import i18n from '../../i18n';
import { useEditorStore } from '../editorStore';
import { useDialogStore } from '../dialogStore';

const A = '/livre/chapters/a.md';
const B = '/livre/chapters/b.md';
const C = '/livre/chapters/c.md';
const LOCK = 'book.renumberInProgress';

let disk: Record<string, string>;
let writes: Array<[string, string]>;
let reads: string[];
/** Appelés avant de répondre : une attente, un refus du main ou une frappe. */
let beforeRead: (path: string) => Promise<void> | void;
type WriteVerdict = { success: false; error: string } | void;
let beforeWrite: (path: string) => Promise<WriteVerdict> | WriteVerdict;
let live: string;
let setValue: ReturnType<typeof vi.fn>;
/** Le pont IPC simulé : un test peut y glisser ce qui arrive pendant une écriture. */
let editorIpc: {
  loadFile: (path: string) => Promise<{ success: boolean; content?: string }>;
  saveFile: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
};

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Ouvre `path` : tampon propre, façade montée sur son texte. */
function openOn(path: string | null, text: string, over: { isDirty?: boolean; live?: string } = {}): void {
  live = over.live ?? text;
  useEditorStore.setState({
    filePath: path,
    content: text,
    isDirty: over.isDirty ?? false,
    lastSavedAt: null,
    switchLock: null,
    editorFacade: {
      getValue: () => live,
      setValue,
    } as unknown as EditorFacade,
  });
}

const store = () => useEditorStore.getState();
const refuseConfirm = () => useDialogStore.getState().resolveConfirm(false);
const acceptConfirm = () => useDialogStore.getState().resolveConfirm(true);
const confirmMessage = () => useDialogStore.getState().confirmMessage;
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  disk = { [A]: '# A\n', [B]: '# B\n', [C]: '# C\n' };
  writes = [];
  reads = [];
  beforeRead = () => undefined;
  beforeWrite = () => undefined;
  setValue = vi.fn();
  editorIpc = {
    loadFile: async (path) => {
      reads.push(path);
      await beforeRead(path);
      return { success: true, content: disk[path] };
    },
    saveFile: async (path, content) => {
      const verdict = await beforeWrite(path);
      if (verdict) return verdict;
      writes.push([path, content]);
      disk[path] = content;
      return { success: true };
    },
  };
  (window as unknown as { electron: unknown }).electron = {
    editor: {
      loadFile: (path: string) => editorIpc.loadFile(path),
      saveFile: (path: string, content: string) => editorIpc.saveFile(path, content),
    },
  };
});

afterEach(() => {
  useEditorStore.setState({ switchLock: null, editorFacade: null, bufferDetached: false } as never);
  while (useDialogStore.getState().confirmOpen) refuseConfirm();
});

describe('rouvrir le fichier déjà ouvert', () => {
  it('tampon modifié : rien n’est écrit ni relu, et le texte vivant reste', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    const version = store().documentVersion;

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'unchanged' });
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
    expect(store().documentVersion).toBe(version);
    expect(store().isDirty).toBe(true);
    expect(store().getLiveContent()).toBe('# A\nfrappe\n');
  });

  it('la frappe que la synchro n’a pas encore poussée compte aussi', async () => {
    openOn(A, '# A\n', { isDirty: false, live: '# A\nfrappe\n' });
    const version = store().documentVersion;

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'unchanged' });
    expect(store().documentVersion).toBe(version);
    expect(store().content).toBe('# A\n');
  });

  it('tampon propre, disque identique : la vue et son annulation ne bougent pas', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'unchanged' });
    expect(store().documentVersion).toBe(version);
  });

  it('tampon propre, disque changé dehors : le document reprend le disque', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    disk[A] = '# A modifié dehors\n';

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'replaced' });
    expect(store().content).toBe('# A modifié dehors\n');
    expect(store().documentVersion).toBe(version + 1);
  });

  it('frappe pendant la relecture : le disque n’écrase pas ce qui vient d’être tapé', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    disk[A] = '# A modifié dehors\n';
    beforeRead = () => {
      live = '# A\nfrappe\n';
    };

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'unchanged' });
    expect(store().documentVersion).toBe(version);
  });

  it('frappe puis enregistrement pendant la relecture : le texte lu avant l’écriture ne revient pas', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    // Le texte est lu au départ de la lecture, qui répond après l'écriture.
    const reading = deferred();
    editorIpc.loadFile = async (path) => {
      const text = disk[path];
      await reading.promise;
      return { success: true, content: text };
    };

    const reopening = store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');
    await flushMicrotasks();
    live = '# A\nphrase\n';
    await store().saveFile();
    reading.release();

    expect(await reopening).toEqual({ status: 'unchanged' });
    expect(store().documentVersion).toBe(version);
    expect(store().content).toBe('# A\nphrase\n');
    expect(disk[A]).toBe('# A\nphrase\n');
  });
});

describe('document sans titre : le fichier sortant', () => {
  it('est écrit, texte vivant compris, avant que le chemin disparaisse', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    let pathDuringWrite: string | null = 'pas écrit';
    beforeWrite = () => {
      pathDuringWrite = store().filePath;
    };

    const outcome = await store().replaceBuffer({ kind: 'untitled' }, 'new-document');

    expect(outcome).toEqual({ status: 'replaced' });
    expect(pathDuringWrite).toBe(A);
    expect(disk[A]).toBe('# A\nfrappe\n');
    expect(store().filePath).toBeNull();
    expect(store().content).toBe('');
    expect(store().isDirty).toBe(false);
  });

  it('écriture refusée : rejet, et le chemin comme le texte restent', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    beforeWrite = () => ({ success: false as const, error: 'disque plein' });

    await expect(store().createNewFile()).rejects.toThrow('disque plein');

    expect(store().filePath).toBe(A);
    expect(store().getLiveContent()).toBe('# A\nfrappe\n');
    expect(disk[A]).toBe('# A\n');
  });

  it('ne passe plus par la façade : le cache du sortant garde son texte', async () => {
    openOn(A, '# A\n');

    await store().createNewFile();

    expect(setValue).not.toHaveBeenCalled();
    expect(store().filePath).toBeNull();
  });

  it('discardOutgoing : rien n’est écrit, l’auteur a déjà tranché', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });

    const outcome = await store().replaceBuffer(
      { kind: 'untitled', discardOutgoing: true },
      'project-close'
    );

    expect(outcome).toEqual({ status: 'replaced' });
    expect(writes).toEqual([]);
    expect(store().filePath).toBeNull();
  });
});

describe('tampon sans titre non vide', () => {
  it('ouvrir un fichier demande confirmation ; un refus laisse tout en place', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page entière.' });
    const version = store().documentVersion;

    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    expect(confirmMessage()).toBe(i18n.t('editor.discardUntitledConfirm'));
    refuseConfirm();

    expect(await opening).toEqual({ status: 'cancelled' });
    expect(store().filePath).toBeNull();
    expect(store().getLiveContent()).toBe('Une page entière.');
    expect(store().documentVersion).toBe(version);
    expect(reads).toEqual([]);
  });

  it('un nouveau tampon sans titre demande aussi confirmation', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page entière.' });
    const version = store().documentVersion;

    const creating = store().createNewFile();
    await flushMicrotasks();
    expect(confirmMessage()).toBe(i18n.t('editor.discardUntitledConfirm'));
    refuseConfirm();

    expect(await creating).toEqual({ status: 'cancelled' });
    expect(store().documentVersion).toBe(version);
  });

  it('accepter abandonne le tampon et ouvre le fichier', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page entière.' });

    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    acceptConfirm();

    expect(await opening).toEqual({ status: 'replaced' });
    expect(store().filePath).toBe(B);
    expect(store().content).toBe('# B\n');
    expect(writes).toEqual([]);
  });

  it('un tampon vide ne pose aucune question', async () => {
    openOn(null, '');

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');

    expect(outcome).toEqual({ status: 'replaced' });
    expect(useDialogStore.getState().confirmOpen).toBe(false);
  });
});

describe('frappes pendant la bascule', () => {
  it('pendant l’écriture du sortant : seconde écriture avant de changer de document', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nun\n' });
    // Le texte est lu au départ de l'écriture : la frappe tombe pendant qu'elle dure.
    let pass = 0;
    const write = editorIpc.saveFile;
    editorIpc.saveFile = async (path, content) => {
      const result = await write(path, content);
      pass += 1;
      if (pass === 1) live = '# A\nun\ndeux\n';
      return result;
    };

    // Avant de lire le suivant : si sa lecture échoue, la frappe est déjà à l'abri.
    let writesBeforeRead = -1;
    beforeRead = () => {
      writesBeforeRead = writes.length;
    };

    await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');

    expect(disk[A]).toBe('# A\nun\ndeux\n');
    expect(writes.map(([path]) => path)).toEqual([A, A]);
    expect(writesBeforeRead).toBe(2);
    expect(store().filePath).toBe(B);
    expect(store().content).toBe('# B\n');
  });

  it('pendant la lecture du fichier entrant : réécrit le sortant, puis bascule', async () => {
    openOn(A, '# A\n');
    beforeRead = (path) => {
      if (path === B) live = '# A\nfrappe\n';
    };

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');

    expect(outcome).toEqual({ status: 'replaced' });
    expect(disk[A]).toBe('# A\nfrappe\n');
    expect(store().filePath).toBe(B);
  });

  it('frappe sans fin : la boucle s’arrête, et le document reste celui de l’auteur', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\n0\n' });
    let pass = 0;
    const write = editorIpc.saveFile;
    editorIpc.saveFile = async (path, content) => {
      const result = await write(path, content);
      pass += 1;
      live = `# A\n${pass}\n`;
      return result;
    };

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');

    expect(outcome).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(A);
    expect(pass).toBeLessThanOrEqual(6);
  });
});

describe('demandes concurrentes', () => {
  it('le dernier gagne, quel que soit l’ordre d’arrivée des lectures', async () => {
    openOn(A, '# A\n');
    const slowB = deferred();
    beforeRead = (path) => (path === B ? slowB.promise : undefined);

    const first = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    const second = store().replaceBuffer({ kind: 'open', filePath: C }, 'open-file');

    expect(await second).toEqual({ status: 'replaced' });
    slowB.release();
    expect(await first).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(C);
    expect(store().content).toBe('# C\n');
  });

  it('revenir au fichier ouvert annule la bascule en cours', async () => {
    openOn(A, '# A\n');
    const slowB = deferred();
    beforeRead = (path) => (path === B ? slowB.promise : undefined);

    const first = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    expect(await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file')).toEqual({
      status: 'unchanged',
    });
    slowB.release();

    expect(await first).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(A);
  });

  it('relecture chassée par une ouverture plus récente : elle ne ramène pas son fichier', async () => {
    openOn(A, '# A\n');
    disk[A] = '# A modifié dehors\n';
    const reading = deferred();
    beforeRead = (path) => (path === A ? reading.promise : undefined);

    const reopening = store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');
    await flushMicrotasks();
    const opening = await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    reading.release();

    expect(opening).toEqual({ status: 'replaced' });
    expect(await reopening).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(B);
    expect(store().content).toBe('# B\n');
  });
});

describe('le verrou de bascule (renumérotation en cours)', () => {
  const lock = () => store().setSwitchLock(LOCK);
  const LOCKED = { status: 'locked', lock: LOCK };

  it.each([
    ['open', { kind: 'open', filePath: B }],
    ['untitled', { kind: 'untitled' }],
    ['detach', { kind: 'detach' }],
  ] as const)('%s en tête : refusé, sans rien écrire, lire ni demander', async (_name, target) => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    const version = store().documentVersion;
    lock();

    const outcome = await store().replaceBuffer(target, 'open-file');

    expect(outcome).toEqual(LOCKED);
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
    expect(store().filePath).toBe(A);
    expect(store().documentVersion).toBe(version);
    expect(store().getLiveContent()).toBe('# A\nfrappe\n');
  });

  it('un tampon sans titre verrouillé ne pose pas de question inutile', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    lock();

    expect(await store().createNewFile()).toEqual(LOCKED);
    expect(useDialogStore.getState().confirmOpen).toBe(false);
  });

  it('rouvrir le fichier ouvert n’est pas une bascule : ni refus ni relecture', async () => {
    openOn(A, '# A\n');
    disk[A] = '# A renuméroté\n';
    const version = store().documentVersion;
    lock();

    const outcome = await store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');

    expect(outcome).toEqual({ status: 'unchanged' });
    expect(reads).toEqual([]);
    expect(store().documentVersion).toBe(version);
  });

  it.each([
    ['open', { kind: 'open', filePath: B }],
    ['untitled', { kind: 'untitled' }],
    ['detach', { kind: 'detach' }],
  ] as const)('%s à l’arrivée : le sortant est écrit, le document ne change pas', async (_n, target) => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    const version = store().documentVersion;
    const writing = deferred();
    beforeWrite = () => writing.promise;

    const switching = store().replaceBuffer(target, 'open-file');
    await flushMicrotasks();
    lock();
    // L'opération protégée change le tampon : la bascule refusée n'a plus à l'écrire.
    live = '# A\nrenuméroté\n';
    writing.release();

    expect(await switching).toEqual(LOCKED);
    expect(writes).toEqual([[A, '# A\nfrappe\n']]);
    expect(reads).toEqual([]);
    expect(store().filePath).toBe(A);
    expect(store().documentVersion).toBe(version);
  });

  it('open dont la lecture était en cours : refusé à son arrivée', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    const reading = deferred();
    beforeRead = () => reading.promise;

    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    lock();
    reading.release();

    expect(await opening).toEqual(LOCKED);
    expect(store().filePath).toBe(A);
    expect(store().documentVersion).toBe(version);
  });

  it('relecture du fichier ouvert, verrou posé pendant, disque changé : rien ne bouge', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    disk[A] = '# A renuméroté\n';
    const reading = deferred();
    beforeRead = () => reading.promise;

    const reopening = store().replaceBuffer({ kind: 'open', filePath: A }, 'open-file');
    await flushMicrotasks();
    lock();
    reading.release();

    expect(await reopening).toEqual({ status: 'unchanged' });
    expect(store().content).toBe('# A\n');
    expect(store().documentVersion).toBe(version);
  });

  it('verrou posé pendant la seconde écriture du sortant : refusé à son arrivée', async () => {
    openOn(A, '# A\n');
    const version = store().documentVersion;
    // Le premier passage n'a rien à écrire : la frappe tombe pendant la lecture de B.
    beforeRead = (path) => {
      if (path === B) live = '# A\nfrappe\n';
    };
    const writing = deferred();
    beforeWrite = () => writing.promise;

    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    lock();
    writing.release();

    expect(await opening).toEqual(LOCKED);
    expect(writes).toEqual([[A, '# A\nfrappe\n']]);
    expect(store().filePath).toBe(A);
    expect(store().documentVersion).toBe(version);
  });

  it('une lecture qui survit à toute l’opération n’aboutit pas avec son texte périmé', async () => {
    openOn(A, '# A\n');
    const reading = deferred();
    beforeRead = () => reading.promise;

    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    lock();
    disk[B] = '# B renuméroté\n';
    store().setSwitchLock(null);
    reading.release();

    expect(await opening).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(A);
  });

  it('repart une fois le verrou levé', async () => {
    openOn(A, '# A\n');
    lock();
    store().setSwitchLock(null);

    expect(await store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file')).toEqual({
      status: 'replaced',
    });
    expect(store().filePath).toBe(B);
  });
});

describe('saveFileAs : le chemin change, le document reste', () => {
  const NEW_PATH = '/ailleurs/nouveau.md';

  it('garde la version : la vue n’a aucune raison de se recréer', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    const version = store().documentVersion;

    const outcome = await store().saveFileAs(NEW_PATH);

    expect(outcome).toEqual({ status: 'saved' });
    expect(store().filePath).toBe(NEW_PATH);
    expect(store().content).toBe('Une page.');
    expect(store().isDirty).toBe(false);
    expect(store().documentVersion).toBe(version);
    expect(disk[NEW_PATH]).toBe('Une page.');
  });

  it('verrou posé : rien n’est écrit et le tampon reste sans chemin', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    store().setSwitchLock(LOCK);

    const outcome = await store().saveFileAs(NEW_PATH);

    expect(outcome).toEqual({ status: 'locked', lock: LOCK });
    expect(writes).toEqual([]);
    expect(store().filePath).toBeNull();
  });

  it('verrou posé pendant l’écriture : le tampon reste sans chemin', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    const writing = deferred();
    beforeWrite = () => writing.promise;

    const saving = store().saveFileAs(NEW_PATH);
    await flushMicrotasks();
    store().setSwitchLock(LOCK);
    writing.release();

    expect(await saving).toEqual({ status: 'locked', lock: LOCK });
    expect(store().filePath).toBeNull();
    expect(store().getLiveContent()).toBe('Une page.');
  });

  it('document remplacé pendant l’écriture : son texte n’entre pas dans le miroir du suivant', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    const writing = deferred();
    beforeWrite = (path) => (path === NEW_PATH ? writing.promise : undefined);

    const saving = store().saveFileAs(NEW_PATH);
    await flushMicrotasks();
    // L'auteur a déjà confirmé l'abandon : le tampon est remplacé par B.
    const opening = store().replaceBuffer({ kind: 'open', filePath: B }, 'open-file');
    await flushMicrotasks();
    acceptConfirm();
    await opening;
    live = '# B\n';
    writing.release();

    expect(await saving).toEqual({ status: 'superseded' });
    expect(store().filePath).toBe(B);
    expect(store().content).toBe('# B\n');
  });

  it('frappe pendant l’écriture : le tampon reste marqué modifié, l’autosave la prendra', async () => {
    openOn(null, '', { isDirty: true, live: 'Une page.' });
    beforeWrite = () => {
      live = 'Une page. Et une autre.';
    };

    await store().saveFileAs(NEW_PATH);

    expect(disk[NEW_PATH]).toBe('Une page.');
    expect(store().isDirty).toBe(true);
    expect(store().filePath).toBe(NEW_PATH);
  });
});

describe('detach : hors de tout document, le temps d’un changement de projet', () => {
  it('écrit le sortant, rend son chemin et pose l’état détaché', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    const version = store().documentVersion;

    const outcome = await store().replaceBuffer({ kind: 'detach' }, 'project-switch');

    expect(outcome).toEqual({ status: 'replaced', detachedFrom: A });
    expect(disk[A]).toBe('# A\nfrappe\n');
    expect(store().filePath).toBeNull();
    expect(store().content).toBe('');
    expect(store().bufferDetached).toBe(true);
    expect(store().documentVersion).toBe(version + 1);
  });

  it('écriture refusée : rejet, on reste sur le document', async () => {
    openOn(A, '# A\n', { isDirty: true, live: '# A\nfrappe\n' });
    beforeWrite = () => ({ success: false as const, error: 'refusé' });

    await expect(
      store().replaceBuffer({ kind: 'detach' }, 'project-switch')
    ).rejects.toThrow('refusé');

    expect(store().filePath).toBe(A);
    expect(store().bufferDetached).toBe(false);
  });

  it('le remplacement suivant lève l’état détaché, sans question', async () => {
    openOn(A, '# A\n');
    await store().replaceBuffer({ kind: 'detach' }, 'project-switch');
    useEditorStore.setState({ editorFacade: null });

    await store().replaceBuffer({ kind: 'open', filePath: B }, 'project-open');

    expect(store().bufferDetached).toBe(false);
    expect(store().filePath).toBe(B);
    expect(useDialogStore.getState().confirmOpen).toBe(false);
  });
});
