import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface RecipeInputDef {
  type: 'string' | 'number' | 'boolean' | 'path';
  required: boolean;
  description?: string;
  default?: unknown;
}

interface Recipe {
  name: string;
  version: string;
  description: string;
  inputs: Record<string, RecipeInputDef>;
  steps: Array<{ id: string; kind: string }>;
  outputs: Record<string, unknown>;
}

type RunEvent =
  | { kind: 'run_started'; at: string; recipe: string }
  | { kind: 'step_start'; at: string; stepId: string; stepKind: string }
  | { kind: 'step_ok'; at: string; stepId: string; stepKind: string; stub?: boolean }
  | {
      kind: 'step_failed';
      at: string;
      stepId: string;
      stepKind: string;
      error: { code: string; message: string };
    }
  | { kind: 'run_completed'; at: string; recipe: string }
  | {
      kind: 'run_failed';
      at: string;
      recipe: string;
      error: { code: string; message: string };
    };

interface RecipesApi {
  read(
    scope: 'builtin' | 'user',
    fileName: string
  ): Promise<{ success: boolean; recipe?: Recipe; error?: string }>;
  run(
    scope: 'builtin' | 'user',
    fileName: string,
    inputs: Record<string, unknown>
  ): Promise<{
    success: boolean;
    ok?: boolean;
    outputs?: Record<string, unknown>;
    logPath?: string;
    failedStep?: { stepId: string; message: string };
    error?: string;
  }>;
  onEvent(
    cb: (env: { runId: string; event: RunEvent }) => void
  ): () => void;
}

function api(): RecipesApi | null {
  return (
    (window as unknown as { electron?: { fusion?: { recipes?: RecipesApi } } })
      .electron?.fusion?.recipes ?? null
  );
}

interface Props {
  scope: 'builtin' | 'user';
  fileName: string;
  onClose: () => void;
}

