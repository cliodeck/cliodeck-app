/**
 * Le fichier qu'écrit un export (PDF, Word, reveal.js) n'est jamais un fichier Markdown.
 *
 * Le chemin de sortie se résout contre le projet (L07-2 pour PDF et Word, L10-1 pour reveal.js) :
 * un nom nu saisi dans le champ « Fichier de sortie » désigne donc un fichier du projet, et
 * « slides.md » ou « document.md » y remplaçait le manuscrit par le HTML, le PDF ou le .docx de
 * son propre export, sans copie, l'export déclaré réussi. Un chemin absolu le faisait déjà.
 *
 * Aucun export n'écrit de Markdown : un fichier de sortie en `.md` ou `.markdown` est toujours une
 * erreur de saisie, et ce qu'il remplacerait est un texte de l'auteur (manuscrit, chapitre, note
 * de lecture). La règle porte sur l'extension, sans lire le disque, en ignorant la casse : macOS
 * l'ignore aussi, et « Slides.MD » y est le manuscrit.
 */
import { basename, extname, resolve as resolvePath } from 'path';
import type { ExportResult } from './export-time-limit.js';

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * Le refus à rendre tel quel, avant tout travail, quand le fichier de sortie est un fichier
 * Markdown ; `null` sinon. Sans chemin de sortie, l'export écrit à côté du projet, sous le titre
 * et l'extension de son format : rien à refuser.
 */
export function refuseMarkdownOutput(projectPath: string, outputPath: string | undefined): ExportResult | null {
  if (!outputPath) return null;
  const target = resolvePath(projectPath, outputPath);
  if (!MARKDOWN_EXTENSIONS.has(extname(target).toLowerCase())) return null;
  console.warn('⚠️ Export refusé : le fichier de sortie est un fichier Markdown :', target);
  return {
    success: false,
    error: `Le fichier de sortie ${target} est un fichier Markdown : l'export ne le remplace pas.`,
    errorCode: 'export.outputIsMarkdown',
    errorParams: { file: basename(target) },
  };
}
