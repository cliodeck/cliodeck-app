import { parser as markdownParser, GFM } from '@lezer/markdown';
import type { Tree } from '@lezer/common';
import { Footnotes, PandocCitations } from './lezer-extensions/index.js';

/**
 * Découpage d'un deck de slides (chantier « même éditeur », 2026-07-18).
 *
 * Remplace les deux vérités regex de la chaîne présentations (navigator
 * ligne-à-ligne, export `split('\n---\n')`) par un parse unique : un `---`
 * dans un bloc de code n'est PAS un séparateur (bug préexistant corrigé),
 * et le frontmatter YAML initial n'est PAS une slide. Fonctions pures,
 * sans DOM ni import ClioDeck — même famille que footnote-tools.ts.
 *
 * Sémantique du séparateur : une ligne dont le texte est exactement `---`
 * (tolérance `\r` final, fichiers mixtes), hors blocs de code et hors
 * frontmatter. NB : un `---` collé sous un paragraphe est un titre Setext
 * pour CommonMark ; il compte néanmoins comme séparateur ici — c'est le
 * comportement historique de l'export reveal, documenté tel quel.
 *
 * Règle de désambiguïsation frontmatter / première slide (partagée avec le
 * repli scholarly via detectFrontmatterLines) : un document ouvrant sur
 * `---` n'a un frontmatter que si (1) la ligne suivant l'ouverture n'est
 * pas vide, (2) une clôture `---` existe dans les MAX_SCAN_LINES premières
 * lignes, (3) au moins une ligne du corps ressemble à une clé YAML
 * (`clef:`). Sinon, ce `---` est un séparateur : le deck commence par une
 * première slide (éventuellement vide).
 */

export interface SlideInfo {
  /** 0-based. */
  index: number;
  /** Offsets du contenu de la slide (hors séparateurs). */
  from: number;
  to: number;
  /** 1-indexée ; première ligne non vide du contenu (ou première ligne). */
  line: number;
  /** Premier titre de la slide, sinon null. */
  title: string | null;
  /** Niveau du titre (groupement reveal H1/H2), null si autre/absent. */
  level: 1 | 2 | null;
}

export interface DeckInfo {
  frontmatter: { from: number; to: number; yaml: string } | null;
  slides: SlideInfo[];
  /** 0-based : les lignes `---` qui séparent les slides, hors frontmatter et hors blocs de code. */
  separatorLines: number[];
}

const MAX_SCAN_LINES = 100;
const YAML_KEY = /^\s*[A-Za-z0-9_][\w.-]*\s*:/;

const slidesParser = markdownParser.configure([GFM, Footnotes, PandocCitations]);

/** Le `---` peut porter un `\r` résiduel (fichiers mixtes, cf. fidelity.ts). */
export function isSeparatorLine(text: string): boolean {
  return text === '---' || text === '---\r';
}

/**
 * Détection de frontmatter sur des textes de lignes bruts (sans `\n`).
 * Retourne l'index 0-based de la ligne de clôture, ou null. Source unique
 * de la règle — le repli scholarly (cm/scholarly/frontmatter.ts) et
 * parseSlides s'alignent dessus.
 */
export function detectFrontmatterLines(
  lines: readonly string[]
): { closingLine: number } | null {
  if (lines.length < 2 || !isSeparatorLine(lines[0])) return null;
  // Ligne vide immédiatement après l'ouverture : c'est un séparateur de
  // slide en tête de deck, pas un frontmatter.
  if (lines[1] !== undefined && lines[1].trim() === '') return null;
  const last = Math.min(lines.length - 1, MAX_SCAN_LINES);
  let sawYamlKey = false;
  for (let i = 1; i <= last; i++) {
    const text = lines[i];
    if (isSeparatorLine(text)) {
      return sawYamlKey ? { closingLine: i } : null;
    }
    if (YAML_KEY.test(text)) sawYamlKey = true;
  }
  return null;
}

interface LineRec {
  from: number;
  to: number; // fin de ligne, sans le saut
  text: string;
}

function splitLines(source: string): LineRec[] {
  const out: LineRec[] = [];
  let start = 0;
  for (;;) {
    const nl = source.indexOf('\n', start);
    if (nl === -1) {
      out.push({ from: start, to: source.length, text: source.slice(start) });
      return out;
    }
    out.push({ from: start, to: nl, text: source.slice(start, nl) });
    start = nl + 1;
  }
}

