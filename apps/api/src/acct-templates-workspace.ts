import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { DnsRecord } from '@xpanel/core'
import { services } from '@xpanel/render'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Placeholders a zone template line may use, substituted per new account. Unknown %names% are refused. */
export const TEMPLATE_PLACEHOLDERS = ['%domain%', '%ipv4%', '%ipv6%', '%mailhost%'] as const
export const TEMPLATE_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'] as const
export const TEMPLATE_LIMITS = { templates: 20, records: 50, lineBytes: 1024, name: 64, title: 140, body: 2000 } as const
export interface TemplateRecord { name: string; ttl: number; type: typeof TEMPLATE_RECORD_TYPES[number]; priority: number | null; content: string }
export interface TemplatePage { title: string; body: string }
export interface AccountTemplate { id: string; name: string; records: TemplateRecord[]; defaultPage: TemplatePage; suspendedPage: TemplatePage; planIds: string[]; updatedAt: string; updatedBy: string }
export interface TemplateAccount { domain: string; ipv4: string; ipv6: string | null; mailHost: string }
export interface TemplatesHelpers extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('accounts/templates.json', null) */
  readSaved: () => Promise<unknown>
  /** ext.write('accounts/templates.json', value) */
  writeSaved: (value: unknown) => Promise<unknown>
  now?: () => Date
}

const ROUTE = /^\/api\/server\/account-templates(?:\/([^/]+))?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
// Owner names stay relative and placeholder-free: '@', '*', or labels such as www, _dmarc, _sip._tcp.
const OWNER = /^(?:@|\*|(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$/
const LINE_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const TEXT_FORBIDDEN = /[\p{Cf}\p{Zl}\p{Zp}<>\x00-\x09\x0b-\x1f\x7f-\x9f]/u
const MAX_BODY_BYTES = 64 * 1024
const INPUT_KEYS = 'defaultPage,expectedRevision,name,planIds,suspendedPage,zone'
const RECORD_KEYS = 'defaultPage,id,name,planIds,records,suspendedPage,updatedAt,updatedBy'
// RFC 5737 / RFC 3849 documentation addresses: previews never show a real host.
export const TEMPLATE_SAMPLE: TemplateAccount = { domain: 'example.com', ipv4: '192.0.2.10', ipv6: '2001:db8::10', mailHost: 'mail.example.com' }
const invalid = (message: string, detail: Record<string, unknown> = {}): never => fail('VALIDATION', message, { stateChanged: false, ...detail })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))

/** One record per line, BIND order without class: `name ttl type [priority] content`. Blank lines and `;` comments are skipped. */
export function parseZoneTemplate(text: unknown): TemplateRecord[] {
  if (typeof text !== 'string' || !text.isWellFormed()) return invalid('the zone template must be text')
  const records: TemplateRecord[] = []
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, index) => {
    const line = raw.trim(), at = { line: index + 1 }
    if (!line || line.startsWith(';')) return
    if (Buffer.byteLength(line) > TEMPLATE_LIMITS.lineBytes || LINE_FORBIDDEN.test(line)) invalid(`line ${index + 1} is too long or has control characters`, at)
    const parts = line.split(/\s+/), [name, ttlText, typeText] = parts
    const type = (typeText ?? '').toUpperCase() as TemplateRecord['type']
    if (!name || !OWNER.test(name)) invalid(`line ${index + 1}: the name must be @, * or relative labels such as www`, at)
    if (!ttlText || !/^\d{1,10}$/.test(ttlText) || Number(ttlText) > services.MAX_TTL) invalid(`line ${index + 1}: the TTL must be a number of seconds`, at)
    if (!(TEMPLATE_RECORD_TYPES as readonly string[]).includes(type)) invalid(`line ${index + 1}: the type must be one of ${TEMPLATE_RECORD_TYPES.join(', ')}`, at)
    const prioritized = type === 'MX' || type === 'SRV'
    if (prioritized && !/^\d{1,5}$/.test(parts[3] ?? '')) invalid(`line ${index + 1}: ${type} needs a priority before its content`, at)
    const content = parts.slice(prioritized ? 4 : 3).join(' ')
    if (!content) invalid(`line ${index + 1}: the record content is missing`, at)
    const unknown = (content.match(/%[a-z0-9_]*%/gi) ?? []).filter(token => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(token))
    if (unknown.length) invalid(`line ${index + 1}: unknown placeholder ${unknown[0]}`, at)
    records.push({ name: name!, ttl: Number(ttlText), type, priority: prioritized ? Number(parts[3]) : null, content })
    if (records.length > TEMPLATE_LIMITS.records) invalid(`a template holds at most ${TEMPLATE_LIMITS.records} records`)
  })
  return records
}
/** Canonical text for editing; parseZoneTemplate(formatZoneTemplate(r)) returns r. */
export const formatZoneTemplate = (records: readonly TemplateRecord[]): string => records.map(record => [record.name, record.ttl, record.type, ...(record.priority === null ? [] : [record.priority]), record.content].join(' ')).join('\n')

