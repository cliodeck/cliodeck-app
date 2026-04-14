// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChatSurface } from '../ChatSurface';
import type { UnifiedMessage } from '../types';

const mk = (overrides: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
  id: 'm1',
  role: 'user',
  content: 'hello',
  ...overrides,
});

describe('ChatSurface', () => {
  it('renders the title in the header', () => {
    render(
      <ChatSurface
        title="My Chat"
        messages={[]}
        isProcessing={false}
        onSend={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: 'My Chat' })).toBeInTheDocument();
  });

  it('shows empty state when no messages, not processing, no streaming', () => {
    render(
      <ChatSurface
        messages={[]}
        isProcessing={false}
        onSend={() => undefined}
        emptyState={<div data-testid="empty">nothing here</div>}
      />,
    );
    expect(screen.getByTestId('empty')).toBeInTheDocument();
  });

  it('clear button calls onClear when clicked, disabled when no messages', () => {
    const onClear = vi.fn();
    const { rerender, container } = render(
      <ChatSurface
        title="t"
        messages={[]}
        isProcessing={false}
        onSend={() => undefined}
        onClear={onClear}
      />,
    );
    const btn = container.querySelector('.chat-surface__header-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    rerender(
      <ChatSurface
        title="t"
        messages={[mk()]}
        isProcessing={false}
        onSend={() => undefined}
        onClear={onClear}
      />,
    );
    const btn2 = container.querySelector('.chat-surface__header-btn') as HTMLButtonElement;
    expect(btn2.disabled).toBe(false);
    fireEvent.click(btn2);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders banner when provided', () => {
    render(
      <ChatSurface
        messages={[mk()]}
        isProcessing={false}
        onSend={() => undefined}
        banner={<div data-testid="banner">heads up</div>}
      />,
    );
    expect(screen.getByTestId('banner')).toBeInTheDocument();
  });

  it('renders header extras slot', () => {
    render(
      <ChatSurface
        title="t"
        messages={[]}
        isProcessing={false}
        onSend={() => undefined}
        headerExtras={<div data-testid="hx">mode</div>}
      />,
    );
    expect(screen.getByTestId('hx')).toBeInTheDocument();
  });

  it('streamingContent triggers a virtual streaming bubble at the end', () => {
    const { container } = render(
      <ChatSurface
        messages={[mk({ id: 'a', role: 'user', content: 'hi' })]}
        isProcessing={true}
        streamingContent="partial response"
        onSend={() => undefined}
      />,
    );
    const bubbles = container.querySelectorAll('.message-bubble');
    expect(bubbles.length).toBe(2);
    const last = bubbles[bubbles.length - 1];
    expect(last.textContent).toContain('partial response');
    expect(last.querySelector('.streaming-indicator')).not.toBeNull();
  });

  it('invokes renderMessageExtras per message and renders returned node', () => {
    const renderMessageExtras = vi.fn((m: UnifiedMessage) => (
      <div data-testid={`x-${m.id}`}>extra-{m.id}</div>
    ));
    render(
      <ChatSurface
        messages={[mk({ id: 'a' }), mk({ id: 'b', content: 'second' })]}
        isProcessing={false}
        onSend={() => undefined}
        renderMessageExtras={renderMessageExtras}
      />,
    );
    expect(renderMessageExtras).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('x-a')).toBeInTheDocument();
    expect(screen.getByTestId('x-b')).toBeInTheDocument();
  });

  it('sending via composer (Cmd+Enter) calls onSend with trimmed value then clears input', async () => {
    const onSend = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        isProcessing={false}
        onSend={onSend}
        emptyState={<div>empty</div>}
      />,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '  hello world  ' } });
    expect(textarea.value).toBe('  hello world  ');
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    // Allow microtask for async handleSend.
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith('hello world');
    expect(textarea.value).toBe('');
  });
});
