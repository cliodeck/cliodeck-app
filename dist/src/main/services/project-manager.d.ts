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
        filePath?: string;
        zoteroCollection?: string;
    };
    cslPath?: string;
    chapters?: Chapter[];
}
interface Chapter {
    id: string;
    title: string;
    order: number;
    filePath: string;
}
export declare class ProjectManager {
    private currentProject;
    private currentProjectPath;
    /**
     * Retourne le chemin du dossier du projet actuellement ouvert
     */
    getCurrentProjectPath(): string | null;
    /**
     * Retourne le projet actuellement ouvert
     */
    getCurrentProject(): Project | null;
    /**
     * Reads project metadata without setting it as the current project.
     * Used for displaying recent projects list without affecting the active project.
     */
    getProjectMetadata(projectPath: string): Promise<{
        success: boolean;
        project: Project;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
        project?: undefined;
    }>;
    createProject(data: {
        name: string;
        type?: string;
        path: string;
        content?: string;
    }): Promise<{
        success: boolean;
        path: string;
        project: Project;
    }>;
    loadProject(projectPath: string): Promise<{
        success: boolean;
        project: Project;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
        project?: undefined;
    }>;
    saveProject(data: {
        path: string;
        content: string;
        bibliography?: string;
    }): Promise<{
        success: boolean;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
    }>;
    getChapters(projectId: string): Promise<{
        success: boolean;
        chapters: Chapter[];
        error?: undefined;
    } | {
        success: boolean;
        chapters: any[];
        error: any;
    }>;
    setBibliographySource(data: {
        projectPath: string;
        type: 'file' | 'zotero';
        filePath?: string;
        zoteroCollection?: string;
    }): Promise<{
        success: boolean;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
    }>;
    /**
     * Get project configuration from project.json
     */
    getConfig(projectPath: string): Promise<Project | null>;
    /**
     * Update project configuration (partial update)
     */
    updateConfig(projectPath: string, updates: Partial<Project>): Promise<{
        success: boolean;
        error?: string;
    }>;
    setCSLPath(data: {
        projectPath: string;
        cslPath?: string;
    }): Promise<{
        success: boolean;
        cslPath?: string;
        error?: string;
    }>;
}
export declare const projectManager: ProjectManager;
export {};
