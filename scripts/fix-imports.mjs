#!/usr/bin/env node

/**
 * tsc émet les specifiers relatifs tels qu'écrits en source (sans
 * extension, résolution « bundler »), mais Node en ESM exige un chemin de
 * fichier explicite. Ce script réécrit les imports du build main :
 *
 *  - `./foo`      → `./foo.js`
 *  - `./foo`      → `./foo/index.js`  quand `foo` est un DOSSIER
 *
 * La détection de dossier compte : `src/editor/**` (partagé avec le
 * renderer, qui lui résout à la Vite) contient des barils `index.ts`, et
 * un import de dossier fait échouer Electron au démarrage avec
 * ERR_UNSUPPORTED_DIR_IMPORT — panne invisible pour tsc et pour Vitest.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!existsSync(dirPath)) return arrayOfFiles;
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

// dist/src : le processus main importe désormais des modules partagés de
// src/editor (parseSlides pour l'export/preview des présentations).
const files = [...getAllFiles('dist/backend'), ...getAllFiles('dist/src')];

console.log(`🔧 Fixing imports in ${files.length} files...`);

let fixedCount = 0;

/** `./x` → `./x/index.js` si dossier, `./x.js` sinon. */
function resolveSpecifier(fileDir, importPath) {
  if (importPath.endsWith('.js') || importPath.endsWith('.json')) return null;
  const absolute = resolve(fileDir, importPath);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return `${importPath}/index.js`;
  }
  return `${importPath}.js`;
}

files.forEach((file) => {
  const fileDir = dirname(file);
  let content = readFileSync(file, 'utf-8');
  const originalContent = content;

  // `from '…'` (import et re-export) sur specifiers relatifs.
  content = content.replace(
    /from\s+['"](\.\.?[/\\][^'"]+)['"]/g,
    (match, importPath) => {
      const fixed = resolveSpecifier(fileDir, importPath);
      return fixed ? `from '${fixed}'` : match;
    }
  );

  // `import('…')` dynamiques.
  content = content.replace(
    /import\(\s*['"](\.\.?[/\\][^'"]+)['"]\s*\)/g,
    (match, importPath) => {
      const fixed = resolveSpecifier(fileDir, importPath);
      return fixed ? `import('${fixed}')` : match;
    }
  );

  if (content !== originalContent) {
    writeFileSync(file, content);
    fixedCount++;
  }
});

console.log(`✅ Fixed ${fixedCount} files`);
