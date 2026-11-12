/**
 * L'historique que la conversation renvoie au modèle à chaque question (S06-1-1).
 *
 * Un tour resté sans réponse — arrêté avant le premier jeton, en erreur, refusé au départ
 * (`local-error`), raisonnement seul, encore en attente — garde à l'écran sa bulle, `content: ''`
 * (l'erreur et le raisonnement sont rangés à part). Renvoyée telle quelle, cette bulle vide faisait
 * échouer en HTTP 400 chaque question suivante chez Claude et Gemini, jusqu'à ce qu'on vide la
 * conversation. Elle ne repart plus, et sa question non plus : avec les deux questions, le modèle
 * répondrait aussi à celle que l'auteur a abandonnée. La bulle et la question restent affichées.
 *
 * Un tour partiel qui a du texte repart, même interrompu ou en erreur : c'est ce que l'auteur a lu.
 * Seuls le rôle et le texte partent ; le chat n'écrit jamais de message `system` dans ce store.
 */

import type { BrainstormMessage } from '../../stores/chatStore';

export function toProviderHistory(
  messages: BrainstormMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant' && !m.content.trim()) {
      // Tour sans réponse : la question qui le précède sort avec lui.
      if (history[history.length - 1]?.role === 'user') history.pop();
      continue;
    }
    history.push({ role: m.role, content: m.content });
  }
  return history;
}
