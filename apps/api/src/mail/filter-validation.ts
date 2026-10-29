import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { canonicalForwarderAddress } from './forwarder-validation.ts'

export const FILTER_COMPILATION_BUDGET_BYTES = 1024 * 1024
/** the host renders account-wide and mailbox rules into one script with at most this many rules */
export const MAX_FILTER_RULES = services.MAX_FILTERS
export const MAX_FILTER_ACTIONS = 10
export type FilterScope = 'global' | 'mailbox'
export interface FilterScopeContext { accountId: string; scope: FilterScope; mailbox: string | null }
export interface FilterCondition {
  field: 'from' | 'to' | 'subject' | 'header' | 'size' | 'body'
  headerName?: string
  comparator: 'contains' | 'is' | 'matches' | 'over' | 'under'
  value: string
}
export interface FilterAction { type: 'fileinto' | 'redirect' | 'discard' | 'reject' | 'keep' | 'mark-read' | 'stop'; target?: string }
export interface FilterContent { name: string; priority: number; enabled: boolean; matchAll: boolean; conditions: FilterCondition[]; actions: FilterAction[] }
export type FilterPatch = Partial<Omit<FilterContent, 'priority'>>
export interface ValidatedFilterRule extends FilterContent, FilterScopeContext { id: string; createdAt: string }