/** Substitutes placeholders for one account. A record using %ipv6% is left out when the account has no IPv6 address. */
export const renderTemplateRecords = (records: readonly TemplateRecord[], account: TemplateAccount): services.RecordInput[] => records
  .filter(record => account.ipv6 !== null || !record.content.includes('%ipv6%'))
  .map(record => ({ zone: account.domain, name: record.name, type: record.type, ttl: record.ttl, priority: record.priority,
    content: record.content.replaceAll('%domain%', account.domain).replaceAll('%ipv4%', account.ipv4).replaceAll('%ipv6%', account.ipv6 ?? '').replaceAll('%mailhost%', account.mailHost) }))
/** Default zone plus template records, validated as one zone (CNAME exclusivity, record grammars). */
const templateZone = (records: readonly TemplateRecord[], account: TemplateAccount, nameservers: readonly string[]): services.ZoneRecord[] => services.validateZone([
  ...services.defaultZoneRecords(account.domain, { ipv4: account.ipv4, ipv6: account.ipv6, nameservers: [...nameservers], mailHost: account.mailHost, adminEmail: 'hostmaster@' + account.domain, serial: 2026010101 }),
  ...renderTemplateRecords(records, account),
])
const defaultNameservers = (domain: string): string[] => ['ns1.' + domain, 'ns2.' + domain]
export const previewTemplateZone = (records: readonly TemplateRecord[], account: TemplateAccount = TEMPLATE_SAMPLE): services.ZoneRecord[] => templateZone(records, account, defaultNameservers(account.domain))
export const templateForPlan = (list: readonly AccountTemplate[], planId: string): AccountTemplate | null => list.find(template => template.planIds.includes(planId)) ?? null

/**
 * Account creation, before any state changes: the template of the new account's plan, or null when no
 * template names the plan or nothing is saved. An unreadable file or records that cannot form this
 * domain's zone refuse the creation (PRECONDITION_FAILED, stateChanged false).
 */
export function templateForNewAccount(raw: unknown, planId: unknown, domain: string, nameservers: readonly string[]): AccountTemplate | null {
  const list = readSavedTemplates(raw)
  if (!list) return fail('PRECONDITION_FAILED', 'the saved account templates require review before accounts can be created', { stateChanged: false, reason: 'account_templates_invalid' })
  const template = typeof planId === 'string' ? templateForPlan(list, planId) : null
  if (!template) return null
  const sample = { ...TEMPLATE_SAMPLE, domain, mailHost: 'mail.' + domain }
  try { for (const account of [sample, { ...sample, ipv6: null }]) templateZone(template.records, account, nameservers.length ? nameservers : defaultNameservers(domain)) }
  catch { return fail('PRECONDITION_FAILED', 'the plan template records do not form a valid zone for this domain', { stateChanged: false, reason: 'account_template_zone_invalid', templateId: template.id }) }
  return template
}
/** The new account's zone: default records plus its plan template's records, without the SOA the reconciler renders. */
export const accountTemplateZoneRecords = (template: AccountTemplate, account: { primaryDomain: string; ipv4: string; ipv6?: string | null }, nameservers: readonly string[]): Omit<DnsRecord, 'id'>[] => {
  const domain = account.primaryDomain
  return templateZone(template.records, { domain, ipv4: account.ipv4, ipv6: account.ipv6 ?? null, mailHost: 'mail.' + domain }, nameservers.length ? nameservers : defaultNameservers(domain))
    .flatMap(({ zone, name, type, ttl, priority, content }) => type === 'SOA' ? [] : [{ zone, name, type, ttl, priority, content }])
}

