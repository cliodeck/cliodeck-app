/**
 * Le pont preload expose ~184 canaux IPC, dont la lecture et l'écriture de
 * fichiers. Si la fenêtre principale navigue hors de l'application, le
 * preload est réinjecté dans le document distant et la page de l'attaquant
 * en hérite. `setWindowOpenHandler` ne couvrait que `window.open`.
 */
import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { attachNavigationGuard, classifyNavigation } from '../navigation-guard.js';

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
