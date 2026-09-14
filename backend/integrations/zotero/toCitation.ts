import { createCitation, type Citation, type ZoteroAttachmentInfo } from '../../types/citation';
import { extractYear } from '../../core/bibliography/citekey';
import { verbatimSafe } from '../../core/bibliography/BibTeXExporter';
import type { ZoteroAttachment, ZoteroItem } from './ZoteroAPI';
import { formatCreators } from './creators';

/**
 * Conversion d'un item Zotero en entrée bibliographique — une seule, pour
 * l'import comme pour la synchronisation. Il en existait deux copies qui
 * divergeaient ; chaque correction appliquée à l'une manquait à l'autre.
 *
 * La cible est BibLaTeX : pandoc lit un fichier `.bib` en BibLaTeX, et c'est
 * ce dialecte qui distingue un article de presse d'un article de revue, une
 * page web d'un document quelconque, ou qui porte une date complète.
 */

/**
 * Type Zotero → type d'entrée BibLaTeX. Tout ce qui manquait ici devenait
 * `@misc`, que les styles CSL rendent comme un document sans nature :
 * l'article du *New York Times* s'affichait « In The New York Times », le
 * billet de blog et la page web sans leur site.
 */
const ENTRY_TYPES: Record<string, string> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  conferencePaper: 'inproceedings',
  encyclopediaArticle: 'inreference',
  dictionaryEntry: 'inreference',
  thesis: 'thesis',
  report: 'report',
  manuscript: 'unpublished',
  letter: 'letter',
  email: 'letter',
  webpage: 'online',
  blogPost: 'online',
  forumPost: 'online',
  preprint: 'online',
  computerProgram: 'software',
  videoRecording: 'video',
  tvBroadcast: 'video',
  film: 'movie',
  audioRecording: 'audio',
  radioBroadcast: 'audio',
  podcast: 'audio',
  dataset: 'dataset',
  patent: 'patent',
  artwork: 'artwork',
};

/** BibLaTeX distingue presse et magazine d'une revue par `entrysubtype`. */
const ENTRY_SUBTYPES: Record<string, string> = {
  newspaperArticle: 'newspaper',
  magazineArticle: 'magazine',
};

/** Types dont le conteneur est un ouvrage (`booktitle`), pas un périodique. */
const BOOK_CONTAINER_TYPES = new Set([
  'bookSection',
  'conferencePaper',
  'encyclopediaArticle',
  'dictionaryEntry',
]);

/**
 * Champs BibLaTeX que Zotero alimente et qui vivent dans `customFields`.
 * Zotero en est propriétaire : la synchronisation les compare, et une
 * valeur disparue de Zotero disparaît du fichier.
 */
export const ZOTERO_OWNED_FIELDS = [
  'entrysubtype',
  'type',
  'url',
  'doi',
  'volume',
  'number',
  'pages',
  'address',
  'isbn',
  'edition',
  'series',
  'date',
  'urldate',
] as const;

/**
 * Premier champ renseigné parmi des noms Zotero. Un même rôle porte des noms
 * différents selon le type de notice : le titre d'un blog est `blogTitle`,
 * celui d'un site `websiteTitle`, l'éditeur d'une thèse `university`.
 */
