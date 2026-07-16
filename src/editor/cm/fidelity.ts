import { EditorState, type Extension } from '@codemirror/state';

/**
 * Fidélité octet par octet (plan CM6, décision cadre n°1).
 *
 * Le modèle de document CM6 stocke des lignes et resérialise avec un unique
 * séparateur (`EditorState.lineSeparator`, "\n" par défaut) : sans précaution,
 * un fichier CRLF serait silencieusement normalisé à la première sauvegarde.
 *
 * Stratégie : si le fichier est uniformément CRLF, on déclare "\r\n" comme
 * séparateur — round-trip exact, aucun caractère parasite à l'écran. Sinon on
 * force "\n" : les "\r" d'un fichier mixte ne sont alors PAS des fins de
 * ligne mais des caractères du document, préservés tels quels (et rendus
 * visibles par highlightSpecialChars, comme le ^M de vim — c'est voulu : on
 * montre l'état réel du fichier plutôt que de le réécrire en douce).
 */

export type LineSeparator = '\n' | '\r\n';

export function detectLineSeparator(source: string): LineSeparator {
  let crlf = 0;
  let bareLf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      if (source[i - 1] === '\r') crlf++;
      else bareLf++;
    }
  }
  return crlf > 0 && bareLf === 0 ? '\r\n' : '\n';
}

/**
 * Construit l'état CM6 d'un document en garantissant le contrat de fidélité :
 * `createDocState(source).doc.toString() === source` pour toute chaîne.
 */
export function createDocState(
  source: string,
  extensions: Extension[] = []
): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [
      EditorState.lineSeparator.of(detectLineSeparator(source)),
      ...extensions,
    ],
  });
}

/** Charge puis restitue sans édition — la boucle du test de fidélité. */
export function roundTrip(source: string): string {
  return createDocState(source).doc.toString();
}
