/**
 * Le pont preload expose ~184 canaux IPC, dont la lecture et l'écriture de
 * fichiers. Si la fenêtre principale navigue hors de l'application, le
 * preload est réinjecté dans le document distant et la page de l'attaquant
 * en hérite. `setWindowOpenHandler` ne couvrait que `window.open`.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { attachNavigationGuard, classifyNavigation } from '../navigation-guard.js';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined),
  projectPath: null as string | null,
}));

vi.mock('electron', () => ({ shell: { openExternal: mocks.openExternal } }));

vi.mock('../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => mocks.projectPath },
}));

const DEV = 'http://localhost:5173';
const PROD = 'file:///Applications/ClioDeck.app/Contents/dist/renderer/index.html';

describe('classifyNavigation — application servie par Vite (dev)', () => {
  it('autorise la navigation interne', () => {
    expect(classifyNavigation('http://localhost:5173/', DEV)).toBe('allow');
    expect(classifyNavigation('http://localhost:5173/index.html', DEV)).toBe('allow');
  });

  it('refuse un autre port de la même machine', () => {
    // Un serveur local hostile reste un tiers.
    expect(classifyNavigation('http://localhost:9999/', DEV)).toBe('external');
  });

  it('envoie un lien web au navigateur du système', () => {
    expect(classifyNavigation('https://example.org/page', DEV)).toBe('external');
  });
});

describe('classifyNavigation — application empaquetée (file:)', () => {
  it('autorise le rechargement du document de l’application', () => {
    expect(classifyNavigation(PROD, PROD)).toBe('allow');
    expect(classifyNavigation(`${PROD}#/write`, PROD)).toBe('allow');
  });

  it('refuse un AUTRE fichier local', () => {
    // Le point clé : l'origine d'un `file:` est opaque, donc comparer les
    // origines aurait autorisé n'importe quel fichier de la machine.
    expect(classifyNavigation('file:///Users/x/.ssh/id_rsa', PROD)).toBe('block');
    expect(classifyNavigation('file:///etc/passwd', PROD)).toBe('block');
  });

  it('envoie un lien web au navigateur, jamais dans la fenêtre', () => {
    expect(classifyNavigation('https://attaquant.example/', PROD)).toBe('external');
    expect(classifyNavigation('http://attaquant.example/', PROD)).toBe('external');
  });
});

describe('classifyNavigation — protocoles hostiles', () => {
  it('refuse tout ce qui n’est ni l’application ni un lien web', () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,<script>fetch("//x")</script>',
      'vbscript:msgbox',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(classifyNavigation(target, PROD)).toBe('block');
    }
  });

  it('refuse une URL illisible plutôt que de la laisser passer', () => {
    expect(classifyNavigation('', PROD)).toBe('block');
    expect(classifyNavigation('pas une url', PROD)).toBe('block');
  });

  it('laisse passer mailto vers le client de messagerie', () => {
    expect(classifyNavigation('mailto:x@example.org', PROD)).toBe('external');
  });
});

describe('attachNavigationGuard — idempotence', () => {
  /** Faux WebContents qui compte les écouteurs posés. */
  function fakeContents() {
    const events: string[] = [];
    const contents = {
      on(event: string) {
        events.push(event);
        return contents;
      },
      setWindowOpenHandler() {
        events.push('window-open-handler');
      },
    };
    return { contents: contents as unknown as WebContents, events };
  }

  it('ne pose ses écouteurs qu’une fois par WebContents', () => {
    // Relevé en pilotant l'app : la fenêtre principale reçoit le garde
    // explicitement ET via le filet global `web-contents-created`. Les
    // écouteurs étaient donc posés deux fois, et un lien externe ouvrait
    // DEUX onglets dans le navigateur.
    const { contents, events } = fakeContents();

    attachNavigationGuard(contents, PROD);
    const afterFirst = events.length;
    expect(afterFirst).toBeGreaterThan(0);

    attachNavigationGuard(contents, PROD);
    expect(events).toHaveLength(afterFirst);
  });

  it('garde bien chaque WebContents distinct', () => {
    const a = fakeContents();
    const b = fakeContents();

    attachNavigationGuard(a.contents, PROD);
    attachNavigationGuard(b.contents, PROD);

    expect(b.events.length).toBe(a.events.length);
    expect(b.events.length).toBeGreaterThan(0);
  });
});

