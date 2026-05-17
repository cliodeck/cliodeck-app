// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceCard } from '../SourceCard';
import type { ChatSource } from '../../../stores/chatStore';
import type { UnifiedSource } from '../../../../../../backend/types/chat-source';

describe('SourceCard', () => {
  it('renders a legacy ChatSource (PDF-centric)', () => {
    const src: ChatSource = {
      documentId: 'doc-1',
      documentTitle: 'Some Paper',
      author: 'Foch',
      year: '1914',
      pageNumber: 12,
      chunkContent: 'The excerpt body.',
      similarity: 0.87,
    };
    render(<SourceCard source={src} index={1} />);
    // Author (year) reference when both present.
    expect(screen.getByText('Foch (1914)')).toBeInTheDocument();
    expect(screen.getByText(/87%/)).toBeInTheDocument();
  });

  it('renders a UnifiedSource (vault kind, no page number)', () => {
    const src: UnifiedSource = {
      kind: 'vault',
      id: 'notes/foo.md',
      title: 'My Note',
      snippet: 'note body',
      score: 0.5,
      notePath: 'notes/foo.md',
    };
    render(<SourceCard source={src} index={2} />);
    expect(screen.getByText('My Note')).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    // No page number → no "page" label.
    expect(screen.queryByText(/page/i)).toBeNull();
  });

  it('normalises a BrainstormSource (structural) without throwing', () => {
    const src = {
      kind: 'bibliographie' as const,
      sourceType: 'secondary' as const,
      title: 'Brainstorm Paper',
      snippet: 'extracted snippet',
      similarity: 0.33,
      documentId: 'doc-x',
      pageNumber: 7,
    };
    render(<SourceCard source={src} index={3} />);
    expect(screen.getByText('Brainstorm Paper')).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
  });

  it('expands to show the excerpt when clicked', () => {
    const src: ChatSource = {
      documentId: 'd',
      documentTitle: 'T',
      pageNumber: 1,
      chunkContent: 'hidden body',
      similarity: 0.1,
    };
    const { container } = render(<SourceCard source={src} index={1} />);
    expect(container.querySelector('.source-content')).toBeNull();
    const header = container.querySelector('.source-header') as HTMLElement;
    fireEvent.click(header);
    expect(container.querySelector('.source-content')).not.toBeNull();
    expect(screen.getByText('hidden body')).toBeInTheDocument();
  });
});
