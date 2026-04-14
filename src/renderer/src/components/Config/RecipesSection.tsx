import React, { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';

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
  return (
    (window as unknown as { electron?: { fusion?: { recipes?: RecipesApi } } })
      .electron?.fusion?.recipes ?? null
  );
}

export const RecipesSection: React.FC = () => {
  const [builtin, setBuiltin] = useState<RecipeSummary[]>([]);
  const [user, setUser] = useState<RecipeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async (): Promise<void> => {
    const r = api();
    if (!r) {
      setError('Fusion API non exposée par le preload.');
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
        setError(res.error ?? 'Chargement impossible.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

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
          Aucune recette.
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
              <p style={{ margin: '4px 0 0', fontSize: 11, opacity: 0.6 }}>
                <code>{r.fileName}</code> · {r.steps} étapes
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="config-section">
      <h3 className="config-section-title">
        <BookOpen size={16} /> Recettes (lecture seule)
      </h3>
      <p className="config-hint">
        Recettes YAML disponibles — <em>builtin</em> livrées avec l'app,{' '}
        <em>user</em> placées dans <code>.cliodeck/v2/recipes/</code> du projet.
        L'exécution depuis l'UI arrivera dans une vague suivante ; pour l'instant
        utilise <code>cliodeck recipe run &lt;nom&gt;</code> en CLI.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => void refresh()}
          disabled={loading}
          title="Recharger la liste"
        >
          <RefreshCw size={14} strokeWidth={1} /> Actualiser
        </button>
      </div>
      {error && (
        <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</p>
      )}
      {renderGroup('Builtin', builtin)}
      {renderGroup('User', user)}
    </section>
  );
};
