// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CitationAutocomplete, type CitationCandidate } from '../CitationAutocomplete';

const candidates: CitationCandidate[] = [
  { id: 'foucault1975', title: 'Surveiller et punir', author: 'Foucault, Michel', year: '1975' },
  { id: 'foucault1976', title: 'Histoire de la sexualité', author: 'Foucault, Michel', year: '1976' },
  { id: 'bourdieu1979', title: 'La Distinction', author: 'Bourdieu, Pierre', year: '1979' },
  { id: 'derrida1967', title: 'De la grammatologie', author: 'Derrida, Jacques', year: '1967' },
];

const renderAC = (props: Partial<React.ComponentProps<typeof CitationAutocomplete>> = {}) => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <CitationAutocomplete
      query=""
      candidates={candidates}
      position={{ top: 0, left: 0 }}
      onSelect={onSelect}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSelect, onClose };
};

describe('<CitationAutocomplete />', () => {
  afterEach(() => cleanup());

  it('renders candidates (max 8) with empty query', () => {
    renderAC({ query: '' });
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByText('@foucault1975')).toBeInTheDocument();
  });

  it('filters by prefix and orders prefix-matches first', () => {
    renderAC({ query: 'fouc' });
    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('@foucault1975');
  });

  it('filters on author substring', () => {
    renderAC({ query: 'bourd' });
    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('@bourdieu1979');
  });

  it('shows empty state when nothing matches', () => {
    renderAC({ query: 'zzzzz', emptyLabel: 'Rien' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Rien')).toBeInTheDocument();
  });

  it('Enter selects the active candidate', () => {
    const { onSelect } = renderAC({ query: '' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('foucault1975');
  });

  it('ArrowDown moves active then Enter selects next', () => {
    const { onSelect } = renderAC({ query: '' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('foucault1976');
  });

  it('Escape calls onClose', () => {
    const { onClose } = renderAC({ query: '' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('click selects candidate', () => {
    const { onSelect } = renderAC({ query: '' });
    fireEvent.click(screen.getByTestId('citation-option-bourdieu1979'));
    expect(onSelect).toHaveBeenCalledWith('bourdieu1979');
  });

  it('honours maxResults', () => {
    const many: CitationCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `k${i}`,
      title: `t${i}`,
      author: 'A',
      year: '2000',
    }));
    render(
      <CitationAutocomplete
        query=""
        candidates={many}
        position={{ top: 0, left: 0 }}
        onSelect={() => undefined}
        onClose={() => undefined}
        maxResults={5}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });
});
