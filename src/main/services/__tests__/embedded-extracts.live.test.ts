/**
 * Les extraits que le modèle embarqué lit, mesurés au vrai tokeniseur (revue de L08-4) : sauté
 * quand aucun modèle n'est donné.
 *
 *   CLIODECK_TEST_GGUF=/chemin/qwen2.5-0.5b-instruct-q4_k_m.gguf \
 *     npx vitest run src/main/services/__tests__/embedded-extracts.live.test.ts
 *
 * Le plafond de 4 extraits suppose le mode État de l'art et un français propre. Des indications
 * du projet (`context.md`) ou un texte d'OCR en laissent tenir moins : la coupe des consignes
 * effaçait alors les derniers extraits, que le panneau des sources montrait quand même. Ici, les
 * scénarios de la revue, sur le tokeniseur du petit Qwen 2.5 0,5B (pas le modèle de production :
 * les comptes de jetons de la famille Qwen 2.5 sont ceux de son tokeniseur, commun aux tailles).
 * `CLIODECK_TEST_REPORT` : fichier où écrire les comptes mesurés.
 *
 * Le modèle est libéré à la fin (A16). Jamais `llama.dispose()`.
 */
import { appendFileSync, existsSync } from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EmbeddedProvider } from '../../../../backend/core/llm/providers/embedded.js';
import { EMBEDDED_CONTEXT_SIZE, embeddedInputBudget } from '../../../../backend/core/llm/context-windows.js';
import { BUILTIN_MODES } from '../../../../backend/core/modes/built-in-modes.js';
import { manuscriptSlots } from '../retrieval-quota.js';
import { fitExtractsToWindow, formatContextAsSystemPrompt, type ReadExtracts } from '../fusion-chat-service.js';
import type { MultiSourceSearchResult } from '../retrieval-service.js';

const GGUF = process.env.CLIODECK_TEST_GGUF;
const REPORT = process.env.CLIODECK_TEST_REPORT;
const available = !!GGUF && existsSync(GGUF);

const SENTENCES = [
  'La grève des dockers du Havre éclate en août 1910, lorsque la Compagnie générale transatlantique impose le travail de nuit sans majoration de salaire.',
  'Le syndicat des ouvriers du port, affilié à la CGT, réclame la journée de dix heures et la suppression du marchandage à la tâche.',
  'Jules Durand, secrétaire du syndicat des charbonniers, est arrêté en septembre 1910 et accusé d’avoir incité au meurtre d’un contremaître.',
  'L’historiographie des années 1970 insiste sur la combativité ouvrière et sur la répression patronale coordonnée avec l’État.',
  'Des travaux plus récents nuancent ce tableau en montrant la fragmentation des métiers portuaires et la concurrence entre équipes.',
];

/** Un extrait de 1 500 caractères, comme ceux que garde `formatContextAsSystemPrompt`. */
const prose = (i: number): string => {
  let text = '';
  for (let k = 0; text.length < 1500; k++) text += `${SENTENCES[(i + k) % SENTENCES.length]} `;
  return text.slice(0, 1500);
};

/** Le même extrait, abîmé comme un OCR d'archives : lettres confondues, ponctuation parasite. */
const ocr = (i: number): string =>
  prose(i)
    .replace(/e/g, 'c')
    .replace(/ /g, ' ,')
    .replace(/[aiou]/g, (c, at: number) => (at % 7 === 0 ? 'ii' : c))
    .slice(0, 1500);

const hitOf = (i: number, content: string): MultiSourceSearchResult =>
  ({
    chunk: { id: `c-${i}`, content, documentId: `doc-${i}`, chunkIndex: 0, pageNumber: 10 + i },
    document: { id: `doc-${i}`, title: `Les dockers du Havre, volume ${i}`, author: 'Pigenet', year: '1990' },
    similarity: 0.9 - i / 100,
    sourceType: 'secondary',
  }) as unknown as MultiSourceSearchResult;

const MODE_FR = BUILTIN_MODES.find((m) => m.metadata.id === 'literature-review')?.systemPrompt.fr ?? '';
const QUESTION = 'Quelles sont les principales interprétations historiographiques de la grève de 1910 ?';
const HINTS = 'Projet : thèse sur les dockers du Havre (1900-1914). '.repeat(30);

describe.skipIf(!available)('extraits lus par le modèle embarqué réel (GGUF donné par CLIODECK_TEST_GGUF)', () => {
  const provider = new EmbeddedProvider({ modelPath: GGUF ?? '', modelId: 'qwen2.5-0.5b' });

  afterAll(async () => {
    await provider.dispose();
  });

  async function measure(label: string, fixedSystem: string[], contents: string[]) {
    const tokenizer = await provider.embeddedTokenizer();
    expect(tokenizer).not.toBeNull();
    if (!tokenizer) throw new Error('tokeniseur absent');
    const found: ReadExtracts = { hits: contents.map((c, i) => hitOf(i + 1, c)), own: [], notes: [] };
    const blocksFor = (read: ReadExtracts) => ({ systemPrompt: formatContextAsSystemPrompt(read.hits, 'fr') });
    const budget = embeddedInputBudget(EMBEDDED_CONTEXT_SIZE);
    const { read, blocks } = fitExtractsToWindow({
      found,
      blocksFor,
      fixedSystem,
      question: QUESTION,
      budget,
      tokenizer,
      bandsFor: (n) => ({ manuscript: manuscriptSlots(n) }),
    });
    const count = (text: string) => tokenizer.tokenize(text).length;
    const before = count([...fixedSystem, blocksFor(found).systemPrompt].join('\n\n')) + count(QUESTION);
    const after = count([...fixedSystem, blocks.systemPrompt].join('\n\n')) + count(QUESTION);
    const result = { label, budget, extractsFound: contents.length, extractsRead: read.hits.length, tokensBefore: before, tokensAfter: after };
    if (REPORT) appendFileSync(REPORT, `${JSON.stringify(result)}\n`);
    // Ce qui est montré tient en entier : la coupe des consignes n'aura rien à retirer.
    expect(after).toBeLessThanOrEqual(budget);
    return result;
  }

  it('mode État de l’art et 4 extraits de français propre : les 4 tiennent', async () => {
    const r = await measure('etat-de-l-art+4', [MODE_FR], [1, 2, 3, 4].map(prose));
    expect(r.extractsRead).toBe(4);
  }, 180_000);

  it('avec 1 600 caractères d’indications du projet : un extrait part avant d’être montré', async () => {
    const r = await measure('etat-de-l-art+context.md-1600+4', [MODE_FR, HINTS], [1, 2, 3, 4].map(prose));
    expect(r.tokensBefore).toBeGreaterThan(r.budget);
    expect(r.extractsRead).toBeLessThan(4);
    expect(r.extractsRead).toBeGreaterThan(0);
  }, 180_000);

  it('4 extraits d’OCR abîmé : ceux qui ne tiennent pas partent avant d’être montrés', async () => {
    const r = await measure('etat-de-l-art+4-ocr', [MODE_FR], [1, 2, 3, 4].map(ocr));
    expect(r.tokensBefore).toBeGreaterThan(r.budget);
    expect(r.extractsRead).toBeLessThan(4);
    expect(r.extractsRead).toBeGreaterThan(0);
  }, 180_000);
});
