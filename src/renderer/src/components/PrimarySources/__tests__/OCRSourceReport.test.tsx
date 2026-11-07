// @vitest-environment jsdom
/**
 * Décision Q26 : des notes Tropy de 500 caractères ou plus tiennent lieu de
 * transcription, et l'OCR ne passe pas sans « Relancer l'OCR ». La condition
 * de l'auteur : que ce soit clair sur la source. Ce test fixe quand la phrase
 * paraît, et ce qu'elle cite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';
import { OCRSourceReport } from '../OCRSourceReport';
import { NOTE_TRANSCRIPTION_MIN_CHARS } from '../../../../../../backend/integrations/tropy/note-transcription';

interface ReportOverrides {
  transcriptionSource: string | null;
  notesLength: number;
}

function installReport({ transcriptionSource, notesLength }: ReportOverrides): void {
  (window as unknown as { electron: unknown }).electron = {
    tropy: {
      getSourceOCRReport: () =>
        Promise.resolve({
          success: true,
          report: {
            sourceId: 's1',
            title: 'Lettre du commissaire central',
            ocrConfidence: transcriptionSource === 'tesseract' ? 88.5 : null,
            transcriptionSource,
            chunkCount: 3,
            avgQualityScore: null,
            minQualityScore: null,
            maxQualityScore: null,
            transcriptionLength: 1200,
            notesLength,
          },
        }),
    },
  };
}

afterEach(() => cleanup());

describe('OCRSourceReport : notes qui tiennent lieu de transcription (Q26)', () => {
  it('le dit quand les notes atteignent le seuil', async () => {
    installReport({ transcriptionSource: 'tropy-notes', notesLength: NOTE_TRANSCRIPTION_MIN_CHARS });
    render(<OCRSourceReport sourceId="s1" />);
    expect(await screen.findByText('primarySources.notesHoldOCR')).toBeInTheDocument();
  });

  it('se tait sous le seuil : la note est un commentaire, l’OCR passe', async () => {
    installReport({ transcriptionSource: 'tropy-notes', notesLength: NOTE_TRANSCRIPTION_MIN_CHARS - 1 });
    render(<OCRSourceReport sourceId="s1" />);
    expect(await screen.findByText('primarySources.ocrReport')).toBeInTheDocument();
    expect(screen.queryByText('primarySources.notesHoldOCR')).toBeNull();
  });

  it('se tait quand l’OCR a donné le texte, même avec de longues notes', async () => {
    installReport({ transcriptionSource: 'tesseract', notesLength: 2000 });
    render(<OCRSourceReport sourceId="s1" />);
    expect(await screen.findByText('primarySources.ocrReport')).toBeInTheDocument();
    expect(screen.queryByText('primarySources.notesHoldOCR')).toBeNull();
  });
});

describe('primarySources.notesHoldOCR dans les trois langues', () => {
  const localesDir = path.resolve(__dirname, '../../../../../../public/locales');
  for (const locale of ['fr', 'en', 'de']) {
    it(`${locale} : seuil interpolé et libellé exact de la case`, () => {
      const common = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'common.json'), 'utf-8')) as {
        primarySources: Record<string, string>;
      };
      const notice = common.primarySources.notesHoldOCR;
      expect(notice).toContain('{{min}}');
      expect(notice).not.toContain(String(NOTE_TRANSCRIPTION_MIN_CHARS));
      // La case s'affiche « Relancer l'OCR sur toutes les sources (ignorer…) » :
      // la phrase en cite la partie avant la parenthèse.
      const label = common.primarySources.forceOCR.split(' (')[0];
      expect(notice).toContain(label);
    });
  }
});
