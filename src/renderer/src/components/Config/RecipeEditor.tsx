/**
 * RecipeEditor (A14) — dual-mode recipe editing.
 *
 * Two views:
 *   1. Form mode: structured fields for name, version, description, inputs, steps
 *   2. YAML mode: CodeMirror editor for power users who prefer raw YAML
 *
 * Changes validate on save. Only user-scope recipes can be saved;
 * builtin recipes open in read-only mode.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Save,
  Plus,
  Trash2,
  Code2,
  FormInput,
  GripVertical,
  AlertCircle,
} from 'lucide-react';
import { YamlEditor } from '../common/YamlEditor';
import yaml from 'js-yaml';

interface RecipeInputDef {
  type: 'string' | 'number' | 'boolean' | 'path';
  required: boolean;
  description?: string;
  default?: unknown;
}

interface RecipeStep {
  id: string;
  kind: string;
  with?: Record<string, unknown>;
}

interface Recipe {
  name: string;
  version: string;
  description: string;
  inputs: Record<string, RecipeInputDef>;
  steps: RecipeStep[];
  outputs: Record<string, unknown>;
}

interface RecipesApi {
  readYaml(
    scope: 'builtin' | 'user',
    fileName: string
  ): Promise<{ success: boolean; yaml?: string; error?: string }>;
  save(
    fileName: string,
    yaml: string
  ): Promise<{ success: boolean; error?: string }>;
}

function api(): RecipesApi | null {
  return (window.electron?.fusion?.recipes as RecipesApi | undefined) ?? null;
}

const STEP_KINDS = ['brainstorm', 'search', 'graph', 'write', 'export'];
const INPUT_TYPES = ['string', 'number', 'boolean', 'path'];

interface Props {
  scope: 'builtin' | 'user';
  fileName: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const RecipeEditor: React.FC<Props> = ({ scope, fileName, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [rawYaml, setRawYaml] = useState<string>('');
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const readOnly = scope === 'builtin';

  useEffect(() => {
    const r = api();
    if (!r) {
      setLoadError('Fusion API unavailable');
      return;
    }
    void r.readYaml(scope, fileName).then((res) => {
      if (res.success && res.yaml) {
        setRawYaml(res.yaml);
        try {
          const parsed = yaml.load(res.yaml) as Recipe;
          setRecipe(normalizeRecipe(parsed));
        } catch {
          // YAML valid but not a valid recipe — still show in YAML mode
          setMode('yaml');
        }
      } else {
        setLoadError(res.error ?? 'Failed to load recipe');
      }
    });
  }, [scope, fileName]);

  const normalizeRecipe = (raw: unknown): Recipe => {
    const r = raw as Partial<Recipe>;
    return {
      name: r.name ?? '',
      version: String(r.version ?? '1'),
      description: r.description ?? '',
      inputs: r.inputs ?? {},
      steps: r.steps ?? [],
      outputs: r.outputs ?? {},
    };
  };

  const recipeToYaml = useCallback((r: Recipe): string => {
    return yaml.dump(r, { lineWidth: 120, noRefs: true, quotingType: '"' });
  }, []);

  const syncFormToYaml = useCallback(
    (r: Recipe) => {
      setRawYaml(recipeToYaml(r));
      setDirty(true);
    },
    [recipeToYaml]
  );

  const handleYamlChange = useCallback((value: string | undefined) => {
    if (value === undefined) return;
    setRawYaml(value);
    setDirty(true);
    try {
      const parsed = yaml.load(value) as Recipe;
      setRecipe(normalizeRecipe(parsed));
      setSaveError(null);
    } catch {
      // Invalid YAML — keep editing, show error on save
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (readOnly) return;
    const r = api();
    if (!r) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await r.save(fileName, rawYaml);
      if (res.success) {
        setDirty(false);
        onSaved?.();
      } else {
        setSaveError(res.error ?? 'Save failed');
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [readOnly, fileName, rawYaml, onSaved]);

  // Form field handlers
  const updateField = <K extends keyof Recipe>(key: K, value: Recipe[K]) => {
    if (!recipe) return;
    const updated = { ...recipe, [key]: value };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const addStep = () => {
    if (!recipe) return;
    const id = `step_${recipe.steps.length + 1}`;
    const updated = { ...recipe, steps: [...recipe.steps, { id, kind: 'brainstorm' }] };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const updateStep = (index: number, patch: Partial<RecipeStep>) => {
    if (!recipe) return;
    const steps = recipe.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    const updated = { ...recipe, steps };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const removeStep = (index: number) => {
    if (!recipe) return;
    const steps = recipe.steps.filter((_, i) => i !== index);
    const updated = { ...recipe, steps };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const addInput = () => {
    if (!recipe) return;
    const key = `param_${Object.keys(recipe.inputs).length + 1}`;
    const inputs = { ...recipe.inputs, [key]: { type: 'string' as const, required: false } };
    const updated = { ...recipe, inputs };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const updateInput = (oldKey: string, newKey: string, def: RecipeInputDef) => {
    if (!recipe) return;
    const inputs = { ...recipe.inputs };
    if (oldKey !== newKey) delete inputs[oldKey];
    inputs[newKey] = def;
    const updated = { ...recipe, inputs };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  const removeInput = (key: string) => {
    if (!recipe) return;
    const inputs = { ...recipe.inputs };
    delete inputs[key];
    const updated = { ...recipe, inputs };
    setRecipe(updated);
    syncFormToYaml(updated);
  };

  return (
    <div className="settings-modal" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        className="settings-content"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 820, height: '80vh' }}
      >
        {/* Header */}
        <div className="settings-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {recipe?.name || fileName}
            {readOnly && (
              <span style={{ fontSize: 11, opacity: 0.6, fontWeight: 400 }}>
                ({t('recipeEditor.readOnly')})
              </span>
            )}
            {dirty && !readOnly && (
              <span style={{ fontSize: 11, color: 'var(--color-accent)', fontWeight: 400 }}>
                ({t('recipeEditor.unsaved')})
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Mode toggle */}
            <button
              type="button"
              className={`toolbar-btn ${mode === 'form' ? 'toolbar-btn--active' : ''}`}
              onClick={() => setMode('form')}
              title={t('recipeEditor.modeForm')}
            >
              <FormInput size={14} />
            </button>
            <button
              type="button"
              className={`toolbar-btn ${mode === 'yaml' ? 'toolbar-btn--active' : ''}`}
              onClick={() => setMode('yaml')}
              title={t('recipeEditor.modeYaml')}
            >
              <Code2 size={14} />
            </button>
            {!readOnly && (
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                title={t('recipeEditor.save')}
              >
                <Save size={14} /> {t('recipeEditor.save')}
              </button>
            )}
            <button className="close-btn" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="settings-body" style={{ padding: 0, height: 'calc(100% - 56px)', overflow: 'hidden' }}>
          {loadError && (
            <div style={{ padding: 16, color: 'var(--color-danger)' }}>{loadError}</div>
          )}
          {saveError && (
            <div
              style={{
                padding: '8px 16px',
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                color: 'var(--color-danger)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <AlertCircle size={14} /> {saveError}
            </div>
          )}

          {mode === 'yaml' && (
            <YamlEditor
              height="100%"
              value={rawYaml}
              onChange={handleYamlChange}
              readOnly={readOnly}
            />
          )}

          {mode === 'form' && recipe && (
            <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>
              {/* Metadata */}
              <section className="config-section" style={{ marginBottom: 16 }}>
                <h4 className="config-section-title">{t('recipeEditor.sections.metadata')}</h4>
                <div className="config-field">
                  <label className="config-label">{t('recipeEditor.fields.name')}</label>
                  <input
                    type="text"
                    className="config-input"
                    value={recipe.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    disabled={readOnly}
                  />
                </div>
                <div className="config-field">
                  <label className="config-label">{t('recipeEditor.fields.version')}</label>
                  <input
                    type="text"
                    className="config-input"
                    value={recipe.version}
                    onChange={(e) => updateField('version', e.target.value)}
                    disabled={readOnly}
                    style={{ width: 80 }}
                  />
                </div>
                <div className="config-field">
                  <label className="config-label">{t('recipeEditor.fields.description')}</label>
                  <textarea
                    className="config-input"
                    value={recipe.description}
                    onChange={(e) => updateField('description', e.target.value)}
                    disabled={readOnly}
                    rows={2}
                    style={{ width: '100%', resize: 'vertical' }}
                  />
                </div>
              </section>

              {/* Inputs */}
              <section className="config-section" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 className="config-section-title">{t('recipeEditor.sections.inputs')}</h4>
                  {!readOnly && (
                    <button type="button" className="toolbar-btn" onClick={addInput}>
                      <Plus size={12} /> {t('recipeEditor.addInput')}
                    </button>
                  )}
                </div>
                {Object.entries(recipe.inputs).map(([key, def]) => (
                  <InputField
                    key={key}
                    inputKey={key}
                    def={def}
                    readOnly={readOnly}
                    onChange={(newKey, newDef) => updateInput(key, newKey, newDef)}
                    onRemove={() => removeInput(key)}
                  />
                ))}
                {Object.keys(recipe.inputs).length === 0 && (
                  <p style={{ fontSize: 12, opacity: 0.6 }}>{t('recipeEditor.noInputs')}</p>
                )}
              </section>

              {/* Steps */}
              <section className="config-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 className="config-section-title">{t('recipeEditor.sections.steps')}</h4>
                  {!readOnly && (
                    <button type="button" className="toolbar-btn" onClick={addStep}>
                      <Plus size={12} /> {t('recipeEditor.addStep')}
                    </button>
                  )}
                </div>
                {recipe.steps.map((step, idx) => (
                  <StepField
                    key={idx}
                    index={idx}
                    step={step}
                    readOnly={readOnly}
                    onChange={(patch) => updateStep(idx, patch)}
                    onRemove={() => removeStep(idx)}
                  />
                ))}
                {recipe.steps.length === 0 && (
                  <p style={{ fontSize: 12, opacity: 0.6 }}>{t('recipeEditor.noSteps')}</p>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Sub-components

const InputField: React.FC<{
  inputKey: string;
  def: RecipeInputDef;
  readOnly: boolean;
  onChange: (newKey: string, newDef: RecipeInputDef) => void;
  onRemove: () => void;
}> = ({ inputKey, def, readOnly, onChange, onRemove }) => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 100px auto auto auto',
        gap: 8,
        alignItems: 'center',
        padding: '6px 0',
        borderBottom: '1px solid var(--border-color)',
      }}
    >
      <input
        type="text"
        className="config-input"
        value={inputKey}
        onChange={(e) => onChange(e.target.value, def)}
        disabled={readOnly}
        placeholder="key"
        style={{ fontSize: 12 }}
      />
      <select
        className="config-input"
        value={def.type}
        onChange={(e) => onChange(inputKey, { ...def, type: e.target.value as RecipeInputDef['type'] })}
        disabled={readOnly}
        style={{ fontSize: 12 }}
      >
        {INPUT_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="checkbox"
          checked={def.required}
          onChange={(e) => onChange(inputKey, { ...def, required: e.target.checked })}
          disabled={readOnly}
        />
        req
      </label>
      <input
        type="text"
        className="config-input"
        value={def.description ?? ''}
        onChange={(e) => onChange(inputKey, { ...def, description: e.target.value || undefined })}
        disabled={readOnly}
        placeholder="description"
        style={{ fontSize: 11, width: 140 }}
      />
      {!readOnly && (
        <button type="button" onClick={onRemove} style={{ background: 'none', border: 0, color: 'var(--color-danger)', cursor: 'pointer' }}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
};

const StepField: React.FC<{
  index: number;
  step: RecipeStep;
  readOnly: boolean;
  onChange: (patch: Partial<RecipeStep>) => void;
  onRemove: () => void;
}> = ({ index, step, readOnly, onChange, onRemove }) => {
  const [showWith, setShowWith] = useState(false);

  return (
    <div
      style={{
        padding: '8px 0',
        borderBottom: '1px solid var(--border-color)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <GripVertical size={14} style={{ opacity: 0.4 }} />
        <span style={{ fontSize: 11, opacity: 0.6, minWidth: 20 }}>#{index + 1}</span>
        <input
          type="text"
          className="config-input"
          value={step.id}
          onChange={(e) => onChange({ id: e.target.value })}
          disabled={readOnly}
          placeholder="step_id"
          style={{ fontSize: 12, flex: 1 }}
        />
        <select
          className="config-input"
          value={step.kind}
          onChange={(e) => onChange({ kind: e.target.value })}
          disabled={readOnly}
          style={{ fontSize: 12, width: 120 }}
        >
          {STEP_KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowWith((v) => !v)}
          className="toolbar-btn"
          style={{ fontSize: 11, padding: '2px 6px' }}
        >
          with
        </button>
        {!readOnly && (
          <button type="button" onClick={onRemove} style={{ background: 'none', border: 0, color: 'var(--color-danger)', cursor: 'pointer' }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {showWith && (
        <div style={{ marginTop: 6, marginLeft: 36 }}>
          <textarea
            className="config-input"
            value={step.with ? yaml.dump(step.with, { lineWidth: 80 }) : ''}
            onChange={(e) => {
              try {
                const parsed = yaml.load(e.target.value) as Record<string, unknown>;
                onChange({ with: parsed });
              } catch {
                // Let user keep editing invalid YAML
              }
            }}
            disabled={readOnly}
            rows={4}
            style={{
              width: '100%',
              fontFamily: 'var(--mono-font, ui-monospace, monospace)',
              fontSize: 11,
              resize: 'vertical',
            }}
            placeholder="key: value"
          />
        </div>
      )}
    </div>
  );
};
