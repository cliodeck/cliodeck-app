import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { rotateJsonlFile } from '../log-rotation.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, entries: Array<{ at: string; data: string }>) {
  const lines = entries.map((e) => JSON.stringify(e));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

describe('rotateJsonlFile (A21)', () => {
  it('returns zeroes if file does not exist', async () => {
    const result = await rotateJsonlFile(path.join(tmpDir, 'nope.jsonl'));
    expect(result).toEqual({ purged: 0, kept: 0 });
  });

  it('keeps all entries if none are older than TTL', async () => {
    const filePath = path.join(tmpDir, 'recent.jsonl');
    writeJsonl(filePath, [
      { at: new Date().toISOString(), data: 'fresh' },
      { at: new Date().toISOString(), data: 'also fresh' },
    ]);

    const result = await rotateJsonlFile(filePath, { ttlDays: 90 });
    expect(result).toEqual({ purged: 0, kept: 2 });
  });

  it('purges entries older than TTL', async () => {
    const filePath = path.join(tmpDir, 'mixed.jsonl');
    const old = new Date();
    old.setDate(old.getDate() - 100);
    const recent = new Date();

    writeJsonl(filePath, [
      { at: old.toISOString(), data: 'ancient' },
      { at: recent.toISOString(), data: 'current' },
    ]);

    const result = await rotateJsonlFile(filePath, { ttlDays: 90, archive: false });
    expect(result).toEqual({ purged: 1, kept: 1 });

    // Verify file only contains the kept entry
    const remaining = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).data).toBe('current');
  });

  it('creates a .gz archive of purged entries when archive=true', async () => {
    const filePath = path.join(tmpDir, 'archive-test.jsonl');
    const old = new Date();
    old.setDate(old.getDate() - 200);

    writeJsonl(filePath, [
      { at: old.toISOString(), data: 'very old' },
    ]);

    await rotateJsonlFile(filePath, { ttlDays: 90, archive: true });

    // Check that a .gz file was created
    const files = fs.readdirSync(tmpDir);
    const gzFiles = files.filter((f) => f.endsWith('.gz'));
    expect(gzFiles).toHaveLength(1);
    expect(gzFiles[0]).toMatch(/archive-test.*purged\.jsonl\.gz/);
  });

  it('handles malformed lines gracefully (keeps them)', async () => {
    const filePath = path.join(tmpDir, 'malformed.jsonl');
    const old = new Date();
    old.setDate(old.getDate() - 200);

    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ at: old.toISOString(), data: 'old' })}\nnot-valid-json\n`,
      'utf8'
    );

    const result = await rotateJsonlFile(filePath, { ttlDays: 90, archive: false });
    expect(result.purged).toBe(1);
    expect(result.kept).toBe(1); // malformed line is kept

    const remaining = fs.readFileSync(filePath, 'utf8').trim();
    expect(remaining).toBe('not-valid-json');
  });

  it('respects custom TTL', async () => {
    const filePath = path.join(tmpDir, 'ttl.jsonl');
    const daysAgo40 = new Date();
    daysAgo40.setDate(daysAgo40.getDate() - 40);

    writeJsonl(filePath, [
      { at: daysAgo40.toISOString(), data: '40 days old' },
    ]);

    // With 90 days TTL: should keep it
    const r1 = await rotateJsonlFile(filePath, { ttlDays: 90, archive: false });
    expect(r1.purged).toBe(0);

    // With 30 days TTL: should purge it
    const r2 = await rotateJsonlFile(filePath, { ttlDays: 30, archive: false });
    expect(r2.purged).toBe(1);
  });
});