const invalid = (message: string): never => fail('VALIDATION', message)
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid(label + ' must be an object')
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unknown filter field')
}
const printable = (value: unknown, label: string, maximum: number, minimum = 0): string => {
  if (typeof value !== 'string' || value.length > maximum * 2 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return invalid(label + ' must be a bounded printable string')
  const characters = [...value]
  if (characters.length < minimum || characters.length > maximum || characters.some(character => { const point = character.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff })) return invalid(label + ' contains invalid Unicode or exceeds its limit')
  return value
}
const boolean = (value: unknown, label: string): boolean => typeof value === 'boolean' ? value : invalid(label + ' must be a boolean')
const priority = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10000 ? value : invalid('priority must be an integer between 1 and 10000')
const conditionFields = ['from', 'to', 'subject', 'header', 'size', 'body'] as const
const stringComparators = ['contains', 'is', 'matches'] as const
const actionTypes = ['fileinto', 'redirect', 'discard', 'reject', 'keep', 'mark-read', 'stop'] as const
const contentKeys = ['name', 'priority', 'enabled', 'matchAll', 'conditions', 'actions'] as const
const storedKeys = [...contentKeys, 'id', 'accountId', 'scope', 'mailbox', 'compiledSieve', 'createdAt']
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
const dense = (value: readonly unknown[]): void => { for (let i = 0; i < value.length; i++) if (!own(value, String(i))) invalid('Sparse filter arrays are not supported') }

export function validateFilterCondition(input: unknown): FilterCondition {
  const value = record(input, 'condition')
  keys(value, ['field', 'headerName', 'comparator', 'value'])
  const field = typeof value.field === 'string' ? value.field.toLowerCase() : ''
  if (!(conditionFields as readonly string[]).includes(field)) return invalid('Unknown condition field')
  const text = printable(value.value, 'condition value', 1024)
  if (field === 'size') {
    if (value.headerName !== undefined || !['over', 'under'].includes(String(value.comparator)) || typeof value.comparator !== 'string') return invalid('size requires over or under')
    const match = /^([0-9]+)([KMG])?$/i.exec(text.trim())
    if (!match) return invalid('size must be a whole ASCII decimal with optional K, M or G')
    const multiplier = match[2] ? { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2].toUpperCase() as 'K' | 'M' | 'G'] : 1
    const bytes = Number(match[1]) * multiplier
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2147483647) return invalid('size exceeds the supported byte range')
    return { field: 'size', comparator: value.comparator as 'over' | 'under', value: String(bytes) }
  }
  if (typeof value.comparator !== 'string' || !(stringComparators as readonly string[]).includes(value.comparator)) return invalid('String conditions require contains, is or matches')
  let headerName: string | undefined
  if (field === 'header') {
    headerName = printable(value.headerName, 'header name', 78, 1)
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_\x60|~]+$/.test(headerName)) return invalid('Invalid header token')
  } else if (value.headerName !== undefined) return invalid('headerName is only valid for header conditions')
  return { field: field as FilterCondition['field'], comparator: value.comparator as FilterCondition['comparator'], value: text, ...(headerName === undefined ? {} : { headerName }) }
}
const conditions = (value: unknown): FilterCondition[] => {
  if (!Array.isArray(value) || value.length > 50) return invalid('conditions must contain between 0 and 50 entries')
  dense(value)
  return value.map(validateFilterCondition)
}
const action = (input: unknown): FilterAction => {
  const value = record(input, 'action')
  keys(value, ['type', 'target'])
  if (typeof value.type !== 'string' || !(actionTypes as readonly string[]).includes(value.type)) return invalid('Unknown filter action')
  if (['keep', 'discard', 'mark-read', 'stop'].includes(value.type)) {
    if (value.target !== undefined && value.target !== '') return invalid(value.type + ' does not accept a target')
    return { type: value.type as 'keep' }
  }
  if (value.type === 'redirect') return { type: 'redirect', target: canonicalForwarderAddress(value.target) }
  return { type: value.type as 'fileinto' | 'reject', target: printable(value.target, 'action target', value.type === 'fileinto' ? 255 : 1024, 1) }
}
const actions = (value: unknown): FilterAction[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILTER_ACTIONS) return invalid('actions must contain between 1 and ' + MAX_FILTER_ACTIONS + ' entries')
  dense(value)
  return value.map(action)
}
/** The host renderer is the grammar: a rule it cannot render (empty value, header name, folder, action mix) is refused here. */
const renderable = <T extends FilterContent>(rule: T): T => {
  try { services.renderSieveScript({ filters: [services.mailFilterOf({ ...rule, enabled: true } as unknown as Record<string, unknown>)] }) }
  catch (error) { return invalid(error instanceof Error ? error.message : 'filter cannot be rendered') }
  return rule
}
const validateHints = (body: Record<string, unknown>): void => {
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision))) invalid('expectedRevision must be a SHA256 revision')
  if (body.accountId !== undefined) printable(body.accountId, 'accountId hint', 128, 1)
  if (body.scope !== undefined && (typeof body.scope !== 'string' || !['global', 'mailbox'].includes(body.scope))) invalid('Unknown filter scope')
  if (body.mailbox !== undefined && body.mailbox !== null) canonicalForwarderAddress(body.mailbox)
  if (body.scope === 'global' && body.mailbox !== undefined && body.mailbox !== null) invalid('Account-wide filters cannot select a mailbox')
  if (body.scope === 'mailbox' && body.mailbox === null) invalid('Mailbox filters require a mailbox')
}
export function validateFilterDraft(input: unknown, defaults: { priority: number }): FilterContent {
  const body = record(input, 'filter')
  keys(body, [...contentKeys, 'accountId', 'scope', 'mailbox', 'expectedRevision'])
  validateHints(body)
  if (!own(body, 'conditions')) return invalid('Explicit conditions are required')
  return renderable({
    name: printable(body.name, 'filter name', 128, 1).trim() || invalid('filter name cannot be empty'),
    priority: priority(own(body, 'priority') ? body.priority : defaults?.priority),
    enabled: own(body, 'enabled') ? boolean(body.enabled, 'enabled') : true,
    matchAll: own(body, 'matchAll') ? boolean(body.matchAll, 'matchAll') : true,
    conditions: conditions(body.conditions),
    actions: actions(body.actions),
  })
}
export function validateFilterPatch(input: unknown): FilterPatch {
  const body = record(input, 'filter patch')
  keys(body, ['name', 'enabled', 'matchAll', 'conditions', 'actions', 'expectedRevision'])
  validateHints(body)
  const result: FilterPatch = {}
  if (own(body, 'name')) result.name = printable(body.name, 'filter name', 128, 1).trim() || invalid('filter name cannot be empty')
  if (own(body, 'enabled')) result.enabled = boolean(body.enabled, 'enabled')
  if (own(body, 'matchAll')) result.matchAll = boolean(body.matchAll, 'matchAll')
  if (own(body, 'conditions')) result.conditions = conditions(body.conditions)
  if (own(body, 'actions')) result.actions = actions(body.actions)
  if (!Object.keys(result).length) return invalid('At least one editable filter field is required')
  return result
}
export function assertFilterContext(input: unknown, context: FilterScopeContext): void {
  const rule = record(input, 'stored filter')
  printable(context.accountId, 'trusted account', 128, 1)
  if (!['global', 'mailbox'].includes(context.scope) || context.scope === 'global' && context.mailbox !== null || context.scope === 'mailbox' && (context.mailbox === null || canonicalForwarderAddress(context.mailbox) !== context.mailbox)) return invalid('Invalid trusted filter context')
  if (rule.accountId !== context.accountId || rule.scope !== context.scope) return invalid('Filter does not belong to this context')
  const mailbox = rule.mailbox === null ? null : canonicalForwarderAddress(rule.mailbox)
  if (mailbox !== context.mailbox) return invalid('Filter mailbox does not belong to this context')
}
const storedContent = (body: Record<string, unknown>): FilterContent => renderable({
  name: printable(body.name, 'filter name', 128, 1).trim() || invalid('filter name cannot be empty'),
  priority: priority(body.priority),
  enabled: boolean(body.enabled, 'enabled'),
  matchAll: boolean(body.matchAll, 'matchAll'),
  conditions: conditions(body.conditions),
  actions: actions(body.actions),
})
export function validateStoredFilterRule(input: unknown, context: FilterScopeContext): ValidatedFilterRule {
  const body = record(input, 'stored filter')
  keys(body, storedKeys)
  assertFilterContext(body, context)
  const id = printable(body.id, 'filter id', 128, 1)
  const createdAt = printable(body.createdAt, 'createdAt', 64, 1)
  if (!Number.isFinite(Date.parse(createdAt))) return invalid('Invalid filter creation date')
  if (body.compiledSieve !== undefined && (typeof body.compiledSieve !== 'string' || Buffer.byteLength(body.compiledSieve) > FILTER_COMPILATION_BUDGET_BYTES)) return invalid('Invalid cached filter preview')
  return { ...storedContent(body), id, ...context, createdAt }
}
const budget = () => {
  let bytes = 0
  return (text: string): string => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > FILTER_COMPILATION_BUDGET_BYTES) invalid('Filter compilation budget exceeded')
    return text
  }
}
/** The selected scope's rules exactly as the host renders them (renderSieveScript), within the size budget. */
function compileContents(values: readonly FilterContent[]): string {
  const active = values.filter(value => value.enabled).sort((a, b) => a.priority - b.priority)
  const text = services.renderSieveScript({ filters: active.map(value => services.mailFilterOf(value as unknown as Record<string, unknown>)) })
  if (Buffer.byteLength(text, 'utf8') > FILTER_COMPILATION_BUDGET_BYTES) invalid('Filter compilation budget exceeded')
  return text
}
export function compileValidatedFilters(rules: readonly unknown[], context: FilterScopeContext): string {
  if (!Array.isArray(rules) || rules.length > MAX_FILTER_RULES) return invalid('Too many filter rules')
  dense(rules)
  // Validate the empty selected context as well; never infer authority from a first record.
  assertFilterContext({ ...context }, context)
  const consume = budget()
  const values = rules.map(input => {
    const value = validateStoredFilterRule(input, context)
    consume(JSON.stringify(value))
    return value
  })
  return compileContents(values)
}
export function filterRevision(context: FilterScopeContext, records: readonly unknown[]): string {
  assertFilterContext({ ...context }, context)
  if (!Array.isArray(records) || records.length > MAX_FILTER_RULES) return invalid('Too many filter records for a revision')
  dense(records)
  const digest = createHash('sha256'), consume = budget()
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 16) invalid('Filter revision projection is too complex')
    const emit = (text: string) => { digest.update(consume(text)) }
    if (value === null) { emit('null'); return }
    if (typeof value === 'string') {
      if (value.length > FILTER_COMPILATION_BUDGET_BYTES) invalid('Filter revision projection exceeds its budget')
      emit(JSON.stringify(value)); return
    }
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { emit(JSON.stringify(value)); return }
    if (Array.isArray(value)) { dense(value); emit('['); value.forEach((item, index) => { if (index) emit(','); visit(item, depth + 1) }); emit(']'); return }
    const object = record(value, 'revision value'), names = Object.keys(object).sort()
    if (names.length > 128) invalid('Filter revision projection has too many fields')
    emit('{')
    names.forEach((name, index) => { if (index) emit(','); emit(JSON.stringify(name) + ':'); visit(object[name], depth + 1) })
    emit('}')
  }
  const projection = records.map(value => {
    const input = record(value, 'filter revision record')
    // Derived source is not authority. Invalid raw content remains in the revision so it can be safely repaired.
    return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'compiledSieve'))
  })
  visit({ context, records: projection }, 0)
  return digest.digest('hex')
}
/** A sample message for a filter dry run: From, To and Subject plus up to 50 other headers, a text body and an optional size. */
export function validateSampleMessage(input: unknown): { headers: { name: string; value: string }[]; body: string; size?: number } {
  const value = record(input, 'message')
  keys(value, ['from', 'to', 'subject', 'headers', 'body', 'size'])
  const line = (text: unknown, label: string): string => printable(text ?? '', label, 998)
  const headers = [['From', value.from], ['To', value.to], ['Subject', value.subject]]
    .filter(([, text]) => text !== undefined && text !== '').map(([name, text]) => ({ name: name as string, value: line(text, String(name)) }))
  if (value.headers !== undefined) {
    if (!Array.isArray(value.headers) || value.headers.length > 50) return invalid('headers must contain at most 50 entries')
    dense(value.headers)
    for (const raw of value.headers) {
      const header = record(raw, 'header')
      keys(header, ['name', 'value'])
      const name = printable(header.name, 'header name', 78, 1)
      if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) return invalid('Invalid header token')
      headers.push({ name, value: line(header.value, 'header value') })
    }
  }
  if (typeof value.body !== 'string' && value.body !== undefined) return invalid('body must be a string')
  const body = value.body ?? ''
  if (body.length > 65536 || /[\u0000\u2028\u2029]/u.test(body)) return invalid('body must be at most 65536 characters of text')
  if (value.size !== undefined && !(typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 2147483647)) return invalid('size must be a whole number of bytes')
  return { headers, body, ...(value.size === undefined ? {} : { size: value.size as number }) }
}
