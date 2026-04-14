// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MessageInput } from '../MessageInput';

function setup(overrides: Partial<React.ComponentProps<typeof MessageInput>> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const props = {
    value: '',
    onChange,
    onSend,
    onCancel,
    isProcessing: false,
    ...overrides,
  };
  const utils = render(<MessageInput {...props} />);
  return { ...utils, onChange, onSend, onCancel };
}

describe('MessageInput', () => {
  it('renders default placeholder (falls back to translation key)', () => {
    setup();
    // i18n mock returns the key when no fallback is passed.
    expect(screen.getByPlaceholderText('chat.placeholder')).toBeInTheDocument();
  });

  it('renders the placeholder override', () => {
    setup({ placeholder: 'Ask me anything' });
    expect(screen.getByPlaceholderText('Ask me anything')).toBeInTheDocument();
  });

  it('calls onChange when the user types', () => {
    const { onChange } = setup();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledWith('hi');
  });

  it('Cmd+Enter triggers onSend, bare Enter does not', () => {
    const { onSend } = setup({ value: 'hello' });
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Enter triggers onSend', () => {
    const { onSend } = setup({ value: 'hello' });
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('disables textarea and shows cancel button when isProcessing', () => {
    const { onCancel } = setup({ isProcessing: true, value: 'hi' });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    const cancelBtn = screen.getByRole('button', { name: 'chat.cancel' });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('send button is disabled when value is empty', () => {
    setup({ value: '' });
    const sendBtn = screen.getByRole('button', { name: 'chat.send' }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });
});
