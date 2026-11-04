/**
 * BrainstormPanel (fusion phase 3.1b).
 *
 * Historian-facing layout:
 *   - Chat sits at the top, full space (above the fold).
 *   - Workspace hints, Obsidian vault status and recipes live below, in a
 *     collapsible "Project context" drawer (collapsed by default) so the
 *     technical scaffolding doesn't greet the user in place of the chat.
 *   - While the default chat mode is active, a dismissable band above the
 *     chat proposes the « Brainstorming » chat mode (palier 2 of
 *     docs/poids-du-manuscrit.md); the refusal is remembered in the app
 *     config, the switch is not (`useBrainstormModeNotice`).
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Database,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
  MessageCircle,
  Lightbulb,
  Network,
  LayoutGrid,
  AlertTriangle,
} from 'lucide-react';
import { AssistantChat } from '../Chat/AssistantChat';
import { IdeasPanel } from './IdeasPanel';
import { IdeasGraph } from './IdeasGraph';
import { IdeasCanvas } from './IdeasCanvas';
import { useProjectStore } from '../../stores/projectStore';
import { ideasFilePath, useIdeaStore } from '../../stores/ideaStore';
import { useBrainstormModeNotice } from '../../hooks/useBrainstormModeNotice';
import { contextFailureText, unreadableFailure, type ContextHints } from '../../services/context-file';
import './BrainstormPanel.css';

interface RecipeSummary {
  fileName: string;
  name: string;
  version: string;
  description: string;
  steps: number;
}

interface VaultStatus {
  indexed: boolean;
  dbPath: string;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'no_project';

type BrainstormTab = 'chat' | 'ideas' | 'canvas' | 'graph';

/**
 * Ce que l'auteur doit savoir du fichier de ses idées, sur tous les onglets : le chargement met
 * de côté dès l'arrivée sur le chat, l'onglet par défaut, où l'on peut passer toute une session.
 * Pas de bouton de fermeture : la mise de côté se dit tant que la fenêtre est ouverte et que le
 * fichier mis de côté est là. Seule une lecture impossible attend qu'on vienne aux idées : rien
 * n'est en jeu, et le disque reviendra peut-être tout seul.
 */
const IdeasFileNotices: React.FC<{ projectPath: string; showBlocked: boolean }> = ({ projectPath, showBlocked }) => {
  const { t } = useTranslation('common');
  const persistence = useIdeaStore((s) => s.persistence);
  const saveError = useIdeaStore((s) => s.saveError);
  const loadIdeas = useIdeaStore((s) => s.loadIdeas);
  const saveIdeas = useIdeaStore((s) => s.saveIdeas);

  return (
    <>
      {persistence.kind === 'quarantined' && (
        <div className="brainstorm-panel__ideas-notice" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <div className="brainstorm-panel__ideas-notice-body">
            <p>{t('ideas.unreadable.quarantined')}</p>
            <code className="brainstorm-panel__ideas-notice-path">{persistence.backupPath}</code>
          </div>
        </div>
      )}
      {persistence.kind === 'blocked' && showBlocked && (
        <div className="brainstorm-panel__ideas-notice" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <div className="brainstorm-panel__ideas-notice-body">
            <p>{t('ideas.unreadable.blocked')}</p>
            <code className="brainstorm-panel__ideas-notice-path">{ideasFilePath(projectPath)}</code>
            <code className="brainstorm-panel__ideas-notice-path">{persistence.reason}</code>
          </div>
          <button
            type="button"
            className="brainstorm-panel__ideas-notice-retry"
            onClick={() => void loadIdeas(projectPath)}
          >
            {t('ideas.unreadable.retry')}
          </button>
        </div>
      )}
      {saveError && (
        <div className="brainstorm-panel__ideas-notice" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <div className="brainstorm-panel__ideas-notice-body">
            <p>{t('ideas.saveFailed')}</p>
            <code className="brainstorm-panel__ideas-notice-path">{saveError}</code>
          </div>
          <button
            type="button"
            className="brainstorm-panel__ideas-notice-retry"
            onClick={() => void saveIdeas(projectPath)}
          >
            {t('ideas.unreadable.retry')}
          </button>
        </div>
      )}
    </>
  );
};

