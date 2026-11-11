/**
 * Un `cliodeck-config.json` ou un `cliodeck-secrets.json` illisible (S11-1-10).
 *
 * electron-store (conf 14) lit son fichier dans son constructeur, avec `clearInvalidConfig: false` :
 * un JSON invalide y lève la `SyntaxError` de `JSON.parse`, et un fichier vide aussi (« Unexpected
 * end of JSON input »). `configManager.init` rejetait donc dans le `whenReady` du main, avant
 * `createWindow` : l'app tournait sans fenêtre et sans un mot. `clearInvalidConfig: true` aurait été
 * pire : le store repart vide et réécrit le fichier avec les défauts, réglages perdus sans copie.
 *
 * Le fichier illisible est mis de côté par `quarantineFile` (`<nom>.illisible-<horodatage>`, octets
 * d'origine), le store repart des défauts, et la copie est rendue pour que l'auteur l'apprenne.
 *
 * Vrai `conf` (le socle d'electron-store), vrais fichiers dans un dossier temporaire. Seuls le
 * dossier de l'app et le trousseau sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  app: { getPath: () => place.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

const { default: Store } = await import('electron-store');
const { openStoreResilient } = await import('../open-store-resilient.js');

/** `configManager.init` initialise le singleton `secureStorage`, une fois par module : un module neuf par test. */
async function freshServices() {
  vi.resetModules();
  const { ConfigManager } = await import('../config-manager.js');
  const { SecureStorage } = await import('../secure-storage.js');
  return { ConfigManager, SecureStorage };
}

const CONFIG = 'cliodeck-config.json';
const SECRETS = 'cliodeck-secrets.json';
/** Une virgule en trop, laissée en éditant le fichier à la main. */
const TRAILING_COMMA = '{\n  "language": "en",\n  "lastDialogDirectory": "/Users/historienne/Archives",\n}\n';

const at = (name: string) => join(place.dir, name);
const copiesOf = (name: string) => readdirSync(place.dir).filter((n) => n.startsWith(`${name}.illisible-`));
const openConfig = () =>
  new Store({ name: 'cliodeck-config', defaults: { language: 'fr' } }) as unknown as {
    get(key: string): unknown;
  };

beforeEach(() => {
  // Le chemin réel : `quarantineFile` rend celui du fichier, et `/var` est un lien vers `/private/var` sous macOS.
  place.dir = realpathSync(mkdtempSync(join(tmpdir(), 'cliodeck-store-')));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(place.dir, { recursive: true, force: true });
});

