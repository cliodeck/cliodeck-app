// @vitest-environment jsdom
/**
 * Le pourcentage d'une recommandation (S13-1-33).
 *
 * Il est la similarité de la recherche, sur l'échelle du cosinus, et non plus un score de rang
 * (« 100 % » pour la première carte reclassée). Avec le reclassement, l'ordre vient du modèle : une
 * carte à 31 % peut précéder une carte à 45 %. L'infobulle du pourcentage le dit.
 */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SimilarityCard } from '../SimilarityCard';

afterEach(cleanup);

it('affiche la similarité reçue, avec l’infobulle qui dit d’où viennent l’ordre et le pourcentage', () => {
  render(
    <SimilarityCard
      recommendation={{
        pdfId: 'doc-a',
        title: 'Les syndicats européens face à la CECA',
        authors: ['Spierenburg'],
        similarity: 0.31,
        chunkPreview: 'La Haute Autorité examine le dossier.',
        sourceType: 'secondary',
      }}
    />
  );

  expect(screen.getByText('31%').getAttribute('title')).toBe('similarity.scoreTooltip');
});
