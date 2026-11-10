import { create, type StoreApi } from 'zustand';
import {
  DEFAULT_BOOK_SETTINGS,
  type BookSettings,
  type Chapter,
  type ResolvedChapter,
  type UnattachedFile,
} from '@backend/types/book';
import i18n from '../i18n';
import { useDialogStore } from './dialogStore';
import { useIdeaStore } from './ideaStore';
import { useNotificationStore } from './notificationStore';
import { useRebuildStore } from './rebuildStore';
import { openFailureKey } from '../components/Project/open-failure';
import { projectLifecycle } from '../lifecycle/projectLifecycle';

// MARK: - Types

export type { Chapter, ResolvedChapter, UnattachedFile, BookSettings };

export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'article' | 'book' | 'presentation';
  createdAt: Date;
  lastOpenedAt: Date;
  cslPath?: string;
  // Resolved absolute path to the bibliography file, derived from
  // `bibliographySource` by `project-manager.ts` at load time. Optional
  // because older / freshly-created projects may not have one yet.
  bibliography?: string;
  /** Le `.bib` du projet, relatif à son dossier, tel que `project.json` le range. */
  bibliographySource?: { filePath?: string };
}

/**
 * Typed load state machine (fusion 3.10, claw-code lesson 6.1).
 *
 * Replaces the legacy `isLoading: boolean`. Components that just want
 * a spinner can read `loadState.kind === 'loading'`; components that
 * need the failure reason (toast, retry button) get it without a side
 * channel. `ready` does NOT carry the project itself — `currentProject`
 * remains the single source of truth for "what is loaded right now"
 * so existing selectors keep working unchanged.
 */
export type ProjectLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'ready'; loadedAt: string; path: string }
  | { kind: 'failed'; path: string; error: string; at: string };

interface ProjectState {
  // Current project
  currentProject: Project | null;
  /** Manifeste réconcilié avec le disque (entrées `missing` conservées). */
  chapters: ResolvedChapter[];
  /** Fichiers markdown trouvés hors manifeste — la Phase 2 les rattachera. */
  unattachedFiles: UnattachedFile[];
  currentChapterId: string | null;
  /** Réglages d'appareil savant de l'ouvrage courant. */
  bookSettings: BookSettings;

  // Typed load state — see ProjectLoadState above.
  loadState: ProjectLoadState;

  // Recent projects
  recentProjects: Project[];

  // Actions
  loadProject: (projectPath: string) => Promise<void>;
  /**
   * Rend faux si rien n'a été créé sans qu'il y ait d'erreur : l'auteur garde son
   * tampon sans titre, le verrou est posé, un autre changement de projet est en cours,
   * ou une autre demande a pris le pas.
   */
  createProject: (name: string, type: Project['type'], path: string) => Promise<boolean>;
  closeProject: () => void;
  /** Met à jour le projet courant sans le recharger : ni l'éditeur ni les services. */
  patchCurrentProject: (patch: Partial<Pick<Project, 'cslPath'>>) => void;

  setCurrentChapter: (chapterId: string) => void;
  /** Recharge le manifeste depuis le disque (après création/modification). */
  refreshChapters: () => Promise<void>;
  /** Crée le fichier du chapitre ET l'entrée de manifeste. */
  addChapter: (title: string, kind?: Chapter['kind']) => Promise<void>;
  /** Retire du manifeste — le fichier reste sur le disque. */
  deleteChapter: (chapterId: string) => Promise<void>;
  reorderChapters: (chapters: Chapter[]) => Promise<void>;
  updateBookSettings: (settings: Partial<BookSettings>) => Promise<void>;

  loadRecentProjects: () => Promise<void>;
}

// MARK: - Helpers

/**
 * Le fichier choisi n'est pas un projet : rien n'a été ouvert ni touché. Il porte son nom,
 * que le panneau affiche dans le message traduit. Le code du main ne se montre jamais.
 */
export class NotAProjectError extends Error {
  readonly fileName: string;

  constructor(fileName: string, message: string) {
    super(message);
    this.name = 'NotAProjectError';
    this.fileName = fileName;
  }
}

/**
 * Tout autre refus du main, à l'ouverture comme à la création. Son code choisit le message : un
 * `project.json` abîmé, un dossier introuvable, un service qui n'a pas démarré n'appellent pas le
 * même geste. Le texte de l'erreur reste pour le journal, et pour les refus de création, qui le
 * portent dans leur texte (`project_exists`).
 */
export class ProjectOpenError extends Error {
  readonly code: string | undefined;
  /**
   * Le projet ouvert avant la demande n'a pas pu revenir (`restoredPath: null`) : plus aucun projet
   * n'est ouvert, et « Rien n'a été modifié » serait faux.
   */
  readonly previousClosed: boolean;

  constructor(code: string | undefined, message: string, previousClosed = false) {
    super(message);
    this.name = 'ProjectOpenError';
    this.code = code;
    this.previousClosed = previousClosed;
  }
}

/**
 * L'erreur d'un refus du main, à `project:get-metadata` comme à `project:load`. `previousClosed` :
 * voir `ProjectOpenError`.
 */
function projectRefusal(
  response: { code?: string; fileName?: string; error?: string },
  projectPath: string,
  previousClosed = false
): Error {
  const message = response.error || 'Failed to load project';
  const notAProject = response.code === 'not_a_project' || response.code === 'manifest_invalid';
  return notAProject
    ? new NotAProjectError(response.fileName ?? projectPath, message)
    : new ProjectOpenError(response.code, message, previousClosed);
}

/**
 * La séquence du main a refermé le projet d'avant sans pouvoir le rouvrir : sa réponse le dit par
 * `restoredPath: null`. Un projet était à l'écran, et il n'y est plus côté main.
 */
