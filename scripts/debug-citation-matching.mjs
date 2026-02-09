/**
 * Script pour déboguer le matching des citations
 */

import Database from 'better-sqlite3';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: node debug-citation-matching.mjs <path-to-vectors.db>');
  process.exit(1);
}

console.log(`📂 Analyzing citation matching issues in: ${dbPath}\n`);

try {
  const db = new Database(dbPath, { readonly: true });

  // 1. Check document metadata (author and year)
  console.log('📋 Document metadata check:\n');

  const docs = db.prepare(`
    SELECT
      id,
      title,
      author,
      year,
      metadata
    FROM documents
    LIMIT 20
  `).all();

  let docsWithAuthor = 0;
  let docsWithYear = 0;
  let docsWithBoth = 0;

  for (const doc of docs) {
    const hasAuthor = doc.author && doc.author.trim() !== '';
    const hasYear = doc.year && doc.year.trim() !== '';

    if (hasAuthor) docsWithAuthor++;
    if (hasYear) docsWithYear++;
    if (hasAuthor && hasYear) docsWithBoth++;

    console.log(`  ${hasAuthor && hasYear ? '✅' : '❌'} ${doc.title?.substring(0, 60) || 'Untitled'}`);
    console.log(`     Author: ${doc.author || 'NULL'}`);
    console.log(`     Year: ${doc.year || 'NULL'}`);

    // Parse metadata if available
    if (doc.metadata) {
      try {
        const meta = JSON.parse(doc.metadata);
        if (meta.author || meta.year) {
          console.log(`     Metadata author: ${meta.author || 'N/A'}`);
          console.log(`     Metadata year: ${meta.year || 'N/A'}`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    console.log('');
  }

  console.log(`\n📊 Summary (first 20 docs):`);
  console.log(`  Documents with author: ${docsWithAuthor}/20`);
  console.log(`  Documents with year: ${docsWithYear}/20`);
  console.log(`  Documents with BOTH: ${docsWithBoth}/20`);

  // 2. Sample citations and try to understand why they don't match
  console.log('\n\n🔍 Citation matching analysis:\n');

  const citations = db.prepare(`
    SELECT
      dc.target_citation,
      d.title as source_title,
      d.author as source_author,
      d.year as source_year
    FROM document_citations dc
    JOIN documents d ON dc.source_doc_id = d.id
    WHERE dc.target_doc_id IS NULL
    LIMIT 10
  `).all();

  console.log(`Sample of unmatched citations (${citations.length} shown):\n`);

  for (const cit of citations) {
    console.log(`  Citation: "${cit.target_citation}"`);
    console.log(`    From document: ${cit.source_title?.substring(0, 50)}`);
    console.log(`    Document author: ${cit.source_author || 'NULL'}`);
    console.log(`    Document year: ${cit.source_year || 'NULL'}`);

    // Try to extract author and year from citation text
    const authorMatch = cit.target_citation.match(/\(?\s*([A-Za-zÀ-ÿ\s&]+),?\s*(\d{4})/);
    if (authorMatch) {
      console.log(`    Extracted from citation: ${authorMatch[1].trim()} (${authorMatch[2]})`);
    }
    console.log('');
  }

  // 3. Check total stats
  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM documents').get();
  const docsWithMetadata = db.prepare(`
    SELECT COUNT(*) as count
    FROM documents
    WHERE author IS NOT NULL AND author != ''
      AND year IS NOT NULL AND year != ''
  `).get();

  console.log(`\n📈 Overall statistics:`);
  console.log(`  Total documents: ${totalDocs.count}`);
  console.log(`  Documents with author AND year: ${docsWithMetadata.count} (${Math.round(docsWithMetadata.count / totalDocs.count * 100)}%)`);
  console.log(`  Documents missing metadata: ${totalDocs.count - docsWithMetadata.count}`);

  const totalCitations = db.prepare('SELECT COUNT(*) as count FROM document_citations').get();
  const matchedCitations = db.prepare('SELECT COUNT(*) as count FROM document_citations WHERE target_doc_id IS NOT NULL').get();

  console.log(`\n  Total citations: ${totalCitations.count}`);
  console.log(`  Matched citations: ${matchedCitations.count} (${Math.round(matchedCitations.count / totalCitations.count * 100)}%)`);
  console.log(`  Unmatched citations: ${totalCitations.count - matchedCitations.count}`);

  db.close();

  console.log('\n\n💡 Conclusion:');
  if (docsWithMetadata.count < totalDocs.count * 0.5) {
    console.log('❌ PROBLEM: Most documents are missing author/year metadata!');
    console.log('   → Citations cannot be matched without document metadata');
    console.log('   → Need to extract author/year from PDF metadata or filenames');
  } else if (matchedCitations.count === 0) {
    console.log('❌ PROBLEM: No citations are being matched despite having metadata!');
    console.log('   → Check the matching algorithm');
    console.log('   → Author name normalization might be too strict');
  } else {
    console.log('✅ Some citations are being matched successfully');
  }

} catch (error) {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
