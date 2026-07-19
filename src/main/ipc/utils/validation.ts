/**
 * Zod validation schemas for IPC handler inputs
 */
import { z } from 'zod';

// Project schemas
export const ProjectCreateSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  type: z.enum(['article', 'book', 'presentation']).optional(),
  path: z.string().min(1, 'Project path is required'),
  // Pas de `chapters` ici : le manifeste d'un livre est construit par
  // `createProject` puis géré par ses propres canaux (`ChapterSchema`).
  // Le champ qui traînait déclarait un `string[]`, incompatible avec le
  // type `Chapter` — vestige d'avant le chantier livre, jamais émis.
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

// Zotero schemas (support both API and local modes)
export const ZoteroTestConnectionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1, 'User ID is required'),
    apiKey: z.string().min(1, 'API key is required'),
    groupId: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().min(1, 'Data directory is required'),
    libraryID: z.number().optional(),
  }),
]);

export const ZoteroListCollectionsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().min(1),
    libraryID: z.number().optional(),
  }),
]);

export const ZoteroSyncSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    collectionKey: z.string().optional(),
    downloadPDFs: z.boolean().default(true),
    exportBibTeX: z.boolean().default(true),
    targetDirectory: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().min(1),
    libraryID: z.number().optional(),
    collectionKey: z.string().optional(),
    downloadPDFs: z.boolean().default(true),
    exportBibTeX: z.boolean().default(true),
    targetDirectory: z.string().optional(),
  }),
]);

// Export schemas
// Book chapters (manifeste du manuscrit)
const ChapterSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  filePath: z.string().min(1),
  order: z.number().int().min(0),
  kind: z.enum(['chapter', 'front', 'back']).optional(),
});

export const BookSettingsSchema = z.object({
  noteStyle: z.enum(['footnote', 'endnote-chapter', 'endnote-book']),
  noteNumbering: z.enum(['continuous', 'per-chapter']),
  bibliography: z.enum(['single', 'per-chapter']),
  numberChapters: z.boolean(),
  numberSections: z.boolean(),
});

export const PDFExportSchema = z.object({
  projectPath: z.string().min(1),
  projectType: z.enum(['article', 'book', 'presentation']),
  // Un livre exporte son manuscrit assemblé côté main : `content` peut
  // alors être vide (cf. `manuscript`).
  content: z.string(),
  outputPath: z.string().optional(),
  bibliographyPath: z.string().optional(),
  bookSettings: BookSettingsSchema.optional(),
  manuscript: z
    .object({
      chapters: z.array(ChapterSchema).max(500),
      liveOverrides: z.record(z.string(), z.string()).optional(),
      scope: z
        .union([z.literal('book'), z.object({ chapterId: z.string().min(1) })])
        .optional(),
    })
    .optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      date: z.string().optional(),
      abstract: z.string().optional(),
    })
    .optional(),
  beamerConfig: z.record(z.string(), z.unknown()).optional(),
  citation: z
    .object({
      useEngine: z.boolean().optional(),
      style: z.string().optional(),
      locale: z.string().optional(),
    })
    .optional(),
})
  .passthrough()
  .refine((v) => v.content.length > 0 || !!v.manuscript, {
    message: 'content vide sans manuscrit à assembler',
    path: ['content'],
  });

/**
 * Chemin de sortie d'un export.
 *
 * Refuse les caractères qui n'ont rien à faire dans un nom de fichier et
 * qui servaient à s'échapper d'une commande shell (guillemets, `$`, backtick,
 * `;`, `|`, `&`, retour à la ligne). L'ouverture passe désormais par
 * `shell.openPath`, donc sans shell — cette contrainte est une seconde
 * barrière, pas la seule.
 */
export const OutputPathSchema = z
  .string()
  .min(1)
  .refine((p) => !/["'`$;|&\n\r]/.test(p), {
    message: 'Le chemin de sortie contient des caractères non autorisés.',
  });

