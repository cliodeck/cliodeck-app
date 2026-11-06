/**
 * Version minimale de macOS déclarée par le paquet.
 *
 * Electron 44 a abandonné macOS 12 (Chromium ne le suit plus) : ClioDeck
 * exige macOS 13 depuis la montée en Electron 45 (décision T7). Le minimum
 * est écrit dans `build.mac.minimumSystemVersion`, qu'electron-builder copie
 * dans `LSMinimumSystemVersion` : sous un macOS plus ancien, le Finder refuse
 * d'ouvrir l'app au lieu de la laisser planter au lancement. Ce test garde
 * deux choses qui peuvent se perdre sans bruit : la déclaration elle-même, et
 * son accord avec le binaire d'Electron installé — une montée qui relève le
 * minimum doit relever aussi celui du paquet (et la documentation).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  build: { mac: { minimumSystemVersion?: string } };
};
const ELECTRON_PLIST = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/Info.plist');

function major(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

describe('minimum macOS du paquet', () => {
  it('déclare macOS 13', () => {
    expect(manifest.build.mac.minimumSystemVersion).toBe('13.0');
  });

  // Le binaire macOS d'Electron n'est installé que sur un Mac.
  it.skipIf(!fs.existsSync(ELECTRON_PLIST))('n’est pas plus bas que celui d’Electron', () => {
    const electronMinimum = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', ELECTRON_PLIST], {
      encoding: 'utf8',
    }).trim();
    expect(major(manifest.build.mac.minimumSystemVersion ?? '0')).toBeGreaterThanOrEqual(major(electronMinimum));
  });
});
