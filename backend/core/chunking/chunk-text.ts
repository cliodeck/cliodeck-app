/**
 * Le texte propre d'un extrait de PDF, sans le préfixe de contexte que les
 * découpeurs posent en tête : `[Doc: <titre> | Section: <section>]` suivi d'une
 * ligne vide (`AdaptiveChunker.enhanceChunkWithContext`, `DocumentChunker`,
 * `SemanticChunker`).
 *
 * Ce préfixe sert l'embedding et BM25, qui l'indexent avec l'extrait. Il ne doit
 * pas compter comme du texte de l'extrait : ni pour le bonus « mot-clé exact »
 * de la recherche hybride (un titre « Histoire sociale » le donnait à tous les
 * extraits de l'ouvrage), ni dans l'extrait cité au modèle.
 */

const HEADER_START = '[Doc:';

/**
 * Retire le préfixe `[Doc: …]` et les blancs qui le suivent. Le préfixe va jusqu'à la première
 * ligne vide, qui se termine par « ] » : un titre peut contenir des crochets (« [1789-1914] »),
 * que l'ancienne expression `/^\[Doc:[^\]]*\]/` coupait au premier « ] ». Sans préfixe reconnu,
 * le texte revient tel quel.
 */
export function stripChunkHeader(content: string): string {
  if (!content.startsWith(HEADER_START)) return content;
  const blankLine = content.indexOf('\n\n');
  if (blankLine === -1 || content[blankLine - 1] !== ']') return content;
  return content.slice(blankLine).trimStart();
}
