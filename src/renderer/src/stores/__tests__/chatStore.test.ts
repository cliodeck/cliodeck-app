import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

beforeEach(() => {
  useChatStore.getState().reset();
});

describe('chatStore (fusion unified store)', () => {
  it('appendUser adds a user turn and returns its id', () => {
    const id = useChatStore.getState().appendUser('Hi');
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id, role: 'user', content: 'Hi' });
  });

  it('beginAssistant creates a pending assistant placeholder', () => {
    const aId = useChatStore.getState().beginAssistant('sess-1');
    const s = useChatStore.getState();
    expect(s.sessionId).toBe('sess-1');
    expect(s.pendingAssistantId).toBe(aId);
    const a = s.messages.find((m) => m.id === aId);
    expect(a).toMatchObject({ role: 'assistant', pending: true, content: '' });
  });

  it('appendDelta accumulates content into the right message', () => {
    const aId = useChatStore.getState().beginAssistant('s');
    useChatStore.getState().appendDelta(aId, 'Hello');
    useChatStore.getState().appendDelta(aId, ', world');
    const a = useChatStore
      .getState()
      .messages.find((m) => m.id === aId);
    expect(a?.content).toBe('Hello, world');
  });

  it('finishAssistant clears pending state and stores finishReason', () => {
    const aId = useChatStore.getState().beginAssistant('s');
    useChatStore.getState().appendDelta(aId, 'done');
    useChatStore.getState().finishAssistant(aId, 'stop');
    const s = useChatStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
    const a = s.messages.find((m) => m.id === aId);
    expect(a?.pending).toBe(false);
    expect(a?.finishReason).toBe('stop');
  });

  it('cancel marks the in-flight assistant as cancelled without losing prior text', () => {
    const aId = useChatStore.getState().beginAssistant('s');
    useChatStore.getState().appendDelta(aId, 'partial');
    useChatStore.getState().cancel();
    const s = useChatStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
    const a = s.messages.find((m) => m.id === aId);
    expect(a?.content).toBe('partial');
    expect(a?.finishReason).toBe('cancelled');
  });

  it('error from stream surfaces on the assistant turn', () => {
    const aId = useChatStore.getState().beginAssistant('s');
    useChatStore.getState().finishAssistant(aId, 'error', 'boom');
    const a = useChatStore
      .getState()
      .messages.find((m) => m.id === aId);
    expect(a?.error).toBe('boom');
    expect(a?.finishReason).toBe('error');
  });

  it('reset clears everything', () => {
    useChatStore.getState().appendUser('Hi');
    useChatStore.getState().beginAssistant('s');
    useChatStore.getState().reset();
    const s = useChatStore.getState();
    expect(s.messages).toEqual([]);
    expect(s.sessionId).toBeNull();
    expect(s.pendingAssistantId).toBeNull();
  });
});
