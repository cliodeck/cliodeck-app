/**
 * Typed vault scan report (fusion step 2.1bis, claw-code lesson 6.3 —
 * *partial success first-class*).
 *
 * A real Obsidian vault always contains notes that can't be cleanly indexed:
 * broken frontmatter, binary files mislabeled as .md, empty notes, wikilinks
 * pointing at deleted targets. The scan must never return a single boolean —
 * consumers (UI badges, recipes, diagnostics) need to see *what* was kept,
 * *what* was skipped, and *why*. The `SkipReason` union is discriminated so
 * exhaustiveness checking across the app is type-safe.
 *
 * The same shape is reusable for Zotero / Tropy scans (plan: "Appliquer le
 * même pattern à Zotero et Tropy"). Live here for now; lift to a shared
 * `integrations/scan-report.ts` when the Zotero/Tropy variants land.
 */

import type { VaultFileEntry, ParsedVaultNote } from '../../types/vault.js';

export type NoteRef = Pick<
  VaultFileEntry,
  'relativePath' | 'absolutePath' | 'fileName'
>;

export type SkipReason =
  | { kind: 'hidden_file'; detail?: string }
  | { kind: 'empty_note' }
  | { kind: 'binary_content'; detail: string }
  | { kind: 'frontmatter_parse_error'; message: string }
  | { kind: 'oversized'; sizeBytes: number; limit: number }
  | { kind: 'ignored_by_pattern'; pattern: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'broken_wikilinks_only'; count: number };

export type FailureReason =
  | { kind: 'io_error'; message: string }
  | { kind: 'parser_crash'; message: string };

export interface IndexedNote {
  ref: NoteRef;
  parsed: ParsedVaultNote;
}

export interface SkippedNote {
  ref: NoteRef;
  reason: SkipReason;
}

export interface FailedNote {
  ref: NoteRef;
  reason: FailureReason;
}

export interface VaultScanReport {
  vaultPath: string;
  startedAt: string;
  completedAt: string;
  indexed: IndexedNote[];
  skipped: SkippedNote[];
  failed: FailedNote[];
  stats: {
    totalFound: number;
    indexedCount: number;
    skippedCount: number;
    failedCount: number;
  };
}

export function emptyReport(vaultPath: string): VaultScanReport {
  const now = new Date().toISOString();
  return {
    vaultPath,
    startedAt: now,
    completedAt: now,
    indexed: [],
    skipped: [],
    failed: [],
    stats: { totalFound: 0, indexedCount: 0, skippedCount: 0, failedCount: 0 },
  };
}

export function finalizeReport(report: VaultScanReport): VaultScanReport {
  return {
    ...report,
    completedAt: new Date().toISOString(),
    stats: {
      totalFound:
        report.indexed.length + report.skipped.length + report.failed.length,
      indexedCount: report.indexed.length,
      skippedCount: report.skipped.length,
      failedCount: report.failed.length,
    },
  };
}

/**
 * Exhaustive narrowing helper: call from a `switch` over `SkipReason.kind`
 * to get a compile-time error when a new variant is added without handling.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}