function field(data: ZoteroItem['data'], ...names: string[]): string | undefined {
  for (const name of names) {
    const value = data[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Date BibLaTeX (`AAAA-MM` ou `AAAA-MM-JJ`) quand Zotero connaît plus que
 * l'année — ce qui compte pour un article de presse ou un billet daté.
 * La base locale stocke « 2025-06-16 2025-06-16 », avec `00` pour un mois
 * ou un jour inconnu ; l'API renvoie la saisie d'origine, exploitable
 * seulement quand elle est déjà au format ISO.
 */
export function zoteroDate(raw: string | undefined): string | undefined {
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (month === '00') return undefined;
  return day === '00' ? `${year}-${month}` : `${year}-${month}-${day}`;
}

/** Date de consultation, réduite au jour (`2025-06-20 08:12:33` → `2025-06-20`). */
function accessDate(raw: string | undefined): string | undefined {
  const match = raw?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

/**
 * PDF joints à la notice, quand la source les a fournis (`data.attachments`).
 *
 * `undefined` si la source ne les a pas lus : ce n'est pas la même chose
 * qu'une notice sans PDF, et la synchronisation ne doit pas en déduire
 * qu'ils ont disparu. Les autres pièces jointes (instantanés HTML, liens)
 * sont écartées : le panneau les présente comme des PDF à télécharger.
 */
function pdfAttachments(data: ZoteroItem['data']): ZoteroAttachmentInfo[] | undefined {
  if (!Array.isArray(data.attachments)) return undefined;
  return (data.attachments as ZoteroAttachment[])
    .filter((att) => {
      const type = att.data.contentType;
      const name = att.data.filename ?? '';
      return type === 'application/pdf' || (!type && /\.pdf$/i.test(name));
    })
    .map((att) => ({
      key: att.key,
      filename: att.data.filename || `${att.key}.pdf`,
      contentType: 'application/pdf',
      downloaded: false,
      dateModified: att.data.dateModified,
      md5: att.data.md5,
    }));
}

/**
 * Item Zotero → citation, avec la clé BibTeX déjà attribuée
 * (cf. `assignCiteKeys`).
 */
export function zoteroItemToCitation(item: ZoteroItem, bibtexKey: string): Citation {
  const data = item.data;
  const itemType = data.itemType;

  const periodical = field(data, 'publicationTitle', 'blogTitle', 'websiteTitle', 'forumTitle', 'programTitle');
  const book = field(data, 'bookTitle', 'proceedingsTitle', 'encyclopediaTitle', 'dictionaryTitle');
  const url = field(data, 'url');

  const customFields: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) customFields[name] = value;
  };
  set('entrysubtype', ENTRY_SUBTYPES[itemType]);
  set('type', field(data, 'thesisType', 'reportType', 'websiteType', 'genre', 'manuscriptType', 'letterType', 'presentationType', 'postType', 'mapType'));
  // Encodée dès ici, telle qu'elle sera écrite puis relue : sinon une URL
  // contenant des accolades différerait de sa relecture, et la
  // synchronisation la verrait « modifiée » à chaque passage (cas réel :
  // un gabarit `${import.meta.env.VITE_BASEURL}` capturé par Zotero).
  set('url', url && verbatimSafe(url));
  const doi = field(data, 'DOI');
  set('doi', doi && verbatimSafe(doi));
  set('volume', field(data, 'volume'));
  set(
    'number',
    field(data, 'issue', 'number', 'reportNumber', 'archiveID', 'episodeNumber', 'patentNumber', 'billNumber', 'docketNumber', 'documentNumber', 'publicLawNumber', 'identifier')
  );
  set('pages', field(data, 'pages'));
  set('address', field(data, 'place'));
  set('isbn', field(data, 'ISBN'));
  set('edition', field(data, 'edition'));
  set('series', field(data, 'series'));
  set('date', zoteroDate(field(data, 'date', 'dateDecided', 'issueDate', 'dateEnacted')));
  // Une date de consultation sans URL ne dit rien à personne.
  if (url) set('urldate', accessDate(field(data, 'accessDate')));

  const inBook = BOOK_CONTAINER_TYPES.has(itemType);

  return createCitation({
    id: bibtexKey,
    type: ENTRY_TYPES[itemType] ?? 'misc',
    author: formatCreators(item, 'author'),
    editor: formatCreators(item, 'editor') || undefined,
    year: extractYear(field(data, 'date', 'dateDecided', 'issueDate', 'dateEnacted')),
    title: field(data, 'title', 'caseName', 'nameOfAct', 'subject') ?? 'Untitled',
    // Le titre court de Zotero, ou rien : le titre coupé à 47 caractères
    // qu'on fabriquait autrefois n'est pas un titre court.
    shortTitle: field(data, 'shortTitle'),
    journal: inBook ? undefined : periodical,
    booktitle: inBook ? (book ?? periodical) : undefined,
    publisher: field(data, 'publisher', 'university', 'institution', 'company', 'repository', 'label', 'distributor', 'studio', 'network'),
    zoteroKey: item.key,
    zoteroAttachments: pdfAttachments(data),
    tags: data.tags?.map((t) => t.tag),
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
  });
}
