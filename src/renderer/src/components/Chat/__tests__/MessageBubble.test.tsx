// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
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
    expect(screen.getByText('👤')).toBeInTheDocument();
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
});
