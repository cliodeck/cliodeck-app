import type { GraphData, GraphNode, TopicAnalysisResult } from './corpus-types';

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function dateSuffix(): string {
  return new Date().toISOString().split('T')[0];
}

export function exportTopicsAsJSON(
  topicAnalysis: TopicAnalysisResult,
  fullGraphData: GraphData | null
): void {
  const exportData = {
    exportDate: new Date().toISOString(),
    analysisDate: new Date().toISOString(),
    statistics: topicAnalysis.statistics || {},
    topics: topicAnalysis.topics.map((topic) => ({
      id: topic.id,
      keywords: topic.keywords,
      size: topic.size,
      documents: (fullGraphData?.nodes || [])
        .filter((node) => topicAnalysis.topicAssignments?.[node.id] === topic.id)
        .map((node) => ({
          id: node.id,
          title: node.metadata?.title || node.label,
          author: node.metadata?.author,
          year: node.metadata?.year,
        })),
    })),
    outliers: (topicAnalysis.outliers || []).map((docId) => {
      const node = fullGraphData?.nodes.find((n) => n.id === docId);
      return {
        id: docId,
        title: node?.metadata?.title || node?.label,
        author: node?.metadata?.author,
      };
    }),
  };

  downloadBlob(JSON.stringify(exportData, null, 2), `topics-export-${dateSuffix()}.json`, 'application/json');
}

export function exportTopicsAsCSV(
  topicAnalysis: TopicAnalysisResult,
  fullGraphData: GraphData | null
): void {
  let csv = 'Document_ID,Document_Title,Author,Year,Topic_ID,Topic_Keywords\n';
  const documentNodes = (fullGraphData?.nodes || []).filter((node) => node.type === 'document');

  documentNodes.forEach((node) => {
    const title = (node.metadata?.title || node.label).replace(/"/g, '""');
    const author = (node.metadata?.author || '').replace(/"/g, '""');
    const year = node.metadata?.year || '';
    const topicId = topicAnalysis.topicAssignments?.[node.id] ?? -1;

    let topicKeywords = '';
    if (topicId >= 0) {
      const topic = topicAnalysis.topics.find((t) => t.id === topicId);
      if (topic) topicKeywords = topic.keywords.join(';');
    } else {
      topicKeywords = 'OUTLIER';
    }

    csv += `"${node.id}","${title}","${author}","${year}",${topicId},"${topicKeywords}"\n`;
  });

  downloadBlob(csv, `topics-by-document-${dateSuffix()}.csv`, 'text/csv');
}

export function exportTopicsAsMarkdown(
  topicAnalysis: TopicAnalysisResult,
  fullGraphData: GraphData | null
): void {
  let md = `# Analyse Thématique - Export\n\n`;
  md += `**Date d'export:** ${new Date().toLocaleDateString()}\n`;
  md += `**Nombre de topics:** ${topicAnalysis.topics.length}\n\n`;
  md += `---\n\n`;

  topicAnalysis.topics.forEach((topic) => {
    md += `## Topic ${topic.id}\n\n`;
    md += `**Mots-clés:** ${topic.keywords.join(', ')}\n\n`;
    md += `**Taille:** ${topic.size} documents\n\n`;

    const topicDocs = (fullGraphData?.nodes || []).filter(
      (node) => topicAnalysis.topicAssignments?.[node.id] === topic.id
    );

    if (topicDocs.length > 0) {
      md += `**Documents:**\n\n`;
      topicDocs.forEach((node) => {
        const title = node.metadata?.title || node.label;
        const author = node.metadata?.author || '';
        const year = node.metadata?.year || '';
        md += `- ${title}${author ? ` (${author}` : ''}${year ? `, ${year})` : author ? ')' : ''}\n`;
      });
      md += `\n`;
    }
  });

  downloadBlob(md, `topics-export-${dateSuffix()}.md`, 'text/markdown');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportGraphAsGEXF(fullGraphData: GraphData): void {
  let gexf = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  gexf += `<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2">\n`;
  gexf += `  <meta lastmodifieddate="${dateSuffix()}">\n`;
  gexf += `    <creator>ClioDesk</creator>\n`;
  gexf += `    <description>Knowledge Graph Export</description>\n`;
  gexf += `  </meta>\n`;
  gexf += `  <graph mode="static" defaultedgetype="directed">\n`;
  gexf += `    <attributes class="node">\n`;
  gexf += `      <attribute id="0" title="type" type="string"/>\n`;
  gexf += `      <attribute id="1" title="title" type="string"/>\n`;
  gexf += `      <attribute id="2" title="author" type="string"/>\n`;
  gexf += `      <attribute id="3" title="year" type="string"/>\n`;
  gexf += `      <attribute id="4" title="pageCount" type="integer"/>\n`;
  gexf += `      <attribute id="5" title="centrality" type="float"/>\n`;
  gexf += `    </attributes>\n`;
  gexf += `    <attributes class="edge">\n`;
  gexf += `      <attribute id="0" title="type" type="string"/>\n`;
  gexf += `      <attribute id="1" title="weight" type="float"/>\n`;
  gexf += `    </attributes>\n`;

  gexf += `    <nodes>\n`;
  fullGraphData.nodes.forEach((node: GraphNode) => {
    gexf += `      <node id="${node.id}" label="${escapeXml(node.label || '')}">\n`;
    gexf += `        <attvalues>\n`;
    gexf += `          <attvalue for="0" value="${node.type}"/>\n`;
    gexf += `          <attvalue for="1" value="${escapeXml(node.metadata?.title || '')}"/>\n`;
    gexf += `          <attvalue for="2" value="${escapeXml(node.metadata?.author || '')}"/>\n`;
    gexf += `          <attvalue for="3" value="${node.metadata?.year || ''}"/>\n`;
    gexf += `          <attvalue for="4" value="${node.metadata?.pageCount || 0}"/>\n`;
    gexf += `          <attvalue for="5" value="${node.centrality || 0}"/>\n`;
    gexf += `        </attvalues>\n`;
    gexf += `      </node>\n`;
  });
  gexf += `    </nodes>\n`;

  gexf += `    <edges>\n`;
  fullGraphData.edges.forEach((edge, index) => {
    const sourceId = typeof edge.source === 'object' ? (edge.source as unknown as GraphNode).id : edge.source;
    const targetId = typeof edge.target === 'object' ? (edge.target as unknown as GraphNode).id : edge.target;
    gexf += `      <edge id="${index}" source="${sourceId}" target="${targetId}">\n`;
    gexf += `        <attvalues>\n`;
    gexf += `          <attvalue for="0" value="${edge.type}"/>\n`;
    gexf += `          <attvalue for="1" value="${edge.weight}"/>\n`;
    gexf += `        </attvalues>\n`;
    gexf += `      </edge>\n`;
  });
  gexf += `    </edges>\n`;

  gexf += `  </graph>\n`;
  gexf += `</gexf>`;

  downloadBlob(gexf, `knowledge-graph-${dateSuffix()}.gexf`, 'application/gexf+xml');
}
