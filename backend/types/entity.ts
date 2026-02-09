/**
 * Entity types for Named Entity Recognition (NER) in Graph RAG
 *
 * These types support the extraction and storage of named entities
 * from primary source documents (Tropy) for improved search relevance.
 */

// MARK: - Entity Types

export type EntityType = 'PERSON' | 'LOCATION' | 'DATE' | 'ORGANIZATION' | 'EVENT';

/**
 * Weights for entity types in search scoring
 * Higher weights boost relevance more strongly
 */
export const ENTITY_TYPE_WEIGHTS: Record<EntityType, number> = {
  PERSON: 1.5,       // Most important for historical documents
  EVENT: 1.4,        // Historical events are highly relevant
  DATE: 1.3,         // Temporal context is important
  LOCATION: 1.2,     // Geographic context
  ORGANIZATION: 1.1, // Institutions, groups
};

// MARK: - Entity Interfaces

/**
 * A unique entity in the knowledge graph
 */
export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  normalizedName: string;  // For deduplication (lowercase, no accents)
  aliases?: string[];      // Alternative names/spellings
  createdAt: string;
}

/**
 * A mention of an entity in a specific chunk
 */
export interface EntityMention {
  id: string;
  entityId: string;
  chunkId: string;
  sourceId: string;
  startPosition?: number;
  endPosition?: number;
  context: string;  // Sentence containing the entity
}

/**
 * A relationship between two entities (co-occurrence)
 */
export interface EntityRelation {
  entity1Id: string;
  entity2Id: string;
  relationType: 'co-occurrence' | 'mentioned-together';
  weight: number;          // Number of co-occurrences
  sourceIds: string[];     // Sources where they appear together
}

// MARK: - Extracted Entity (from NER)

/**
 * An entity extracted by the NER service (before deduplication)
 */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
  context: string;         // The sentence/phrase where it was found
  confidence?: number;     // Optional confidence score
  startPosition?: number;  // Position in the original text
  endPosition?: number;
}

// MARK: - NER Result

/**
 * Result of NER extraction on a text
 */
export interface NERExtractionResult {
  entities: ExtractedEntity[];
  processingTimeMs: number;
  modelUsed: string;
  textLength: number;
}

// MARK: - Search Types

/**
 * Configuration for entity-boosted search
 */
export interface EntitySearchConfig {
  enabled: boolean;
  hybridWeight: number;    // Weight for hybrid search score (default: 0.7)
  entityWeight: number;    // Weight for entity match score (default: 0.3)
  typeWeights: Record<EntityType, number>;  // Per-type boost weights
}

/**
 * Default search configuration
 */
export const DEFAULT_ENTITY_SEARCH_CONFIG: EntitySearchConfig = {
  enabled: true,
  hybridWeight: 0.7,
  entityWeight: 0.3,
  typeWeights: ENTITY_TYPE_WEIGHTS,
};

/**
 * Entity match information for a search result
 */
export interface EntityMatchInfo {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  matchScore: number;
  isExactMatch: boolean;
}

// MARK: - Statistics

/**
 * Statistics about entities in the knowledge graph
 */
export interface EntityStatistics {
  totalEntities: number;
  byType: Record<EntityType, number>;
  totalMentions: number;
  totalRelations: number;
  topEntities: Array<{
    entity: Entity;
    mentionCount: number;
  }>;
}
