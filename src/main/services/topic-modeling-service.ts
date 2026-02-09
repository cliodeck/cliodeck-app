/**
 * Topic Modeling Service Singleton
 * Provides access to the TopicModelingService instance
 */
import { TopicModelingService } from '../../../backend/core/analysis/TopicModelingService.js';

export const topicModelingService = new TopicModelingService();
