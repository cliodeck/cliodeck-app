/**
 * EntityNormalizer - Normalizes entity names for deduplication
 *
 * Handles variations in entity names (case, accents, articles)
 * to ensure the same entity is recognized across different mentions.
 */

import type { EntityType } from '../../types/entity';

// French month names for date normalization
const FRENCH_MONTHS: Record<string, string> = {
  'janvier': '01',
  'février': '02',
  'fevrier': '02',
  'mars': '03',
  'avril': '04',
  'mai': '05',
  'juin': '06',
  'juillet': '07',
  'août': '08',
  'aout': '08',
  'septembre': '09',
  'octobre': '10',
  'novembre': '11',
  'décembre': '12',
  'decembre': '12',
};

// Roman numerals for century normalization
const ROMAN_NUMERALS: Record<string, number> = {
  'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5,
  'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10,
  'xi': 11, 'xii': 12, 'xiii': 13, 'xiv': 14, 'xv': 15,
  'xvi': 16, 'xvii': 17, 'xviii': 18, 'xix': 19, 'xx': 20,
  'xxi': 21,
};

export class EntityNormalizer {
  /**
   * Normalizes an entity name for deduplication
   * - Lowercase
   * - Remove accents
   * - Remove articles (le, la, les, l')
   * - Handle variations (De Gaulle = de Gaulle = DE GAULLE)
   */
  normalize(name: string, type: EntityType): string {
    if (!name || typeof name !== 'string') {
      return '';
    }

    let normalized = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // Remove accents
      .replace(/^(le |la |les |l'|l')/gi, '')  // Remove French articles
      .replace(/^(the |a |an )/gi, '')  // Remove English articles
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .trim();

    // Type-specific normalization
    switch (type) {
      case 'DATE':
        normalized = this.normalizeDateEntity(normalized);
        break;
      case 'PERSON':
        normalized = this.normalizePersonEntity(normalized);
        break;
      case 'LOCATION':
        normalized = this.normalizeLocationEntity(normalized);
        break;
      case 'ORGANIZATION':
        normalized = this.normalizeOrganizationEntity(normalized);
        break;
    }

    return normalized;
  }

  /**
   * Checks if two entities are probably the same
   */
  areSameEntity(a: string, b: string, type: EntityType): boolean {
    const normA = this.normalize(a, type);
    const normB = this.normalize(b, type);

    if (!normA || !normB) return false;

    // Exact match
    if (normA === normB) return true;

    // For persons, check if one name is contained in the other
    // e.g., "Gaulle" matches "Charles de Gaulle"
    if (type === 'PERSON') {
      return this.arePersonNamesSimilar(normA, normB);
    }

    // For locations, check for common abbreviations
    if (type === 'LOCATION') {
      return this.areLocationsSimilar(normA, normB);
    }

    // For dates, use the normalized format comparison
    if (type === 'DATE') {
      return normA === normB;
    }

    // For other types, check inclusion (must be a complete word)
    if (normA.length > 3 && normB.length > 3) {
      // Check if one is a word boundary match in the other
      const wordsA = normA.split(' ');
      const wordsB = normB.split(' ');

      // Check if all words of the shorter match the longer
      const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
      const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;

      return shorter.every(word => longer.includes(word));
    }

    return false;
  }