function previousClosedBy(response: { restoredPath?: string | null }, hadProject: boolean): boolean {
  return hadProject && response.restoredPath === null;
}

/**
 * Sauvegarde le document ouvert dans l'éditeur s'il a des modifications non
 * écrites, en lisant comme la porte le texte vivant : `isDirty` ne voit ni une
 * frappe que la synchronisation n'a pas poussée, ni une frappe pendant une écriture.
 * Appelé avant la fermeture d'un projet, tant que le main autorise encore son
 * écriture. Import dynamique pour éviter le cycle projectStore ↔ editorStore.
 */
async function saveOutgoingEditorIfDirty(): Promise<void> {
  const { writeOpenDocumentWhileDirty } = await import('./editorStore');
  await writeOpenDocumentWhileDirty();
}

/**
 * Un project.json illisible, ou un fichier qui n'est pas un projet : le main refuserait sans
 * basculer, autant le savoir avant de couper l'éditeur. Détacher détruit la vue, donc les
 * propositions de l'IA en attente, que le retour sur le document ne rend pas, et pose la question
 * du tampon sans titre pour une ouverture vouée à l'échec. Ne touche ni au projet courant ni aux récents.
 */
async function assertProjectReadable(projectPath: string): Promise<void> {
  const metadata = await window.electron.project.getMetadata(projectPath);
  if (!metadata.success) throw projectRefusal(metadata, projectPath);
}

/**
 * Écrit les idées du projet courant, tant que le main l'autorise, et rend ce qui l'en a empêché.
 * Celles d'un projet déjà fermé n'ont plus où s'écrire : elles ne retiennent rien.
 */
async function flushCurrentProjectIdeas(): Promise<string | null> {
  const { loadedFor, flushIdeas } = useIdeaStore.getState();
  if (loadedFor !== useProjectStore.getState().currentProject?.path) return null;
  await flushIdeas();
  return useIdeaStore.getState().saveError;
}

/** Ce que l'éditeur a quitté, à lui rendre si rien ne vient le remplacer. */
interface DetachedEditor {
  from: string | null;
  /**
   * Le texte d'un tampon sans titre. L'auteur a accepté de l'abandonner pour ce projet,
   * pas pour rien : il n'est sur aucun disque, et l'échec lui dira « rien n'a été modifié ».
   */
  untitledText?: string;
}

/**
 * Coupe l'éditeur du projet qu'on quitte, AVANT de demander le changement au main.
 * Le sortant s'écrit pendant que son projet est encore le projet courant, et plus
 * rien ne s'y tape ensuite : une frappe pendant `project:load` n'avait plus nulle
 * part où s'écrire, la bascule rejetait, et le repli réécrivait le document entrant.
 *
 * Rend `null` si le changement n'a pas lieu : l'auteur garde son tampon sans titre ou ses idées
 * non écrites, une autre demande a pris le pas, ou le verrou est posé, ce qui lui est dit.
 * Rejette si le document sortant ne peut pas être écrit : rien n'a changé, et rien ne se perd.
 */
async function detachOutgoingEditor(): Promise<DetachedEditor | null> {
  const { useEditorStore } = await import('./editorStore');
  // Les idées aussi. Si elles ne s'écrivent pas, l'auteur choisit : un fichier d'idées en panne ne
  // l'enferme pas dans ce projet, et rien ne se perd sans qu'il l'ait dit. La question les nomme,
  // car le document, lui, n'y est pour rien.
  const ideasError = await flushCurrentProjectIdeas();
  if (ideasError) {
    const leave = await useDialogStore
      .getState()
      .showConfirm(i18n.t('ideas.switchSaveFailed', { reason: ideasError }), i18n.t('ideas.switchSaveFailedTitle'), {
        danger: true,
      });
    if (!leave) return null;
  }

  const outcome = await useEditorStore.getState().replaceBuffer({ kind: 'detach' }, 'project-switch');
  if (outcome.status === 'locked') await useDialogStore.getState().showAlert(i18n.t(outcome.lock));
  if (outcome.status !== 'replaced') return null;
  return { from: outcome.detachedFrom ?? null, untitledText: outcome.detachedText };
}

/**
 * Le changement de projet a échoué : l'écran montre encore le projet d'avant, et
 * l'éditeur y revient. Si le main a déjà basculé, il refuse de relire ce document :
 * un tampon vide, mais le sortant est sur le disque et l'éditeur n'est pas figé. Sans
 * document d'origine, c'est le texte du tampon sans titre qui revient, sans son annulation.
 * Sur un tampon, aucun chapitre n'est courant, comme quand rien ne s'ouvre.
 *
 * L'échec du changement parle seul : si l'index de l'entrant a échoué avant lui, son
 * message désignerait, sur l'écran du projet d'avant, un projet qui ne s'y trouve pas.
 */
async function reopenAfterFailedSwitch(
  detached: DetachedEditor,
  set: StoreApi<ProjectState>['setState'],
  previousClosed = false
): Promise<void> {
  useRebuildStore.getState().resetProgress();
  const { useEditorStore } = await import('./editorStore');
  const { replaceBuffer } = useEditorStore.getState();
  // Le projet d'avant n'est pas revenu : son document n'a plus où se relire.
  if (detached.from && !previousClosed) {
    try {
      const outcome = await replaceBuffer({ kind: 'open', filePath: detached.from }, 'project-restore');
      if (outcome.status === 'replaced') return;
    } catch (error) {
      console.error('Document sortant impossible à rouvrir:', error);
    }
  }
  set({ currentChapterId: null });
  await replaceBuffer({ kind: 'untitled', text: detached.untitledText }, 'project-restore');
}

