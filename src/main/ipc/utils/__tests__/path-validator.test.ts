import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';

// Mock electron.app so validateReadPath does not try to load the real runtime.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent-app-path' },
}));

// Mock the project-manager module; tests override getCurrentProjectPath per-suite.
const projectPathRef = { current: null as string | null };
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: {
    getCurrentProjectPath: () => projectPathRef.current,
  },
}));

// Import after mocks.
const { validateReadPath, validateWritePath } = await import('../path-validator');

let tmpRoot: string;
let projectDir: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-pv-'));
  projectDir = path.join(tmpRoot, 'my-project');
  await mkdir(path.join(projectDir, '.cliodeck', 'v2'), { recursive: true });
  await writeFile(path.join(projectDir, 'document.md'), '# doc');
  projectPathRef.current = projectDir;
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('validateReadPath', () => {
  it('allows reads inside the project', async () => {
    const p = path.join(projectDir, 'document.md');
    expect(await validateReadPath(p)).toBe(p);
  });

  it('allows reads inside the project .cliodeck/ subtree', async () => {
    const p = path.join(projectDir, '.cliodeck', 'v2', 'config.json');
    expect(await validateReadPath(p)).toBe(p);
  });

  it('rejects reads in $HOME outside the project (~/.ssh, etc.)', async () => {
    const fakeSsh = path.join(os.homedir(), '.ssh', 'authorized_keys');
    await expect(validateReadPath(fakeSsh)).rejects.toThrow('Read access denied');
  });

  it('rejects reads to arbitrary system paths', async () => {
    await expect(validateReadPath('/etc/passwd')).rejects.toThrow('Read access denied');
  });

  it('rejects symlinks that escape the project perimeter', async () => {
    const linkPath = path.join(projectDir, 'evil-link');
    await symlink('/etc/passwd', linkPath).catch(() => undefined);
    await expect(validateReadPath(linkPath)).rejects.toThrow('Read access denied');
  });

  it('blocks path traversal attempts that escape the project', async () => {
    const traversal = path.join(projectDir, '..', '..', 'etc', 'passwd');
    await expect(validateReadPath(traversal)).rejects.toThrow('Read access denied');
  });

  it('does not match sibling directories with a shared prefix', async () => {
    const sibling = projectDir + '-sibling/file.txt';
    await expect(validateReadPath(sibling)).rejects.toThrow('Read access denied');
  });
});

describe('validateWritePath', () => {
  it('allows writes inside the project directory', async () => {
    const p = path.join(projectDir, 'chapters', 'ch1.md');
    expect(await validateWritePath(p)).toBe(p);
  });

  it('rejects writes to ~/.ssh/authorized_keys', async () => {
    const fakeSsh = path.join(os.homedir(), '.ssh', 'authorized_keys');
    await expect(validateWritePath(fakeSsh)).rejects.toThrow('Write access denied');
  });

  it('rejects writes to ~/.bashrc', async () => {
    const bashrc = path.join(os.homedir(), '.bashrc');
    await expect(validateWritePath(bashrc)).rejects.toThrow('Write access denied');
  });

  it('rejects writes outside the project in $HOME', async () => {
    const p = path.join(os.homedir(), 'exports', 'output.pdf');
    await expect(validateWritePath(p)).rejects.toThrow('Write access denied');
  });

  it('rejects writes to system paths', async () => {
    await expect(validateWritePath('/etc/crontab')).rejects.toThrow('Write access denied');
  });

  it('blocks write path traversal', async () => {
    const traversal = path.join(projectDir, '..', '..', '..', 'etc', 'hosts');
    await expect(validateWritePath(traversal)).rejects.toThrow('Write access denied');
  });

  it('rejects writes when no project is open', async () => {
    const saved = projectPathRef.current;
    projectPathRef.current = null;
    try {
      await expect(validateWritePath(path.join(saved!, 'x.md'))).rejects.toThrow(
        'Write access denied'
      );
    } finally {
      projectPathRef.current = saved;
    }
  });
});
