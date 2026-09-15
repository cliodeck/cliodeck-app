#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

console.log('🔧 Fixing backend ES module issues...');

// Fix PDFIndexer imports - ajouter .js aux imports locaux
const pdfIndexerPath = 'dist/backend/core/pdf/PDFIndexer.js';
let indexerContent = readFileSync(pdfIndexerPath, 'utf-8');

// Corriger l'import de PDFExtractor
indexerContent = indexerContent.replace(
  /from ['"]\.\/PDFExtractor['"]/g,
  "from './PDFExtractor.js'"
);

writeFileSync(pdfIndexerPath, indexerContent);

// Fix HNSWVectorStore - convert default import to require for CommonJS module
const hnswStorePath = 'dist/backend/core/vector-store/HNSWVectorStore.js';
let hnswContent = readFileSync(hnswStorePath, 'utf-8');

// Replace ES6 import with createRequire for CommonJS module
hnswContent = hnswContent.replace(
  /import hnswlib from 'hnswlib-node';/,
  `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const hnswlib = require('hnswlib-node');`
);

writeFileSync(hnswStorePath, hnswContent);

console.log('✅ Backend ES module issues fixed');
