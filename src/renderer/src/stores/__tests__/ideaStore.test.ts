import { describe, it, expect, beforeEach } from 'vitest';
import { useIdeaStore } from '../ideaStore';

beforeEach(() => {
  useIdeaStore.setState({ ideas: [], isLoading: false, selectedId: null });
});

describe('ideaStore', () => {
  it('starts empty', () => {
    expect(useIdeaStore.getState().ideas).toEqual([]);
  });

  it('addIdea creates an idea with generated id and timestamps', () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'Dreyfus hypothesis',
      content: 'The press coverage shifted after Zola\'s J\'accuse',
      tags: ['dreyfus', 'press'],
      links: [],
      origin: { type: 'manual' },
    });

    const { ideas } = useIdeaStore.getState();
    expect(ideas).toHaveLength(1);
    expect(ideas[0].id).toBe(id);
    expect(ideas[0].title).toBe('Dreyfus hypothesis');
    expect(ideas[0].tags).toEqual(['dreyfus', 'press']);
    expect(ideas[0].createdAt).toBeTruthy();
    expect(ideas[0].updatedAt).toBe(ideas[0].createdAt);
  });

  it('updateIdea patches fields and bumps updatedAt', async () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'Original',
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
    });

    const before = useIdeaStore.getState().ideas[0].updatedAt;
    // Tiny delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));

    useIdeaStore.getState().updateIdea(id, { title: 'Updated', content: 'New content' });

    const updated = useIdeaStore.getState().ideas[0];
    expect(updated.title).toBe('Updated');
    expect(updated.content).toBe('New content');
    expect(updated.updatedAt).not.toBe(before);
  });

  it('removeIdea removes by id and clears selection if needed', () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'To delete',
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
    });
    useIdeaStore.getState().setSelected(id);
    expect(useIdeaStore.getState().selectedId).toBe(id);

    useIdeaStore.getState().removeIdea(id);
    expect(useIdeaStore.getState().ideas).toHaveLength(0);
    expect(useIdeaStore.getState().selectedId).toBeNull();
  });

  it('addLink / removeLink manages links on an idea', () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'Source idea',
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
    });

    useIdeaStore.getState().addLink(id, {
      targetId: 'citation_123',
      targetType: 'citation',
      label: 'supports',
    });

    expect(useIdeaStore.getState().ideas[0].links).toHaveLength(1);
    expect(useIdeaStore.getState().ideas[0].links[0].targetId).toBe('citation_123');

    useIdeaStore.getState().removeLink(id, 'citation_123');
    expect(useIdeaStore.getState().ideas[0].links).toHaveLength(0);
  });

  it('addTag / removeTag manages tags', () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'Tagged',
      content: '',
      tags: ['history'],
      links: [],
      origin: { type: 'manual' },
    });

    useIdeaStore.getState().addTag(id, 'digital');
    expect(useIdeaStore.getState().ideas[0].tags).toEqual(['history', 'digital']);

    // Duplicate tag is ignored
    useIdeaStore.getState().addTag(id, 'history');
    expect(useIdeaStore.getState().ideas[0].tags).toEqual(['history', 'digital']);

    useIdeaStore.getState().removeTag(id, 'history');
    expect(useIdeaStore.getState().ideas[0].tags).toEqual(['digital']);
  });

  it('getAllTags returns sorted deduplicated tags', () => {
    useIdeaStore.getState().addIdea({
      title: 'A',
      content: '',
      tags: ['zola', 'press'],
      links: [],
      origin: { type: 'manual' },
    });
    useIdeaStore.getState().addIdea({
      title: 'B',
      content: '',
      tags: ['press', 'antisemitism'],
      links: [],
      origin: { type: 'manual' },
    });

    expect(useIdeaStore.getState().getAllTags()).toEqual([
      'antisemitism',
      'press',
      'zola',
    ]);
  });

  it('tracks chat origin', () => {
    useIdeaStore.getState().addIdea({
      title: 'From chat',
      content: 'Some AI-generated insight',
      tags: [],
      links: [],
      origin: { type: 'chat', sessionId: 'sess_1', messageId: 'msg_42' },
    });

    const idea = useIdeaStore.getState().ideas[0];
    expect(idea.origin).toEqual({
      type: 'chat',
      sessionId: 'sess_1',
      messageId: 'msg_42',
    });
  });

  it('stores position for canvas layout', () => {
    const id = useIdeaStore.getState().addIdea({
      title: 'Positioned',
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
      position: { x: 100, y: 200 },
    });

    expect(useIdeaStore.getState().ideas[0].position).toEqual({ x: 100, y: 200 });

    useIdeaStore.getState().updateIdea(id, { position: { x: 300, y: 400 } });
    expect(useIdeaStore.getState().ideas[0].position).toEqual({ x: 300, y: 400 });
  });
});
