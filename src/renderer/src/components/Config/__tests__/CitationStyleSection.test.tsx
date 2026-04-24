// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CitationStyleSection } from '../CitationStyleSection';

interface ElectronMock {
  citation: {
    listStyles: ReturnType<typeof vi.fn>;
    listLocales: ReturnType<typeof vi.fn>;
    format: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
  };
  config: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  bibliography: {
    search: ReturnType<typeof vi.fn>;
  };
}

function installElectronMock(overrides?: Partial<ElectronMock>): ElectronMock {
  const mock: ElectronMock = {
    citation: {
      listStyles: vi.fn().mockResolvedValue({
        success: true,
        styles: [
          { id: 'chicago-note-bibliography', label: 'Chicago Note Bibliography' },
          { id: 'modern-language-association', label: 'Modern Language Association' },
        ],
      }),
      listLocales: vi.fn().mockResolvedValue({
        success: true,
        locales: ['en-US', 'fr-FR'],
      }),
      format: vi.fn(),
      preview: vi.fn().mockResolvedValue({
        success: true,
        footnote: '<span>fn</span>',
        bibliography: '<span>bib</span>',
      }),
    },
    config: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    bibliography: {
      search: vi.fn().mockResolvedValue({ success: true, citations: [] }),
    },
    ...overrides,
  };
  (window as unknown as { electron: ElectronMock }).electron = mock;
  return mock;
}

describe('CitationStyleSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders style and locale dropdowns populated from IPC', async () => {
    installElectronMock();
    render(<CitationStyleSection />);

    // Header auto-collapsed; expand it so the selects are in the DOM tree.
    fireEvent.click(screen.getByText('Citation style'));

    const styleSelect = (await screen.findByLabelText('Citation style')) as HTMLSelectElement;
    const localeSelect = screen.getByLabelText('Citation locale') as HTMLSelectElement;

    await waitFor(() => {
      expect(styleSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(2);
    });

    const styleIds = Array.from(styleSelect.options).map((o) => o.value);
    expect(styleIds).toContain('chicago-note-bibliography');
    expect(styleIds).toContain('modern-language-association');

    const localeIds = Array.from(localeSelect.options).map((o) => o.value);
    expect(localeIds).toContain('en-US');
    expect(localeIds).toContain('fr-FR');
  });

  it('persists config changes via window.electron.config.set', async () => {
    const mock = installElectronMock();
    render(<CitationStyleSection />);
    fireEvent.click(screen.getByText('Citation style'));

    const styleSelect = (await screen.findByLabelText('Citation style')) as HTMLSelectElement;
    await waitFor(() => {
      expect(styleSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(2);
    });

    fireEvent.change(styleSelect, { target: { value: 'modern-language-association' } });

    await waitFor(() => {
      expect(mock.config.set).toHaveBeenCalledWith('citation', {
        style: 'modern-language-association',
        locale: 'en-US',
      });
    });
  });
});
