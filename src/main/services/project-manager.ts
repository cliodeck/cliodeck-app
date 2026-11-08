import { writeFile, readFile, mkdir, copyFile, readdir, open, rm, rmdir, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { dirname, basename, join } from 'path';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import {
  isEvictedByIcloud,
  parseUserJson,
  readUserFile,
  UnreadableFileError,
  updateJsonFile,
  withFileLock,
} from '../../../backend/core/fs/user-files.js';
import { isInside, sameFile } from '../../../backend/core/vector-store/file-identity.js';
import { migrateWorkspaceToFlat } from '../../../backend/core/workspace/migrator.js';
import { workspaceConfigIssue, type WorkspaceConfigIssue } from '../../../backend/core/workspace/config.js';
import { workspaceLinkOutside } from '../../../backend/core/workspace/link-guard.js';
import { CONTEXT_FILE, CONTEXT_TEMPLATE } from '../../../backend/core/hints/loader.js';
import {
  CHAPTERS_DIR,
  DEFAULT_BOOK_SETTINGS,
  NON_CHAPTER_FILES,
  chapterFileName,
  normalizeBookSettings,
  type BookSettings,
  type Chapter,
  type ChapterRead,
  type ResolvedChapter,
  type UnattachedFile,
} from '../../../backend/types/book.js';

async function autoMigrateWorkspace(projectDir: string): Promise<void> {
  // `.cliodeck` lié hors du projet (D18) : la migration y créerait ou déplacerait des fichiers, à
  // l'autre bout du lien. Rien n'y touche ; `configIssue` le dit à l'écran.
  if (await workspaceLinkOutside(projectDir)) return;
  // Best-effort: a failed migration must not block project load. The next
  // load will retry. Most-common case (already-flat workspace) is a no-op.
  try {
    const report = await migrateWorkspaceToFlat(projectDir);
    if (report.copied.length > 0 || report.warnings.length > 0) {
      console.log('[workspace] auto-migration:', {
        kind: report.kind,
        copied: report.copied.length,
        skipped: report.skipped.length,
        // Le texte, pas le compte : un lien sortant refusé ne se dit que là.
        warnings: report.warnings,
      });
    }
  } catch (e) {
    console.warn(
      '[workspace] auto-migration failed (non-fatal):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

interface TemplateFile {
  /** Chemin relatif au dossier du projet. */
  relPath: string;
  content: string;
}

/**
 * Écrit les gabarits d'un nouveau projet, sans jamais remplacer un fichier
 * (ouverture exclusive : un fichier apparu après le contrôle d'existence lève
 * EEXIST). En cas d'échec, retire seulement ce que cet appel a créé.
 */
async function writeTemplates(projectPath: string, templates: TemplateFile[]): Promise<void> {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const ensureDir = async (dir: string) => {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.push(dir);
    }
  };
  try {
    await ensureDir(projectPath);
    for (const { relPath, content } of templates) {
      const target = path.join(projectPath, relPath);
      await ensureDir(path.dirname(target));
      const handle = await open(target, 'wx');
      createdFiles.push(target);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    }
  } catch (error: unknown) {
    await Promise.all(createdFiles.map((file) => rm(file, { force: true }).catch(() => undefined)));
    for (const dir of createdDirs.reverse()) {
      await rmdir(dir).catch(() => undefined);
    }
    throw error;
  }
}

const slidesTemplate = (name: string) => `## ${name}

Auteur · Date

Note: Bienvenue dans cette présentation.

---

## Plan

- Contexte
- Méthodologie
- Résultats
- Conclusion

---

## Contexte

- Point important 1
- Point important 2
- Point important 3

Note: Détaillez ici le contexte de votre recherche.

---

## Méthodologie

- Méthode 1
- Méthode 2
- Méthode 3

---

## Résultats

| Élément | Valeur |
|---------|--------|
| A       | 10     |
| B       | 20     |

Note: Commentez les résultats principaux.

---

## Conclusion

Merci de votre attention !

Note: N'oubliez pas de mentionner les perspectives futures.
`;

interface Project {
  id?: string;
  name: string;
  type?: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  bibliography?: string;
  bibliographySource?: {
    type: 'file' | 'zotero';
    filePath?: string; // Path to .bib file relative to project
    zoteroCollection?: string; // Zotero collection key
  };
  cslPath?: string; // Path to CSL file (relative to project or absolute)
  /** Manifeste du manuscrit (projets « livre »). Ordre et titres. */
  chapters?: Chapter[];
  /** Réglages d'appareil savant (projets « livre »). */
  book?: BookSettings;
  /** La bibliothèque et la collection Zotero du projet. Les champs inconnus restent. */
  zotero?: { groupId?: string; collectionKey?: string; libraryID?: number };
}

/** Le nom du manifeste : `createProject` n'en a jamais écrit d'autre, et tout le code le relit à ce nom. */
const PROJECT_FILE = 'project.json';

/** Les types que ClioDeck écrit. Un manifeste qui porte `name` n'a pas à en avoir un connu. */
const PROJECT_TYPES: ReadonlySet<unknown> = new Set(['article', 'book', 'presentation']);

/**
 * Ce fichier n'est pas un manifeste de projet. `not_a_project` : il ne porte pas le bon nom, il
 * n'en sera jamais un, et une ligne des récents qui le désigne peut partir. `manifest_invalid` :
 * il porte le bon nom sans décrire un projet ; il peut se réparer, et sa ligne reste cachée (Q8).
 */
class NotAProjectError extends Error {
  readonly code: 'not_a_project' | 'manifest_invalid';

  constructor(projectFile: string, code: NotAProjectError['code']) {
    super(`${projectFile} n'est pas un manifeste de projet`);
    this.name = 'NotAProjectError';
    this.code = code;
  }
}

/** Un JSON valide qui n'est pas un objet n'est pas un manifeste, et s'écrirait mal. */
function assertIsManifest(projectFile: string, value: unknown): asserts value is Project {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotAProjectError(projectFile, 'manifest_invalid');
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Le bloc `zotero` se change clé par clé, `undefined` effaçant : une synchronisation peut y avoir
 * posé la collection depuis que le panneau a lu le fichier, et la synchronisation suivante part
 * d'elle. Ce qui n'est pas un objet ne se fusionne pas : le reçu le remplace tel quel.
 */
function zoteroUpdate(stored: unknown, received: unknown): Pick<Project, 'zotero'> | undefined {
  return isRecord(stored) && isRecord(received) ? { zotero: { ...stored, ...received } } : undefined;
}

/**
 * Lit le manifeste, en décodage strict comme à l'écriture : un fichier en Latin-1 se refuse
 * plutôt que de voir ses accents changés en U+FFFD, puis réécrits. Le BOM d'un éditeur Windows
 * passe. Lève si `project.json` est absent, illisible ou invalide.
 */
async function readManifest(projectFile: string): Promise<Project> {
  const read = await readUserFile(projectFile);
  if (read.kind === 'absent') throw new Error(`Project file not found: ${projectFile}`);
  if (read.kind === 'unreadable') throw new UnreadableFileError(projectFile, read.reason, read.message);
  const project = parseUserJson(read.content);
  assertIsManifest(projectFile, project);
  return project;
}

/**
 * Lit ce qu'on demande d'ouvrir. Le dialogue filtre sur l'extension : n'importe quel `.json` arrive
 * ici, recevrait `lastOpenedAt`, et son dossier un `.cliodeck`. La seule garde des deux portes :
 * `project:load`, et `project:get-metadata`, que le renderer interroge avant de quitter le document
 * ouvert. Tolérante à dessein, car un faux refus fermerait à l'auteur son propre projet : au bon nom,
 * `name` en texte suffit, ou un type connu. Un fichier mal nommé se refuse sans être lu.
 */
async function readManifestToOpen(projectFile: string): Promise<Project> {
  const name = path.basename(projectFile);
  if (name.toLowerCase() !== PROJECT_FILE) throw new NotAProjectError(projectFile, 'not_a_project');
  const project = await readManifest(projectFile);
  // Sur un disque sans casse, `Project.json` est bien ce que le reste du code relira. Sur un disque
  // à casse, ce serait un autre fichier ou aucun : le projet s'ouvrirait sans pouvoir se relire.
  const rereadable = name === PROJECT_FILE || sameFile(projectFile, path.join(path.dirname(projectFile), PROJECT_FILE));
  const describesProject = typeof project.name === 'string' || PROJECT_TYPES.has(project.type);
  if (!rereadable || !describesProject) throw new NotAProjectError(projectFile, 'manifest_invalid');
  return project;
}

/**
 * Le dossier existe, se liste, et `project.json` n'y est vraiment pas. Le seul cas où un projet
 * récent peut sortir de la liste : un volume débranché ou un parent renommé lisent ENOENT eux
 * aussi, comme un lien vers un volume absent, que seul `lstat` voit encore.
 */
async function projectFileIsMissing(projectFile: string): Promise<boolean> {
  try {
    await lstat(projectFile);
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    const entries = await readdir(path.dirname(projectFile));
    return !entries.includes(path.basename(projectFile)) && !(await isEvictedByIcloud(projectFile));
  } catch {
    return false;
  }
}

export class ProjectManager {
  private currentProject: Project | null = null;
  private currentProjectPath: string | null = null;

  /**
   * Retourne le chemin du dossier du projet actuellement ouvert
   */
  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }

  /**
   * Retourne le projet actuellement ouvert
   */
  getCurrentProject(): Project | null {
    return this.currentProject;
  }

  /**
   * Reads project metadata without setting it as the current project.
   * Used for displaying recent projects list without affecting the active project.
   */
  async getProjectMetadata(projectPath: string) {
    try {
      const project = await readManifestToOpen(projectPath);
      const projectDir = path.dirname(projectPath);

      // Load bibliography if configured (resolve relative path to absolute)
      if (project.bibliographySource?.filePath) {
        const bibPath = path.join(projectDir, project.bibliographySource.filePath);
        if (existsSync(bibPath)) {
          project.bibliography = bibPath;
        }
      }

      // Resolve cslPath to absolute for display
      if (project.cslPath && !path.isAbsolute(project.cslPath)) {
        const absoluteCslPath = path.join(projectDir, project.cslPath);
        if (existsSync(absoluteCslPath)) {
          project.cslPath = absoluteCslPath;
        }
      }

      // Set path dynamically
      project.path = projectDir;

      return { success: true as const, project };
    } catch (error: unknown) {
      // Chaque récent passe ici à chaque ouverture du panneau : pas de pile pour un disque débranché.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ Project metadata unavailable:', message);
      const code = error instanceof NotAProjectError
        ? error.code
        : (await projectFileIsMissing(projectPath)) ? 'project_file_missing' : 'project_unavailable';
      return { success: false as const, code, fileName: path.basename(projectPath), error: message };
    }
  }

  async createProject(data: { name: string; type?: string; path: string; content?: string }) {
    const projectType = data.type || 'article';

    // Create a subfolder with the project name
    const projectPath = path.join(data.path, data.name);

    // Issue #13: path is computed dynamically, not stored in project.json
    const project: Project = {
      id: crypto.randomUUID(),
      name: data.name,
      type: projectType,
      path: projectPath, // Keep in memory for renderer
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };

    const templates: TemplateFile[] = [];

    // Livre : squelette multi-fichiers + manifeste + réglages d'ouvrage.
    // Le `#` du fichier EST le titre du chapitre (plan, arbitrage 1) : le
    // manifeste et le fichier disent donc la même chose, et l'auteur peut
    // renommer depuis l'un ou l'autre.
    if (projectType === 'book') {
      const firstTitle = 'Introduction';
      const firstFile = chapterFileName(0, firstTitle);
      templates.push({
        relPath: path.join(CHAPTERS_DIR, firstFile),
        content: `# ${firstTitle}\n\n`,
      });

      project.chapters = [
        {
          id: crypto.randomUUID(),
          title: firstTitle,
          filePath: `${CHAPTERS_DIR}/${firstFile}`,
          order: 0,
          kind: 'chapter',
        },
      ];
      project.book = { ...DEFAULT_BOOK_SETTINGS };
    }

    // Article et présentation gardent leur document monolithique ; le livre
    // n'a PAS de document.md (son texte vit dans chapters/).
    if (projectType !== 'book') {
      templates.push({ relPath: 'document.md', content: data.content || '# ' + data.name });
    }

    // For articles and books, create abstract.md and context.md
    if (projectType === 'article' || projectType === 'book') {
      templates.push({ relPath: 'abstract.md', content: '# Résumé\n\nRésumé à compléter...' });

      // Gabarit inerte : les instructions vivent dans un commentaire HTML,
      // retiré avant injection (cf. backend/core/hints/loader.ts). Un
      // context.md jamais édité n'apprend donc rien au modèle — l'ancien
      // gabarit, lui, aurait injecté son exemple sur l'IA dans l'éducation.
      templates.push({ relPath: CONTEXT_FILE, content: CONTEXT_TEMPLATE });
    }

    // For presentations, create slides.md with reveal.js syntax
    if (projectType === 'presentation') {
      templates.push({ relPath: 'slides.md', content: slidesTemplate(data.name) });
    }

    // project.json (without path field - it's computed from file location)
    // s'écrit en dernier : tant qu'il manque, le dossier n'est pas un projet.
    const { path: _excludedPath, ...projectForSave } = project;
    templates.push({ relPath: 'project.json', content: JSON.stringify(projectForSave, null, 2) });

    // Créer ne remplace jamais rien : on refuse avant toute écriture, sans
    // toucher au projet courant ni aux projets récents.
    if (existsSync(path.join(projectPath, 'project.json'))) {
      return { success: false as const, error: 'project_exists' };
    }
    if (templates.some((file) => existsSync(path.join(projectPath, file.relPath)))) {
      return { success: false as const, error: 'project_files_exist' };
    }

    try {
      await writeTemplates(projectPath, templates);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { success: false as const, error: 'project_files_exist' };
      }
      throw error;
    }

    // Ensure flat .cliodeck/ layout (with config.json) from day 1. Idempotent.
    await autoMigrateWorkspace(projectPath);
    // Le dossier pouvait déjà porter un `.cliodeck` : mêmes conséquences qu'à l'ouverture.
    const configIssue = await workspaceConfigIssue(projectPath);

    const projectFile = path.join(projectPath, 'project.json');

    // Add to recent projects
    configManager.addRecentProject(projectFile);

    // Store as current project
    this.currentProject = project;
    this.currentProjectPath = projectPath;

    console.log('✅ Project created:', projectPath);
    return { success: true as const, path: projectFile, project, ...(configIssue ? { configIssue } : {}) };
  }

  /**
   * La seule porte d'écriture de `project.json`, création exclusive mise à part. Le mutateur part
   * de ce que dit le disque, sous le verrou du fichier, et n'y pose que ses champs : rien ne vient
   * de la mémoire, donc rien n'efface la mise à jour d'à côté. Il reste court. Ce qui se calcule
   * à partir de l'emplacement (`path`, `bibliography`, `cslPath` en absolu) se pose sur le résultat,
   * après : ni le mutateur ne le voit, ni le disque, où il deviendrait faux au premier déplacement.
   * Un fichier absent ou illisible lève, sans rien écrire.
   */
  private async updateProjectFile(
    projectFile: string,
    mutate: (project: Project) => void | Promise<void>
  ): Promise<Project> {
    const { value } = await updateJsonFile<Project>(projectFile, async (current) => {
      if (current === null) throw new Error(`Project file not found: ${projectFile}`);
      assertIsManifest(projectFile, current);
      await mutate(current);
      // Issue #13: path is computed from the file location, never stored.
      const { path: _excludedPath, ...projectForSave } = current;
      return projectForSave as Project;
    });
    return value as Project;
  }

  /** Ce projet est-il celui que la mémoire tient ? Le dossier entier, pas un préfixe du chemin. */
  private isCurrentProject(projectDir: string): boolean {
    return this.currentProject !== null && this.currentProjectPath === projectDir;
  }

  async loadProject(projectPath: string): Promise<{
    success: boolean;
    project?: Project;
    configIssue?: WorkspaceConfigIssue;
    code?: NotAProjectError['code'];
    fileName?: string;
    error?: string;
  }> {
    try {
      // Refusé ici, B n'a rien subi, pas même sa migration, et le projet courant reste en place.
      await readManifestToOpen(projectPath);
      const projectDir = path.dirname(projectPath);
      // Le nom que relit tout le code, celui du verrou d'écriture, celui que gardent les récents.
      const projectFile = path.join(projectDir, PROJECT_FILE);

      // Promote in-flight v2-subdir or pre-fusion v1 workspaces to flat layout
      // before any service opens DB handles into `.cliodeck/`.
      await autoMigrateWorkspace(projectDir);

      // Le projet s'ouvre quand même : son texte n'y est pour rien. L'interface dit ce qui manque.
      const configIssue = await workspaceConfigIssue(projectDir);

      const project = await this.updateProjectFile(projectFile, (stored) => {
        // Migration: Convert absolute paths to relative paths
        if (stored.bibliographySource?.filePath && path.isAbsolute(stored.bibliographySource.filePath)) {
          const relativePath = path.relative(projectDir, stored.bibliographySource.filePath);
          console.log('🔄 Migrating bibliography path from absolute to relative:', relativePath);
          stored.bibliographySource.filePath = relativePath;
        }

        if (stored.cslPath && path.isAbsolute(stored.cslPath)) {
          const relativePath = path.relative(projectDir, stored.cslPath);
          console.log('🔄 Migrating CSL path from absolute to relative:', relativePath);
          stored.cslPath = relativePath;
        }

        // Livre : les réglages d'ouvrage sont normalisés (défauts pour les
        // champs absents, valeurs inconnues ignorées) afin que la suite de la
        // chaîne — assemblage, template — n'ait jamais à se défendre contre un
        // `project.json` édité à la main.
        if (stored.type === 'book') {
          const normalized = normalizeBookSettings(stored.book);
          if (JSON.stringify(normalized) !== JSON.stringify(stored.book)) {
            stored.book = normalized;
          }
          if (!Array.isArray(stored.chapters)) {
            // Pas de migration (arbitrage 10) : un manifeste vide suffit, la
            // réconciliation disque proposera de rattacher ce qu'elle trouve.
            stored.chapters = [];
          }
        }

        stored.lastOpenedAt = new Date().toISOString();
      });

      // Load bibliography if configured (resolve relative path to absolute)
      console.log('🔍 Checking for bibliography source:', project.bibliographySource);
      if (project.bibliographySource?.filePath) {
        const bibPath = path.join(projectDir, project.bibliographySource.filePath);
        console.log('🔍 Looking for bibliography at:', bibPath);
        if (existsSync(bibPath)) {
          project.bibliography = bibPath;
          console.log('📚 Bibliography found:', bibPath);
        } else {
          console.log('⚠️ Bibliography file not found:', bibPath);
        }
      } else {
        console.log('ℹ️ No bibliography source configured');
      }

      // Resolve cslPath to absolute for runtime use (after saving)
      if (project.cslPath && !path.isAbsolute(project.cslPath)) {
        const absoluteCslPath = path.join(projectDir, project.cslPath);
        if (existsSync(absoluteCslPath)) {
          project.cslPath = absoluteCslPath;
          console.log('📄 CSL file resolved to absolute path:', absoluteCslPath);
        } else {
          console.log('⚠️ CSL file not found:', absoluteCslPath);
        }
      }

      configManager.addRecentProject(projectFile);

      // Issue #13: Always set path dynamically from projectDir (not from file)
      // This ensures paths are always correct regardless of synchronization
      project.path = projectDir;

      // Store current project
      this.currentProject = project;
      this.currentProjectPath = projectDir;

      console.log('✅ Project loaded:', projectPath);
      console.log('📤 Returning project with bibliography:', {
        hasBibliography: !!project.bibliography,
        bibliographyPath: project.bibliography,
        hasBibliographySource: !!project.bibliographySource
      });

      return { success: true, project, ...(configIssue ? { configIssue } : {}) };
    } catch (error: unknown) {
      console.error('❌ Failed to load project:', error);
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NotAProjectError) {
        return { success: false, code: error.code, fileName: path.basename(projectPath), error: message };
      }
      return { success: false, error: message };
    }
  }

  async saveProject(data: { path: string; content: string; bibliography?: string }) {
    try {
      await this.updateProjectFile(data.path, (project) => {
        project.updatedAt = new Date().toISOString();
        if (data.bibliography !== undefined) {
          project.bibliography = data.bibliography;
        }
      });

      // NE PLUS écrire document.md ici. Ce chemin écrivait le contenu reçu
      // dans un `document.md` codé en dur à côté du project.json — dans un
      // livre à chapitres, il aurait écrasé un fichier qui n'est plus le
      // manuscrit. La sauvegarde du texte passe par `editor:save-file`, qui
      // connaît le vrai chemin du fichier ouvert.

      console.log('✅ Project saved:', data.path);
      return { success: true };
    } catch (error: unknown) {
      console.error('❌ Failed to save project:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Résout un chemin de projet — dossier OU `project.json` — vers le
   * couple (dossier, fichier manifeste). Les appelants historiques
   * passaient tantôt l'un tantôt l'autre ; on accepte les deux plutôt que
   * de faire échouer l'ouverture sur un détail de forme.
   */
  private resolveProjectPaths(projectPathOrFile: string): {
    projectDir: string;
    projectFile: string;
  } {
    const isJson = projectPathOrFile.endsWith('.json');
    const projectDir = isJson ? path.dirname(projectPathOrFile) : projectPathOrFile;
    return { projectDir, projectFile: path.join(projectDir, 'project.json') };
  }

  /**
   * Refuse tout chemin de manifeste qui sort du dossier du projet. Contrôle lexical : il
   * dit si une ligne a sa place dans le manifeste. Un lien se juge à part
   * (`leavesProject`) : sa ligne reste, son fichier peut être rétabli à cet endroit.
   */
  private isInsideProject(projectDir: string, relPath: string): boolean {
    if (path.isAbsolute(relPath)) return false;
    const resolved = path.resolve(projectDir, relPath);
    const rel = path.relative(projectDir, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** Ce chemin du projet mène-t-il dehors, par un lien (le sien ou celui d'un dossier) ? */
  private leavesProject(projectDir: string, relPath: string): boolean {
    return !isInside(projectDir, path.resolve(projectDir, relPath));
  }

  private readChapter(projectDir: string, relPath: string): Promise<ChapterRead> {
    if (!this.isInsideProject(projectDir, relPath) || this.leavesProject(projectDir, relPath)) {
      return Promise.resolve({
        filePath: relPath,
        reason: 'refused',
        error: `Path "${relPath}" escapes the project directory`,
      });
    }
    const absolute = path.resolve(projectDir, relPath);
    return withFileLock(absolute, async (): Promise<ChapterRead> => {
      const read = await readUserFile(absolute);
      if (read.kind === 'ok') return { filePath: relPath, content: read.content };
      return read.kind === 'absent'
        ? { filePath: relPath, reason: 'absent', error: `${relPath}: file not found` }
        : { filePath: relPath, reason: read.reason, error: read.message };
    });
  }

  /** Titre suggéré pour un fichier non rattaché : son premier `#`. */
  private async suggestTitle(absPath: string): Promise<string | undefined> {
    try {
      const content = await readFile(absPath, 'utf-8');
      const match = content.match(/^\s*#\s+(.+?)\s*$/m);
      return match ? match[1] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Manifeste du manuscrit, réconcilié avec le disque.
   *
   * Le paramètre est le **chemin du projet** (dossier ou `project.json`),
   * pas un identifiant : bien des `project.json` n'ont pas de champ `id`,
   * et s'appuyer dessus a déjà rendu des projets inouvrables.
   *
   * Réconciliation (décision cadre n°2 — on ne perd jamais de texte) :
   * - une entrée dont le fichier a disparu est conservée et marquée
   *   `missing`, jamais supprimée en silence ; de même pour un lien qui
   *   sort du projet, marqué en plus `outsideProject` et jamais lu ;
   * - un `.md` présent dans le projet ou dans `chapters/` mais absent du
   *   manifeste est retourné comme « non rattaché », avec un titre suggéré.
   */
  async getChapters(projectPathOrFile: string): Promise<{
    success: boolean;
    chapters: ResolvedChapter[];
    unattached: UnattachedFile[];
    error?: string;
  }> {
    try {
      const { projectDir, projectFile } = this.resolveProjectPaths(projectPathOrFile);

      let manifest: Chapter[] = [];
      if (existsSync(projectFile)) {
        const raw = await readFile(projectFile, 'utf-8');
        const project = parseUserJson<Project>(raw);
        manifest = Array.isArray(project.chapters) ? project.chapters : [];
      }

      // Entrées du manifeste : garde anti-évasion, puis existence.
      const chapters: ResolvedChapter[] = [];
      for (const entry of manifest) {
        if (!entry?.filePath || !this.isInsideProject(projectDir, entry.filePath)) {
          console.warn(
            '⚠️ Chapitre ignoré (chemin hors du projet):',
            entry?.filePath
          );
          continue;
        }
        const abs = path.resolve(projectDir, entry.filePath);
        let onDisk: Pick<ResolvedChapter, 'missing' | 'outsideProject'> = {};
        if (this.leavesProject(projectDir, entry.filePath)) {
          onDisk = { missing: true, outsideProject: true };
        } else if (!existsSync(abs)) {
          onDisk = { missing: true };
        }
        chapters.push({ ...entry, kind: entry.kind ?? 'chapter', ...onDisk });
      }
      chapters.sort((a, b) => a.order - b.order);

      // Fichiers du disque absents du manifeste.
      const claimed = new Set(
        chapters.map((c) => path.normalize(c.filePath).replace(/\\/g, '/'))
      );
      const unattached: UnattachedFile[] = [];

      const scan = async (dirRel: string): Promise<void> => {
        const dirAbs = dirRel ? path.join(projectDir, dirRel) : projectDir;
        if (!existsSync(dirAbs)) return;
        // `chapters` lié ailleurs : ce dossier n'est pas celui du projet.
        if (dirRel && this.leavesProject(projectDir, dirRel)) return;
        let entries: string[];
        try {
          entries = await readdir(dirAbs);
        } catch {
          return;
        }
        for (const name of entries) {
          if (!name.endsWith('.md')) continue;
          if (!dirRel && (NON_CHAPTER_FILES as readonly string[]).includes(name)) {
            continue; // pièces connues du projet, pas des chapitres
          }
          const rel = dirRel ? `${dirRel}/${name}` : name;
          if (claimed.has(rel)) continue;
          unattached.push({
            filePath: rel,
            // Un lien qui sort du projet : on n'en lit rien, pas même le titre.
            suggestedTitle: this.leavesProject(projectDir, rel)
              ? undefined
              : await this.suggestTitle(path.join(dirAbs, name)),
          });
        }
      };

      await scan('');
      await scan(CHAPTERS_DIR);

      return { success: true, chapters, unattached };
    } catch (error: unknown) {
      console.error('❌ Failed to get chapters:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, chapters: [], unattached: [], error: message };
    }
  }

  /**
   * Écrit le manifeste. Les chemins sont re-vérifiés côté main : le
   * renderer n'est pas une frontière de confiance suffisante pour laisser
   * entrer un `../..` dans un fichier de projet.
   *
   * Seul champ écrit en entier depuis le renderer, parce que lui seul sait ce qu'il a retiré : une
   * entrée du disque absente de la liste reçue peut être un retrait comme une création d'à côté.
   * Limite assumée : `createChapter` puis `saveChapters` sur la liste d'avant retire l'entrée du
   * manifeste. Le fichier reste, et se propose comme non rattaché : aucun texte n'est perdu.
   */
  async saveChapters(data: { projectPath: string; chapters: Chapter[] }) {
    try {
      const { projectDir, projectFile } = this.resolveProjectPaths(data.projectPath);

      for (const chapter of data.chapters) {
        if (!this.isInsideProject(projectDir, chapter.filePath)) {
          throw new Error(
            `Chapter path "${chapter.filePath}" escapes the project directory`
          );
        }
      }

      // L'ordre stocké est renormalisé sur l'ordre du tableau reçu : le
      // manifeste fait foi (arbitrage 7), pas les valeurs envoyées.
      const chapters = data.chapters.map((c, index) => ({
        ...c,
        order: index,
        kind: c.kind ?? 'chapter',
      }));
      await this.updateProjectFile(projectFile, (project) => {
        project.chapters = chapters;
        project.updatedAt = new Date().toISOString();
      });

      if (this.currentProject && this.isCurrentProject(projectDir)) {
        this.currentProject.chapters = chapters;
      }

      console.log('✅ Chapters saved:', chapters.length);
      return { success: true, chapters };
    } catch (error: unknown) {
      console.error('❌ Failed to save chapters:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Lecture groupée de chapitres (plan chapitres, Phase 3).
   *
   * Les fonctions transverses — renumérotation de l'ouvrage, vérification
   * des citations, statistiques — ont besoin du texte des chapitres qui ne
   * sont PAS ouverts dans l'éditeur. Même garde anti-évasion que le reste :
   * un chemin qui sort du projet est refusé, pas lu.
   *
   * Un fichier illisible (disparu entre-temps, ou qui n'est pas en UTF-8) est
   * retourné avec sa raison plutôt que de faire échouer toute la lecture :
   * l'appelant décide s'il peut travailler sans lui. La lecture est stricte, comme
   * à l'ouverture : la renumérotation réécrit ce qu'elle lit, et un décodage avec
   * perte rendrait définitifs les U+FFFD qu'elle y aurait trouvés.
   */
  async readChapters(data: { projectPath: string; filePaths: string[] }): Promise<{
    success: boolean;
    files: ChapterRead[];
    error?: string;
  }> {
    try {
      const { projectDir } = this.resolveProjectPaths(data.projectPath);
      // Tous les verrous dès la réception : une lecture demandée après une écriture lit
      // ce que celle-ci a écrit.
      const files = await Promise.all(
        data.filePaths.map((relPath) => this.readChapter(projectDir, relPath))
      );
      return { success: true, files };
    } catch (error: unknown) {
      console.error('❌ Failed to read chapters:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, files: [], error: message };
    }
  }

  /** Écrit les réglages d'ouvrage (normalisés) dans `project.json`. */
  async saveBookSettings(data: {
    projectPath: string;
    settings: Partial<BookSettings>;
  }) {
    try {
      const { projectDir, projectFile } = this.resolveProjectPaths(data.projectPath);

      const { book: settings } = await this.updateProjectFile(projectFile, (project) => {
        project.book = normalizeBookSettings({ ...project.book, ...data.settings });
        project.updatedAt = new Date().toISOString();
      });

      if (this.currentProject && this.isCurrentProject(projectDir)) {
        this.currentProject.book = settings;
      }

      console.log('✅ Book settings saved');
      return { success: true, settings };
    } catch (error: unknown) {
      console.error('❌ Failed to save book settings:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Crée le fichier d'un nouveau chapitre et l'ajoute au manifeste.
   * Le fichier reçoit son `#` (le titre du chapitre EST son premier titre).
   */
  async createChapter(data: {
    projectPath: string;
    title: string;
    kind?: Chapter['kind'];
  }) {
    try {
      const { projectDir, projectFile } = this.resolveProjectPaths(data.projectPath);

      // Sous le verrou du manifeste : l'ordre et le nom libre se décident sur la liste du disque, et
      // deux créations ne prennent ni le même numéro, ni le même fichier.
      let chapter: Chapter | undefined;
      const { chapters: stored } = await this.updateProjectFile(projectFile, async (project) => {
        const chapters: Chapter[] = Array.isArray(project.chapters) ? project.chapters : [];

        const order = chapters.length;
        const chaptersDir = path.join(projectDir, CHAPTERS_DIR);
        // Le fichier s'écrirait à l'autre bout du lien, et naîtrait manquant.
        if (this.leavesProject(projectDir, CHAPTERS_DIR)) {
          throw new Error(
            `Le dossier ${CHAPTERS_DIR} est un lien qui sort du projet : impossible d'y créer un chapitre.`
          );
        }
        await mkdir(chaptersDir, { recursive: true });

        // Nom libre s'il est déjà pris : le préfixe n'a pas valeur d'autorité,
        // mais deux fichiers ne peuvent pas partager un nom.
        // Un lien cassé vers l'extérieur n'est pas un nom libre : `existsSync` ne le voit pas,
        // et `writeFile` créerait le fichier à l'autre bout.
        const taken = (name: string): boolean =>
          existsSync(path.join(chaptersDir, name)) ||
          this.leavesProject(projectDir, path.join(CHAPTERS_DIR, name));
        let fileName = chapterFileName(order, data.title);
        let attempt = 2;
        while (taken(fileName)) {
          fileName = chapterFileName(order, `${data.title}-${attempt}`);
          attempt += 1;
        }

        await writeFile(path.join(chaptersDir, fileName), `# ${data.title}\n\n`);

        chapter = {
          id: crypto.randomUUID(),
          title: data.title,
          filePath: `${CHAPTERS_DIR}/${fileName}`,
          order,
          kind: data.kind ?? 'chapter',
        };

        project.chapters = [...chapters, chapter];
        project.updatedAt = new Date().toISOString();
      });

      if (this.currentProject && this.isCurrentProject(projectDir)) {
        this.currentProject.chapters = stored;
      }

      if (!chapter) throw new Error('Chapter not created');
      console.log('✅ Chapter created:', chapter.filePath);
      return { success: true, chapter };
    } catch (error: unknown) {
      console.error('❌ Failed to create chapter:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async setBibliographySource(data: {
    projectPath: string;
    type: 'file' | 'zotero';
    filePath?: string;
    zoteroCollection?: string;
  }) {
    try {
      const projectDir = dirname(data.projectPath);

      let relativeFilePath = data.filePath;

      // Convert absolute path to relative if it's a file path
      if (data.type === 'file' && data.filePath) {
        if (path.isAbsolute(data.filePath)) {
          relativeFilePath = path.relative(projectDir, data.filePath);
          console.log('📝 Converted bibliography path to relative:', relativeFilePath);
        }
      }

      const { bibliographySource } = await this.updateProjectFile(data.projectPath, (project) => {
        project.bibliographySource = {
          type: data.type,
          filePath: relativeFilePath,
          zoteroCollection: data.zoteroCollection,
        };
        project.updatedAt = new Date().toISOString();
      });

      if (this.currentProject && this.isCurrentProject(projectDir)) {
        this.currentProject.bibliographySource = bibliographySource;
      }

      console.log('✅ Bibliography source configured:', data.type);
      return { success: true };
    } catch (error: unknown) {
      console.error('❌ Failed to set bibliography source:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Get project configuration from project.json
   */
  async getConfig(projectPath: string): Promise<Project | null> {
    try {
      if (!existsSync(projectPath)) {
        console.warn('⚠️ Project file not found:', projectPath);
        return null;
      }

      const content = await readFile(projectPath, 'utf-8');
      const project = parseUserJson<Project>(content);
      return project;
    } catch (error: unknown) {
      console.error('❌ Failed to get project config:', error);
      return null;
    }
  }

  /**
   * Update project configuration (partial update)
   */
  async updateConfig(projectPath: string, updates: Partial<Project>): Promise<{ success: boolean; error?: string }> {
    try {
      // Seuls les champs reçus changent : le reste vient du disque, pas du renderer.
      const stored = await this.updateProjectFile(projectPath, (project) => {
        Object.assign(project, updates, zoteroUpdate(project.zotero, updates.zotero), {
          updatedAt: new Date().toISOString(),
        });
      });
      console.log('✅ Project config updated:', projectPath);

      // La mémoire garde ce qui s'y résout (chemins en absolu), et le chemin du projet.
      if (this.currentProject && this.isCurrentProject(this.resolveProjectPaths(projectPath).projectDir)) {
        const { path: _excludedPath, ...received } = updates;
        this.currentProject = {
          ...this.currentProject,
          ...received,
          zotero: stored.zotero,
          updatedAt: stored.updatedAt,
        };
      }

      return { success: true };
    } catch (error: unknown) {
      console.error('❌ Failed to update project config:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async setCSLPath(data: {
    projectPath: string;
    cslPath?: string;
  }): Promise<{ success: boolean; cslPath?: string; notCopied?: true; error?: string }> {
    try {
      console.log('📝 setCSLPath called with:', data);

      // Validate projectPath
      if (!data.projectPath) {
        throw new Error('Project path is required');
      }

      // Avant la copie : un manifeste illisible ne fait rien entrer dans le dossier du projet.
      await readManifest(data.projectPath);
      const projectDir = dirname(data.projectPath);

      let relativeCslPath: string | undefined = undefined;
      let notCopied = false;

      // If a CSL file is provided, copy it to project if it's external
      if (data.cslPath && existsSync(data.cslPath)) {
        const cslFileName = basename(data.cslPath);
        const projectCslPath = join(projectDir, cslFileName);

        // Check if CSL file is outside the project directory
        if (!data.cslPath.startsWith(projectDir)) {
          console.log('📋 Copying CSL file to project directory...');
          console.log('   Source:', data.cslPath);
          console.log('   Destination:', projectCslPath);

          try {
            await copyFile(data.cslPath, projectCslPath);
            // Store as relative path (just the filename)
            relativeCslPath = cslFileName;
            console.log('✅ CSL file copied successfully, stored as relative path:', relativeCslPath);
          } catch (copyError: unknown) {
            console.error('❌ Failed to copy CSL file:', copyError);
            // Le style reste utilisable depuis sa place, et l'auteur le sait :
            // il ne suivra pas le projet sur une autre machine.
            relativeCslPath = data.cslPath;
            notCopied = true;
          }
        } else {
          // File is already in project directory, store as relative path
          relativeCslPath = path.relative(projectDir, data.cslPath);
          console.log('✅ CSL file in project directory, stored as relative path:', relativeCslPath);
        }
      }

      await this.updateProjectFile(data.projectPath, (project) => {
        project.cslPath = relativeCslPath;
        project.updatedAt = new Date().toISOString();
      });

      console.log('✅ CSL path configured:', relativeCslPath);
      // Return the absolute path for the UI. Une copie ratée garde le chemin
      // absolu de la source : le joindre au dossier du projet rendait un
      // chemin qui n'existe pas, et l'export écartait le style en silence.
      const absolutePath = relativeCslPath
        ? path.isAbsolute(relativeCslPath)
          ? relativeCslPath
          : join(projectDir, relativeCslPath)
        : undefined;
      if (this.currentProject && this.isCurrentProject(projectDir)) {
        this.currentProject.cslPath = absolutePath;
      }
      return { success: true, cslPath: absolutePath, ...(notCopied ? { notCopied: true as const } : {}) };
    } catch (error: unknown) {
      console.error('❌ Failed to set CSL path:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message || 'Unknown error' };
    }
  }
}

export const projectManager = new ProjectManager();
