/**
 * L'inventaire des stores du renderer (L03-4) : chaque fichier de `stores/`, `stores/bibliography/`
 * compris, dit s'il appartient au projet ouvert ou non. Un nouveau fichier non classé fait échouer
 * ce test : son auteur décide, et un store lié au projet s'inscrit au registre (`projectLifecycle`).
 *
 * - `project` : son état vient du projet ouvert. Il inscrit sa remise à zéro, ou une autre
 *   séquence la fait (`resetBy`), à un autre moment que l'entrée dans le projet, et dit pourquoi.
 * - `filtered` : son état mêle plusieurs projets et survit à la bascule ; ses lecteurs ne montrent
 *   que ce qui revient au projet ouvert, par le sélecteur nommé (`selector`), et rien ne le vide.
 * - `global` : préférence de l'auteur, réglage de l'application, état d'interface, ou aucun état.
 *
 * Les remises à zéro hors de `stores/` sont listées à part (amendement A36) : toute inscription au
 * registre dans le renderer doit figurer dans l'une ou l'autre liste.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

type Scope =
  | { scope: 'project'; why: string }
  | { scope: 'project'; why: string; resetBy: { file: string; call: string } }
  | { scope: 'filtered'; why: string; selector: string }
  | { scope: 'global'; why: string };

const RENDERER = path.resolve(__dirname, '../..');
const STORES = path.join(RENDERER, 'stores');
const REGISTERS = 'projectLifecycle.onReset(';
const BIBLIOGRAPHY_RESET = { file: 'bibliographyStore.ts', call: "projectLifecycle.onReset('bibliography'" };

const INVENTORY: Record<string, Scope> = {
  'bibliographyStore.ts': { scope: 'project', why: 'références, PDF indexés, notes de lecture du projet (S07-1-31)' },
  'bibliography/citationSlice.ts': {
    scope: 'project',
    why: 'références, bandeau, sélection, recherche, filtre de tags ; tri gardé',
    resetBy: BIBLIOGRAPHY_RESET,
  },
  'bibliography/indexingSlice.ts': {
    scope: 'project',
    why: 'PDF indexés du brain.db, lot en cours',
    resetBy: BIBLIOGRAPHY_RESET,
  },
  'bibliography/readingNotesSlice.ts': {
    scope: 'project',
    why: 'notes de lecture du projet ; affichage des tags automatiques gardé',
    resetBy: BIBLIOGRAPHY_RESET,
  },
  'bibliography/zoteroSlice.ts': { scope: 'global', why: 'aucun état : des actions sur les tranches ci-dessus' },
  'bibliography/types.ts': { scope: 'global', why: 'aucun état : des types' },
  'bibliography/referenceTags.ts': { scope: 'global', why: 'aucun état : des fonctions pures' },
  'bibliography/citationAbstract.ts': { scope: 'global', why: 'aucun état : une fonction pure' },
  'chatStore.ts': { scope: 'project', why: 'la conversation (S16-1-22, Q11) ; réglages du chat gardés' },
  'ragQueryStore.ts': {
    scope: 'project',
    why: 'sélection de documents et de collections, listes proposées (S15-1-10) ; réglages gardés',
  },
  'journalStore.ts': { scope: 'project', why: 'sessions et session sélectionnée du journal (S17-1-9)' },
  'similarityStore.ts': { scope: 'project', why: 'filtre de collections et résultats (S18-1-25)' },
  'usageJournalStore.ts': { scope: 'project', why: 'résumé du jour lu dans le journal.db du projet' },
  'manuscriptStore.ts': { scope: 'project', why: 'plan et statistiques des chapitres' },
  'slidesStore.ts': { scope: 'project', why: 'génération et aperçu des diapositives du projet' },
  'primarySourcesStore.ts': { scope: 'project', why: 'projet Tropy lié, sources et filtres (S18-1-30, L06-4)' },
  'projectStore.ts': {
    scope: 'project',
    why: 'le pilote du registre : il pose le projet entrant, ses chapitres et ses réglages d’ouvrage',
    resetBy: { file: 'projectStore.ts', call: 'projectLifecycle.enter(' },
  },
  'editorStore.ts': {
    scope: 'project',
    why: 'le document ouvert : la bascule le détache puis ouvre celui du projet entrant',
    resetBy: { file: 'projectStore.ts', call: "replaceBuffer({ kind: 'detach' }" },
  },
  'rebuildStore.ts': {
    scope: 'project',
    why: 'suivi de reconstruction de l’index : vidé avant la demande au main, car celui du projet entrant arrive pendant elle',
    resetBy: { file: 'projectStore.ts', call: 'useRebuildStore.getState().resetProgress()' },
  },
  'tropyReindexStore.ts': {
    scope: 'project',
    why: 'réindexation des sources primaires : son hook l’efface au changement de projet puis relit l’état du main, qui peut l’avoir publiée pendant l’ouverture',
    resetBy: { file: 'tropyReindexStore.ts', call: 'store.clear()' },
  },
  'pdfIndexStore.ts': {
    scope: 'project',
    why: 'index des PDF à reconstruire, lu dans le brain.db du projet, et son bandeau fermé : il revient à la réouverture (J8)',
  },
  'ideaStore.ts': {
    scope: 'project',
    why: 'idées du projet, sélection, état de son fichier ; un chargement en vol devient caduc (S16-1-18)',
  },
  'draftsStore.ts': {
    scope: 'filtered',
    why: 'brouillons de tous les projets, persistés ; chacun porte le sien, ceux d’avant sans projet se voient partout (Q12)',
    selector: 'draftsForProject',
  },
  'modeStore.ts': {
    scope: 'global',
    why: 'mode actif : préférence de l’auteur, persistée ; la liste, modes du projet compris, se relit au montage du sélecteur',
  },
  'workspaceModeStore.ts': { scope: 'global', why: 'mode de l’espace de travail : état d’interface, persisté' },
  'cloudConsentStore.ts': { scope: 'global', why: 'consentement au fournisseur distant, pour la session de l’app' },
  'mcpToolsStore.ts': { scope: 'global', why: 'choix des outils MCP par nom : préférence de l’auteur, persistée' },
  'languageStore.ts': { scope: 'global', why: 'langue de l’interface' },
  'densityStore.ts': { scope: 'global', why: 'densité de l’interface' },
  'dialogStore.ts': { scope: 'global', why: 'dialogue à l’écran' },
  'notificationStore.ts': {
    scope: 'global',
    why: 'messages à l’écran ; ceux d’un projet sont retirés par projectStore',
  },
  'menuIntentStore.ts': { scope: 'global', why: 'commande du menu en attente d’un panneau, consommée une fois' },
  'index.ts': { scope: 'global', why: 'aucun état : des réexportations' },
};

/** Les inscriptions au registre hors de `stores/` (A36). */
const OUTSIDE_STORES: Record<string, string> = {
  'components/Editor/editor-state-memory.ts': 'curseur et annulation mémorisés par document du projet',
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const relative = (base: string, file: string): string => path.relative(base, file).split(path.sep).join('/');
const source = (base: string, file: string): string => readFileSync(path.join(base, file), 'utf8');

describe('inventaire des stores : projet ou global', () => {
  const files = filesUnder(STORES).map((file) => relative(STORES, file));

  it('tout fichier de stores/ est classé', () => {
    const unclassified = files.filter((file) => !(file in INVENTORY));
    expect(unclassified).toEqual([]);
  });

  it('l’inventaire ne nomme aucun fichier disparu', () => {
    const gone = Object.keys(INVENTORY).filter((file) => !files.includes(file));
    expect(gone).toEqual([]);
  });

  it.each(Object.entries(INVENTORY))('%s', (file, entry) => {
    const text = source(STORES, file);
    if (entry.scope === 'project' && 'resetBy' in entry) {
      expect(source(STORES, entry.resetBy.file)).toContain(entry.resetBy.call);
    } else if (entry.scope === 'project') {
      // Un store lié au projet inscrit sa remise à zéro.
      expect(text).toContain(REGISTERS);
    } else if (entry.scope === 'filtered') {
      // Filtré, pas vidé : il fournit son sélecteur, et une remise à zéro perdrait ce qu'il garde.
      expect(text).toContain(`export function ${entry.selector}(`);
      expect(text).not.toContain(REGISTERS);
    } else {
      // Un store global qui s'inscrirait serait mal classé.
      expect(text).not.toContain(REGISTERS);
    }
  });
});

describe('inscriptions hors de stores/ (A36)', () => {
  it('chaque inscription au registre du renderer est dans l’inventaire ou dans la liste A36', () => {
    const registering = filesUnder(RENDERER)
      .filter((file) => !file.startsWith(path.join(RENDERER, 'lifecycle')))
      .filter((file) => readFileSync(file, 'utf8').includes(REGISTERS))
      .map((file) => relative(RENDERER, file));
    const listed = [
      ...Object.entries(INVENTORY)
        .filter(([, entry]) => entry.scope === 'project' && !('resetBy' in entry))
        .map(([file]) => `stores/${file}`),
      ...Object.keys(OUTSIDE_STORES),
    ];

    expect(registering.sort()).toEqual(listed.sort());
  });
});