/**
 * Le main a refusé le projet demandé, et le projet d'avant est encore à l'écran. Ses stores n'ont
 * rien perdu. Une réponse partie pour lui pendant la tentative, que le registre a ignorée, ne revient
 * pas d'elle-même : son panneau garde ce qu'il montrait avant elle.
 *
 * `restoredByMain` : la réponse porte `restoredPath`, la séquence d'ouverture du main est donc passée.
 * Elle a pu fermer puis rouvrir les services du projet d'avant, et lui faire oublier sa bibliographie :
 * le renderer la lui renvoie. Sans `restoredPath` (« Nouveau projet » au nom déjà pris), le main a
 * refusé avant toute fermeture : il n'a rien oublié, et rien n'est relu.
 */
async function restorePreviousProject(
  previous: Project | null,
  shown: () => Project | null,
  restoredByMain: boolean
): Promise<void> {
  projectLifecycle.abortTransition();
  // Fermé d'office pendant la demande (`project:closed`) : il n'est plus à l'écran, rien à lui rendre.
  if (!previous || !restoredByMain || shown()?.path !== previous.path) return;
  await resendBibliographyToMain(previous, shown);
}

/**
 * Renvoie au main la bibliographie du projet revenu. Le `.bib` se lit dans `project.json`, relu à
 * l'instant : `currentProject` est la copie prise à l'ouverture, et un `.bib` reçu depuis (import,
 * synchronisation Zotero), que le main a écrit dans le manifeste, n'y figure pas.
 *
 * Aucun `.bib` connu, ou un manifeste illisible sans `.bib` à l'ouverture : la liste à l'écran
 * reste telle quelle. La vider effacerait des références que le panneau montrait, sans rien rendre
 * au main.
 */
async function resendBibliographyToMain(previous: Project, shown: () => Project | null): Promise<void> {
  let declared: BibliographyDeclaration = previous;
  try {
    const metadata = await window.electron.project.getMetadata(`${previous.path}/project.json`);
    if (metadata?.success && metadata.project) {
      declared = {
        path: previous.path,
        bibliography: metadata.project.bibliography,
        bibliographySource: metadata.project.bibliographySource,
      };
    } else {
      console.warn('⚠️ project.json du projet revenu illisible, bibliographie de son ouverture :', metadata?.error);
    }
  } catch (error) {
    console.warn('⚠️ project.json du projet revenu illisible, bibliographie de son ouverture :', error);
  }
  // Fermé d'office pendant la relecture : il n'est plus à l'écran.
  if (shown()?.path !== previous.path) return;
  const bibliographyPath = bibliographyFileOf(declared);
  if (bibliographyPath) await loadBibliographyFile(bibliographyPath, previous.path);
}

let documentNotOpenedNotice: string | null = null;
let stopWatchingEditor: (() => void) | null = null;
let ideasNotWrittenNotice: string | null = null;
let configIssueNotice: string | null = null;

function dismissConfigIssue(): void {
  if (configIssueNotice) useNotificationStore.getState().dismiss(configIssueNotice);
  configIssueNotice = null;
}

/**
 * `config.json` illisible : le projet est ouvert, mais son coffre et ses serveurs manquent, et le
 * mode de sécurité n'est plus celui de l'auteur. Un message qui reste, une fois par ouverture, une
 * fois le projet à l'écran : jamais pendant le changement, et rien s'il échoue.
 */
function notifyConfigIssue(issue?: { kind: string; path: string }): void {
  if (!issue) return;
  // `.cliodeck` lié hors du projet (D18) : le même état, mais rien n'est illisible, et bien plus manque.
  const linked = issue.kind === 'linked_outside';
  configIssueNotice = useNotificationStore.getState().notify({
    level: 'error',
    title: i18n.t(linked ? 'project.workspaceLinkedOutside.title' : 'project.configUnreadable.title'),
    message: i18n.t(
      linked
        ? 'project.workspaceLinkedOutside.message'
        : issue.kind === 'newer_schema'
          ? 'project.configUnreadable.newerSchema'
          : 'project.configUnreadable.message'
    ),
    details: issue.path,
    duration: 0,
  });
}

/**
 * Le document du projet ne s'ouvre pas : l'éditeur montrera un tampon sans titre, qui
 * ressemble à un document vide. L'auteur doit le savoir avant d'y écrire, d'où un message
 * qui reste, jusqu'à ce qu'il le ferme, qu'un fichier s'ouvre dans l'éditeur ou que ce
 * projet ne soit plus à l'écran.
 */
function notifyDocumentNotOpened(filePath: string, error: unknown, reasonKey: string): void {
  documentNotOpenedNotice = useNotificationStore.getState().notify({
    level: 'error',
    title: i18n.t('project.documentOpenError'),
    message: `${i18n.t(reasonKey)} ${i18n.t('project.documentOpenUntitled')}`,
    details: `${filePath}\n${error instanceof Error ? error.message : String(error)}`,
    duration: 0,
  });
}

function dismissDocumentNotOpened(): void {
  stopWatchingEditor?.();
  stopWatchingEditor = null;
  if (documentNotOpenedNotice) useNotificationStore.getState().dismiss(documentNotOpenedNotice);
  documentNotOpenedNotice = null;
}

/** Un projet tel que le main le rend : dates sérialisées, et ce qu'il reste à ouvrir. */
interface ProjectFromMain extends Omit<Project, 'createdAt' | 'lastOpenedAt'> {
  createdAt: string;
  lastOpenedAt?: string;
  book?: Partial<BookSettings>;
}

type BibliographyDeclaration = Pick<Project, 'path' | 'bibliography' | 'bibliographySource'>;

/**
 * Le `.bib` que déclare le projet : `bibliographySource` (relatif à son dossier), sinon l'ancien
 * champ `bibliography` (absolu). Null s'il n'en déclare aucun.
 */
function bibliographyFileOf(project: BibliographyDeclaration): string | null {
  if (project.bibliographySource?.filePath) return `${project.path}/${project.bibliographySource.filePath}`;
  return project.bibliography || null;
}

