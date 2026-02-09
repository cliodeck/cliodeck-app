import React from 'react';

interface EventData {
  eventType: string;
  eventData?: Record<string, any>;
}

/**
 * Format event data into human-readable text for historians
 */
export function formatEventForDisplay(event: EventData): {
  label: string;
  description: string;
} {
  const { eventType, eventData } = event;

  switch (eventType) {
    // AI Operations
    case 'ai_operation': {
      const opType = eventData?.operationType || 'inconnue';
      const opLabels: Record<string, string> = {
        rag_query: 'Recherche documentaire (RAG)',
        summarization: 'Génération de résumé',
        citation_extraction: 'Extraction de citations',
        topic_modeling: 'Modélisation thématique',
      };
      return {
        label: opLabels[opType] || `Opération IA: ${opType}`,
        description: 'Une opération d\'intelligence artificielle a été effectuée sur vos documents.',
      };
    }

    // Document Operations
    case 'document_operation': {
      const opType = eventData?.operationType || 'inconnue';
      const filePath = eventData?.filePath || '';
      const fileName = filePath.split('/').pop() || filePath;
      const opLabels: Record<string, string> = {
        save: 'Sauvegarde de document',
        create: 'Création de document',
        delete: 'Suppression de document',
      };
      return {
        label: opLabels[opType] || `Document: ${opType}`,
        description: fileName ? `Fichier: ${fileName}` : '',
      };
    }

    // PDF Operations
    case 'pdf_operation': {
      const opType = eventData?.operationType || 'inconnue';
      const docId = eventData?.documentId || '';
      const opLabels: Record<string, string> = {
        import: 'Import de PDF',
        delete: 'Suppression de PDF',
        reindex: 'Réindexation de PDF',
      };
      return {
        label: opLabels[opType] || `PDF: ${opType}`,
        description: docId ? `Document: ${docId}` : '',
      };
    }

    // Chat Messages
    case 'chat_message': {
      const role = eventData?.role || 'inconnu';
      const roleLabels: Record<string, string> = {
        user: 'Question posée',
        assistant: 'Réponse de l\'assistant',
      };
      return {
        label: roleLabels[role] || 'Message de chat',
        description: eventData?.preview || '',
      };
    }

    // Session Events
    case 'session_start':
      return {
        label: 'Début de session',
        description: 'Ouverture du projet',
      };

    case 'session_end':
      return {
        label: 'Fin de session',
        description: 'Fermeture du projet',
      };

    // Bibliography Events
    case 'bibliography_import':
      return {
        label: 'Import bibliographique',
        description: eventData?.count ? `${eventData.count} références importées` : 'Références importées',
      };

    case 'bibliography_update':
      return {
        label: 'Mise à jour bibliographique',
        description: 'La bibliographie a été modifiée',
      };

    // Corpus Events
    case 'corpus_analysis':
      return {
        label: 'Analyse du corpus',
        description: 'Analyse thématique ou statistique effectuée',
      };

    case 'graph_generated':
      return {
        label: 'Génération du graphe',
        description: 'Le graphe d\'exploration a été généré',
      };

    // Export Events
    case 'export_pdf':
      return {
        label: 'Export PDF',
        description: eventData?.outputPath ? `Exporté vers: ${eventData.outputPath.split('/').pop()}` : 'Document exporté en PDF',
      };

    case 'export_word':
      return {
        label: 'Export Word',
        description: eventData?.outputPath ? `Exporté vers: ${eventData.outputPath.split('/').pop()}` : 'Document exporté en Word',
      };

    case 'export_latex':
      return {
        label: 'Export LaTeX',
        description: 'Document exporté en LaTeX',
      };

    // Search Events
    case 'search_performed':
      return {
        label: 'Recherche effectuée',
        description: eventData?.query ? `Requête: "${eventData.query}"` : '',
      };

    // Configuration Events
    case 'config_changed':
      return {
        label: 'Configuration modifiée',
        description: eventData?.key ? `Paramètre: ${eventData.key}` : 'Paramètres mis à jour',
      };

    // Default fallback
    default:
      return {
        label: formatEventTypeLabel(eventType),
        description: eventData ? formatEventDataSummary(eventData) : '',
      };
  }
}

/**
 * Convert snake_case event type to human-readable label
 */
function formatEventTypeLabel(eventType: string): string {
  return eventType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Create a brief summary of event data without JSON notation
 */
function formatEventDataSummary(data: Record<string, any>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (key === 'id') continue; // Skip internal IDs

    const label = formatEventTypeLabel(key);

    if (typeof value === 'string') {
      const truncated = value.length > 50 ? value.substring(0, 50) + '...' : value;
      parts.push(`${label}: ${truncated}`);
    } else if (typeof value === 'number') {
      parts.push(`${label}: ${value}`);
    } else if (typeof value === 'boolean') {
      parts.push(`${label}: ${value ? 'Oui' : 'Non'}`);
    }

    if (parts.length >= 3) break; // Limit to 3 items
  }

  return parts.join(' | ');
}

interface EventDisplayProps {
  eventType: string;
  eventData?: Record<string, any>;
  showDescription?: boolean;
}

export const EventDisplay: React.FC<EventDisplayProps> = ({
  eventType,
  eventData,
  showDescription = true,
}) => {
  const { label, description } = formatEventForDisplay({ eventType, eventData });

  return (
    <div className="event-display">
      <span className="event-label">{label}</span>
      {showDescription && description && (
        <span className="event-description">{description}</span>
      )}
    </div>
  );
};
