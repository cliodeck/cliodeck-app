/**
 * Découpage adaptatif — celui que l'indexation des PDF utilise par défaut.
 *
 * Deux défauts y sont restés invisibles parce que rien ne testait ce fichier :
 *
 * - la limite de taille ne valait rien pour un PDF (#157). Le texte extrait
 *   d'une page ne contient aucun saut de ligne ; chaque page formait donc un
 *   « paragraphe » que le découpage refusait de recouper : 443 mots en médiane
 *   pour une limite de 300, mesuré sur 39 PDF réels ;
 * - le numéro de page d'un extrait dérivait (#160) : le recouvrement entre
 *   deux extraits était compté deux fois dans le suivi de position, et la page
 *   annoncée prenait une page d'avance tous les huit à dix extraits. C'est ce
 *   numéro que l'assistant cite.
 *
 * Les textes d'essai imitent l'extraction réelle : une page = une seule ligne.
 * Chaque phrase porte un numéro, ce qui permet de dire où elle se trouve et de
 * vérifier qu'aucune ne se perd.
 */
import { describe, it, expect } from 'vitest';
import { AdaptiveChunker } from '../core/chunking/AdaptiveChunker.js';
import { CHUNKING_CONFIGS } from '../core/chunking/DocumentChunker.js';
import type { DocumentChunk, DocumentPage } from '../types/pdf-document.js';

const MAX = CHUNKING_CONFIGS.cpuOptimized.maxChunkSize;
const WORDS_PER_SENTENCE = 12;

/** Une phrase de douze mots, reconnaissable à son numéro. */
const sentence = (id: number) => `Phrase s${id} alpha beta gamma delta epsilon zeta eta theta iota fin.`;

/** `pageCount` pages de `perPage` phrases, sans aucun saut de ligne, comme un PDF extrait. */
function pdfLike(pageCount: number, perPage: number): DocumentPage[] {
  return Array.from({ length: pageCount }, (_, p) => ({
    pageNumber: p + 1,
    text: Array.from({ length: perPage }, (_, s) => sentence(p * perPage + s + 1)).join(' '),
  }));
}

const words = (text: string) => text.match(/\S+/g) ?? [];
const ids = (text: string) => [...text.matchAll(/\bs(\d+)\b/g)].map((m) => Number(m[1]));
/** Le contenu d'un extrait sans son préfixe de contexte « [Doc: … ] ». */
const body = (chunk: DocumentChunk) => chunk.content.replace(/^\[Doc: [^\]]*\]\n\n/, '');
const chunkPdf = (pages: DocumentPage[]) =>
  new AdaptiveChunker(CHUNKING_CONFIGS.cpuOptimized).createChunks(pages, 'doc', { title: 'Titre du document' });

/** Pour chaque extrait, le numéro de la première phrase qui lui est propre (hors recouvrement). */
function firstOwnSentence(chunks: DocumentChunk[]): number[] {
  let seen = 0;
  return chunks.map((chunk) => {
    const own = ids(body(chunk)).filter((id) => id > seen);
    seen = Math.max(seen, ...ids(body(chunk)));
    return own[0];
  });
}

describe('AdaptiveChunker — taille des extraits (#157)', () => {
  it('ne dépasse jamais la limite, même quand une page entière tient en une ligne de 400 mots', () => {
    const pages = pdfLike(6, 34); // 34 phrases × 12 mots = 408 mots par page
    expect(words(pages[0].text).length).toBeGreaterThan(MAX);

    const chunks = chunkPdf(pages);

    expect(chunks.length).toBeGreaterThan(pages.length);
    for (const chunk of chunks) expect(words(body(chunk)).length).toBeLessThanOrEqual(MAX);
  });

  it('découpe aussi un bloc sans ponctuation, sans perdre un mot', () => {
    const table = Array.from({ length: 700 }, (_, i) => `m${i}`).join(' ');

    const chunks = new AdaptiveChunker(CHUNKING_CONFIGS.cpuOptimized).createChunks(
      [{ pageNumber: 1, text: table }],
      'doc'
    );

    for (const chunk of chunks) expect(words(chunk.content).length).toBeLessThanOrEqual(MAX);
    expect(chunks.flatMap((chunk) => words(chunk.content)).join(' ')).toBe(table);
  });

  it('relie deux extraits consécutifs par un recouvrement', () => {
    const chunks = chunkPdf(pdfLike(3, 34));

    for (let i = 1; i < chunks.length; i++) {
      const previous = new Set(ids(body(chunks[i - 1])));
      expect(ids(body(chunks[i])).some((id) => previous.has(id))).toBe(true);
    }
  });
});

