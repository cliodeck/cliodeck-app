import { describe, it, expect } from 'vitest';
import { buildMCPSpawnEnv } from '../env-filter.js';

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
    // User config can override PATH because PATH is whitelisted and not denied.
    // This is accepted risk — MCP servers sometimes need a custom PATH to find
    // their runtime (e.g. nvm, pyenv). Callers must validate config at admin
    // ingest time.
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
