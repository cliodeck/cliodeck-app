/**
 * Regression tests for `bin/cliodeck-mcp`.
 *
 * The wrapper only ever knew the git-checkout layout, so an installed app
 * could not serve MCP at all — and Settings still offered its user a
 * copy-paste snippet pointing at the missing file. These tests pin both
 * layouts by standing in a fake Electron binary that echoes what it was
 * handed; no real Electron, no app bundle, no native binding.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const WRAPPER = path.resolve(__dirname, '../../../bin/cliodeck-mcp');
const CLI_REL = 'dist/backend/mcp-server/cli.js';

/** A stand-in for Electron: prints the env flag and the args it received. */
const FAKE_ELECTRON = `#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "ARG=$a"; done\n`;

function write(file: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function run(wrapper: string, args: string[]): { status: number; out: string } {
  try {
    return { status: 0, out: execFileSync(wrapper, args, { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.skipIf(process.platform === 'win32')('bin/cliodeck-mcp', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mcp-wrapper-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the built CLI under the repo Electron in a git checkout', () => {
    const repo = path.join(tmp, 'checkout');
    write(path.join(repo, 'node_modules/.bin/electron'), FAKE_ELECTRON, 0o755);
    write(path.join(repo, CLI_REL), '// built bundle\n');
    const wrapper = path.join(repo, 'bin/cliodeck-mcp');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.copyFileSync(WRAPPER, wrapper);
    fs.chmodSync(wrapper, 0o755);

    const { status, out } = run(wrapper, ['/some/workspace']);

    expect(status).toBe(0);
    expect(out).toContain('RUN_AS_NODE=1');
    expect(out).toContain(`ARG=${path.join(repo, CLI_REL)}`);
    expect(out).toContain('ARG=/some/workspace');
  });

  it('runs the CLI from app.asar under the bundled binary in an installed app', () => {
    // macOS layout: <app>/Contents/Resources/bin/cliodeck-mcp, executable in
    // the sibling MacOS/ directory.
    const contents = path.join(tmp, 'ClioDeck.app/Contents');
    const resources = path.join(contents, 'Resources');
    write(path.join(resources, 'app.asar'), 'not really an archive');
    write(path.join(contents, 'MacOS/ClioDeck'), FAKE_ELECTRON, 0o755);
    const wrapper = path.join(resources, 'bin/cliodeck-mcp');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.copyFileSync(WRAPPER, wrapper);
    fs.chmodSync(wrapper, 0o755);

    const { status, out } = run(wrapper, ['/some/workspace']);

    expect(status).toBe(0);
    expect(out).toContain('RUN_AS_NODE=1');
    // The path points inside the archive: Electron resolves it, the shell cannot.
    expect(out).toContain(`ARG=${path.join(resources, 'app.asar', CLI_REL)}`);
    expect(out).toContain('ARG=/some/workspace');
  });

  it('finds the Linux executable next to the resources directory', () => {
    const install = path.join(tmp, 'opt-cliodeck');
    const resources = path.join(install, 'resources');
    write(path.join(resources, 'app.asar'), 'not really an archive');
    write(path.join(install, 'cliodeck'), FAKE_ELECTRON, 0o755);
    const wrapper = path.join(resources, 'bin/cliodeck-mcp');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.copyFileSync(WRAPPER, wrapper);
    fs.chmodSync(wrapper, 0o755);

    const { status, out } = run(wrapper, ['/some/workspace']);

    expect(status).toBe(0);
    expect(out).toContain(`ARG=${path.join(resources, 'app.asar', CLI_REL)}`);
  });

  it('fails loud when neither a build nor an installed app is present', () => {
    const bare = path.join(tmp, 'bare');
    const wrapper = path.join(bare, 'bin/cliodeck-mcp');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.copyFileSync(WRAPPER, wrapper);
    fs.chmodSync(wrapper, 0o755);

    const { status, out } = run(wrapper, ['/some/workspace']);

    expect(status).toBe(2);
    expect(out).toContain('no ClioDeck code found');
  });
});
