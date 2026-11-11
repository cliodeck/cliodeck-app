import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Save } from 'lucide-react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { useProjectStore } from '../../stores/projectStore';
import {
  contextFailureText,
  readContextFile,
  saveContextFile,
  unreadableFailure,
} from '../../services/context-file';

function cancelOkTimer(timer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

export const WorkspaceHintsSection: React.FC = () => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  /**
   * Le fichier tel qu'il a été lu, à l'octet près : l'écriture se compare à lui, pas à la zone,
   * qui rend ses fins de ligne en LF dès la première frappe. Et pour quel projet.
   */
  const [loadedRaw, setLoadedRaw] = useState('');
  const [projectPath, setProjectPath] = useState('');
  /** Illisible, ou lié hors du projet : rien à éditer ici, et rien à y écrire. */
  const [blocked, setBlocked] = useState(false);
  const [sourcePath, setSourcePath] = useState<string>('context.md');
  // `.cliodeck/hints.md` d'un projet antérieur : toujours lu et injecté, mais
  // il ne s'édite plus ici — on le signale pour que son contenu ne devienne
  // pas un contexte fantôme que l'auteur ne retrouve nulle part.
  const [legacyHints, setLegacyHints] = useState<{ path: string; content: string } | null>(null);
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [loaded, setLoaded] = useState(false);

  // Une seule lecture par ouverture : relire au changement de langue, juste au-dessus dans ce
  // même panneau, remplacerait ce qui est tapé dans la zone.
  const tRef = useRef(t);
  tRef.current = t;

  // « Enregistré » revient à l'état normal 1,5 s plus tard ; le retour est annulé si la section
  // disparaît avant (Réglages fermés). Parti après, il touchait à une section démontée, et sous
  // Vitest à un jsdom déjà défait : la CI rougissait sans test en échec.
  const okTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => cancelOkTimer(okTimer), []);

  useEffect(() => {
    const tr = tRef.current;
    if (!window.electron?.fusion?.hints) {
      setStatus({ kind: 'error', message: tr('hints.errors.noFusionApi') });
      return;
    }
    setProjectPath(useProjectStore.getState().currentProject?.path ?? '');
    void readContextFile().then((res) => {
      if (res.success) {
        setValue(res.hints.raw);
        setLoadedRaw(res.hints.raw);
        setSourcePath(res.hints.sourcePath);
        const legacy = res.hints.sources.legacyHints;
        setLegacyHints(
          legacy.present ? { path: legacy.sourcePath, content: legacy.content } : null
        );
        const refused = unreadableFailure(res.hints);
        setBlocked(refused !== null);
        if (refused) setStatus({ kind: 'error', message: contextFailureText(tr, refused) });
      } else {
        setStatus({ kind: 'error', message: contextFailureText(tr, res) });
      }
      setLoaded(true);
    });
  }, []);

  const save = useCallback(async () => {
    setStatus({ kind: 'saving' });
    const res = await saveContextFile(value, { expectedRaw: loadedRaw, sourcePath, projectPath });
    if (res.success) {
      // Le texte attendu avance avec le fichier : un second Enregistrer n'est pas un conflit.
      setLoadedRaw(res.hints.raw);
      setStatus({ kind: 'ok' });
      cancelOkTimer(okTimer);
      okTimer.current = setTimeout(() => {
        okTimer.current = null;
        setStatus((now) => (now.kind === 'ok' ? { kind: 'idle' } : now));
      }, 1500);
    } else {
      // Ce que devient le texte de la zone : il n'est perdu que si on l'y laisse en partant.
      const kept =
        res.error === 'context_conflict'
          ? t('hints.errors.conflict')
          : res.error === 'context_project_changed'
            ? t('hints.errors.projectChanged')
            : '';
      setStatus({ kind: 'error', message: `${contextFailureText(t, res)} ${kept}`.trim() });
    }
  }, [value, loadedRaw, sourcePath, projectPath, t]);

  return (
    <CollapsibleSection title={t('hints.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
      <p className="config-hint">{t('hints.hint')}</p>
      <p className="config-hint" style={{ fontSize: 11, opacity: 0.7 }}>
        {t('hints.filePath')} <code>{sourcePath}</code>
      </p>
      {legacyHints && (
        <p className="config-hint" style={{ fontSize: 11 }}>
          {t('hints.legacyNotice', { path: legacyHints.path })}
        </p>
      )}
      <textarea
        className="config-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!loaded || blocked || status.kind === 'saving'}
        rows={10}
        placeholder={t('hints.placeholder')}
        style={{
          width: '100%',
          fontFamily: 'var(--mono-font, ui-monospace, monospace)',
          fontSize: 12,
          padding: 8,
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={save}
          disabled={!loaded || blocked || status.kind === 'saving'}
          title={t('hints.buttons.saveTitle')}
        >
          <Save size={16} strokeWidth={1} /> {t('hints.buttons.save')}
        </button>
        {status.kind === 'ok' && (
          <span style={{ color: 'var(--color-accent)' }}><Check size={14} /> {t('hints.status.saved')}</span>
        )}
        {status.kind === 'saving' && <span>…</span>}
        {status.kind === 'error' && (
          <span role="alert" style={{ color: 'var(--color-danger)' }}>{status.message}</span>
        )}
      </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
