import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';
import { projectLifecycle } from '../../lifecycle/projectLifecycle';

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

  /**
   * La fin d'un tour effacé arrivait après l'envoi du suivant : elle remettait à zéro la session et
   * le message en cours, ceux du nouveau tour, qui perdait son bouton Stop (S16-1-3).
   */
  it('finishAssistant d’un message qui n’est pas en cours ne touche ni sessionId ni pendingAssistantId', () => {
    const s = useChatStore.getState();
    const old = s.beginAssistant('s1');
    const current = s.beginAssistant('s2');

    s.finishAssistant(old, 'stop');

    const after = useChatStore.getState();
    expect(after.sessionId).toBe('s2');
    expect(after.pendingAssistantId).toBe(current);
    expect(after.messages.find((m) => m.id === old)?.pending).toBe(false);
    expect(after.messages.find((m) => m.id === current)?.pending).toBe(true);
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

describe('chatStore.appendThinking', () => {
  it('accumule le raisonnement à part du contenu', () => {
    const s = useChatStore.getState();
    s.reset();
    const aId = s.beginAssistant('sess');
    s.appendThinking(aId, 'Je ');
    s.appendThinking(aId, 'réfléchis.');
    s.appendDelta(aId, 'Réponse.');
    const m = useChatStore.getState().messages.find((x) => x.id === aId);
    expect(m?.thinking).toBe('Je réfléchis.');
    expect(m?.content).toBe('Réponse.');
  });
});

/**
 * La conversation appartient au projet où elle a eu lieu (S16-1-22, décision Q11) : ouvrir un autre
 * projet la vide à l'écran, sans quoi elle repartait en historique dans les tours du suivant, et ses
 * sources s'ouvraient dans ses fichiers. Les réglages du chat, eux, restent.
 */
describe('chatStore — changement de projet', () => {
  it('après enter(B) : messages vides, tour en cours oublié, réglages conservés', () => {
    projectLifecycle.enter('/projets/A');
    const s = useChatStore.getState();
    s.setChatSettings({ modeId: 'free-mode', retrieval: { topK: 7 } });
    s.appendUser('Qui était le préfet en 1934 ?');
    s.beginAssistant('session-de-A');

    projectLifecycle.beginTransition();
    projectLifecycle.enter('/projets/B');

    const after = useChatStore.getState();
    expect(after.messages).toEqual([]);
    expect(after.sessionId).toBeNull();
    expect(after.pendingAssistantId).toBeNull();
    expect(after.chatSettings).toEqual({ modeId: 'free-mode', retrieval: { topK: 7 } });
  });

  it('le même projet rouvert garde la conversation', () => {
    projectLifecycle.enter('/projets/A');
    useChatStore.getState().appendUser('Une question');

    projectLifecycle.beginTransition();
    projectLifecycle.enter('/projets/A');

    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['Une question']);
  });
});
