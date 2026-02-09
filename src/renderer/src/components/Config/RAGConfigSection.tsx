import React from 'react';
import { CollapsibleSection } from '../common/CollapsibleSection';
import type { RAGConfig } from './ConfigPanel';

interface RAGConfigSectionProps {
  config: RAGConfig;
  onChange: (config: RAGConfig) => void;
}

export const RAGConfigSection: React.FC<RAGConfigSectionProps> = ({ config, onChange }) => {

  const handleTopKChange = (value: number) => {
    onChange({ ...config, topK: value });
  };

  const handleThresholdChange = (value: number) => {
    onChange({ ...config, similarityThreshold: value });
  };

  const handleChunkingChange = (value: 'cpuOptimized' | 'standard' | 'large') => {
    onChange({ ...config, chunkingConfig: value });
  };

  const handleSummaryGenerationChange = (value: 'extractive' | 'abstractive' | 'disabled') => {
    onChange({ ...config, summaryGeneration: value });
  };

  const handleSummaryMaxLengthChange = (value: number) => {
    onChange({ ...config, summaryMaxLength: value });
  };

  const handleUseGraphContextChange = (value: boolean) => {
    onChange({ ...config, useGraphContext: value });
  };

  const handleGraphSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, graphSimilarityThreshold: value });
  };

  const handleAdditionalGraphDocsChange = (value: number) => {
    onChange({ ...config, additionalGraphDocs: value });
  };

  const handleIncludeSummariesChange = (value: boolean) => {
    onChange({ ...config, includeSummaries: value });
  };

  const handleEnableTopicModelingChange = (value: boolean) => {
    onChange({ ...config, enableTopicModeling: value });
  };

  const handleExplorationSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, explorationSimilarityThreshold: value });
  };

  // === Chunk Quality Optimization Handlers ===
  const handleCustomChunkingEnabledChange = (value: boolean) => {
    onChange({ ...config, customChunkingEnabled: value });
  };

  const handleCustomMaxChunkSizeChange = (value: number) => {
    onChange({ ...config, customMaxChunkSize: value });
  };

  const handleCustomMinChunkSizeChange = (value: number) => {
    onChange({ ...config, customMinChunkSize: value });
  };

  const handleCustomOverlapSizeChange = (value: number) => {
    onChange({ ...config, customOverlapSize: value });
  };

  const handleEnableQualityFilteringChange = (value: boolean) => {
    onChange({ ...config, enableQualityFiltering: value });
  };

  const handleMinChunkEntropyChange = (value: number) => {
    onChange({ ...config, minChunkEntropy: value });
  };

  const handleMinUniqueWordRatioChange = (value: number) => {
    onChange({ ...config, minUniqueWordRatio: value });
  };

  const handleEnablePreprocessingChange = (value: boolean) => {
    onChange({ ...config, enablePreprocessing: value });
  };

  const handleEnableOCRCleanupChange = (value: boolean) => {
    onChange({ ...config, enableOCRCleanup: value });
  };

  const handleEnableHeaderFooterRemovalChange = (value: boolean) => {
    onChange({ ...config, enableHeaderFooterRemoval: value });
  };

  const handleEnableDeduplicationChange = (value: boolean) => {
    onChange({ ...config, enableDeduplication: value });
  };

  const handleEnableSimilarityDedupChange = (value: boolean) => {
    onChange({ ...config, enableSimilarityDedup: value });
  };

  const handleDedupSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, dedupSimilarityThreshold: value });
  };

  const handleUseSemanticChunkingChange = (value: boolean) => {
    onChange({ ...config, useSemanticChunking: value });
  };

  const handleSemanticSimilarityThresholdChange = (value: number) => {
    onChange({ ...config, semanticSimilarityThreshold: value });
  };

  const handleSemanticWindowSizeChange = (value: number) => {
    onChange({ ...config, semanticWindowSize: value });
  };

  const handleEnableContextCompressionChange = (value: boolean) => {
    onChange({ ...config, enableContextCompression: value });
  };

  return (
    <CollapsibleSection title="Configuration RAG" defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          {/* Top K */}
          <div className="config-field">
            <label className="config-label">
              Nombre de chunks (topK)
              <span className="config-help">
                Nombre maximum de chunks récupérés pour répondre à une question
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="1"
                max="20"
                value={config.topK}
                onChange={(e) => handleTopKChange(parseInt(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="1"
                max="20"
                value={config.topK}
                onChange={(e) => handleTopKChange(parseInt(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              Valeur actuelle: {config.topK} chunks
              <br />
              <small>
                • 1-5: Réponses rapides, contexte limité
                <br />
                • 6-10: Équilibre vitesse/contexte (recommandé)
                <br />
                • 11-20: Maximum de contexte, plus lent
              </small>
            </div>
          </div>

          {/* Similarity Threshold */}
          <div className="config-field">
            <label className="config-label">
              Seuil de similarité
              <span className="config-help">
                Score minimum de similarité pour inclure un chunk (0.0 - 1.0)
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.similarityThreshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={config.similarityThreshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              Valeur actuelle: {config.similarityThreshold.toFixed(2)}
              <br />
              <small>
                • 0.0-0.2: Plus de résultats, moins précis
                <br />
                • 0.2-0.4: Équilibre (recommandé)
                <br />
                • 0.4-1.0: Très précis, risque de ne rien trouver
              </small>
            </div>
          </div>

          {/* Chunking Configuration */}
          <div className="config-field">
            <label className="config-label">
              Stratégie de découpage
              <span className="config-help">
                Taille des chunks lors de l'indexation
              </span>
            </label>
            <select
              value={config.chunkingConfig}
              onChange={(e) => handleChunkingChange(e.target.value as any)}
              className="config-select"
            >
              <option value="cpuOptimized">Optimisé CPU (petits chunks, rapide)</option>
              <option value="standard">Standard (équilibré)</option>
              <option value="large">Large (gros chunks, plus de contexte)</option>
            </select>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: '#fff3cd',
                border: '1px solid #ffc107',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚠️ Attention :</strong> Changer cette option nécessite de ré-indexer tous les PDFs.
                <br />
                <small>
                  Les chunks existants ne seront pas mis à jour automatiquement.
                </small>
              </div>
            </div>
          </div>

          {/* Summary Generation */}
          <div className="config-field">
            <label className="config-label">
              Génération de résumés
              <span className="config-help">
                Méthode pour générer des résumés de documents
              </span>
            </label>
            <select
              value={config.summaryGeneration}
              onChange={(e) => handleSummaryGenerationChange(e.target.value as any)}
              className="config-select"
            >
              <option value="disabled">Désactivé</option>
              <option value="extractive">Extractif (sélection de phrases clés)</option>
              <option value="abstractive">Abstractif (génération via LLM)</option>
            </select>
            <div className="config-description">
              <small>
                • Extractif: Rapide, sélectionne les phrases importantes
                <br />
                • Abstractif: Plus lent, génère un résumé original (nécessite LLM)
              </small>
            </div>
          </div>

          {/* Summary Max Length - Only shown if summary generation is enabled */}
          {config.summaryGeneration !== 'disabled' && (
            <div className="config-field">
              <label className="config-label">
                Longueur maximale des résumés
                <span className="config-help">
                  Nombre maximum de mots dans le résumé
                </span>
              </label>
              <div className="config-input-group">
                <input
                  type="range"
                  min="100"
                  max="1000"
                  step="50"
                  value={config.summaryMaxLength}
                  onChange={(e) => handleSummaryMaxLengthChange(parseInt(e.target.value))}
                  className="config-slider"
                />
                <input
                  type="number"
                  min="100"
                  max="1000"
                  step="50"
                  value={config.summaryMaxLength}
                  onChange={(e) => handleSummaryMaxLengthChange(parseInt(e.target.value))}
                  className="config-number"
                />
              </div>
              <div className="config-description">
                Valeur actuelle: {config.summaryMaxLength} mots
              </div>
            </div>
          )}

          {/* Use Graph Context */}
          <div className="config-field">
            <label className="config-label">
              Utiliser le graphe de connaissances
              <span className="config-help">
                Enrichir les résultats avec des documents liés (citations, similarité)
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.useGraphContext}
                onChange={(e) => handleUseGraphContextChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.useGraphContext ? 'Activé' : 'Désactivé'}</span>
            </div>
            <div className="config-description">
              <small>
                Active la recherche de documents liés via citations et similarité sémantique
              </small>
            </div>
          </div>

          {/* Additional Graph Docs - Only shown if graph context is enabled */}
          {config.useGraphContext && (
            <>
              <div className="config-field">
                <label className="config-label">
                  Documents liés à inclure
                  <span className="config-help">
                    Nombre de documents liés à ajouter au contexte
                  </span>
                </label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={config.additionalGraphDocs}
                    onChange={(e) => handleAdditionalGraphDocsChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={config.additionalGraphDocs}
                    onChange={(e) => handleAdditionalGraphDocsChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  Valeur actuelle: {config.additionalGraphDocs} documents
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">
                  Seuil de similarité pour le graphe
                  <span className="config-help">
                    Score minimum de similarité pour inclure un document lié
                  </span>
                </label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.5"
                    max="1"
                    step="0.05"
                    value={config.graphSimilarityThreshold}
                    onChange={(e) => handleGraphSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.5"
                    max="1"
                    step="0.05"
                    value={config.graphSimilarityThreshold}
                    onChange={(e) => handleGraphSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  Valeur actuelle: {config.graphSimilarityThreshold.toFixed(2)}
                </div>
              </div>
            </>
          )}

          {/* Include Summaries in RAG */}
          <div className="config-field">
            <label className="config-label">
              Utiliser résumés dans le RAG
              <span className="config-help">
                Utiliser les résumés au lieu des chunks pour le contexte
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.includeSummaries}
                onChange={(e) => handleIncludeSummariesChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.includeSummaries ? 'Activé' : 'Désactivé'}</span>
            </div>
            <div className="config-description">
              <small>
                Si activé, utilise les résumés de documents au lieu des chunks détaillés
                <br />
                ⚠️ Nécessite que la génération de résumés soit activée
              </small>
            </div>
          </div>

          {/* Exploration Similarity Threshold */}
          <div className="config-field">
            <label className="config-label">
              Seuil de similarité (Exploration)
              <span className="config-help">
                Score minimum pour créer des liens de similarité dans le graphe d'exploration
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.explorationSimilarityThreshold}
                onChange={(e) => handleExplorationSimilarityThresholdChange(parseFloat(e.target.value))}
                className="config-slider"
              />
              <input
                type="number"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.explorationSimilarityThreshold}
                onChange={(e) => handleExplorationSimilarityThresholdChange(parseFloat(e.target.value))}
                className="config-number"
              />
            </div>
            <div className="config-description">
              Valeur actuelle: {config.explorationSimilarityThreshold.toFixed(2)}
              <br />
              <small>
                • 0.5-0.6: Plus de connexions, graphe dense
                <br />
                • 0.7: Équilibre (recommandé)
                <br />
                • 0.8-0.95: Connexions très fortes uniquement
              </small>
            </div>
          </div>

          {/* Topic Modeling */}
          <div className="config-field">
            <label className="config-label">
              Modélisation de topics
              <span className="config-help">
                Activer l'analyse thématique automatique du corpus
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableTopicModeling}
                onChange={(e) => handleEnableTopicModelingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.enableTopicModeling ? 'Activé' : 'Désactivé'}</span>
            </div>
            <div className="config-description">
              <small>
                Active BERTopic pour identifier automatiquement les thèmes du corpus
              </small>
            </div>
          </div>

          {/* === CHUNK QUALITY OPTIMIZATION === */}
          <div className="config-field" style={{ marginTop: '24px', borderTop: '1px solid #ddd', paddingTop: '16px' }}>
            <h4 style={{ margin: '0 0 16px 0', color: '#666' }}>🎯 Optimisation qualité des chunks</h4>
          </div>

          {/* Custom Chunking */}
          <div className="config-field">
            <label className="config-label">
              Paramètres personnalisés
              <span className="config-help">
                Définir manuellement la taille des chunks
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.customChunkingEnabled ?? false}
                onChange={(e) => handleCustomChunkingEnabledChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.customChunkingEnabled ? 'Activé' : 'Désactivé'}</span>
            </div>
          </div>

          {config.customChunkingEnabled && (
            <>
              <div className="config-field">
                <label className="config-label">Taille max (mots)</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="100"
                    max="1500"
                    step="50"
                    value={config.customMaxChunkSize ?? 500}
                    onChange={(e) => handleCustomMaxChunkSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="100"
                    max="1500"
                    value={config.customMaxChunkSize ?? 500}
                    onChange={(e) => handleCustomMaxChunkSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">Taille min (mots)</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="20"
                    max="200"
                    step="10"
                    value={config.customMinChunkSize ?? 100}
                    onChange={(e) => handleCustomMinChunkSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="20"
                    max="200"
                    value={config.customMinChunkSize ?? 100}
                    onChange={(e) => handleCustomMinChunkSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">Chevauchement (mots)</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="10"
                    value={config.customOverlapSize ?? 75}
                    onChange={(e) => handleCustomOverlapSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0"
                    max="200"
                    value={config.customOverlapSize ?? 75}
                    onChange={(e) => handleCustomOverlapSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Quality Filtering */}
          <div className="config-field">
            <label className="config-label">
              Filtrage qualité
              <span className="config-help">
                Filtrer les chunks de faible qualité (entropie, répétition)
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableQualityFiltering ?? true}
                onChange={(e) => handleEnableQualityFilteringChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.enableQualityFiltering !== false ? 'Activé' : 'Désactivé'}</span>
            </div>
          </div>

          {config.enableQualityFiltering !== false && (
            <>
              <div className="config-field">
                <label className="config-label">Entropie minimale</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0"
                    max="0.8"
                    step="0.05"
                    value={config.minChunkEntropy ?? 0.3}
                    onChange={(e) => handleMinChunkEntropyChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0"
                    max="0.8"
                    step="0.05"
                    value={config.minChunkEntropy ?? 0.3}
                    onChange={(e) => handleMinChunkEntropyChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
                <div className="config-description">
                  <small>Plus élevé = filtre les chunks répétitifs</small>
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">Ratio mots uniques min</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.2"
                    max="0.8"
                    step="0.05"
                    value={config.minUniqueWordRatio ?? 0.4}
                    onChange={(e) => handleMinUniqueWordRatioChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.2"
                    max="0.8"
                    step="0.05"
                    value={config.minUniqueWordRatio ?? 0.4}
                    onChange={(e) => handleMinUniqueWordRatioChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Preprocessing */}
          <div className="config-field">
            <label className="config-label">
              Prétraitement texte
              <span className="config-help">
                Nettoyer le texte avant découpage (OCR, headers/footers)
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enablePreprocessing ?? true}
                onChange={(e) => handleEnablePreprocessingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.enablePreprocessing !== false ? 'Activé' : 'Désactivé'}</span>
            </div>
          </div>

          {config.enablePreprocessing !== false && (
            <>
              <div className="config-field">
                <label className="config-label">Nettoyage OCR</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableOCRCleanup ?? true}
                    onChange={(e) => handleEnableOCRCleanupChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{config.enableOCRCleanup !== false ? 'Oui' : 'Non'}</span>
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">Supprimer en-têtes/pieds</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableHeaderFooterRemoval ?? true}
                    onChange={(e) => handleEnableHeaderFooterRemovalChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{config.enableHeaderFooterRemoval !== false ? 'Oui' : 'Non'}</span>
                </div>
              </div>
            </>
          )}

          {/* Deduplication */}
          <div className="config-field">
            <label className="config-label">
              Déduplication
              <span className="config-help">
                Supprimer les chunks en double
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableDeduplication ?? true}
                onChange={(e) => handleEnableDeduplicationChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.enableDeduplication !== false ? 'Activé' : 'Désactivé'}</span>
            </div>
          </div>

          {config.enableDeduplication !== false && (
            <>
              <div className="config-field">
                <label className="config-label">Déduplication par similarité</label>
                <div className="config-input-group">
                  <input
                    type="checkbox"
                    checked={config.enableSimilarityDedup ?? false}
                    onChange={(e) => handleEnableSimilarityDedupChange(e.target.checked)}
                    className="config-checkbox"
                  />
                  <span>{config.enableSimilarityDedup ? 'Oui (plus lent)' : 'Non'}</span>
                </div>
              </div>

              {config.enableSimilarityDedup && (
                <div className="config-field">
                  <label className="config-label">Seuil similarité</label>
                  <div className="config-input-group">
                    <input
                      type="range"
                      min="0.7"
                      max="0.95"
                      step="0.05"
                      value={config.dedupSimilarityThreshold ?? 0.85}
                      onChange={(e) => handleDedupSimilarityThresholdChange(parseFloat(e.target.value))}
                      className="config-slider"
                    />
                    <input
                      type="number"
                      min="0.7"
                      max="0.95"
                      step="0.05"
                      value={config.dedupSimilarityThreshold ?? 0.85}
                      onChange={(e) => handleDedupSimilarityThresholdChange(parseFloat(e.target.value))}
                      className="config-number"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Semantic Chunking */}
          <div className="config-field">
            <label className="config-label">
              Chunking sémantique
              <span className="config-help">
                Utiliser les embeddings pour détecter les frontières (expérimental)
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.useSemanticChunking ?? false}
                onChange={(e) => handleUseSemanticChunkingChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.useSemanticChunking ? 'Activé' : 'Désactivé'}</span>
            </div>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: '#e3f2fd',
                border: '1px solid #2196f3',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚡ Info :</strong> Augmente le temps d'indexation (~3x)
              </div>
            </div>
          </div>

          {config.useSemanticChunking && (
            <>
              <div className="config-field">
                <label className="config-label">Sensibilité sémantique</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="0.5"
                    max="0.9"
                    step="0.05"
                    value={config.semanticSimilarityThreshold ?? 0.7}
                    onChange={(e) => handleSemanticSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="0.5"
                    max="0.9"
                    step="0.05"
                    value={config.semanticSimilarityThreshold ?? 0.7}
                    onChange={(e) => handleSemanticSimilarityThresholdChange(parseFloat(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>

              <div className="config-field">
                <label className="config-label">Taille fenêtre (phrases)</label>
                <div className="config-input-group">
                  <input
                    type="range"
                    min="2"
                    max="5"
                    value={config.semanticWindowSize ?? 3}
                    onChange={(e) => handleSemanticWindowSizeChange(parseInt(e.target.value))}
                    className="config-slider"
                  />
                  <input
                    type="number"
                    min="2"
                    max="5"
                    value={config.semanticWindowSize ?? 3}
                    onChange={(e) => handleSemanticWindowSizeChange(parseInt(e.target.value))}
                    className="config-number"
                  />
                </div>
              </div>
            </>
          )}

          {/* Context Compression */}
          <div className="config-field">
            <label className="config-label">
              Compression du contexte
              <span className="config-help">
                Réduit le contexte envoyé au LLM pour améliorer les performances
              </span>
            </label>
            <div className="config-input-group">
              <input
                type="checkbox"
                checked={config.enableContextCompression ?? true}
                onChange={(e) => handleEnableContextCompressionChange(e.target.checked)}
                className="config-checkbox"
              />
              <span>{config.enableContextCompression !== false ? 'Activé' : 'Désactivé'}</span>
            </div>
            <div className="config-description">
              <div style={{
                padding: '8px 12px',
                backgroundColor: '#fff3e0',
                border: '1px solid #ff9800',
                borderRadius: '4px',
                marginTop: '8px'
              }}>
                <strong>⚠️ Note :</strong> Désactiver la compression envoie plus de contexte au LLM,
                ce qui peut améliorer la précision des réponses pour les documents avec des structures
                standardisées (ex: procès-verbaux, archives) mais augmente la latence et le coût.
              </div>
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
