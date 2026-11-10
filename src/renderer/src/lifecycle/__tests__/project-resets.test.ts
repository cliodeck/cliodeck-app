// @vitest-environment jsdom
/**
 * Ce que chaque store lié au projet remet à zéro quand l'écran passe à un autre projet (L03-4), et
 * ce qu'il garde : les préférences de l'auteur ne dépendent pas du projet.
 *
 * Les remises à zéro hors de `stores/` sont inscrites elles aussi (amendement A36) : le cache des
 * états de l'éditeur, que seul un abonnement au projectStore vidait, et les sources primaires, que
 * seul le panneau vidait, à son montage.
 *
 * Vrais stores et registre, pilotés comme le fait `projectStore` : `beginTransition` puis `enter`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { projectLifecycle } from '../projectLifecycle';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { idleBatchIndexing } from '../../stores/bibliography/indexingSlice';
import { useUsageJournalStore, type TodayView } from '../../stores/usageJournalStore';
import { useManuscriptStore } from '../../stores/manuscriptStore';
import { useSlidesStore } from '../../stores/slidesStore';
import { usePrimarySourcesStore } from '../../stores/primarySourcesStore';
import { editorStates } from '../../components/Editor/editor-state-memory';

const CITATION_A = { id: 'Dupont_1990', type: 'book', author: 'Dupont', year: '1990', title: 'Le préfet et la grève' };

function switchTo(path: string | null): void {
  projectLifecycle.beginTransition();
  projectLifecycle.enter(path);
}

beforeEach(() => {
  projectLifecycle.enter('/projets/A');
});

describe('bibliographie', () => {
  it('ce qui vient du projet A disparaît ; le tri et l’affichage des tags automatiques restent', () => {
    useBibliographyStore.setState({
      citations: [CITATION_A],
      filteredCitations: [CITATION_A],
      bibliographyProblem: { kind: 'missing', file: 'a.bib' },
      selectedCitationId: 'Dupont_1990',
      searchQuery: 'préfet',
      selectedTags: ['grève'],
      sortBy: 'year',
      sortOrder: 'desc',
      indexedFilePaths: new Set(['/projets/A/PDFs/dupont.pdf']),
      indexedBibtexKeys: new Set(['Dupont_1990']),
      batchIndexing: { isIndexing: true, current: 2, total: 5, skipped: 0, indexed: 1, errors: [] },
      readingNotes: [{ file: 'reading-notes/Dupont_1990.md', citekey: 'Dupont_1990', tags: ['à relire'] }],
      showAutomaticZoteroTags: true,
    });

    switchTo('/projets/B');

    const state = useBibliographyStore.getState();
    expect(state.citations).toEqual([]);
    expect(state.filteredCitations).toEqual([]);
    expect(state.bibliographyProblem).toBeNull();
    expect(state.selectedCitationId).toBeNull();
    expect(state.searchQuery).toBe('');
    expect(state.selectedTags).toEqual([]);
    expect([...state.indexedFilePaths]).toEqual([]);
    expect([...state.indexedBibtexKeys]).toEqual([]);
    expect(state.batchIndexing).toEqual(idleBatchIndexing());
    expect(state.readingNotes).toEqual([]);
    expect(state.getAllTags()).toEqual([]);
    expect(state.sortBy).toBe('year');
    expect(state.sortOrder).toBe('desc');
    expect(state.showAutomaticZoteroTags).toBe(true);
  });
});

describe('journal d’usage IA, plan du manuscrit, présentations', () => {
  it('le résumé du jour et les adjudications de A disparaissent', () => {
    useUsageJournalStore.setState({
      today: { summary: { from: 'a', to: 'b' }, decisions: [] } as unknown as TodayView,
      adjudications: { summary: { total: 3 }, draftCount: 1 } as never,
      error: 'Échec',
      errorCode: 'SAVE_FAILED',
      loading: true,
    });

    switchTo('/projets/B');

    const state = useUsageJournalStore.getState();
    expect(state.today).toBeNull();
    expect(state.adjudications).toBeNull();
    expect(state.error).toBeNull();
    expect(state.errorCode).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('le plan et les statistiques des chapitres de A disparaissent', () => {
    useManuscriptStore.setState({
      info: { 'chapters/01.md': { stats: { words: 10 } as never, outline: [] } },
      refreshing: true,
    });

    switchTo('/projets/B');

    expect(useManuscriptStore.getState().info).toEqual({});
    expect(useManuscriptStore.getState().refreshing).toBe(false);
  });

  it('le panneau de génération et l’aperçu des diapositives de A se ferment', () => {
    useSlidesStore.setState({ isPanelOpen: true, isPreviewOpen: true });

    switchTo('/projets/B');

    expect(useSlidesStore.getState().isPanelOpen).toBe(false);
    expect(useSlidesStore.getState().isPreviewOpen).toBe(false);
  });
});

describe('inscriptions hors de stores/ (A36)', () => {
  it('le cache des états de l’éditeur se vide, éditeur monté ou non', () => {
    editorStates.set('/projets/A/document.md', { json: {}, text: '# A', scrollTop: 120 });

    switchTo('/projets/B');

    expect(editorStates.size).toBe(0);
  });

  it('les sources primaires de A disparaissent, panneau monté ou non', () => {
    usePrimarySourcesStore.setState({
      tpyPath: '/archives/Danzig.tpy',
      projectInfo: { name: 'Archives Danzig', itemCount: 1, lastModified: '2026-11-01', isWatching: false },
      searchQuery: 'préfet',
      selectedCollection: 'Carton 12',
    });

    switchTo('/projets/B');

    const state = usePrimarySourcesStore.getState();
    expect(state.tpyPath).toBeNull();
    expect(state.projectInfo).toBeNull();
    expect(state.searchQuery).toBe('');
    expect(state.selectedCollection).toBeNull();
  });

  it('le même projet rouvert ne vide ni l’un ni l’autre', () => {
    editorStates.set('/projets/A/document.md', { json: {}, text: '# A', scrollTop: 120 });
    usePrimarySourcesStore.setState({ tpyPath: '/archives/Danzig.tpy' });

    switchTo('/projets/A');

    expect(editorStates.size).toBe(1);
    expect(usePrimarySourcesStore.getState().tpyPath).toBe('/archives/Danzig.tpy');
    editorStates.clear();
  });
});
