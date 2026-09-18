/**
 * Un PDF sans couche de texte garde, en base, la trace de sa densité : c'est
 * elle qui déclenche l'avertissement de l'app et que lit le bilan de santé
 * (#132).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import { VectorStore } from '../core/vector-store/VectorStore';
import { PDFIndexer } from '../core/pdf/PDFIndexer';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function embed(content: string): Promise<Float32Array> {
  const v = new Float32Array(8);
  for (let i = 0; i < content.length; i++) v[i % 8] += content.charCodeAt(i) / 1000;
  return v;
}
const META = { title: 'The Remaking of Memory', author: 'Wang', year: '2025' };

describe.skipIf(!sqliteAvailable)('PDF sans texte : densité enregistrée', () => {
  let dir: string;
  let store: VectorStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-sans-texte-'));
    store = new VectorStore(dir);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('un PDF image est indexé, et marqué lowText dans ses métadonnées persistées', async () => {
    const extract = async () => ({ pages: Array.from({ length: 13 }, (_, i) => ({ pageNumber: i + 1, text: '' })), metadata: {}, title: META.title });
    const indexer = new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);
    const document = await indexer.indexPDF('/projet/PDFs/Wang_2025.pdf', 'Wang_2025', undefined, META);

    expect(document.metadata.textDensity).toEqual({ charsPerPage: 0, lowText: true });
    expect(store.getDocument(document.id)?.metadata.textDensity).toEqual({ charsPerPage: 0, lowText: true });
  });

  it('un PDF de texte ne l’est pas', async () => {
    const text = 'Digital history requires historians to reflect on the transformations their tools impose on sources. '.repeat(20);
    const extract = async () => ({ pages: [{ pageNumber: 1, text }], metadata: {}, title: 'Texte' });
    const indexer = new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);
    const document = await indexer.indexPDF('/projet/PDFs/Texte.pdf', 'Texte_2020', undefined, META);
    expect(document.metadata.textDensity?.lowText).toBe(false);
  });
});
