#!/usr/bin/env node
/**
 * Script de diagnostic pour le système RAG
 * Vérifie: Ollama, base de données vectorielle, embeddings, configuration
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(level, message, data = null) {
  const prefix = {
    info: `${colors.blue}ℹ${colors.reset}`,
    success: `${colors.green}✓${colors.reset}`,
    error: `${colors.red}✗${colors.reset}`,
    warn: `${colors.yellow}⚠${colors.reset}`,
  }[level];

  console.log(`${prefix} ${message}`);
  if (data) {
    console.log(`  ${colors.cyan}→${colors.reset}`, JSON.stringify(data, null, 2));
  }
}

async function checkOllama(url = 'http://localhost:11434') {
  log('info', `Checking Ollama at ${url}...`);

  try {
    const response = await fetch(`${url}/api/tags`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = data.models || [];

    log('success', `Ollama is running (${models.length} models installed)`);

    const embeddingModels = models.filter(m =>
      m.name.includes('embed') || m.name.includes('nomic')
    );
    const chatModels = models.filter(m =>
      m.name.includes('gemma') || m.name.includes('llama') || m.name.includes('mistral')
    );

    if (embeddingModels.length > 0) {
      log('success', `Embedding models: ${embeddingModels.map(m => m.name).join(', ')}`);
    } else {
      log('error', 'No embedding models found!');
    }

    if (chatModels.length > 0) {
      log('success', `Chat models: ${chatModels.map(m => m.name).join(', ')}`);
    } else {
      log('error', 'No chat models found!');
    }

    return true;
  } catch (error) {
    log('error', `Ollama not accessible: ${error.message}`);
    return false;
  }
}

function findProjectDatabases() {
  log('info', 'Looking for project databases...');

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const documentsPath = join(homeDir, 'Documents', 'GitHub', 'cliodeck');

  const databases = [];

  // Rechercher récursivement les fichiers vectors.db
  function searchDir(dir, depth = 0) {
    if (depth > 5) return; // Limite de profondeur

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory() && entry.name === '.cliodeck') {
          const dbPath = join(fullPath, 'vectors.db');
          if (fs.existsSync(dbPath)) {
            databases.push({
              path: dbPath,
              project: dir,
            });
          }
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          searchDir(fullPath, depth + 1);
        }
      }
    } catch (error) {
      // Ignore permission errors
    }
  }

  // Chercher dans le répertoire courant
  const cwd = process.cwd();
  searchDir(cwd);

  // Chercher dans ~/Documents si disponible
  if (fs.existsSync(documentsPath)) {
    searchDir(documentsPath);
  }

  log('success', `Found ${databases.length} project database(s)`);
  databases.forEach(db => {
    console.log(`  ${colors.cyan}→${colors.reset} ${db.project}`);
  });

  return databases;
}

function analyzeDatabase(dbPath) {
  log('info', `Analyzing database: ${dbPath}`);

  try {
    const db = new Database(dbPath, { readonly: true });

    // Vérifier les tables
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all();

    log('success', `Tables: ${tables.map(t => t.name).join(', ')}`);

    // Statistiques des documents
    const docStats = db.prepare(`
      SELECT COUNT(*) as count FROM documents
    `).get();

    log('info', `Total documents: ${docStats.count}`);

    if (docStats.count === 0) {
      log('error', 'No documents indexed! You need to index PDFs first.');
      db.close();
      return;
    }

    // Statistiques des chunks
    const chunkStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_embedding
      FROM chunks
    `).get();

    log('info', `Total chunks: ${chunkStats.total}`);
    log('info', `Chunks with embeddings: ${chunkStats.with_embedding}`);

    if (chunkStats.with_embedding === 0) {
      log('error', 'No embeddings generated! This is the problem.');
      log('warn', 'Possible causes:');
      console.log('    - Ollama was not running during indexing');
      console.log('    - Embedding model not available');
      console.log('    - Indexing failed silently');
    } else if (chunkStats.with_embedding < chunkStats.total) {
      log('warn', `Only ${chunkStats.with_embedding}/${chunkStats.total} chunks have embeddings`);
    } else {
      log('success', 'All chunks have embeddings ✓');
    }

    // Vérifier la taille des embeddings
    const embeddingSample = db.prepare(`
      SELECT LENGTH(embedding) as size
      FROM chunks
      WHERE embedding IS NOT NULL
      LIMIT 1
    `).get();

    if (embeddingSample) {
      // Float32Array: 4 bytes per dimension
      const dimensions = embeddingSample.size / 4;
      log('info', `Embedding dimensions: ${dimensions}`);

      if (dimensions !== 768 && dimensions !== 384) {
        log('warn', `Unexpected embedding size (expected 768 or 384, got ${dimensions})`);
      }
    }

    // Vérifier les résumés
    const summaryStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN summary IS NOT NULL THEN 1 ELSE 0 END) as with_summary
      FROM documents
    `).get();

    log('info', `Documents with summaries: ${summaryStats.with_summary}/${summaryStats.total}`);

    // Lister quelques documents
    const sampleDocs = db.prepare(`
      SELECT id, title, author, year
      FROM documents
      LIMIT 5
    `).all();

    if (sampleDocs.length > 0) {
      console.log(`\n${colors.cyan}Sample documents:${colors.reset}`);
      sampleDocs.forEach(doc => {
        console.log(`  - ${doc.title || 'Untitled'} (${doc.author || 'Unknown'}, ${doc.year || 'N/A'})`);
      });
    }

    db.close();

    // Résumé du diagnostic
    console.log(`\n${colors.cyan}=== DIAGNOSTIC SUMMARY ===${colors.reset}`);
    if (chunkStats.with_embedding === 0) {
      log('error', 'PROBLEM FOUND: No embeddings in database');
      console.log('\nSolution: Re-index your PDFs with Ollama running');
    } else if (chunkStats.with_embedding < chunkStats.total) {
      log('warn', 'PROBLEM FOUND: Partial embeddings');
      console.log('\nSolution: Re-index incomplete documents');
    } else {
      log('success', 'Database looks healthy!');
      console.log('\nIf RAG still doesn\'t work, check:');
      console.log('  1. Ollama is running when you send chat messages');
      console.log('  2. Console logs for errors during chat');
      console.log('  3. Project is properly loaded in the app');
    }

  } catch (error) {
    log('error', `Failed to analyze database: ${error.message}`);
  }
}

async function testEmbeddingGeneration(url = 'http://localhost:11434') {
  log('info', 'Testing embedding generation...');

  try {
    const response = await fetch(`${url}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nomic-embed-text',
        prompt: 'This is a test sentence for embedding generation.',
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.embedding && Array.isArray(data.embedding)) {
      log('success', `Embedding generated successfully (${data.embedding.length} dimensions)`);
      return true;
    } else {
      log('error', 'Invalid embedding response');
      return false;
    }
  } catch (error) {
    log('error', `Failed to generate embedding: ${error.message}`);
    return false;
  }
}

// Main
async function main() {
  console.log(`${colors.cyan}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║   ClioDesk RAG Diagnostic Tool        ║${colors.reset}`);
  console.log(`${colors.cyan}╚═══════════════════════════════════════╝${colors.reset}\n`);

  // Check if specific DB path provided as argument
  const dbPath = process.argv[2];
  if (dbPath) {
    if (!fs.existsSync(dbPath)) {
      log('error', `Database not found: ${dbPath}`);
      process.exit(1);
    }

    console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}Analyzing: ${dbPath}${colors.reset}`);
    console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}\n`);
    analyzeDatabase(dbPath);
    return;
  }

  // 1. Check Ollama
  const ollamaOk = await checkOllama();
  console.log('');

  if (ollamaOk) {
    // 2. Test embedding generation
    await testEmbeddingGeneration();
    console.log('');
  }

  // 3. Find and analyze databases
  const databases = findProjectDatabases();
  console.log('');

  if (databases.length === 0) {
    log('error', 'No project databases found!');
    log('info', 'Make sure you have created a project and indexed some PDFs.');
    return;
  }

  // Analyze each database
  for (const db of databases) {
    console.log(`\n${colors.cyan}═══════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}Project: ${db.project}${colors.reset}`);
    console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}\n`);
    analyzeDatabase(db.path);
  }
}

main().catch(error => {
  log('error', `Fatal error: ${error.message}`);
  process.exit(1);
});
