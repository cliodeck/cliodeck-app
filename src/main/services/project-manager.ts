// @ts-nocheck
import { writeFile, readFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { dirname, basename, join } from 'path';
import crypto from 'crypto';
import { configManager } from './config-manager.js';

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
  chapters?: Chapter[];
}

interface Chapter {
  id: string;
  title: string;
  order: number;
  filePath: string;
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
    } catch (error: any) {
      console.error('❌ Failed to get project metadata:', error);
      return { success: false, error: error.message };
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

    // Create project.json (without path field - it's computed from file location)
    const projectFile = path.join(projectPath, 'project.json');
    const { path: _excludedPath, ...projectForSave } = project;
    await writeFile(projectFile, JSON.stringify(projectForSave, null, 2));

    // Create markdown file
    const mdFile = path.join(projectPath, 'document.md');
    await writeFile(mdFile, data.content || '# ' + data.name);

    // For articles and books, create abstract.md and context.md
    if (projectType === 'article' || projectType === 'book') {
      const abstractFile = path.join(projectPath, 'abstract.md');
      await writeFile(abstractFile, '# Résumé\n\nRésumé à compléter...');

      const contextFile = path.join(projectPath, 'context.md');
      await writeFile(contextFile, '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. Ce contexte sera utilisé pour améliorer les réponses de l\'assistant IA.\n\nExemple : "Cette recherche porte sur l\'impact de l\'intelligence artificielle dans l\'éducation supérieure, avec un focus particulier sur la taxonomie de Bloom et les stratégies pédagogiques actives."');
    }

    // For presentations, create slides.md with Beamer syntax
    if (projectType === 'presentation') {
      const slidesFile = path.join(projectPath, 'slides.md');
      const slidesTemplate = `# Introduction

Votre contenu ici...

- Point important 1
- Point important 2
- Point important 3

# Plan de la présentation

1. Contexte
2. Méthodologie
3. Résultats
4. Conclusion

# Section 1: Contexte

## Sous-section

Texte de votre slide...

::: notes
Ceci est une note pour le présentateur.
Elle n'apparaîtra pas sur le slide, uniquement dans vos notes.
:::

# Section 2: Méthodologie

## Approche

- Méthode 1
- Méthode 2
- Méthode 3

# Résultats

## Tableau récapitulatif

| Élément | Valeur |
|---------|--------|
| A       | 10     |
| B       | 20     |

# Conclusion

Merci de votre attention !

::: notes
N'oubliez pas de mentionner les perspectives futures.
:::
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
    } catch (error) {
      console.error('❌ Failed to load project:', error);
      return { success: false, error: error.message };
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

      // Sauvegarder le markdown
      const mdFile = path.join(path.dirname(data.path), 'document.md');
      await writeFile(mdFile, data.content);

      console.log('✅ Project saved:', data.path);
      return { success: true };
    } catch (error) {
      console.error('❌ Failed to save project:', error);
      return { success: false, error: error.message };
    }
  }

  async getChapters(projectId: string) {
    try {
      // Pour l'instant, retourner un chapitre par défaut basé sur document.md
      // Dans une version future, on pourra gérer plusieurs chapitres
      const chapters: Chapter[] = [
        {
          id: 'main',
          title: 'Document principal',
          order: 0,
          filePath: 'document.md',
        },
      ];

      return { success: true, chapters };
    } catch (error) {
      console.error('❌ Failed to get chapters:', error);
      return { success: false, chapters: [], error: error.message };
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
    } catch (error) {
      console.error('❌ Failed to set bibliography source:', error);
      return { success: false, error: error.message };
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
    } catch (error) {
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
    } catch (error: any) {
      console.error('❌ Failed to update project config:', error);
      return { success: false, error: error.message };
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
          } catch (copyError: any) {
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
    } catch (error: any) {
      console.error('❌ Failed to set CSL path:', error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  }
}

export const projectManager = new ProjectManager();
