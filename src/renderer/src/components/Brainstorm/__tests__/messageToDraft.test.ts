import { describe, it, expect } from 'vitest';
import { appendDraftToContent, messageToDraft } from '../messageToDraft';

describe('messageToDraft (3.3)', () => {
  it('formats an assistant turn with markers', () => {
    const out = messageToDraft(
      { id: 'a-1', role: 'assistant', content: 'Hello world.' },
      { at: '2026-04-13T12:00:00Z' }
    );
    expect(out).toContain('<!-- cliodeck:brainstorm-draft id="a-1"');
    expect(out).toContain('at="2026-04-13T12:00:00Z"');
    expect(out).toContain('Hello world.');
    expect(out.endsWith('<!-- /cliodeck:brainstorm-draft -->')).toBe(true);
  });

  it('appends a Sources section with quoted citations', () => {
    const out = messageToDraft(
      { id: 'a-1', role: 'assistant', content: 'Analysis.' },
      {
        at: '2026-04-13T00:00:00Z',
        citations: [
          {
            sourceId: 'zotero:ABCD',
            label: 'De Gaulle, Mémoires (1954)',
            quote: 'Toute ma vie, je me suis fait\nune certaine idée…',
          },
          { sourceId: 'obsidian:Notes/Vichy.md', label: 'Vichy note' },
        ],
      }
    );
    expect(out).toContain('**Sources**');
    expect(out).toContain('- `zotero:ABCD` — De Gaulle, Mémoires (1954)');
    expect(out).toContain('  > Toute ma vie, je me suis fait');
    expect(out).toContain('  > une certaine idée…');
    expect(out).toContain('- `obsidian:Notes/Vichy.md` — Vichy note');
  });

  it('refuses non-assistant turns', () => {
    expect(() =>
      messageToDraft({ id: 'u', role: 'user', content: 'x' })
    ).toThrow(/assistant/);
  });

  it('appendDraftToContent inserts blank-line separator', () => {
    expect(appendDraftToContent('', 'X')).toBe('X');
    expect(appendDraftToContent('A', 'B')).toBe('A\n\nB\n');
    // single trailing newline: pad to a blank line before draft
    expect(appendDraftToContent('A\n', 'B')).toBe('A\n\nB\n');
    // already has a blank line: no extra padding needed
    expect(appendDraftToContent('A\n\n', 'B')).toBe('A\n\nB\n');
  });
});
