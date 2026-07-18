/**
 * Propositions IA de l'éditeur — IPC handler d'adjudication (plan CM6, Phase 4c).
 *
 * Point de routage unique entre l'éditeur (renderer) et les DEUX journaux,
 * avec des granularités imposées par les types de chaque destinataire :
 *
 *   - **journal de recherche** (`history_proposal_events`, brain.db) :
 *     l'événement complet, contenus inclus ;
 *   - **journal d'usage IA** (`proposal_adjudications`, journal.db) :
 *     {decision, category, model, task, at, workspace} — RIEN d'autre, le
 *     type `RecordAdjudicationInput` ne peut pas transporter de contenu ;
 *   - la note de rejet échantillonnée devient un **brouillon** de la couche
 *     décisionnelle (`decision_drafts`), jamais une décision.
 *
 * Deux émetteurs distincts, aucun couplage de schéma : chaque charge est
 * construite champ par champ, jamais par spread de l'événement entrant.
 * Best-effort intégral : une panne de journalisation ne remonte pas à
 * l'éditeur (l'adjudication elle-même a déjà eu lieu côté renderer).
 */
import { ipcMain } from 'electron';
import { historyService } from '../../services/history-service.js';
import { usageJournalService } from '../../services/usage-journal-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, ProposalAdjudicationSchema } from '../utils/validation.js';

export function setupProposalHandlers() {
  ipcMain.handle('proposals:adjudication', async (_event, rawEvent: unknown) => {
    const event = validate(ProposalAdjudicationSchema, rawEvent);
    try {
      // 1. Journal de recherche — événement complet, contenus inclus.
      historyService.logProposalAdjudication({
        at: event.at,
        proposalId: event.proposalId,
        decision: event.decision,
        category: event.category,
        model: event.model,
        task: event.task,
        latencyMs: event.latencyMs,
        originalText: event.original,
        proposedText: event.proposed,
        finalText: event.final,
        rejectionNote: event.rejectionNote,
      });

      // 2. Journal d'usage IA — agrégats décisionnels sans contenu.
      usageJournalService.recordAdjudication({
        at: event.at,
        decision: event.decision,
        category: event.category,
        model: event.model,
        task: event.task,
      });

      // 3. Note de rejet échantillonnée → brouillon décisionnel.
      if (event.rejectionNote) {
        usageJournalService.recordDecisionDraft({
          at: event.at,
          category: event.category,
          model: event.model,
          task: event.task,
          note: event.rejectionNote,
        });
      }

      return successResponse();
    } catch (error: unknown) {
      console.error('❌ proposals:adjudication error:', error);
      return errorResponse(error instanceof Error ? error : String(error));
    }
  });

  console.log('✅ Proposal handlers registered (1 handler)');
}