export const RevealJSExportSchema = z.object({
  projectPath: z.string().min(1),
  content: z.string().min(1),
  outputPath: OutputPathSchema.optional(),
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

// Simple string schemas (for handlers that receive a single string argument)
export const StringPathSchema = z.string().min(1, 'Path is required');
export const StringIdSchema = z.string().min(1, 'ID is required');
export const StringQuerySchema = z.string().min(1, 'Query is required');
export const StringUrlSchema = z.string().min(1, 'URL is required');
export const StringContentSchema = z.string().min(1, 'Content is required');
export const OptionalStringSchema = z.string().optional();
export const OptionalModelIdSchema = z.string().optional();

// Filesystem schemas
export const FsReadDirectorySchema = z.object({
  dirPath: z.string().min(1, 'Directory path is required'),
});

export const FsWriteFileSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  content: z.string(),
});

export const FsReadFileSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
});

export const FsCopyFileSchema = z.object({
  source: z.string().min(1, 'Source path is required'),
  destination: z.string().min(1, 'Destination path is required'),
});

export const DialogOpenFileSchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  buttonLabel: z.string().optional(),
  filters: z.array(z.object({
    name: z.string(),
    extensions: z.array(z.string()),
  })).optional(),
  properties: z.array(z.string()).optional(),
}).passthrough();

export const DialogSaveFileSchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  buttonLabel: z.string().optional(),
  filters: z.array(z.object({
    name: z.string(),
    extensions: z.array(z.string()),
  })).optional(),
}).passthrough();

// Tropy schemas
export const TropySyncSchema = z.object({
  performOCR: z.boolean(),
  ocrLanguage: z.string(),
  transcriptionDirectory: z.string().optional(),
  forceReindex: z.boolean().optional(),
});

export const TropyPerformOcrSchema = z.object({
  imagePath: z.string().min(1, 'Image path is required'),
  language: z.string().min(1, 'Language is required'),
});

export const TropyPerformBatchOcrSchema = z.object({
  imagePaths: z.array(z.string().min(1)).min(1, 'At least one image path is required'),
  language: z.string().min(1, 'Language is required'),
});

export const TropyImportTranscriptionSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  type: z.string().optional(),
});

export const TropyUpdateTranscriptionSchema = z.object({
  sourceId: z.string().min(1, 'Source ID is required'),
  transcription: z.string(),
  source: z.enum(['tesseract', 'transkribus', 'manual']),
});

// Editor schemas
export const EditorSaveFileSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  content: z.string(),
  previousContent: z.string().optional(),
});

export const EditorInsertTextSchema = z.object({
  text: z.string(),
  metadata: z.object({
    modeId: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
});

// Mode schemas
export const ModeSaveSchema = z.object({
  mode: z.record(z.string(), z.unknown()),
  target: z.enum(['global', 'project']),
});

export const ModeDeleteSchema = z.object({
  modeId: z.string().min(1, 'Mode ID is required'),
  source: z.enum(['global', 'project']),
});

export const ModeImportSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  target: z.enum(['global', 'project']),
});

export const ModeExportSchema = z.object({
  modeId: z.string().min(1, 'Mode ID is required'),
  outputPath: z.string().min(1, 'Output path is required'),
});

// Config schemas
export const ConfigSetSchema = z.object({
  key: z.string().min(1, 'Config key is required'),
  value: z.unknown(),
});

// Bibliography handler schemas
export const BibliographyExportSchema = z.object({
  citations: z.array(z.record(z.string(), z.unknown())),
  filePath: z.string().min(1, 'File path is required'),
  format: z.enum(['modern', 'legacy']).optional(),
});

export const BibliographyExportStringSchema = z.object({
  citations: z.array(z.record(z.string(), z.unknown())),
  format: z.enum(['modern', 'legacy']).optional(),
});

export const BibliographyDetectOrphanPdfsSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  citations: z.array(z.record(z.string(), z.unknown())),
  includeSubdirectories: z.boolean().optional(),
  pdfSubdirectory: z.string().optional(),
});

