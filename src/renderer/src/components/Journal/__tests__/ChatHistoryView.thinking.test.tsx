// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatHistoryView } from '../ChatHistoryView';

afterEach(() => cleanup());

describe('ChatHistoryView — raisonnement conservé au journal', () => {
  it('affiche le raisonnement replié, à part de la réponse', () => {
    render(
      <ChatHistoryView
        messages={[
          { id: 'u', sessionId: 's', role: 'user', content: 'Question', timestamp: new Date() },
          { id: 'a', sessionId: 's', role: 'assistant', content: 'Réponse.', thinking: 'Je pèse les sources…', timestamp: new Date() },
        ]}
      />
    );
    const details = document.querySelector('details.message-thinking');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent).toContain('chat.thinkingBlock');
    expect(details?.querySelector('pre')?.textContent).toBe('Je pèse les sources…');
    expect(screen.getByText('Réponse.')).toBeTruthy();
  });

  it('n’affiche rien de tel pour un message sans raisonnement', () => {
    render(
      <ChatHistoryView
        messages={[{ id: 'a', sessionId: 's', role: 'assistant', content: 'Réponse.', timestamp: new Date() }]}
      />
    );
    expect(document.querySelector('details.message-thinking')).toBeNull();
  });
});
