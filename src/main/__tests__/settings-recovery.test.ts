/**
 * Deux fichiers de réglages en panne à la fois : la boîte d'erreur nomme aussi la copie déjà faite.
 *
 * `configManager.init` met de côté un `cliodeck-config.json` illisible, puis ouvre
 * `cliodeck-secrets.json`. Si ce second fichier échoue pour une autre raison (droits), `init` rejette
 * après la mise de côté : la boîte d'erreur ne nommait que l'erreur des clés, et l'app sortait. Au
 * lancement suivant, droits rétablis, la configuration se lit (ce sont les défauts) et plus rien ne
 * nomme la copie `.illisible-` : l'auteur n'apprenait jamais que ses réglages étaient repartis des
 * défauts, ni où retrouver les siens.
 *
 * Vrai `conf` (le socle d'electron-store), vrais fichiers dans un dossier temporaire, vrais textes de
 * `menu.json`. Seuls le dossier de l'app et le trousseau sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const place = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf');
  return {
    default: class extends Conf<Record<string, unknown>> {
      // Ce que fait electron-store : `name` s'appelle `configName` pour `conf`, et le dossier est
      // celui de l'app. Jamais celui de `projectName`, qui serait le vrai dossier de l'auteur.
      constructor({ name, ...options }: Record<string, unknown>) {
        super({ ...options, configName: name as string, cwd: place.dir, projectVersion: '1.0.0' });
      }
    },
  };
});
vi.mock('electron', () => ({
  app: { getPath: () => place.dir, isPackaged: false, getAppPath: () => resolve(__dirname, '../../..') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { loadMenuTranslations, setLanguage } from '../i18n';
import { recoveredSettingsDetail, settingsFailureMessage } from '../settings-recovery';

const fr = JSON.parse(readFileSync(resolve(__dirname, '../../../public/locales/fr/menu.json'), 'utf8')) as Record<
  string,
  string
>;

/** `configManager.init` initialise le singleton `secureStorage`, une fois par module : un module neuf par lancement. */
async function freshConfigManager() {
  vi.resetModules();
  const { ConfigManager } = await import('../services/config-manager.js');
  return new ConfigManager();
}

const CONFIG = 'cliodeck-config.json';
const SECRETS = 'cliodeck-secrets.json';
/** Une virgule en trop, laissée en éditant le fichier à la main. */
const TRAILING_COMMA = '{\n  "language": "en",\n  "lastDialogDirectory": "/Users/historienne/Archives",\n}\n';

const at = (name: string) => join(place.dir, name);
const copiesOf = (name: string) => readdirSync(place.dir).filter((n) => n.startsWith(`${name}.illisible-`));

beforeEach(() => {
  // Le chemin réel : `quarantineFile` rend celui du fichier, et `/var` est un lien vers `/private/var` sous macOS.
  place.dir = realpathSync(mkdtempSync(join(tmpdir(), 'cliodeck-reglages-')));
  // Sans configuration lue, le main parle français, sa langue par défaut.
  loadMenuTranslations();
  setLanguage('fr');
});

afterEach(() => {
  rmSync(place.dir, { recursive: true, force: true });
});

describe('la boîte d’erreur d’un démarrage impossible', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'configuration illisible, puis clés sans droit de lecture : elle nomme l’erreur et la copie de la configuration',
    async () => {
      writeFileSync(at(CONFIG), TRAILING_COMMA);
      writeFileSync(at(SECRETS), '{}');
      chmodSync(at(SECRETS), 0o000);
      const manager = await freshConfigManager();
      let failure: unknown = null;
      try {
        await manager.init().catch((error: unknown) => {
          failure = error;
        });
      } finally {
        chmodSync(at(SECRETS), 0o644);
      }

      // `init` a mis la configuration de côté avant d'ouvrir les clés : la copie existe déjà.
      expect(failure).toMatchObject({ code: 'EACCES' });
      const [copy] = copiesOf(CONFIG);
      expect(readFileSync(at(copy), 'utf8')).toBe(TRAILING_COMMA);

      const { title, content } = settingsFailureMessage(failure, manager.getRecoveredFiles());

      expect(title).toBe(fr.settingsUnreadableTitle);
      expect(content).toContain('EACCES');
      expect(content).toContain(fr.settingsRecoveredConfig.replace('{{path}}', () => at(copy)));

      // C'est la seule occasion de le dire : au lancement suivant, droits rétablis, la configuration
      // se lit (ce sont les défauts), et plus rien ne nomme la copie.
      const next = await freshConfigManager();
      await next.init();
      expect(next.getRecoveredFiles()).toEqual([]);
      expect(next.get('language')).toBe('fr');
    }
  );

  it('rien de mis de côté : la boîte ne nomme que l’erreur', () => {
    const failure = Object.assign(new Error("EACCES: permission denied, open '/u/cliodeck-config.json'"), {
      code: 'EACCES',
    });

    expect(settingsFailureMessage(failure, [])).toEqual({
      title: fr.settingsUnreadableTitle,
      content: fr.settingsUnreadableMessage.replace('{{error}}', () => failure.message),
    });
  });
});

describe('le message des réglages mis de côté', () => {
  it('un paragraphe par copie, et pour les clés, qu’elles sont à ressaisir', () => {
    const detail = recoveredSettingsDetail([
      { kind: 'config', copy: '/u/cliodeck-config.json.illisible-1' },
      { kind: 'secrets', copy: '/u/cliodeck-secrets.json.illisible-1' },
    ]);

    expect(detail).toBe(
      [
        fr.settingsRecoveredConfig.replace('{{path}}', '/u/cliodeck-config.json.illisible-1'),
        fr.settingsRecoveredSecrets.replace('{{path}}', '/u/cliodeck-secrets.json.illisible-1'),
      ].join('\n\n')
    );
  });
});
