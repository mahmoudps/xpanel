import { isHtmlElement, type MarkupNode } from './markup.ts'

export type AttributePredicate = string | boolean | { readonly not: string } | { readonly oneOf: readonly string[] }
export type AttributePredicates = Readonly<Record<string, AttributePredicate>>
export type ControllerFact = 'present' | 'absent'
export interface ControllerContext {
  readonly route?: string
  readonly surface?: 'login' | 'xpanel' | 'xwhm' | 'xmail'
  readonly qualified?: boolean
  readonly loginAudience?: string
  readonly facts?: Readonly<Record<string, ControllerFact>>
}
export interface RouteScope {
  readonly kind: 'all' | 'authenticated' | 'non-login-non-error-documents' | 'login-surface'
  readonly surfaces?: readonly string[]
  readonly audiences?: readonly string[]
}
export interface LookupScope {
  readonly kind: 'descendant' | 'closest' | 'document'
  readonly selector?: string
}
export interface ConditionalRequirement {
  readonly id?: string
  readonly rootSelector?: string
  readonly rootRequired?: boolean
  readonly applicableRoutes?: readonly string[]
  readonly rootAttributes?: AttributePredicates
  readonly rootAttributeExclusions?: AttributePredicates
  readonly documentAttributes?: AttributePredicates
  readonly contextFacts?: Readonly<Record<string, ControllerFact>>
  readonly whenScopeMounted?: string
  readonly whenButtonSelector?: string
  readonly semanticTag?: string
  readonly elements?: readonly ControllerElementRequirement[]
  readonly requiredSelectors?: readonly string[]
  readonly optionalSelectors?: readonly string[]
}
export interface TemplateScope {
  readonly templateSelector: string
  readonly required?: boolean
  readonly perItemSelector?: string
  readonly requiredSelectors?: readonly string[]
  readonly conditionalSelectors?: readonly { readonly scopeSelector: string; readonly requiredSelectors: readonly string[] }[]
}
export interface SemanticRelation {
  readonly selector: string
  readonly ancestorHook?: string
  readonly tag?: string
}
export interface IdRelation {
  readonly ownerSelector?: string
  readonly idAttribute?: string
  readonly targetId?: string
  readonly targetIds?: readonly string[]
  readonly targetIdTemplate?: string
  readonly finiteValues?: readonly string[]
  readonly sourceValue?: string
  readonly finiteTargetIds?: readonly string[]
  readonly sameIdAttributes?: readonly string[]
  readonly targetIdPattern?: string
  readonly targetHook?: string
  readonly targetTag?: string
  readonly targetName?: string
  readonly targetTypes?: readonly string[]
  readonly targetAutocomplete?: string
  readonly targetMustBeUnique?: boolean
  readonly sameRoot?: string
  readonly sameForm?: string
  readonly sameOwningForm?: string | Readonly<Record<string, string>>
  readonly required?: boolean
  readonly guardRequired?: boolean
  readonly capabilityRequired?: boolean
  readonly optionalLookup?: boolean
}
export interface AssociatedEditor {
  readonly id: string
  readonly allowedKinds: readonly { readonly tag?: string; readonly contenteditable?: string; readonly role?: string }[]
}
export interface KeyedTarget {
  readonly fromSelector: string
  readonly fromAttribute: string
  readonly templateSelector: string
  readonly targetSelector: string
  readonly targetAttribute: string
}
export interface ControllerElementRequirement {
  readonly selector: string
  readonly tags?: readonly string[]
  readonly attributes?: AttributePredicates
  readonly occurrence?: 'first' | 'every'
  readonly required?: boolean
}
export interface ControllerDeclaration {
  readonly id: string
  readonly rootSelector: string
  readonly rootRequired?: boolean
  readonly qualifiedOnly?: boolean
  readonly applicableRoutes?: readonly string[]
  readonly routeScope?: RouteScope
  readonly rootAttributes?: AttributePredicates
  readonly rootAttributeExclusions?: AttributePredicates
  readonly parentRootSelector?: string
  readonly scopeSelector?: string
  readonly scopeCount?: number
  readonly lookupScope?: LookupScope
  readonly ownScopeOnly?: boolean
  readonly elements?: readonly ControllerElementRequirement[]
  readonly documentAttributes?: AttributePredicates
  readonly requiredSelectors?: readonly string[]
  /** Optional lookups create no initial-node requirement; their source policies are audited separately. */
  readonly optionalSelectors?: readonly string[]
  readonly variants?: readonly ControllerDeclaration[]
  readonly nestedScopes?: readonly ControllerDeclaration[]
  readonly conditionalRequirements?: readonly ConditionalRequirement[]
  readonly conditionalRequired?: readonly ConditionalRequirement[]
  readonly additionalConditionalRequired?: readonly ConditionalRequirement[]
  readonly templateScopes?: readonly TemplateScope[]
  readonly semanticRelations?: readonly SemanticRelation[]
  readonly perMatchRequired?: readonly { readonly selector: string; readonly eachAttributes: Readonly<Record<string, readonly string[]>> }[]
  readonly relations?: readonly IdRelation[]
  readonly associatedEditor?: AssociatedEditor
  readonly keyedTargets?: readonly KeyedTarget[]
}
export interface ControllerConformanceIssue {
  readonly kind: 'controller' | 'hook' | 'element' | 'relation'
  readonly name: string
  readonly controller: string
  readonly detail?: string
}