describe('AdaptiveChunker — rien ne se perd', () => {
  it('garde toutes les phrases, dans l’ordre', () => {
    const pages = pdfLike(8, 34);
    const chunks = chunkPdf(pages);

    const kept = [...new Set(chunks.flatMap((chunk) => ids(body(chunk))))];
    expect(kept).toEqual(Array.from({ length: 8 * 34 }, (_, i) => i + 1));
  });

  it('garde entière une phrase à cheval sur deux pages', () => {
    const straddling = 'Cette phrase commence en bas de page et se termine en haut de la suivante.';
    const [head, tail] = [straddling.slice(0, 40), straddling.slice(40)];
    const pages: DocumentPage[] = [
      { pageNumber: 1, text: `${pdfLike(1, 30)[0].text} ${head.trim()}` },
      { pageNumber: 2, text: `${tail.trim()} ${pdfLike(1, 30)[0].text}` },
    ];

    const chunks = chunkPdf(pages);

    expect(chunks.some((chunk) => body(chunk).includes(straddling))).toBe(true);
  });

  it('garde ce qui précède le premier titre', () => {
    const text = ['Préambule du document avant tout titre.', '1. Introduction', 'Le corps du texte commence ici.'].join('\n');

    const chunks = chunkPdf([{ pageNumber: 1, text }]);

    expect(chunks.some((chunk) => chunk.content.includes('Préambule du document'))).toBe(true);
    expect(chunks.some((chunk) => chunk.metadata?.sectionTitle === 'Introduction')).toBe(true);
  });

  it('écarte toujours la bibliographie, comme avant', () => {
    const text = ['1. Introduction', 'Le corps du texte.', 'REFERENCES', 'Dupont, Jean. Un titre. 2020.'].join('\n');

    const chunks = chunkPdf([{ pageNumber: 1, text }]);

    expect(chunks.some((chunk) => chunk.content.includes('Le corps du texte'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('Dupont'))).toBe(false);
  });
});

describe('AdaptiveChunker — page et position d’un extrait (#160)', () => {
  const PER_PAGE = 34;
  const pageOf = (id: number) => Math.ceil(id / PER_PAGE);

  it('annonce la page où commence le texte propre de l’extrait', () => {
    const chunks = chunkPdf(pdfLike(12, PER_PAGE));

    const firsts = firstOwnSentence(chunks);
    chunks.forEach((chunk, i) => expect(chunk.pageNumber).toBe(pageOf(firsts[i])));
  });

  it('ne dérive pas : au bout de quarante pages, la page annoncée est toujours la bonne', () => {
    const pages = pdfLike(40, PER_PAGE);
    const chunks = chunkPdf(pages);

    const firsts = firstOwnSentence(chunks);
    const last = chunks.length - 1;
    expect(chunks[last].pageNumber).toBe(pageOf(firsts[last]));
    expect(chunks[last].pageNumber).toBeGreaterThanOrEqual(39);
    // Avant correction : une page d'avance tous les huit à dix extraits.
    const wrong = chunks.filter((chunk, i) => chunk.pageNumber !== pageOf(firsts[i]));
    expect(wrong).toHaveLength(0);
  });

  it('enregistre une position qui désigne bien le texte de l’extrait', () => {
    const pages = pdfLike(5, PER_PAGE);
    const fullText = pages.map((page) => page.text).join('\n\n');
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

    for (const chunk of chunkPdf(pages)) {
      const own = flat(fullText.slice(chunk.startPosition, chunk.endPosition));
      expect(own.length).toBeGreaterThan(0);
      expect(flat(body(chunk)).endsWith(own)).toBe(true);
    }
  });

  it(`compte ${WORDS_PER_SENTENCE} mots par phrase d’essai`, () => {
    expect(words(sentence(1))).toHaveLength(WORDS_PER_SENTENCE);
  });
});
