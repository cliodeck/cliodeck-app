/**
 * Tests for TextPreprocessor OCR cleanup.
 *
 * Regression coverage for the "fragmented letters" fix: a regex that
 * reconstructs sequences like "O z f i c i a l" into "Official" without
 * damaging legitimate short words in normal prose.
 *
 * Inputs were sampled from real OCR output on the Lester diary corpus
 * (Zotero attachments indexed in /home/inactinique/Documents/2026-04-29_Lester/).
 */

import { describe, it, expect } from 'vitest';
import { TextPreprocessor } from '../TextPreprocessor.js';

const pre = new TextPreprocessor();

describe('TextPreprocessor.cleanOCRArtifacts — fragmented-letter fix', () => {
  describe('positive: reconstruct fragmented words', () => {
    it('collapses a fragmented word inside a sentence', () => {
      // "Ozficial" rather than "Official" because the OCR replaced "ff"
      // with a single "z" — the regex can only close the spaces, not
      // restore missing letters. Ozficial is still far better for
      // embedding than "O z f i c i a l".
      const input = 'The O z f i c i a l calls this morning.';
      const out = pre.cleanOCRArtifacts(input);
      expect(out).toContain('Ozficial');
      expect(out).not.toMatch(/O\s+z\s+f/);
    });

    it('recollects a 5-letter greeting', () => {
      expect(pre.cleanOCRArtifacts('H e l l o')).toBe('Hello');
    });

    it('recollects common OCR-split words seen in the corpus', () => {
      expect(pre.cleanOCRArtifacts('c o r d i a l')).toBe('cordial');
      expect(pre.cleanOCRArtifacts('w i f e')).toBe('wife');
      expect(pre.cleanOCRArtifacts('s e n t r i e s')).toBe('sentries');
    });

    it('handles punctuation attached to the fragmented word', () => {
      // Leading/trailing whitespace around brackets is preserved; only
      // the letter run itself is collapsed.
      expect(pre.cleanOCRArtifacts('( p o l i c e )')).toBe('( police )');
      expect(pre.cleanOCRArtifacts('"H e l l o"')).toBe('"Hello"');
    });

    it('leaves adjacent normal words alone', () => {
      const input = 'he said H e l l o world today';
      const out = pre.cleanOCRArtifacts(input);
      expect(out).toBe('he said Hello world today');
    });
  });

  describe('negative: preserve normal prose', () => {
    it('does not merge short standalone words', () => {
      expect(pre.cleanOCRArtifacts('I am happy')).toBe('I am happy');
    });

    it('does not merge a chain of legitimate short words', () => {
      expect(pre.cleanOCRArtifacts('a cat is here')).toBe('a cat is here');
    });

    it('does not merge 2-letter OCR splits (documented limitation)', () => {
      // "di d" was "did" in the source, but we can't distinguish it
      // from legitimate "a b" pairs without context. Leaving it
      // untouched is the safe choice.
      expect(pre.cleanOCRArtifacts('He di d not wait')).toBe('He di d not wait');
    });

    it('does not merge single-letter pronouns surrounded by normal words', () => {
      expect(pre.cleanOCRArtifacts('I know what I said')).toBe('I know what I said');
    });
  });

  describe('edge cases', () => {
    it('is a no-op on empty input', () => {
      expect(pre.cleanOCRArtifacts('')).toBe('');
    });

    it('closes against punctuation on the right boundary', () => {
      expect(pre.cleanOCRArtifacts('r i f l e-bearing')).toContain('rifle-bearing');
    });

    it('collapses an ambiguous letter run into one token', () => {
      // Without word-separator information we can't know that
      // "H e l l o w o r l d" is meant to be two words — the entire
      // run collapses. Acceptable: "Helloworld" still tokenizes
      // closer to the source than ten single-letter tokens would.
      expect(pre.cleanOCRArtifacts('H e l l o w o r l d')).toBe('Helloworld');
    });
  });
});
