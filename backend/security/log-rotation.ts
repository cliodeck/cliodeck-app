/**
 * Log rotation for JSONL audit files (A21).
 *
 * On each call, reads the file line-by-line, drops entries older than TTL,
 * and rewrites the file in place. Optionally compresses the purged entries
 * to a timestamped `.gz` archive.
 *
 * Default TTL: 90 days. Configurable 30-365 via workspace config.
 */

import fs from 'fs';
import path from 'path';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export interface RotationOptions {
  /** TTL in days. Entries older than this are purged. Default: 90. */
  ttlDays?: number;
  /** Whether to archive purged entries to a .gz file. Default: true. */
  archive?: boolean;
}

const DEFAULT_TTL_DAYS = 90;

/**
 * Rotate a JSONL file: remove entries older than `ttlDays`, optionally
 * archiving them. Returns the number of purged entries.
 */
export async function rotateJsonlFile(
  filePath: string,
  options?: RotationOptions
): Promise<{ purged: number; kept: number }> {
  const ttlDays = options?.ttlDays ?? DEFAULT_TTL_DAYS;
  const shouldArchive = options?.archive ?? true;

  if (!fs.existsSync(filePath)) {
    return { purged: 0, kept: 0 };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ttlDays);
  const cutoffMs = cutoff.getTime();

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  const kept: string[] = [];
  const purged: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const at = entry.at || entry.timestamp || entry.createdAt;
      if (at && new Date(at).getTime() < cutoffMs) {
        purged.push(line);
      } else {
        kept.push(line);
      }
    } catch {
      // Malformed line — keep it to avoid silent data loss
      kept.push(line);
    }
  }

  if (purged.length === 0) {
    return { purged: 0, kept: kept.length };
  }

  // Archive purged entries if requested
  if (shouldArchive && purged.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = path.basename(filePath, '.jsonl');
    const archivePath = path.join(
      path.dirname(filePath),
      `${basename}.${timestamp}.purged.jsonl.gz`
    );
    const data = purged.join('\n') + '\n';
    const gzStream = createGzip();
    const outStream = fs.createWriteStream(archivePath);
    await pipeline(Readable.from(data), gzStream, outStream);
  }

  // Rewrite the file with only kept entries
  fs.writeFileSync(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');

  return { purged: purged.length, kept: kept.length };
}

/**
 * Rotate all audit JSONL files in a workspace v2 directory.
 */
export async function rotateWorkspaceAuditLogs(
  workspacePath: string,
  options?: RotationOptions
): Promise<{ mcpAccess: { purged: number; kept: number }; securityEvents: { purged: number; kept: number } }> {
  const mcpPath = path.join(workspacePath, '.cliodeck', 'v2', 'mcp-access.jsonl');
  const secPath = path.join(workspacePath, '.cliodeck', 'v2', 'security-events.jsonl');

  const [mcpAccess, securityEvents] = await Promise.all([
    rotateJsonlFile(mcpPath, options),
    rotateJsonlFile(secPath, options),
  ]);

  return { mcpAccess, securityEvents };
}
