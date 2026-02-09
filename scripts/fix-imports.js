#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import path from 'path';

// Trouve tous les fichiers .js dans dist/backend
const files = glob.sync('dist/backend/**/*.js');

console.log(`🔧 Fixing imports in ${files.length} files...`);

let fixedCount = 0;

files.forEach((file) => {
  let content = readFileSync(file, 'utf-8');
  const originalContent = content;

  // Remplacer les imports relatifs sans extension par des imports avec .js
  // Pattern: from './something' ou from '../something'
  content = content.replace(
    /from\s+['"](\.\.[\/\\][^'"]+)['"]/g,
    (match, importPath) => {
      if (!importPath.endsWith('.js')) {
        return `from '${importPath}.js'`;
      }
      return match;
    }
  );

  content = content.replace(
    /from\s+['"](\.[\/\\][^'"]+)['"]/g,
    (match, importPath) => {
      if (!importPath.endsWith('.js')) {
        return `from '${importPath}.js'`;
      }
      return match;
    }
  );

  if (content !== originalContent) {
    writeFileSync(file, content);
    fixedCount++;
  }
});

console.log(`✅ Fixed ${fixedCount} files`);