/**
 * Lit le `.bib` du projet dans le panneau et dans le main, rattachements Zotero compris. Le bandeau
 * d'un `.bib` illisible vaut pour son projet : chaque lecture repart sans lui.
 */
async function loadBibliographyFile(bibliographyPath: string, projectPath: string): Promise<void> {
  try {
    const { useBibliographyStore } = await import('./bibliographyStore');
    useBibliographyStore.setState({ bibliographyProblem: null });
    console.log('📚 Loading bibliography from:', bibliographyPath);
    // Use loadBibliographyWithMetadata to restore zoteroAttachments from metadata file
    await useBibliographyStore.getState().loadBibliographyWithMetadata(bibliographyPath, projectPath);
    console.log('✅ Bibliography loaded for project (with metadata)');
    // Refresh indexed PDFs to update the Chat panel state
    await useBibliographyStore.getState().refreshIndexedPDFs();
    console.log('✅ Indexed PDFs refreshed');
  } catch (error) {
    console.error('❌ Failed to load project bibliography:', error);
  }
}

/**
 * Charge la bibliographie du projet à son ouverture, dans le panneau et dans le main : le main n'en
 * connaît que ce que le renderer lui fait lire (`bibliography:load-with-metadata`), et s'en sert pour
 * l'aperçu des citations et les exports. Au retour du projet d'avant après un échec, c'est
 * `resendBibliographyToMain`.
 */
async function loadProjectBibliography(project: BibliographyDeclaration): Promise<void> {
  // Load bibliography if configured
  console.log('🔍 Project data received:', {
    hasBibliography: !!project.bibliography,
    bibliographyPath: project.bibliography,
    hasBibliographySource: !!project.bibliographySource
  });

  // Try loading from bibliographySource first (new system), fallback to bibliography (old system)
  const bibliographyPath = bibliographyFileOf(project);

  if (bibliographyPath) {
    await loadBibliographyFile(bibliographyPath, project.path);
  } else {
    console.log('ℹ️ No bibliography to load');
    // Still refresh indexed PDFs in case there are documents indexed without bibliography
    try {
      const { useBibliographyStore } = await import('./bibliographyStore');
      // Le registre a vidé la liste du projet d'avant ; pas celle du même projet rouvert, dont le
      // `.bib` a pu sortir de `project.json` depuis (Q22).
      useBibliographyStore.setState({ bibliographyProblem: null, citations: [], filteredCitations: [] });
      await useBibliographyStore.getState().refreshIndexedPDFs();
    } catch (error) {
      console.error('❌ Failed to refresh indexed PDFs:', error);
    }
  }
}

/**
 * Pose le projet entrant, puis ses chapitres, sa bibliographie et son document.
 * Commun à l'ouverture et à la création : la création s'arrêtait au premier point,
 * et l'auteur tapait dans un éditeur sans document ou dans celui du projet d'avant.
 * L'éditeur est détaché quand elle arrive, et n'en sort qu'ici.
 */
async function openProjectContents(
  project: ProjectFromMain,
  set: StoreApi<ProjectState>['setState'],
  detached: DetachedEditor
): Promise<void> {
  dismissDocumentNotOpened();
  dismissConfigIssue();
  if (ideasNotWrittenNotice) useNotificationStore.getState().dismiss(ideasNotWrittenNotice);
  ideasNotWrittenNotice = null;
  // Le main a basculé : ce qui ne s'est pas écrit du sortant n'a plus où aller, et l'auteur le
  // sait. La sortie n'a pas à le lui redemander, y compris si le Brainstorm n'est pas ouvert et
  // que rien ne recharge la liste. Rouvrir ce même projet, au contraire, le réécrit.
  if (useIdeaStore.getState().loadedFor !== project.path) useIdeaStore.getState().abandonUnwrittenIdeas();
  // Les stores du projet d'avant se vident avant que l'écran ne montre celui-ci, et avant que sa
  // bibliographie ne se charge. Le même dossier rouvert ne perd rien. Le main rend le dossier sous la
  // graphie demandée : rouvert sous une autre (lien, casse), le même projet serait vidé, sans dommage,
  // puisque sa bibliographie se recharge juste après et le reste à l'ouverture de chaque panneau.
  projectLifecycle.enter(project.path);
  set({
    currentProject: {
      ...project,
      createdAt: new Date(project.createdAt),
      lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
    },
    // Rien du projet d'avant : un navigateur composerait ses chemins sous le nouveau.
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  });

  // Chapitres des projets « livre ». Best-effort : un échec ici ne doit
  // JAMAIS empêcher l'ouverture du projet — un manuscrit ne devient pas
  // inaccessible à cause d'une liste accessoire.
  let firstChapterPath: string | null = null;
  if (project.type === 'book') {
    set({ bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...(project.book ?? {}) } });
    try {
      const chaptersResult = await window.electron.project.getChapters(project.path);
      if (chaptersResult.success) {
        set({
          chapters: chaptersResult.chapters,
          unattachedFiles: chaptersResult.unattached ?? [],
        });
        const first = chaptersResult.chapters.find(
          (c: ResolvedChapter) => !c.missing
        );
        if (first) {
          firstChapterPath = `${project.path}/${first.filePath}`;
          set({ currentChapterId: first.id });
        }
      }
    } catch (error) {
      console.warn('⚠️ Chapitres indisponibles (projet ouvert malgré tout):', error);
    }
  }

  await loadProjectBibliography(project);

  // Ouvrir le document principal. Pour un livre, c'est le PREMIER
  // chapitre du manifeste : un livre n'a pas de `document.md` et
  // l'ouvrir créerait un fichier fantôme hors manuscrit.
  const documentPath =
    project.type === 'presentation'
      ? `${project.path}/slides.md`
      : project.type === 'book'
        ? firstChapterPath
        : `${project.path}/document.md`;

  const { useEditorStore, EditorFileError, openErrorKey } = await import('./editorStore');
  const { replaceBuffer } = useEditorStore.getState();
  // Seul `replaced` sort du détachement : `unchanged` n'arrive pas d'un tampon sans chemin,
  // et `superseded` (un verrou posé pendant la lecture) laisserait l'éditeur figé.
  const openDocument = async (filePath: string): Promise<boolean> => {
    const outcome = await replaceBuffer({ kind: 'open', filePath }, 'project-open');
    return outcome.status === 'replaced';
  };

  // Seul un fichier absent se crée : le repli prenait toute erreur de lecture pour ce
  // cas, et réécrivait par « # Nom » un document présent. Et sans pouvoir écraser ce qui
  // serait apparu entre-temps. Un chapitre de livre ne s'invente pas.
  const openOrCreate = async (filePath: string): Promise<boolean> => {
    try {
      return await openDocument(filePath);
    } catch (error) {
      const creatable = error instanceof EditorFileError && error.code === 'absent' && project.type !== 'book';
      if (!creatable) throw error;
    }
    await window.electron.fs.writeFile(filePath, `# ${project.name}\n`, { exclusive: true });
    console.log('📝 Created document');
    return openDocument(filePath);
  };

  let opened = false;
  if (!documentPath) {
    // Livre au manifeste vide (tous les chapitres manquants, ou projet
    // créé hors app) : on n'invente pas de fichier — la Phase 2 offrira
    // de créer un chapitre ou de rattacher un fichier existant.
    console.warn('ℹ️ Aucun chapitre à ouvrir : manifeste vide');
  } else {
    try {
      // Load file FIRST so content is ready in the store
      opened = await openOrCreate(documentPath);
      console.log('📝 Document loaded into editor with path tracking');
    } catch (error) {
      console.error('Failed to load document into editor:', error);
      notifyDocumentNotOpened(documentPath, error, openErrorKey(error, 'project.documentOpenUnchanged'));
      // Il parle du tampon sans titre : un fichier ouvert le rend faux, surtout celui
      // qu'il demandait de convertir puis de rouvrir.
      stopWatchingEditor = useEditorStore.subscribe((state) => {
        if (state.filePath) dismissDocumentNotOpened();
      });
    }
  }

  // Rien à ouvrir : ni l'ancien document, ni un éditeur figé en lecture seule. Aucun
  // chapitre n'est donc courant : le renommer réécrirait son titre dans ce tampon. Et
  // rien n'ayant remplacé un tampon sans titre, son texte reste.
  if (!opened) {
    set({ currentChapterId: null });
    await replaceBuffer({ kind: 'untitled', text: detached.untitledText }, 'project-open');
  }
}

