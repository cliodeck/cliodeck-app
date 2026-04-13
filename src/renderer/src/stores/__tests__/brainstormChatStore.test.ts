import { describe, it, expect, beforeEach } from 'vitest';
import { useBrainstormChatStore } from '../brainstormChatStore';

beforeEach(() => {
  useBrainstormChatStore.getState().reset();
});

describe('brainstormChatStore (3.2)', () => {
  it('appendUser adds a user turn and returns its id', () => {
    const id = useBrainstormChatStore.getState().appendUser('Hi');
    const msgs = useBrainstormChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id, role: 'user', content: 'Hi' });
  });

  it('beginAssistant creates a pending assistant placeholder', () => {
    const aId = useBrainstormChatStore.getState().beginAssistant('sess-1');
    const s = useBrainstormChatStore.getState();
    expect(s.sessionId).toBe('sess-1');
    expect(s.pendingAssistantId).toBe(aId);
    const a = s.messages.find((m) => m.id === aId);
    expect(a).toMatchObject({ role: 'assistant', pending: true, content: '' });
  });

  it('appendDelta accumulates content into the right message', () => {
    const aId = useBrainstormChatStore.getState().beginAssistant('s');
    useBrainstormChatStore.getState().appendDelta(aId, 'Hello');
    useBrainstormChatStore.getState().appendDelta(aId, ', world');
    const a = useBrainstormChatStore
      .getState()
      .messages.find((m) => m.id === aId);
    expect(a?.content).toBe('Hello, world');
  });

  it('finishAssistant clears pending state and stores finishReason', () => {
    const aId = useBrainstormChatStore.getState().beginAssistant('s');
    useBrainstormChatStore.getState().appendDelta(aId, 'done');
    useBrainstormChatStore.getState().finishAssistant(aId, 'stop');
    const s = useBrainstormChatStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
    const a = s.messages.find((m) => m.id === aId);
    expect(a?.pending).toBe(false);
    expect(a?.finishReason).toBe('stop');
  });

  it('cancel marks the in-flight assistant as cancelled without losing prior text', () => {
    const aId = useBrainstormChatStore.getState().beginAssistant('s');
    useBrainstormChatStore.getState().appendDelta(aId, 'partial');
    useBrainstormChatStore.getState().cancel();
    const s = useBrainstormChatStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
    const a = s.messages.find((m) => m.id === aId);
    expect(a?.content).toBe('partial');
    expect(a?.finishReason).toBe('cancelled');
  });

  it('error from stream surfaces on the assistant turn', () => {
    const aId = useBrainstormChatStore.getState().beginAssistant('s');
    useBrainstormChatStore.getState().finishAssistant(aId, 'error', 'boom');
    const a = useBrainstormChatStore
      .getState()
      .messages.find((m) => m.id === aId);
    expect(a?.error).toBe('boom');
    expect(a?.finishReason).toBe('error');
  });

  it('reset clears everything', () => {
    useBrainstormChatStore.getState().appendUser('Hi');
    useBrainstormChatStore.getState().beginAssistant('s');
    useBrainstormChatStore.getState().reset();
    const s = useBrainstormChatStore.getState();
    expect(s.messages).toEqual([]);
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
  });
});
