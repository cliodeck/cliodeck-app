import { writeFile, readFile, mkdir, copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { dirname, basename, join } from 'path';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import { migrateWorkspaceToFlat } from '../../../backend/core/workspace/migrator.js';
import {
  CHAPTERS_DIR,
  DEFAULT_BOOK_SETTINGS,
  NON_CHAPTER_FILES,
  chapterFileName,
  normalizeBookSettings,
  type BookSettings,
  type Chapter,
  type ResolvedChapter,
  type UnattachedFile,
} from '../../../backend/types/book.js';

async function autoMigrateWorkspace(projectDir: string): Promise<void> {
  // Best-effort: a failed migration must not block project load. The next
  // load will retry. Most-common case (already-flat workspace) is a no-op.
  try {
    const report = await migrateWorkspaceToFlat(projectDir);
    if (report.copied.length > 0 || report.warnings.length > 0) {
      console.log('[workspace] auto-migration:', {
        kind: report.kind,
        copied: report.copied.length,
        skipped: report.skipped.length,
        warnings: report.warnings.length,
      });
    }
  } catch (e) {
    console.warn(
      '[workspace] auto-migration failed (non-fatal):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

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
      const content = await readFile(projectPath, 'utf-8');
      const project: Project = JSON.parse(content);
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

      return { success: true, project };
    } catch (error: unknown) {
      console.error('❌ Failed to get project metadata:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async createProject(data: { name: string; type?: string; path: string; content?: string }) {
    const projectType = data.type || 'article';

    // Create a subfolder with the project name
    const projectPath = path.join(data.path, data.name);

    // Create folder if it doesn't exist
    if (!existsSync(projectPath)) {
      await mkdir(projectPath, { recursive: true });
    }

    // Ensure flat .cliodeck/ layout (with config.json) from day 1. Idempotent.
    await autoMigrateWorkspace(projectPath);

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

    // Livre : squelette multi-fichiers + manifeste + réglages d'ouvrage.
    // Le `#` du fichier EST le titre du chapitre (plan, arbitrage 1) : le
    // manifeste et le fichier disent donc la même chose, et l'auteur peut
    // renommer depuis l'un ou l'autre.
    if (projectType === 'book') {
      const chaptersPath = path.join(projectPath, CHAPTERS_DIR);
      await mkdir(chaptersPath, { recursive: true });

      const firstTitle = 'Introduction';
      const firstFile = chapterFileName(0, firstTitle);
      await writeFile(
        path.join(chaptersPath, firstFile),
        `# ${firstTitle}\n\n`
      );

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

    // Create project.json (without path field - it's computed from file location)
    const projectFile = path.join(projectPath, 'project.json');
    const { path: _excludedPath, ...projectForSave } = project;
    await writeFile(projectFile, JSON.stringify(projectForSave, null, 2));

    // Article et présentation gardent leur document monolithique ; le livre
    // n'a PAS de document.md (son texte vit dans chapters/).
    if (projectType !== 'book') {
      const mdFile = path.join(projectPath, 'document.md');
      await writeFile(mdFile, data.content || '# ' + data.name);
    }

    // For articles and books, create abstract.md and context.md
    if (projectType === 'article' || projectType === 'book') {
      const abstractFile = path.join(projectPath, 'abstract.md');
      await writeFile(abstractFile, '# Résumé\n\nRésumé à compléter...');

      const contextFile = path.join(projectPath, 'context.md');
      await writeFile(contextFile, '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. Ce contexte sera utilisé pour améliorer les réponses de l\'assistant IA.\n\nExemple : "Cette recherche porte sur l\'impact de l\'intelligence artificielle dans l\'éducation supérieure, avec un focus particulier sur la taxonomie de Bloom et les stratégies pédagogiques actives."');
    }

    // For presentations, create slides.md with reveal.js syntax
    if (projectType === 'presentation') {
      const slidesFile = path.join(projectPath, 'slides.md');
      const slidesTemplate = `## ${data.name}

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
      await writeFile(slidesFile, slidesTemplate);
    }

    // Add to recent projects
    configManager.addRecentProject(projectFile);

    // Store as current project
    this.currentProject = project;
    this.currentProjectPath = projectPath;

    console.log('✅ Project created:', projectPath);
    return { success: true, path: projectFile, project };
  }

  async loadProject(projectPath: string) {
    try {
      // Load project.json file
      const content = await readFile(projectPath, 'utf-8');
      const project: Project = JSON.parse(content);
      const projectDir = path.dirname(projectPath);

      // Promote in-flight v2-subdir or pre-fusion v1 workspaces to flat layout
      // before any service opens DB handles into `.cliodeck/`.
      await autoMigrateWorkspace(projectDir);

      // Migration: Convert absolute paths to relative paths
      let needsSave = false;

      // Migrate bibliographySource.filePath
      if (project.bibliographySource?.filePath && path.isAbsolute(project.bibliographySource.filePath)) {
        const relativePath = path.relative(projectDir, project.bibliographySource.filePath);
        console.log('🔄 Migrating bibliography path from absolute to relative:', relativePath);
        project.bibliographySource.filePath = relativePath;
        needsSave = true;
      }

      // Migrate cslPath
      if (project.cslPath && path.isAbsolute(project.cslPath)) {
        const relativePath = path.relative(projectDir, project.cslPath);
        console.log('🔄 Migrating CSL path from absolute to relative:', relativePath);
        project.cslPath = relativePath;
        needsSave = true;
      }

      // Livre : les réglages d'ouvrage sont normalisés (défauts pour les
      // champs absents, valeurs inconnues ignorées) afin que la suite de la
      // chaîne — assemblage, template — n'ait jamais à se défendre contre un
      // `project.json` édité à la main.
      if (project.type === 'book') {
        const normalized = normalizeBookSettings(project.book);
        if (JSON.stringify(normalized) !== JSON.stringify(project.book)) {
          project.book = normalized;
          needsSave = true;
        }
        if (!Array.isArray(project.chapters)) {
          // Pas de migration (arbitrage 10) : un manifeste vide suffit, la
          // réconciliation disque proposera de rattacher ce qu'elle trouve.
          project.chapters = [];
          needsSave = true;
        }
      }

      // Update lastOpenedAt
      project.lastOpenedAt = new Date().toISOString();
      needsSave = true;

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

      // Save update (including migration if needed)
      // IMPORTANT: Save before resolving paths to absolute
      // Issue #13: Exclude path field from saved file (it's computed from file location)
      if (needsSave) {
        const { path: _excludedPath, ...projectForSave } = project;
        await writeFile(projectPath, JSON.stringify(projectForSave, null, 2));
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

      configManager.addRecentProject(projectPath);

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

      return { success: true, project };
    } catch (error: unknown) {
      console.error('❌ Failed to load project:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async saveProject(data: { path: string; content: string; bibliography?: string }) {
    try {
      // Charger le projet existant
      const projectContent = await readFile(data.path, 'utf-8');
      const project: Project = JSON.parse(projectContent);

      // Mettre à jour
      project.updatedAt = new Date().toISOString();
      if (data.bibliography !== undefined) {
        project.bibliography = data.bibliography;
      }

      // Sauvegarder le projet (Issue #13: exclure le champ path)
      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(data.path, JSON.stringify(projectForSave, null, 2));

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

  /** Refuse tout chemin de manifeste qui sort du dossier du projet. */
  private isInsideProject(projectDir: string, relPath: string): boolean {
    if (path.isAbsolute(relPath)) return false;
    const resolved = path.resolve(projectDir, relPath);
    const rel = path.relative(projectDir, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
   *   `missing`, jamais supprimée en silence ;
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
        const project: Project = JSON.parse(raw);
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
        chapters.push({
          ...entry,
          kind: entry.kind ?? 'chapter',
          ...(existsSync(abs) ? {} : { missing: true }),
        });
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
            suggestedTitle: await this.suggestTitle(path.join(dirAbs, name)),
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
   */
  async saveChapters(data: { projectPath: string; chapters: Chapter[] }) {
    try {
      const { projectDir, projectFile } = this.resolveProjectPaths(data.projectPath);
      if (!existsSync(projectFile)) {
        throw new Error(`Project file not found: ${projectFile}`);
      }

      for (const chapter of data.chapters) {
        if (!this.isInsideProject(projectDir, chapter.filePath)) {
          throw new Error(
            `Chapter path "${chapter.filePath}" escapes the project directory`
          );
        }
      }

      const raw = await readFile(projectFile, 'utf-8');
      const project: Project = JSON.parse(raw);

      // L'ordre stocké est renormalisé sur l'ordre du tableau reçu : le
      // manifeste fait foi (arbitrage 7), pas les valeurs envoyées.
      project.chapters = data.chapters.map((c, index) => ({
        ...c,
        order: index,
        kind: c.kind ?? 'chapter',
      }));
      project.updatedAt = new Date().toISOString();

      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(projectFile, JSON.stringify(projectForSave, null, 2));

      if (this.currentProject && this.currentProjectPath === projectDir) {
        this.currentProject.chapters = project.chapters;
      }

      console.log('✅ Chapters saved:', project.chapters.length);
      return { success: true, chapters: project.chapters };
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
   * Un fichier illisible (disparu entre-temps) est retourné avec son
   * erreur plutôt que de faire échouer toute la lecture : l'appelant décide
   * s'il peut travailler sans lui.
   */
  async readChapters(data: { projectPath: string; filePaths: string[] }): Promise<{
    success: boolean;
    files: Array<{ filePath: string; content?: string; error?: string }>;
    error?: string;
  }> {
    try {
      const { projectDir } = this.resolveProjectPaths(data.projectPath);
      const files: Array<{ filePath: string; content?: string; error?: string }> = [];

      for (const relPath of data.filePaths) {
        if (!this.isInsideProject(projectDir, relPath)) {
          files.push({
            filePath: relPath,
            error: `Path "${relPath}" escapes the project directory`,
          });
          continue;
        }
        try {
          const content = await readFile(path.resolve(projectDir, relPath), 'utf-8');
          files.push({ filePath: relPath, content });
        } catch (error: unknown) {
          files.push({
            filePath: relPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

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
      if (!existsSync(projectFile)) {
        throw new Error(`Project file not found: ${projectFile}`);
      }

      const raw = await readFile(projectFile, 'utf-8');
      const project: Project = JSON.parse(raw);

      const settings = normalizeBookSettings({ ...project.book, ...data.settings });
      project.book = settings;
      project.updatedAt = new Date().toISOString();

      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(projectFile, JSON.stringify(projectForSave, null, 2));

      if (this.currentProject && this.currentProjectPath === projectDir) {
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
      if (!existsSync(projectFile)) {
        throw new Error(`Project file not found: ${projectFile}`);
      }

      const raw = await readFile(projectFile, 'utf-8');
      const project: Project = JSON.parse(raw);
      const chapters: Chapter[] = Array.isArray(project.chapters) ? project.chapters : [];

      const order = chapters.length;
      const chaptersDir = path.join(projectDir, CHAPTERS_DIR);
      await mkdir(chaptersDir, { recursive: true });

      // Nom libre s'il est déjà pris : le préfixe n'a pas valeur d'autorité,
      // mais deux fichiers ne peuvent pas partager un nom.
      let fileName = chapterFileName(order, data.title);
      let attempt = 2;
      while (existsSync(path.join(chaptersDir, fileName))) {
        fileName = chapterFileName(order, `${data.title}-${attempt}`);
        attempt += 1;
      }

      await writeFile(path.join(chaptersDir, fileName), `# ${data.title}\n\n`);

      const chapter: Chapter = {
        id: crypto.randomUUID(),
        title: data.title,
        filePath: `${CHAPTERS_DIR}/${fileName}`,
        order,
        kind: data.kind ?? 'chapter',
      };

      project.chapters = [...chapters, chapter];
      project.updatedAt = new Date().toISOString();
      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(projectFile, JSON.stringify(projectForSave, null, 2));

      if (this.currentProject && this.currentProjectPath === projectDir) {
        this.currentProject.chapters = project.chapters;
      }

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
      const projectContent = await readFile(data.projectPath, 'utf-8');
      const project: Project = JSON.parse(projectContent);
      const projectDir = dirname(data.projectPath);

      let relativeFilePath = data.filePath;

      // Convert absolute path to relative if it's a file path
      if (data.type === 'file' && data.filePath) {
        if (path.isAbsolute(data.filePath)) {
          relativeFilePath = path.relative(projectDir, data.filePath);
          console.log('📝 Converted bibliography path to relative:', relativeFilePath);
        }
      }

      project.bibliographySource = {
        type: data.type,
        filePath: relativeFilePath,
        zoteroCollection: data.zoteroCollection,
      };

      project.updatedAt = new Date().toISOString();

      // Issue #13: Exclude path field from saved file
      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(data.projectPath, JSON.stringify(projectForSave, null, 2));

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
      const project: Project = JSON.parse(content);
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
      if (!existsSync(projectPath)) {
        throw new Error(`Project file not found: ${projectPath}`);
      }

      const content = await readFile(projectPath, 'utf-8');
      const project: Project = JSON.parse(content);

      // Merge updates into project
      const updatedProject = {
        ...project,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      // Issue #13: Exclude path field from saved file (it's computed from file location)
      const { path: _excludedPath, ...projectForSave } = updatedProject;
      await writeFile(projectPath, JSON.stringify(projectForSave, null, 2));
      console.log('✅ Project config updated:', projectPath);

      // Update current project if it's the same (keep path in memory)
      if (this.currentProjectPath && projectPath.startsWith(this.currentProjectPath)) {
        updatedProject.path = this.currentProjectPath;
        this.currentProject = updatedProject;
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
  }): Promise<{ success: boolean; cslPath?: string; error?: string }> {
    try {
      console.log('📝 setCSLPath called with:', data);

      // Validate projectPath
      if (!data.projectPath) {
        throw new Error('Project path is required');
      }

      if (!existsSync(data.projectPath)) {
        throw new Error(`Project file not found: ${data.projectPath}`);
      }

      const projectContent = await readFile(data.projectPath, 'utf-8');
      const project: Project = JSON.parse(projectContent);
      const projectDir = dirname(data.projectPath);

      let relativeCslPath: string | undefined = undefined;

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
            // Fall back to using absolute path
            relativeCslPath = data.cslPath;
          }
        } else {
          // File is already in project directory, store as relative path
          relativeCslPath = path.relative(projectDir, data.cslPath);
          console.log('✅ CSL file in project directory, stored as relative path:', relativeCslPath);
        }
      }

      project.cslPath = relativeCslPath;
      project.updatedAt = new Date().toISOString();

      // Issue #13: Exclude path field from saved file
      const { path: _excludedPath, ...projectForSave } = project;
      await writeFile(data.projectPath, JSON.stringify(projectForSave, null, 2));

      console.log('✅ CSL path configured:', relativeCslPath);
      // Return the absolute path for the UI
      const absolutePath = relativeCslPath ? join(projectDir, relativeCslPath) : undefined;
      return { success: true, cslPath: absolutePath };
    } catch (error: unknown) {
      console.error('❌ Failed to set CSL path:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message || 'Unknown error' };
    }
  }
}

export const projectManager = new ProjectManager();
