#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = readdirSync(dirPath);

  files.forEach((file) => {
    const filePath = join(dirPath, file);
    if (statSync(filePath).isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
    } else if (file.endsWith('.js')) {
      arrayOfFiles.push(filePath);
    }
  });

  return arrayOfFiles;
}

const files = getAllFiles('dist/backend');

console.log(`🔧 Fixing imports in ${files.length} files...`);

let fixedCount = 0;

files.forEach((file) => {
  let content = readFileSync(file, 'utf-8');
  const originalContent = content;

  // Remplacer les imports relatifs sans extension par des imports avec .js
  content = content.replace(
    /from\s+['"](\.\.[\/\\][^'"]+)['"]/g,
    (match, importPath) => {
      if (!importPath.endsWith('.js') && !importPath.endsWith('.json')) {
        return `from '${importPath}.js'`;
      }
      return match;
    }
  );

  content = content.replace(
    /from\s+['"](\.[\/\\][^'"]+)['"]/g,
    (match, importPath) => {
      if (!importPath.endsWith('.js') && !importPath.endsWith('.json')) {
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
