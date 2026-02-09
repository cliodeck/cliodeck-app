import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Import direct des fichiers de traduction
import frCommon from '../../../public/locales/fr/common.json'
import frMenu from '../../../public/locales/fr/menu.json'
import enCommon from '../../../public/locales/en/common.json'
import enMenu from '../../../public/locales/en/menu.json'
import deCommon from '../../../public/locales/de/common.json'
import deMenu from '../../../public/locales/de/menu.json'

// Langues supportées
export const SUPPORTED_LANGUAGES = {
  fr: 'Français',
  en: 'English',
  de: 'Deutsch'
} as const

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES

// Configuration i18next avec les ressources importées
i18n
  .use(initReactI18next)
  .init({
    resources: {
      fr: {
        common: frCommon,
        menu: frMenu
      },
      en: {
        common: enCommon,
        menu: enMenu
      },
      de: {
        common: deCommon,
        menu: deMenu
      }
    },
    lng: 'fr', // Langue par défaut
    fallbackLng: 'fr',
    ns: ['common', 'menu'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false // React échappe déjà les valeurs
    },
    react: {
      useSuspense: false // Désactiver Suspense car les traductions sont déjà chargées
    }
  })

export default i18n
