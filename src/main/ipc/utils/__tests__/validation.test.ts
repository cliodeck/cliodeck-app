import { describe, it, expect } from 'vitest';
import {
  validate,
  ProjectCreateSchema,
  ProjectSaveSchema,
  BibliographySourceSchema,
  PDFIndexSchema,
  PDFSearchSchema,
  ChatSendSchema,
  ZoteroTestConnectionSchema,
  ZoteroSyncSchema,
  PDFExportSchema,
  RevealJSExportSchema,
  HistoryExportReportSchema,
  HistorySearchEventsSchema,
} from '../validation';

describe('validate() helper', () => {
  it('returns parsed data for valid input', () => {
    const result = validate(ProjectCreateSchema, {
      name: 'Test Project',
      path: '/home/user/test',
    });
    expect(result.name).toBe('Test Project');
    expect(result.path).toBe('/home/user/test');
  });

  it('throws for invalid input', () => {
    expect(() => validate(ProjectCreateSchema, { name: '', path: '' })).toThrow('Validation failed');
  });

  it('throws for missing required fields', () => {
    expect(() => validate(ProjectCreateSchema, {})).toThrow('Validation failed');
  });
});

describe('ProjectCreateSchema', () => {
  it('accepts valid project data', () => {
    const result = ProjectCreateSchema.parse({
      name: 'Mon Projet',
      path: '/home/user/project',
    });
    expect(result.name).toBe('Mon Projet');
  });

  it('accepts with optional bibliographySource', () => {
    const result = ProjectCreateSchema.parse({
      name: 'Projet',
      path: '/tmp/p',
      bibliographySource: { type: 'zotero', userId: '123', apiKey: 'abc' },
    });
    expect(result.bibliographySource?.type).toBe('zotero');
  });

  it('rejects empty name', () => {
    expect(() => ProjectCreateSchema.parse({ name: '', path: '/p' })).toThrow();
  });

  it('rejects empty path', () => {
    expect(() => ProjectCreateSchema.parse({ name: 'P', path: '' })).toThrow();
  });
});

describe('ProjectSaveSchema', () => {
  it('accepts valid save data', () => {
    const result = ProjectSaveSchema.parse({
      path: '/home/user/project.json',
      content: '# My Document',
    });
    expect(result.content).toBe('# My Document');
  });

  it('rejects missing content', () => {
    expect(() => ProjectSaveSchema.parse({ path: '/p' })).toThrow();
  });
});

describe('BibliographySourceSchema', () => {
  it('accepts file type', () => {
    const result = BibliographySourceSchema.parse({
      projectPath: '/project/project.json',
      type: 'file',
      filePath: '/project/refs.bib',
    });
    expect(result.type).toBe('file');
  });

  it('accepts zotero type', () => {
    const result = BibliographySourceSchema.parse({
      projectPath: '/project/project.json',
      type: 'zotero',
      zoteroCollection: 'ABC123',
    });
    expect(result.type).toBe('zotero');
  });

  it('rejects invalid type', () => {
    expect(() =>
      BibliographySourceSchema.parse({
        projectPath: '/p',
        type: 'mendeley',
      })
    ).toThrow();
  });
});

describe('PDFIndexSchema', () => {
  it('accepts valid PDF path', () => {
    const result = PDFIndexSchema.parse({ filePath: '/docs/paper.pdf' });
    expect(result.filePath).toBe('/docs/paper.pdf');
  });

  it('accepts with bibtexKey', () => {
    const result = PDFIndexSchema.parse({ filePath: '/docs/paper.pdf', bibtexKey: 'smith2024' });
    expect(result.bibtexKey).toBe('smith2024');
  });

  it('rejects empty filePath', () => {
    expect(() => PDFIndexSchema.parse({ filePath: '' })).toThrow();
  });
});

describe('PDFSearchSchema', () => {
  it('accepts valid search', () => {
    const result = PDFSearchSchema.parse({ query: 'World War II' });
    expect(result.query).toBe('World War II');
  });

  it('accepts with options', () => {
    const result = PDFSearchSchema.parse({
      query: 'test',
      options: { topK: 10, threshold: 0.5 },
    });
    expect(result.options?.topK).toBe(10);
  });

  it('rejects empty query', () => {
    expect(() => PDFSearchSchema.parse({ query: '' })).toThrow();
  });

  it('rejects topK out of range', () => {
    expect(() => PDFSearchSchema.parse({ query: 'test', options: { topK: 200 } })).toThrow();
  });
});