const textOf = (value: unknown, what: string, max: number, multiline: boolean): string => {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalid(`${what} must be text`)
  const text = value.replace(/\r\n?/g, '\n').trim()
  if ([...text].length > max || TEXT_FORBIDDEN.test(text) || (!multiline && text.includes('\n'))) return invalid(`${what} must be at most ${max} characters of plain text without HTML`)
  return text
}
const pageOf = (value: unknown, what: string): TemplatePage => {
  if (!object(value) || keys(value) !== 'body,title') return invalid(`${what} needs exactly a title and a body`)
  return { title: textOf(value.title, `the ${what} title`, TEMPLATE_LIMITS.title, false), body: textOf(value.body, `the ${what} body`, TEMPLATE_LIMITS.body, true) }
}
const planIdsOf = (value: unknown): string[] => Array.isArray(value) && value.length <= 1000 && value.every(id => typeof id === 'string' && UUID.test(id)) && new Set(value).size === value.length ? [...value as string[]].sort() : invalid('planIds must be distinct plan identities')
type Fields = Pick<AccountTemplate, 'name' | 'records' | 'defaultPage' | 'suspendedPage' | 'planIds'>
export function parseTemplateInput(body: unknown): Fields & { expectedRevision: string } {
  if (!object(body) || keys(body) !== INPUT_KEYS) return invalid('exactly name, zone, defaultPage, suspendedPage, planIds and expectedRevision are required')
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('the observed templates revision is required')
  const name = textOf(body.name, 'the template name', TEMPLATE_LIMITS.name, false)
  if (!name) return invalid('the template name is required')
  const records = parseZoneTemplate(body.zone)
  try { previewTemplateZone(records); previewTemplateZone(records, { ...TEMPLATE_SAMPLE, ipv6: null }) }
  catch (error) { return invalid('the template records do not form a valid zone with the default records: ' + (error instanceof Error ? error.message : 'invalid record')) }
  return { name, records, defaultPage: pageOf(body.defaultPage, 'default page'), suspendedPage: pageOf(body.suspendedPage, 'suspended page'), planIds: planIdsOf(body.planIds), expectedRevision: body.expectedRevision }
}

const templateOf = (raw: unknown): AccountTemplate | null => {
  try {
    if (!object(raw) || keys(raw) !== RECORD_KEYS || typeof raw.id !== 'string' || !UUID.test(raw.id) || typeof raw.updatedAt !== 'string' || !STAMP.test(raw.updatedAt) || typeof raw.updatedBy !== 'string' || !ACTOR.test(raw.updatedBy) || !Array.isArray(raw.records)) return null
    const records = parseZoneTemplate(formatZoneTemplate(raw.records as TemplateRecord[]))
    if (JSON.stringify(records) !== JSON.stringify(raw.records)) return null
    previewTemplateZone(records)
    return { id: raw.id, name: textOf(raw.name, 'name', TEMPLATE_LIMITS.name, false), records, defaultPage: pageOf(raw.defaultPage, 'default page'), suspendedPage: pageOf(raw.suspendedPage, 'suspended page'), planIds: planIdsOf(raw.planIds), updatedAt: raw.updatedAt, updatedBy: raw.updatedBy }
  } catch { return null }
}
/** Strict saved-file reader: null input is "nothing saved"; any unreadable record makes the whole file unreadable. */
export function readSavedTemplates(raw: unknown): AccountTemplate[] | null {
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > TEMPLATE_LIMITS.templates) return null
  const list = raw.map(templateOf)
  if (list.some(item => item === null)) return null
  const templates = list as AccountTemplate[], plans = templates.flatMap(template => template.planIds)
  return new Set(templates.map(template => template.id)).size === templates.length && new Set(templates.map(template => template.name.toLowerCase())).size === templates.length && new Set(plans).size === plans.length ? templates : null
}

