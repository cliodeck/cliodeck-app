import type { ResolvedCitation } from '../live-render';

/** Candidat d'autocomplétion (projection minimale de la bibliographie). */
export interface CitationCandidate {
  id: string;
  author: string;
  year: string;
  title: string;
}

/**
 * Libellés injectés par l'hôte (i18n ClioDeck) — le module reste pur.
 * Les valeurs par défaut (anglais) servent aux tests et à la publication.
 */
export interface ScholarlyLabels {
  citationNotFound: string;
  bibliographyEmpty: string;
  footnoteNoDefinition: string;
  save: string;
  cancel: string;
  frontmatterFolded: string;
  frontmatterFold: string;
}

export const DEFAULT_LABELS: ScholarlyLabels = {
  citationNotFound: 'Key not found in bibliography',
  bibliographyEmpty: 'No citations — import a bibliography first',
  footnoteNoDefinition: 'Missing definition — Cmd/Ctrl+click to create it',
  save: 'Save',
  cancel: 'Cancel',
  frontmatterFolded: 'Frontmatter folded — click to expand',
  frontmatterFold: 'Fold frontmatter',
};

export interface ScholarlyOptions {
  /** Résolution d'une clé (même callback que le rendu live). */
  resolveCitation?: (key: string) => ResolvedCitation | null;
  /** Bibliographie courante pour l'autocomplétion `@`. */
  getCitations?: () => CitationCandidate[];
  labels?: Partial<ScholarlyLabels>;
}
