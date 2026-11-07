// @vitest-environment jsdom
/**
 * Rapport OCR d'une source : l'explication de la décision Q26.
 *
 * Des notes Tropy de 500 caractères ou plus tiennent lieu de transcription et
 * l'OCR ne passe pas sans « Relancer l'OCR sur toutes les sources ». L'auteur
 * a posé une condition : que l'historien le voie sur la source concernée.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';
import { OCRSourceReport } from '../OCRSourceReport';
import { NOTE_TRANSCRIPTION_MIN_CHARS } from '../../../../../../backend/integrations/tropy/note-transcription';

function stubReport(report: Record<string, unknown>): void {
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.tropy = {
    getSourceOCRReport: async () => ({
      success: true,
      report: {
        sourceId: 's',
        title: 'Lettre du commissaire',
        ocrConfidence: null,
        chunkCount: 3,
        avgQualityScore: 0.8,
        minQualityScore: 0.7,
        maxQualityScore: 0.9,
        transcriptionLength: 900,
        ...report,
      },
    }),
  };
}

afterEach(cleanup);

describe('OCRSourceReport — notes Tropy tenant lieu de transcription', () => {
  it('explique pourquoi l’OCR n’a pas été lancé quand les notes atteignent le seuil', async () => {
    stubReport({ transcriptionSource: 'tropy-notes', notesLength: NOTE_TRANSCRIPTION_MIN_CHARS });
    render(<OCRSourceReport sourceId="s" />);
    expect(await screen.findByText('primarySources.notesHoldOCR')).toBeInTheDocument();
  });

  it('l’explique aussi quand la source n’a pas encore d’extraits', async () => {
    stubReport({
      transcriptionSource: 'tropy-notes',
      notesLength: 800,
      chunkCount: 0,
      avgQualityScore: null,
    });
    render(<OCRSourceReport sourceId="s" />);
    expect(await screen.findByText('primarySources.notesHoldOCR')).toBeInTheDocument();
  });

  it('se tait pour une note courte, qui n’empêche pas l’OCR', async () => {
    stubReport({ transcriptionSource: 'tropy-notes', notesLength: NOTE_TRANSCRIPTION_MIN_CHARS - 1 });
    render(<OCRSourceReport sourceId="s" />);
    await screen.findByText('primarySources.ocrReport');
    expect(screen.queryByText('primarySources.notesHoldOCR')).toBeNull();
  });

  it('se tait quand un corps existe : les notes sont à côté, l’OCR a eu lieu', async () => {
    stubReport({ transcriptionSource: 'tesseract', ocrConfidence: 88, notesLength: 2000 });
    render(<OCRSourceReport sourceId="s" />);
    await screen.findByText('primarySources.ocrReport');
    expect(screen.queryByText('primarySources.notesHoldOCR')).toBeNull();
  });

  it('les trois langues tirent le seuil de la constante, sans l’écrire en dur', () => {
    for (const lng of ['fr', 'en', 'de']) {
      const file = path.join(__dirname, '../../../../../../public/locales', lng, 'common.json');
      const message = JSON.parse(fs.readFileSync(file, 'utf-8')).primarySources.notesHoldOCR as string;
      expect(message).toContain('{{min}}');
      expect(message).not.toContain(String(NOTE_TRANSCRIPTION_MIN_CHARS));
    }
  });

  it('les trois langues citent le libellé exact de la case « Relancer l’OCR »', () => {
    for (const lng of ['fr', 'en', 'de']) {
      const file = path.join(__dirname, '../../../../../../public/locales', lng, 'common.json');
      const strings = JSON.parse(fs.readFileSync(file, 'utf-8')).primarySources as Record<string, string>;
      // La case s'affiche « Relancer l'OCR sur toutes les sources (ignorer…) » :
      // la phrase en cite la partie avant la parenthèse.
      expect(strings.notesHoldOCR).toContain(strings.forceOCR.split(' (')[0]);
    }
  });
});
