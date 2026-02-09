/**
 * Default system prompts for the RAG chatbot
 * Phase 2.3 - Configurable system prompts
 */
export declare const DEFAULT_SYSTEM_PROMPTS: {
    fr: string;
    en: string;
};
/**
 * Gets the default system prompt for a given language
 */
export declare function getDefaultSystemPrompt(language: 'fr' | 'en'): string;
/**
 * Gets the system prompt to use based on configuration
 */
export declare function getSystemPrompt(language: 'fr' | 'en', useCustomPrompt: boolean, customPrompt?: string): string;