/**
 * Electron 45 ne dit pas si une navigation vient d'un geste. Le garde ouvrait donc dans le
 * navigateur toute navigation externe : une balise `<meta http-equiv="refresh">` présente dans la
 * page suffisait, sans aucun clic (mesuré par L08-1). Un lien que l'historien active passe
 * désormais par le preload ; une navigation externe qui arrive au garde n'a pas eu de geste.
 */
describe('attachNavigationGuard — une navigation externe n’est jamais ouverte', () => {
  const APP = PROD;
  let root: string;

  /** Faux WebContents qui émet les vrais noms d'événements, avec les arguments d'Electron 45. */
  function emitterContents() {
    const emitter = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => undefined });
    attachNavigationGuard(emitter as unknown as WebContents, APP);
    const event = (url: string, isMainFrame = true) => ({ url, isMainFrame, preventDefault: vi.fn() });
    return {
      /** `will-navigate` : frame principal (meta refresh, `location`, lien suivi). */
      navigate(url: string) {
        const ev = event(url);
        emitter.emit('will-navigate', ev, url, false, true);
        return ev;
      },
      /** `will-frame-navigate` : Electron l'émet pour TOUS les frames, principal compris. */
      frameNavigate(url: string, isMainFrame: boolean) {
        const ev = event(url, isMainFrame);
        emitter.emit('will-frame-navigate', ev);
        return ev;
      },
      redirect(url: string) {
        const ev = event(url);
        emitter.emit('will-redirect', ev, url, false, true);
        return ev;
      },
    };
  }

  /** Les refus inscrits au journal de sécurité du projet ouvert. */
  function journal(): Array<{ kind: string; url?: string; at?: string }> {
    let raw = '';
    try {
      raw = readFileSync(join(root, '.cliodeck', 'security-events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { kind: string; url?: string; at?: string });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliodeck-garde-'));
    mocks.projectPath = root;
    mocks.openExternal.mockClear();
  });

  afterEach(() => {
    mocks.projectPath = null;
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('une navigation du frame principal sans geste (meta refresh) est refusée et inscrite au journal', async () => {
    const guard = emitterContents();
    const ev = guard.navigate('http://127.0.0.1:9/refresh');

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0]).toMatchObject({ kind: 'external_navigation_blocked', url: 'http://127.0.0.1:9/refresh' });
    expect(typeof journal()[0].at).toBe('string');
  });

  it('la navigation d’un sous-frame (aperçu en iframe) suit la même règle', async () => {
    const guard = emitterContents();
    const ev = guard.frameNavigate('https://attaquant.example/cadre', false);

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0]).toMatchObject({ kind: 'external_navigation_blocked', url: 'https://attaquant.example/cadre' });
  });

  it('une redirection vers l’extérieur n’est jamais un geste', async () => {
    const guard = emitterContents();
    const ev = guard.redirect('https://attaquant.example/redirection');

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0]).toMatchObject({ kind: 'external_navigation_blocked', url: 'https://attaquant.example/redirection' });
  });

  it('même juste après un clic, une navigation externe n’ouvre rien : un clic passe par le preload, pas par la navigation', () => {
    // Le geste ne s'établit pas ici : une navigation qui suit un clic a pu être réécrite (lien
    // échangé entre le clic et la navigation, script qui suit le clic). Elle est refusée comme
    // les autres ; le lien cliqué, lui, a déjà été ouvert par le preload.
    const guard = emitterContents();
    guard.navigate('http://127.0.0.1:9/lien');
    guard.navigate('http://127.0.0.1:9/lien');

    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('une navigation du frame principal n’est traitée qu’une fois (will-navigate et will-frame-navigate)', async () => {
    // `will-frame-navigate` couvre aussi le frame principal : traitée deux fois, une navigation
    // ouvrait deux onglets ; refusée deux fois, elle ferait deux lignes au journal.
    const guard = emitterContents();
    guard.navigate('http://127.0.0.1:9/une-fois');
    const mainFrame = guard.frameNavigate('http://127.0.0.1:9/une-fois', true);
    expect(mainFrame.preventDefault).not.toHaveBeenCalled();

    // Témoin : quand il est au journal, une seconde ligne pour la première URL y serait aussi.
    guard.navigate('http://127.0.0.1:9/temoin');
    await vi.waitFor(() => expect(journal().map((e) => e.url)).toContain('http://127.0.0.1:9/temoin'));
    expect(journal().filter((e) => e.url === 'http://127.0.0.1:9/une-fois')).toHaveLength(1);
  });

  it('la navigation interne passe, sans rien inscrire', async () => {
    const guard = emitterContents();
    const ev = guard.navigate(`${APP}#/write`);

    expect(ev.preventDefault).not.toHaveBeenCalled();
    guard.navigate('http://127.0.0.1:9/temoin');
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0].url).toBe('http://127.0.0.1:9/temoin');
  });

  it('un autre protocole reste bloqué, comme avant', () => {
    const guard = emitterContents();
    const ev = guard.navigate('file:///etc/passwd');

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('sans projet ouvert, le refus va au journal du processus principal seulement', async () => {
    mocks.projectPath = null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const guard = emitterContents();
    const ev = guard.navigate('http://127.0.0.1:9/sans-projet');

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((args) => args.join(' ').includes('http://127.0.0.1:9/sans-projet'))).toBe(true);
    expect(journal()).toEqual([]);
  });
});

