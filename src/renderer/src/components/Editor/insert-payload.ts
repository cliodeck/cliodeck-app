/**
 * Canal IPC 'editor:insert-text-command' (Phase 4a) : le main émet désormais
 * `{ text, metadata? }` SANS enrober le texte de marqueurs de provenance.
 * Les listeners renderer acceptent les deux formes (chaîne héritée d'une
 * version antérieure du main, ou objet) ; les éditeurs hérités
 * (Monaco/Milkdown) reconstruisent localement l'enveloppe cliodeck-gen à
 * l'identique, l'éditeur CM6 transforme le texte balisé en proposition.
 */

export interface InsertTextPayload {
  text: string;
  metadata?: { modeId?: string; model?: string };
}

export function normalizeInsertPayload(raw: unknown): InsertTextPayload {
  if (typeof raw === 'string') return { text: raw };
  if (raw && typeof raw === 'object') {
    const candidate = raw as { text?: unknown; metadata?: unknown };
    if (typeof candidate.text === 'string') {
      const meta = candidate.metadata as
        | { modeId?: unknown; model?: unknown }
        | undefined;
      return {
        text: candidate.text,
        metadata:
          meta && typeof meta === 'object'
            ? {
                modeId:
                  typeof meta.modeId === 'string' ? meta.modeId : undefined,
                model: typeof meta.model === 'string' ? meta.model : undefined,
              }
            : undefined,
      };
    }
  }
  return { text: '' };
}

/**
 * Enveloppe de provenance héritée — format exact de l'ancien
 * editor-handlers.ts, préservé pour les éditeurs Milkdown/Monaco (gelés
 * jusqu'à la Phase 5). CM6 ne produit plus ces marqueurs : l'annotation
 * changeOrigin et le contrat propositionnel les remplacent.
 */
export function wrapLegacyProvenance(payload: InsertTextPayload): string {
  const { text, metadata } = payload;
  if (!metadata?.modeId) return text;
  const date = new Date().toISOString();
  return `<!-- cliodeck-gen mode="${metadata.modeId}" model="${metadata.model || 'unknown'}" date="${date}" -->\n${text}\n<!-- /cliodeck-gen -->`;
}
