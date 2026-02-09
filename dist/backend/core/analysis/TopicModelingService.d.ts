/**
 * TopicModelingService - Gestion du service Python BERTopic
 *
 * Ce service gère le cycle de vie du service Python pour le topic modeling :
 * - Démarrage/arrêt du subprocess Python
 * - Health checks
 * - Communication HTTP avec le service
 * - Parsing des réponses
 */
export interface Topic {
    id: number;
    label: string;
    keywords: string[];
    documents: string[];
    size: number;
}
export interface TopicAnalysisResult {
    topics: Topic[];
    topicAssignments: Record<string, number>;
    outliers: string[];
    statistics: {
        totalDocuments: number;
        numTopics: number;
        numOutliers: number;
        numDocumentsInTopics: number;
    };
}
export interface TopicAnalysisOptions {
    minTopicSize?: number;
    nrTopics?: number | 'auto';
    language?: 'french' | 'english' | 'multilingual';
    nGramRange?: [number, number];
}
export declare class TopicModelingService {
    private pythonProcess?;
    private serviceURL;
    private isStarting;
    private isRunning;
    private startupTimeout;
    private venvPath?;
    private currentVenvDir?;
    private autoStart;
    /**
     * Retourne le chemin vers le venv dans le dossier utilisateur
     * Production et dev: ~/.cliodeck/python-venv
     * Cela évite de polluer le dépôt git et centralise les données utilisateur
     */
    private getVenvDir;
    /**
     * Retourne le chemin vers l'exécutable Python du venv
     */
    private getVenvPythonPath;
    /**
     * Vérifie si le venv existe et est valide
     */
    private checkVenvExists;
    /**
     * Crée et configure le venv avec les dépendances
     */
    private setupVenv;
    /**
     * Tue les processus Python zombies qui occupent le port 8001
     */
    private killZombieProcesses;
    /**
     * Démarre le service Python en subprocess
     *
     * @throws Error si Python n'est pas disponible ou si le service ne démarre pas
     */
    start(): Promise<void>;
    /**
     * Arrête le service Python
     */
    stop(): Promise<void>;
    /**
     * Vérifie si Python est disponible sur le système
     *
     * @throws Error si Python n'est pas disponible
     */
    private checkPythonAvailable;
    /**
     * Vérifie si pip est en train d'installer des dépendances
     */
    private isPipInstalling;
    /**
     * Attend que le service soit prêt en effectuant des health checks
     *
     * @throws Error si le service ne répond pas dans le délai imparti
     */
    private waitForServiceReady;
    /**
     * Vérifie si le service est en bonne santé
     *
     * @returns true si le service répond correctement
     */
    isHealthy(): Promise<boolean>;
    /**
     * Analyse les topics d'un corpus de documents
     *
     * @param embeddings - Embeddings des documents (N x 768)
     * @param documents - Textes des documents
     * @param documentIds - IDs des documents
     * @param options - Options d'analyse
     * @returns Résultat de l'analyse de topics
     *
     * @throws Error si le service n'est pas disponible ou si l'analyse échoue
     */
    analyzeTopics(embeddings: Float32Array[], documents: string[], documentIds: string[], options?: TopicAnalysisOptions): Promise<TopicAnalysisResult>;
    /**
     * Retourne l'état du service
     */
    getStatus(): {
        isRunning: boolean;
        isStarting: boolean;
        serviceURL: string;
    };
    /**
     * Vérifie si les packages critiques sont installés dans le venv
     * Note: On utilise une vérification rapide avec pip show au lieu d'importer les modules
     * car bertopic peut prendre 30+ secondes à importer la première fois
     */
    private checkCriticalPackages;
    /**
     * Vérifie si l'environnement Python est installé et prêt
     */
    checkEnvironmentStatus(): Promise<{
        installed: boolean;
        venvPath?: string;
        pythonVersion?: string;
        error?: string;
    }>;
    /**
     * Installe ou réinstalle l'environnement Python
     */
    setupEnvironment(onProgress?: (message: string) => void): Promise<{
        success: boolean;
        error?: string;
    }>;
}
