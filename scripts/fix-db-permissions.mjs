#!/usr/bin/env node

/**
 * Script pour corriger les permissions des bases de données SQLite
 *
 * Usage: node scripts/fix-db-permissions.mjs [project-path]
 */

import { readdir, stat, chmod, access, constants } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

async function findCliodeckDirs(startPath) {
  const results = [];

  try {
    const entries = await readdir(startPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(startPath, entry.name);

      // Skip certain directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name === '.cliodeck') {
          results.push(fullPath);
        } else {
          // Recursively search (max depth 3 to avoid deep traversal)
          const depth = fullPath.split('/').length - startPath.split('/').length;
          if (depth < 3) {
            try {
              const subResults = await findCliodeckDirs(fullPath);
              results.push(...subResults);
            } catch (err) {
              // Permission denied or other error, skip
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error reading ${startPath}:`, err.message);
  }

  return results;
}

async function fixPermissions(cliodeckDir) {
  console.log(`\n🔍 Checking: ${cliodeckDir}`);

  try {
    // Fix directory permissions
    await chmod(cliodeckDir, 0o755);
    console.log(`✅ Fixed directory permissions: ${cliodeckDir}`);

    // Find and fix database files
    const entries = await readdir(cliodeckDir);

    for (const entry of entries) {
      if (entry.endsWith('.db') || entry.endsWith('.db-journal') || entry.endsWith('.db-wal')) {
        const dbPath = join(cliodeckDir, entry);

        try {
          // Check if file is readable/writable
          await access(dbPath, constants.R_OK | constants.W_OK);
          console.log(`  ℹ️  ${entry} already has correct permissions`);
        } catch (err) {
          // File is not readable/writable, fix it
          await chmod(dbPath, 0o644);
          console.log(`  ✅ Fixed file permissions: ${entry}`);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error fixing permissions for ${cliodeckDir}:`, err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let searchPath;

  if (args.length > 0) {
    searchPath = args[0];
  } else {
    // Search in user's home directory by default
    searchPath = homedir();
    console.log('No path specified, searching in home directory...');
  }

  console.log(`🔍 Searching for .cliodeck directories in: ${searchPath}\n`);

  const cliodeckDirs = await findCliodeckDirs(searchPath);

  if (cliodeckDirs.length === 0) {
    console.log('No .cliodeck directories found.');
    return;
  }

  console.log(`Found ${cliodeckDirs.length} .cliodeck directories:\n`);

  for (const dir of cliodeckDirs) {
    await fixPermissions(dir);
  }

  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
