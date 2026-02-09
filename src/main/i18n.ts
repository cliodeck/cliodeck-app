import { readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

type SupportedLanguage = 'fr' | 'en' | 'de';

interface MenuTranslations {
  [key: string]: string;
}

let currentLanguage: SupportedLanguage = 'fr';
const translations: Record<SupportedLanguage, MenuTranslations> = {
  fr: {},
  en: {},
  de: {}
};

// Charger les traductions des menus
export function loadMenuTranslations(): void {
  const languages: SupportedLanguage[] = ['fr', 'en', 'de'];

  for (const lang of languages) {
    try {
      // En production, les fichiers sont dans resources/public/locales
      // En développement, ils sont dans public/locales
      const publicPath = app.isPackaged
        ? join(process.resourcesPath, 'public')
        : join(app.getAppPath(), 'public');

      const menuPath = join(publicPath, 'locales', lang, 'menu.json');
      const content = readFileSync(menuPath, 'utf-8');
      translations[lang] = JSON.parse(content);
    } catch (error) {
      console.error(`Failed to load menu translations for ${lang}:`, error);
      // Fallback vers des traductions vides
      translations[lang] = {};
    }
  }
}

// Définir la langue courante
export function setLanguage(language: SupportedLanguage): void {
  if (['fr', 'en', 'de'].includes(language)) {
    currentLanguage = language;
  }
}

// Obtenir la langue courante
export function getLanguage(): SupportedLanguage {
  return currentLanguage;
}

// Fonction de traduction pour les menus
export function t(key: string): string {
  return translations[currentLanguage]?.[key] || key;
}