const view = (raw: unknown, plans: { id: string; name: string }[]) => {
  const list = readSavedTemplates(raw)
  return {
    state: raw === null ? 'default' : list ? 'saved' : 'invalid', revision: revisionOf(raw),
    templates: (list ?? []).map(template => ({ ...template, zone: formatZoneTemplate(template.records), preview: previewTemplateZone(template.records).map(({ name, type, ttl, priority, content }) => ({ name, type, ttl, priority, content })) })),
    plans, placeholders: [...TEMPLATE_PLACEHOLDERS], sample: TEMPLATE_SAMPLE,
    // Account creation adds the zone records. No publisher for default or suspended pages exists: the web server serves its shipped pages.
    application: { appliedToNewAccounts: true, defaultPagePublished: false, suspendedPagePublished: false },
  }
}
const readJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}
const sameAuthority = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** Root account templates: GET/POST /api/server/account-templates, PUT/DELETE /api/server/account-templates/:id. */
export async function handleAccountTemplatesRoute(request: Request, url: URL, method: string, helpers: TemplatesHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1]
  const operation = id === undefined ? (method === 'POST' ? 'create' : 'read') : method === 'DELETE' ? 'delete' : 'update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'account-templates.' + operation)
  const allow = id === undefined ? 'GET, POST' : 'PUT, DELETE'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !UUID.test(id)) return fail('NOT_FOUND', 'template not found', { stateChanged: false })
  if (url.search) return invalid('account templates do not accept selectors')
  const plans = async () => (await helpers.store.listPlans()).map(plan => ({ id: plan.id, name: plan.name }))
  if (operation === 'read') return json(200, view(await helpers.readSaved(), await plans()))
  const body = await readJson(request)
  let input: (Fields & { expectedRevision: string }) | null = null, expectedRevision: string
  if (operation === 'delete') {
    if (!object(body) || keys(body) !== 'expectedRevision' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('only the observed templates revision is accepted')
    expectedRevision = body.expectedRevision
  } else { input = parseTemplateInput(body); expectedRevision = input.expectedRevision }
  return serial(async () => {
    const raw = await helpers.readSaved()
    if (revisionOf(raw) !== expectedRevision) return fail('CONFLICT', 'templates changed since they were read; reload before saving', { stateChanged: false })
    const list = readSavedTemplates(raw)
    if (!list) return fail('PRECONDITION_FAILED', 'the saved templates file requires review before it can be changed', { stateChanged: false })
    const index = id === undefined ? -1 : list.findIndex(template => template.id === id)
    if (id !== undefined && index < 0) return fail('NOT_FOUND', 'template not found', { stateChanged: false })
    const known = await plans()
    if (input) {
      const missing = input.planIds.filter(planId => !known.some(plan => plan.id === planId))
      if (missing.length) return invalid('these plans do not exist', { missing: missing.slice(0, 10) })
      const others = list.filter((_, at) => at !== index)
      if (others.some(template => template.name.toLowerCase() === input!.name.toLowerCase())) return fail('CONFLICT', 'a template with this name already exists', { stateChanged: false })
      const taken = input.planIds.filter(planId => others.some(template => template.planIds.includes(planId)))
      if (taken.length) return fail('CONFLICT', 'a plan can use only one template; remove it from the other template first', { stateChanged: false, plans: taken.slice(0, 10) })
      if (operation === 'create' && list.length >= TEMPLATE_LIMITS.templates) return fail('LIMIT_EXCEEDED', `at most ${TEMPLATE_LIMITS.templates} templates can be saved`, { stateChanged: false })
    }
    const actor = await helpers.requireCaller(request)
    await helpers.assertRoot(actor, 'account-templates.' + operation)
    if (!sameAuthority(actor, caller)) return fail('FORBIDDEN', 'template authority changed', { stateChanged: false })
    const stamp = (helpers.now?.() ?? new Date()).toISOString(), by = actor.principal.username
    const next = [...list]
    let target: AccountTemplate
    if (operation === 'delete') { target = list[index]!; next.splice(index, 1) }
    else {
      const { expectedRevision: _revision, ...fields } = input!
      target = { id: operation === 'create' ? randomUUID() : id!, ...fields, updatedAt: stamp, updatedBy: by }
      if (operation === 'create') next.push(target); else next[index] = target
    }
    try { await helpers.writeSaved(next) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the template write requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    const saved = await helpers.readSaved()
    if (revisionOf(saved) !== revisionOf(next) || !readSavedTemplates(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved templates could not be verified', { stateChanged: true, verificationRequired: true })
    try { await helpers.emitAudit({ actor: by, principalId: actor.principal.id, action: `server.account-template.${operation === 'create' ? 'created' : operation === 'update' ? 'updated' : 'deleted'}`, target: 'account-template:' + target.id, detail: { records: target.records.length, plans: target.planIds.length }, outcome: 'ok' }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the template is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(operation === 'create' ? 201 : 200, { ...view(saved, known), changed: target.id })
  })
}
