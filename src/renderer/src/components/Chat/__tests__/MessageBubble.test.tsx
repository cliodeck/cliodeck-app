// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../MessageBubble';
import type { UnifiedMessage } from '../types';

const baseMsg = (overrides: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: '1',
  role: 'user',
  content: 'hello',
  ...overrides,
});

describe('MessageBubble', () => {
  it('renders a user message with avatar and plain paragraph (no markdown)', () => {
    const { container } = render(
      <MessageBubble message={baseMsg({ role: 'user', content: '**not bold**' })} />,
    );
    expect(container.querySelector('.message-avatar svg')).not.toBeNull();
    // User content is rendered in a <p>, literally (markdown not parsed).
    const p = container.querySelector('.message-content p');
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe('**not bold**');
    expect(container.querySelector('.message-content strong')).toBeNull();
  });

  it('renders an assistant message with markdown (bold → <strong>)', () => {
    const { container } = render(
      <MessageBubble
        message={baseMsg({ id: '2', role: 'assistant', content: 'this is **bold**' })}
      />,
    );
    const strong = container.querySelector('.message-content strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('bold');
  });

  it('shows the timestamp when provided', () => {
    const ts = new Date('2026-04-14T10:30:00');
    const { container } = render(
      <MessageBubble message={baseMsg({ timestamp: ts })} />,
    );
    const time = container.querySelector('.message-time');
    expect(time).not.toBeNull();
    expect(time?.textContent).toMatch(/10.?30/);
  });

  it('shows streaming indicator when isStreaming prop is true', () => {
    const { container } = render(
      <MessageBubble message={baseMsg({ role: 'assistant', content: 'x' })} isStreaming />,
    );
    expect(container.querySelector('.streaming-indicator')).not.toBeNull();
  });

  it('shows streaming indicator when message.pending is true', () => {
    const { container } = render(
      <MessageBubble message={baseMsg({ role: 'assistant', content: 'x', pending: true })} />,
    );
    expect(container.querySelector('.streaming-indicator')).not.toBeNull();
  });

  it('shows badge text when provided', () => {
    render(<MessageBubble message={baseMsg({ badge: 'Brainstorm' })} />);
    expect(screen.getByText('Brainstorm')).toBeInTheDocument();
  });

  it('renders extras slot below content', () => {
    render(
      <MessageBubble
        message={baseMsg()}
        extras={<div data-testid="extras-slot">sources</div>}
      />,
    );
    expect(screen.getByTestId('extras-slot')).toBeInTheDocument();
  });

  // S05-1-7 : une réponse arrêtée par la limite de longueur du modèle le dit.
  describe('réponse tronquée', () => {
    it('finishReason length : la ligne chat.truncated s’affiche, avec son icône', () => {
      const { container } = render(
        <MessageBubble
          message={baseMsg({ id: 't', role: 'assistant', content: 'Première partie', finishReason: 'length' })}
        />,
      );
      const line = screen.getByText('chat.truncated');
      expect(line).toBeInTheDocument();
      expect(container.querySelector('.message-truncated svg')).not.toBeNull();
    });

    it.each(['stop', 'error', 'cancelled', undefined])('finishReason %s : aucune ligne', (finishReason) => {
      render(
        <MessageBubble
          message={baseMsg({ id: 't', role: 'assistant', content: 'Réponse', finishReason })}
        />,
      );
      expect(screen.queryByText('chat.truncated')).toBeNull();
    });
  });

  it('renders the … placeholder for pending assistant message with empty content', () => {
    const { container } = render(
      <MessageBubble
        message={baseMsg({ id: '3', role: 'assistant', content: '', pending: true })}
      />,
    );
    const md = container.querySelector('.message-markdown');
    expect(md?.textContent).toBe('…');
  });

  it('sanitizes <script> tags out of assistant content', () => {
    const { container } = render(
      <MessageBubble
        message={baseMsg({
          id: '4',
          role: 'assistant',
          content: 'safe <script>alert(1)</script> tail',
        })}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
  });

  // S16-1-29 : une réponse faite uniquement de balises interdites sort vide de
  // DOMPurify ; le repli injectait alors le contenu brut comme HTML. La
  // réponse doit rester du texte échappé, jamais du balisage actif.
  describe('réponse entièrement filtrée par l\'assainissement', () => {
    const STYLE = '<style>body{display:none}</style>';

    const renderAssistant = (
      content: string,
      extra: Partial<UnifiedMessage> = {},
      enableNER = false,
    ) =>
      render(
        <MessageBubble
          message={baseMsg({ id: 'f', role: 'assistant', content, ...extra })}
          enableNER={enableNER}
        />,
      );

    it.each([STYLE, `${STYLE}\n`])(
      'n\'injecte aucun <style> et montre le texte échappé (%j)',
      (content) => {
        const before = getComputedStyle(document.body).display;
        const { container } = renderAssistant(content);
        expect(container.querySelector('style')).toBeNull();
        expect(document.querySelector('style')).toBeNull();
        expect(getComputedStyle(document.body).display).toBe(before);
        const md = container.querySelector('.message-markdown');
        expect(md?.textContent).toBe(content);
      },
    );

    it.each([
      ['meta', '<meta http-equiv="refresh" content="0;url=https://exemple.invalid/">'],
      ['img', '<img src=x onerror=alert(1)>'],
      ['iframe', '<iframe></iframe>'],
    ])('n\'injecte aucun élément %s', (tag, content) => {
      const { container } = renderAssistant(content);
      const md = container.querySelector('.message-markdown');
      expect(md?.querySelector(tag)).toBeNull();
      expect(md?.textContent).toBe(content);
    });

    it('garde ces garanties pendant le flux, balise non fermée, NER actif', () => {
      const content = '<style>body{display:none}';
      const before = getComputedStyle(document.body).display;
      const { container } = renderAssistant(content, { pending: true }, true);
      expect(document.querySelector('style')).toBeNull();
      expect(getComputedStyle(document.body).display).toBe(before);
      expect(container.querySelector('.message-markdown')?.textContent).toBe(content);
    });

    it('garde ces garanties une fois la réponse finie, NER actif', () => {
      const { container } = renderAssistant(STYLE, {}, true);
      expect(document.querySelector('style')).toBeNull();
      expect(container.querySelector('.message-markdown')?.textContent).toBe(STYLE);
    });
  });
});
