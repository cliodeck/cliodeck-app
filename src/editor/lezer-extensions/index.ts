/**
 * Lezer markdown extensions for scholarly writing: Pandoc-style footnotes
 * and citations. Self-contained module (only @lezer/* imports), designed for
 * standalone npm publication (MIT) once the API has settled.
 */
export { Footnotes, footnoteTags } from './footnotes';
export { PandocCitations, citationTags } from './pandoc-citations';

import type { MarkdownExtension } from '@lezer/markdown';
import { Footnotes } from './footnotes';
import { PandocCitations } from './pandoc-citations';

/** Both extensions bundled, ready for `markdown({ extensions })`. */
export const scholarlyMarkdown: MarkdownExtension = [
  Footnotes,
  PandocCitations,
];
