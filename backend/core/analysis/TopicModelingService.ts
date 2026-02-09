/**
 * TopicModelingService - Gestion du service Python BERTopic
 *
 * Ce service gère le cycle de vie du service Python pour le topic modeling :
 * - Démarrage/arrêt du subprocess Python
 * - Health checks
 * - Communication HTTP avec le service
 * - Parsing des réponses
 */

import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';

const access = promisify(fs.access);
const mkdir = promisify(fs.mkdir);

// MARK: - Types

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
  nrTopics?: number | 'auto'; // Nombre de topics souhaités (auto = automatique)
  language?: 'french' | 'english' | 'multilingual';
  nGramRange?: [number, number];
}

interface HealthResponse {
  status: string;
  service: string;
  version: string;
}

interface AnalyzeResponse {
  topics: Topic[];
  topic_assignments: Record<string, number>;
  outliers: string[];
  statistics: {
    total_documents: number;
    num_topics: number;
    num_outliers: number;
    num_documents_in_topics: number;
  };
}

// MARK: - TopicModelingService

export class TopicModelingService {
  private pythonProcess?: ChildProcess;
  private serviceURL: string = 'http://127.0.0.1:8001';
  private isStarting: boolean = false;
  private isRunning: boolean = false;
  private startupTimeout: number = 120000; // 120 secondes (chargement de torch/transformers peut être lent)
  private venvPath?: string;
  private currentVenvDir?: string; // Chemin du venv actuel pour la détection pip
  private autoStart: boolean = false; // Désactiver le démarrage automatique par défaut

  /**
   * Retourne le chemin vers le venv dans le dossier utilisateur
   * Production et dev: ~/.cliodeck/python-venv
   * Cela évite de polluer le dépôt git et centralise les données utilisateur
   */
  private getVenvDir(isProduction: boolean, pythonServicePath: string): string {
    // Toujours utiliser le dossier utilisateur (plus propre)
    return path.join(os.homedir(), '.cliodeck', 'python-venv');
  }

  /**
   * Retourne le chemin vers l'exécutable Python du venv
   */
  private getVenvPythonPath(venvDir: string): string {
    return path.join(venvDir, 'bin', 'python3');
  }

