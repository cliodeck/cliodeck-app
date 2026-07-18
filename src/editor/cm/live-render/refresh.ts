import { StateEffect } from '@codemirror/state';

/**
 * Effet de rafraîchissement du rendu live pour les dépendances EXTERNES au
 * document (Phase 3b) : quand la bibliographie change, la résolution des
 * clés de citation change sans qu'aucune transaction de document n'ait eu
 * lieu — le wrapper dispatch cet effet et le ViewPlugin recalcule.
 */
export const liveRenderRefresh = StateEffect.define<null>();
