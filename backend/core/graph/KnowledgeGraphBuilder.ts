/**
 * KnowledgeGraphBuilder - Constructs the knowledge graph from multiple sources
 *
 * Combines:
 * - Entity co-occurrences from documents
 * - Wikilinks from Obsidian vault
 * - Tags as concept nodes
 * - Document similarity edges
 *
 * Uses graphology for graph operations and Louvain for community detection.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { VectorStore } from '../vector-store/VectorStore.js';
import type { GraphData, GraphNode, GraphEdge, EntityType } from '../../types/entity.js';

export class KnowledgeGraphBuilder {
  private vectorStore: VectorStore;

  constructor(vectorStore: VectorStore) {
    this.vectorStore = vectorStore;
  }

  /**
   * Build the complete knowledge graph
   */
  build(options?: {
    includeDocuments?: boolean;
    includeEntities?: boolean;
    includeVaultLinks?: boolean;
    includeTags?: boolean;
    similarityThreshold?: number;
    /** Minimum number of mentions for an entity to appear (default: 2) */
    minMentions?: number;
    /** Minimum co-occurrence weight for an edge (default: 2) */
    minCoOccurrence?: number;
    /** Maximum number of entity nodes (default: 150, by mention count) */
    maxEntities?: number;
  }): GraphData {
    const graph = new Graph({ multi: false, type: 'undirected' });
    const opts = {
      includeDocuments: true,
      includeEntities: true,
      includeVaultLinks: true,
      includeTags: true,
      similarityThreshold: 0.3,
      minMentions: 2,
      minCoOccurrence: 3,
      maxEntities: 100,
      ...options,
    };

    const t0 = Date.now();

    // 1. Add document nodes
    if (opts.includeDocuments) {
      this.addDocumentNodes(graph);
      console.error(`[KnowledgeGraph] Step 1 — Documents: ${graph.order} nodes (${Date.now() - t0}ms)`);
    }

    // 2. Add entity nodes and co-occurrence edges
    if (opts.includeEntities) {
      const beforeEntities = graph.order;
      this.addEntityNodes(graph, opts.minMentions, opts.maxEntities);
      const entityNodes = graph.order - beforeEntities;
      const beforeEdges = graph.size;
      this.addCoOccurrenceEdges(graph, opts.minCoOccurrence);
      const cooccurEdges = graph.size - beforeEdges;
      console.error(`[KnowledgeGraph] Step 2 — Entities: +${entityNodes} nodes, +${graph.size - beforeEdges + (graph.size - beforeEdges - cooccurEdges)} mention edges, +${cooccurEdges} co-occurrence edges (${Date.now() - t0}ms)`);
    }

    // 3. Add vault wikilink edges
    if (opts.includeVaultLinks) {
      const before = graph.size;
      this.addVaultLinkEdges(graph);
      console.error(`[KnowledgeGraph] Step 3 — Wikilinks: +${graph.size - before} edges (${Date.now() - t0}ms)`);
    }

    // 4. Add tag concept nodes
    if (opts.includeTags) {
      const beforeNodes = graph.order;
      const beforeEdges = graph.size;
      this.addTagNodes(graph);
      console.error(`[KnowledgeGraph] Step 4 — Tags: +${graph.order - beforeNodes} nodes, +${graph.size - beforeEdges} edges (${Date.now() - t0}ms)`);
    }

    console.error(`[KnowledgeGraph] Pre-Louvain: ${graph.order} nodes, ${graph.size} edges (${Date.now() - t0}ms)`);

    // 5. Community detection (if enough nodes)
    let communities: Record<string, number> = {};
    if (graph.order >= 3) {
      try {
        const louvainStart = Date.now();
        communities = louvain(graph);
        console.error(`[KnowledgeGraph] Step 5 — Louvain: ${Object.keys(communities).length} assignments, ${new Set(Object.values(communities)).size} communities (${Date.now() - louvainStart}ms)`);
        // Assign community to nodes
        for (const [nodeId, community] of Object.entries(communities)) {
          if (graph.hasNode(nodeId)) {
            graph.setNodeAttribute(nodeId, 'community', community);
          }
        }
      } catch (e) {
        // Louvain can fail on disconnected or trivial graphs — non-critical
        console.error('[KnowledgeGraph] Louvain community detection failed:', e);
      }
    }

    // Convert to output format
    const result = this.graphToData(graph, communities);
    console.error(`[KnowledgeGraph] Done: ${result.nodes.length} nodes, ${result.edges.length} edges, total ${Date.now() - t0}ms`);
    return result;
  }

  /**
   * Get statistics about the graph
   */
  getStatistics(): { entities: number; relations: number; communities: number; documents: number } {
    const data = this.build();
    const communitySet = new Set(data.nodes.map(n => n.community).filter(c => c !== undefined));

    return {
      entities: data.nodes.filter(n => n.type === 'entity').length,
      relations: data.edges.length,
      communities: communitySet.size,
      documents: data.nodes.filter(n => n.type === 'document' || n.type === 'note').length,
    };
  }

  // ── Node builders ─────────────────────────────────────────────

  private addDocumentNodes(graph: Graph): void {
    const docs = this.vectorStore.getAllDocuments();
    for (const doc of docs) {
      const nodeId = `doc:${doc.id}`;
      if (!graph.hasNode(nodeId)) {
        graph.addNode(nodeId, {
          label: doc.title,
          type: doc.sourceType === 'obsidian-note' ? 'note' : 'document',
          metadata: { author: doc.author, year: doc.year, sourceType: doc.sourceType },
          size: 3,
        });
      }
    }
  }

  private addEntityNodes(graph: Graph, minMentions: number, maxEntities: number): void {
    // Only include entities with enough mentions, ranked by mention count
    const rows = this.vectorStore.database.prepare(`
      SELECT e.*, COUNT(em.id) as mention_count
      FROM entities e
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      GROUP BY e.id
      HAVING mention_count >= ?
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(minMentions, maxEntities) as any[];

    for (const row of rows) {
      const nodeId = `entity:${row.id}`;
      if (!graph.hasNode(nodeId)) {
        // Scale node size by mention count (min 2, max 8)
        const size = Math.min(8, 2 + Math.log2(row.mention_count));
        graph.addNode(nodeId, {
          label: row.name,
          type: 'entity',
          entityType: row.type,
          size,
        });
      }

      // Link entity to documents via mentions
      const mentions = this.vectorStore.database.prepare(
        'SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = ?'
      ).all(row.id) as any[];

      for (const mention of mentions) {
        const docNodeId = `doc:${mention.document_id}`;
        if (graph.hasNode(docNodeId)) {
          const edgeKey = `mention:${row.id}:${mention.document_id}`;
          if (!graph.hasEdge(edgeKey)) {
            try {
              graph.addEdgeWithKey(edgeKey, nodeId, docNodeId, {
                type: 'mention',
                weight: 1,
              });
            } catch {
              // Edge may already exist — safe to ignore
            }
          }
        }
      }
    }
  }

  private addCoOccurrenceEdges(graph: Graph, minWeight: number): void {
    // Find entities that co-occur in the same chunk, filtered by minimum weight
    const coOccurrences = this.vectorStore.database.prepare(`
      SELECT em1.entity_id as e1, em2.entity_id as e2, COUNT(*) as weight
      FROM entity_mentions em1
      JOIN entity_mentions em2 ON em1.chunk_id = em2.chunk_id AND em1.entity_id < em2.entity_id
      GROUP BY em1.entity_id, em2.entity_id
      HAVING weight >= ?
    `).all(minWeight) as any[];

    for (const row of coOccurrences) {
      const node1 = `entity:${row.e1}`;
      const node2 = `entity:${row.e2}`;
      if (graph.hasNode(node1) && graph.hasNode(node2)) {
        const edgeKey = `cooccur:${row.e1}:${row.e2}`;
        if (!graph.hasEdge(edgeKey)) {
          try {
            graph.addEdgeWithKey(edgeKey, node1, node2, {
              type: 'co-occurrence',
              weight: row.weight,
            });
          } catch {
            // Edge may already exist in the graph — safe to ignore duplicate insertion
          }
        }
      }
    }
  }

  private addVaultLinkEdges(graph: Graph): void {
    const links = this.vectorStore.database.prepare(`
      SELECT vl.source_note_id, vl.target_relative_path, vn_target.id as target_note_id
      FROM vault_links vl
      LEFT JOIN vault_notes vn_target ON (
        vl.target_relative_path = REPLACE(vn_target.relative_path, '.md', '')
        OR vl.target_relative_path || '.md' = vn_target.relative_path
        OR vl.target_relative_path = vn_target.title
      )
    `).all() as any[];

    for (const link of links) {
      if (!link.target_note_id) continue;

      const sourceNodeId = `doc:${link.source_note_id}`;
      const targetNodeId = `doc:${link.target_note_id}`;

      if (graph.hasNode(sourceNodeId) && graph.hasNode(targetNodeId)) {
        const edgeKey = `wikilink:${link.source_note_id}:${link.target_note_id}`;
        if (!graph.hasEdge(edgeKey)) {
          try {
            graph.addEdgeWithKey(edgeKey, sourceNodeId, targetNodeId, {
              type: 'link',
              weight: 1,
            });
          } catch {
            // Edge may already exist in the graph — safe to ignore duplicate insertion
          }
        }
      }
    }
  }

  private addTagNodes(graph: Graph): void {
    const tagRows = this.vectorStore.database.prepare(`
      SELECT id, tags_json FROM vault_notes WHERE tags_json IS NOT NULL
    `).all() as any[];

    for (const row of tagRows) {
      let tags: string[];
      try {
        tags = JSON.parse(row.tags_json);
      } catch {
        // Malformed tags_json in DB row — skip this note's tags
        continue;
      }
      if (!tags || tags.length === 0) continue;

      const docNodeId = `doc:${row.id}`;

      for (const tag of tags) {
        const tagNodeId = `tag:${tag}`;
        if (!graph.hasNode(tagNodeId)) {
          graph.addNode(tagNodeId, {
            label: `#${tag}`,
            type: 'entity',
            entityType: 'CONCEPT',
            size: 1.5,
          });
        }

        if (graph.hasNode(docNodeId)) {
          const edgeKey = `tag:${row.id}:${tag}`;
          if (!graph.hasEdge(edgeKey)) {
            try {
              graph.addEdgeWithKey(edgeKey, docNodeId, tagNodeId, {
                type: 'mention',
                weight: 1,
              });
            } catch {
              // Edge may already exist in the graph — safe to ignore duplicate insertion
            }
          }
        }
      }
    }
  }

  // ── Conversion ────────────────────────────────────────────────

  private graphToData(graph: Graph, communities: Record<string, number>): GraphData {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    graph.forEachNode((nodeId, attrs) => {
      nodes.push({
        id: nodeId,
        label: attrs.label || nodeId,
        type: attrs.type || 'entity',
        entityType: attrs.entityType,
        community: attrs.community ?? communities[nodeId],
        size: attrs.size || 2,
        metadata: attrs.metadata,
      });
    });

    graph.forEachEdge((_edgeKey, attrs, source, target) => {
      edges.push({
        source,
        target,
        type: attrs.type || 'co-occurrence',
        weight: attrs.weight || 1,
      });
    });

    return { nodes, edges, communities };
  }
}
