// Theme-agnostic HTML helpers. Every theme imports these from core; no theme may import another theme's files.

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes arbitrary strings for safe interpolation into HTML text and attributes.
 */
export { parseMarkup, type MarkupNode } from './themes/markup.ts'

export function escapeHtml(str: string): string {
  if (str.length === 0) return ''
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch)
}
