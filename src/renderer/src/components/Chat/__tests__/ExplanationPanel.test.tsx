// @vitest-environment jsdom
/**
 * ExplanationPanel — collapse/expand + renders search stats & timing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ExplanationPanel } from '../ExplanationPanel';
import type { RAGExplanation } from '../../../stores/chatStore';

const fixture: RAGExplanation = {
  search: {
    totalResults: 12,
    searchDurationMs: 87,
    cacheHit: true,
    sourceType: 'secondary',
    documents: [
      { title: 'Test doc', chunkCount: 3, similarity: 0.82 },
    ],
  },
  llm: {
    provider: 'openai',
    model: 'gpt-4o',
    contextWindow: 128000,
    temperature: 0.2,
    promptSize: 5100,
  },
  timing: {
    searchMs: 87,
    generationMs: 650,
    totalMs: 737,
  },
} as unknown as RAGExplanation;

describe('ExplanationPanel', () => {
  afterEach(() => cleanup());

  it('is collapsed by default and expands on toggle click', () => {
    render(<ExplanationPanel explanation={fixture} />);
    expect(screen.queryByTestId('explanation-content')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByTestId('explanation-content')).toBeInTheDocument();
  });

  it('renders search stats (totalResults, duration) and timing', () => {
    render(<ExplanationPanel explanation={fixture} />);
    fireEvent.click(screen.getByRole('button'));
    const content = screen.getByTestId('explanation-content');
    expect(content.textContent).toContain('12');
    expect(content.textContent).toContain('87ms');
    expect(content.textContent).toContain('650ms');
    expect(content.textContent).toContain('737ms');
    // Provider / model surfaced.
    expect(content.textContent).toContain('openai');
    expect(content.textContent).toContain('gpt-4o');
  });

  it('collapses back when toggled again', () => {
    render(<ExplanationPanel explanation={fixture} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByTestId('explanation-content')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('explanation-content')).not.toBeInTheDocument();
  });

  // Les explications persistées avant l'ajout de `corpora` / `contextChars`
  // (historiques anciens) gardent l'ancienne ligne « Type de sources ».
  it('sans corpora garde la ligne « Type de sources » et aucune ligne de contexte', () => {
    render(<ExplanationPanel explanation={fixture} />);
    fireEvent.click(screen.getByRole('button'));
    const content = screen.getByTestId('explanation-content');
    expect(content.textContent).toContain('Type de sources:');
    expect(content.textContent).toContain('Bibliographie (PDFs)');
    expect(screen.queryByTestId('explanation-corpora')).not.toBeInTheDocument();
    expect(screen.queryByTestId('explanation-context-chars')).not.toBeInTheDocument();
  });

  it('compte chaque corpus, marque ceux non interrogés et donne la part du manuscrit', () => {
    const withCorpora = {
      ...fixture,
      search: {
        ...fixture.search,
        corpora: [
          { source: 'secondary', attempted: true, ok: true, hitCount: 9, selectedCount: 5 },
          { source: 'primary', attempted: true, ok: true, hitCount: 2, selectedCount: 2 },
          { source: 'vault', attempted: false, ok: false, hitCount: 0, selectedCount: 0 },
          { source: 'manuscript', attempted: true, ok: true, hitCount: 7, selectedCount: 3 },
          { source: 'readingNotes', attempted: true, ok: true, hitCount: 0, selectedCount: 0 },
        ],
        contextChars: { total: 12_400, sources: 7_900, manuscript: 4_500, readingNotes: 0 },
      },
    } as unknown as RAGExplanation;
    render(<ExplanationPanel explanation={withCorpora} />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('explanation-corpus-secondary').textContent).toBe('Bibliographie 5');
    expect(screen.getByTestId('explanation-corpus-primary').textContent).toBe('Archives 2');
    expect(screen.getByTestId('explanation-corpus-vault').textContent).toBe(
      'Notes (vault) non interrogé'
    );
    expect(screen.getByTestId('explanation-corpus-manuscript').textContent).toBe('Manuscrit 3');
    // Un corpus à zéro reste listé : l'absence se lit, elle ne se devine pas.
    expect(screen.getByTestId('explanation-corpus-readingNotes').textContent).toBe(
      'Notes de lecture 0'
    );
    // L'ordre : les sources, puis le texte de l'auteur.
    expect(screen.getByTestId('explanation-corpora').textContent).toMatch(
      /Bibliographie 5 · Archives 2 · Notes \(vault\) non interrogé · Manuscrit 3 · Notes de lecture 0/
    );
    expect(screen.getByTestId('explanation-content').textContent).not.toContain('Type de sources');

    const context = screen.getByTestId('explanation-context-chars').textContent;
    expect(context).toContain('12.4k caractères');
    expect(context).toContain('dont manuscrit 4.5k (36 %)');
  });

  it('tait la part du manuscrit quand il ne pèse rien, et liste un corpus absent comme non interrogé', () => {
    const noManuscript = {
      ...fixture,
      search: {
        ...fixture.search,
        corpora: [{ source: 'secondary', attempted: true, ok: true, hitCount: 4, selectedCount: 4 }],
        contextChars: { total: 6_000, sources: 6_000, manuscript: 0, readingNotes: 0 },
      },
    } as unknown as RAGExplanation;
    render(<ExplanationPanel explanation={noManuscript} />);
    fireEvent.click(screen.getByRole('button'));
    const context = screen.getByTestId('explanation-context-chars').textContent;
    expect(context).toContain('6.0k caractères');
    expect(context).not.toContain('dont manuscrit');
    expect(screen.getByTestId('explanation-corpus-manuscript').textContent).toBe(
      'Manuscrit non interrogé'
    );
  });
});
