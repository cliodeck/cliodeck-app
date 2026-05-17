// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SourcePopover, positionLabel } from '../SourcePopover';
import type { BrainstormSource } from '../../../stores/chatStore';

type MockSourcesApi = {
  openPdf: ReturnType<typeof vi.fn>;
  revealTropy: ReturnType<typeof vi.fn>;
  openNote: ReturnType<typeof vi.fn>;
};

function installApi(): MockSourcesApi {
  const api: MockSourcesApi = {
    openPdf: vi.fn().mockResolvedValue({ success: true }),
    revealTropy: vi.fn().mockResolvedValue({ success: true }),
    openNote: vi.fn().mockResolvedValue({ success: true }),
  };
  (window as unknown as { electron: { sources: MockSourcesApi } }).electron = {
    sources: api,
  };
  return api;
}

const base: Omit<BrainstormSource, 'sourceType' | 'kind'> = {
  title: 'Papert 1980',
  snippet: 'Mindstorms snippet',
  similarity: 0.82,
};

describe('SourcePopover', () => {
  beforeEach(() => {
    (window as unknown as { electron: unknown }).electron = undefined;
  });
  afterEach(() => cleanup());

  it('positionLabel summarises per source type', () => {
    expect(
      positionLabel({
        ...base,
        kind: 'bibliographie',
        sourceType: 'secondary',
        pageNumber: 42,
        chunkOffset: 128,
      })
    ).toBe('page 42 · offset 128');
    expect(
      positionLabel({
        ...base,
        kind: 'note',
        sourceType: 'vault',
        notePath: 'topics/bloom.md',
        lineNumber: 12,
      })
    ).toBe('topics/bloom.md · L12');
    expect(
      positionLabel({ ...base, kind: 'archive', sourceType: 'primary', itemId: 'tropy-7' })
    ).toBe('item #tropy-7');
  });

  it('calls sources.openPdf with documentId+page for secondary sources', async () => {
    const api = installApi();
    render(
      <SourcePopover
        source={{
          ...base,
          kind: 'bibliographie',
          sourceType: 'secondary',
          documentId: 'doc-1',
          pageNumber: 7,
          chunkOffset: 4,
        }}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('source-popover-open'));
    await waitFor(() => expect(api.openPdf).toHaveBeenCalledWith('doc-1', 7));
    expect(api.revealTropy).not.toHaveBeenCalled();
    expect(api.openNote).not.toHaveBeenCalled();
  });

  it('calls sources.revealTropy with itemId for primary sources', async () => {
    const api = installApi();
    render(
      <SourcePopover
        source={{
          ...base,
          kind: 'archive',
          sourceType: 'primary',
          itemId: 'tropy-42',
        }}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('source-popover-open'));
    await waitFor(() => expect(api.revealTropy).toHaveBeenCalledWith('tropy-42'));
  });

  it('calls sources.openNote for vault sources (prefers notePath over relativePath)', async () => {
    const api = installApi();
    render(
      <SourcePopover
        source={{
          ...base,
          kind: 'note',
          sourceType: 'vault',
          notePath: 'a/b.md',
          relativePath: 'legacy.md',
          lineNumber: 3,
        }}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('source-popover-open'));
    await waitFor(() => expect(api.openNote).toHaveBeenCalledWith('a/b.md', 3));
  });

  it('surfaces a helpful error when traceability fields are missing', async () => {
    installApi();
    render(
      <SourcePopover
        source={{
          ...base,
          kind: 'bibliographie',
          sourceType: 'secondary',
          // no documentId
        }}
        onClose={() => {}}
      />
    );
    // Button disabled because canOpen is false.
    expect(screen.getByTestId('source-popover-open')).toBeDisabled();
  });

  it('renders the snippet and title', () => {
    render(
      <SourcePopover
        source={{
          ...base,
          kind: 'bibliographie',
          sourceType: 'secondary',
          documentId: 'doc-1',
          pageNumber: 7,
        }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Papert 1980')).toBeTruthy();
    expect(screen.getByText('Mindstorms snippet')).toBeTruthy();
    expect(screen.getByText('page 7')).toBeTruthy();
  });
});
