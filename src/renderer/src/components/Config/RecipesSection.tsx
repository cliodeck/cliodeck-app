import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Play, RefreshCw } from 'lucide-react';
import { RecipeRunModal } from './RecipeRunModal';

interface RecipeSummary {
  fileName: string;
  name: string;
  version: string;
  description: string;
  steps: number;
}

interface RecipesApi {
  list(): Promise<{
    success: boolean;
    builtin?: RecipeSummary[];
    user?: RecipeSummary[];
    error?: string;
  }>;
}

function api(): RecipesApi | null {
  return (window.electron?.fusion?.recipes as RecipesApi | undefined) ?? null;
}

export const RecipesSection: React.FC = () => {
  const { t } = useTranslation();
  const [builtin, setBuiltin] = useState<RecipeSummary[]>([]);
  const [user, setUser] = useState<RecipeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runTarget, setRunTarget] = useState<{
    scope: 'builtin' | 'user';
    fileName: string;
  } | null>(null);

  const refresh = async (): Promise<void> => {
    const r = api();
    if (!r) {
      setError(t('recipes.errors.noFusionApi'));
      return;
    }
    setLoading(true);
    try {
      const res = await r.list();
      if (res.success) {
        setBuiltin(res.builtin ?? []);
        setUser(res.user ?? []);
        setError(null);
      } else {
        setError(res.error ?? t('recipes.errors.loadFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const scopeOf = (items: RecipeSummary[]): 'builtin' | 'user' =>
    items === builtin ? 'builtin' : 'user';

  const renderGroup = (title: string, items: RecipeSummary[]): React.ReactNode => (
    <div style={{ marginBottom: 12 }}>
      <h4
        style={{
          margin: '8px 0 4px',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          opacity: 0.7,
        }}
      >
        {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="config-hint" style={{ margin: 0 }}>
          {t('recipes.groups.empty')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((r) => (
            <li
              key={r.fileName}
              style={{
                padding: 8,
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                marginBottom: 6,
                background: 'var(--bg-panel)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{r.name}</strong>
                <span style={{ fontSize: 11, opacity: 0.6 }}>v{r.version}</span>
              </div>
              {r.description && (
                <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.8 }}>{r.description}</p>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <p style={{ margin: 0, fontSize: 11, opacity: 0.6 }}>
                  <code>{r.fileName}</code> ·{' '}
                  {t('recipes.card.stepsCount', { count: r.steps })}
                </p>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setRunTarget({ scope: scopeOf(items), fileName: r.fileName })}
                  title={t('recipes.buttons.runTitle')}
                  style={{ padding: '2px 8px', fontSize: 12 }}
                >
                  <Play size={12} strokeWidth={1} /> {t('recipes.buttons.run')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <BookOpen size={16} /> {t('recipes.title')}
      </h3>
      <p className="config-hint">
        {t('recipes.hintIntro')} <em>{t('recipes.hintBuiltinLabel')}</em>{' '}
        {t('recipes.hintBuiltinSuffix')} <em>{t('recipes.hintUserLabel')}</em>{' '}
        {t('recipes.hintUserSuffix')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void refresh()}
          disabled={loading}
          title={t('recipes.buttons.refreshTitle')}
        >
          <RefreshCw size={14} strokeWidth={1} /> {t('recipes.buttons.refresh')}
        </button>
      </div>
      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
      )}
      {renderGroup(t('recipes.groups.builtin'), builtin)}
      {renderGroup(t('recipes.groups.user'), user)}
      {runTarget && (
        <RecipeRunModal
          scope={runTarget.scope}
          fileName={runTarget.fileName}
          onClose={() => setRunTarget(null)}
        />
      )}
    </section>
  );
};
