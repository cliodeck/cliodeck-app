/**
 * Les changements qui mènent d'un texte à un autre en touchant le moins possible du premier.
 *
 * Remplacer tout le document pour une édition calculée par l'app (renumérotation des notes,
 * renommage du chapitre ouvert) ramenait le curseur en tête et retirait toutes les propositions IA
 * en attente, journalisées comme `invalidated` alors que l'auteur n'avait rien décidé (L01-6). Avec
 * des changements localisés, CM6 garde le curseur et les propositions là où rien ne change.
 *
 * Deux passes de Myers : les lignes d'abord, puis, dans chaque bloc de lignes qui diffère, les
 * caractères. Un caractère hors BMP compte pour un : aucune limite ne tombe entre ses deux moitiés.
 * La recherche est bornée en mémoire et en temps : au-delà, elle se coupe en deux, puis rend des
 * plages plus larges, préfixe et suffixe communs exclus. Plus larges, jamais fausses.
 *
 * Positions et longueurs en unités UTF-16 du texte de départ, comme les offsets de CM6. Les
 * changements sont triés et séparés par au moins un caractère gardé : `ChangeSet.of` les accepte
 * tels quels, et les appliquer de la fin vers le début sur `prev` rend exactement `next`.
 */

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Une plage qui diffère : `a[aFrom, aTo)` devient `b[bFrom, bTo)`, en indices de jetons. */
interface Hunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

/** Au-delà, la trace de Myers (de l'ordre du carré de ce nombre) coûterait trop de mémoire. */
const MAX_EDITS = 2000;
/**
 * Comparaisons de jetons pour tout un texte, au plus (lignes et caractères chacun) : 85 ms pour
 * 1 500 notes renumérotées dans un chapitre de 260 000 caractères, 160 ms au pire mesuré, sur un
 * Mac. Ce qui reste à chercher une fois la limite passée devient une plage par morceau.
 */
const MAX_COMPARISONS = 20_000_000;
/** Une recherche trop longue se coupe en deux, au plus autant de fois de suite. */
const MAX_SPLITS = 12;

/** Le travail déjà fait, partagé par toutes les recherches d'un même texte. */
interface Budget {
  comparisons: number;
}

/**
 * Plus courte suite d'insertions et de retraits de `a[aLo, aHi)` à `b[bLo, bHi)` (Myers, 1986),
 * regroupée en plages ; `null` si elle dépasse `MAX_EDITS` ou le budget.
 */
function shortestEdit(
  a: ArrayLike<number>,
  aLo: number,
  aHi: number,
  b: ArrayLike<number>,
  bLo: number,
  bHi: number,
  budget: Budget
): Hunk[] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // Avant le tour d, les extrémités atteintes au tour d - 1, pour k de -d - 1 à d + 1.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      const snakeFrom = x;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      budget.comparisons += x - snakeFrom + 1;
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (budget.comparisons > MAX_COMPARISONS) return null;
  }
  if (found < 0) return null;

  // Remontée : chaque tour a fait un pas hors de la diagonale, puis a suivi les jetons communs.
  const steps: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const at = (k: number) => before[k + d + 1];
    const k = x - y;
    const inserted = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevX = at(inserted ? k + 1 : k - 1);
    const prevY = prevX - (inserted ? k + 1 : k - 1);
    steps.push(
      inserted
        ? { aFrom: aLo + prevX, aTo: aLo + prevX, bFrom: bLo + prevY, bTo: bLo + prevY + 1 }
        : { aFrom: aLo + prevX, aTo: aLo + prevX + 1, bFrom: bLo + prevY, bTo: bLo + prevY }
    );
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

/**
 * Les plages qui diffèrent entre `a[aLo, aHi)` et `b[bLo, bHi)`, ajoutées à `out`. Préfixe et suffixe
 * communs d'abord ; une recherche trop longue se coupe en deux, chaque moitié de `a` face à la part
 * de `b` qui lui correspond en proportion, ce qui aligne exactement deux textes de même longueur
 * (une renumérotation ne change pas le nombre de lignes). Au bout des coupes, une seule plage :
 * plus large, jamais fausse.
 */
