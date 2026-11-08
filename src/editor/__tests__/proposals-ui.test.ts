// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { createDocState, readDocText } from '../cm/fidelity';
import { proposals } from '../proposals';

/**
 * Une proposition de l'IA se reconnaît au premier coup d'œil, boutons compris (BT1-1, C33 à C35).
 * Sur une longue réponse, les trois icônes sans libellé venaient après le texte, à mi-hauteur de
 * l'encart : sous le bas de l'écran. L'auteur voyait un texte déjà inséré, sans rien à accepter.
 */

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const LABELS = {
  heading: 'Proposition IA',
  accept: 'Accepter la proposition (Tab)',
  acceptShort: 'Accepter',
  reject: 'Rejeter la proposition (Échap)',
  rejectShort: 'Rejeter',
  modify: 'Modifier la proposition',
  modifyShort: 'Modifier',
  rejectionPrompt: 'pourquoi ?',
  apply: 'Appliquer',
  cancel: 'Annuler',
};

const LONG = Array.from({ length: 30 }, (_, i) => `Paragraphe ${i + 1} de la réponse.`).join('\n\n');

const views: EditorView[] = [];

function viewWithProposal(doc: string, at: number, proposed: string) {
  const instance = proposals({ onEvent: () => undefined, labels: LABELS });
  const view = new EditorView({
    state: createDocState(doc, [instance.extension]),
    parent: document.body,
  });
  views.push(view);
  const proposal = instance.inject(view, { range: { from: at, to: at }, proposed });
  const box = view.dom.querySelector<HTMLElement>('.cm-proposal-box');
  if (!box) throw new Error('Pas d’encart');
  return { view, instance, proposal, box };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('l’encart d’une proposition', () => {
  it('commence par la barre d’actions, nommée, dont chaque bouton porte un libellé visible', () => {
    const { box } = viewWithProposal('Un\n\nDeux\n', 2, LONG);

    const bar = box.firstElementChild;
    expect(bar?.textContent).toContain('Proposition IA');
    const buttons = [...(bar?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Accepter', 'Rejeter', 'Modifier']);
    // Le raccourci reste dit, au survol et aux lecteurs d'écran.
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Accepter la proposition (Tab)',
      'Rejeter la proposition (Échap)',
      'Modifier la proposition',
    ]);
    expect(buttons.map((b) => b.title)).toEqual(buttons.map((b) => b.getAttribute('aria-label')));
    // Le texte proposé suit la barre, entier.
    expect(box.lastElementChild?.textContent).toBe(LONG);
  });

  it('Accepter, dans la barre, fait entrer le texte ; Rejeter ne laisse rien', () => {
    const accepted = viewWithProposal('Un\n\nDeux\n', 2, 'X');
    const accept = accepted.box.firstElementChild?.querySelectorAll('button')[0];
    accept?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(readDocText(accepted.view.state)).toBe('UnX\n\nDeux\n');

    const rejected = viewWithProposal('Un\n\nDeux\n', 2, 'X');
    const reject = rejected.box.firstElementChild?.querySelectorAll('button')[1];
    reject?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(readDocText(rejected.view.state)).toBe('Un\n\nDeux\n');
    expect(rejected.view.dom.querySelector('.cm-proposal-box')).toBeNull();
  });

  it('Modifier garde la barre en tête : Appliquer et Annuler y sont, le champ suit', () => {
    const { view, proposal } = viewWithProposal('Un\n\nDeux\n', 2, LONG);
    const modify = view.dom.querySelector('.cm-proposal-box')?.firstElementChild?.querySelectorAll('button')[2];
    modify?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    const box = view.dom.querySelector<HTMLElement>(`.cm-proposal-box[data-proposal-id="${proposal.id}"]`);
    const bar = box?.firstElementChild;
    expect(bar?.textContent).toContain('Proposition IA');
    expect([...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim())).toEqual([
      'Appliquer',
      'Annuler',
    ]);
    expect(box?.querySelector('textarea')?.value).toBe(LONG);
  });

  it('se situe à sa barre : c’est elle que le défilement amène à l’écran, pas le bas de trente paragraphes', () => {
    const { view, box } = viewWithProposal('Un\n\nDeux\n', 2, LONG);
    const bar = box.firstElementChild as HTMLElement;
    const rect = (top: number, bottom: number, left: number, right: number) =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;
    // Une mise en page simulée : jsdom n'en a pas. L'encart descend très bas, la barre est en haut,
    // sur la ligne de l'auteur, comme le tampon que CodeMirror pose avant un widget.
    box.getBoundingClientRect = () => rect(100, 2100, 40, 640);
    box.getClientRects = () => [rect(100, 2100, 40, 640)] as unknown as DOMRectList;
    bar.getBoundingClientRect = () => rect(100, 124, 44, 420);
    for (const buffer of view.dom.querySelectorAll<HTMLElement>('.cm-widgetBuffer')) {
      buffer.getBoundingClientRect = () => rect(104, 120, 40, 40);
    }

    // La position que `scrollIntoView` vise : la barre, et non l'encart sur toute sa hauteur.
    const coords = view.coordsAtPos(2, 1);
    expect(coords?.top).toBe(100);
    expect(coords?.bottom).toBe(124);
    expect(coords?.left).toBe(44);
  });
});
