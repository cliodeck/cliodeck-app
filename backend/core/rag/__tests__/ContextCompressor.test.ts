import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextCompressor } from '../ContextCompressor';

// Suppress console.log during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

function makeChunk(content: string, overrides: Partial<{
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  similarity: number;
  embedding: number[];
}> = {}) {
  return {
    content,
    documentId: overrides.documentId ?? 'doc-1',
    documentTitle: overrides.documentTitle ?? 'Test Document',
    pageNumber: overrides.pageNumber ?? 1,
    similarity: overrides.similarity ?? 0.9,
    embedding: overrides.embedding,
  };
}

function makeChunksOfSize(totalChars: number, chunkCount: number): ReturnType<typeof makeChunk>[] {
  const charsPerChunk = Math.ceil(totalChars / chunkCount);
  return Array.from({ length: chunkCount }, (_, i) =>
    makeChunk('A'.repeat(charsPerChunk), {
      documentId: `doc-${i}`,
      documentTitle: `Document ${i}`,
      pageNumber: i + 1,
      similarity: 0.95 - i * 0.05,
    }),
  );
}

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;

  beforeEach(() => {
    compressor = new ContextCompressor();
  });

  describe('compress()', () => {
    it('returns chunks unchanged when total size <= 10000 (none-small strategy)', () => {
      const chunks = [
        makeChunk('Short chunk content about history.'),
        makeChunk('Another short chunk about World War II.'),
      ];

      const result = compressor.compress(chunks, 'World War II');

      expect(result.stats.strategy).toBe('none-small');
      expect(result.stats.reductionPercent).toBe(0);
      expect(result.chunks.length).toBe(2);
      expect(result.chunks).toEqual(chunks);
    });

    it('applies light-deduplication for 15k-25k char contexts', () => {
      // Create chunks totaling ~18000 chars, some duplicated
      const uniqueContent1 = 'The French Revolution began in 1789. ' + 'X'.repeat(4000);
      const uniqueContent2 = 'Napoleon crowned himself emperor in 1804. ' + 'Y'.repeat(4000);
      const duplicateContent = 'The French Revolution began in 1789. ' + 'X'.repeat(4000); // same as #1

      const chunks = [
        makeChunk(uniqueContent1, { documentTitle: 'Doc A', pageNumber: 1 }),
        makeChunk(uniqueContent2, { documentTitle: 'Doc B', pageNumber: 2 }),
        makeChunk(duplicateContent, { documentTitle: 'Doc C', pageNumber: 3 }),
        makeChunk('Z'.repeat(6000), { documentTitle: 'Doc D', pageNumber: 4 }),
      ];

      const result = compressor.compress(chunks, 'French Revolution');

      expect(result.stats.strategy).toBe('light-deduplication');
      // The duplicate should have been removed
      expect(result.chunks.length).toBeLessThan(chunks.length);
    });

    it('applies medium-dedup-extraction for 25k-35k char contexts', () => {
      const chunks = makeChunksOfSize(30000, 6);

      const result = compressor.compress(chunks, 'test query keywords');

      expect(result.stats.strategy).toBe('medium-dedup-extraction');
      expect(result.stats.originalSize).toBeGreaterThan(25000);
    });

    it('applies aggressive-full for >35k char contexts', () => {
      const chunks = makeChunksOfSize(40000, 8);

      const result = compressor.compress(chunks, 'test query');

      expect(result.stats.strategy).toBe('aggressive-full');
      expect(result.stats.compressedSize).toBeLessThan(result.stats.originalSize);
    });

    it('reports accurate stats', () => {
      const chunks = [makeChunk('Hello world')];
      const result = compressor.compress(chunks, 'test');

      expect(result.stats.originalChunks).toBe(1);
      expect(result.stats.compressedChunks).toBe(1);
      expect(result.stats.originalSize).toBe(11);
      expect(result.stats.compressedSize).toBe(11);
    });

    it('handles empty chunks array', () => {
      const result = compressor.compress([], 'test query');

      expect(result.chunks).toEqual([]);
      expect(result.stats.originalSize).toBe(0);
      expect(result.stats.strategy).toBe('none-small');
    });

    it('respects maxChars parameter', () => {
      // Create a very large context that needs aggressive compression
      const chunks = makeChunksOfSize(50000, 10);
      const maxChars = 15000;

      const result = compressor.compress(chunks, 'test query', maxChars);

      expect(result.stats.strategy).toBe('aggressive-full');
    });
  });

  describe('extractKeywords()', () => {
    // Access private method for testing
    const getKeywords = (query: string) => {
      return (compressor as any)['extractKeywords'](query);
    };

    it('extracts meaningful words from query', () => {
      const keywords = getKeywords('What is the history of World War II?');
      expect(keywords).toContain('history');
      expect(keywords).toContain('world');
      expect(keywords).toContain('war');
    });

    it('filters out French stopwords', () => {
      const keywords = getKeywords('Quels sont les impacts de la Révolution française?');
      expect(keywords).not.toContain('les');
      expect(keywords).not.toContain('de');
      expect(keywords).not.toContain('la');
      expect(keywords).toContain('impacts');
    });

    it('filters out English stopwords', () => {
      const keywords = getKeywords('What is the meaning of this document?');
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('of');
      expect(keywords).not.toContain('is');
      expect(keywords).toContain('meaning');
      expect(keywords).toContain('document');
    });

    it('filters out words with 2 or fewer characters', () => {
      const keywords = getKeywords('I am at a big house');
      expect(keywords).not.toContain('am');
      expect(keywords).not.toContain('at');
      expect(keywords).toContain('big');
      expect(keywords).toContain('house');
    });

    it('extracts quoted phrases', () => {
      const keywords = getKeywords('Find documents about "World War II" and "Cold War"');
      expect(keywords).toContain('World War II');
      expect(keywords).toContain('Cold War');
    });

    it('returns unique keywords', () => {
      const keywords = getKeywords('history history history');
      const unique = [...new Set(keywords)];
      expect(keywords.length).toBe(unique.length);
    });
  });

  describe('deduplicateSemanticChunks()', () => {
    const deduplicate = (chunks: any[], threshold: number) => {
      return (compressor as any)['deduplicateSemanticChunks'](chunks, threshold);
    };

    it('removes chunks with high text similarity', () => {
      const chunks = [
        makeChunk('The quick brown fox jumps over the lazy dog'),
        makeChunk('The quick brown fox jumps over the lazy dog'), // exact duplicate
        makeChunk('Something completely different about quantum physics'),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(2);
    });

    it('keeps all chunks when they are dissimilar', () => {
      const chunks = [
        makeChunk('The French Revolution changed European politics forever.'),
        makeChunk('Quantum computing uses qubits instead of classical bits.'),
        makeChunk('Marine biology studies organisms living in the ocean.'),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(3);
    });

    it('handles single chunk', () => {
      const chunks = [makeChunk('Only one chunk here')];
      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(1);
    });

    it('handles empty array', () => {
      const result = deduplicate([], 0.85);
      expect(result.length).toBe(0);
    });

    // Dédup INTRA-document : un même passage cité par deux documents
    // différents est une corroboration, pas un doublon.
    it('keeps identical passages when they come from different documents', () => {
      const passage = 'Le télégramme du 3 août 1914 annonce la mobilisation générale.';
      const chunks = [
        makeChunk(passage, { documentId: 'doc-archives' }),
        makeChunk(passage, { documentId: 'doc-memoires' }),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(2);
    });

    it('still removes overlapping windows within the same document', () => {
      const passage = 'Le télégramme du 3 août 1914 annonce la mobilisation générale.';
      const chunks = [
        makeChunk(passage, { documentId: 'doc-archives', pageNumber: 1 }),
        makeChunk(passage, { documentId: 'doc-archives', pageNumber: 1 }),
      ];

      const result = deduplicate(chunks, 0.85);
      expect(result.length).toBe(1);
    });
  });

  describe('selectTopKChunks()', () => {
    const selectTopK = (chunks: any[], k: number) => {
      return (compressor as any)['selectTopKChunks'](chunks, k);
    };

    it('selects chunks with highest similarity scores', () => {
      const chunks = [
        makeChunk('Low similarity', { similarity: 0.3 }),
        makeChunk('High similarity', { similarity: 0.95 }),
        makeChunk('Medium similarity', { similarity: 0.7 }),
        makeChunk('Very high similarity', { similarity: 0.99 }),
      ];

      const result = selectTopK(chunks, 2);
      expect(result.length).toBe(2);
      expect(result[0].similarity).toBe(0.99);
      expect(result[1].similarity).toBe(0.95);
    });

    it('returns all chunks when k >= chunk count', () => {
      const chunks = [
        makeChunk('A', { similarity: 0.5 }),
        makeChunk('B', { similarity: 0.8 }),
      ];

      const result = selectTopK(chunks, 5);
      expect(result.length).toBe(2);
    });
  });

  describe('calculateTextSimilarity()', () => {
    const calcSimilarity = (a: string, b: string) => {
      return (compressor as any)['calculateTextSimilarity'](a, b);
    };

    it('returns 1 for identical texts', () => {
      expect(calcSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 0 for completely different texts', () => {
      expect(calcSimilarity('aaa bbb ccc', 'xxx yyy zzz')).toBe(0);
    });

    it('returns a value between 0 and 1 for partially similar texts', () => {
      const sim = calcSimilarity('the quick brown fox', 'the slow brown fox');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });
  });

  describe('splitIntoSentences()', () => {
    const splitSentences = (text: string) => {
      return (compressor as any)['splitIntoSentences'](text);
    };

    it('splits text at sentence boundaries', () => {
      const sentences = splitSentences('First sentence. Second sentence. Third one.');
      expect(sentences.length).toBe(3);
    });

    it('handles question marks and exclamation marks', () => {
      const sentences = splitSentences('Is this a question? Yes it is! Good.');
      expect(sentences.length).toBe(3);
    });

    it('returns empty array for empty string', () => {
      const sentences = splitSentences('');
      expect(sentences.length).toBe(0);
    });

    // Régressions français : abréviations et majuscules accentuées.
    it('does not split after French abbreviations (M., cf., p., vol.)', () => {
      const sentences = splitSentences(
        'Selon M. Clemenceau, la guerre continue. Cf. p. 12 du vol. 3.'
      );
      expect(sentences.length).toBe(2);
      expect(sentences[0]).toBe('Selon M. Clemenceau, la guerre continue.');
      expect(sentences[1]).toBe('Cf. p. 12 du vol. 3.');
    });

    it('splits before accented capitals (É, À…)', () => {
      const sentences = splitSentences("Bataille perdue. Épuisée, l'armée recule.");
      expect(sentences.length).toBe(2);
      expect(sentences[1]).toBe("Épuisée, l'armée recule.");
    });
  });

  describe('extractKeywords() — accents (régression)', () => {
    const getKeywords = (query: string) => {
      return (compressor as any)['extractKeywords'](query);
    };

    it('keeps accented French terms intact', () => {
      const keywords = getKeywords(
        "L'armée coloniale pendant la Révolution : décolonisation et mémoire"
      );
      expect(keywords).toContain('révolution');
      expect(keywords).toContain('décolonisation');
      expect(keywords).toContain('mémoire');
      expect(keywords).not.toContain('volution');
      expect(keywords).not.toContain('moire');
    });
  });

  describe('compress() — clé de correspondance et zone 10-15k', () => {
    it('transporte la clé opaque `key` jusqu’aux chunks compressés', () => {
      const chunks = Array.from({ length: 6 }, (_, i) => ({
        ...makeChunk(`Contenu unique numéro ${i}. ` + `mot${i} `.repeat(500), {
          documentId: `doc-${i}`,
        }),
        key: `k-${i}`,
      }));
      const result = compressor.compress(chunks as any, 'contenu unique');
      for (const c of result.chunks) {
        expect((c as any).key).toMatch(/^k-\d$/);
      }
    });

    it('applique la dédup légère dès 10k (ancienne zone morte)', () => {
      const chunks = makeChunksOfSize(12000, 4);
      const result = compressor.compress(chunks, 'test');
      expect(result.stats.strategy).toBe('light-deduplication');
    });
  });

  /**
   * L'extrait montré à l'historien DOIT être le texte de la source. Ces
   * trois régressions le fabriquaient : un tableau pulvérisé puis
   * recomposé, des phrases éloignées collées sans marque de coupe, et un
   * repli qui rendait les phrases dans l'ordre du score.
   */
  describe('fidélité de l’extrait', () => {
    /** Force le chemin d'extraction de phrases (stratégie `medium-*`). */
    function withFiller(chunk: ReturnType<typeof makeChunk>) {
      const filler = Array.from({ length: 40 }, (_, i) =>
        makeChunk('Remplissage sans aucun rapport. '.repeat(30), {
          documentId: `filler-${i}`,
        }),
      );
      return [chunk, ...filler];
    }

    const TABLE = [
      "Le tableau suivant récapitule les effectifs de l'usine.",
      '',
      '| Année | Ouvriers | Employés |',
      '|---|---|---|',
      '| 1919 | 1200 | 300 |',
      '| 1920 | 1450 | 340 |',
      '',
      'Ces chiffres proviennent du registre du personnel.',
    ].join('\n');

    it('ne découpe pas un tableau markdown', () => {
      const target = makeChunk(TABLE, { documentId: 'cible' });
      const result = compressor.compress(
        withFiller(target),
        'effectifs ouvriers',
        8000,
      );
      const out = result.chunks.find((c) => c.documentId === 'cible');

      // Le tableau ressort intact — chiffres compris.
      expect(out?.content).toBe(TABLE);
      expect(out?.content).toContain('| 1919 | 1200 | 300 |');
      expect(out?.content).toContain('| 1920 | 1450 | 340 |');
    });

    it('ne découpe pas un bloc de code', () => {
      const code = ['Voici la requête employée.', '```sql', 'SELECT * FROM x;', '```'].join('\n');
      const target = makeChunk(code, { documentId: 'cible' });
      const result = compressor.compress(withFiller(target), 'requête', 8000);

      expect(result.chunks.find((c) => c.documentId === 'cible')?.content).toBe(code);
    });

    it('ne coupe pas sur un pipe isolé en prose', () => {
      // Le garde structurel exige DEUX lignes de tableau : une prose
      // contenant un seul `|` atteint donc le découpage en phrases, et
      // c'est là que l'ancien séparateur `|` la tranchait en plein milieu.
      const prose =
        "Le registre porte la mention « entrée | sortie » en tête de colonne. " +
        'Cette notation revient dans les trois volumes conservés. ' +
        "Elle disparaît après 1921 sans explication connue à ce jour.";
      const target = makeChunk(prose, { documentId: 'cible' });
      const result = compressor.compress(withFiller(target), 'registre mention', 8000);
      const out = result.chunks.find((c) => c.documentId === 'cible')?.content ?? '';

      // La phrase qui porte le pipe doit rester entière si elle est retenue.
      if (out.includes('entrée')) {
        expect(out).toContain('« entrée | sortie »');
      }
      // Et en aucun cas le texte ne doit contenir de fragment orphelin
      // commençant par la seconde moitié de la cellule.
      expect(out).not.toMatch(/(^|\[…\] )sortie »/);
    });

    it('marque les coupes par […] et garde l’ordre du document', () => {
      const prose = [
        "Les ouvriers réclament quinze centimes de l'heure.",
        'Le préfet télégraphie au ministre dès le matin.',
        "La négociation s'ouvre le 12 mars dans la salle du conseil.",
        'Elle échoue en moins de deux heures.',
        'Le mouvement se durcit alors et gagne les fonderies.',
        'La troupe est appelée le 15 mars.',
      ].join(' ');
      const target = makeChunk(prose, { documentId: 'cible' });
      const result = compressor.compress(
        withFiller(target),
        'négociation ouvriers',
        8000,
      );
      const out = result.chunks.find((c) => c.documentId === 'cible')?.content ?? '';

      // Des phrases ont bien été retirées…
      expect(out.length).toBeLessThan(prose.length);
      // …et la coupe est signalée, au lieu de produire une fausse citation continue.
      expect(out).toContain('[…]');

      // Les phrases conservées restent dans l'ordre du document.
      const positions = [
        "Les ouvriers réclament quinze centimes de l'heure.",
        "La négociation s'ouvre le 12 mars dans la salle du conseil.",
        'La troupe est appelée le 15 mars.',
      ]
        .map((s) => out.indexOf(s))
        .filter((i) => i >= 0);
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    });
  });
});
