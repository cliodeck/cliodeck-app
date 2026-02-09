/**
 * EntityNormalizer - Normalizes entity names for deduplication
 *
 * Handles variations in entity names (case, accents, articles)
 * to ensure the same entity is recognized across different mentions.
 */
import type { EntityType } from '../../types/entity';
export declare class EntityNormalizer {
    /**
     * Normalizes an entity name for deduplication
     * - Lowercase
     * - Remove accents
     * - Remove articles (le, la, les, l')
     * - Handle variations (De Gaulle = de Gaulle = DE GAULLE)
     */
    normalize(name: string, type: EntityType): string;
    /**
     * Checks if two entities are probably the same
     */
    areSameEntity(a: string, b: string, type: EntityType): boolean;
    /**
     * Normalizes a date entity
     * "18 juin 1940" -> "1940-06-18"
     * "XIXe siècle" -> "siecle-19"
     * "1914-1918" -> "1914-1918"
     */
    private normalizeDateEntity;
    /**
     * Normalizes a person name
     * Handles: "M. Dupont" -> "dupont"
     *          "Jean-Pierre" -> "jean-pierre"
     */
    private normalizePersonEntity;
    /**
     * Normalizes a location name
     * Handles country/city variations
     */
    private normalizeLocationEntity;
    /**
     * Normalizes an organization name
     * Handles acronyms and full names
     */
    private normalizeOrganizationEntity;
    /**
     * Checks if two person names are similar
     * Handles partial name matches (last name only, etc.)
     */
    private arePersonNamesSimilar;
    /**
     * Checks if two locations are similar
     * Handles common abbreviations and variations
     */
    private areLocationsSimilar;
    /**
     * Generates a unique key for an entity (for deduplication)
     */
    getEntityKey(name: string, type: EntityType): string;
}
export declare const entityNormalizer: EntityNormalizer;
