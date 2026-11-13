// A flat element outline of server-rendered HTML and the hook selectors matched against it. Pure, no DOM: the
// conformance check and the route-hook generator share it.

/** A semantic selector used by a controller: data hooks, named fields, roles or an element id. */
export type HookSelector = `[data-${string}]` | '[name]' | `[name="${string}"]` | '[role]' | `[role="${string}"]` | `#${string}`
export type MarkupNamespace = 'html' | 'svg' | 'mathml'

export interface MarkupNode {
  readonly tag: string
  readonly namespace: MarkupNamespace
  readonly attrs: ReadonlyMap<string, string>
  /** Index of the parent node, or -1 at the top level. */
  readonly parent: number
  /** Index of the nearest `<template>` ancestor, or -1 when the node is live markup. */
  readonly template: number
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript'])
const CLOSING_TAGS: Readonly<Record<string, RegExp>> = {
  script: /<\/script(?=[\t\n\f\r />])/ig,
  style: /<\/style(?=[\t\n\f\r />])/ig,
  textarea: /<\/textarea(?=[\t\n\f\r />])/ig,
  title: /<\/title(?=[\t\n\f\r />])/ig,
  noscript: /<\/noscript(?=[\t\n\f\r />])/ig,
}
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const SVG_HTML_POINTS = new Set(['foreignobject', 'desc', 'title'])
const MATH_TEXT_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])
const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const ENTITY: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }
const decode = (value: string): string => value.includes('&') ? value.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITY[name]!) : value
const nodeSpans = new WeakMap<MarkupNode, { readonly start: number; readonly openEnd: number }>()
const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map()
let cachedHtmlA = ''
let cachedNodesA: readonly MarkupNode[] | undefined
let cachedHtmlB = ''
let cachedNodesB: readonly MarkupNode[] | undefined

export const markupNodeSpan = (node: MarkupNode): { readonly start: number; readonly openEnd: number } | undefined => nodeSpans.get(node)

export const isHtmlElement = (node: MarkupNode, tag?: string): boolean =>
  node.namespace === 'html' && (tag === undefined || node.tag === tag)

function childNamespace(tag: string, parent?: MarkupNode): MarkupNamespace {
  if (!parent) return tag === 'svg' ? 'svg' : tag === 'math' ? 'mathml' : 'html'
  const htmlContext = parent.namespace === 'html'
    || parent.namespace === 'svg' && SVG_HTML_POINTS.has(parent.tag)
    || parent.namespace === 'mathml' && (
      MATH_TEXT_POINTS.has(parent.tag) && tag !== 'mglyph' && tag !== 'malignmark'
      || parent.tag === 'annotation-xml' && ['text/html', 'application/xhtml+xml'].includes((parent.attrs.get('encoding') ?? '').toLowerCase())
    )
  if (htmlContext) return tag === 'svg' ? 'svg' : tag === 'math' ? 'mathml' : 'html'
  if (parent.namespace === 'mathml' && parent.tag === 'annotation-xml' && tag === 'svg') return 'svg'
  return parent.namespace
}

/** A flat element outline of server-rendered HTML: tags, attributes and nesting. Script, style, textarea and
 *  title and scripting-enabled noscript contents are skipped; HTML template contents are parsed and marked.
 *  Foreign content retains its namespace, including HTML integration points. Enough to check hooks, not a full
 *  HTML parser: implied end tags are closed at the next matching end tag. */
export function parseMarkup(html: string): MarkupNode[] {
  if (cachedNodesA !== undefined && html === cachedHtmlA) return cachedNodesA.slice()
  if (cachedNodesB !== undefined && html === cachedHtmlB) return cachedNodesB.slice()
  const nodes: MarkupNode[] = []
  const open: number[] = []
  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
    const [, endTag, startTag, rawAttrs = '', selfClosing] = match
    if (endTag) {
      const tag = endTag.toLowerCase()
      const at = open.findLastIndex(index => nodes[index]!.tag === tag)
      if (at >= 0) open.length = at
      continue
    }
    if (!startTag) continue
    const start = match.index
    const openEnd = TOKEN.lastIndex
    const tag = startTag.toLowerCase()
    let attrs: ReadonlyMap<string, string> = EMPTY_ATTRS
    if (rawAttrs) {
      let mutable: Map<string, string> | undefined
      ATTRIBUTE.lastIndex = 0
      for (let attribute = ATTRIBUTE.exec(rawAttrs); attribute; attribute = ATTRIBUTE.exec(rawAttrs)) {
        const name = attribute[1]!.toLowerCase()
        mutable ??= new Map<string, string>()
        if (!mutable.has(name)) mutable.set(name, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''))
      }
      if (mutable) attrs = mutable
    }
    const parent = open.at(-1) ?? -1
    const parentNode = parent < 0 ? undefined : nodes[parent]!
    const namespace = childNamespace(tag, parentNode)
    const template = parentNode === undefined ? -1 : isHtmlElement(parentNode, 'template') ? parent : parentNode.template
    const node: MarkupNode = { tag, namespace, attrs, parent, template }
    nodeSpans.set(node, { start, openEnd })
    nodes.push(node)
    if (namespace === 'html' && RAW_TEXT.has(tag) || tag === 'script' || tag === 'style') {
      const closing = CLOSING_TAGS[tag] ?? new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, 'ig')
      closing.lastIndex = TOKEN.lastIndex
      TOKEN.lastIndex = closing.exec(html)?.index ?? html.length
    } else if (!(namespace === 'html' && VOID.has(tag)) && !selfClosing) open.push(nodes.length - 1)
  }
  cachedHtmlB = cachedHtmlA
  cachedNodesB = cachedNodesA
  cachedHtmlA = html
  cachedNodesA = nodes
  return nodes.slice()
}

const SELECTOR = /^(?:#([\w-]+)|\[(data-[a-z0-9]+(?:-[a-z0-9]+)*|name|role)(?:="([^"]*)")?\])$/
const parsedSelectors = new Map<string, RegExpExecArray>()

/** Whether one node matches a hook selector. */
export function matchesHook(node: MarkupNode, selector: HookSelector): boolean {
  let parts = parsedSelectors.get(selector)
  if (!parts) {
    const parsed = SELECTOR.exec(selector)
    if (!parsed) throw new Error(`Unsupported hook selector: ${selector}`)
    parsedSelectors.set(selector, parts = parsed)
  }
  const [, id, name, value] = parts
  if (id !== undefined) return node.attrs.get('id') === id
  return value === undefined ? node.attrs.has(name!) : node.attrs.get(name!) === value
}