export const BrainstormPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const [activeTab, setActiveTab] = useState<BrainstormTab>('chat');
  const [hints, setHints] = useState<ContextHints | null>(null);
  const [builtin, setBuiltin] = useState<RecipeSummary[]>([]);
  const [user, setUser] = useState<RecipeSummary[]>([]);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const loadIdeas = useIdeaStore((s) => s.loadIdeas);
  const ideasLoadedFor = useIdeaStore((s) => s.loadedFor);
  const ideasLoading = useIdeaStore((s) => s.isLoading);
  const ideasBlocked = useIdeaStore((s) => s.persistence.kind === 'blocked');
  const projectSwitching = useProjectStore((s) => s.loadState.kind === 'loading');
  // Tant que la liste n'est pas celle de ce projet, on ne la montre pas : elle vient du projet
  // d'avant, ou elle est vide en attendant le disque (un fichier OneDrive met des secondes à
  // arriver), et ce qu'on y ferait disparaîtrait au chargement. Pendant une bascule non plus : le
  // sortant s'écrit à son début, et une frappe après lui n'aurait plus nulle part où aller.
  const ideasShown =
    currentProjectPath !== null && ideasLoadedFor === currentProjectPath && !ideasLoading && !projectSwitching;
  const modeNotice = useBrainstormModeNotice();
  // Sans projet, le panneau invite déjà à en ouvrir un : pas deux bandes, et
  // rien à chercher dans des sources qui n'existent pas encore.
  const showModeNotice = modeNotice.visible && status !== 'no_project';

  // Rien à voir avec les consignes ni les recettes ci-dessous : leur échec laissait à l'écran
  // la liste du projet d'avant.
  useEffect(() => {
    if (currentProjectPath) void loadIdeas(currentProjectPath);
  }, [currentProjectPath, loadIdeas]);

  useEffect(() => {
    let cancelled = false;

    if (!currentProjectPath) {
      setStatus('no_project');
      setHints(null);
      setBuiltin([]);
      setUser([]);
      setVault(null);
      setVaultError(null);
      setLoadError(null);
      return;
    }

    setStatus('loading');
    setLoadError(null);

    (async () => {
      try {
        const fusion = window.electron.fusion;
        if (!fusion) {
          if (!cancelled) {
            setLoadError(t('chat.brainstorm.fusionApiMissing'));
            setStatus('idle');
          }
          return;
        }
        const [h, r, v] = await Promise.all([
          fusion.hints.read(),
          fusion.recipes.list(),
          fusion.vault.status(),
        ]);
        if (cancelled) return;

        if (h.success && h.hints) {
          setHints(h.hints);
        } else if (h.error === 'no_project') {
          // Project was closed between reads — reflect it cleanly.
          setStatus('no_project');
          return;
        } else if (h.error) {
          setLoadError(`Hints: ${h.error}`);
        }

        if (r.success) {
          setBuiltin(r.builtin ?? []);
          setUser(r.user ?? []);
        }
        if (v.success) {
          setVault({ indexed: !!v.indexed, dbPath: v.dbPath ?? '' });
          setVaultError(null);
        } else {
          // Sans cela, le tiroir dirait « vérification… » sans fin.
          setVaultError(v.error && v.error !== 'no_project' ? v.error : t('chat.brainstorm.vaultUnavailable'));
        }
        setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setStatus('idle');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProjectPath]);

  const recipeCount = builtin.length + user.length;
  // Illisible ou lié hors du projet : pas « aucun fichier », qui inviterait à en créer un.
  const contextRefused = contextOpen && hints ? unreadableFailure(hints) : null;

  return (
    <div className="brainstorm-panel">
      {status === 'no_project' && (
        <div className="brainstorm-panel__notice" role="status">
          {t('chat.brainstorm.openProjectNotice')}
        </div>
      )}

      {loadError && status !== 'no_project' && (
        <div className="brainstorm-panel__error" role="alert">
          {loadError}
        </div>
      )}

      {/* Tab bar: Chat | Ideas */}
      <nav className="brainstorm-panel__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'chat'}
          className={`brainstorm-panel__tab ${activeTab === 'chat' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          <MessageCircle size={14} />
          <span>{t('ideas.tabChat')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'ideas'}
          className={`brainstorm-panel__tab ${activeTab === 'ideas' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('ideas')}
        >
          <Lightbulb size={14} />
          <span>{t('ideas.tabIdeas')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'canvas'}
          className={`brainstorm-panel__tab ${activeTab === 'canvas' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('canvas')}
        >
          <LayoutGrid size={14} />
          <span>{t('ideas.tabCanvas')}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'graph'}
          className={`brainstorm-panel__tab ${activeTab === 'graph' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('graph')}
        >
          <Network size={14} />
          <span>{t('ideas.tabGraph')}</span>
        </button>
      </nav>

      {currentProjectPath && ideasShown && (
        <IdeasFileNotices projectPath={currentProjectPath} showBlocked={activeTab !== 'chat'} />
      )}

      {/* Tab content */}
      {activeTab === 'chat' && (
        <>
          {showModeNotice && (
            <div className="brainstorm-panel__mode-notice" role="status">
              <Lightbulb size={14} aria-hidden="true" />
              <span className="brainstorm-panel__mode-notice-text">
                {t(
                  'ideas.modeNotice.message',
                  'Le mode de chat « Brainstorming » cherche des idées dans vos sources, avec 20 extraits et sans votre manuscrit par défaut.'
                )}
              </span>
              <div className="brainstorm-panel__mode-notice-actions">
                <button
                  type="button"
                  className="brainstorm-panel__mode-notice-primary"
                  onClick={modeNotice.activate}
                >
                  {t('ideas.modeNotice.activate', 'Activer le mode Brainstorming')}
                </button>
                <button
                  type="button"
                  className="brainstorm-panel__mode-notice-secondary"
                  onClick={modeNotice.dismiss}
                >
                  {t('ideas.modeNotice.dismiss', 'Ne plus proposer')}
                </button>
              </div>
            </div>
          )}
          <section className="brainstorm-panel__chat">
            <AssistantChat variant="full" />
          </section>
        </>
      )}
      {activeTab !== 'chat' && (
        <section className="brainstorm-panel__chat">
          {currentProjectPath && !ideasShown && (
            <p className="brainstorm-panel__muted brainstorm-panel__ideas-loading">{t('ideas.loading')}</p>
          )}
          {/* Bloqué : rien de ce qu'on y ferait ne serait enregistré. */}
          {ideasShown && !ideasBlocked && activeTab === 'ideas' && <IdeasPanel />}
          {ideasShown && !ideasBlocked && activeTab === 'canvas' && <IdeasCanvas />}
          {ideasShown && !ideasBlocked && activeTab === 'graph' && <IdeasGraph />}
        </section>
      )}

      {/* Collapsible drawer: hints / vault / recipes */}
      <section
        className={`brainstorm-panel__drawer ${
          contextOpen ? 'is-open' : 'is-closed'
        }`}
      >
        <button
          type="button"
          className="brainstorm-panel__drawer-toggle"
          onClick={() => setContextOpen((v) => !v)}
          aria-expanded={contextOpen}
          aria-controls="brainstorm-context-drawer"
        >
          {contextOpen ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          <SettingsIcon size={14} />
          <span className="brainstorm-panel__drawer-title">
            {t('chat.brainstorm.projectContext')}
          </span>
          {!contextOpen && recipeCount > 0 && (
            <span className="brainstorm-panel__drawer-count">
              {t('chat.brainstorm.recipesCount', { count: recipeCount })}
            </span>
          )}
        </button>

        {contextOpen && (
          <div
            id="brainstorm-context-drawer"
            className="brainstorm-panel__drawer-body"
          >
            <div className="brainstorm-panel__section">
              <h3>
                <FileText size={14} /> {t('chat.brainstorm.workspaceHints')}
              </h3>
              {contextRefused && (
                <p className="brainstorm-panel__hints-refused" role="alert">
                  <AlertTriangle size={14} aria-hidden="true" /> {contextFailureText(t, contextRefused)}
                </p>
              )}
              {hints?.present ? (
                <pre className="brainstorm-panel__hints">
                  {hints.normalized}
                </pre>
              ) : (
                !contextRefused && (
                  <p className="brainstorm-panel__muted">
                    {t('chat.brainstorm.noHints', {
                      path: hints?.sourcePath ?? '.cliodeck/hints.md',
                    })}
                  </p>
                )
              )}
            </div>

            <div className="brainstorm-panel__section">
              <h3>
                <Database size={14} /> {t('chat.brainstorm.obsidianVault')}
              </h3>
              {vaultError ? (
                <p className="brainstorm-panel__muted">{vaultError}</p>
              ) : vault ? (
                <p className="brainstorm-panel__muted">
                  {vault.indexed
                    ? t('chat.brainstorm.vaultReady', { path: vault.dbPath })
                    : t('chat.brainstorm.vaultNotIndexed')}
                </p>
              ) : (
                <p className="brainstorm-panel__muted">
                  {t('chat.brainstorm.vaultChecking')}
                </p>
              )}
            </div>

            <div className="brainstorm-panel__section">
              <h3>
                {t('chat.brainstorm.recipesHeading', { count: recipeCount })}
              </h3>
              <ul className="brainstorm-panel__recipes">
                {[...builtin, ...user].map((r) => (
                  <li key={r.fileName}>
                    <strong>{r.name}</strong>{' '}
                    <span className="brainstorm-panel__muted">
                      v{r.version}
                    </span>
                    <p className="brainstorm-panel__muted">
                      {r.description || '—'} · {r.steps}{' '}
                      {t('chat.brainstorm.stepsSuffix')}
                    </p>
                  </li>
                ))}
                {recipeCount === 0 && (
                  <li className="brainstorm-panel__muted">
                    {t('chat.brainstorm.noRecipes')}
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
