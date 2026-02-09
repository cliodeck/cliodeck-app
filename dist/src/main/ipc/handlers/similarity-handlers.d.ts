import { z } from 'zod';
export declare const SimilarityAnalyzeSchema: z.ZodObject<{
    text: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        granularity: z.ZodOptional<z.ZodEnum<{
            sentence: "sentence";
            paragraph: "paragraph";
            section: "section";
        }>>;
        maxResults: z.ZodOptional<z.ZodNumber>;
        similarityThreshold: z.ZodOptional<z.ZodNumber>;
        collectionFilter: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>;
        sourceType: z.ZodOptional<z.ZodEnum<{
            secondary: "secondary";
            primary: "primary";
            both: "both";
        }>>;
        useReranking: z.ZodOptional<z.ZodBoolean>;
        useContextualEmbedding: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare function setupSimilarityHandlers(): void;
