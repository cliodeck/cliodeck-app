import { describe, it, expect } from 'vitest';
import {
  emptyReport,
  finalizeReport,
  assertNever,
  type SkipReason,
  type VaultScanReport,
} from '../scan-report.js';

describe('VaultScanReport (2.1bis)', () => {
  it('empty report has zero stats', () => {
    const r = emptyReport('/vault');
    expect(r.stats.totalFound).toBe(0);
    expect(r.indexed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it('finalizeReport recomputes stats from accumulators', () => {
    const base = emptyReport('/vault');
    const ref = {
      relativePath: 'a.md',
      absolutePath: '/vault/a.md',
      fileName: 'a.md',
    };
    const populated: VaultScanReport = {
      ...base,
      skipped: [{ ref, reason: { kind: 'empty_note' } }],
      failed: [{ ref, reason: { kind: 'io_error', message: 'EACCES' } }],
    };
    const final = finalizeReport(populated);
    expect(final.stats).toEqual({
      totalFound: 2,
      indexedCount: 0,
      skippedCount: 1,
      failedCount: 1,
    });
    expect(final.completedAt).toBeDefined();
  });

  it('SkipReason variants are exhaustively narrowable', () => {
    // This test exists to anchor the compile-time exhaustiveness contract:
    // if a new variant is added to SkipReason, the default branch must
    // stop compiling. We assert here only the runtime case labels.
    const labels: SkipReason['kind'][] = [];
    const cases: SkipReason[] = [
      { kind: 'hidden_file' },
      { kind: 'empty_note' },
      { kind: 'binary_content', detail: 'PK\\x03\\x04' },
      { kind: 'frontmatter_parse_error', message: 'bad YAML' },
      { kind: 'oversized', sizeBytes: 10, limit: 5 },
      { kind: 'ignored_by_pattern', pattern: '*.tmp' },
      { kind: 'unreadable', message: 'EACCES' },
      { kind: 'broken_wikilinks_only', count: 2 },
    ];
    for (const c of cases) {
      switch (c.kind) {
        case 'hidden_file':
        case 'empty_note':
        case 'binary_content':
        case 'frontmatter_parse_error':
        case 'oversized':
        case 'ignored_by_pattern':
        case 'unreadable':
        case 'broken_wikilinks_only':
          labels.push(c.kind);
          break;
        default:
          assertNever(c);
      }
    }
    expect(labels).toHaveLength(cases.length);
  });
});