export const BibliographyDeleteOrphanPdfsSchema = z.array(
  z.string().min(1)
).min(1, 'At least one file path is required');

export const BibliographyArchiveOrphanPdfsSchema = z.object({
  filePaths: z.array(z.string().min(1)).min(1, 'At least one file path is required'),
  projectPath: z.string().min(1, 'Project path is required'),
  archiveSubdir: z.string().optional(),
});

export const BibliographySaveMetadataSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  citations: z.array(z.record(z.string(), z.unknown())),
});

export const BibliographyLoadWithMetadataSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  projectPath: z.string().min(1, 'Project path is required'),
});

// Corpus schemas (optional options objects)
export const CorpusOptionsSchema = z.record(z.string(), z.unknown()).optional();

// Embedded LLM schemas
export const EmbeddedLLMProviderSchema = z.enum(['ollama', 'embedded', 'auto']);

// Additional Zotero schemas (for handlers not yet validated)
export const ZoteroListLibrariesSchema = z.object({
  dataDirectory: z.string().min(1, 'Data directory is required'),
});

export const ZoteroDownloadPDFSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    attachmentKey: z.string().min(1, 'Attachment key is required'),
    filename: z.string().min(1, 'Filename is required'),
    targetDirectory: z.string().min(1, 'Target directory is required'),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().optional(),
    libraryID: z.number().optional(),
    attachmentKey: z.string().min(1, 'Attachment key is required'),
    filename: z.string().min(1, 'Filename is required'),
    targetDirectory: z.string().min(1, 'Target directory is required'),
  }),
]);

export const ZoteroEnrichCitationsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    citations: z.array(z.record(z.string(), z.unknown())),
    collectionKey: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().optional(),
    libraryID: z.number().optional(),
    citations: z.array(z.record(z.string(), z.unknown())),
    collectionKey: z.string().optional(),
  }),
]);

export const ZoteroCheckUpdatesSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    localCitations: z.array(z.record(z.string(), z.unknown())),
    collectionKey: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().optional(),
    libraryID: z.number().optional(),
    localCitations: z.array(z.record(z.string(), z.unknown())),
    collectionKey: z.string().optional(),
  }),
]);

export const ZoteroApplyUpdatesSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('api'),
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    currentCitations: z.array(z.record(z.string(), z.unknown())),
    diff: z.record(z.string(), z.unknown()),
    strategy: z.enum(['local', 'remote', 'manual']),
    resolution: z.record(z.string(), z.unknown()).optional(),
    collectionKey: z.string().optional(),
  }),
  z.object({
    mode: z.literal('local'),
    dataDirectory: z.string().optional(),
    libraryID: z.number().optional(),
    currentCitations: z.array(z.record(z.string(), z.unknown())),
    diff: z.record(z.string(), z.unknown()),
    strategy: z.enum(['local', 'remote', 'manual']),
    resolution: z.record(z.string(), z.unknown()).optional(),
    collectionKey: z.string().optional(),
  }),
]);

// Additional Project schemas (for handlers not yet validated)
export const ProjectSetCSLPathSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  cslPath: z.string().optional(),
});

export const ProjectUpdateConfigSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  updates: z.record(z.string(), z.unknown()),
});

export const ProjectSaveChaptersSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  chapters: z.array(ChapterSchema),
});

/** Lecture groupée de chapitres (Phase 3) : bornée pour éviter l'abus. */
export const ProjectReadChaptersSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  filePaths: z.array(z.string().min(1)).max(500),
});

export const ProjectCreateChapterSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  title: z.string().min(1, 'Chapter title is required'),
  kind: z.enum(['chapter', 'front', 'back']).optional(),
});

export const ProjectBookSettingsSchema = z.object({
  projectPath: z.string().min(1, 'Project path is required'),
  settings: z.object({
    noteStyle: z.enum(['footnote', 'endnote-chapter', 'endnote-book']).optional(),
    noteNumbering: z.enum(['continuous', 'per-chapter']).optional(),
    bibliography: z.enum(['single', 'per-chapter']).optional(),
    numberChapters: z.boolean().optional(),
    numberSections: z.boolean().optional(),
  }),
});

