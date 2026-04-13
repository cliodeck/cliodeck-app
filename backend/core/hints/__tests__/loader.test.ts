import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  loadWorkspaceHints,
  prependAsPrompt,
  prependAsSystemMessage,
  writeWorkspaceHints,
} from '../loader.js';
import { ensureV2Directories } from '../../workspace/layout.js';
import type { ChatMessage } from '../../llm/providers/base.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-hints-'));
  await ensureV2Directories(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Workspace hints loader (4.1)', () => {
  it('reports absent when hints.md does not exist', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
    expect(h.sourcePath).toContain('hints.md');
  });

  it('reports absent for an empty/whitespace-only hints.md', async () => {
    await writeWorkspaceHints(tmp, '\n   \n');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.raw).not.toBe('');
    expect(h.normalized).toBe('');
  });

  it('loads and normalizes user-authored hints', async () => {
    await writeWorkspaceHints(
      tmp,
      '  # Directives\n\nCite en Chicago author-date.\n\n'
    );
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.normalized.startsWith('# Directives')).toBe(true);
    expect(h.normalized.endsWith('Chicago author-date.')).toBe(true);
  });

  it('prependAsPrompt is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(prependAsPrompt('Analyse X', h)).toBe('Analyse X');
  });

  it('prependAsPrompt wraps the prompt when hints present', async () => {
    await writeWorkspaceHints(tmp, 'Langue: français.');
    const h = await loadWorkspaceHints(tmp);
    const out = prependAsPrompt('Analyse X', h);
    expect(out).toContain('Langue: français.');
    expect(out).toContain('Analyse X');
    expect(out.indexOf('Langue: français.')).toBeLessThan(
      out.indexOf('Analyse X')
    );
  });

  it('prependAsSystemMessage is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(prependAsSystemMessage(msgs, h)).toBe(msgs);
  });

  it('prependAsSystemMessage prepends a fresh system message', async () => {
    await writeWorkspaceHints(tmp, 'Cite en Chicago.');
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Help' },
    ];
    const out = prependAsSystemMessage(msgs, h);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Cite en Chicago.');
    expect(out[1]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[1]);
  });
});