/**
 * Le verrou de bascule de l'éditeur vaut aussi pour le projet : une
 * renumérotation écrit le manuscrit du projet courant, fichier par fichier.
 * Rend vrai si l'action doit s'arrêter, l'auteur étant alors prévenu. Une
 * alerte et non un rejet : les appelants traduiraient un rejet par « ce projet n'a
 * pas pu être ouvert », et le bouton de fermeture n'en attrape aucun.
 */
async function refusedBySwitchLock(): Promise<boolean> {
  const { useEditorStore } = await import('./editorStore');
  const { switchLock } = useEditorStore.getState();
  if (!switchLock) return false;
  await useDialogStore.getState().showAlert(i18n.t(switchLock));
  return true;
}

/**
 * Plus aucun projet à l'écran : ni ses chapitres, ni ses messages, ni le suivi de son index. Après
 * une fermeture, ou quand le main a fermé le projet de lui-même.
 */
function enterNoProject(set: StoreApi<ProjectState>['setState']): void {
  dismissDocumentNotOpened();
  dismissConfigIssue();
  // Après la fermeture du main : un échec publié juste avant elle arrive avant sa réponse.
  useRebuildStore.getState().resetProgress();
  // Rien du projet fermé ne reste dans les stores : bibliographie, conversation, sélections…
  projectLifecycle.enter(null);
  set({
    currentProject: null,
    chapters: [],
    unattachedFiles: [],
    currentChapterId: null,
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  });
}

/**
 * L'écriture du document sortant a échoué : fermer quand même perd ce qui n'est pas écrit.
 * L'auteur décide, la cause sous les yeux.
 */
async function confirmCloseUnsaved(error: unknown): Promise<boolean> {
  console.error('❌ Sauvegarde du document sortant impossible à la fermeture:', error);
  const reason = error instanceof Error ? error.message : String(error);
  return useDialogStore
    .getState()
    .showConfirm(i18n.t('project.closeUnsavedConfirm', { reason }), i18n.t('project.closeUnsavedConfirmTitle'), {
      danger: true,
    });
}

/**
 * Avant de fermer : le document ouvert s'écrit tant que son projet est encore le projet courant,
 * puis l'éditeur s'en détache, en lecture seule, le temps de la fermeture, qui peut attendre une
 * indexation en vol. Une frappe pendant ce temps n'aurait plus nulle part où s'écrire.
 *
 * Rend null si la fermeture n'a pas lieu : l'auteur garde le projet, le verrou est posé (ce qui lui
 * est dit), ou le détachement a été chassé (il tape encore pendant l'écriture, ou une autre demande
 * a pris le pas), comme pour un changement de projet (`detachOutgoingEditor`). Fermer quand même
 * laisserait l'éditeur sur un document du projet fermé, modifiable, que le validateur refuserait
 * d'écrire. `detached` dit si l'éditeur a quitté un document. Un tampon sans titre n'appartient à
 * aucun projet : il reste tel quel.
 *
 * `closedByMainMeanwhile` dit si le main a fermé le projet de lui-même pendant l'attente
 * (`project:closed`). L'écriture qui échoue alors ne pose aucune question : il n'y a plus de projet
 * à garder ouvert, et l'appelant met le texte à l'abri dans un tampon sans titre.
 */