// Additional PDF schemas (for handlers not yet validated)
export const PDFExtractMetadataSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
});

export const PDFIndexFullSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  bibtexKey: z.string().optional(),
  bibliographyMetadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    year: z.string().optional(),
  }).optional(),
});

export const PDFCheckModifiedSchema = z.object({
  citations: z.array(z.record(z.string(), z.unknown())),
  projectPath: z.string().min(1, 'Project path is required'),
});

// Word export schemas
export const WordExportSchema = z.object({
  projectPath: z.string().min(1),
  projectType: z.enum(['article', 'book', 'presentation']).optional(),
  // Vide autorisé quand `manuscript` est fourni : le texte est alors
  // assemblé côté main depuis le manifeste (même motif que l'export PDF).
  content: z.string(),
  outputPath: z.string().optional(),
  bibliographyPath: z.string().optional(),
  templatePath: z.string().optional(),
  bookSettings: BookSettingsSchema.optional(),
  manuscript: z
    .object({
      chapters: z.array(ChapterSchema).max(500),
      liveOverrides: z.record(z.string(), z.string()).optional(),
      scope: z
        .union([z.literal('book'), z.object({ chapterId: z.string().min(1) })])
        .optional(),
    })
    .optional(),
  metadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
    abstract: z.string().optional(),
  }).optional(),
  citation: z
    .object({
      useEngine: z.boolean().optional(),
      style: z.string().optional(),
      locale: z.string().optional(),
    })
    .optional(),
})
  .passthrough()
  .refine((v) => v.content.length > 0 || !!v.manuscript, {
    message: 'content vide sans manuscrit à assembler',
    path: ['content'],
  });

// History session ID schema (for handlers that take a sessionId)
export const HistorySessionIdSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
});

// Bibliography optional citations schema
export const BibliographyGetStatisticsSchema = z.object({
  citations: z.array(z.record(z.string(), z.unknown())).optional(),
});

// Usage journal (journal d'usage IA) schemas
export const UsageSetModeSchema = z.enum([
  'brainstorm',
  'write',
  'explore',
  'export',
  'recipe',
  'mcp',
  'cli',
  'unknown',
]);

/**
 * Adjudication d'une proposition IA de l'éditeur (plan CM6, Phase 4).
 * Les champs de contenu (original/proposed/final/rejectionNote) sont bornés :
 * ils vont au journal de recherche ; le handler ne transmet JAMAIS de contenu
 * au journal d'usage.
 */
export const ProposalAdjudicationSchema = z.object({
  proposalId: z.string().min(1, 'proposalId is required').max(200),
  decision: z.enum(['accepted', 'rejected', 'modified', 'invalidated', 'expired']),
  category: z.string().min(1, 'category is required').max(200),
  model: z.string().max(200),
  task: z.string().max(500),
  latencyMs: z.number().min(0).finite(),
  at: z.string().min(1, 'at (ISO 8601) is required').max(64),
  original: z.string().max(100_000).optional(),
  proposed: z.string().max(100_000).optional(),
  final: z.string().max(100_000).optional(),
  rejectionNote: z.string().max(2_000).optional(),
  /**
   * Document où l'adjudication a eu lieu — un chapitre, dans un livre.
   * Journal de recherche UNIQUEMENT : le journal d'usage IA n'en reçoit
   * jamais (règle de granularité, docs/INSTRUCTIONS_journal-usage-ia.md).
   */
  filePath: z.string().max(4_096).optional(),
});

export const UsageSaveDecisionSchema = z.object({
  id: z.string().min(1).optional(),
  task: z.string().min(1, 'Tâche requise'),
  alternative: z.string(),
  justification: z.string(),
  verdict: z.enum(['worth_it', 'not_worth_it', 'unsure', 'pending']),
  verdictNote: z.string().optional(),
  sessionIds: z.array(z.string()),
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