/** Plages des blocs de code (fenced + indentés) de l'arbre. */
function codeRanges(tree: Tree): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        out.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return out;
}

function inRanges(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number
): boolean {
  for (const r of ranges) {
    if (from >= r.from && to <= r.to) return true;
  }
  return false;
}

const HEADING = /^(?:ATXHeading|SetextHeading)([12])$/;

export function parseSlides(source: string): DeckInfo {
  const lines = splitLines(source);
  const tree = slidesParser.parse(source);
  const code = codeRanges(tree);

  // Frontmatter (règle partagée).
  const fmLines = lines.slice(0, MAX_SCAN_LINES + 1).map((l) => l.text);
  const fm = detectFrontmatterLines(fmLines);
  const frontmatter =
    fm === null
      ? null
      : {
          from: 0,
          to: lines[fm.closingLine].to,
          yaml: source.slice(lines[0].to + 1, lines[fm.closingLine].from),
        };
  const firstContentLine = fm === null ? 0 : fm.closingLine + 1;

  // Séparateurs : lignes `---` hors frontmatter et hors blocs de code.
  const separators: number[] = []; // index de ligne
  for (let i = firstContentLine; i < lines.length; i++) {
    const l = lines[i];
    if (isSeparatorLine(l.text) && !inRanges(code, l.from, l.to)) {
      separators.push(i);
    }
  }

  // Segments entre séparateurs.
  const slides: SlideInfo[] = [];
  const segments: Array<{ firstLine: number; lastLine: number }> = [];
  let segStart = firstContentLine;
  for (const sep of separators) {
    segments.push({ firstLine: segStart, lastLine: sep - 1 });
    segStart = sep + 1;
  }
  segments.push({ firstLine: segStart, lastLine: lines.length - 1 });

  for (const seg of segments) {
    const index = slides.length;
    // Segment vide (séparateurs consécutifs, ou deck ouvrant sur `---`) :
    // une slide vide est légitime dans un deck.
    if (seg.firstLine > seg.lastLine) {
      const at = seg.firstLine < lines.length ? lines[seg.firstLine].from : source.length;
      slides.push({ index, from: at, to: at, line: lineNumberAt(lines, at), title: null, level: null });
      continue;
    }
    const from = lines[seg.firstLine].from;
    const to = lines[seg.lastLine].to;

    let contentLine = seg.firstLine;
    while (contentLine < seg.lastLine && lines[contentLine].text.trim() === '') {
      contentLine++;
    }

    const heading = firstHeading(tree, source, from, to);
    slides.push({
      index,
      from,
      to,
      line: contentLine + 1,
      title: heading?.title ?? null,
      level: heading?.level ?? null,
    });
  }

  return { frontmatter, slides, separatorLines: separators };
}

function lineNumberAt(lines: readonly LineRec[], offset: number): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].from <= offset) return i + 1;
  }
  return 1;
}

function firstHeading(
  tree: Tree,
  source: string,
  from: number,
  to: number
): { title: string; level: 1 | 2 | null } | null {
  let found: { title: string; level: 1 | 2 | null } | null = null;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (found) return false;
      const m = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(node.name);
      if (!m) return undefined;
      if (node.from < from) return false; // titre chevauchant hors segment
      const raw = source
        .slice(node.from, node.to)
        .replace(/^#{1,6}[ \t]*/, '')
        .replace(/[ \t]#*\s*$/, '')
        .split('\n')[0]
        .trim();
      const levelMatch = HEADING.exec(node.name);
      found = {
        title: raw,
        level: levelMatch ? (Number(levelMatch[1]) as 1 | 2) : null,
      };
      return false;
    },
  });
  return found;
}

// MARK: - Parties d'une slide et notes du présentateur

/**
 * Une diapositive reveal.js tirée d'un segment du découpage : le segment entier, ou, quand il
 * ouvre sur un titre de niveau 1, chacune de ses parties ouvertes par un titre de niveau 2 (les
 * verticales de reveal). Offsets relatifs au segment ; les parties le couvrent bout à bout.
 */
export interface SlidePart {
  from: number;
  to: number;
  /** Début de la ligne `Note:` qui ouvre les notes du présentateur, null sans notes. */
  notesLineFrom: number | null;
  /** Ce qui se projette : la partie jusqu'aux notes, sans les blancs de bord. */
  markdown: string;
  /** Les notes, sans le `Note:` qui les ouvre ni les blancs de bord. */
  notes: string;
}

