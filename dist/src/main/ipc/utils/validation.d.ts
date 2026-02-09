/**
 * Zod validation schemas for IPC handler inputs
 */
import { z } from 'zod';
export declare const ProjectCreateSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    chapters: z.ZodOptional<z.ZodArray<z.ZodString>>;
    bibliographySource: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            file: "file";
            zotero: "zotero";
        }>;
        path: z.ZodOptional<z.ZodString>;
        userId: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        collectionKey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ProjectSaveSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const BibliographySourceSchema: z.ZodObject<{
    projectPath: z.ZodString;
    type: z.ZodEnum<{
        file: "file";
        zotero: "zotero";
    }>;
    filePath: z.ZodOptional<z.ZodString>;
    zoteroCollection: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const PDFIndexSchema: z.ZodObject<{
    filePath: z.ZodString;
    bibtexKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const PDFSearchSchema: z.ZodObject<{
    query: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        topK: z.ZodOptional<z.ZodNumber>;
        threshold: z.ZodOptional<z.ZodNumber>;
        documentIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ChatSendSchema: z.ZodObject<{
    message: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        context: z.ZodOptional<z.ZodBoolean>;
        topK: z.ZodOptional<z.ZodNumber>;
        includeSummaries: z.ZodOptional<z.ZodBoolean>;
        useGraphContext: z.ZodOptional<z.ZodBoolean>;
        additionalGraphDocs: z.ZodOptional<z.ZodNumber>;
        collectionKeys: z.ZodOptional<z.ZodArray<z.ZodString>>;
        documentIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sourceType: z.ZodOptional<z.ZodEnum<{
            secondary: "secondary";
            primary: "primary";
            both: "both";
        }>>;
        provider: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            ollama: "ollama";
            embedded: "embedded";
        }>>;
        model: z.ZodOptional<z.ZodString>;
        timeout: z.ZodOptional<z.ZodNumber>;
        numCtx: z.ZodOptional<z.ZodNumber>;
        temperature: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        top_k: z.ZodOptional<z.ZodNumber>;
        repeat_penalty: z.ZodOptional<z.ZodNumber>;
        systemPromptLanguage: z.ZodOptional<z.ZodEnum<{
            fr: "fr";
            en: "en";
        }>>;
        useCustomSystemPrompt: z.ZodOptional<z.ZodBoolean>;
        customSystemPrompt: z.ZodOptional<z.ZodString>;
        enableContextCompression: z.ZodOptional<z.ZodBoolean>;
        modeId: z.ZodOptional<z.ZodString>;
        noSystemPrompt: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ZoteroTestConnectionSchema: z.ZodObject<{
    userId: z.ZodString;
    apiKey: z.ZodString;
    groupId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ZoteroSyncSchema: z.ZodObject<{
    userId: z.ZodString;
    apiKey: z.ZodString;
    groupId: z.ZodOptional<z.ZodString>;
    collectionKey: z.ZodOptional<z.ZodString>;
    downloadPDFs: z.ZodDefault<z.ZodBoolean>;
    exportBibTeX: z.ZodDefault<z.ZodBoolean>;
    targetDirectory: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const PDFExportSchema: z.ZodObject<{
    projectPath: z.ZodString;
    projectType: z.ZodEnum<{
        article: "article";
        book: "book";
        presentation: "presentation";
    }>;
    content: z.ZodString;
    outputPath: z.ZodOptional<z.ZodString>;
    bibliographyPath: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        author: z.ZodOptional<z.ZodString>;
        date: z.ZodOptional<z.ZodString>;
        abstract: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    beamerConfig: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const RevealJSExportSchema: z.ZodObject<{
    projectPath: z.ZodString;
    content: z.ZodString;
    outputPath: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        author: z.ZodOptional<z.ZodString>;
        date: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    config: z.ZodOptional<z.ZodObject<{
        theme: z.ZodOptional<z.ZodString>;
        transition: z.ZodOptional<z.ZodString>;
        controls: z.ZodOptional<z.ZodBoolean>;
        progress: z.ZodOptional<z.ZodBoolean>;
        slideNumber: z.ZodOptional<z.ZodBoolean>;
        history: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const HistoryExportReportSchema: z.ZodObject<{
    sessionId: z.ZodString;
    format: z.ZodEnum<{
        latex: "latex";
        markdown: "markdown";
        json: "json";
    }>;
}, z.core.$strip>;
export declare const HistorySearchEventsSchema: z.ZodObject<{
    sessionId: z.ZodOptional<z.ZodString>;
    eventType: z.ZodOptional<z.ZodString>;
    startDate: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    endDate: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
}, z.core.$strip>;
/**
 * Validates input data against a Zod schema
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Validated and typed data
 * @throws Error if validation fails
 */
export declare function validate<T>(schema: z.ZodSchema<T>, data: unknown): T;
