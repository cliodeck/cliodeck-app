/**
 * Un bilan de lot qui compte les erreurs sans les nommer ne sert à rien : la
 * personne ne peut ni savoir quel PDF a échoué, ni pourquoi, ni nous le dire.
 * Les messages existaient déjà, ils n'étaient simplement jamais affichés.
 */

/** Au-delà, la liste déborderait de la boîte : le reste est au journal de la console. */
const MAX_LISTED = 10;

export function withErrorDetails(summary: string, errors: string[]): string {
  if (errors.length === 0) return summary;
  const listed = errors.slice(0, MAX_LISTED).map((error) => `• ${error}`);
  if (errors.length > MAX_LISTED) listed.push(`… +${errors.length - MAX_LISTED}`);
  return `${summary}\n\n${listed.join('\n')}`;
}
