/**
 * Aucune fausse clé d'API au format réel n'est écrite d'un seul tenant.
 *
 * Les tests ont besoin de clés qui ressemblent aux vraies (`AIza…`,
 * `sk-ant-api03…`, `sk-proj…`) : c'est leur forme qu'ils éprouvent. Écrites
 * d'un seul tenant, le secret scanning de GitHub les signale comme des fuites
 * (#212). On les assemble donc à partir de morceaux, et ce garde-fou empêche
 * le retour d'une clé entière. Ses propres motifs sont assemblés de même.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const TEXT_FILE = /\.(c?m?[jt]sx?|json|md|ya?ml|css|html|txt)$/;

const REAL_FORMAT = new RegExp(
  [`${'AI'}za[0-9A-Za-z_-]{20}`, `${'sk-ant'}-api03-`, `${'sk'}-proj-`].join('|')
);

describe('fausses clés d’API', () => {
  it('aucune clé au format réel n’est écrite d’un seul tenant dans le dépôt', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => TEXT_FILE.test(f) && f !== 'package-lock.json');
    expect(files.length).toBeGreaterThan(500);
    const found: string[] = [];
    for (const file of files) {
      const abs = path.join(ROOT, file);
      if (!fs.existsSync(abs)) continue;
      fs.readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (REAL_FORMAT.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(found).toEqual([]);
  });
});
