/**
 * Détection d'un lancement sans bac à sable (#151).
 *
 * L'enjeu : l'AppImage peut démarrer sans le bac à sable de Chromium sans
 * que l'utilisateur l'ait demandé. L'avertissement ne doit ni manquer dans
 * ce cas, ni apparaître là où il n'a pas lieu d'être.
 */
import { describe, it, expect } from 'vitest';
import { sandboxStatus } from '../sandbox-status.js';

describe('état du bac à sable', () => {
  it('signale une AppImage lancée sans bac à sable', () => {
    expect(
      sandboxStatus({ platform: 'linux', noSandboxSwitch: true, appImagePath: '/home/a/ClioDeck.AppImage' })
    ).toEqual({ disabled: true, appImage: true });
  });

  it('signale aussi un lancement manuel avec --no-sandbox, sans parler d’AppImage', () => {
    expect(sandboxStatus({ platform: 'linux', noSandboxSwitch: true, appImagePath: undefined })).toEqual({
      disabled: true,
      appImage: false,
    });
  });

  it('ne dit rien quand le bac à sable est actif, AppImage ou non', () => {
    expect(
      sandboxStatus({ platform: 'linux', noSandboxSwitch: false, appImagePath: '/home/a/ClioDeck.AppImage' })
    ).toEqual({ disabled: false, appImage: false });
  });

  it('ne dit rien hors de Linux : les tests e2e passent --no-sandbox partout', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(sandboxStatus({ platform, noSandboxSwitch: true, appImagePath: undefined })).toEqual({
        disabled: false,
        appImage: false,
      });
    }
  });
});