const unsupported = (id: string, section: string, value: string): never => {
  throw new Error(`CONTROLLER_CONTRACT_UNSUPPORTED ${id}: unsupported ${section}: ${value}`)
}
const keys = (value: object, allowed: readonly string[], id: string, section: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(id, `${section} condition`, key)
}
const DECLARATION_KEYS = ['id', 'rootSelector', 'rootRequired', 'qualifiedOnly', 'applicableRoutes', 'routeScope', 'rootAttributes', 'rootAttributeExclusions', 'parentRootSelector', 'scopeSelector', 'scopeCount', 'lookupScope', 'ownScopeOnly', 'elements', 'documentAttributes', 'requiredSelectors', 'optionalSelectors', 'variants', 'nestedScopes', 'conditionalRequirements', 'conditionalRequired', 'additionalConditionalRequired', 'templateScopes', 'semanticRelations', 'perMatchRequired', 'relations', 'associatedEditor', 'keyedTargets']
const CONDITIONAL_KEYS = ['id', 'rootSelector', 'rootRequired', 'applicableRoutes', 'rootAttributes', 'rootAttributeExclusions', 'documentAttributes', 'contextFacts', 'whenScopeMounted', 'whenButtonSelector', 'semanticTag', 'elements', 'requiredSelectors', 'optionalSelectors']
const RELATION_KEYS = ['ownerSelector', 'idAttribute', 'targetId', 'targetIds', 'targetIdTemplate', 'finiteValues', 'sourceValue', 'finiteTargetIds', 'sameIdAttributes', 'targetIdPattern', 'targetHook', 'targetTag', 'targetName', 'targetTypes', 'targetAutocomplete', 'targetMustBeUnique', 'sameRoot', 'sameForm', 'sameOwningForm', 'required', 'guardRequired', 'capabilityRequired', 'optionalLookup']

