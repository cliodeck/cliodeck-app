import React from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../common/CollapsibleSection';
import type { RAGConfig } from './ConfigPanel';
import { RAGRetrievalSettings } from './RAGRetrievalSettings';
import { RAGChunkQualitySettings } from './RAGChunkQualitySettings';

/**
 * Configuration RAG — coquille (#57). Le contenu vit dans deux
 * sous-sections extraites verbatim (912 lignes → 3 fichiers, split sur le
 * modèle de CorpusExplorerPanel) : réglages de retrieval d'un côté,
 * optimisation qualité des chunks de l'autre — la frontière que le
 * fichier marquait déjà par sa bannière « CHUNK QUALITY OPTIMIZATION ».
 */
interface RAGConfigSectionProps {
  config: RAGConfig;
  onChange: (config: RAGConfig) => void;
}

export const RAGConfigSection: React.FC<RAGConfigSectionProps> = ({ config, onChange }) => {
  const { t } = useTranslation('common');
  return (
    <CollapsibleSection title={t('ragConfig.title')} defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <RAGRetrievalSettings config={config} onChange={onChange} />
          <RAGChunkQualitySettings config={config} onChange={onChange} />
        </div>
      </div>
    </CollapsibleSection>
  );
};