/** La ligne qui ouvre les notes : `Note:` ou `Notes:`, en toute casse, en tête de ligne. */
const NOTES_LINE = /^\s*notes?:/i;

/** Le segment ouvre-t-il sur un titre `# …` ? Il commence alors une section reveal. */
export function startsWithH1(segment: string): boolean {
  return slidesParser.parse(segment).topNode.firstChild?.name === 'ATXHeading1';
}

/**
 * Parties d'un segment et leurs notes, sur l'arbre Lezer comme parseSlides : le contenu d'un
 * bloc de code n'est jamais un séparateur. Les regex qui faisaient ce travail ignoraient les
 * blocs de code : un commentaire R (`## …`) coupait la diapositive, et un `Note:` cité dans du
 * code en envoyait la suite aux notes (S12-2-3). Les notes courent de la première ligne `Note:`
 * hors code jusqu'à la fin de la partie. Règle unique de l'aperçu, des exports reveal.js et de
 * l'export beamer (`speakerNotesToPandoc`).
 */
export function splitSlideParts(segment: string): SlidePart[] {
  if (segment.trim() === '') return [];
  const tree = slidesParser.parse(segment);
  const code = codeRanges(tree);

  // Une partie par titre `## ` du premier niveau, sous un `# ` d'ouverture : un `## ` de bloc
  // de code n'est pas un nœud de titre.
  const starts = [0];
  const first = tree.topNode.firstChild;
  if (first?.name === 'ATXHeading1') {
    for (let node = first.nextSibling; node; node = node.nextSibling) {
      if (node.name === 'ATXHeading2') starts.push(segment.lastIndexOf('\n', node.from - 1) + 1);
    }
  }

  const lines = splitLines(segment);
  return starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] : segment.length;
    const notesLine = lines.find(
      (l) => l.from >= from && l.from < to && NOTES_LINE.test(l.text) && !inRanges(code, l.from, l.to)
    );
    return {
      from,
      to,
      notesLineFrom: notesLine?.from ?? null,
      markdown: segment.slice(from, notesLine?.from ?? to).trim(),
      notes: notesLine ? segment.slice(notesLine.from, to).replace(NOTES_LINE, '').trim() : '',
    };
  });
}

/**
 * Le deck avec chaque note du présentateur en bloc `::: notes`, que pandoc écrit `\note{…}` pour
 * beamer. Pandoc ne connaît pas les lignes `Note:` du format reveal.js : il les imprimait sur la
 * diapositive projetée (S12-1-8). Seules les notes changent, découpées comme dans l'aperçu ; un
 * `Note:` sans texte disparaît.
 */
export function speakerNotesToPandoc(source: string): string {
  let out = '';
  let last = 0;
  for (const slide of parseSlides(source).slides) {
    const segment = source.slice(slide.from, slide.to);
    for (const part of splitSlideParts(segment)) {
      if (part.notesLineFrom === null) continue;
      const start = slide.from + part.notesLineFrom;
      out += source.slice(last, start);
      if (part.notes) {
        // Pandoc ne lit un bloc `:::` qu'après une ligne vide : collé à un paragraphe, il en
        // devient le texte (mesuré).
        if (!/(^|\n)[ \t]*\n$/.test(out) && out !== '') out += '\n';
        out += `::: notes\n${part.notes}\n:::`;
      }
      // Les blancs qui suivent les notes restent : ils séparent la partie suivante.
      last = slide.from + part.from + segment.slice(part.from, part.to).trimEnd().length;
    }
  }
  return out + source.slice(last);
}

/**
 * Index (0-based) de la slide au droit d'un offset. Un offset situé sur un
 * séparateur appartient à la slide QUI SUIT (la frontière annonce la slide
 * d'après — cohérent avec l'étiquette « Slide n » du rendu live). Bornes
 * clampées ; 0 pour un deck vide.
 */
export function slideIndexAtOffset(deck: DeckInfo, offset: number): number {
  const { slides } = deck;
  if (slides.length === 0) return 0;
  for (let i = 0; i < slides.length; i++) {
    if (offset <= slides[i].to) return i;
  }
  return slides.length - 1;
}
