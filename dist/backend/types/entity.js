/**
 * Entity types for Named Entity Recognition (NER) in Graph RAG
 *
 * These types support the extraction and storage of named entities
 * from primary source documents (Tropy) for improved search relevance.
 */
/**
 * Weights for entity types in search scoring
 * Higher weights boost relevance more strongly
 */
export const ENTITY_TYPE_WEIGHTS = {
    PERSON: 1.5, // Most important for historical documents
    EVENT: 1.4, // Historical events are highly relevant
    DATE: 1.3, // Temporal context is important
    LOCATION: 1.2, // Geographic context
    ORGANIZATION: 1.1, // Institutions, groups
};
/**
 * Default search configuration
 */
export const DEFAULT_ENTITY_SEARCH_CONFIG = {
    enabled: true,
    hybridWeight: 0.7,
    entityWeight: 0.3,
    typeWeights: ENTITY_TYPE_WEIGHTS,
};
