// @vitest-environment jsdom
/**
 * Un lien web s'ouvre sur un geste de l'historien, et sur rien d'autre (E1).
 *
 * Le garde de navigation du main ouvrait dans le navigateur toute navigation externe, faute de
 * savoir si elle venait d'un geste : une balise `<meta http-equiv="refresh">` suffisait. Le
 * preload, qui voit le DOM de la page, ouvre désormais lui-même le lien activé, par le canal
 * `shell:open-external` ; le garde refuse toute navigation externe.
 *
 * jsdom ne sait pas fabriquer un événement « de confiance » (`isTrusted` y est toujours faux) :
 * le geste réel est simulé par un objet qui porte `isTrusted: true`. Les vrais clics, et les
 * clics de script, sont rejoués dans l'app réelle par `e2e/journey-external-link.spec.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SimulatedElectron } from './helpers/simulated-bridge';

const sim = vi.hoisted(() => ({ current: null as SimulatedElectron | null }));

vi.mock('electron', async () => {
  const { createSimulatedElectron } = await import('./helpers/simulated-bridge');
  sim.current = createSimulatedElectron();
  return sim.current.module;
});

type Listener = (event: MouseEvent) => void;
const registered: Array<{ type: string; listener: Listener; capture: boolean }> = [];
let openActivatedLink: (event: MouseEvent, open: (url: string) => void) => void;

beforeAll(async () => {
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    registered.push({ type, listener: listener as Listener, capture });
    add(type, listener, options);
  }) as typeof window.addEventListener);
  ({ openActivatedLink } = await import('../index'));
});

afterEach(() => {
  document.body.innerHTML = '';
});

const invoke = () => vi.spyOn((sim.current as SimulatedElectron).module.ipcRenderer, 'invoke').mockClear();

function link(href: string, inner?: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  if (inner) a.innerHTML = inner;
  else a.textContent = 'un lien';
  document.body.append(a);
  return a;
}

/** Un geste réel : clic, Cmd+clic, Entrée sur un lien focalisé (qui produit un `click`), clic du milieu. */
function gesture(
  target: Element,
  init: { type?: 'click' | 'auxclick'; button?: number; detail?: number; trusted?: boolean } = {},
) {
  const preventDefault = vi.fn();
  const event = {
    type: init.type ?? 'click',
    button: init.button ?? 0,
    detail: init.detail ?? 1,
    isTrusted: init.trusted ?? true,
    target,
    preventDefault,
  } as unknown as MouseEvent;
  return { event, preventDefault };
}

describe('lien activé par l’historien', () => {
  it('un clic sur un lien web l’ouvre une fois, par l’URL résolue du lien, et la fenêtre ne navigue pas', () => {
    const open = vi.fn();
    const a = link('http://127.0.0.1:9/inventaire');
    const { event, preventDefault } = gesture(a);

    openActivatedLink(event, open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:9/inventaire');
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('un clic sur le texte en gras d’un lien ouvre le lien', () => {
    const open = vi.fn();
    const a = link('https://archives.example/fonds', '<strong>le fonds</strong>');
    const { event } = gesture(a.querySelector('strong') as Element);

    openActivatedLink(event, open);

    expect(open).toHaveBeenCalledWith('https://archives.example/fonds');
  });

  it('le clic du milieu ouvre le lien ; le clic droit, non', () => {
    const open = vi.fn();
    const a = link('https://archives.example/fonds');

    openActivatedLink(gesture(a, { type: 'auxclick', button: 1 }).event, open);
    const right = gesture(a, { type: 'auxclick', button: 2 });
    openActivatedLink(right.event, open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(right.preventDefault).not.toHaveBeenCalled();
  });

  it('mailto part vers la messagerie', () => {
    const open = vi.fn();
    openActivatedLink(gesture(link('mailto:archiviste@example.org')).event, open);
    expect(open).toHaveBeenCalledWith('mailto:archiviste@example.org');
  });

  it('le second clic d’un double-clic n’ouvre pas un second onglet, et la fenêtre ne navigue pas pour autant', () => {
    const open = vi.fn();
    const a = link('https://archives.example/fonds');

    openActivatedLink(gesture(a, { detail: 1 }).event, open);
    const second = gesture(a, { detail: 2 });
    openActivatedLink(second.event, open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('ce qui n’est pas un geste, ou pas un lien web', () => {
  it('un clic lancé par un script (`anchor.click()`) n’ouvre rien et laisse la navigation au garde, qui la refuse', () => {
    const open = vi.fn();
    const { event, preventDefault } = gesture(link('http://127.0.0.1:9/script'), { trusted: false });

    openActivatedLink(event, open);

    expect(open).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('un lien interne (ancre, fichier de l’application) n’est pas touché', () => {
    const open = vi.fn();
    for (const href of ['#main-content', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const { event, preventDefault } = gesture(link(href));
      openActivatedLink(event, open);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('un clic hors de tout lien n’est pas touché', () => {
    const open = vi.fn();
    const p = document.createElement('p');
    document.body.append(p);
    const { event, preventDefault } = gesture(p);

    openActivatedLink(event, open);

    expect(open).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('un lien dans un texte en cours d’édition place le curseur, il ne s’ouvre pas', () => {
    const open = vi.fn();
    const zone = document.createElement('div');
    zone.contentEditable = 'true';
    document.body.append(zone);
    const a = link('https://archives.example/fonds');
    zone.append(a);
    // jsdom ne calcule pas `isContentEditable` : on le pose comme le ferait le navigateur.
    Object.defineProperty(a, 'isContentEditable', { value: true });

    openActivatedLink(gesture(a).event, open);

    expect(open).not.toHaveBeenCalled();
  });
});

describe('branchement du preload', () => {
  it('écoute click et auxclick sur window, en capture : un composant de la page ne peut pas l’en priver', () => {
    const types = registered.filter((r) => r.capture).map((r) => r.type);
    expect(types).toContain('click');
    expect(types).toContain('auxclick');
  });

  it('le lien activé part par le canal shell:open-external, une fois', () => {
    const spy = invoke();
    const onClick = registered.find((r) => r.type === 'click' && r.capture);
    expect(onClick).toBeDefined();

    onClick?.listener(gesture(link('http://127.0.0.1:9/inventaire')).event);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('shell:open-external', 'http://127.0.0.1:9/inventaire');
  });

  it('un vrai clic de script, distribué dans jsdom, n’appelle pas le canal', () => {
    const spy = invoke();
    link('http://127.0.0.1:9/script').click();
    expect(spy).not.toHaveBeenCalled();
  });
});
