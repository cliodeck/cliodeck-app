/**
 * Binaires llama.cpp de chaque architecture Mac (#128) : le DMG Intel,
 * construit sur Apple Silicon, partait sans `@node-llama-cpp/mac-x64`, et le
 * modèle embarqué ne pouvait pas démarrer sur un Mac Intel.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { integrityOf, missingPrebuilts } from '../fetch-llama-prebuilts.mjs';

const optionalDependencies = {
  '@node-llama-cpp/mac-arm64-metal': '3.18.1',
  '@node-llama-cpp/mac-x64': '3.18.1',
  '@node-llama-cpp/linux-x64': '3.18.1',
};

describe('missingPrebuilts', () => {
  it('réclame mac-x64 sur une machine Apple Silicon où npm ne l’a pas installé (cas du DMG rc.6-beta.2)', () => {
    const installed: Record<string, string> = { '@node-llama-cpp/mac-arm64-metal': '3.18.1' };
    const missing = missingPrebuilts(['darwin-arm64', 'darwin-x64'], {
      optionalDependencies,
      installedVersion: (name: string) => installed[name] ?? null,
    });
    expect(missing).toEqual([{ name: '@node-llama-cpp/mac-x64', version: '3.18.1' }]);
  });

  it('ne réclame rien quand les deux architectures sont là, à la bonne version', () => {
    const missing = missingPrebuilts(['darwin-arm64', 'darwin-x64'], {
      optionalDependencies,
      installedVersion: () => '3.18.1',
    });
    expect(missing).toEqual([]);
  });

  it('remplace un paquet d’une autre version que celle attendue par node-llama-cpp', () => {
    const missing = missingPrebuilts(['darwin-x64'], {
      optionalDependencies,
      installedVersion: () => '3.17.0',
    });
    expect(missing).toEqual([{ name: '@node-llama-cpp/mac-x64', version: '3.18.1' }]);
  });

  it('refuse une cible inconnue plutôt que de construire sans moteur', () => {
    expect(() => missingPrebuilts(['darwin-ppc'], { optionalDependencies, installedVersion: () => null })).toThrow(/cible inconnue/);
  });
});

describe('integrityOf', () => {
  it('produit l’empreinte au format du package-lock', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llama-integrity-')), 'a.tgz');
    fs.writeFileSync(f, 'contenu');
    const expected = `sha512-${createHash('sha512').update('contenu').digest('base64')}`;
    try {
      expect(integrityOf(f)).toBe(expected);
    } finally {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    }
  });
});
