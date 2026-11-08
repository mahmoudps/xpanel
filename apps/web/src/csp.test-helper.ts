// Test helper: markup a document policy would block. Product code does not import it.
import { parseMarkup } from './themes/markup.ts'

const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster']
const foreign = (value: string | undefined): boolean => value !== undefined && /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)

/** Inline scripts, inline handlers, javascript: URLs, <base>, plugins and foreign subresources, one line each. */
export function cspMarkupIssues(html: string): string[] {
  const issues: string[] = []
  for (const node of parseMarkup(html)) {
    const where = `${node.tag}${node.attrs.get('id') ? '#' + node.attrs.get('id') : ''}`
    for (const [name, value] of node.attrs) {
      if (/^on[a-z]+$/i.test(name)) issues.push(`inline handler ${name} on ${where}`)
      if (URL_ATTRIBUTES.includes(name) && /^\s*javascript:/i.test(value)) issues.push(`javascript: URL in ${name} on ${where}`)
    }
    if (node.namespace !== 'html') continue
    const src = node.attrs.get('src')
    if (node.tag === 'script' && src === undefined && node.attrs.get('type') !== 'application/json') issues.push(`inline script ${where}`)
    if (node.tag === 'script' && src !== undefined && !src.startsWith('/assets/')) issues.push(`script source ${src}`)
    if (node.tag === 'base' || node.tag === 'object' || node.tag === 'embed') issues.push(`<${node.tag}>`)
    if (['img', 'iframe', 'video', 'audio', 'source', 'script'].includes(node.tag) && foreign(src)) issues.push(`foreign ${node.tag} ${src}`)
    if (node.tag === 'link' && /\bstylesheet\b/.test(node.attrs.get('rel') ?? '') && foreign(node.attrs.get('href'))) issues.push(`foreign stylesheet ${node.attrs.get('href')}`)
    if (node.tag === 'form' && foreign(node.attrs.get('action'))) issues.push(`foreign form action ${node.attrs.get('action')}`)
  }
  return issues
}
