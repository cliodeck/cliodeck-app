import { StateEffect } from '@codemirror/state';

/**
 * Effet de rafraîchissement du rendu live pour les dépendances EXTERNES au
 * document (Phase 3b) : quand la bibliographie change, la résolution des
 * clés de citation change sans qu'aucune transaction de document n'ait eu
 * lieu ; quand un document sans titre reçoit son chemin, celle des images
 * relatives aussi — le wrapper dispatch cet effet et le rendu recalcule.
 */
export const liveRenderRefresh = StateEffect.define<null>();
