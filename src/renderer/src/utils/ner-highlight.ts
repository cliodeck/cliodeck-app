/**
 * NER-like entity highlighting for chat messages (A11.5).
 *
 * Pattern-based entity detection for historians:
 * - Dates (various formats: "1789", "14 juillet 1789", "1914-1918", "XIXe siècle")
 * - Proper nouns (capitalized multi-word sequences)
 * - Places (common geographic markers: "Paris", "France", etc.)
 *
 * Operates on plain text extracted from HTML nodes. Returns HTML with
 * <mark class="ner ner--{type}"> wrappers.
 */

export type EntityType = 'date' | 'person' | 'place' | 'org';

export interface Entity {
  text: string;
  type: EntityType;
  start: number;
  end: number;
}

// Date patterns for historians
const DATE_PATTERNS = [
  // Year ranges: 1914-1918, 1789–1793
  /\b(\d{4})\s*[-–]\s*(\d{4})\b/g,
  // Full dates: 14 juillet 1789, 3 septembre 1939
  /\b\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/gi,
  // Century: XIXe siècle, XXe siècle, 19th century
  /\b(?:X{0,3}(?:IX|IV|V?I{0,3}))e\s+siècle\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)\s+century\b/gi,
  // Standalone years in historical range (1400-2100)
  /\b(1[4-9]\d{2}|20\d{2}|21\d{2})\b/g,
];

// Capitalized multi-word sequences (proper nouns)
// Two or more consecutive capitalized words (allowing particles like de/von/van)
const PROPER_NOUN_PATTERN = /[A-ZÀ-ÖÙ-Ý][a-zà-öù-ÿ]+(?:\s+(?:de|du|des|von|van|le|la|di|d'|el|al-))?(?:\s+[A-ZÀ-ÖÙ-Ý][a-zà-öù-ÿ]+)+/g;

// Common words that look like proper nouns but aren't (stoplist)
const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'which', 'what', 'when',
  'where', 'while', 'also', 'however', 'moreover', 'furthermore',
  'les', 'des', 'une', 'dans', 'pour', 'avec', 'mais', 'donc',
  'cette', 'selon', 'entre', 'ainsi', 'comme', 'plus',
]);

/**
 * Detect entities in plain text.
 */
export function detectEntities(text: string): Entity[] {
  const entities: Entity[] = [];
  const occupied = new Set<number>();

  // Dates first (highest priority)
  for (const pattern of DATE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // Skip single 4-digit numbers that are likely not years (within longer numbers)
      if (match[0].length === 4) {
        const charBefore = text[start - 1];
        const charAfter = text[end];
        if ((charBefore && /\d/.test(charBefore)) || (charAfter && /\d/.test(charAfter))) {
          continue;
        }
      }
      if (!isOccupied(occupied, start, end)) {
        entities.push({ text: match[0], type: 'date', start, end });
        markOccupied(occupied, start, end);
      }
    }
  }

  // Proper nouns (persons/places/orgs — we classify as 'person' generically)
  const re = new RegExp(PROPER_NOUN_PATTERN.source, PROPER_NOUN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const words = match[0].trim().split(/\s+/);
    // Skip if first word is a stopword
    if (STOPWORDS.has(words[0].toLowerCase())) continue;
    // Need at least 2 meaningful words
    const meaningfulWords = words.filter((w) => w.length > 2 && !['de', 'du', 'des', 'von', 'van', 'le', 'la', 'di', 'el'].includes(w.toLowerCase()));
    if (meaningfulWords.length < 2) continue;
    if (!isOccupied(occupied, start, end)) {
      entities.push({ text: match[0].trim(), type: 'person', start, end });
      markOccupied(occupied, start, end);
    }
  }

  return entities.sort((a, b) => a.start - b.start);
}

function isOccupied(set: Set<number>, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (set.has(i)) return true;
  }
  return false;
}

function markOccupied(set: Set<number>, start: number, end: number): void {
  for (let i = start; i < end; i++) set.add(i);
}

/**
 * Apply NER highlights to an HTML string. Processes text nodes only
 * (doesn't corrupt tags or attributes).
 */
export function highlightEntitiesInHtml(html: string): string {
  // Parse using a simple approach: split on HTML tags, process text parts
  const parts = html.split(/(<[^>]+>)/);
  let insideCode = false;

  return parts
    .map((part) => {
      // Track <code> blocks — don't highlight inside them
      if (part.match(/^<code/i)) insideCode = true;
      if (part.match(/^<\/code/i)) insideCode = false;

      // Skip HTML tags and code blocks
      if (part.startsWith('<') || insideCode) return part;

      // Process text node
      const entities = detectEntities(part);
      if (entities.length === 0) return part;

      let result = '';
      let cursor = 0;
      for (const entity of entities) {
        result += part.slice(cursor, entity.start);
        result += `<mark class="ner ner--${entity.type}" title="${entity.type}">${escapeHtml(entity.text)}</mark>`;
        cursor = entity.end;
      }
      result += part.slice(cursor);
      return result;
    })
    .join('');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