async function leaveEditorBeforeClose(closedByMainMeanwhile: () => boolean): Promise<{ detached: boolean } | null> {
  const { useEditorStore } = await import('./editorStore');
  if (!useEditorStore.getState().filePath) return { detached: false };

  let discardOutgoing = false;
  try {
    await saveOutgoingEditorIfDirty();
  } catch (error) {
    if (closedByMainMeanwhile()) return null;
    if (!(await confirmCloseUnsaved(error))) return null;
    discardOutgoing = true;
  }

  const detach = () =>
    useEditorStore
      .getState()
      .replaceBuffer(discardOutgoing ? { kind: 'detach', discardOutgoing: true } : { kind: 'detach' }, 'project-close');
  let outcome;
  try {
    outcome = await detach();
  } catch (error) {
    // Une frappe arrivée après l'écriture, qui ne s'écrit pas à son tour : la même question.
    if (closedByMainMeanwhile()) return null;
    if (!(await confirmCloseUnsaved(error))) return null;
    discardOutgoing = true;
    outcome = await detach();
  }
  if (outcome.status === 'locked') {
    await useDialogStore.getState().showAlert(i18n.t(outcome.lock));
    return null;
  }
  if (outcome.status !== 'replaced') return null;
  return { detached: true };
}

/**
 * Le main a fermé le projet de lui-même (`project:closed`) : il ne se rechargeait plus. L'écran
 * passe à l'état sans projet, l'éditeur repart d'un tampon sans titre, et l'auteur le sait. Le texte
 * qui n'était pas écrit n'a plus où aller : il reste dans le tampon, pour « Enregistrer sous ».
 */
async function closedByMain(
  closed: { path: string; code: string; error: string },
  get: StoreApi<ProjectState>['getState'],
  set: StoreApi<ProjectState>['setState']
): Promise<void> {
  console.warn('⚠️ Projet fermé par le processus principal :', closed);
  if (get().currentProject?.path !== closed.path) return;
  enterNoProject(set);
  // Un changement de projet en cours, ou une fermeture demandée par l'auteur, garde la main : sa fin
  // posera l'état, et l'éditeur, détaché pour lui, en sortira par elle. Pour une fermeture, poser
  // `idle` ici laisserait passer une ouverture que la suite de la fermeture refermerait.
  const switching = switchInProgress(get());
  if (!switching) {
    set({ loadState: { kind: 'idle' } });
    await keepEditorTextOutOfClosedProject();
  }
  await useDialogStore.getState().showAlert(i18n.t(openFailureKey(closed.code, true) ?? 'project.openFailed'));
}

/**
 * Le projet du document ouvert est fermé, et le validateur refuse toute écriture dans son dossier :
 * l'éditeur repart d'un tampon sans titre, qui garde le texte non écrit pour « Enregistrer sous ».
 * Un tampon détaché appartient au changement de projet qui l'a détaché, un tampon sans titre à
 * aucun projet : ni l'un ni l'autre ne bouge.
 */
async function keepEditorTextOutOfClosedProject(): Promise<void> {
  const { useEditorStore, needsFlush } = await import('./editorStore');
  const editor = useEditorStore.getState();
  if (!editor.filePath || editor.bufferDetached) return;
  const live = editor.getLiveContent();
  const unsaved = needsFlush({ filePath: editor.filePath, isDirty: editor.isDirty, live, mirror: editor.content });
  await editor.replaceBuffer(
    unsaved ? { kind: 'untitled', discardOutgoing: true, text: live } : { kind: 'untitled', discardOutgoing: true },
    'project-close'
  );
}

/**
 * Un seul changement de projet à la fois : la règle du voile du panneau, que le dialogue
 * d'ouverture, sans fenêtre parente, laisse passer. Le main ne sait pas en mener deux
 * (services initialisés en parallèle), et le perdant, dont il refuse alors la lecture,
 * viderait l'éditeur du gagnant. À lire sans attente avant de poser `loading`.
 */
function switchInProgress(state: ProjectState): boolean {
  return state.loadState.kind === 'loading';
}

