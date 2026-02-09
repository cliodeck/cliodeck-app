/**
 * Zod validation schemas for IPC handler inputs
 */
import { z } from 'zod';

// Project schemas
export const ProjectCreateSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  path: z.string().min(1, 'Project path is required'),
  chapters: z.array(z.string()).optional(),
  bibliographySource: z
    .object({
      type: z.enum(['file', 'zotero']),
      path: z.string().optional(),
      userId: z.string().optional(),
      apiKey: z.string().optional(),
      collectionKey: z.string().optional(),
    })
    .optional(),
});

export const ProjectSaveSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BibliographySourceSchema = z.object({
  projectPath: z.string().min(1),
  type: z.enum(['file', 'zotero']),
  filePath: z.string().optional(),
  zoteroCollection: z.string().optional(),
});

// PDF schemas
export const PDFIndexSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  bibtexKey: z.string().optional(),
});

export const PDFSearchSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  options: z
    .object({
      topK: z.number().min(1).max(100).optional(),
      threshold: z.number().min(0).max(1).optional(),
      documentIds: z.array(z.string()).optional(),
    })
    .optional(),
});

// Chat schemas
export const ChatSendSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  options: z
    .object({
      context: z.boolean().optional(),
      topK: z.number().min(1).max(100).optional(),
      includeSummaries: z.boolean().optional(),
      useGraphContext: z.boolean().optional(),
      additionalGraphDocs: z.number().min(0).max(10).optional(),
      // Collection filtering (filter RAG by Zotero collections)
      collectionKeys: z.array(z.string()).optional(),
      // Issue #16: Document filtering (filter RAG by specific document IDs)
      documentIds: z.array(z.string()).optional(),
      // Source type selection (primary = Tropy archives, secondary = PDFs, both = all)
      sourceType: z.enum(['secondary', 'primary', 'both']).optional(),
      // Provider selection
      provider: z.enum(['ollama', 'embedded', 'auto']).optional(),
      model: z.string().optional(),
      timeout: z.number().min(1000).optional(),
      numCtx: z.number().min(512).max(262144).optional(), // Context window size in tokens
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      top_k: z.number().min(1).max(100).optional(),
      repeat_penalty: z.number().min(0).max(2).optional(),
      // System prompt configuration (Phase 2.3)
      systemPromptLanguage: z.enum(['fr', 'en']).optional(),
      useCustomSystemPrompt: z.boolean().optional(),
      customSystemPrompt: z.string().optional(),
      // Context compression override (from mode)
      enableContextCompression: z.boolean().optional(),
      // Mode tracking
      modeId: z.string().optional(),
      noSystemPrompt: z.boolean().optional(),
    })
    .optional(),
});

// Zotero schemas
export const ZoteroTestConnectionSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  apiKey: z.string().min(1, 'API key is required'),
  groupId: z.string().optional(),
});

export const ZoteroSyncSchema = z.object({
  userId: z.string().min(1),
  apiKey: z.string().min(1),
  groupId: z.string().optional(),
  collectionKey: z.string().optional(),
  downloadPDFs: z.boolean().default(true),
  exportBibTeX: z.boolean().default(true),
  targetDirectory: z.string().optional(),
});

// Export schemas
export const PDFExportSchema = z.object({
  projectPath: z.string().min(1),
  projectType: z.enum(['article', 'book', 'presentation']),
  content: z.string().min(1),
  outputPath: z.string().optional(),
  bibliographyPath: z.string().optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      date: z.string().optional(),
      abstract: z.string().optional(),
    })
    .optional(),
  beamerConfig: z.record(z.string(), z.unknown()).optional(),
});

export const RevealJSExportSchema = z.object({
  projectPath: z.string().min(1),
  content: z.string().min(1),
  outputPath: z.string().optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      date: z.string().optional(),
    })
    .optional(),
  config: z
    .object({
      theme: z.string().optional(),
      transition: z.string().optional(),
      controls: z.boolean().optional(),
      progress: z.boolean().optional(),
      slideNumber: z.boolean().optional(),
      history: z.boolean().optional(),
    })
    .optional(),
});

// History schemas
export const HistoryExportReportSchema = z.object({
  sessionId: z.string().min(1),
  format: z.enum(['markdown', 'json', 'latex']),
});

export const HistorySearchEventsSchema = z.object({
  sessionId: z.string().optional(),
  eventType: z.string().optional(),
  startDate: z.string().or(z.date()).optional(),
  endDate: z.string().or(z.date()).optional(),
});

/**
 * Validates input data against a Zod schema
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Validated and typed data
 * @throws Error if validation fails
 */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Validation failed: ${messages}`);
    }
    throw error;
  }
}
