import '../../web/src/i18n.ts'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { localeDirection, translator } from '../../web/src/i18n.ts'
import { LOCALES, SOURCE_LOCALE } from '../../../packages/core/src/i18n/locales.ts'
import type { Locale } from '../../web/src/i18n.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { workspaceJson } from './account-ssh-workspace.ts'
import { DeliveryFailure } from './alert-delivery.ts'
import type { EmailSender } from './alert-delivery.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { secBody } from './sec-workspace.ts'
import { isWebhookUrl } from '../../agent/src/ops-webhooks.ts'
import type { WebhookSender } from '../../agent/src/ops-webhooks.ts'
import { MARKETING_MESSAGE_PREFIX } from '../../agent/src/mail-log-reports.ts'
import type { MailOutcomes } from '../../agent/src/mail-log-reports.ts'

/** Saved lists, templates, campaigns and flows; counters and flow positions live in the run file. */
export const MARKETING_STATE = 'extended/mail/marketing.json'
export const MARKETING_RUN = 'extended/mail/marketing-run.json'
const MARKETING_KEY = 'extended/mail/marketing-key.json'
const BASE = '/api/server/mail/marketing'
/** Outside /api/: a one-click unsubscribe is a form POST, which the API routes refuse. */
export const UNSUBSCRIBE_PATH = '/mail/unsubscribe'
const LIMITS = { groups: 100, subscribers: 20000, suppressed: 50000, templates: 100, campaigns: 200, flows: 50, steps: 20, runs: 20000, view: 500, subject: 200, body: 200_000, name: 64, scan: 200 }
export const MARKETING_RATE_DEFAULT = 60, MARKETING_RATE_MAX = 600
const unchanged = { stateChanged: false }
const invalid = (message: string, extra: Record<string, unknown> = {}): never => fail('VALIDATION', message, { ...unchanged, ...extra })
const ADDRESS = /^[a-z0-9._+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/
const NAME = /^[\p{L}\p{N} ._&'()-]{1,64}$/u

export interface MarketingGroup { id: string; name: string }
export interface MarketingSubscriber { address: string; groups: string[]; status: 'subscribed' | 'unsubscribed'; addedAt: string }
export interface MarketingSuppressed { address: string; reason: 'bounced' | 'deferred' | 'invalid_domain' | 'manual'; at: string }
export interface MarketingTemplate { id: string; name: string; subject: string; text: string; html: string }
export type MarketingCampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'finished'
export interface MarketingCampaign { id: string; name: string; fromAddress: string; fromName: string; subject: string; groupId: string; templateId: string; ratePerMinute: number; scheduledAt: string | null; status: MarketingCampaignStatus; createdAt: string }
export type MarketingStep = { type: 'send'; templateId: string } | { type: 'delay'; minutes: number } | { type: 'webhook'; url: string }
export interface MarketingFlow { id: string; name: string; groupId: string; fromAddress: string; fromName: string; steps: MarketingStep[]; enabled: boolean }
export interface MarketingFile { version: 1; groups: MarketingGroup[]; subscribers: MarketingSubscriber[]; suppressed: MarketingSuppressed[]; templates: MarketingTemplate[]; campaigns: MarketingCampaign[]; flows: MarketingFlow[] }
export interface MarketingCounters { sent: number; failed: number; skipped: number; delivered: number; bounced: number }
export interface MarketingFlowRun { flowId: string; address: string; step: number; dueAt: string }
export interface MarketingRun { version: 1; campaigns: Record<string, MarketingCounters & { position: number; cursor: string | null; lastError: string | null }>; flows: Record<string, MarketingCounters & { webhooks: number }>; runs: MarketingFlowRun[]; sequence: number }
export const EMPTY_MARKETING: MarketingFile = { version: 1, groups: [], subscribers: [], suppressed: [], templates: [], campaigns: [], flows: [] }
export const EMPTY_MARKETING_RUN: MarketingRun = { version: 1, campaigns: {}, flows: {}, runs: [], sequence: 0 }
const counters = (): MarketingCounters => ({ sent: 0, failed: 0, skipped: 0, delivered: 0, bounced: 0 })

const path = (store: Pick<StateStore, 'rootDir'>, name: string): string => join(store.rootDir, name)
const readFile = async (store: Pick<StateStore, 'rootDir'>): Promise<{ file: MarketingFile; revision: string }> => {
  let raw: unknown
  try { raw = await readJsonIfExists<unknown>(path(store, MARKETING_STATE)) } catch { return fail('PRECONDITION_FAILED', 'saved campaign data is unreadable', unchanged) }
  const file = (raw ?? structuredClone(EMPTY_MARKETING)) as MarketingFile
  if (file.version !== 1 || !Array.isArray(file.subscribers)) return fail('PRECONDITION_FAILED', 'saved campaign data requires review', unchanged)
  return { file, revision: createHash('sha256').update(JSON.stringify({ namespace: 'mail:marketing:v1', raw })).digest('hex') }
}
const readRun = async (store: Pick<StateStore, 'rootDir'>): Promise<MarketingRun> => {
  const raw = await readJsonIfExists<MarketingRun>(path(store, MARKETING_RUN)).catch(() => null)
  return raw?.version === 1 ? raw : structuredClone(EMPTY_MARKETING_RUN)
}
let runQueue: Promise<unknown> = Promise.resolve()
/** The minute tick and the routes change the run file; each change reads it fresh. */
const changeRun = <T>(store: Pick<StateStore, 'rootDir'>, change: (run: MarketingRun) => T): Promise<T> => {
  const task = runQueue.then(async () => { const run = await readRun(store), result = change(run); await atomicWriteJson(path(store, MARKETING_RUN), run, 0o640); return result })
  runQueue = task.catch(() => undefined)
  return task
}
const changeFile = async <T>(store: StateStore, expected: string | null, change: (file: MarketingFile) => T, guard: () => Promise<unknown> = async () => undefined): Promise<T> => {
  const lease = await store.getWriterLock().acquire()
  try {
    await guard()
    const { file, revision } = await readFile(store)
    if (expected !== null && revision !== expected) return fail('CONFLICT', 'saved campaign data changed; reload before saving', unchanged)
    const result = change(file)
    await lease.assertFencingToken()
    await atomicWriteJson(path(store, MARKETING_STATE), file, 0o640)
    return result
  } finally { await lease.release() }
}

/** Template text and subject take {address} and {unsubscribeUrl}; anything else in braces is refused. */
const TEMPLATE_VARS = ['address', 'unsubscribeUrl']
const assertVars = (text: string, field: string): void => { for (const match of text.matchAll(/\{([^{}]*)\}/g)) if (!TEMPLATE_VARS.includes(match[1]!)) invalid(`unknown variable {${match[1]!.slice(0, 40)}} in ${field}`, { reason: 'unknown_variable', variable: match[1]!.slice(0, 40) }) }
const fill = (text: string, values: Readonly<Record<string, string>>): string => text.replace(/\{(address|unsubscribeUrl)\}/g, (_, name: string) => values[name] ?? '')
const htmlValue = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** Every message carries the link: a template without one gets it as a footer. */
export function renderMarketing(template: Pick<MarketingTemplate, 'subject' | 'text' | 'html'>, subject: string, address: string, unsubscribeUrl: string) {
  const values = { address, unsubscribeUrl }, line = (body: string): string => body.includes('{unsubscribeUrl}') ? body : body + '\n\n{unsubscribeUrl}'
  const html = template.html ? fill(template.html.includes('{unsubscribeUrl}') ? template.html : template.html + '<p><a href="{unsubscribeUrl}">{unsubscribeUrl}</a></p>', { address: htmlValue(address), unsubscribeUrl: htmlValue(unsubscribeUrl) }) : ''
  return { subject: fill(subject || template.subject, values).replace(/[\r\n]+/g, ' '), text: fill(line(template.text), values), ...(html ? { html } : {}) }
}

const key = async (store: Pick<StateStore, 'rootDir'>): Promise<Buffer> => {
  const saved = await readJsonIfExists<{ key?: string }>(path(store, MARKETING_KEY)).catch(() => null)
  if (saved?.key && /^[0-9a-f]{64}$/.test(saved.key)) return Buffer.from(saved.key, 'hex')
  const value = randomBytes(32)
  await atomicWriteJson(path(store, MARKETING_KEY), { key: value.toString('hex') }, 0o600)
  return value
}
const sign = (secret: Buffer, payload: string): string => createHmac('sha256', secret).update('mail-unsubscribe\0' + payload).digest('base64url')
/** The link is a signed capability for one address in one group; it reveals nothing and carries no account. */
export const unsubscribeToken = (secret: Buffer, groupId: string, address: string): string => { const payload = Buffer.from(JSON.stringify([groupId, address])).toString('base64url'); return payload + '.' + sign(secret, payload) }
export function readUnsubscribeToken(secret: Buffer, token: string): { groupId: string; address: string } | null {
  const [payload, mac, extra] = token.split('.')
  if (!payload || !mac || extra !== undefined || payload.length > 512) return null
  const want = Buffer.from(sign(secret, payload)), got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try { const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown; return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' ? { groupId: value[0], address: value[1] } : null } catch { return null }
}
const page = (locale: Locale, title: string, form: string): Response => new Response(`<!doctype html><html lang="${locale}" dir="${localeDirection(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${htmlValue(title)}</title></head><body><h1>${htmlValue(title)}</h1>${form}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action 'self'", 'x-content-type-options': 'nosniff' } })

/** Public: a link scanner's GET only shows the button; the recipient's POST, or a mail client's RFC 8058 one-click POST, unsubscribes. */
export async function handleUnsubscribeRoute(request: Request, url: URL, method: string, store: StateStore): Promise<Response | null> {
  if (url.pathname !== UNSUBSCRIBE_PATH) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const asked = request.headers.get('accept-language')?.toLowerCase() ?? '', locale = (LOCALES.find(item => asked.startsWith(item.tag))?.tag ?? SOURCE_LOCALE) as Locale, t = translator(locale)
  const token = url.searchParams.get('t') ?? '', target = readUnsubscribeToken(await key(store), token)
  if (!target) return new Response(null, { status: 404 })
  if (method === 'GET') return page(locale, t(msgid('Unsubscribe from this list?')), `<form method="post" action="${htmlValue(UNSUBSCRIBE_PATH + '?t=' + encodeURIComponent(token))}"><button type="submit">${htmlValue(t(msgid('Unsubscribe')))}</button></form>`)
  await changeFile(store, null, file => {
    const row = file.subscribers.find(item => item.address === target.address)
    if (row) row.groups = row.groups.filter(id => id !== target.groupId)
  })
  return page(locale, t(msgid('You are unsubscribed from this list.')), '')
}

const groupByName = (file: MarketingFile, name: unknown): MarketingGroup => file.groups.find(item => item.name === name) ?? fail('NOT_FOUND', 'no group has this name', unchanged)
const templateByName = (file: MarketingFile, name: unknown): MarketingTemplate => file.templates.find(item => item.name === name) ?? fail('NOT_FOUND', 'no template has this name', unchanged)
const text = (value: unknown, max: number, what: string): string => typeof value === 'string' && value.length <= max ? value : invalid(`${what} must be text of at most ${max} characters`)
const named = (value: unknown, what: string): string => { const name = typeof value === 'string' ? value.trim() : ''; return NAME.test(name) ? name : invalid(`${what} must be 1 to 64 letters, digits or simple punctuation`) }
const address = (value: unknown, what: string): string => { const item = typeof value === 'string' ? value.trim().toLowerCase() : ''; return ADDRESS.test(item) ? item : invalid(`${what} is not a valid address`) }
/** Newline, comma or JSON list of addresses. Each line is checked; the first bad one is named. */
export function parseSubscriberImport(input: string): string[] {
  const trimmed = input.trim()
  let items: unknown[]
  if (trimmed.startsWith('[')) { try { const value = JSON.parse(trimmed) as unknown; items = Array.isArray(value) ? value : [] } catch { return invalid('the JSON list could not be read') } }
  else items = trimmed.split(/[\r\n,;]+/).map(item => item.trim()).filter(Boolean)
  if (!items.length || items.length > LIMITS.subscribers) return invalid(`import 1 to ${LIMITS.subscribers} addresses`)
  return [...new Set(items.map(item => address(typeof item === 'object' && item !== null ? (item as { address?: unknown }).address : item, 'each line')))]
}
const stepOf = (line: unknown, file: MarketingFile): MarketingStep => {
  const [kind, ...rest] = String(line).trim().split(/\s+/), value = rest.join(' ')
  if (kind === 'send') return { type: 'send', templateId: templateByName(file, value).id }
  if (kind === 'delay') { const minutes = Number(value); return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 525600 ? { type: 'delay', minutes } : invalid('a delay is a number of minutes') }
  if (kind === 'webhook') return isWebhookUrl(value) ? { type: 'webhook', url: value } : invalid('a webhook is a public https address')
  return invalid('each step is one line: send <template>, delay <minutes> or webhook <https address>')
}

export interface MarketingRouteHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  email: () => Promise<EmailSender>
  publicOrigin: string | null
  resolveMx?: (domain: string) => Promise<boolean>
}
const domainReceivesMail = async (domain: string): Promise<boolean> => {
  const resolver = new Resolver({ timeout: 4000, tries: 1 })
  const answers = (await Promise.allSettled([resolver.resolveMx(domain), resolver.resolve4(domain), resolver.resolve6(domain)]))
  return answers.some(item => item.status === 'fulfilled' && item.value.length > 0) || answers.some(item => item.status === 'rejected' && !['ENOTFOUND', 'ENODATA'].includes((item.reason as NodeJS.ErrnoException).code ?? ''))
}
const view = async (store: StateStore) => {
  const { file, revision } = await readFile(store), run = await readRun(store), names = new Map(file.groups.map(group => [group.id, group.name])), templates = new Map(file.templates.map(item => [item.id, item.name]))
  return { revision,
    groups: file.groups.map(group => ({ ...group, count: file.subscribers.filter(item => item.groups.includes(group.id)).length })),
    subscribersTotal: file.subscribers.length, subscribers: file.subscribers.slice(0, LIMITS.view).map(item => ({ address: item.address, groups: item.groups.map(id => names.get(id) ?? id).join(', '), status: item.status, addedAt: item.addedAt })),
    suppressedTotal: file.suppressed.length, suppressed: file.suppressed.slice(0, LIMITS.view),
    templates: file.templates.map(item => ({ id: item.id, name: item.name, subject: item.subject, format: item.html ? 'html' : 'text' })),
    campaigns: file.campaigns.map(item => ({ ...item, group: names.get(item.groupId) ?? null, template: templates.get(item.templateId) ?? null, ...counters(), lastError: null, ...run.campaigns[item.id] })),
    flows: file.flows.map(item => ({ id: item.id, name: item.name, group: names.get(item.groupId) ?? null, enabled: item.enabled, steps: item.steps.length, waiting: run.runs.filter(entry => entry.flowId === item.id).length, ...counters(), webhooks: 0, ...run.flows[item.id] })) }
}
const hostedSender = async (store: StateStore, value: unknown): Promise<string> => {
  const from = address(value, 'the sender')
  // Only hosted domains sign with this server's DKIM keys; any other sender would fail DMARC and burn the server's reputation.
  if (!(await store.listDomains()).some(domain => domain.name === from.slice(from.lastIndexOf('@') + 1))) return fail('PRECONDITION_FAILED', 'the sender must be at a domain hosted on this server', { ...unchanged, reason: 'sender_not_hosted' })
  return from
}

/** WHM mail campaigns, subscribers and automation. Root only: every write names the revision it read. */
export async function handleMailMarketingRoute(request: Request, url: URL, method: string, helpers: MarketingRouteHelpers): Promise<Response | null> {
  const p = url.pathname
  if (p !== BASE && !p.startsWith(BASE + '/')) return null
  const op = p.slice(BASE.length + 1), action = 'server.mail.marketing.' + (op.replaceAll('/', '.') || 'read')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return invalid('this route takes no selectors')
  if (method !== (op ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: op ? 'POST' : 'GET' } })
  if (!op) return workspaceJson(await view(helpers.store))
  const body = await secBody(request, 512 * 1024), expected = typeof body.expectedRevision === 'string' ? body.expectedRevision : invalid('the exact observed revision is required')
  const now = new Date().toISOString(), { store } = helpers
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return current }
  const change = <T>(work: (file: MarketingFile) => T): Promise<T> => changeFile(store, expected, work, fresh)
  const done = async (target: string, detail: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Response> => {
    const actor = await fresh()
    await helpers.emitAudit({ actor: actor.principal.username, action: 'mail.marketing.' + op.replace('/', '_'), target, principalId: actor.principal.id, outcome: 'ok', detail }).catch(() => fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }))
    return workspaceJson({ ...await view(store), ...extra })
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const campaign = (file: MarketingFile): MarketingCampaign => file.campaigns.find(item => item.id === id) ?? fail('NOT_FOUND', 'campaign not found', unchanged)
  const flow = (file: MarketingFile): MarketingFlow => file.flows.find(item => item.id === id) ?? fail('NOT_FOUND', 'flow not found', unchanged)
  const template = (file: MarketingFile): MarketingTemplate => file.templates.find(item => item.id === id) ?? fail('NOT_FOUND', 'template not found', unchanged)
  switch (op) {
    case 'groups/add': { const name = named(body.name, 'the group name'); await change(file => { if (file.groups.length >= LIMITS.groups) invalid(`at most ${LIMITS.groups} groups`); if (file.groups.some(item => item.name === name)) fail('CONFLICT', 'this group already exists', unchanged); file.groups.push({ id: randomUUID(), name }) }); return done('mail-group:' + name) }
    case 'groups/remove': { await change(file => { if (file.campaigns.some(item => item.groupId === id && ['scheduled', 'sending'].includes(item.status)) || file.flows.some(item => item.groupId === id)) fail('CONFLICT', 'a campaign or flow uses this group', unchanged); file.groups = file.groups.filter(item => item.id !== id); for (const row of file.subscribers) row.groups = row.groups.filter(group => group !== id) }); return done('mail-group:' + id) }
    case 'subscribers/import': {
      const list = parseSubscriberImport(text(body.addresses, 2_000_000, 'the address list'))
      const added = await change(file => {
        const group = groupByName(file, body.group), byAddress = new Map(file.subscribers.map(item => [item.address, item])), fresh: string[] = []
        for (const item of list) {
          const row = byAddress.get(item)
          if (!row) { if (file.subscribers.length >= LIMITS.subscribers) invalid(`at most ${LIMITS.subscribers} subscribers`); file.subscribers.push({ address: item, groups: [group.id], status: 'subscribed', addedAt: now }); fresh.push(item) }
          else if (!row.groups.includes(group.id)) { row.groups.push(group.id); fresh.push(item) }
        }
        return { group: group.id, addresses: fresh, flows: file.flows.filter(item => item.enabled && item.groupId === group.id) }
      })
      // A new member starts each enabled flow of its group, which is the flow's trigger.
      if (added.flows.length) await changeRun(store, run => { for (const item of added.flows) for (const member of added.addresses) if (run.runs.length < LIMITS.runs) run.runs.push({ flowId: item.id, address: member, step: 0, dueAt: now }) })
      return done('mail-group:' + added.group, { added: added.addresses.length })
    }
    case 'subscribers/remove': { const item = address(body.address, 'the address'); await change(file => { file.subscribers = file.subscribers.filter(row => row.address !== item) }); return done('mail-list', {}) }
    case 'subscribers/move': { const item = address(body.address, 'the address'); await change(file => { const row = file.subscribers.find(entry => entry.address === item) ?? fail('NOT_FOUND', 'subscriber not found', unchanged); row.groups = [groupByName(file, body.group).id] }); return done('mail-list', {}) }
    case 'subscribers/status': { const item = address(body.address, 'the address'); if (body.status !== 'subscribed' && body.status !== 'unsubscribed') return invalid('the status must be subscribed or unsubscribed'); const status = body.status; await change(file => { (file.subscribers.find(entry => entry.address === item) ?? fail('NOT_FOUND', 'subscriber not found', unchanged)).status = status }); return done('mail-list', {}) }
    case 'suppressed/add': { const item = address(body.address, 'the address'); await change(file => { if (file.suppressed.length >= LIMITS.suppressed) invalid(`at most ${LIMITS.suppressed} suppressed addresses`); if (!file.suppressed.some(row => row.address === item)) file.suppressed.push({ address: item, reason: 'manual', at: now }) }); return done('mail-list', {}) }
    case 'suppressed/remove': { const item = address(body.address, 'the address'); await change(file => { file.suppressed = file.suppressed.filter(row => row.address !== item) }); return done('mail-list', {}) }
    case 'suppressed/scan': {
      const { file } = await readFile(store), suppressed = new Set(file.suppressed.map(row => row.address))
      const domains = [...new Set(file.subscribers.filter(row => !suppressed.has(row.address)).map(row => row.address.slice(row.address.lastIndexOf('@') + 1)))].slice(0, LIMITS.scan), check = helpers.resolveMx ?? domainReceivesMail, dead = new Set<string>()
      for (const domain of domains) if (!await check(domain)) dead.add(domain)
      const found = await change(next => { const rows = next.subscribers.filter(row => dead.has(row.address.slice(row.address.lastIndexOf('@') + 1)) && !next.suppressed.some(item => item.address === row.address)); next.suppressed.push(...rows.slice(0, LIMITS.suppressed - next.suppressed.length).map(row => ({ address: row.address, reason: 'invalid_domain' as const, at: now }))); return rows.length })
      return done('mail-list', { domains: domains.length, invalid: dead.size, found })
    }
    case 'templates/save': {
      const name = named(body.name, 'the template name'), subject = text(body.subject, LIMITS.subject, 'the subject').trim(), textBody = text(body.text, LIMITS.body, 'the text'), html = text(body.html ?? '', LIMITS.body, 'the HTML')
      if (!subject || /[\r\n]/.test(subject) || !textBody.trim()) return invalid('a template needs a subject and a text body')
      assertVars(subject, 'subject'); assertVars(textBody, 'text'); assertVars(html, 'html')
      await change(file => { const row = file.templates.find(item => item.name === name); if (row) Object.assign(row, { subject, text: textBody, html }); else { if (file.templates.length >= LIMITS.templates) invalid(`at most ${LIMITS.templates} templates`); file.templates.push({ id: randomUUID(), name, subject, text: textBody, html }) } })
      return done('mail-template:' + name)
    }
    case 'templates/duplicate': { await change(file => { if (file.templates.length >= LIMITS.templates) invalid(`at most ${LIMITS.templates} templates`); const row = template(file); let name = row.name.slice(0, 57) + ' copy', index = 2; while (file.templates.some(item => item.name === name)) name = row.name.slice(0, 55) + ' copy ' + index++; file.templates.push({ ...row, id: randomUUID(), name }) }); return done('mail-template:' + id) }
    case 'templates/remove': { await change(file => { if (file.campaigns.some(item => item.templateId === id && ['scheduled', 'sending', 'paused'].includes(item.status)) || file.flows.some(item => item.steps.some(step => step.type === 'send' && step.templateId === id))) fail('CONFLICT', 'a campaign or flow uses this template', unchanged); file.templates = file.templates.filter(item => item.id !== id) }); return done('mail-template:' + id) }
    case 'templates/preview': { const { file } = await readFile(store), row = template(file); return workspaceJson(renderMarketing(row, row.subject, 'subscriber@example.com', (helpers.publicOrigin ?? 'https://server.example.com') + UNSUBSCRIBE_PATH)) }
    case 'campaigns/save': {
      const name = named(body.name, 'the campaign name'), fromName = named(body.fromName, 'the sender name'), fromAddress = await hostedSender(store, body.fromAddress), subject = text(body.subject ?? '', LIMITS.subject, 'the subject').trim()
      const rate = body.ratePerMinute === null || body.ratePerMinute === undefined ? MARKETING_RATE_DEFAULT : body.ratePerMinute
      if (!Number.isSafeInteger(rate) || (rate as number) < 1 || (rate as number) > MARKETING_RATE_MAX || /[\r\n]/.test(subject)) return invalid(`the rate must be 1 to ${MARKETING_RATE_MAX} messages each minute`)
      const when = typeof body.scheduledAt === 'string' && body.scheduledAt.trim() ? body.scheduledAt.trim() : null
      if (when !== null && !Number.isFinite(Date.parse(when))) return invalid('the schedule must be a date and time')
      assertVars(subject, 'subject')
      await change(file => { if (file.campaigns.length >= LIMITS.campaigns) invalid(`at most ${LIMITS.campaigns} campaigns`); file.campaigns.push({ id: randomUUID(), name, fromAddress, fromName, subject, groupId: groupByName(file, body.group).id, templateId: templateByName(file, body.template).id, ratePerMinute: rate as number, scheduledAt: when === null ? null : new Date(when).toISOString(), status: 'draft', createdAt: now }) })
      return done('mail-campaign:' + name)
    }
    case 'campaigns/start': { if (!helpers.publicOrigin) return fail('PRECONDITION_FAILED', 'campaigns need the public address of the panel for their unsubscribe link', { ...unchanged, reason: 'public_origin_required' }); await change(file => { const row = campaign(file); if (row.status === 'finished') fail('CONFLICT', 'this campaign already finished', unchanged); row.status = row.scheduledAt && Date.parse(row.scheduledAt) > Date.now() ? 'scheduled' : 'sending' }); return done('mail-campaign:' + id) }
    case 'campaigns/pause': { await change(file => { campaign(file).status = 'paused' }); return done('mail-campaign:' + id) }
    case 'campaigns/remove': { await change(file => { if (['scheduled', 'sending'].includes(campaign(file).status)) fail('CONFLICT', 'pause the campaign first', unchanged); file.campaigns = file.campaigns.filter(item => item.id !== id) }); await changeRun(store, run => { delete run.campaigns[id] }); return done('mail-campaign:' + id) }
    case 'campaigns/test': {
      const to = address(body.to, 'the test address'), { file } = await readFile(store), row = campaign(file), source = file.templates.find(item => item.id === row.templateId) ?? fail('NOT_FOUND', 'template not found', unchanged)
      const message = renderMarketing(source, '[Test] ' + (row.subject || source.subject), to, (helpers.publicOrigin ?? '') + UNSUBSCRIBE_PATH)
      try { await (await helpers.email())({ to: [to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), from: { address: row.fromAddress, name: row.fromName } }) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the local mail server did not accept the test message', { ...unchanged, reason: 'mail_refused' }) }
      return done('mail-campaign:' + id, { test: true })
    }
    case 'flows/save': {
      const name = named(body.name, 'the flow name'), fromName = named(body.fromName, 'the sender name'), fromAddress = await hostedSender(store, body.fromAddress)
      if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > LIMITS.steps) return invalid(`a flow has 1 to ${LIMITS.steps} steps`)
      await change(file => { const steps = (body.steps as unknown[]).map(line => stepOf(line, file)), groupId = groupByName(file, body.group).id, row = file.flows.find(item => item.name === name); if (row) Object.assign(row, { steps, groupId, fromAddress, fromName }); else { if (file.flows.length >= LIMITS.flows) invalid(`at most ${LIMITS.flows} flows`); file.flows.push({ id: randomUUID(), name, groupId, fromAddress, fromName, steps, enabled: false }) } })
      return done('mail-flow:' + name)
    }
    case 'flows/toggle': { await change(file => { const row = flow(file); row.enabled = !row.enabled }); return done('mail-flow:' + id) }
    case 'flows/duplicate': { await change(file => { if (file.flows.length >= LIMITS.flows) invalid(`at most ${LIMITS.flows} flows`); const row = flow(file); let name = row.name.slice(0, 57) + ' copy', index = 2; while (file.flows.some(item => item.name === name)) name = row.name.slice(0, 55) + ' copy ' + index++; file.flows.push({ ...structuredClone(row), id: randomUUID(), name, enabled: false }) }); return done('mail-flow:' + id) }
    case 'flows/remove': { await change(file => { flow(file); file.flows = file.flows.filter(item => item.id !== id) }); await changeRun(store, run => { delete run.flows[id]; run.runs = run.runs.filter(entry => entry.flowId !== id) }); return done('mail-flow:' + id) }
    default: return null
  }
}

export interface MarketingTickPorts { store: StateStore; email: EmailSender; webhook: WebhookSender; publicOrigin: string | null; now?: () => Date }
const MESSAGE_KIND = /^<xpm-(c|f)([0-9a-f]{8})-/
/** Delivery results from the log feed the counters; a bounce or an expired message suppresses the address. */
export async function applyMarketingOutcomes(store: StateStore, rows: MailOutcomes['marketing'], now: Date): Promise<void> {
  if (!rows.length) return
  const { file } = await readFile(store)
  const owner = (kind: string, prefix: string): string | undefined => (kind === 'c' ? file.campaigns : file.flows).find(item => item.id.startsWith(prefix))?.id
  await changeRun(store, run => {
    for (const row of rows) {
      const match = MESSAGE_KIND.exec(row.messageId), id = match && owner(match[1]!, match[2]!)
      if (!id || row.status === 'deferred') continue
      const counter = match![1] === 'c' ? run.campaigns[id] ??= { ...counters(), position: 0, cursor: null, lastError: null } : run.flows[id] ??= { ...counters(), webhooks: 0 }
      if (row.status === 'sent') counter.delivered++; else counter.bounced++
    }
  })
  const failed = rows.filter(row => row.status === 'bounced' || row.status === 'expired')
  if (failed.length) await changeFile(store, null, next => { for (const row of failed) if (next.suppressed.length < LIMITS.suppressed && !next.suppressed.some(item => item.address === row.recipient)) next.suppressed.push({ address: row.recipient, reason: row.status === 'expired' ? 'deferred' : 'bounced', at: now.toISOString() }) })
}
/** One minute of sending: each campaign sends at its own rate, then due flow steps run. Nothing here waits for delivery. */
export async function runMarketingTick(ports: MarketingTickPorts): Promise<void> {
  const { store } = ports, now = (ports.now ?? (() => new Date()))(), { file } = await readFile(store)
  if (!file.campaigns.length && !file.flows.length) return
  const due = file.campaigns.filter(item => item.status === 'sending' || item.status === 'scheduled' && item.scheduledAt !== null && Date.parse(item.scheduledAt) <= now.getTime())
  const blocked = new Set(file.suppressed.map(item => item.address)), secret = await key(store), templates = new Map(file.templates.map(item => [item.id, item]))
  const link = (groupId: string, target: string): string => (ports.publicOrigin ?? '') + UNSUBSCRIBE_PATH + '?t=' + encodeURIComponent(unsubscribeToken(secret, groupId, target))
  const send = async (input: { kind: 'c' | 'f'; id: string; sequence: number; fromAddress: string; fromName: string; subject: string; template: MarketingTemplate; groupId: string; target: string }): Promise<void> => {
    const unsubscribeUrl = link(input.groupId, input.target), message = renderMarketing(input.template, input.subject, input.target, unsubscribeUrl)
    await ports.email({ to: [input.target], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), from: { address: input.fromAddress, name: input.fromName },
      messageId: `${MARKETING_MESSAGE_PREFIX}${input.kind}${input.id.slice(0, 8)}-${input.sequence}@${input.fromAddress.slice(input.fromAddress.lastIndexOf('@') + 1)}>`,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', Precedence: 'bulk' } })
  }
  for (const campaign of due) {
    const template = templates.get(campaign.templateId)
    if (!template || !ports.publicOrigin) { await changeRun(store, run => { (run.campaigns[campaign.id] ??= { ...counters(), position: 0, cursor: null, lastError: null }).lastError = template ? 'public_origin_required' : 'template_missing' }); continue }
    const audience = file.subscribers.filter(item => item.groups.includes(campaign.groupId) && item.status === 'subscribed').map(item => item.address).sort()
    // The cursor is an address, not an index: someone unsubscribing mid-send must not shift who comes next.
    const progress = (await readRun(store)).campaigns[campaign.id], start = progress?.position ?? 0, left = audience.filter(item => progress?.cursor === null || progress?.cursor === undefined || item > progress.cursor), slice = left.slice(0, campaign.ratePerMinute)
    const tally = { ...counters(), error: null as string | null }
    let offset = 0, cursor = progress?.cursor ?? null
    for (const target of slice) {
      if (blocked.has(target)) { tally.skipped++; offset++; cursor = target; continue }
      try { await send({ kind: 'c', id: campaign.id, sequence: start + offset, fromAddress: campaign.fromAddress, fromName: campaign.fromName, subject: campaign.subject, template, groupId: campaign.groupId, target }); tally.sent++; offset++; cursor = target }
      catch (error) {
        tally.error = error instanceof DeliveryFailure ? error.code : 'unreachable'
        // A refused address is one failure; a mail server that cannot be reached stops this minute, and the next one continues.
        if (tally.error === 'refused') { tally.failed++; offset++; cursor = target } else break
      }
    }
    const position = start + offset, finished = offset >= left.length
    await changeRun(store, run => { const row = run.campaigns[campaign.id] ??= { ...counters(), position: 0, cursor: null, lastError: null }; row.position = position; row.cursor = cursor; row.sent += tally.sent; row.failed += tally.failed; row.skipped += tally.skipped; row.lastError = tally.error })
    if (finished || campaign.status === 'scheduled') await changeFile(store, null, next => { const row = next.campaigns.find(item => item.id === campaign.id); if (row && row.status !== 'paused') row.status = finished ? 'finished' : 'sending' })
  }
  const dueRuns = (await readRun(store)).runs.filter(entry => Date.parse(entry.dueAt) <= now.getTime()).slice(0, MARKETING_RATE_DEFAULT)
  for (const entry of dueRuns) {
    const flow = file.flows.find(item => item.id === entry.flowId), step = flow?.steps[entry.step], subscriber = file.subscribers.find(item => item.address === entry.address)
    const eligible = !!flow?.enabled && !!subscriber && subscriber.status === 'subscribed' && subscriber.groups.includes(flow.groupId) && !blocked.has(entry.address)
    let nextAt = now, sent = 0, failed = 0, webhooks = 0
    if (eligible && step?.type === 'delay') nextAt = new Date(now.getTime() + step.minutes * 60_000)
    if (eligible && step?.type === 'send') {
      const template = templates.get(step.templateId), sequence = await changeRun(store, run => run.sequence++)
      try { if (!template || !ports.publicOrigin) throw new Error('flow_send_unavailable'); await send({ kind: 'f', id: flow!.id, sequence, fromAddress: flow!.fromAddress, fromName: flow!.fromName, subject: template.subject, template, groupId: flow!.groupId, target: entry.address }); sent = 1 } catch { failed = 1 }
    }
    if (eligible && step?.type === 'webhook') {
      const payload = JSON.stringify({ event: 'mail.flow.step', flow: flow!.name, address: entry.address, at: now.toISOString() })
      try { const result = await ports.webhook({ url: step.url, body: payload, headers: { 'content-type': 'application/json' } }); if (result.status >= 200 && result.status < 300) webhooks = 1; else failed = 1 } catch { failed = 1 }
    }
    await changeRun(store, run => {
      const row = run.runs.find(item => item.flowId === entry.flowId && item.address === entry.address && item.step === entry.step)
      if (flow) { const counter = run.flows[flow.id] ??= { ...counters(), webhooks: 0 }; counter.sent += sent; counter.failed += failed; counter.webhooks += webhooks }
      if (!row) return
      if (!eligible || entry.step + 1 >= (flow?.steps.length ?? 0)) run.runs = run.runs.filter(item => item !== row)
      else { row.step++; row.dueAt = nextAt.toISOString() }
    })
  }
}
