// @vitest-environment jsdom
/**
 * Régression : 18 modales sur 20 n'écoutaient pas Échap, alors que ce hook
 * existait et n'était branché que sur ConfirmDialog et AlertDialog.
 *
 * Le hook exigeait que sa ref soit attachée à un conteneur AVANT de traiter
 * la moindre touche. Une modale qui l'appelait sans câbler la ref restait
 * donc insensible à Échap, sans le moindre signe. Échap est désormais
 * indépendant de la ref ; seul le piégeage du Tab en dépend.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { useCallback, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { isModalOpen, useFocusTrap } from '../useFocusTrap';

afterEach(() => cleanup());

/** Modale qui n'attache PAS la ref — le cas des 18 modales branchées. */
function SansRef({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  useFocusTrap({ active, onEscape });
  return <div>modale</div>;
}

/** Modale qui attache la ref — piégeage du Tab en plus. */
function AvecRef({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  const ref = useFocusTrap({ active, onEscape });
  return (
    <div ref={ref}>
      <button>premier</button>
      <button>dernier</button>
    </div>
  );
}

describe('useFocusTrap — Échap', () => {
  it('ferme même quand la ref n’est pas attachée', () => {
    const onEscape = vi.fn();
    render(<SansRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ferme aussi quand la ref est attachée', () => {
    const onEscape = vi.fn();
    render(<AvecRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ne fait rien quand la modale est fermée', () => {
    const onEscape = vi.fn();
    render(<SansRef active={false} onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('ignore les autres touches', () => {
    const onEscape = vi.fn();
    render(<SansRef active onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cesse d’écouter après démontage', () => {
    const onEscape = vi.fn();
    const { unmount } = render(<SansRef active onEscape={onEscape} />);
    unmount();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('useFocusTrap — isModalOpen', () => {
  it('vrai tant qu’un piège est actif avec son conteneur, faux après sa fermeture', () => {
    const { rerender } = render(<AvecRef active onEscape={vi.fn()} />);
    expect(isModalOpen()).toBe(true);

    rerender(<AvecRef active={false} onEscape={vi.fn()} />);
    expect(isModalOpen()).toBe(false);
  });

  it('faux après le démontage', () => {
    const { unmount } = render(<AvecRef active onEscape={vi.fn()} />);
    unmount();

    expect(isModalOpen()).toBe(false);
  });

  it('faux pour un piège inactif, même monté', () => {
    render(<AvecRef active={false} onEscape={vi.fn()} />);

    expect(isModalOpen()).toBe(false);
  });

  it('faux pour un panneau sans conteneur, qui ne prend qu’Échap', () => {
    render(<SansRef active onEscape={vi.fn()} />);

    expect(isModalOpen()).toBe(false);
  });

  it('deux modales : la fermeture de l’une laisse l’autre compter', () => {
    const first = render(<AvecRef active onEscape={vi.fn()} />);
    const second = render(<AvecRef active onEscape={vi.fn()} />);

    first.unmount();
    expect(isModalOpen()).toBe(true);

    second.unmount();
    expect(isModalOpen()).toBe(false);
  });
});

describe('useFocusTrap — la pile', () => {
  /** Une modale nommée : ses deux boutons disent à qui ils appartiennent. */
  function Modale({
    name,
    active = true,
    onEscape,
    restoreFocus,
    aboveModals,
    children,
  }: {
    name: string;
    active?: boolean;
    onEscape?: () => void;
    restoreFocus?: boolean;
    aboveModals?: boolean;
    children?: ReactNode;
  }) {
    const ref = useFocusTrap({ active, onEscape, restoreFocus, aboveModals });
    return (
      <div ref={ref} data-testid={name}>
        <button>{`${name}-premier`}</button>
        <button>{`${name}-dernier`}</button>
        {children}
      </div>
    );
  }

  /** Un panneau qui ne prend qu'Échap, sans conteneur : `ManuscriptSearch`. */
  function Panneau({ onEscape }: { onEscape: () => void }) {
    useFocusTrap({ active: true, onEscape, restoreFocus: false });
    return <input aria-label="panneau" />;
  }

  const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' });
  const pressTab = (shiftKey = false) => fireEvent.keyDown(document, { key: 'Tab', shiftKey });

  describe('Échap', () => {
    it('deux pièges actifs : seul le dernier répond', () => {
      const dessous = vi.fn();
      const dessus = vi.fn();
      render(
        <>
          <Modale name="dessous" onEscape={dessous} />
          <Modale name="dessus" onEscape={dessus} />
        </>
      );

      pressEscape();

      expect(dessus).toHaveBeenCalledTimes(1);
      expect(dessous).not.toHaveBeenCalled();
    });

    it('le dernier démonté, le suivant répond', () => {
      const dessous = vi.fn();
      const dessus = vi.fn();
      const { rerender } = render(
        <>
          <Modale name="dessous" onEscape={dessous} />
          <Modale name="dessus" onEscape={dessus} />
        </>
      );

      rerender(<Modale name="dessous" onEscape={dessous} />);
      pressEscape();

      expect(dessous).toHaveBeenCalledTimes(1);
      expect(dessus).not.toHaveBeenCalled();
    });

    it('un sommet sans onEscape garde la touche : celui du dessous ne se ferme pas', () => {
      const dessous = vi.fn();
      render(
        <>
          <Modale name="dessous" onEscape={dessous} />
          <Modale name="dessus" />
        </>
      );

      pressEscape();

      expect(dessous).not.toHaveBeenCalled();
    });

    it('activés dans le même commit, l’enfant est au-dessus de son parent', () => {
      // Les effets enfants passent avant les parents : empilés dans cet ordre,
      // le parent se retrouverait au sommet et Échap le fermerait lui.
      const parent = vi.fn();
      const enfant = vi.fn();
      render(
        <Modale name="parent" onEscape={parent}>
          <Modale name="enfant" onEscape={enfant} />
        </Modale>
      );

      pressEscape();

      expect(enfant).toHaveBeenCalledTimes(1);
      expect(parent).not.toHaveBeenCalled();
    });

    it('un piège inactif ne garde pas sa place : réactivé, il passe au sommet', () => {
      const premier = vi.fn();
      const second = vi.fn();
      const scene = (actif: boolean) => (
        <>
          <Modale name="premier" active={actif} onEscape={premier} />
          <Modale name="second" onEscape={second} />
        </>
      );
      const { rerender } = render(scene(true));

      rerender(scene(false));
      pressEscape();
      expect(second).toHaveBeenCalledTimes(1);
      expect(premier).not.toHaveBeenCalled();

      rerender(scene(true));
      pressEscape();
      expect(premier).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('un onEscape fraîchement changé ne fait perdre sa place à aucun des deux', () => {
      const scene = (dessous: () => void, dessus: () => void) => (
        <>
          <Modale name="dessous" onEscape={dessous} />
          <Modale name="dessus" onEscape={dessus} />
        </>
      );
      const dessous = vi.fn();
      const dessus = vi.fn();
      const { rerender } = render(scene(vi.fn(), vi.fn()));

      // Le piège du dessous repose son écouteur : il passe APRÈS celui du dessus sur `document`.
      rerender(scene(dessous, dessus));
      pressEscape();

      expect(dessus).toHaveBeenCalledTimes(1);
      expect(dessous).not.toHaveBeenCalled();
    });

    it('l’écouteur du dessous passe après celui du sommet : le sommet fermé, il ne se croit pas au sommet', () => {
      // Une vraie frappe : entre deux écouteurs, le navigateur vide les microtâches, et React a
      // déjà démonté le piège qui vient de répondre. `fireEvent` ne laisse aucune microtâche
      // passer : `flushSync` fait ce travail au même moment.
      const reglages = vi.fn();
      function Scene({ onReglages }: { onReglages: () => void }) {
        const [question, setQuestion] = useState(true);
        // Stable, comme le dialogue : seul le piège des Réglages se réabonne, et son écouteur passe
        // après celui de la question. En ligne, les deux se réabonneraient et l'ordre ne bougerait pas.
        const answer = useCallback(() => flushSync(() => setQuestion(false)), []);
        return (
          <>
            <Modale name="reglages" onEscape={onReglages} />
            {question && <Modale name="question" onEscape={answer} />}
          </>
        );
      }
      const { rerender, queryByTestId } = render(<Scene onReglages={vi.fn()} />);
      // Comme `onClose` en ligne des Réglages, qui change à chaque rendu de MainLayout.
      rerender(<Scene onReglages={reglages} />);

      pressEscape();

      expect(queryByTestId('question')).toBeNull();
      expect(reglages).not.toHaveBeenCalled();

      pressEscape();
      expect(reglages).toHaveBeenCalledTimes(1);
    });

    it('Échap maintenu : la répétition du clavier ne ferme rien, ni le sommet ni le dessous', () => {
      const dessous = vi.fn();
      const dessus = vi.fn();
      render(
        <>
          <Modale name="dessous" onEscape={dessous} />
          <Modale name="dessus" onEscape={dessus} />
        </>
      );

      const event = fireEvent.keyDown(document, { key: 'Escape', repeat: true });

      expect(dessus).not.toHaveBeenCalled();
      expect(dessous).not.toHaveBeenCalled();
      // `fireEvent` rend faux quand `preventDefault` a été appelé : la touche ne part pas plus loin.
      expect(event).toBe(false);
    });

    it('Échap maintenu : la première frappe ferme le sommet, la suivante ne ferme pas le dessous', () => {
      const reglages = vi.fn();
      function Scene() {
        const [question, setQuestion] = useState(true);
        return (
          <>
            <Modale name="reglages" onEscape={reglages} />
            {question && <Modale name="question" onEscape={() => setQuestion(false)} />}
          </>
        );
      }
      const { queryByTestId } = render(<Scene />);

      pressEscape();
      expect(queryByTestId('question')).toBeNull();

      fireEvent.keyDown(document, { key: 'Escape', repeat: true });
      expect(reglages).not.toHaveBeenCalled();

      // La touche relâchée puis pressée de nouveau : un vrai second Échap.
      pressEscape();
      expect(reglages).toHaveBeenCalledTimes(1);
    });

    it('une modale ouverte après un dialogue reste dessous à l’écran : Échap va au dialogue', () => {
      const question = vi.fn();
      const apropos = vi.fn();
      const scene = (avecApropos: boolean) => (
        <>
          <Modale name="question" onEscape={question} aboveModals />
          {avecApropos && <Modale name="apropos" onEscape={apropos} />}
        </>
      );
      const { rerender } = render(scene(false));
      rerender(scene(true));

      pressEscape();

      expect(question).toHaveBeenCalledTimes(1);
      expect(apropos).not.toHaveBeenCalled();
    });

    it('un élément plus proche a déjà pris la touche : le piège ne ferme rien', () => {
      // La popup de note, le panneau de recherche et les propositions de CM6 appellent
      // `preventDefault` sur leur Échap, avant que l'événement n'atteigne `document`.
      const onEscape = vi.fn();
      const { getByLabelText } = render(
        <Modale name="modale" onEscape={onEscape}>
          <input
            aria-label="popup"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.preventDefault();
            }}
          />
        </Modale>
      );

      fireEvent.keyDown(getByLabelText('popup'), { key: 'Escape' });
      expect(onEscape).not.toHaveBeenCalled();

      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tab', () => {
    it('ne boucle que dans le sommet', () => {
      const { getByText } = render(
        <>
          <Modale name="dessous" onEscape={vi.fn()} />
          <Modale name="dessus" onEscape={vi.fn()} />
        </>
      );
      getByText('dessus-dernier').focus();

      pressTab();

      expect(document.activeElement).toBe(getByText('dessus-premier'));
    });

    it('le focus est resté dans la modale du dessous : Tab le ramène au sommet au lieu de le perdre', () => {
      // HelpModal, ou l'éditeur de recette, s'ouvrent sans prendre le focus : il reste sur leur
      // déclencheur, dans les Réglages. Le piège des Réglages ne répond plus : sans ce retour,
      // le navigateur le ferait sortir de la modale, vers la page derrière.
      const { getByText } = render(
        <>
          <Modale name="dessous" onEscape={vi.fn()} />
          <Modale name="dessus" onEscape={vi.fn()} />
        </>
      );
      getByText('dessous-dernier').focus();

      pressTab();
      expect(document.activeElement).toBe(getByText('dessus-premier'));

      getByText('dessous-premier').focus();
      pressTab(true);
      expect(document.activeElement).toBe(getByText('dessus-dernier'));
    });

    it('une modale ouverte après un dialogue ne lui prend pas Tab', () => {
      const scene = (avecApropos: boolean) => (
        <>
          <Modale name="question" onEscape={vi.fn()} aboveModals />
          {avecApropos && <Modale name="apropos" onEscape={vi.fn()} />}
        </>
      );
      const { rerender, getByText } = render(scene(false));
      rerender(scene(true));
      getByText('question-dernier').focus();

      pressTab();

      expect(document.activeElement).toBe(getByText('question-premier'));
    });

    it('un éditeur de texte riche compte parmi les éléments du piège : Tab y boucle au lieu d’en sortir', () => {
      // `.cm-content` de CodeMirror : un `contenteditable`, sans `tabindex`.
      const { getByLabelText, getByText } = render(
        <Modale name="recette" onEscape={vi.fn()}>
          <div aria-label="yaml" contentEditable suppressContentEditableWarning />
        </Modale>
      );
      const yaml = getByLabelText('yaml');
      yaml.focus();
      expect(document.activeElement).toBe(yaml);

      pressTab();
      expect(document.activeElement).toBe(getByText('recette-premier'));

      pressTab(true);
      expect(document.activeElement).toBe(yaml);
    });

    it('un panneau sans conteneur ouvert après une modale ne lui prend ni Tab ni Échap', () => {
      const modale = vi.fn();
      const panneau = vi.fn();
      const { getByText } = render(
        <>
          <Modale name="modale" onEscape={modale} />
          <Panneau onEscape={panneau} />
        </>
      );
      getByText('modale-dernier').focus();

      pressTab();
      expect(document.activeElement).toBe(getByText('modale-premier'));

      pressEscape();
      expect(modale).toHaveBeenCalledTimes(1);
      expect(panneau).not.toHaveBeenCalled();
    });

    it('un panneau seul garde Échap et laisse circuler Tab', () => {
      const panneau = vi.fn();
      const { getByLabelText } = render(<Panneau onEscape={panneau} />);
      getByLabelText('panneau').focus();

      const event = fireEvent.keyDown(document, { key: 'Tab' });

      // `fireEvent` rend faux quand `preventDefault` a été appelé : Tab reste au navigateur.
      expect(event).toBe(true);
      expect(document.activeElement).toBe(getByLabelText('panneau'));

      pressEscape();
      expect(panneau).toHaveBeenCalledTimes(1);
    });
  });

  describe('le retour du focus, sur deux niveaux', () => {
    function DeuxNiveaux() {
      const [question, setQuestion] = useState(false);
      return (
        <>
          <Modale name="reglages" onEscape={vi.fn()}>
            <button onClick={() => setQuestion(true)}>reinitialiser</button>
          </Modale>
          <Modale name="question" active={question} onEscape={() => setQuestion(false)} />
        </>
      );
    }

    it('Échap sur la question rend le focus au déclencheur, dans la modale du dessous', () => {
      const { getByText } = render(<DeuxNiveaux />);
      const declencheur = getByText('reinitialiser');
      declencheur.focus();

      fireEvent.click(declencheur);
      act(() => getByText('question-premier').focus());

      pressEscape();

      expect(document.activeElement).toBe(declencheur);
    });

    /** Un piège toujours actif, monté à la demande : l'éditeur de recette, le consentement cloud. */
    function Declencheur({ restoreFocus, auto }: { restoreFocus?: boolean; auto?: boolean }) {
      const [ouvert, setOuvert] = useState(false);
      return (
        <>
          <button onClick={() => setOuvert(true)}>ouvrir</button>
          {ouvert && (
            <Modale name="modale" onEscape={() => setOuvert(false)} restoreFocus={restoreFocus}>
              {auto && <input aria-label="champ" autoFocus />}
            </Modale>
          )}
        </>
      );
    }

    it('un piège démonté alors qu’il est actif rend le focus à son déclencheur', () => {
      const { getByText } = render(<Declencheur />);
      const declencheur = getByText('ouvrir');
      declencheur.focus();
      fireEvent.click(declencheur);
      act(() => getByText('modale-premier').focus());

      pressEscape();

      expect(document.activeElement).toBe(declencheur);
    });

    it('un champ en autoFocus : le focus revient au déclencheur, pas au corps de la page', () => {
      const { getByText, getByLabelText } = render(<Declencheur auto />);
      const declencheur = getByText('ouvrir');
      declencheur.focus();
      fireEvent.click(declencheur);
      expect(document.activeElement).toBe(getByLabelText('champ'));

      pressEscape();

      expect(document.activeElement).toBe(declencheur);
    });

    it('restoreFocus: false : démonté, il ne rend le focus à personne', () => {
      const { getByText } = render(<Declencheur restoreFocus={false} />);
      const declencheur = getByText('ouvrir');
      declencheur.focus();
      fireEvent.click(declencheur);
      act(() => getByText('modale-premier').focus());

      pressEscape();

      expect(document.activeElement).toBe(document.body);
    });

    it('deux pièges en relais dans le même commit : l’entrant retient le déclencheur, pas le bouton du sortant', () => {
      function Relais() {
        const [etape, setEtape] = useState<'aucune' | 'alerte' | 'question'>('aucune');
        return (
          <>
            <button onClick={() => setEtape('alerte')}>ouvrir</button>
            <Modale name="alerte" active={etape === 'alerte'} onEscape={() => setEtape('question')} />
            <Modale name="question" active={etape === 'question'} onEscape={() => setEtape('aucune')} />
          </>
        );
      }
      const { getByText } = render(<Relais />);
      const declencheur = getByText('ouvrir');
      declencheur.focus();
      fireEvent.click(declencheur);
      act(() => getByText('alerte-premier').focus());

      pressEscape(); // L'alerte cède la place à la question, dans le même commit.
      expect(document.activeElement).toBe(declencheur);
      act(() => getByText('question-premier').focus());

      pressEscape();
      expect(document.activeElement).toBe(declencheur);
    });
  });
});
