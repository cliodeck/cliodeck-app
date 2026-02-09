/**
 * Script pour inspecter les citations dans la base de données
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: node inspect-citations.mjs <path-to-vectors.db>');
  process.exit(1);
}

console.log(`📂 Inspecting database: ${dbPath}\n`);

try {
  const db = new Database(dbPath, { readonly: true });

  // 1. Count total documents
  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM documents').get();
  console.log(`📄 Total documents: ${totalDocs.count}`);

  // 2. Count document_citations entries
  const totalCitations = db.prepare('SELECT COUNT(*) as count FROM document_citations').get();
  console.log(`🔗 Total citation records: ${totalCitations.count}\n`);

  // 3. Check citations_extracted field
  console.log('📊 Citations per document:');
  const docs = db.prepare(`
    SELECT
      id,
      title,
      citations_extracted,
      LENGTH(citations_extracted) as data_size
    FROM documents
    LIMIT 10
  `).all();

  for (const doc of docs) {
    console.log(`\n  Document: ${doc.title}`);
    console.log(`    ID: ${doc.id}`);
    console.log(`    Data size: ${doc.data_size || 0} bytes`);

    if (doc.citations_extracted) {
      try {
        const citations = JSON.parse(doc.citations_extracted);
        console.log(`    ✅ Citations count: ${citations.length}`);

        if (citations.length > 0) {
          console.log(`    First citation example:`);
          console.log(`      Text: ${citations[0].text}`);
          console.log(`      Author: ${citations[0].author || 'N/A'}`);
          console.log(`      Year: ${citations[0].year || 'N/A'}`);
        }
      } catch (e) {
        console.log(`    ❌ Error parsing citations: ${e.message}`);
      }
    } else {
      console.log(`    ⚠️ No citations_extracted data`);
    }
  }

  // 4. Sample document_citations table
  console.log('\n\n📋 Sample citation relationships:');
  const citationRelations = db.prepare(`
    SELECT
      dc.id,
      dc.source_doc_id,
      dc.target_citation,
      dc.target_doc_id,
      d1.title as source_title,
      d2.title as target_title
    FROM document_citations dc
    LEFT JOIN documents d1 ON dc.source_doc_id = d1.id
    LEFT JOIN documents d2 ON dc.target_doc_id = d2.id
    LIMIT 10
  `).all();

  if (citationRelations.length === 0) {
    console.log('  ⚠️ No citation relationships found');
  } else {
    for (const rel of citationRelations) {
      console.log(`\n  Citation: "${rel.target_citation}"`);
      console.log(`    From: ${rel.source_title || 'Unknown'}`);
      console.log(`    To: ${rel.target_title || 'Unmatched'}`);
      console.log(`    Target ID: ${rel.target_doc_id || 'NULL'}`);
    }
  }

  db.close();
  console.log('\n✅ Inspection complete');

} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
