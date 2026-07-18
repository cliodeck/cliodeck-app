/**
 * Canal IPC `editor:insert-text-command` : le main émet `{ text, metadata? }`
 * (Phase 4 — plus de marqueurs de provenance côté main). `normalizeInsertPayload`
 * accepte aussi l'ancienne forme chaîne par tolérance. Le contenu balisé IA
 * (`metadata.modeId`) devient une proposition adjudicable dans l'éditeur.
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
