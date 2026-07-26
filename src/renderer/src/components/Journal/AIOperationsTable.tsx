import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AIOperation } from '../../stores/journalStore';

interface Props {
  operations: AIOperation[];
}

export const AIOperationsTable: React.FC<Props> = ({ operations }) => {
  const { t } = useTranslation('common');
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  const toggleExpand = (opId: string) => {
    setExpandedOp(expandedOp === opId ? null : opId);
  };

  return (
    <div className="ai-operations-table">
      <h3>{t('aiOps.title')}</h3>

      {operations.length === 0 ? (
        <div className="empty-state">
          <p>{t('aiOps.empty')}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('aiOps.time')}</th>
              <th>{t('aiOps.operation')}</th>
              <th>{t('aiOps.model')}</th>
              <th>{t('aiOps.duration')}</th>
              <th>{t('aiOps.success')}</th>
              <th>{t('aiOps.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {operations.map((op) => (
              <React.Fragment key={op.id}>
                <tr>
                  <td>{op.timestamp.toLocaleTimeString('fr-FR')}</td>
                  <td>{op.operationType}</td>
                  <td>{op.modelName || 'N/A'}</td>
                  <td>{op.durationMs ? `${op.durationMs}ms` : 'N/A'}</td>
                  <td>{op.success ? '✓' : '✗'}</td>
                  <td>
                    <button onClick={() => toggleExpand(op.id)}>
                      {expandedOp === op.id ? 'Réduire' : 'Détails'}
                    </button>
                  </td>
                </tr>
                {expandedOp === op.id && (
                  <tr className="expanded-row">
                    <td colSpan={6}>
                      <div className="operation-details">
                        {op.inputText && (
                          <div className="detail-section">
                            <h4>Entrée:</h4>
                            <pre>{op.inputText.substring(0, 500)}</pre>
                          </div>
                        )}
                        {op.outputText && (
                          <div className="detail-section">
                            <h4>Sortie:</h4>
                            <pre>{op.outputText.substring(0, 500)}</pre>
                          </div>
                        )}
                        {op.inputMetadata && (
                          <div className="detail-section">
                            <h4>Métadonnées d'entrée:</h4>
                            <pre>{JSON.stringify(op.inputMetadata, null, 2)}</pre>
                          </div>
                        )}
                        {op.outputMetadata && (
                          <div className="detail-section">
                            <h4>Métadonnées de sortie:</h4>
                            <pre>{JSON.stringify(op.outputMetadata, null, 2)}</pre>
                          </div>
                        )}
                        {op.modelParameters && (
                          <div className="detail-section">
                            <h4>Paramètres du modèle:</h4>
                            <pre>{JSON.stringify(op.modelParameters, null, 2)}</pre>
                          </div>
                        )}
                        {op.errorMessage && (
                          <div className="detail-section error">
                            <h4>Erreur:</h4>
                            <pre>{op.errorMessage}</pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
