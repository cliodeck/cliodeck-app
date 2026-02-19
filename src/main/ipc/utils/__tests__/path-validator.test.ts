import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock os.homedir()
vi.mock('os', () => ({
  default: { homedir: () => '/home/testuser' },
  homedir: () => '/home/testuser',
}));

// Mock the project-manager module
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: {
    getCurrentProjectPath: vi.fn(() => '/home/testuser/projects/my-project'),
  },
}));

// Import after mocks
const { validateReadPath, validateWritePath } = await import('../path-validator');

describe('validateReadPath', () => {
  it('allows paths within home directory', async () => {
    const result = await validateReadPath('/home/testuser/documents/file.pdf');
    expect(result).toBe('/home/testuser/documents/file.pdf');
  });

  it('allows paths in subdirectories of home', async () => {
    const result = await validateReadPath('/home/testuser/projects/my-project/refs.bib');
    expect(result).toBe('/home/testuser/projects/my-project/refs.bib');
  });

  it('allows /usr/share paths', async () => {
    const result = await validateReadPath('/usr/share/csl-styles/apa.csl');
    expect(result).toBe('/usr/share/csl-styles/apa.csl');
  });

  it('allows /usr/local/share paths', async () => {
    const result = await validateReadPath('/usr/local/share/fonts/arial.ttf');
    expect(result).toBe('/usr/local/share/fonts/arial.ttf');
  });

  it('allows /opt/homebrew paths', async () => {
    const result = await validateReadPath('/opt/homebrew/share/something');
    expect(result).toBe('/opt/homebrew/share/something');
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(validateReadPath('/etc/passwd')).rejects.toThrow('Read access denied');
  });

  it('rejects root paths', async () => {
    await expect(validateReadPath('/tmp/secret')).rejects.toThrow('Read access denied');
  });

  it('resolves relative paths before checking', async () => {
    // This resolves to cwd + the relative path, which likely won't be in /home/testuser
    // unless cwd is in /home/testuser
    const resolved = path.resolve('some/relative/path');
    if (resolved.startsWith('/home/testuser')) {
      const result = await validateReadPath('some/relative/path');
      expect(result).toBe(resolved);
    } else {
      await expect(validateReadPath('some/relative/path')).rejects.toThrow('Read access denied');
    }
  });

  it('blocks path traversal attempts', async () => {
    // /home/testuser/../../../etc/passwd resolves to /etc/passwd
    await expect(validateReadPath('/home/testuser/../../../etc/passwd')).rejects.toThrow(
      'Read access denied'
    );
  });
});

describe('validateWritePath', () => {
  it('allows writes within the project directory', async () => {
    const result = await validateWritePath('/home/testuser/projects/my-project/document.md');
    expect(result).toBe('/home/testuser/projects/my-project/document.md');
  });

  it('allows writes within home directory', async () => {
    const result = await validateWritePath('/home/testuser/exports/output.pdf');
    expect(result).toBe('/home/testuser/exports/output.pdf');
  });

  it('rejects writes outside home and project', async () => {
    await expect(validateWritePath('/tmp/malicious.sh')).rejects.toThrow('Write access denied');
  });

  it('rejects writes to system paths', async () => {
    await expect(validateWritePath('/etc/crontab')).rejects.toThrow('Write access denied');
  });

  it('blocks write path traversal', async () => {
    await expect(
      validateWritePath('/home/testuser/projects/my-project/../../../../../../etc/hosts')
    ).rejects.toThrow('Write access denied');
  });
});