/**
 * Une nouvelle fenêtre (`window.open`, `target=_blank`) n'ouvre jamais rien (amendement après E1).
 * Le refus vivait dans `index.ts`, sur la seule fenêtre principale : tout autre `WebContents`
 * (fenêtre d'impression des présentations, webview) gardait le comportement par défaut d'Electron,
 * qui crée la fenêtre. Un lien que l'historien active est ouvert par le preload, avant toute
 * nouvelle fenêtre : ce qui arrive ici n'a pas eu de geste.
 */
describe('attachNavigationGuard — aucune nouvelle fenêtre, sur tout WebContents', () => {
  const APP = PROD;
  let root: string;

  type OpenHandler = (details: { url: string; disposition: string }) => { action: string };

  /** Faux WebContents qui garde le gestionnaire de nouvelle fenêtre que le garde lui pose. */
  function openerContents(): (url: string) => { action: string } {
    let handler: OpenHandler | null = null;
    const contents = {
      on: () => contents,
      setWindowOpenHandler: (h: OpenHandler) => {
        handler = h;
      },
    };
    attachNavigationGuard(contents as unknown as WebContents, APP);
    return (url) => {
      if (!handler) throw new Error('aucun gestionnaire de nouvelle fenêtre posé par le garde');
      return handler({ url, disposition: 'new-window' });
    };
  }

  function journal(): Array<{ kind: string; url?: string }> {
    let raw = '';
    try {
      raw = readFileSync(join(root, '.cliodeck', 'security-events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { kind: string; url?: string });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliodeck-garde-fenetre-'));
    mocks.projectPath = root;
    mocks.openExternal.mockClear();
  });

  afterEach(() => {
    mocks.projectPath = null;
    rmSync(root, { recursive: true, force: true });
  });

  it('window.open("https://…") sans geste : refusé, rien ne s’ouvre, et le refus est au journal de sécurité', async () => {
    const open = openerContents();

    expect(open('https://attaquant.example/onglet')).toEqual({ action: 'deny' });

    expect(mocks.openExternal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0]).toMatchObject({ kind: 'external_navigation_blocked', url: 'https://attaquant.example/onglet' });
  });

  it('une URL file: : refusée, rien ne s’ouvre, et rien au journal (comme une navigation bloquée)', async () => {
    const open = openerContents();

    expect(open('file:///etc/passwd')).toEqual({ action: 'deny' });

    expect(mocks.openExternal).not.toHaveBeenCalled();
    // Témoin : quand il est au journal, une ligne pour le fichier y serait aussi.
    open('https://temoin.example/');
    await vi.waitFor(() => expect(journal()).toHaveLength(1));
    expect(journal()[0].url).toBe('https://temoin.example/');
  });

  it('le document de l’application lui-même : refusé aussi, l’app n’a qu’une fenêtre', () => {
    const open = openerContents();

    expect(open(APP)).toEqual({ action: 'deny' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
