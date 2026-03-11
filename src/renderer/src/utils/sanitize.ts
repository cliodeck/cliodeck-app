import DOMPurify from 'dompurify';

/**
 * DOMPurify configuration for chat messages (assistant responses).
 * Allows standard markdown-generated HTML tags but strips scripts and event handlers.
 */
const CHAT_PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li',
    'code', 'pre',
    'a',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'del', 'sup', 'sub',
    'span', 'div',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
};

/**
 * DOMPurify configuration for markdown preview (editor content).
 * Slightly more permissive to allow images in user content.
 */
const PREVIEW_PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    ...CHAT_PURIFY_CONFIG.ALLOWED_TAGS!,
    'img',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'title', 'width', 'height'],
};

/**
 * Sanitize HTML output from markdown parsing for chat messages.
 */
export function sanitizeChat(html: string): string {
  return DOMPurify.sanitize(html, CHAT_PURIFY_CONFIG);
}

/**
 * Sanitize HTML output from markdown parsing for editor preview.
 */
export function sanitizePreview(html: string): string {
  return DOMPurify.sanitize(html, PREVIEW_PURIFY_CONFIG);
}
