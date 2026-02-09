type SupportedLanguage = 'fr' | 'en' | 'de';
export declare function loadMenuTranslations(): void;
export declare function setLanguage(language: SupportedLanguage): void;
export declare function getLanguage(): SupportedLanguage;
export declare function t(key: string): string;
export {};