describe('openStoreResilient — sur le vrai electron-store', () => {
  it('JSON invalide : le fichier est mis de côté avec ses octets, le store repart des défauts, et la copie est rendue', async () => {
    writeFileSync(at(CONFIG), TRAILING_COMMA);

    const { store, recoveredFrom } = await openStoreResilient(openConfig, at(CONFIG));

    expect(copiesOf(CONFIG)).toHaveLength(1);
    expect(recoveredFrom).toBe(at(copiesOf(CONFIG)[0]));
    expect(readFileSync(recoveredFrom as string, 'utf8')).toBe(TRAILING_COMMA);
    expect(store.get('language')).toBe('fr');
    // Le fichier neuf est lisible : le prochain lancement ne repasse pas par ici.
    expect(JSON.parse(readFileSync(at(CONFIG), 'utf8'))).toEqual({ language: 'fr' });
  });

  it('fichier vide (coupure pendant une écriture) : electron-store lève aussi, et il est traité comme illisible', async () => {
    writeFileSync(at(CONFIG), '');

    const { store, recoveredFrom } = await openStoreResilient(openConfig, at(CONFIG));

    expect(recoveredFrom).toBe(at(copiesOf(CONFIG)[0]));
    expect(readFileSync(recoveredFrom as string)).toHaveLength(0);
    expect(store.get('language')).toBe('fr');
  });

  it('une copie `.illisible-` précédente, du même horodatage, n’est pas écrasée', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T09:30:00.000Z'));
    const earlier = at(`${CONFIG}.illisible-2026-11-11T09-30-00-000Z`);
    writeFileSync(earlier, 'la mise de côté d’avant');
    writeFileSync(at(CONFIG), TRAILING_COMMA);

    const { recoveredFrom } = await openStoreResilient(openConfig, at(CONFIG));

    expect(readFileSync(earlier, 'utf8')).toBe('la mise de côté d’avant');
    expect(recoveredFrom).toBe(`${earlier}-1`);
    expect(readFileSync(recoveredFrom as string, 'utf8')).toBe(TRAILING_COMMA);
  });

  it('pas de fichier (premier lancement) : rien n’est mis de côté', async () => {
    const { store, recoveredFrom } = await openStoreResilient(openConfig, at(CONFIG));

    expect(recoveredFrom).toBeNull();
    expect(store.get('language')).toBe('fr');
    expect(copiesOf(CONFIG)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('fichier sans droit de lecture : l’erreur remonte, et rien n’est renommé', async () => {
    writeFileSync(at(CONFIG), '{"language":"en"}');
    chmodSync(at(CONFIG), 0o000);
    try {
      await expect(openStoreResilient(openConfig, at(CONFIG))).rejects.toMatchObject({ code: 'EACCES' });
      expect(copiesOf(CONFIG)).toEqual([]);
      expect(existsSync(at(CONFIG))).toBe(true);
    } finally {
      chmodSync(at(CONFIG), 0o644);
    }
    expect(readFileSync(at(CONFIG), 'utf8')).toBe('{"language":"en"}');
  });

  it('toute autre erreur remonte telle quelle, sans rien renommer', async () => {
    writeFileSync(at(CONFIG), TRAILING_COMMA);
    const disk = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });

    await expect(
      openStoreResilient(() => {
        throw disk;
      }, at(CONFIG))
    ).rejects.toBe(disk);
    expect(copiesOf(CONFIG)).toEqual([]);
    expect(readFileSync(at(CONFIG), 'utf8')).toBe(TRAILING_COMMA);
  });
});

describe('au démarrage : la configuration et les clés', () => {
  it('cliodeck-config.json illisible : init aboutit avec les défauts, et la copie est listée', async () => {
    writeFileSync(at(CONFIG), TRAILING_COMMA);
    const { ConfigManager } = await freshServices();
    const manager = new ConfigManager();

    await manager.init();

    const [copy] = copiesOf(CONFIG);
    expect(readFileSync(at(copy), 'utf8')).toBe(TRAILING_COMMA);
    expect(manager.get('language')).toBe('fr');
    expect(manager.getRecoveredFiles()).toEqual([{ kind: 'config', copy: at(copy) }]);
  });

  it('cliodeck-secrets.json illisible : init aboutit sans clé, et la copie est listée avec celle des clés', async () => {
    writeFileSync(at(SECRETS), '{"zotero.apiKey": "abcd",,}');
    const { ConfigManager } = await freshServices();
    const manager = new ConfigManager();

    await manager.init();

    const [copy] = copiesOf(SECRETS);
    expect(readFileSync(at(copy), 'utf8')).toBe('{"zotero.apiKey": "abcd",,}');
    expect(manager.getRecoveredFiles()).toEqual([{ kind: 'secrets', copy: at(copy) }]);
  });

  it('SecureStorage seul : un fichier des clés illisible repart vide, et la copie est rendue', async () => {
    writeFileSync(at(SECRETS), '{');
    const { SecureStorage } = await freshServices();
    const storage = new SecureStorage();

    await storage.init();

    const [copy] = copiesOf(SECRETS);
    expect(storage.getRecoveredFrom()).toBe(at(copy));
    expect(storage.getKey('zotero.apiKey')).toBe('');
    expect(storage.unreadableKeys()).toEqual([]);
  });

  it('deux fichiers lisibles : rien n’est listé', async () => {
    writeFileSync(at(CONFIG), '{"language":"de"}');
    writeFileSync(at(SECRETS), '{}');
    const { ConfigManager } = await freshServices();
    const manager = new ConfigManager();

    await manager.init();

    expect(manager.get('language')).toBe('de');
    expect(manager.getRecoveredFiles()).toEqual([]);
    expect(copiesOf(CONFIG)).toEqual([]);
    expect(copiesOf(SECRETS)).toEqual([]);
  });
});
