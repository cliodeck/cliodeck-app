import { EditorState, Facet, Text, type Extension } from '@codemirror/state';

/**
 * Fidélité octet par octet (plan CM6, décision cadre n°1).
 *
 * Le modèle de document CM6 stocke des lignes et resérialise avec un unique
 * séparateur : sans précaution, un fichier CRLF serait silencieusement
 * normalisé à la première sauvegarde.
 *
 * Stratégie : si le fichier est uniformément CRLF, aucun séparateur n'est
 * déclaré — CM6 coupe alors tout texte inséré sur `\r\n`, `\r` ou `\n` — et
 * la facette `documentEol` dit que le fichier s'écrit en CRLF : `readDocText`
 * les rend, round-trip exact, aucun caractère parasite à l'écran. Déclarer
 * `\r\n` à CM6 ne coupait plus une chaîne insérée que sur lui : un `\n` collé,
 * copié par une commande ou remplacé par la recherche restait à l'intérieur
 * d'une « ligne », et le fichier devenait mixte (S14-1-24). Sinon on force
 * "\n" : les "\r" d'un fichier mixte ne sont alors PAS des fins de ligne mais
 * des caractères du document, préservés tels quels (et rendus visibles par
 * highlightSpecialChars, comme le ^M de vim — c'est voulu : on montre l'état
 * réel du fichier plutôt que de le réécrire en douce).
 *
 * Conséquence : `state.sliceDoc()` et `state.lineBreak` rendent du LF dans un
 * fichier CRLF, comme le curseur, qui compte une fin de ligne pour un. Le
 * copier vers une autre application sort en LF.
 */

export type LineSeparator = '\n' | '\r\n';

/**
 * CRLF seulement si toutes les fins de ligne le sont. Un `\r` isolé fait un fichier mixte : sans
 * séparateur déclaré, CM6 y verrait une fin de ligne, et l'écrirait en `\r\n`.
 */
export function detectLineSeparator(source: string): LineSeparator {
  let crlf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      if (source[i - 1] !== '\r') return '\n';
      crlf++;
    } else if (source[i] === '\r' && source[i + 1] !== '\n') {
      return '\n';
    }
  }
  return crlf > 0 ? '\r\n' : '\n';
}

/** Les fins de ligne qu'écrit `readDocText` : celles du fichier ouvert. */
export const documentEol = Facet.define<LineSeparator, LineSeparator>({
  combine: (values) => values[0] ?? '\n',
});

/**
 * Les extensions qui portent les fins de ligne d'un document : à tout état créé ou restauré
 * depuis `source`.
 */
export function docExtensions(source: string): Extension {
  return detectLineSeparator(source) === '\r\n'
    ? documentEol.of('\r\n')
    : EditorState.lineSeparator.of('\n');
}

/**
 * Construit l'état CM6 d'un document en garantissant le contrat de fidélité :
 * `readDocText(createDocState(source)) === source` pour toute chaîne.
 *
 * ATTENTION : lire le texte via `doc.toString()` ou `state.sliceDoc()` NE
 * rend PAS les fins de ligne du fichier — l'un et l'autre joignent avec "\n"
 * et convertiraient un fichier CRLF en LF à la sauvegarde. Toute lecture du
 * document destinée au disque passe par `readDocText`.
 */
export function createDocState(
  source: string,
  extensions: Extension[] = []
): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [docExtensions(source), ...extensions],
  });
}

/**
 * Texte exact d'un état, fins de ligne du fichier comprises (`documentEol`).
 *
 * C'est la seule lecture autorisée avant une écriture disque, un calcul de
 * fidélité ou une comparaison de contenu. Pour calculer une position, c'est
 * `doc.toString()` : une fin de ligne y vaut 1, comme dans les offsets de CM6.
 */
export function readDocText(state: EditorState): string {
  return state.doc.sliceString(0, state.doc.length, state.facet(documentEol));
}

/**
 * Un texte venu d'ailleurs, prêt à entrer dans un document. Une chaîne passée telle quelle n'est
 * coupée que sur le séparateur déclaré : dans un fichier LF ou mixte, ses `\r` deviendraient des
 * caractères du document. La longueur d'un `Text` est aussi la seule qui soit en offsets du
 * document.
 */
export function toDocText(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/));
}

/**
 * Le texte d'un collage ou d'un dépôt, en fins de ligne de l'éditeur (`\n`) : dans un fichier LF ou
 * mixte, où CM6 ne coupe que sur `\n`, ses `\r` deviendraient des caractères du document, le fichier
 * deviendrait mixte, et la réouverture ferait entrer tous ses `\r` dans le texte. Un fichier CRLF
 * les reçoit en `\r\n` de `readDocText`. Pour `clipboardInputFilter`.
 */
export function toDocLineBreaks(text: string, state: EditorState): string {
  return text.replace(/\r\n?|\n/g, state.lineBreak);
}

/** Charge puis restitue sans édition — la boucle du test de fidélité. */
export function roundTrip(source: string): string {
  return readDocText(createDocState(source));
}