  /**
   * Normalizes a date entity
   * "18 juin 1940" -> "1940-06-18"
   * "XIXe siècle" -> "siecle-19"
   * "1914-1918" -> "1914-1918"
   */
  private normalizeDateEntity(date: string): string {
    // Handle century format (XIXe siècle, 19e siècle)
    const centuryMatch = date.match(/^(x{0,3}i{1,3}v?|i?x|v?i{0,3})[eè]?\s*si[eè]cle$/i) ||
                         date.match(/^(\d{1,2})[eè]?\s*si[eè]cle$/i);
    if (centuryMatch) {
      let century: number;
      if (centuryMatch[1].match(/^\d+$/)) {
        century = parseInt(centuryMatch[1], 10);
      } else {
        century = ROMAN_NUMERALS[centuryMatch[1].toLowerCase()] || 0;
      }
      if (century > 0) {
        return `siecle-${century}`;
      }
    }

    // Handle year range (1914-1918)
    const rangeMatch = date.match(/^(\d{4})\s*[-–]\s*(\d{4})$/);
    if (rangeMatch) {
      return `${rangeMatch[1]}-${rangeMatch[2]}`;
    }

    // Handle full date (18 juin 1940)
    const fullDateMatch = date.match(/^(\d{1,2})\s+([a-zéû]+)\s+(\d{4})$/i);
    if (fullDateMatch) {
      const day = fullDateMatch[1].padStart(2, '0');
      const monthName = fullDateMatch[2].toLowerCase();
      const month = FRENCH_MONTHS[monthName];
      const year = fullDateMatch[3];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // Handle month and year (juin 1940)
    const monthYearMatch = date.match(/^([a-zéû]+)\s+(\d{4})$/i);
    if (monthYearMatch) {
      const monthName = monthYearMatch[1].toLowerCase();
      const month = FRENCH_MONTHS[monthName];
      const year = monthYearMatch[2];
      if (month) {
        return `${year}-${month}`;
      }
    }

    // Handle just year
    const yearMatch = date.match(/^(\d{4})$/);
    if (yearMatch) {
      return yearMatch[1];
    }

    // Return as-is if no pattern matches
    return date;
  }

  /**
   * Normalizes a person name
   * Handles: "M. Dupont" -> "dupont"
   *          "Jean-Pierre" -> "jean-pierre"
   */
  private normalizePersonEntity(name: string): string {
    // Remove titles (M., Mme, Mlle, Dr., Prof., etc.)
    let normalized = name
      .replace(/^(m\.|mme|mlle|dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?|sir|lady)\s+/gi, '')
      .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/gi, '');

    // Keep hyphens in compound names (Jean-Pierre)
    // but normalize spacing
    normalized = normalized.replace(/\s+-\s+/g, '-');

    return normalized.trim();
  }

  /**
   * Normalizes a location name
   * Handles country/city variations
   */
  private normalizeLocationEntity(name: string): string {
    // Common country name variations
    const locationAliases: Record<string, string> = {
      'usa': 'etats-unis',
      'u.s.a.': 'etats-unis',
      'united states': 'etats-unis',
      'états-unis': 'etats-unis',
      'uk': 'royaume-uni',
      'u.k.': 'royaume-uni',
      'united kingdom': 'royaume-uni',
      'grande-bretagne': 'royaume-uni',
      'great britain': 'royaume-uni',
      'allemagne': 'allemagne',
      'germany': 'allemagne',
      'deutschland': 'allemagne',
    };

    const lower = name.toLowerCase();
    if (locationAliases[lower]) {
      return locationAliases[lower];
    }

    return name;
  }

  /**
   * Normalizes an organization name
   * Handles acronyms and full names
   */
  private normalizeOrganizationEntity(name: string): string {
    // Common organization aliases
    const orgAliases: Record<string, string> = {
      'onu': 'nations-unies',
      'un': 'nations-unies',
      'united nations': 'nations-unies',
      'nations unies': 'nations-unies',
      'otan': 'otan',
      'nato': 'otan',
      'ue': 'union-europeenne',
      'eu': 'union-europeenne',
      'european union': 'union-europeenne',
      'union europeenne': 'union-europeenne',
    };

    const lower = name.toLowerCase().replace(/[.']/g, '');
    if (orgAliases[lower]) {
      return orgAliases[lower];
    }

    return name;
  }

  /**
   * Checks if two person names are similar
   * Handles partial name matches (last name only, etc.)
   */
  private arePersonNamesSimilar(a: string, b: string): boolean {
    const partsA = a.split(/[\s-]+/).filter(p => p.length > 1);
    const partsB = b.split(/[\s-]+/).filter(p => p.length > 1);

    // If one is a single word (likely surname), check if it's in the other
    if (partsA.length === 1) {
      return partsB.includes(partsA[0]);
    }
    if (partsB.length === 1) {
      return partsA.includes(partsB[0]);
    }

    // Check if last names match (typically last word)
    const lastA = partsA[partsA.length - 1];
    const lastB = partsB[partsB.length - 1];

    if (lastA === lastB && lastA.length > 2) {
      // Last names match - could be same person
      // Check if first names also have some overlap or are initials
      const firstA = partsA[0];
      const firstB = partsB[0];

      if (firstA === firstB) return true;
      if (firstA.length === 1 || firstB.length === 1) {
        // One is an initial - check if it matches
        return firstA[0] === firstB[0];
      }
    }

    return false;
  }

  /**
   * Checks if two locations are similar
   * Handles common abbreviations and variations
   */
  private areLocationsSimilar(a: string, b: string): boolean {
    // Already normalized, so direct comparison should work
    // This handles cases where one is an abbreviation
    return a === b;
  }

  /**
   * Generates a unique key for an entity (for deduplication)
   */
  getEntityKey(name: string, type: EntityType): string {
    return `${type}:${this.normalize(name, type)}`;
  }
}

// Singleton instance
export const entityNormalizer = new EntityNormalizer();