describe('ChatSendSchema', () => {
  it('accepts simple message', () => {
    const result = ChatSendSchema.parse({ message: 'Hello' });
    expect(result.message).toBe('Hello');
  });

  it('accepts with full options', () => {
    const result = ChatSendSchema.parse({
      message: 'Analyse ce document',
      options: {
        context: true,
        topK: 5,
        sourceType: 'both',
        provider: 'ollama',
        temperature: 0.7,
        systemPromptLanguage: 'fr',
        modeId: 'historian-mode',
      },
    });
    expect(result.options?.sourceType).toBe('both');
    expect(result.options?.provider).toBe('ollama');
  });

  it('rejects empty message', () => {
    expect(() => ChatSendSchema.parse({ message: '' })).toThrow();
  });

  it('rejects invalid sourceType', () => {
    expect(() =>
      ChatSendSchema.parse({ message: 'test', options: { sourceType: 'tertiary' } })
    ).toThrow();
  });

  it('rejects temperature out of range', () => {
    expect(() =>
      ChatSendSchema.parse({ message: 'test', options: { temperature: 5 } })
    ).toThrow();
  });
});

describe('ZoteroTestConnectionSchema', () => {
  it('accepts API mode', () => {
    const result = ZoteroTestConnectionSchema.parse({
      mode: 'api',
      userId: '12345',
      apiKey: 'abcdef',
    });
    expect(result.mode).toBe('api');
  });

  it('accepts local mode', () => {
    const result = ZoteroTestConnectionSchema.parse({
      mode: 'local',
      dataDirectory: '/home/user/Zotero',
    });
    expect(result.mode).toBe('local');
  });

  it('rejects API mode without userId', () => {
    expect(() =>
      ZoteroTestConnectionSchema.parse({ mode: 'api', apiKey: 'abc' })
    ).toThrow();
  });

  it('rejects local mode without dataDirectory', () => {
    expect(() =>
      ZoteroTestConnectionSchema.parse({ mode: 'local' })
    ).toThrow();
  });
});

describe('ZoteroSyncSchema', () => {
  it('accepts API sync with defaults', () => {
    const result = ZoteroSyncSchema.parse({
      mode: 'api',
      userId: '123',
      apiKey: 'key',
    });
    expect(result.downloadPDFs).toBe(true);
    expect(result.exportBibTeX).toBe(true);
  });

  it('accepts local sync with collection', () => {
    const result = ZoteroSyncSchema.parse({
      mode: 'local',
      dataDirectory: '/zotero',
      collectionKey: 'COL123',
      downloadPDFs: false,
    });
    expect(result.downloadPDFs).toBe(false);
  });
});

describe('PDFExportSchema', () => {
  it('accepts valid export', () => {
    const result = PDFExportSchema.parse({
      projectPath: '/project',
      projectType: 'article',
      content: '# Title\n\nContent',
    });
    expect(result.projectType).toBe('article');
  });

  it('rejects invalid projectType', () => {
    expect(() =>
      PDFExportSchema.parse({
        projectPath: '/p',
        projectType: 'thesis',
        content: 'text',
      })
    ).toThrow();
  });
});

describe('RevealJSExportSchema', () => {
  it('accepts valid export', () => {
    const result = RevealJSExportSchema.parse({
      projectPath: '/project',
      content: '# Slide 1\n---\n# Slide 2',
    });
    expect(result.content).toContain('Slide');
  });

  it('accepts with config', () => {
    const result = RevealJSExportSchema.parse({
      projectPath: '/project',
      content: 'text',
      config: { theme: 'moon', transition: 'slide' },
    });
    expect(result.config?.theme).toBe('moon');
  });
});

describe('HistoryExportReportSchema', () => {
  it('accepts valid report request', () => {
    const result = HistoryExportReportSchema.parse({
      sessionId: 'session-abc-123',
      format: 'markdown',
    });
    expect(result.format).toBe('markdown');
  });

  it('rejects invalid format', () => {
    expect(() =>
      HistoryExportReportSchema.parse({ sessionId: 'x', format: 'pdf' })
    ).toThrow();
  });
});

describe('HistorySearchEventsSchema', () => {
  it('accepts empty search (all events)', () => {
    const result = HistorySearchEventsSchema.parse({});
    expect(result.sessionId).toBeUndefined();
  });

  it('accepts filtered search', () => {
    const result = HistorySearchEventsSchema.parse({
      sessionId: 'session-1',
      eventType: 'query',
    });
    expect(result.eventType).toBe('query');
  });
});