// MARK: - Store

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  chapters: [],
  unattachedFiles: [],
  currentChapterId: null,
  bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  loadState: { kind: 'idle' },
  recentProjects: [],

  loadProject: async (projectPath: string) => {
    if (await refusedBySwitchLock()) return;
    if (switchInProgress(get())) return;
    const loadStateBefore = get().loadState;
    const previous = get().currentProject;
    const hadProject = previous !== null;
    set({ loadState: { kind: 'loading', path: projectPath } });
    let detached: DetachedEditor | null = null;
    // La demande est partie au main ; il a dit non, et le projet d'avant est encore le sien, ou aucun.
    let asked = false;
    let refused = false;
    // Le refus vient de la séquence d'ouverture du main, qui a pu fermer et rouvrir le projet d'avant.
    let restoredByMain = false;
    try {
      await assertProjectReadable(projectPath);
      detached = await detachOutgoingEditor();
      if (!detached) {
        set({ loadState: loadStateBefore });
        return;
      }

      // Le changement a lieu : le message d'échec de l'index du sortant ne le suit pas, et
      // celui de l'entrant, publié pendant la demande au main, doit rester. Pas plus tôt :
      // un changement refusé laisse le sortant à l'écran, et son message avec.
      useRebuildStore.getState().resetProgress();

      // Plus aucune réponse partie pour le projet à l'écran ne s'inscrit : le main peut basculer.
      projectLifecycle.beginTransition();
      asked = true;
      // Call IPC to load project
      const result = await window.electron.project.load(projectPath);

      if (!result.success || !result.project) {
        refused = true;
        restoredByMain = typeof result.restoredPath === 'string';
        throw projectRefusal(result, projectPath, previousClosedBy(result, hadProject));
      }

      const project = result.project;

      console.log('📥 Raw project data from backend:', {
        project: project,
        bibliography: project.bibliography,
        bibliographySource: project.bibliographySource
      });

      await openProjectContents(project, set, detached);

      // Update recent projects
      await get().loadRecentProjects();

      set({
        loadState: {
          kind: 'ready',
          loadedAt: new Date().toISOString(),
          path: projectPath,
        },
      });
      notifyConfigIssue(result.configIssue);
    } catch (error) {
      console.error('Failed to load project:', error);
      const previousClosed = error instanceof ProjectOpenError && error.previousClosed;
      if (detached) await reopenAfterFailedSwitch(detached, set, previousClosed);
      // A ne revient pas : l'écran le suit, et passe à l'accueil (Q10).
      if (previousClosed) enterNoProject(set);
      else if (refused) await restorePreviousProject(previous, () => get().currentProject, restoredByMain);
      // Sans réponse du main, A reste à l'écran ; passé à B, l'écran l'a suivi et ceci ne fait rien.
      else if (asked) projectLifecycle.abortTransition();
      set({
        loadState: {
          kind: 'failed',
          path: projectPath,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  },

  createProject: async (name: string, type: Project['type'], path: string) => {
    if (await refusedBySwitchLock()) return false;
    if (switchInProgress(get())) return false;
    const loadStateBefore = get().loadState;
    const previous = get().currentProject;
    const hadProject = previous !== null;
    set({ loadState: { kind: 'loading', path } });
    let detached: DetachedEditor | null = null;
    // Comme à l'ouverture : la demande est partie, et le main a dit non. Un nom déjà pris est refusé
    // avant la séquence d'ouverture, sans `restoredPath` : rien du projet d'avant n'a été fermé.
    let asked = false;
    let refused = false;
    let restoredByMain = false;
    try {
      // Même coupure que loadProject : créer un projet bascule aussi le main.
      detached = await detachOutgoingEditor();
      if (!detached) {
        set({ loadState: loadStateBefore });
        return false;
      }

      // Comme à l'ouverture : après les refus, avant la demande au main.
      useRebuildStore.getState().resetProgress();

      projectLifecycle.beginTransition();
      asked = true;
      const result = await window.electron.project.create({ name, type, path });

      if (!result.success || !result.project) {
        refused = true;
        restoredByMain = typeof result.restoredPath === 'string';
        throw new ProjectOpenError(
          result.code,
          result.error || 'Failed to create project',
          previousClosedBy(result, hadProject)
        );
      }

      await openProjectContents(result.project, set, detached);

      await get().loadRecentProjects();

      set({
        loadState: {
          kind: 'ready',
          loadedAt: new Date().toISOString(),
          path,
        },
      });
      notifyConfigIssue(result.configIssue);
      return true;
    } catch (error) {
      console.error('Failed to create project:', error);
      const previousClosed = error instanceof ProjectOpenError && error.previousClosed;
      if (detached) await reopenAfterFailedSwitch(detached, set, previousClosed);
      if (previousClosed) enterNoProject(set);
      else if (refused) await restorePreviousProject(previous, () => get().currentProject, restoredByMain);
      else if (asked) projectLifecycle.abortTransition();
      set({
        loadState: {
          kind: 'failed',
          path,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  },

  closeProject: async () => {
    if (await refusedBySwitchLock()) return;
    // Un changement de projet en cours : la règle du voile du panneau, que le menu ne voit pas.
    if (switchInProgress(get())) return;
    const loadStateBefore = get().loadState;
    // Le main peut fermer le projet de lui-même pendant l'attente (`project:closed`) : `closedByMain`
    // vide alors le projet à l'écran, et laisse le reste à cette fermeture.
    const hadProject = get().currentProject !== null;
    const closedByMainMeanwhile = () => hadProject && get().currentProject === null;
    // Fermer peut attendre une indexation en vol : sans cet état, le bouton paraîtrait mort. Aucun
    // projet n'est attendu au bout (`stillIn` le voit).
    set({ loadState: { kind: 'loading', path: '' } });

    // Fermer le projet abandonne le document courant : il s'écrit tant que le main autorise encore
    // son projet. Si l'écriture échoue, l'auteur choisit, au lieu de tout perdre sans le savoir.
    const left = await leaveEditorBeforeClose(closedByMainMeanwhile);
    if (!left) {
      // Plus aucun projet à garder ouvert : remettre l'état d'avant laisserait `ready` sans projet,
      // et l'éditeur sur un document que le main refuse d'écrire. L'état sans projet, et le texte
      // non écrit à l'abri dans un tampon sans titre, comme pour toute fermeture d'office.
      if (closedByMainMeanwhile()) {
        set({ loadState: { kind: 'idle' } });
        await keepEditorTextOutOfClosedProject();
        return;
      }
      set({ loadState: loadStateBefore });
      return;
    }
    const ideasError = await flushCurrentProjectIdeas();
    if (ideasError) {
      ideasNotWrittenNotice = useNotificationStore.getState().notify({
        level: 'error',
        title: i18n.t('ideas.closeSaveFailedTitle'),
        message: i18n.t('ideas.closeSaveFailed'),
        details: ideasError,
        duration: 0,
      });
    }

    // Plus aucune réponse partie pour ce projet ne s'inscrit ; `enterNoProject` vide ensuite ses stores.
    projectLifecycle.beginTransition();
    try {
      // Close backend resources (PDF Service, vector store, etc.)
      await window.electron.project.close();
      console.log('✅ Backend resources closed');
    } catch (error) {
      console.error('❌ Failed to close backend resources:', error);
    }

    // Clear frontend state
    enterNoProject(set);
    set({ loadState: { kind: 'idle' } });
    // Le validateur refuse désormais toute écriture dans le projet fermé : l'éditeur repart d'un
    // tampon sans titre, vide (`createNewFile`, qu'un tampon détaché refuse).
    if (left.detached) {
      const { useEditorStore } = await import('./editorStore');
      await useEditorStore.getState().replaceBuffer({ kind: 'untitled' }, 'project-close');
    }
  },

  patchCurrentProject: (patch) => {
    const { currentProject } = get();
    if (currentProject) set({ currentProject: { ...currentProject, ...patch } });
  },

  setCurrentChapter: (chapterId: string) => {
    set({ currentChapterId: chapterId });
  },

  refreshChapters: async () => {
    const { currentProject } = get();
    if (!currentProject || currentProject.type !== 'book') return;
    try {
      const result = await window.electron.project.getChapters(currentProject.path);
      if (result.success) {
        set({
          chapters: result.chapters,
          unattachedFiles: result.unattached ?? [],
        });
      }
    } catch (error) {
      console.warn('⚠️ Rafraîchissement des chapitres impossible:', error);
    }
  },

  addChapter: async (title: string, kind?: Chapter['kind']) => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Le fichier ET l'entrée de manifeste sont créés côté main, en une
    // opération : pas d'entrée sans fichier ni l'inverse.
    const result = await window.electron.project.createChapter({
      projectPath: currentProject.path,
      title,
      kind,
    });
    if (!result.success) {
      throw new Error(result.error || 'Création du chapitre impossible');
    }
    await get().refreshChapters();
  },

  deleteChapter: async (chapterId: string) => {
    const { currentProject, chapters, currentChapterId } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Le fichier reste sur le disque (décision cadre : on ne perd jamais de
    // texte) ; il réapparaîtra comme « non rattaché ».
    const remaining = chapters
      .filter((c) => c.id !== chapterId)
      .map(({ missing: _missing, ...chapter }) => chapter);
    const result = await window.electron.project.saveChapters({
      projectPath: currentProject.path,
      chapters: remaining,
    });
    if (!result.success) {
      throw new Error(result.error || 'Suppression du chapitre impossible');
    }
    set({ currentChapterId: currentChapterId === chapterId ? null : currentChapterId });
    await get().refreshChapters();
  },

  reorderChapters: async (newChapters: Chapter[]) => {
    const { currentProject } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    // Optimiste : l'ordre local suit immédiatement le glisser-déposer, le
    // disque confirme ensuite (l'ordre stocké est renormalisé côté main).
    // Le manifeste ne porte pas les marques de réconciliation (`missing`…) : on
    // les garde ici, sans quoi un chapitre manquant redeviendrait ouvrable.
    const known = new Map(get().chapters.map((c) => [c.id, c]));
    set({ chapters: newChapters.map((c, index) => ({ ...known.get(c.id), ...c, order: index })) });
    const result = await window.electron.project.saveChapters({
      projectPath: currentProject.path,
      chapters: newChapters.map(({ ...chapter }) => chapter),
    });
    if (!result.success) {
      await get().refreshChapters(); // rollback depuis la vérité disque
      throw new Error(result.error || 'Réordonnancement impossible');
    }
  },

  updateBookSettings: async (settings: Partial<BookSettings>) => {
    const { currentProject, bookSettings } = get();
    if (!currentProject) throw new Error('Aucun projet ouvert');
    const previous = bookSettings;
    set({ bookSettings: { ...bookSettings, ...settings } });
    const result = await window.electron.project.saveBookSettings({
      projectPath: currentProject.path,
      settings,
    });
    if (!result.success) {
      set({ bookSettings: previous });
      throw new Error(result.error || 'Enregistrement des réglages impossible');
    }
    if (result.settings) set({ bookSettings: result.settings });
  },

  loadRecentProjects: async () => {
    try {
      const recentPaths = await window.electron.project.getRecent();
      const pathsToRemove: string[] = [];

      const recentProjects = await Promise.all(
        recentPaths.map(async (path: string) => {
          try {
            // Use getMetadata instead of load to avoid initializing services for each project
            const result = await window.electron.project.getMetadata(path);
            if (!result.success || !result.project) {
              // Seule une absence avérée retire de la liste, ou un fichier qui ne sera jamais un
              // projet (l'ancienne ouverture a pu l'y mettre). Un disque débranché, un dossier
              // renommé, un project.json à réparer, une réponse qui ne dit rien : caché, et il
              // revient avec son disque.
              if (result.code === 'project_file_missing' || result.code === 'not_a_project') {
                pathsToRemove.push(path);
              }
              return null;
            }
            const project = result.project;
            return {
              ...project,
              createdAt: new Date(project.createdAt),
              lastOpenedAt: new Date(project.lastOpenedAt || project.createdAt),
            };
          } catch {
            return null;
          }
        })
      );

      // Remove non-existent projects from the recent list
      if (pathsToRemove.length > 0) {
        console.log(`🧹 Removing ${pathsToRemove.length} non-existent or non-project entries from recent list`);
        for (const path of pathsToRemove) {
          await window.electron.project.removeRecent(path);
        }
      }

      set({
        recentProjects: recentProjects.filter((p): p is Project => p !== null),
      });
    } catch (error) {
      console.error('Failed to load recent projects:', error);
    }
  },
}));

// Le main a fermé le projet de lui-même : l'écran le suit (L03-3).
if (typeof window !== 'undefined') {
  window.electron?.project?.onClosed?.((closed) => {
    void closedByMain(closed, useProjectStore.getState, useProjectStore.setState).catch((error: unknown) => {
      console.error('❌ Fermeture d’office mal suivie :', error);
    });
  });
}
