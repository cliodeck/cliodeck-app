/**
 * Un message pour l'historien, dit par un code plutôt que par une phrase (A11, L09-2).
 *
 * Le main et le backend ne savent pas dans quelle langue l'interface parle : ils renvoient un
 * code, relatif à `messages.*` des locales (la clé `messages.errors.noResponse` s'écrit
 * `errors.noResponse`), avec ses paramètres. Le renderer le traduit par `translateMessage`
 * (`src/renderer/src/utils/translate-message.ts`), le seul traducteur. Sous `messages`, les codes
 * vivent en objets imbriqués, jamais en clés plates à point.
 *
 * Sans dépendance : importable du backend, du main et du renderer.
 */
export interface UserMessage {
  code: string;
  params?: Record<string, string | number>;
}
