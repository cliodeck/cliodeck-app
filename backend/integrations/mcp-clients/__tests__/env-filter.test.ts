import { describe, it, expect } from 'vitest';
import { buildMCPSpawnEnv, mcpSpawnParentEnv } from '../env-filter.js';

describe('buildMCPSpawnEnv', () => {
  it('inherits whitelisted vars from parent', () => {
    const env = buildMCPSpawnEnv(undefined, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      SECRET_SAUCE: 'nope',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SECRET_SAUCE).toBeUndefined();
  });

  it('inherits LC_* and XDG_* prefixed vars', () => {
    const env = buildMCPSpawnEnv(undefined, {
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      XDG_CONFIG_HOME: '/x',
      NOT_XDG: 'n',
    });
    expect(env.LC_ALL).toBe('C');
    expect(env.LC_CTYPE).toBe('UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/x');
    expect(env.NOT_XDG).toBeUndefined();
  });

  it('strips loader-hijack vars from parent env', () => {
    const env = buildMCPSpawnEnv(undefined, {
      PATH: '/usr/bin',
      LD_PRELOAD: '/evil.so',
      LD_LIBRARY_PATH: '/evil',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
      DYLD_LIBRARY_PATH: '/evil',
      NODE_OPTIONS: '--require=/evil.js',
      PYTHONPATH: '/evil',
      PYTHONSTARTUP: '/evil.py',
    });
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('overlays user env on top of inherited env', () => {
    const env = buildMCPSpawnEnv(
      { MY_TOKEN: 'abc', LANG: 'fr_FR.UTF-8' },
      { PATH: '/usr/bin', LANG: 'en_US.UTF-8' }
    );
    expect(env.MY_TOKEN).toBe('abc');
    expect(env.LANG).toBe('fr_FR.UTF-8');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('refuses denylisted keys in user env', () => {
    const env = buildMCPSpawnEnv(
      {
        LD_PRELOAD: '/evil.so',
        DYLD_INSERT_LIBRARIES: '/evil.dylib',
        NODE_OPTIONS: '--require=/evil.js',
        PYTHONPATH: '/evil',
        PYTHONSTARTUP: '/evil.py',
        LD_LIBRARY_PATH: '/evil',
        SAFE_VAR: 'ok',
      },
      { PATH: '/usr/bin' }
    );
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.SAFE_VAR).toBe('ok');
  });

  it('allows user to override PATH (documented behavior)', () => {
    // User config can override PATH because PATH is whitelisted and not denied:
    // MCP servers sometimes need a custom PATH to find their runtime (e.g. nvm,
    // pyenv). The validation happens before the spawn: the approval fingerprint
    // covers the env, values included (`fingerprintClient`), so a PATH or a
    // package registry added to an approved command asks again, and the dialog
    // shows their value (`confirmMcpAdd`, S09-1-22).
    const env = buildMCPSpawnEnv(
      { PATH: '/custom/bin' },
      { PATH: '/usr/bin' }
    );
    expect(env.PATH).toBe('/custom/bin');
  });

  it('handles undefined user env', () => {
    const env = buildMCPSpawnEnv(undefined, { PATH: '/usr/bin' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('skips undefined values in parent env', () => {
    const env = buildMCPSpawnEnv(undefined, {
      PATH: '/usr/bin',
      HOME: undefined,
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('HOME');
  });
});

/**
 * Lancée depuis le Dock ou le Finder, l'app reçoit le PATH de launchd : `npx`, `node` et `uvx`
 * y échouaient en « spawn ENOENT » (S09-1-10).
 */
describe('mcpSpawnParentEnv : le PATH d’une app lancée depuis le Dock', () => {
  const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const NVM_VERSIONS = '/Users/h/.nvm/versions/node';
  const noNvm = (dir: string): string[] => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dir}'`), { code: 'ENOENT' });
  };
  const darwin = { home: '/Users/h', platform: 'darwin' as const, readdir: noNvm };

  it('ajoute Homebrew, /usr/local/bin, ~/.local/bin (uv) et Volta devant le PATH de launchd', () => {
    const env = mcpSpawnParentEnv({ PATH: LAUNCHD_PATH, HOME: '/Users/h', LANG: 'fr_FR.UTF-8' }, darwin);
    const dirs = (env.PATH ?? '').split(':');
    expect(dirs).toEqual(
      expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', '/Users/h/.local/bin', '/Users/h/.volta/bin'])
    );
    expect(env.PATH?.endsWith(`:${LAUNCHD_PATH}`)).toBe(true);
    expect(env.HOME).toBe('/Users/h');
    expect(env.LANG).toBe('fr_FR.UTF-8');
  });

  it('vaut aussi sous Linux : ~/.local/bin est celui de uv', () => {
    const env = mcpSpawnParentEnv({ PATH: '/usr/bin:/bin' }, { ...darwin, home: '/home/h', platform: 'linux' });
    expect((env.PATH ?? '').split(':')).toContain('/home/h/.local/bin');
  });

  it('sans nvm : aucun dossier nvm, aucune erreur, les autres emplacements quand même', () => {
    const env = mcpSpawnParentEnv({ PATH: LAUNCHD_PATH }, darwin);
    expect(env.PATH).not.toContain('.nvm');
    expect((env.PATH ?? '').split(':')).toContain('/opt/homebrew/bin');
  });

  it('nvm : la version la plus haute, comparée par numéros et non par ordre alphabétique', () => {
    const env = mcpSpawnParentEnv(
      { PATH: LAUNCHD_PATH },
      {
        ...darwin,
        readdir: (dir) => (dir === NVM_VERSIONS ? ['v9.11.2', 'v22.12.0', 'v18.20.4', 'v22.2.0', '.cache'] : noNvm(dir)),
      }
    );
    const nvmDirs = (env.PATH ?? '').split(':').filter((d) => d.includes('.nvm'));
    expect(nvmDirs).toEqual([`${NVM_VERSIONS}/v22.12.0/bin`]);
  });

  it('sous Windows, l’env part tel quel', () => {
    const parent = { Path: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\h' };
    const env = mcpSpawnParentEnv(parent, { home: 'C:\\Users\\h', platform: 'win32', readdir: () => ['v22.12.0'] });
    expect(env).toEqual(parent);
  });

  it('un HOME vide n’ajoute aucun dossier relatif, que la commande chercherait dans le dossier courant', () => {
    const env = mcpSpawnParentEnv({ PATH: LAUNCHD_PATH }, { ...darwin, home: '' });
    expect((env.PATH ?? '').split(':').filter((d) => d !== '' && !d.startsWith('/'))).toEqual([]);
  });

  it('un PATH déclaré par le client reste prioritaire, et l’env reçu n’est pas modifié', () => {
    const parent = { PATH: LAUNCHD_PATH };
    const userEnv = { PATH: '/custom/bin' };
    const env = buildMCPSpawnEnv(userEnv, mcpSpawnParentEnv(parent, darwin));
    expect(env.PATH).toBe('/custom/bin');
    expect(parent).toEqual({ PATH: LAUNCHD_PATH });
    expect(userEnv).toEqual({ PATH: '/custom/bin' });
  });
});
