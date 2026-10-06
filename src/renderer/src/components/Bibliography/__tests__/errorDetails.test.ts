/**
 * Le bilan d'une indexation groupée disait « 4 erreurs » sans dire lesquelles.
 */
import { describe, it, expect } from 'vitest';
import { withErrorDetails } from '../errorDetails';

describe('withErrorDetails', () => {
  it('rend le bilan tel quel quand tout a réussi', () => {
    expect(withErrorDetails('55 indexés, 0 erreurs', [])).toBe('55 indexés, 0 erreurs');
  });

  it('nomme chaque échec sous le bilan', () => {
    const message = withErrorDetails('53 indexés, 2 erreurs', ['Dupont 2020: fichier introuvable', 'Martin 2021: PDF illisible']);
    expect(message).toBe('53 indexés, 2 erreurs\n\n• Dupont 2020: fichier introuvable\n• Martin 2021: PDF illisible');
  });

  it('s’arrête à dix et compte le reste', () => {
    const errors = Array.from({ length: 13 }, (_, i) => `PDF ${i + 1}: erreur`);
    const message = withErrorDetails('bilan', errors);
    expect(message.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(10);
    expect(message.endsWith('… +3')).toBe(true);
  });
});
