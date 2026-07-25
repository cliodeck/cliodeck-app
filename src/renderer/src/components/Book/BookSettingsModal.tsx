/**
 * Réglages de l'ouvrage (#24) — l'UI qui manquait à BookSettings.
 *
 * Les cinq réglages (project.json → section `book`) n'étaient joignables
 * qu'en éditant le fichier à la main, alors que l'IPC
 * `project:save-book-settings` et `projectStore.updateBookSettings`
 * (optimiste + rollback) existaient déjà. Chaque changement est appliqué
 * immédiatement — pas de bouton Enregistrer, le store revient en arrière
 * si l'écriture échoue.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useProjectStore, type BookSettings } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import './BookSettingsModal.css';

interface BookSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BookSettingsModal: React.FC<BookSettingsModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const bookSettings = useProjectStore((s) => s.bookSettings);
  const updateBookSettings = useProjectStore((s) => s.updateBookSettings);

  if (!isOpen) return null;

  const apply = async (patch: Partial<BookSettings>) => {
    try {
      await updateBookSettings(patch);
    } catch (error) {
      console.error('Failed to save book settings:', error);
      await useDialogStore.getState().showAlert(t('book.settings.saveError'));
    }
  };

  return (
    <div className="book-settings-overlay" onClick={onClose}>
      <div
        className="book-settings-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="book-settings-header">
          <h3>{t('book.settings.title')}</h3>
          <button
            className="book-settings-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="book-settings-content">
          {/* Style de notes */}
          <div className="book-settings-field">
            <label htmlFor="book-note-style">{t('book.settings.noteStyle')}</label>
            <select
              id="book-note-style"
              value={bookSettings.noteStyle}
              onChange={(e) => void apply({ noteStyle: e.target.value as BookSettings['noteStyle'] })}
            >
              <option value="footnote">{t('book.settings.noteStyleFootnote')}</option>
              <option value="endnote-chapter">{t('book.settings.noteStyleEndnoteChapter')}</option>
              <option value="endnote-book">{t('book.settings.noteStyleEndnoteBook')}</option>
            </select>
          </div>

          {/* Numérotation des notes */}
          <div className="book-settings-field">
            <label htmlFor="book-note-numbering">{t('book.settings.noteNumbering')}</label>
            <select
              id="book-note-numbering"
              value={bookSettings.noteNumbering}
              onChange={(e) =>
                void apply({ noteNumbering: e.target.value as BookSettings['noteNumbering'] })
              }
            >
              <option value="continuous">{t('book.settings.noteNumberingContinuous')}</option>
              <option value="per-chapter">{t('book.settings.noteNumberingPerChapter')}</option>
            </select>
            <span className="book-settings-hint">{t('book.settings.noteNumberingHint')}</span>
          </div>

          {/* Bibliographie */}
          <div className="book-settings-field">
            <label htmlFor="book-bibliography">{t('book.settings.bibliography')}</label>
            <select
              id="book-bibliography"
              value={bookSettings.bibliography}
              onChange={(e) =>
                void apply({ bibliography: e.target.value as BookSettings['bibliography'] })
              }
            >
              <option value="single">{t('book.settings.bibliographySingle')}</option>
              <option value="per-chapter">{t('book.settings.bibliographyPerChapter')}</option>
            </select>
          </div>

          {/* Numérotation chapitres / sections */}
          <div className="book-settings-field">
            <label className="book-settings-checkbox">
              <input
                type="checkbox"
                checked={bookSettings.numberChapters}
                onChange={(e) => void apply({ numberChapters: e.target.checked })}
              />
              {t('book.settings.numberChapters')}
            </label>
            <label className="book-settings-checkbox">
              <input
                type="checkbox"
                checked={bookSettings.numberSections}
                onChange={(e) => void apply({ numberSections: e.target.checked })}
              />
              {t('book.settings.numberSections')}
            </label>
          </div>

          <p className="book-settings-hint">{t('book.settings.exportHint')}</p>
        </div>
      </div>
    </div>
  );
};
