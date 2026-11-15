// @vitest-environment jsdom
/**
 * Les options et les résultats de la similarité appartiennent au projet (S18-1-25).
 *
 * Le filtre de collections de A restait posé dans B : ses clés n'y désignent rien, le main en fait
 * une liste blanche vide, et chaque segment de B affichait « 0 recommandation », sans filtre
 * visible ni effaçable. Les recommandations de A restaient aussi à l'écran, et « Insérer la
 * citation » mettait dans B des clés de A.
 *
 * Vrais store et registre ; seul le pont `window.electron.similarity` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimilarityStore, type SimilarityResult } from '../similarityStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';

const RESULT_A: SimilarityResult = {
  segmentId: 'seg-1',
  segment: { id: 'seg-1', content: 'La grève de 1934', startLine: 3, endLine: 5, type: 'paragraph' },
  recommendations: [
    { pdfId: 'pdf-a', title: 'Le préfet et la grève', authors: ['Dupont'], similarity: 0.8, chunkPreview: '…', zoteroKey: 'Dupont_1990' },
  ],
  analyzedAt: 1,
};

let similarity: Record<string, ReturnType<typeof vi.fn>>;
let originalElectron: unknown;

function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function switchTo(path: string | null): void {
  projectLifecycle.beginTransition();
  projectLifecycle.enter(path);
}

beforeEach(() => {
  originalElectron = (window as unknown as { electron?: unknown }).electron;
  similarity = {
    getAllResults: vi.fn(async () => ({ success: true, results: [] })),
    analyze: vi.fn(async () => ({ success: true, results: [] })),
    cancel: vi.fn(async () => ({ success: true })),
    onProgress: vi.fn(() => () => undefined),
  };
  (window as unknown as { electron: unknown }).electron = { similarity };
  projectLifecycle.enter('/projets/A');
  useSimilarityStore.setState({
    results: new Map([[RESULT_A.segmentId, RESULT_A]]),
    selectedSegmentId: 'seg-1',
    isAnalyzing: false,
    progress: { current: 4, total: 4, status: 'Analyse terminée', percentage: 100 },
    error: 'Ollama ne répond pas',
    isPanelOpen: true,
  });
  useSimilarityStore.getState().setOptions({ collectionFilter: ['GUERRE'], granularity: 'sentence', maxResults: 9 });
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electron?: unknown }).electron = originalElectron;
});

describe('similarityStore — changement de projet', () => {
  it('filtre de collections, résultats, sélection, progression et erreur de A disparaissent', () => {
    switchTo('/projets/B');

    const state = useSimilarityStore.getState();
    expect(state.options.collectionFilter).toBeNull();
    expect(state.results.size).toBe(0);
    expect(state.selectedSegmentId).toBeNull();
    expect(state.progress).toEqual({ current: 0, total: 0, status: '', percentage: 0 });
    expect(state.error).toBeNull();
  });

  it('les autres options et l’état du panneau restent : ils ne dépendent pas du projet', () => {
    switchTo('/projets/B');

    const state = useSimilarityStore.getState();
    expect(state.options.granularity).toBe('sentence');
    expect(state.options.maxResults).toBe(9);
    expect(state.isPanelOpen).toBe(true);
  });

  it('le même projet rouvert garde ses résultats et son filtre', () => {
    switchTo('/projets/A');

    expect(useSimilarityStore.getState().results.size).toBe(1);
    expect(useSimilarityStore.getState().options.collectionFilter).toEqual(['GUERRE']);
  });

  it('le cache de A, lu avant le passage à B et arrivé après, ne s’inscrit pas', async () => {
    const response = held<unknown>();
    similarity.getAllResults.mockReturnValueOnce(response.promise);
    const loading = useSimilarityStore.getState().loadCachedResults('# Texte de A', '/projets/A/document.md');

    switchTo('/projets/B');
    response.release({ success: true, results: [RESULT_A] });
    await loading;

    expect(useSimilarityStore.getState().results.size).toBe(0);
  });

  it('une analyse lancée dans A : ni sa progression ni ses résultats ne s’affichent dans B', async () => {
    let onProgress: ((p: unknown) => void) | null = null;
    similarity.onProgress.mockImplementation((cb: (p: unknown) => void) => {
      onProgress = cb;
      return () => undefined;
    });
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Texte de A', '/projets/A/document.md');
    expect(useSimilarityStore.getState().isAnalyzing).toBe(true);

    switchTo('/projets/B');
    onProgress!({ current: 2, total: 4, status: 'Segment 2', percentage: 50 });
    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    const state = useSimilarityStore.getState();
    expect(state.isAnalyzing).toBe(false);
    expect(state.progress.percentage).toBe(0);
    expect(state.results.size).toBe(0);
    // L'analyse de A ne tourne plus pour rien dans le main.
    expect(similarity.cancel).toHaveBeenCalledTimes(1);
  });

  it('l’analyse de A annulée par la bascule : son échec ne s’affiche pas dans B', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Texte de A', '/projets/A/document.md');

    switchTo('/projets/B');
    response.release({ success: false, error: 'Analysis cancelled by user' });
    await analysing;

    expect(useSimilarityStore.getState().error).toBeNull();
    expect(useSimilarityStore.getState().isAnalyzing).toBe(false);
  });

  it('témoin : le cache lu dans le même projet s’inscrit', async () => {
    useSimilarityStore.setState({ results: new Map() });
    similarity.getAllResults.mockResolvedValueOnce({ success: true, results: [RESULT_A] });

    await useSimilarityStore.getState().loadCachedResults('La grève de 1934', '/projets/A/document.md');

    expect(useSimilarityStore.getState().results.size).toBe(1);
  });
});

describe('similarityStore — le document ouvert (S13-1-3)', () => {
  it('deux relectures en vol : seule la dernière s’affiche, même arrivée avant l’autre', async () => {
    useSimilarityStore.setState({ results: new Map() });
    const chapter1 = held<unknown>();
    const chapter2 = held<unknown>();
    similarity.getAllResults.mockReturnValueOnce(chapter1.promise).mockReturnValueOnce(chapter2.promise);

    const first = useSimilarityStore.getState().loadCachedResults('# Chapitre 1', '/projets/A/chapters/01.md');
    const second = useSimilarityStore.getState().loadCachedResults('# Chapitre 2', '/projets/A/chapters/02.md');
    chapter2.release({ success: true, results: [] });
    await second;
    chapter1.release({ success: true, results: [RESULT_A] });
    await first;

    expect(useSimilarityStore.getState().results.size).toBe(0);
  });

  it('le fichier du document part au main avec son texte, à l’analyse comme à la relecture', async () => {
    await useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('Sans nom', null);

    expect(similarity.analyze).toHaveBeenCalledWith('# Chapitre 1', expect.any(Object), '/projets/A/chapters/01.md');
    expect(similarity.getAllResults.mock.calls).toEqual([
      ['# Chapitre 1', '/projets/A/chapters/01.md'],
      ['Sans nom', null],
    ]);
  });

  it('une analyse finie après l’ouverture d’un autre document relit le cache pour celui-ci, texte et fichier', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('# Chapitre 2', '/projets/A/chapters/02.md');
    similarity.getAllResults.mockClear();

    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    await vi.waitFor(() =>
      expect(similarity.getAllResults).toHaveBeenCalledWith('# Chapitre 2', '/projets/A/chapters/02.md')
    );
    expect(useSimilarityStore.getState().results.size).toBe(0);
  });

  // Revue de L11-2 : le même document relu pendant l'analyse (panneau refermé et rouvert, aller et
  // retour d'un chapitre à l'autre). Relire le cache à la fin ne rendait rien quand le corpus avait
  // changé entre-temps, ou quand le cache n'avait pas pu s'écrire : des minutes de reclassement
  // perdues, l'écran vide et « Analyser le document ».
  it('le même document relu pendant l’analyse : ses résultats s’affichent, même si le cache n’en rend plus', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('# Chapitre 1', '/projets/A/chapters/01.md');
    similarity.getAllResults.mockClear();

    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    expect(useSimilarityStore.getState().results.size).toBe(1);
    expect(useSimilarityStore.getState().isAnalyzing).toBe(false);
    expect(similarity.getAllResults).not.toHaveBeenCalled();
  });

  it('le même document retouché puis relu pendant l’analyse : ses résultats s’affichent', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('# Chapitre 1\n\nUn ajout.', '/projets/A/chapters/01.md');

    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    expect(useSimilarityStore.getState().results.size).toBe(1);
  });

  it('« Enregistrer sous » pendant l’analyse, même texte : ses résultats s’affichent', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    await useSimilarityStore.getState().loadCachedResults('# Chapitre 1', '/projets/A/copie.md');

    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    expect(useSimilarityStore.getState().results.size).toBe(1);
  });

  it('un document sans nom relu à son texte exact pendant l’analyse : ses résultats s’affichent', async () => {
    const response = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    const analysing = useSimilarityStore.getState().analyze('Sans nom', null);
    await useSimilarityStore.getState().loadCachedResults('Sans nom', null);

    response.release({ success: true, results: [RESULT_A] });
    await analysing;

    expect(useSimilarityStore.getState().results.size).toBe(1);
  });

  it('une relecture du même document partie avant la fin de l’analyse, arrivée après : les résultats de l’analyse restent', async () => {
    const response = held<unknown>();
    const reread = held<unknown>();
    similarity.analyze.mockReturnValueOnce(response.promise);
    similarity.getAllResults.mockReturnValueOnce(reread.promise);
    const analysing = useSimilarityStore.getState().analyze('# Chapitre 1', '/projets/A/chapters/01.md');
    const rereading = useSimilarityStore.getState().loadCachedResults('# Chapitre 1', '/projets/A/chapters/01.md');

    response.release({ success: true, results: [RESULT_A] });
    await analysing;
    // Lue avant que l'analyse écrive le cache : elle ne sait rien de ses résultats.
    reread.release({ success: true, results: [] });
    await rereading;

    expect(useSimilarityStore.getState().results.size).toBe(1);
  });

  it('une relecture qui échoue vide la liste : les résultats d’un autre document ne restent pas', async () => {
    similarity.getAllResults.mockResolvedValueOnce({ success: false, error: 'Validation failed' });

    await useSimilarityStore.getState().loadCachedResults('# Chapitre 2', '/projets/A/chapters/02.md');

    expect(useSimilarityStore.getState().results.size).toBe(0);
  });
});