function diffRange(
  a: ArrayLike<number>,
  aLo: number,
  aHi: number,
  b: ArrayLike<number>,
  bLo: number,
  bHi: number,
  budget: Budget,
  splits: number,
  out: Hunk[]
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    aLo++;
    bLo++;
  }
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  if (aLo === aHi && bLo === bHi) return;
  const whole = { aFrom: aLo, aTo: aHi, bFrom: bLo, bTo: bHi };
  if (aLo === aHi || bLo === bHi) {
    out.push(whole);
    return;
  }
  const found = budget.comparisons > MAX_COMPARISONS ? null : shortestEdit(a, aLo, aHi, b, bLo, bHi, budget);
  if (found) {
    out.push(...found);
    return;
  }
  if (splits >= MAX_SPLITS || budget.comparisons > MAX_COMPARISONS || aHi - aLo < 2) {
    out.push(whole);
    return;
  }
  const aMid = aLo + Math.floor((aHi - aLo) / 2);
  const bMid = bLo + Math.round(((bHi - bLo) * (aMid - aLo)) / (aHi - aLo));
  diffRange(a, aLo, aMid, b, bLo, bMid, budget, splits + 1, out);
  diffRange(a, aMid, aHi, b, bMid, bHi, budget, splits + 1, out);
}

/**
 * Les plages qui diffèrent, dans l'ordre, deux plages contiguës fondues en une. Une fusion peut
 * rapprocher ce qu'une coupe avait séparé (un jeton retiré d'un côté, le même ajouté de l'autre) :
 * ce qu'elle a de commun au début et à la fin en sort.
 */
function diffSequences(a: ArrayLike<number>, b: ArrayLike<number>, budget: Budget): Hunk[] {
  const pieces: Hunk[] = [];
  diffRange(a, 0, a.length, b, 0, b.length, budget, 0, pieces);
  const merged: Hunk[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.aTo === piece.aFrom && last.bTo === piece.bFrom) {
      last.aTo = piece.aTo;
      last.bTo = piece.bTo;
    } else {
      merged.push({ ...piece });
    }
  }
  const hunks: Hunk[] = [];
  for (const h of merged) {
    while (h.aFrom < h.aTo && h.bFrom < h.bTo && a[h.aFrom] === b[h.bFrom]) {
      h.aFrom++;
      h.bFrom++;
    }
    while (h.aTo > h.aFrom && h.bTo > h.bFrom && a[h.aTo - 1] === b[h.bTo - 1]) {
      h.aTo--;
      h.bTo--;
    }
    if (h.aFrom < h.aTo || h.bFrom < h.bTo) hunks.push(h);
  }
  return hunks;
}

/** Les jetons d'un texte et l'offset UTF-16 où chacun commence (un de plus : la fin du texte). */
interface Tokens {
  ids: Int32Array;
  offsets: Int32Array;
}

/** Une ligne par jeton, sa fin de ligne comprise ; deux lignes identiques ont le même numéro. */
function lineTokens(text: string, ids: Map<string, number>): Tokens {
  const starts: number[] = [];
  const values: number[] = [];
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf('\n', at);
    const next = end < 0 ? text.length : end + 1;
    const line = text.slice(at, next);
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    starts.push(at);
    values.push(id);
    at = next;
  }
  starts.push(text.length);
  return { ids: Int32Array.from(values), offsets: Int32Array.from(starts) };
}

/** Un caractère par jeton : deux unités UTF-16 pour un caractère hors BMP. */
function charTokens(text: string): Tokens {
  const starts: number[] = [];
  const values: number[] = [];
  let at = 0;
  for (const char of text) {
    starts.push(at);
    values.push(char.codePointAt(0) ?? 0);
    at += char.length;
  }
  starts.push(text.length);
  return { ids: Int32Array.from(values), offsets: Int32Array.from(starts) };
}

export function minimalChanges(prev: string, next: string): TextChange[] {
  if (prev === next) return [];
  const lineIds = new Map<string, number>();
  const prevLines = lineTokens(prev, lineIds);
  const nextLines = lineTokens(next, lineIds);

  const changes: TextChange[] = [];
  const lineBudget: Budget = { comparisons: 0 };
  const charBudget: Budget = { comparisons: 0 };
  for (const lines of diffSequences(prevLines.ids, nextLines.ids, lineBudget)) {
    // Dans le bloc de lignes qui diffère, les caractères : une étiquette renumérotée ne touche
    // qu'elle-même, pas le paragraphe qui la porte.
    const aBase = prevLines.offsets[lines.aFrom];
    const bBase = nextLines.offsets[lines.bFrom];
    const aText = prev.slice(aBase, prevLines.offsets[lines.aTo]);
    const bText = next.slice(bBase, nextLines.offsets[lines.bTo]);
    const aChars = charTokens(aText);
    const bChars = charTokens(bText);
    for (const chars of diffSequences(aChars.ids, bChars.ids, charBudget)) {
      changes.push({
        from: aBase + aChars.offsets[chars.aFrom],
        to: aBase + aChars.offsets[chars.aTo],
        insert: bText.slice(bChars.offsets[chars.bFrom], bChars.offsets[chars.bTo]),
      });
    }
  }
  return changes;
}
