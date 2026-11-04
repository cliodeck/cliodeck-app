// @vitest-environment jsdom
/**
 * Vider le nombre de topics le ramenait à 10 sous les doigts (`parseInt('') || 10`) : on ne pouvait
 * pas l'effacer pour le retaper, et 1 ou 300 partaient tels quels à l'analyse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CorpusTopicsSection } from '../CorpusTopicsSection';

afterEach(cleanup);

function Section({ onCommit, onLoad }: { onCommit: (n: number) => void; onLoad: (n: number) => void }): React.JSX.Element {
  const [numTopics, setNumTopics] = useState(12);
  return (
    <CorpusTopicsSection
      topicAnalysis={null}
      topicTimeline={null}
      fullGraphData={null}
      loadingTopics={false}
      numTopics={numTopics}
      setNumTopics={(n) => {
        onCommit(n);
        setNumTopics(n);
      }}
      expandedTopic={null}
      setExpandedTopic={() => undefined}
      filters={{ year: null, author: null, language: null, topic: null }}
      setFilters={() => undefined}
      onLoadTopics={() => onLoad(numTopics)}
      onExportJSON={() => undefined}
      onExportCSV={() => undefined}
      onExportMarkdown={() => undefined}
      getDocumentsForTopic={() => []}
    />
  );
}

const field = () => screen.getByRole('spinbutton') as HTMLInputElement;

describe('le nombre de topics', () => {
  it('vidé : le champ reste vide pendant la saisie, et la dernière valeur revient au blur', () => {
    const onCommit = vi.fn();
    render(<Section onCommit={onCommit} onLoad={vi.fn()} />);

    fireEvent.change(field(), { target: { value: '' } });
    expect(field().value).toBe('');
    fireEvent.blur(field());

    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe('12');
  });

  it('hors bornes : borné à ce que l’analyse accepte, et l’auteur le voit', () => {
    const onCommit = vi.fn();
    render(<Section onCommit={onCommit} onLoad={vi.fn()} />);

    fireEvent.change(field(), { target: { value: '300' } });
    fireEvent.blur(field());

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(50);
    expect(field().value).toBe('50');
  });

  it('taper puis cliquer sur Analyser : l’analyse part avec la valeur tapée', () => {
    const onLoad = vi.fn();
    render(<Section onCommit={vi.fn()} onLoad={onLoad} />);

    fireEvent.change(field(), { target: { value: '7' } });
    fireEvent.blur(field());
    fireEvent.click(screen.getByText('corpus.analyzeTopics'));

    expect(onLoad).toHaveBeenCalledExactlyOnceWith(7);
  });
});
