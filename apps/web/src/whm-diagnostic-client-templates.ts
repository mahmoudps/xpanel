/// <reference lib="dom" />
import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode, clientTemplate as canonicalClientTemplate, cloneClientTemplate as canonicalCloneClientTemplate } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode
const clientTemplate = canonicalClientTemplate
const cloneClientTemplate = canonicalCloneClientTemplate

/** Semantic DOM contracts only. Each selected theme supplies the actual presentation. */
export const WHM_DIAGNOSTIC_NODE_TYPES = Object.freeze([
  ['article', 'article'], ['bdi', 'bdi'], ['button', 'button'], ['details', 'details'], ['div', 'div'], ['h3', 'h3'], ['h4', 'h4'], ['header', 'header'], ['input', 'input'], ['li', 'li'], ['p', 'p'], ['span', 'span'], ['summary', 'summary'], ['ul', 'ul'],
  ['account-health-row', 'article'], ['account-selection', 'div'], ['account-headline', 'span'], ['account-checks', 'ul'], ['account-check', 'li'], ['account-check-head', 'div'], ['account-items', 'ul'],
  ['server-health-item', 'li'], ['server-health-head', 'div'], ['server-health-items', 'ul'], ['repair-item', 'article'], ['repair-head', 'header'], ['alert-result', 'li'], ['alert-head', 'div'], ['alert-badges', 'span'],
  ['evidence', 'pre'], ['actions', 'div'], ['note', 'p'], ['note-item', 'li'], ['link', 'a'], ['action', 'button'], ['badge', 'span'], ['badge-ok', 'span'], ['badge-critical', 'span'], ['badge-warn', 'span'],
] as const)

export const WHM_DIAGNOSTIC_ROW_SHAPES = Object.freeze({
  'threshold-row': { tag: 'tr', slots: ['label', 'warning', 'problem'] },
  'limits-row': { tag: 'tr', slots: ['resource', 'plan', 'enforced', 'comparison', 'usage', 'percent'] },
  'limits-table': { tag: 'div', slots: ['heading-resource', 'heading-plan', 'heading-enforced', 'heading-comparison', 'heading-usage', 'heading-percent', 'rows'] },
  'alert-delivery-row': { tag: 'tr', slots: ['at', 'rule', 'kind', 'channel', 'result'] },
  'alert-delivery-empty': { tag: 'tr', slots: ['message'] },
} as const)

export function whmDiagnosticNode<K extends keyof HTMLElementTagNameMap>(root: HTMLElement, tag: K, value?: string, name?: string): HTMLElementTagNameMap[K] {
  const semantic = name ?? tag
  if (!WHM_DIAGNOSTIC_NODE_TYPES.some(([key, expected]) => key === semantic && expected === tag)) throw new Error('invalid_diagnostic_node')
  return whmClientNode(root, 'whm-diagnostic-' + semantic, tag, value)
}

export function whmDiagnosticTemplate(root: HTMLElement, name: keyof typeof WHM_DIAGNOSTIC_ROW_SHAPES): HTMLElement {
  const shape = WHM_DIAGNOSTIC_ROW_SHAPES[name]
  return cloneClientTemplate(clientTemplate(root, 'whm-diagnostic-' + name), shape.tag, shape.slots)
}

/** Fail before any request if a selected theme's required dynamic markup cannot be verified. */
export function assertWhmDiagnosticTemplates(root: HTMLElement): void {
  for (const [name, tag] of WHM_DIAGNOSTIC_NODE_TYPES) {
    const node = whmClientNode(root, 'whm-diagnostic-' + name, tag)
    if (tag === 'input' && (node as HTMLInputElement).type !== 'checkbox') throw new Error('invalid_diagnostic_selection')
  }
  for (const name of Object.keys(WHM_DIAGNOSTIC_ROW_SHAPES)) whmDiagnosticTemplate(root, name as keyof typeof WHM_DIAGNOSTIC_ROW_SHAPES)
}

export const WHM_DIAGNOSTIC_TEMPLATE_BINDING = `${WHM_CLIENT_TEMPLATE_BINDING};const WHM_DIAGNOSTIC_NODE_TYPES=${JSON.stringify(WHM_DIAGNOSTIC_NODE_TYPES)};const WHM_DIAGNOSTIC_ROW_SHAPES=${JSON.stringify(WHM_DIAGNOSTIC_ROW_SHAPES)};const whmDiagnosticNode=${whmDiagnosticNode.toString()};const whmDiagnosticTemplate=${whmDiagnosticTemplate.toString()};const assertWhmDiagnosticTemplates=${assertWhmDiagnosticTemplates.toString()};`