interface AttributeTest { readonly name: string; readonly value?: string }
interface Compound { readonly tag?: string; readonly id?: string; readonly attributes: readonly AttributeTest[] }
interface Part { readonly compound: Compound; readonly relation: 'descendant' | 'child' }
type Selector = readonly (readonly Part[])[]
const selectorCache = new Map<string, Selector>()
const decodeSelectorValue = (value: string, id: string, selector: string): string => {
  if (/\\(?![\\"'])/.test(value)) unsupported(id, 'selector escape', selector)
  return value.replace(/\\([\\"'])/g, '$1')
}
function splitOutside(value: string, delimiter: string, id: string): string[] {
  const parts: string[] = []
  let start = 0, brackets = 0, quote = ''
  for (let at = 0; at < value.length; at++) {
    const char = value[at]!
    if (quote) { if (char === '\\') at++; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '[') brackets++
    else if (char === ']') { if (--brackets < 0) unsupported(id, 'selector', value) }
    else if (!brackets && char === delimiter) { parts.push(value.slice(start, at)); start = at + 1 }
  }
  if (quote || brackets) unsupported(id, 'selector', value)
  parts.push(value.slice(start))
  if (parts.some(part => !part.trim())) unsupported(id, 'selector', value)
  return parts
}
function compound(value: string, id: string, selector: string): Compound {
  let offset = 0, tag: string | undefined, elementId: string | undefined
  const attributes: AttributeTest[] = []
  const tagMatch = /^(?:[A-Za-z][\w-]*|\*)/.exec(value)
  if (tagMatch) { tag = tagMatch[0].toLowerCase(); offset = tagMatch[0].length }
  while (offset < value.length) {
    const rest = value.slice(offset)
    const idMatch = /^#([\w-]+)/.exec(rest)
    if (idMatch) { if (elementId) unsupported(id, 'selector', selector); elementId = idMatch[1]; offset += idMatch[0].length; continue }
    const attr = /^\[([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s\]"']+)))?\]/.exec(rest)
    if (!attr) return unsupported(id, 'selector', selector)
    const raw = attr[2] ?? attr[3] ?? attr[4]
    attributes.push({ name: attr[1]!.toLowerCase(), ...(raw !== undefined ? { value: decodeSelectorValue(raw, id, selector) } : {}) })
    offset += attr[0].length
  }
  if (!tag && !elementId && !attributes.length) unsupported(id, 'selector', selector)
  return { ...(tag ? { tag } : {}), ...(elementId ? { id: elementId } : {}), attributes }
}
function parseSelector(value: string, id: string): Selector {
  const cached = selectorCache.get(value)
  if (cached) return cached
  const groups = splitOutside(value.trim(), ',', id).map(group => {
    const parts: Part[] = []
    let text = '', quote = '', bracket = 0, relation: Part['relation'] = 'descendant', afterChild = false
    const push = () => { if (text) { parts.push({ compound: compound(text, id, value), relation }); text = ''; relation = 'descendant'; afterChild = false } }
    for (let at = 0; at < group.length; at++) {
      const char = group[at]!
      if (quote) { text += char; if (char === '\\') text += group[++at] ?? ''; else if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") { quote = char; text += char; continue }
      if (char === '[') bracket++
      if (char === ']') bracket--
      if (!bracket && char === '>') { push(); if (!parts.length || afterChild) unsupported(id, 'selector', value); relation = 'child'; afterChild = true; continue }
      if (!bracket && /\s/.test(char)) { push(); continue }
      text += char
    }
    push()
    if (!parts.length || afterChild) unsupported(id, 'selector', value)
    return parts
  })
  selectorCache.set(value, groups)
  return groups
}
const HTML_TAGS = new Set(['a', 'article', 'aside', 'bdi', 'bdo', 'body', 'button', 'caption', 'col', 'colgroup', 'datalist', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'html', 'input', 'label', 'legend', 'li', 'main', 'meter', 'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'progress', 'section', 'select', 'span', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'ul'])
const HTML_CONTROL_ATTRIBUTES = new Set(['type', 'name', 'autocomplete', 'checked', 'multiple', 'readonly'])
const semanticTagMatches = (node: MarkupNode, tag: string): boolean =>
  node.tag === tag && (!HTML_TAGS.has(tag) || isHtmlElement(node))
const compoundMatches = (node: MarkupNode, value: Compound): boolean =>
  (!value.tag || value.tag === '*' || semanticTagMatches(node, value.tag))
  && (!value.id || node.attrs.get('id') === value.id)
  && value.attributes.every(attr => attr.value === undefined ? node.attrs.has(attr.name) : node.attrs.get(attr.name) === attr.value)

interface Scope { readonly root: number; readonly template: number; readonly ownRootSelector?: string }
const DOCUMENT: Scope = { root: -1, template: -1 }
const nodeParent = (nodes: readonly MarkupNode[], index: number, scope: Scope): number => {
  const parent = nodes[index]!.parent
  return parent === scope.template && scope.template >= 0 ? -1 : parent
}
const descendantOf = (nodes: readonly MarkupNode[], index: number, ancestor: number, scope: Scope): boolean => {
  for (let current = nodes[index]!.parent; current >= 0; current = nodes[current]!.parent) {
    if (current === ancestor) return true
    if (scope.template >= 0 && current === scope.template) break
  }
  return false
}
function matches(nodes: readonly MarkupNode[], index: number, selector: Selector, scope: Scope): boolean {
  return selector.some(parts => {
    let current = index
    if (!compoundMatches(nodes[current]!, parts.at(-1)!.compound)) return false
    for (let at = parts.length - 1; at > 0; at--) {
      const part = parts[at]!, previous = parts[at - 1]!
      current = nodeParent(nodes, current, scope)
      if (part.relation === 'child') { if (current < 0 || !compoundMatches(nodes[current]!, previous.compound)) return false }
      else { while (current >= 0 && !compoundMatches(nodes[current]!, previous.compound)) current = nodeParent(nodes, current, scope); if (current < 0) return false }
    }
    return true
  })
}
function closest(nodes: readonly MarkupNode[], index: number, query: string, scope: Scope, id: string): number {
  const selector = parseSelector(query, id)
  for (let current = index; current >= 0; current = nodeParent(nodes, current, scope)) if (matches(nodes, current, selector, scope)) return current
  return -1
}
function select(nodes: readonly MarkupNode[], scope: Scope, query: string, id: string, includeSelf = false): number[] {
  const selector = parseSelector(query, id)
  return nodes.flatMap((node, index) => {
    if (node.template !== scope.template || scope.root >= 0 && !(includeSelf && index === scope.root) && !descendantOf(nodes, index, scope.root, scope)) return []
    if (!matches(nodes, index, selector, scope)) return []
    if (scope.ownRootSelector && closest(nodes, index, scope.ownRootSelector, scope, id) !== scope.root) return []
    return [index]
  })
}
function attributesMatch(node: MarkupNode | undefined, attributes: AttributePredicates | undefined, id: string): boolean {
  return Object.entries(attributes ?? {}).every(([name, expected]) => {
    const actual = node?.attrs.get(name)
    if (typeof expected === 'string') return actual === expected
    if (typeof expected === 'boolean') return (node?.attrs.has(name) ?? false) === expected
    if (expected && typeof expected === 'object' && 'not' in expected) { keys(expected, ['not'], id, 'attribute'); return actual !== expected.not }
    if (expected && typeof expected === 'object' && 'oneOf' in expected) { keys(expected, ['oneOf'], id, 'attribute'); return expected.oneOf.includes(actual ?? '') }
    return unsupported(id, 'attribute condition', name)
  })
}
const htmlNode = (nodes: readonly MarkupNode[]): MarkupNode | undefined => nodes.find(node => isHtmlElement(node, 'html') && node.template < 0)
function routeMatches(declaration: ControllerDeclaration, context: ControllerContext, nodes: readonly MarkupNode[]): boolean {
  if (declaration.applicableRoutes?.length && context.route !== undefined && !declaration.applicableRoutes.includes(context.route)) return false
  const policy = declaration.routeScope
  if (!policy) return true
  keys(policy, ['kind', 'surfaces', 'audiences'], declaration.id, 'routeScope')
  const doc = htmlNode(nodes), surface = context.surface ?? doc?.attrs.get('data-surface')
  const login = context.surface === 'login' || context.loginAudience !== undefined
  const error = doc?.attrs.has('data-status') === true
  if (policy.surfaces && surface !== undefined && !policy.surfaces.includes(surface)) return false
  if (policy.kind === 'login-surface') return login && (!policy.audiences || context.loginAudience !== undefined && policy.audiences.includes(context.loginAudience))
  if (policy.kind === 'non-login-non-error-documents') return !login && !error
  if (policy.kind === 'authenticated') return !login && !error && context.qualified !== false
  if (policy.kind !== 'all') unsupported(declaration.id, 'routeScope condition', policy.kind)
  return true
}

function validateAttributes(value: AttributePredicates | undefined, id: string): void {
  for (const [name, predicate] of Object.entries(value ?? {})) {
    if (typeof predicate === 'string' || typeof predicate === 'boolean') continue
    if (!predicate || typeof predicate !== 'object') unsupported(id, 'attribute condition', name)
    if ('not' in predicate) { keys(predicate, ['not'], id, 'attribute'); if (typeof predicate.not !== 'string') unsupported(id, 'attribute condition', name) }
    else if ('oneOf' in predicate) { keys(predicate, ['oneOf'], id, 'attribute'); if (!Array.isArray(predicate.oneOf) || predicate.oneOf.some(item => typeof item !== 'string')) unsupported(id, 'attribute condition', name) }
    else unsupported(id, 'attribute condition', name)
  }
}
function validateContextFacts(value: Readonly<Record<string, ControllerFact>> | undefined, id: string): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported(id, 'contextFacts condition', 'Expected a presence-fact record')
  for (const [key, expected] of Object.entries(value))
    if (!key.trim() || expected !== 'present' && expected !== 'absent') unsupported(id, 'contextFacts condition', key || 'Empty fact key')
}
function validateElements(elements: readonly ControllerElementRequirement[] | undefined, id: string): void {
  for (const element of elements ?? []) {
    keys(element, ['selector', 'tags', 'attributes', 'occurrence', 'required'], id, 'element')
    parseSelector(element.selector, id); validateAttributes(element.attributes, id)
    if (element.required !== undefined && typeof element.required !== 'boolean') unsupported(id, 'element required condition', String(element.required))
    if (element.tags && (!element.tags.length || element.tags.some(tag => !/^[a-z][\w-]*$/.test(tag)))) unsupported(id, 'element tag condition', String(element.tags))
    if (element.occurrence !== undefined && !['first', 'every'].includes(element.occurrence)) unsupported(id, 'element occurrence condition', element.occurrence)
  }
}
function validateDeclaration(declaration: ControllerDeclaration): void {
  const id = declaration.id || 'unnamed'
  keys(declaration, DECLARATION_KEYS, id, 'declaration')
  if (!declaration.id || !declaration.rootSelector) unsupported(id, 'declaration condition', 'id/rootSelector')
  const query = (value: string | undefined) => { if (value && value !== 'document') parseSelector(value, id) }
  query(declaration.rootSelector); query(declaration.parentRootSelector); query(declaration.scopeSelector)
  for (const selector of declaration.requiredSelectors ?? []) query(selector)
  validateElements(declaration.elements, id)
  validateAttributes(declaration.rootAttributes, id); validateAttributes(declaration.rootAttributeExclusions, id); validateAttributes(declaration.documentAttributes, id)
  if (declaration.scopeCount !== undefined && (!Number.isInteger(declaration.scopeCount) || declaration.scopeCount < 0)) unsupported(id, 'scopeCount condition', String(declaration.scopeCount))
  if (declaration.routeScope) {
    keys(declaration.routeScope, ['kind', 'surfaces', 'audiences'], id, 'routeScope')
    if (!['all', 'authenticated', 'non-login-non-error-documents', 'login-surface'].includes(declaration.routeScope.kind)) unsupported(id, 'routeScope condition', declaration.routeScope.kind)
  }
  if (declaration.lookupScope) {
    const lookup = declaration.lookupScope
    keys(lookup, ['kind', 'selector'], id, 'lookupScope')
    if (!['descendant', 'closest', 'document'].includes(lookup.kind) || lookup.kind !== 'document' && !lookup.selector || lookup.kind === 'document' && lookup.selector !== undefined) unsupported(id, 'lookupScope condition', lookup.kind)
    query(lookup.selector)
  }
  for (const rule of [...declaration.conditionalRequirements ?? [], ...declaration.conditionalRequired ?? [], ...declaration.additionalConditionalRequired ?? []]) {
    keys(rule, CONDITIONAL_KEYS, id, 'conditional')
    query(rule.rootSelector); query(rule.whenScopeMounted); query(rule.whenButtonSelector)
    for (const selector of rule.requiredSelectors ?? []) query(selector)
    validateElements(rule.elements, id)
    validateContextFacts(rule.contextFacts, id)
    validateAttributes(rule.rootAttributes, id); validateAttributes(rule.rootAttributeExclusions, id); validateAttributes(rule.documentAttributes, id)
    if (rule.semanticTag && !/^[a-z][\w-]*$/.test(rule.semanticTag)) unsupported(id, 'conditional semanticTag', rule.semanticTag)
  }
  for (const projection of declaration.templateScopes ?? []) {
    keys(projection, ['templateSelector', 'required', 'perItemSelector', 'requiredSelectors', 'conditionalSelectors'], id, 'templateScope')
    query(projection.templateSelector); query(projection.perItemSelector)
    for (const selector of projection.requiredSelectors ?? []) query(selector)
    for (const condition of projection.conditionalSelectors ?? []) {
      keys(condition, ['scopeSelector', 'requiredSelectors'], id, 'template conditional')
      query(condition.scopeSelector)
      for (const selector of condition.requiredSelectors) query(selector)
    }
  }
  for (const relation of declaration.semanticRelations ?? []) { keys(relation, ['selector', 'ancestorHook', 'tag'], id, 'semantic relation'); query(relation.selector); query(relation.ancestorHook) }
  for (const rule of declaration.perMatchRequired ?? []) { keys(rule, ['selector', 'eachAttributes'], id, 'perMatchRequired'); query(rule.selector) }
  for (const relation of declaration.relations ?? []) {
    keys(relation, RELATION_KEYS, id, 'ID relation')
    query(relation.ownerSelector); query(relation.targetHook); query(relation.sameRoot); query(relation.sameForm)
    if (relation.targetIdPattern !== undefined) {
      const pattern = relation.targetIdPattern
      if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$') || pattern.length > 256) unsupported(id, 'ID relation condition', 'Unanchored or invalid target pattern')
      try { new RegExp(pattern) } catch { unsupported(id, 'ID relation condition', 'Invalid target pattern syntax') }
    }
    if (typeof relation.sameOwningForm === 'string') query(relation.sameOwningForm)
    else for (const form of Object.values(relation.sameOwningForm ?? {})) query(form)
  }
  if (declaration.associatedEditor) {
    keys(declaration.associatedEditor, ['id', 'allowedKinds'], id, 'associatedEditor')
    if (!declaration.associatedEditor.allowedKinds.length) unsupported(id, 'editor kind condition', 'Empty alternatives')
    for (const kind of declaration.associatedEditor.allowedKinds) { keys(kind, ['tag', 'contenteditable', 'role'], id, 'editor kind'); if (!kind.tag && !kind.contenteditable && !kind.role) unsupported(id, 'editor kind condition', 'Unconstrained alternative') }
  }
  for (const keyed of declaration.keyedTargets ?? []) { keys(keyed, ['fromSelector', 'fromAttribute', 'templateSelector', 'targetSelector', 'targetAttribute'], id, 'keyed target'); query(keyed.fromSelector); query(keyed.templateSelector); query(keyed.targetSelector) }
  for (const child of [...declaration.variants ?? [], ...declaration.nestedScopes ?? []]) validateDeclaration(child)
}

/** Source-authored controller requirements; observed markup never decides which roots or controls are mandatory. */
export function checkControllerDeclarations(nodes: readonly MarkupNode[], declarations: readonly ControllerDeclaration[], context: ControllerContext): ControllerConformanceIssue[] {
  const issues: ControllerConformanceIssue[] = []
  const add = (kind: ControllerConformanceIssue['kind'], name: string, controller: string, detail?: string) => issues.push({ kind, name, controller, ...(detail ? { detail } : {}) })
  const requireQueries = (scope: Scope, queries: readonly string[] | undefined, id: string): void => {
    for (const query of queries ?? []) if (!select(nodes, scope, query, id).length) add('hook', query, id)
  }
  const globalIds = (id: string) => nodes.flatMap((node, index) => node.template < 0 && node.attrs.get('id') === id ? [index] : [])
  const checkRelation = (relation: IdRelation, scope: Scope, id: string): void => {
    keys(relation, RELATION_KEYS, id, 'ID relation')
    const owners: (number | null)[] = relation.ownerSelector ? select(nodes, scope, relation.ownerSelector, id) : [null]
    const required = relation.required ?? (!relation.optionalLookup && (relation.guardRequired === true || relation.capabilityRequired === true || relation.ownerSelector !== undefined || relation.targetId !== undefined || relation.targetIds !== undefined || relation.targetIdTemplate !== undefined))
    for (const owner of owners) {
      let targetIds: string[]
      if (owner !== null && relation.idAttribute) targetIds = [nodes[owner]!.attrs.get(relation.idAttribute) ?? '']
      else if (relation.targetId) targetIds = [relation.targetId]
      else if (relation.targetIds) targetIds = [...relation.targetIds]
      else if (relation.targetIdTemplate && relation.finiteValues) targetIds = relation.finiteValues.map(value => relation.targetIdTemplate!.replace(/\$\{[^}]+\}/g, value))
      else return unsupported(id, 'ID relation condition', 'No target identity rule')
      for (const targetId of targetIds) {
        const found = globalIds(targetId), name = targetId ? `#${targetId}` : relation.ownerSelector ?? 'ID target'
        if (!targetId || !found.length) { if (required) add('relation', name, id, 'Missing target'); continue }
        if (relation.targetMustBeUnique !== false && found.length !== 1) { add('relation', name, id, 'Target ID is not unique'); continue }
        if (relation.finiteTargetIds && !relation.finiteTargetIds.includes(targetId)) add('relation', name, id, 'Unexpected target ID')
        if (relation.targetIdPattern) {
          if (!relation.targetIdPattern.startsWith('^') || !relation.targetIdPattern.endsWith('$')) unsupported(id, 'ID relation condition', 'Unanchored target pattern')
          if (!new RegExp(relation.targetIdPattern).test(targetId)) add('relation', name, id, 'Target ID pattern differs')
        }
        if (owner !== null && relation.sameIdAttributes?.some(attr => nodes[owner]!.attrs.get(attr) !== targetId)) add('relation', name, id, 'ARIA/data target IDs differ')
        for (const target of found) {
          const node = nodes[target]!
          if (relation.targetTag && !semanticTagMatches(node, relation.targetTag) || (relation.targetName || relation.targetTypes || relation.targetAutocomplete) && !isHtmlElement(node) || relation.targetName && node.attrs.get('name') !== relation.targetName || relation.targetTypes && !relation.targetTypes.includes(node.attrs.get('type') ?? '') || relation.targetAutocomplete && node.attrs.get('autocomplete') !== relation.targetAutocomplete || relation.targetHook && !matches(nodes, target, parseSelector(relation.targetHook, id), DOCUMENT)) add('relation', name, id, 'Target control semantics differ')
          if (owner === null) continue
          if (relation.sameRoot) {
            const ownerRoot = closest(nodes, owner, relation.sameRoot, DOCUMENT, id), targetRoot = closest(nodes, target, relation.sameRoot, DOCUMENT, id)
            if (ownerRoot < 0 || ownerRoot !== targetRoot) add('relation', name, id, 'Target is outside its owning root')
          }
          let form = relation.sameForm ?? relation.sameOwningForm
          if (form && typeof form !== 'string') {
            const choices = Object.entries(form).filter(([attribute]) => nodes[owner]!.attrs.has(attribute))
            if (choices.length !== 1) { add('relation', name, id, 'Owning form discriminator is ambiguous'); continue }
            form = choices[0]![1]
          }
          if (typeof form === 'string') {
            const ownerForm = closest(nodes, owner, form, DOCUMENT, id), targetForm = closest(nodes, target, form, DOCUMENT, id)
            if (ownerForm < 0 || ownerForm !== targetForm || !isHtmlElement(nodes[ownerForm]!, 'form')) add('relation', name, id, 'Target is outside its owning form')
          }
        }
      }
    }
  }
  const checkElements = (scope: Scope, elements: readonly ControllerElementRequirement[] | undefined, id: string): void => {
    for (const element of elements ?? []) {
      const found = select(nodes, scope, element.selector, id)
      const selected = element.occurrence === 'every' ? found : found.slice(0, 1)
      if (!selected.length && element.required !== false || selected.some(at => element.tags && !element.tags.some(tag => semanticTagMatches(nodes[at]!, tag)) || Object.keys(element.attributes ?? {}).some(name => HTML_CONTROL_ATTRIBUTES.has(name)) && !isHtmlElement(nodes[at]!) || !attributesMatch(nodes[at], element.attributes, id))) add('element', element.selector, id, 'Selected control semantics differ')
    }
  }
  const conditional = (rule: ConditionalRequirement, scope: Scope, id: string): void => {
    keys(rule, CONDITIONAL_KEYS, id, 'conditional')
    if (rule.applicableRoutes?.length && context.route !== undefined && !rule.applicableRoutes.includes(context.route)) return
    if (!attributesMatch(htmlNode(nodes), rule.documentAttributes, id) || !attributesMatch(scope.root < 0 ? htmlNode(nodes) : nodes[scope.root], rule.rootAttributes, id)) return
    if (rule.rootAttributeExclusions && attributesMatch(scope.root < 0 ? htmlNode(nodes) : nodes[scope.root], rule.rootAttributeExclusions, id)) return
    const requestedFacts = Object.entries(rule.contextFacts ?? {})
    for (const [key] of requestedFacts) {
      if (!context.facts || !Object.hasOwn(context.facts, key)) throw new Error(`MISSING_CONTROLLER_CONTEXT_FACT ${id}: ${key}`)
      const supplied = context.facts[key]
      if (supplied !== 'present' && supplied !== 'absent') throw new Error(`INVALID_CONTROLLER_CONTEXT_FACT ${id}: ${key}`)
    }
    if (requestedFacts.some(([key, expected]) => context.facts![key] !== expected)) return
    if (rule.whenScopeMounted && !select(nodes, scope, rule.whenScopeMounted, id, true).length) return
    const bases = rule.rootSelector ? select(nodes, scope, rule.rootSelector, id, true) : [scope.root]
    if (!bases.length && (rule.rootRequired || rule.whenButtonSelector && select(nodes, scope, rule.whenButtonSelector, id).length)) add('controller', rule.rootSelector ?? 'conditional scope', id)
    for (const root of bases) {
      const own: Scope = { root, template: scope.template }
      if (rule.whenButtonSelector && !select(nodes, own, rule.whenButtonSelector, id).length) continue
      if (rule.semanticTag && root >= 0 && !semanticTagMatches(nodes[root]!, rule.semanticTag)) add('element', rule.rootSelector ?? rule.semanticTag, id)
      const selectedScope = rule.whenScopeMounted ? select(nodes, own, rule.whenScopeMounted, id, true) : [root]
      for (const at of selectedScope) {
        const conditionalScope: Scope = { root: at, template: scope.template }
        requireQueries(conditionalScope, rule.requiredSelectors, id)
        checkElements(conditionalScope, rule.elements, id)
      }
    }
  }
  const run = (declaration: ControllerDeclaration, incoming: Scope, nested = false, variant = false): void => {
    keys(declaration, DECLARATION_KEYS, declaration.id, 'declaration')
    const id = declaration.id
    if (!id || !declaration.rootSelector) unsupported(id || 'unnamed', 'declaration condition', 'id/rootSelector')
    if (!routeMatches(declaration, context, nodes)) return
    if (context.qualified === false && declaration.qualifiedOnly !== false && declaration.applicableRoutes?.length) return
    if (!attributesMatch(htmlNode(nodes), declaration.documentAttributes, id)) return
    let roots = declaration.rootSelector === 'document' ? [-1] : select(nodes, incoming, declaration.rootSelector, id, variant)
    if (declaration.parentRootSelector) roots = roots.filter(root => root >= 0 && closest(nodes, nodeParent(nodes, root, incoming), declaration.parentRootSelector!, incoming, id) >= 0)
    roots = roots.filter(root => attributesMatch(root < 0 ? htmlNode(nodes) : nodes[root], declaration.rootAttributes, id))
    const routeRequired = declaration.applicableRoutes?.length && context.route !== undefined && declaration.applicableRoutes.includes(context.route)
    const mustMount = declaration.rootRequired ?? ((!nested || variant) && Boolean(routeRequired))
    if (!roots.length && mustMount) add('controller', declaration.rootSelector, id)
    for (const root of roots) {
      const rootNode = root < 0 ? htmlNode(nodes) : nodes[root]
      if (declaration.rootAttributeExclusions && attributesMatch(rootNode, declaration.rootAttributeExclusions, id)) continue
      let scopes: Scope[] = [{ root, template: incoming.template, ...(declaration.ownScopeOnly ? { ownRootSelector: declaration.rootSelector } : {}) }]
      const lookup = declaration.lookupScope
      if (lookup) {
        keys(lookup, ['kind', 'selector'], id, 'lookupScope')
        if (lookup.kind === 'document') scopes = [DOCUMENT]
        else if (lookup.kind === 'closest' && lookup.selector) scopes = scopes.flatMap(scope => { const at = root >= 0 ? closest(nodes, root, lookup.selector!, incoming, id) : -1; return at < 0 ? [] : [{ root: at, template: incoming.template }] })
        else if (lookup.kind === 'descendant' && lookup.selector) scopes = scopes.flatMap(scope => select(nodes, scope, lookup.selector!, id).map(at => ({ root: at, template: incoming.template })))
        else unsupported(id, 'lookupScope condition', lookup.kind)
      }
      if (declaration.scopeSelector) scopes = scopes.flatMap(scope => select(nodes, scope, declaration.scopeSelector!, id).map(at => ({ root: at, template: scope.template })))
      if (!scopes.length && declaration.requiredSelectors?.length) add('controller', declaration.scopeSelector ?? lookup?.selector ?? declaration.rootSelector, id, 'Missing lookup scope')
      if (declaration.scopeCount !== undefined && scopes.length !== declaration.scopeCount) add('controller', declaration.scopeSelector ?? declaration.rootSelector, id, 'Lookup scope count differs')
      for (const scope of scopes) {
        requireQueries(scope, declaration.requiredSelectors, id)
        checkElements(scope, declaration.elements, id)
        for (const rule of [...declaration.conditionalRequired ?? [], ...declaration.additionalConditionalRequired ?? [], ...declaration.conditionalRequirements ?? []]) conditional(rule, scope, id)
        for (const rule of declaration.perMatchRequired ?? []) {
          keys(rule, ['selector', 'eachAttributes'], id, 'perMatchRequired')
          const collection = select(nodes, scope, rule.selector, id, true)
          for (const [name, values] of Object.entries(rule.eachAttributes)) for (const value of values)
            if (!collection.some(at => nodes[at]!.attrs.get(name) === value)) add('hook', `${rule.selector}[${name}="${value}"]`, id, 'Missing collection variant')
        }
        for (const projection of declaration.templateScopes ?? []) {
          keys(projection, ['templateSelector', 'required', 'perItemSelector', 'requiredSelectors', 'conditionalSelectors'], id, 'templateScope')
          const templates = select(nodes, scope, projection.templateSelector, id)
          if (!templates.length && projection.required !== false) add('controller', projection.templateSelector, id, 'Missing template')
          for (const template of templates) {
            if (!isHtmlElement(nodes[template]!, 'template')) { add('element', projection.templateSelector, id, 'Expected HTML template element'); continue }
            const content: Scope = { root: template, template }
            const items = projection.perItemSelector ? select(nodes, content, projection.perItemSelector, id) : [template]
            for (const item of items) {
              const itemScope: Scope = { root: item, template }
              requireQueries(itemScope, projection.requiredSelectors, id)
              for (const condition of projection.conditionalSelectors ?? []) {
                keys(condition, ['scopeSelector', 'requiredSelectors'], id, 'template conditional')
                for (const at of select(nodes, itemScope, condition.scopeSelector, id, true)) requireQueries({ root: at, template }, condition.requiredSelectors, id)
              }
            }
          }
        }
        for (const relation of declaration.semanticRelations ?? []) {
          keys(relation, ['selector', 'ancestorHook', 'tag'], id, 'semantic relation')
          for (const at of select(nodes, scope, relation.selector, id)) {
            if (relation.tag && !semanticTagMatches(nodes[at]!, relation.tag) || relation.ancestorHook && closest(nodes, nodeParent(nodes, at, scope), relation.ancestorHook, scope, id) < 0) add('relation', relation.selector, id, 'Element ancestry/tag differs')
          }
        }
        for (const relation of declaration.relations ?? []) checkRelation(relation, scope, id)
        if (declaration.associatedEditor) {
          const editor = declaration.associatedEditor
          keys(editor, ['id', 'allowedKinds'], id, 'associatedEditor')
          const candidates = globalIds(editor.id)
          if (candidates.length !== 1) add('relation', `#${editor.id}`, id, 'Editor must exist once')
          else if (!editor.allowedKinds.some(kind => {
            keys(kind, ['tag', 'contenteditable', 'role'], id, 'editor kind')
            const node = nodes[candidates[0]!]!
            return isHtmlElement(node) && (!kind.tag || node.tag === kind.tag) && (!kind.contenteditable || node.attrs.get('contenteditable') === kind.contenteditable) && (!kind.role || node.attrs.get('role') === kind.role)
          })) add('element', `#${editor.id}`, id, 'Editor semantics differ')
        }
        for (const keyed of declaration.keyedTargets ?? []) {
          keys(keyed, ['fromSelector', 'fromAttribute', 'templateSelector', 'targetSelector', 'targetAttribute'], id, 'keyed target')
          const owners = select(nodes, scope, keyed.fromSelector, id)
          const templates = select(nodes, scope, keyed.templateSelector, id)
          for (const owner of owners) {
            const key = nodes[owner]!.attrs.get(keyed.fromAttribute)
            const targets = templates.flatMap(template => isHtmlElement(nodes[template]!, 'template') ? select(nodes, { root: template, template }, keyed.targetSelector, id) : [])
              .filter(target => nodes[target]!.attrs.get(keyed.targetAttribute) === key)
            if (!key || targets.length !== 1) add('relation', `${keyed.fromAttribute}=>${keyed.targetAttribute}`, id, 'Loaded row needs one matching reading projection')
          }
        }
      }
      for (const child of declaration.variants ?? []) run(child, { root, template: incoming.template }, true, true)
      for (const child of declaration.nestedScopes ?? []) run(child, { root, template: incoming.template }, true)
    }
  }
  // Validate even inactive branches so unsupported conditions cannot disappear behind an unmounted state.
  for (const declaration of declarations) validateDeclaration(declaration)
  for (const declaration of declarations) run(declaration, DOCUMENT)
  return issues.filter((issue, index) => issues.findIndex(other => other.kind === issue.kind && other.name === issue.name && other.controller === issue.controller && other.detail === issue.detail) === index)
}
