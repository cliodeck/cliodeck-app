// @vitest-environment jsdom
/**
 * Une idée tapée juste avant `Cmd+Q` : seul le blur d'un champ sauvegardait, et quitter n'en
 * fait pas (mesuré dans l'app réelle : la frappe était perdue, à `Cmd+Q` comme à la croix).
 * Le filet de sortie écrit donc les idées avec le document, sous le même plafond, et son rapport
 * le dit : c'est sur lui que le main demande à l'auteur. Vrai store, écritures simulées derrière
 * l'IPC ; la vraie fenêtre est dans `e2e/journey-ideas-unreadable.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorFacade } from '@/editor/facade';
import { flushOpenDocument } from '../useSaveOnQuit';
import { useEditorStore } from '../../stores/editorStore';
import { useIdeaStore } from '../../stores/ideaStore';

const PROJECT = '/p';

let writes: string[];
let onWrite: () => Promise<unknown>;

const ideaStore = () => useIdeaStore.getState();

beforeEach(async () => {
  writes = [];
  onWrite = async () => ({ success: true });
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: async () => true,
      readUserFile: async () => ({ kind: 'ok', content: JSON.stringify({ ideas: [{ id: 'i1', title: 'Braudel' }] }) }),
      writeFile: async (_filePath: string, content: string) => {
        writes.push(content);
        return onWrite();
      },
    },
  };
  useEditorStore.setState({
    filePath: null,
    content: '',
    isDirty: false,
    switchLock: null,
    bufferDetached: true,
    editorFacade: null,
  });
  useIdeaStore.setState({
    ideas: [],
    isLoading: false,
    selectedId: null,
    persistence: { kind: 'ready' },
    loadedFor: null,
    saveError: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flushOpenDocument et les idées', () => {
  it('sans liste chargée (le Brainstorm jamais ouvert) : rien à écrire, et surtout rien à demander', async () => {
    expect(await flushOpenDocument()).toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });

  it('rien de modifié : aucune écriture', async () => {
    await ideaStore().loadIdeas(PROJECT);

    expect(await flushOpenDocument()).toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });

  it('une frappe sans blur part sur le disque avant la réponse au main', async () => {
    await ideaStore().loadIdeas(PROJECT);
    ideaStore().updateIdea('i1', { content: 'Tapé juste avant de quitter.' });

    expect(await flushOpenDocument()).toEqual({ outcome: 'clean' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Tapé juste avant de quitter.');
  });

  it("une écriture d'idées qui échoue se dit : le main demandera à l'auteur", async () => {
    await ideaStore().loadIdeas(PROJECT);
    ideaStore().updateIdea('i1', { content: 'À écrire.' });
    onWrite = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    const report = await flushOpenDocument();

    expect(report.outcome).toBe('failed');
    expect(report.error).toContain('ENOSPC');
    expect(report.stillWriting).toBeUndefined();
  });

  it('un document bien écrit ne fait pas oublier des idées qui échouent : `failed`, sans perdre le document', async () => {
    const saved: Array<[string, string]> = [];
    (window.electron as unknown as { editor: unknown }).editor = {
      saveFile: async (filePath: string, content: string) => {
        saved.push([filePath, content]);
        return { success: true };
      },
    };
    useEditorStore.setState({
      filePath: '/p/document.md',
      content: 'Texte.',
      bufferDetached: false,
      editorFacade: { getValue: () => 'Texte. Frappe.' } as unknown as EditorFacade,
    });
    await ideaStore().loadIdeas(PROJECT);
    ideaStore().updateIdea('i1', { content: 'À écrire.' });
    onWrite = async () => {
      throw new Error('ENOSPC: no space left on device, write');
    };

    const report = await flushOpenDocument();

    expect(saved).toEqual([['/p/document.md', 'Texte. Frappe.']]);
    expect(report.outcome).toBe('failed');
    expect(report.error).toContain('ENOSPC');
  });

  it('une écriture sans réponse ne retient pas la sortie : elle se dit sous le plafond', async () => {
    await ideaStore().loadIdeas(PROJECT);
    ideaStore().updateIdea('i1', { content: 'À écrire.' });
    let answer: (value: unknown) => void = () => undefined;
    onWrite = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    vi.useFakeTimers();

    const flushing = flushOpenDocument();
    await vi.advanceTimersByTimeAsync(3500);
    const report = await flushing;

    expect(report.outcome).toBe('failed');
    expect(report.error).toContain('pas répondu');
    // Lente, pas en échec : le main le dit autrement (D7).
    expect(report.stillWriting).toBe(true);

    // L'écriture finit par répondre : elle libère la file, et le texte est sur le disque.
    vi.useRealTimers();
    onWrite = async () => ({ success: true });
    answer({ success: true });
    await ideaStore().flushIdeas();
    expect(writes.at(-1)).toContain('À écrire.');
  });

  it('bloqué : rien à écrire, donc rien à demander', async () => {
    (window.electron.fs as { readUserFile: unknown }).readUserFile = async () => ({
      kind: 'unreadable',
      reason: 'io',
      message: 'ETIMEDOUT',
    });
    await ideaStore().loadIdeas(PROJECT);
    ideaStore().addIdea({ title: 'x', content: '', tags: [], links: [], origin: { type: 'manual' } });

    expect(await flushOpenDocument()).toEqual({ outcome: 'clean' });
    expect(writes).toEqual([]);
  });
});