  /**
   * Vérifie si le venv existe et est valide
   */
  private async checkVenvExists(venvDir: string): Promise<boolean> {
    const venvPython = this.getVenvPythonPath(venvDir);
    try {
      await access(venvPython, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Crée et configure le venv avec les dépendances
   */
  private async setupVenv(venvDir: string, requirementsPath: string): Promise<void> {
    console.log('📦 Setting up Python virtual environment...');
    console.log(`   venv location: ${venvDir}`);
    console.log(`   requirements: ${requirementsPath}`);

    // Vérifier si le venv existe déjà et est valide
    const venvPython = path.join(venvDir, 'bin', 'python3');
    const venvActivate = path.join(venvDir, 'bin', 'activate');

    if (fs.existsSync(venvPython) && fs.existsSync(venvActivate)) {
      console.log('✅ Virtual environment already exists, checking packages...');

      // Vérifier que les packages critiques sont installés
      try {
        const checkPackages = spawn(venvPython, ['-c',
          'import bertopic, fastapi, uvicorn; print("OK")'
        ]);

        let output = '';
        checkPackages.stdout?.on('data', (data) => {
          output += data.toString();
        });

        const isValid = await new Promise<boolean>((resolve) => {
          checkPackages.on('exit', (code) => {
            resolve(code === 0 && output.includes('OK'));
          });
          checkPackages.on('error', () => resolve(false));
        });

        if (isValid) {
          console.log('✅ All critical packages are installed, skipping setup');
          console.log('💡 To force reinstallation, delete:', venvDir);
          return; // Venv est valide, pas besoin de réinstaller
        } else {
          console.log('⚠️  Some packages are missing, will reinstall...');
          fs.rmSync(venvDir, { recursive: true, force: true });
        }
      } catch (error) {
        console.warn('⚠️  Could not verify packages, will reinstall:', error);
        try {
          fs.rmSync(venvDir, { recursive: true, force: true });
        } catch (rmError) {
          console.warn('⚠️  Could not remove venv:', rmError);
        }
      }
    }

    // Créer le répertoire parent si nécessaire
    const parentDir = path.dirname(venvDir);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch (error) {
      // Ignore si le répertoire existe déjà
    }

    return new Promise((resolve, reject) => {
      // Créer le venv
      const createVenv = spawn('python3', ['-m', 'venv', venvDir]);

      createVenv.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error('Failed to create virtual environment'));
          return;
        }

        console.log('✅ Virtual environment created');
        console.log('📦 Installing Python dependencies...');
        console.log('⚠️  Note: This may take several minutes on first install');

        // Installer les dépendances avec le script personnalisé
        // qui saute numba et llvmlite (packages optionnels problématiques)
        const venvPython = path.join(venvDir, 'bin', 'python3');
        const pythonServiceDir = path.dirname(requirementsPath);
        const installScript = path.join(pythonServiceDir, 'install_deps.py');

        // Vérifier que le script existe, sinon utiliser pip directement
        let installArgs: string[];
        let installCmd: string;

        if (fs.existsSync(installScript)) {
          console.log('Using custom installation script (skips numba/llvmlite)');
          installCmd = venvPython;
          installArgs = [installScript];
        } else {
          console.log('Using standard pip install');
          const venvPip = path.join(venvDir, 'bin', 'pip3');
          installCmd = venvPip;
          installArgs = ['install', '--no-cache-dir', '-r', requirementsPath];
        }

        const installEnv = {
          ...process.env,
          NUMBA_DISABLE_JIT: '1',
        };

        console.log(`Running: ${installCmd} ${installArgs.join(' ')}`);

        const installDeps = spawn(installCmd, installArgs, {
          env: installEnv
        });

        installDeps.stdout?.on('data', (data) => {
          console.log(`[pip] ${data.toString().trim()}`);
        });

        installDeps.stderr?.on('data', (data) => {
          console.error(`[pip] ${data.toString().trim()}`);
        });

        installDeps.on('exit', (installCode) => {
          if (installCode !== 0) {
            reject(new Error('Failed to install Python dependencies'));
            return;
          }

          console.log('✅ Python dependencies installed successfully');
          resolve();
        });

        installDeps.on('error', (err) => {
          reject(new Error(`Failed to install dependencies: ${err.message}`));
        });
      });

      createVenv.on('error', (err) => {
        reject(new Error(`Failed to create venv: ${err.message}`));
      });
    });
  }

  /**
   * Tue les processus Python zombies qui occupent le port 8001
   */
  private async killZombieProcesses(): Promise<void> {
    try {
      console.log('🔍 Checking for zombie Python processes on port 8001...');

      // Trouver les processus qui utilisent le port 8001
      const { spawn } = await import('child_process');
      const lsof = spawn('lsof', ['-ti:8001']);

      let pids = '';
      lsof.stdout?.on('data', (data) => {
        pids += data.toString();
      });

      await new Promise<void>((resolve) => {
        lsof.on('exit', (code) => {
          if (code === 0 && pids.trim()) {
            // Des processus utilisent le port
            const pidList = pids.trim().split('\n').filter(p => p);
            console.log(`⚠️  Found ${pidList.length} zombie process(es) on port 8001: ${pidList.join(', ')}`);

            // Tuer chaque processus
            pidList.forEach(pid => {
              try {
                process.kill(parseInt(pid), 'SIGTERM');
                console.log(`✅ Killed process ${pid}`);
              } catch (err) {
                console.warn(`⚠️  Could not kill process ${pid}:`, err);
              }
            });

            // Attendre un peu pour que les processus se terminent
            setTimeout(() => resolve(), 500);
          } else {
            console.log('✅ No zombie processes found');
            resolve();
          }
        });

        lsof.on('error', () => {
          // lsof n'est peut-être pas disponible, continuer
          console.log('⚠️  lsof not available, skipping zombie check');
          resolve();
        });
      });
    } catch (error) {
      console.warn('⚠️  Could not check for zombie processes:', error);
      // Ne pas lancer d'erreur, continuer le démarrage
    }
  }

  /**
   * Démarre le service Python en subprocess
   *
   * @throws Error si Python n'est pas disponible ou si le service ne démarre pas
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Topic modeling service already running');
      return;
    }

    if (this.isStarting) {
      console.log('⚠️ Topic modeling service is already starting');
      return;
    }

    this.isStarting = true;

    try {
      console.log('🚀 Starting topic modeling service...');

      // Tuer les processus zombies au démarrage
      await this.killZombieProcesses();

      // Déterminer le chemin vers le script Python
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      // Détecter si on est en production (app.asar) ou en développement
      const isProduction = __filename.includes('app.asar');
      console.log(`📦 Environment: ${isProduction ? 'production' : 'development'}`);

      let pythonServicePath: string;

      if (isProduction) {
        // En production: fichiers Python dans extraResources
        pythonServicePath = path.join(
          process.resourcesPath,
          'python-services/topic-modeling'
        );
      } else {
        // En développement: fichiers dans le projet
        const projectRoot = path.join(__dirname, '../../../..');
        pythonServicePath = path.join(
          projectRoot,
          'backend/python-services/topic-modeling'
        );
      }

      console.log(`📂 Python service path: ${pythonServicePath}`);

      // Déterminer le chemin du venv
      const venvDir = this.getVenvDir(isProduction, pythonServicePath);
      const requirementsPath = path.join(pythonServicePath, 'requirements.txt');

      // Stocker pour utilisation dans waitForServiceReady
      this.currentVenvDir = venvDir;

      console.log(`📂 Venv path: ${venvDir}`);

      // Vérifier que Python est disponible
      await this.checkPythonAvailable();

      // Vérifier si le venv existe, sinon le créer
      const venvExists = await this.checkVenvExists(venvDir);
      if (!venvExists) {
        console.log('🔧 Virtual environment not found, creating it...');
        await this.setupVenv(venvDir, requirementsPath);
      }

      // Utiliser le Python du venv
      const pythonExecutable = this.getVenvPythonPath(venvDir);
      console.log(`🐍 Using Python from venv: ${pythonExecutable}`);

      // Démarrer le subprocess Python avec le venv
      // -u: mode unbuffered pour voir les logs immédiatement
      // PYTHONUNBUFFERED: même effet que -u, pour être sûr
      this.pythonProcess = spawn(pythonExecutable, ['-u', 'main.py'], {
        cwd: pythonServicePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NUMBA_DISABLE_JIT: '1',
          PYTHONUNBUFFERED: '1',
        },
      });

      // Logger la sortie standard
      this.pythonProcess.stdout?.on('data', (data) => {
        console.log(`[Python] ${data.toString().trim()}`);
      });

      // Logger les erreurs
      this.pythonProcess.stderr?.on('data', (data) => {
        console.error(`[Python Error] ${data.toString().trim()}`);
      });

      // Gérer la fermeture du processus
      this.pythonProcess.on('exit', (code) => {
        console.log(`🛑 Python service exited with code ${code}`);
        this.isRunning = false;
        this.pythonProcess = undefined;
      });

      // Attendre que le service soit prêt (health check)
      await this.waitForServiceReady();

      this.isRunning = true;
      this.isStarting = false;

      console.log('✅ Topic modeling service started successfully');
    } catch (error) {
      this.isStarting = false;
      this.isRunning = false;

      // Nettoyer le processus si erreur
      if (this.pythonProcess) {
        this.pythonProcess.kill();
        this.pythonProcess = undefined;
      }

      console.error('❌ Failed to start topic modeling service:', error);
      throw error;
    }
  }

  /**
   * Arrête le service Python
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.pythonProcess) {
      console.log('⚠️ Topic modeling service not running');
      return;
    }

    console.log('🛑 Stopping topic modeling service...');

    return new Promise((resolve) => {
      if (this.pythonProcess) {
        this.pythonProcess.on('exit', () => {
          this.isRunning = false;
          this.pythonProcess = undefined;
          console.log('✅ Topic modeling service stopped');
          resolve();
        });

        // Tenter SIGTERM d'abord
        this.pythonProcess.kill('SIGTERM');

        // Si toujours actif après 5s, forcer SIGKILL
        setTimeout(() => {
          if (this.pythonProcess && !this.pythonProcess.killed) {
            console.log('⚠️ Forcing kill of Python service...');
            this.pythonProcess.kill('SIGKILL');
          }
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  /**
   * Vérifie si Python est disponible sur le système
   *
   * @throws Error si Python n'est pas disponible
   */
  private async checkPythonAvailable(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pythonCheck = spawn('python3', ['--version']);

      pythonCheck.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              'Python is not available. Please install Python 3.11+ and required dependencies.'
            )
          );
        }
      });

      pythonCheck.on('error', () => {
        reject(
          new Error(
            'Python is not available. Please install Python 3.11+ and required dependencies.'
          )
        );
      });
    });
  }

  /**
   * Vérifie si pip est en train d'installer des dépendances
   */
  private async isPipInstalling(venvDir: string): Promise<boolean> {
    return new Promise((resolve) => {
      const venvPip = path.join(venvDir, 'bin', 'pip');

      // Vérifier si le processus pip est en cours d'exécution
      const checkPip = spawn('pgrep', ['-f', `${venvPip}.*install`]);

      let found = false;
      checkPip.stdout?.on('data', () => {
        found = true;
      });

      checkPip.on('exit', () => {
        resolve(found);
      });

      checkPip.on('error', () => {
        resolve(false);
      });

      // Timeout après 2 secondes
      setTimeout(() => {
        checkPip.kill();
        resolve(false);
      }, 2000);
    });
  }

  /**
   * Attend que le service soit prêt en effectuant des health checks
   *
   * @throws Error si le service ne répond pas dans le délai imparti
   */
  private async waitForServiceReady(): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000; // Vérifier toutes les 1 seconde
    let effectiveTimeout = this.startupTimeout;
    let installationDetected = false;

    while (Date.now() - startTime < effectiveTimeout) {
      try {
        const isHealthy = await this.isHealthy();
        if (isHealthy) {
          console.log(`✅ Topic modeling service is healthy (took ${Math.floor((Date.now() - startTime) / 1000)}s)`);
          return;
        }
      } catch (error) {
        // Service pas encore prêt, continuer à attendre
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed % 10 === 0) {
          console.log(`⏳ Waiting for service... (${elapsed}s elapsed, pythonProcess=${!!this.pythonProcess}, isStarting=${this.isStarting})`);
        }
      }

      // Vérifier si pip est en train d'installer (seulement au début et si venvDir est défini)
      if (!installationDetected && Date.now() - startTime < 5000 && this.currentVenvDir) {
        const pipIsInstalling = await this.isPipInstalling(this.currentVenvDir);
        if (pipIsInstalling) {
          installationDetected = true;
          effectiveTimeout = 300000; // 5 minutes si installation détectée
          console.log('📦 Detected pip installation in progress...');
          console.log(`⏳ Extending timeout to ${effectiveTimeout / 1000}s for dependency installation`);
        }
      }

      // Afficher un message de progression toutes les 10 secondes si installation en cours
      const elapsed = Date.now() - startTime;
      if (installationDetected && elapsed % 10000 < checkInterval) {
        console.log(`⏳ Still waiting for Python dependencies to install... (${Math.floor(elapsed / 1000)}s elapsed)`);
      }

      // Attendre avant le prochain check
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error(
      `Topic modeling service did not start within ${effectiveTimeout / 1000}s`
    );
  }

  /**
   * Vérifie si le service est en bonne santé
   *
   * @returns true si le service répond correctement
   */
  async isHealthy(): Promise<boolean> {
    if (!this.isRunning && !this.isStarting) {
      return false;
    }

    try {
      const response = await fetch(`${this.serviceURL}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as HealthResponse;
      return data.status === 'healthy';
    } catch (error) {
      return false;
    }
  }

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
  async analyzeTopics(
    embeddings: Float32Array[],
    documents: string[],
    documentIds: string[],
    options: TopicAnalysisOptions = {}
  ): Promise<TopicAnalysisResult> {
    if (!this.isRunning) {
      throw new Error('Topic modeling service is not running. Call start() first.');
    }

    // Valider les paramètres
    if (embeddings.length !== documents.length || embeddings.length !== documentIds.length) {
      throw new Error('embeddings, documents, and documentIds must have the same length');
    }

    if (embeddings.length < (options.minTopicSize || 5)) {
      throw new Error(
        `Not enough documents (${embeddings.length}). Minimum: ${options.minTopicSize || 5}`
      );
    }

    console.log(`📊 Analyzing topics for ${embeddings.length} documents...`);

    try {
      // Convertir Float32Array en arrays normaux pour JSON
      const embeddingsArrays = embeddings.map((emb) => Array.from(emb));

      // Construire la requête
      const requestBody = {
        embeddings: embeddingsArrays,
        documents: documents,
        document_ids: documentIds,
        min_topic_size: options.minTopicSize || 5,
        nr_topics: options.nrTopics === 'auto' ? null : options.nrTopics || null,
        language: options.language || 'multilingual',
        n_gram_range: options.nGramRange || [1, 3],
      };

      // Envoyer la requête
      const response = await fetch(`${this.serviceURL}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        let errorText = await response.text();
        let errorMessage = errorText;
        try {
          // Essayer de parser le JSON pour obtenir plus de détails
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail) {
            // Si detail est une string, l'utiliser directement
            if (typeof errorJson.detail === 'string') {
              errorMessage = errorJson.detail;
            } else {
              // Si c'est un objet/array, le formater
              errorMessage = JSON.stringify(errorJson.detail, null, 2);
            }
          } else if (Array.isArray(errorJson)) {
            // FastAPI peut retourner un array d'erreurs de validation
            errorMessage = errorJson.map(err => err.msg || JSON.stringify(err)).join(', ');
          }
        } catch (e) {
          // Si ce n'est pas du JSON, utiliser le texte brut
        }
        console.error(`❌ Topic analysis HTTP error:`, {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText
        });
        throw new Error(`Topic analysis failed (${response.status}): ${errorMessage}`);
      }

      // Parser la réponse
      const data = (await response.json()) as AnalyzeResponse;

      const result: TopicAnalysisResult = {
        topics: data.topics,
        topicAssignments: data.topic_assignments,
        outliers: data.outliers,
        statistics: {
          totalDocuments: data.statistics.total_documents,
          numTopics: data.statistics.num_topics,
          numOutliers: data.statistics.num_outliers,
          numDocumentsInTopics: data.statistics.num_documents_in_topics,
        },
      };

      console.log(
        `✅ Topic analysis complete: ${result.statistics.numTopics} topics found ` +
        `(${result.statistics.numDocumentsInTopics}/${result.statistics.totalDocuments} documents, ` +
        `${result.statistics.numOutliers} outliers)`
      );

      return result;
    } catch (error) {
      console.error('❌ Topic analysis failed:', error);
      throw error;
    }
  }

  /**
   * Retourne l'état du service
   */
  getStatus(): {
    isRunning: boolean;
    isStarting: boolean;
    serviceURL: string;
  } {
    return {
      isRunning: this.isRunning,
      isStarting: this.isStarting,
      serviceURL: this.serviceURL,
    };
  }

  /**
   * Vérifie si les packages critiques sont installés dans le venv
   * Note: On utilise une vérification rapide avec pip show au lieu d'importer les modules
   * car bertopic peut prendre 30+ secondes à importer la première fois
   */
  private async checkCriticalPackages(venvPython: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let timeoutId: NodeJS.Timeout;

      const doResolve = (value: boolean) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve(value);
        }
      };

      // Utiliser python -m pip show pour vérifier les packages sans les importer
      // On utilise python -m pip au lieu de pip directement pour éviter les problèmes de shebang
      const checkPackages = spawn(venvPython, ['-m', 'pip', 'show', 'bertopic', 'fastapi', 'uvicorn']);

      let output = '';

      checkPackages.stdout?.on('data', (data) => {
        output += data.toString();
      });

      checkPackages.stderr?.on('data', () => {
        // Ignore stderr - pip peut émettre des warnings
      });

      checkPackages.on('exit', (code) => {
        // pip show retourne 0 si tous les packages sont trouvés
        // et affiche "Name: bertopic", "Name: fastapi", "Name: uvicorn"
        const hasBertopic = output.includes('Name: bertopic');
        const hasFastapi = output.includes('Name: fastapi');
        const hasUvicorn = output.includes('Name: uvicorn');

        const isValid = code === 0 && hasBertopic && hasFastapi && hasUvicorn;
        console.log(`📦 Package check: bertopic=${hasBertopic}, fastapi=${hasFastapi}, uvicorn=${hasUvicorn}`);
        doResolve(isValid);
      });

      checkPackages.on('error', (err) => {
        console.error('❌ Failed to check packages:', err);
        doResolve(false);
      });

      // Timeout après 30 secondes (pip show est rapide, mais au cas où)
      timeoutId = setTimeout(() => {
        if (!resolved) {
          checkPackages.kill();
          console.warn('⚠️ Package check timed out');
          doResolve(false);
        }
      }, 30000);
    });
  }

  /**
   * Vérifie si l'environnement Python est installé et prêt
   */
  async checkEnvironmentStatus(): Promise<{
    installed: boolean;
    venvPath?: string;
    pythonVersion?: string;
    error?: string;
  }> {
    try {
      // Déterminer les chemins
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const isProduction = __filename.includes('app.asar');

      let pythonServicePath: string;
      if (isProduction) {
        pythonServicePath = path.join(process.resourcesPath, 'python-services/topic-modeling');
      } else {
        const projectRoot = path.join(__dirname, '../../../..');
        pythonServicePath = path.join(projectRoot, 'backend/python-services/topic-modeling');
      }

      const venvDir = this.getVenvDir(isProduction, pythonServicePath);
      const venvExists = await this.checkVenvExists(venvDir);

      if (!venvExists) {
        return {
          installed: false,
          venvPath: venvDir,
        };
      }

      // Vérifier la version de Python dans le venv
      const venvPython = this.getVenvPythonPath(venvDir);
      const pythonVersion = await new Promise<string>((resolve, reject) => {
        const checkVersion = spawn(venvPython, ['--version']);
        let output = '';

        checkVersion.stdout?.on('data', (data) => {
          output += data.toString();
        });

        checkVersion.stderr?.on('data', (data) => {
          output += data.toString();
        });

        checkVersion.on('exit', (code) => {
          if (code === 0) {
            resolve(output.trim());
          } else {
            reject(new Error('Failed to get Python version'));
          }
        });

        checkVersion.on('error', reject);
      });

      // Vérifier que les packages critiques sont installés
      const packagesOk = await this.checkCriticalPackages(venvPython);
      if (!packagesOk) {
        console.log('⚠️  Venv exists but critical packages are missing');
        return {
          installed: false,
          venvPath: venvDir,
          error: 'Virtual environment exists but required packages (bertopic, fastapi, uvicorn) are not installed',
        };
      }

      return {
        installed: true,
        venvPath: venvDir,
        pythonVersion,
      };
    } catch (error: any) {
      return {
        installed: false,
        error: error.message,
      };
    }
  }

  /**
   * Installe ou réinstalle l'environnement Python
   */
  async setupEnvironment(onProgress?: (message: string) => void): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const log = (msg: string) => {
        console.log(msg);
        if (onProgress) onProgress(msg);
      };

      log('🔧 Configuration de l\'environnement Python...');

      // Déterminer les chemins
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const isProduction = __filename.includes('app.asar');

      let pythonServicePath: string;
      if (isProduction) {
        pythonServicePath = path.join(process.resourcesPath, 'python-services/topic-modeling');
      } else {
        const projectRoot = path.join(__dirname, '../../../..');
        pythonServicePath = path.join(projectRoot, 'backend/python-services/topic-modeling');
      }

      const venvDir = this.getVenvDir(isProduction, pythonServicePath);
      const requirementsPath = path.join(pythonServicePath, 'requirements.txt');

      log(`📂 Venv location: ${venvDir}`);
      log(`📂 Requirements: ${requirementsPath}`);

      // Vérifier que Python est disponible
      log('🔍 Vérification de Python...');
      await this.checkPythonAvailable();
      log('✅ Python disponible');

      // Installer le venv
      log('📦 Installation du venv...');
      await this.setupVenv(venvDir, requirementsPath);
      log('✅ Environnement Python installé avec succès');

      return { success: true };
    } catch (error: any) {
      console.error('❌ Failed to setup environment:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }
}