export const RecipeRunModal: React.FC<Props> = ({ scope, fileName, onClose }) => {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [result, setResult] = useState<{
    ok: boolean;
    outputs?: Record<string, unknown>;
    logPath?: string;
    failedStep?: { stepId: string; message: string };
    error?: string;
  } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const r = api();
    if (!r) {
      setLoadError('Fusion API non exposée.');
      return;
    }
    void r.read(scope, fileName).then((res) => {
      if (res.success && res.recipe) {
        setRecipe(res.recipe);
        const initial: Record<string, unknown> = {};
        for (const [k, def] of Object.entries(res.recipe.inputs)) {
          if (def.default !== undefined) initial[k] = def.default;
          else if (def.type === 'boolean') initial[k] = false;
          else initial[k] = '';
        }
        setInputs(initial);
      } else {
        setLoadError(res.error ?? 'Chargement impossible.');
      }
    });
  }, [scope, fileName]);

  useEffect(() => {
    const r = api();
    if (!r) return;
    return r.onEvent((env) => {
      setEvents((prev) => [...prev, env.event]);
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const canRun = useMemo(() => {
    if (!recipe || running) return false;
    for (const [k, def] of Object.entries(recipe.inputs)) {
      if (def.required) {
        const v = inputs[k];
        if (v === undefined || v === null || v === '') return false;
      }
    }
    return true;
  }, [recipe, inputs, running]);

  const coerce = useCallback(
    (key: string, raw: string): unknown => {
      if (!recipe) return raw;
      const def = recipe.inputs[key];
      if (def?.type === 'number') {
        const n = Number(raw);
        return Number.isNaN(n) ? raw : n;
      }
      return raw;
    },
    [recipe]
  );

  const run = useCallback(async () => {
    const r = api();
    if (!r || !recipe) return;
    setRunning(true);
    setEvents([]);
    setResult(null);
    try {
      const res = await r.run(scope, fileName, inputs);
      if (res.success) {
        setResult({
          ok: res.ok ?? false,
          outputs: res.outputs,
          logPath: res.logPath,
          failedStep: res.failedStep,
        });
      } else {
        setResult({ ok: false, error: res.error ?? 'Échec inconnu.' });
      }
    } finally {
      setRunning(false);
    }
  }, [recipe, inputs, scope, fileName]);

  const renderField = (key: string, def: RecipeInputDef): React.ReactNode => {
    const value = inputs[key];
    if (def.type === 'boolean') {
      return (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => setInputs({ ...inputs, [key]: e.target.checked })}
          disabled={running}
        />
      );
    }
    if (def.type === 'number') {
      return (
        <input
          type="number"
          value={(value as number | string) ?? ''}
          onChange={(e) => setInputs({ ...inputs, [key]: coerce(key, e.target.value) })}
          className="config-input"
          disabled={running}
        />
      );
    }
    // string / path
    const multiLine = def.type === 'string' && key.toLowerCase().includes('plan');
    if (multiLine) {
      return (
        <textarea
          value={(value as string) ?? ''}
          onChange={(e) => setInputs({ ...inputs, [key]: e.target.value })}
          disabled={running}
          rows={6}
          style={{
            width: '100%',
            fontFamily: 'var(--mono-font, ui-monospace, monospace)',
            fontSize: 12,
            padding: 8,
            background: 'var(--bg-app)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 4,
          }}
        />
      );
    }
    return (
      <input
        type="text"
        value={(value as string) ?? ''}
        onChange={(e) => setInputs({ ...inputs, [key]: e.target.value })}
        className="config-input"
        disabled={running}
        placeholder={def.type === 'path' ? '/absolute/path/…' : ''}
      />
    );
  };

  return (
    <div
      className="settings-modal"
      onClick={onClose}
      style={{ zIndex: 1100 }}
    >
      <div
        className="settings-content"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720 }}
      >
        <div className="settings-header">
          <h3>
            <Play size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {recipe?.name ?? fileName}
            {recipe && (
              <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 8 }}>
                v{recipe.version}
              </span>
            )}
          </h3>
          <button className="close-btn" onClick={onClose} disabled={running}>
            <X size={20} />
          </button>
        </div>
        <div className="settings-body" style={{ padding: 16 }}>
          {loadError && (
            <p style={{ color: 'var(--color-danger)' }}>{loadError}</p>
          )}
          {recipe && (
            <>
              {recipe.description && (
                <p className="config-hint">{recipe.description}</p>
              )}

              {Object.entries(recipe.inputs).length > 0 && (
                <section className="config-section" style={{ marginBottom: 12 }}>
                  <h3 className="config-section-title">Paramètres</h3>
                  {Object.entries(recipe.inputs).map(([key, def]) => (
                    <div key={key} className="config-field">
                      <label className="config-label">
                        {key} {def.required && <span style={{ color: 'var(--color-danger)' }}>*</span>}
                        {def.description && (
                          <span className="config-help">{def.description}</span>
                        )}
                      </label>
                      {renderField(key, def)}
                    </div>
                  ))}
                </section>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => void run()}
                  disabled={!canRun}
                >
                  {running ? <Loader2 size={14} /> : <Play size={14} strokeWidth={1} />}{' '}
                  {running ? 'En cours…' : 'Lancer'}
                </button>
                <span style={{ opacity: 0.7, fontSize: 12 }}>
                  {recipe.steps.length} étapes
                </span>
              </div>

              {(events.length > 0 || result) && (
                <section className="config-section">
                  <h3 className="config-section-title">Journal</h3>
                  <div
                    style={{
                      padding: 8,
                      background: 'var(--bg-app)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 4,
                      maxHeight: 260,
                      overflowY: 'auto',
                      fontFamily: 'var(--mono-font, ui-monospace, monospace)',
                      fontSize: 11.5,
                    }}
                  >
                    {events.map((e, i) => (
                      <div key={i} style={{ padding: '2px 0' }}>
                        {renderEvent(e)}
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>

                  {result && (
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      {result.ok ? (
                        <span style={{ color: 'var(--color-accent)' }}>
                          <CheckCircle2 size={14} style={{ verticalAlign: 'middle' }} />{' '}
                          Terminé. Journal : <code>{result.logPath}</code>
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-danger)' }}>
                          <XCircle size={14} style={{ verticalAlign: 'middle' }} />{' '}
                          Échec : {result.failedStep
                            ? `${result.failedStep.stepId} — ${result.failedStep.message}`
                            : result.error}
                        </span>
                      )}
                    </div>
                  )}

                  {result?.ok && result.outputs && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                        Sorties ({Object.keys(result.outputs).length})
                      </summary>
                      <pre
                        style={{
                          margin: '6px 0 0',
                          padding: 8,
                          background: 'var(--bg-app)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 4,
                          fontSize: 11.5,
                          maxHeight: 220,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {JSON.stringify(result.outputs, null, 2)}
                      </pre>
                    </details>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

function renderEvent(e: RunEvent): React.ReactNode {
  switch (e.kind) {
    case 'run_started':
      return <span>▶ Run started — {e.recipe}</span>;
    case 'step_start':
      return (
        <span style={{ opacity: 0.8 }}>
          … step <strong>{e.stepId}</strong> ({e.stepKind})
        </span>
      );
    case 'step_ok':
      return (
        <span style={{ color: 'var(--color-accent)' }}>
          ✓ step <strong>{e.stepId}</strong>
          {e.stub ? ' (stub)' : ''}
        </span>
      );
    case 'step_failed':
      return (
        <span style={{ color: 'var(--color-danger)' }}>
          ✗ step <strong>{e.stepId}</strong> — {e.error.message}
        </span>
      );
    case 'run_completed':
      return <span style={{ color: 'var(--color-accent)' }}>✓ Run completed</span>;
    case 'run_failed':
      return (
        <span style={{ color: 'var(--color-danger)' }}>
          ✗ Run failed — {e.error.message}
        </span>
      );
  }
}
