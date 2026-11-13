// Test helper: markup a document policy would block. Product code does not import it.
import { parseMarkup } from './themes/markup.ts'

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster'])
const FOREIGN_SRC_TAGS = new Set(['img', 'iframe', 'video', 'audio', 'source', 'script'])
const foreign = (value: string | undefined): boolean => value !== undefined && /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)

/** Inline scripts, inline handlers, javascript: URLs, <base>, plugins and foreign subresources, one line each. */
export function cspMarkupIssues(html: string, parsedNodes?: ReturnType<typeof parseMarkup>): string[] {
  const issues: string[] = []
  const nodes = parsedNodes ?? parseMarkup(html)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const attrs = node.attrs
    if (attrs.size > 0) {
      for (const [name, value] of attrs) {
        const c0 = name.charCodeAt(0)
        if ((c0 === 111 || c0 === 79) && name.length > 2 && /^on[a-z]+$/i.test(name)) {
          issues.push(`inline handler ${name} on ${node.tag}${attrs.get('id') ? '#' + attrs.get('id') : ''}`)
        }
        if (URL_ATTRIBUTES.has(name) && value.length >= 11 && /^\s*javascript:/i.test(value)) {
          issues.push(`javascript: URL in ${name} on ${node.tag}${attrs.get('id') ? '#' + attrs.get('id') : ''}`)
        }
      }
    }
    if (node.namespace !== 'html') continue
    const tag = node.tag
    const src = attrs.get('src')
    if (tag === 'script') {
      if (src === undefined && attrs.get('type') !== 'application/json') {
        issues.push(`inline script ${tag}${attrs.get('id') ? '#' + attrs.get('id') : ''}`)
      }
      if (src !== undefined && !src.startsWith('/assets/')) issues.push(`script source ${src}`)
    } else if (tag === 'base' || tag === 'object' || tag === 'embed') {
      issues.push(`<${tag}>`)
    }
    if (src !== undefined && FOREIGN_SRC_TAGS.has(tag) && foreign(src)) issues.push(`foreign ${tag} ${src}`)
    if (tag === 'link' && /\bstylesheet\b/.test(attrs.get('rel') ?? '') && foreign(attrs.get('href'))) issues.push(`foreign stylesheet ${attrs.get('href')}`)
    if (tag === 'form' && attrs.has('action') && foreign(attrs.get('action'))) issues.push(`foreign form action ${attrs.get('action')}`)
  }
  return issues
}
