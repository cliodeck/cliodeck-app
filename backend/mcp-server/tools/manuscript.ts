/**
 * `list_manuscript` et `read_manuscript` — le texte de l'historien, lisible
 * par un client MCP.
 *
 * Ces deux outils ne cherchent pas, ils **lisent** : `search_*` renvoie des
 * extraits classés, ceux-ci rendent un fichier entier, page par page. C'est
 * ce qu'il faut pour « relis mon chapitre 3 et dis-moi ce qui cloche », et
 * c'est aussi pourquoi ils sont les seuls à exiger un accord explicite
 * (`TOOLS_REQUIRING_CONSENT`) : ils sortent du projet un texte inédit.
 *
 * Trois décisions qui méritent d'être dites :
 *
 *  - **Le manuscrit, et rien d'autre.** `context.md` et `.cliodeck/hints.md`
 *    sont exclus. Le README promet ces deux couches « locales, jamais
 *    transmises à un client MCP » ; elles portent des consignes injectées
 *    avec autorité, pas de la prose d'auteur.
 *  - **Liste blanche plutôt que garde-fou.** `read_manuscript` ne résout pas
 *    le chemin qu'on lui donne : il le cherche dans la liste produite par la
 *    découverte. Une traversée (`../../.ssh/id_rsa`) ne se heurte pas à un
 *    filtre à contourner, elle ne désigne simplement rien.
 *  - **Pagination explicite.** Le budget commun coupe à 4 000 caractères avec
 *    une ellipse ; sur un chapitre, le modèle lirait le début en croyant
 *    avoir le tout. Ici la réponse dit `totalChars` et `nextOffset` : ou on
 *    redemande, ou on sait ce qu'on n'a pas lu.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { MCPAccessLogger } from '../logger.js';
import type { MCPRuntimeConfig } from '../config.js';

const LIST_TOOL = 'list_manuscript';
const READ_TOOL = 'read_manuscript';

/** Taille d'une page de lecture par défaut, et plafond par appel. */
const DEFAULT_PAGE = 6000;
const MAX_PAGE = 40000;

/** Fichiers du projet qui ne sont pas du manuscrit (voir l'en-tête). */
const EXCLUDED = new Set(['context.md']);

export interface ManuscriptPiece {
  /** Chemin relatif à la racine du projet — l'identifiant côté client. */
  path: string;
  title: string | null;
  kind: 'chapter' | 'document' | 'slides' | 'other';
  chars: number;
  modified: string;
}

/**
 * Recense les pièces du manuscrit : les chapitres d'un livre dans l'ordre du
 * manifeste, sinon `document.md` / `slides.md` / `abstract.md`.
 *
 * Jamais récursif hors de `chapters/` : un dossier de projet contient aussi
 * les PDF de la bibliographie et, parfois, un coffre Obsidian entier.
 */
export function discoverManuscript(root: string): ManuscriptPiece[] {
  const pieces: ManuscriptPiece[] = [];
  const seen = new Set<string>();

  const add = (relative: string, kind: ManuscriptPiece['kind'], title: string | null): void => {
    if (seen.has(relative) || EXCLUDED.has(path.basename(relative))) return;
    const absolute = path.resolve(root, relative);
    // `project.json` fait partie du projet, et un projet se partage : un
    // manifeste forgé citant `../../notes-perso/journal.md` sortirait le
    // fichier du dossier. On vérifie le confinement ici, à la source de la
    // liste blanche, plutôt que dans chaque appelant.
    const inside = path.relative(root, absolute);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return; // Le manifeste peut citer un fichier disparu.
    }
    if (!stat.isFile()) return;
    seen.add(relative);
    pieces.push({
      path: inside,
      title,
      kind,
      chars: stat.size,
      modified: stat.mtime.toISOString(),
    });
  };

  // Livre : l'ordre vient du manifeste, jamais du nom des fichiers.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) as {
      chapters?: Array<{ filePath?: unknown; title?: unknown; order?: unknown }>;
    };
    const chapters = Array.isArray(manifest.chapters) ? [...manifest.chapters] : [];
    chapters.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    for (const c of chapters) {
      if (typeof c.filePath === 'string' && c.filePath.endsWith('.md')) {
        add(c.filePath, 'chapter', typeof c.title === 'string' ? c.title : null);
      }
    }
  } catch {
    // Pas de manifeste, ou illisible : article ou présentation.
  }

  add('document.md', 'document', null);
  add('slides.md', 'slides', null);
  add('abstract.md', 'other', null);

  return pieces;
}

export function registerManuscriptTools(
  server: McpServer,
  cfg: MCPRuntimeConfig,
  logger: MCPAccessLogger
): void {
  server.tool(
    LIST_TOOL,
    "Lists the pieces of the historian's own manuscript in this project — a book's chapters in manifest order, or the article / presentation file. Returns relative paths to pass to read_manuscript.",
    {},
    async () => {
      const start = Date.now();
      const pieces = discoverManuscript(cfg.workspaceRoot);
      logger.log({
        kind: 'tool_call',
        at: new Date().toISOString(),
        name: LIST_TOOL,
        input: {},
        output: { itemCount: pieces.length, totalChars: 0, truncated: false },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { pieces, elapsedMs: Date.now() - start },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    READ_TOOL,
    "Reads one piece of the historian's manuscript, by the relative path given by list_manuscript. Long pieces come back a page at a time: the answer carries totalChars and, when there is more, nextOffset.",
    {
      path: z.string().min(1).describe('Relative path as returned by list_manuscript'),
      offset: z.number().int().min(0).optional().default(0),
      length: z.number().int().min(1).max(MAX_PAGE).optional().default(DEFAULT_PAGE),
    },
    async ({ path: requested, offset, length }) => {
      const start = Date.now();
      const from = offset ?? 0;
      const size = length ?? DEFAULT_PAGE;

      // Liste blanche : on n'accepte que ce que la découverte a produit.
      const piece = discoverManuscript(cfg.workspaceRoot).find((p) => p.path === requested);
      if (!piece) {
        logger.log({
          kind: 'tool_call',
          at: new Date().toISOString(),
          name: READ_TOOL,
          input: { path: requested, offset: from, length: size },
          output: { itemCount: 0, totalChars: 0, truncated: false },
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                path: requested,
                error: 'unknown_piece',
                note: 'No such manuscript piece. Call list_manuscript for the available paths.',
              }),
            },
          ],
        };
      }

      const text = fs.readFileSync(path.join(cfg.workspaceRoot, piece.path), 'utf8');
      const slice = text.slice(from, from + size);
      const nextOffset = from + slice.length < text.length ? from + slice.length : null;

      logger.log({
        kind: 'tool_call',
        at: new Date().toISOString(),
        name: READ_TOOL,
        input: { path: piece.path, offset: from, length: size },
        output: { itemCount: 1, totalChars: slice.length, truncated: nextOffset !== null },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                path: piece.path,
                title: piece.title,
                kind: piece.kind,
                offset: from,
                totalChars: text.length,
                nextOffset,
                content: slice,
                elapsedMs: Date.now() - start,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
