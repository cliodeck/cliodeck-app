// @vitest-environment jsdom
/**
 * Toute modale piège le focus, et la ref du hook est réellement posée.
 *
 * `useFocusTrap` existait depuis longtemps mais n'était branché que sur
 * deux dialogues. Pire, il avait un défaut qui décourageait son adoption :
 * il exigeait sa ref attachée avant de traiter la moindre touche, si bien
 * qu'une modale qui l'appelait sans câbler la ref restait insensible à
 * Échap — sans le moindre signe. Échap en est désormais indépendant ; le
 * piégeage du Tab, lui, a toujours besoin du conteneur.
 *
 * Ce test vérifie les deux moitiés : le comportement (le Tab boucle) et le
 * câblage (aucune modale n'appelle le hook sans poser sa ref).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { useFocusTrap } from '../hooks/useFocusTrap';

afterEach(() => cleanup());

const COMPONENTS = path.resolve(__dirname, '../components');

function modalFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : modalFiles(full);
    return e.name.endsWith('.tsx') ? [full] : [];
  });
}

function Modale({ onEscape }: { onEscape: () => void }) {
  const ref = useFocusTrap({ active: true, onEscape });
  return (
    <div ref={ref}>
      <button>premier</button>
      <button>milieu</button>
      <button>dernier</button>
    </div>
  );
}

describe('piège de focus', () => {
  it('renvoie du dernier élément au premier', () => {
    const { getByText } = render(<Modale onEscape={vi.fn()} />);
    const dernier = getByText('dernier');
    dernier.focus();
    expect(document.activeElement).toBe(dernier);

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(getByText('premier'));
  });

  it('renvoie du premier au dernier avec Maj+Tab', () => {
    const { getByText } = render(<Modale onEscape={vi.fn()} />);
    const premier = getByText('premier');
    premier.focus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(getByText('dernier'));
  });

  it('laisse circuler le Tab à l’intérieur', () => {
    const { getByText } = render(<Modale onEscape={vi.fn()} />);
    getByText('premier').focus();

    // Ni premier ni dernier : le hook n'intervient pas, le navigateur gère.
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(getByText('premier'));
  });
});

describe('câblage des modales', () => {
  it('aucune modale n’appelle le hook sans poser sa ref', () => {
    const offenders: string[] = [];
    for (const file of modalFiles(COMPONENTS)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('useFocusTrap(')) continue;
      // La ref rendue par le hook doit être attachée quelque part.
      const declared = src.match(/const\s+(\w+)\s*=\s*useFocusTrap\(/);
      if (!declared) {
        offenders.push(`${path.relative(COMPONENTS, file)} — ref non récupérée`);
        continue;
      }
      if (!src.includes(`ref={${declared[1]}}`)) {
        offenders.push(`${path.relative(COMPONENTS, file)} — ${declared[1]} jamais attachée`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('couvre bien un nombre plausible de modales', () => {
    const withHook = modalFiles(COMPONENTS).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('useFocusTrap(')
    );
    expect(withHook.length).toBeGreaterThanOrEqual(18);
  });
});
