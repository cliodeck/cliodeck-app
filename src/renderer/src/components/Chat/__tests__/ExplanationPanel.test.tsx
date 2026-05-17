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
});
