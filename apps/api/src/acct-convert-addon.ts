import { createHash } from 'node:crypto'
import { defaultDocRoot, fail, isXpanelError, validateUsername } from '@xpanel/core'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readConversionJournal } from './lifecycle-convert-addon.ts'

export type ConvertAddonSnapshot = Pick<StateSnapshot, 'plans' | 'accounts' | 'domains' | 'serviceUsers' | 'zones' | 'revision' | 'domainCustomConfigs'>
export interface ConvertAddonPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  readSnapshot: () => Promise<ConvertAddonSnapshot>
  /** True when an account or a panel principal already holds the name. */
  usernameTaken: (username: string) => Promise<boolean>
  /** Journaled apply (apps/api/src/lifecycle-convert-addon.ts); absent where the host agent or the file runner is missing. */
  execute?: (caller: AuthenticatedCaller, plan: ConvertAddonPlan, snapshot: ConvertAddonSnapshot) => Promise<Response>
  readJournal?: () => Promise<unknown>
}
export type ConvertAddonConflictKind = 'username-invalid' | 'username-taken' | 'plan-missing' | 'account-inactive' | 'docroot-outside-home' | 'docroot-shared'
  | 'subdomain-docroot-outside' | 'service-user-not-mail' | 'certificate-shared' | 'custom-configuration' | 'plan-capacity'
export interface ConvertAddonPlan {
  source: { accountId: string; username: string; domainId: string; domain: string; docRoot: string }
  target: { username: string; planId: string; planName: string | null; home: string | null; documentRoot: string | null }
  domains: { id: string; name: string; kind: string; docRoot: string }[]
  mail: { mailboxes: string[]; otherServiceUsers: string[] }
  dns: { zone: string; records: number }[]
  certificates: number
  conflicts: { kind: ConvertAddonConflictKind; value: string }[]
}

export const CONVERT_ADDON_APPLY_UNAVAILABLE = 'converting needs the host agent and the confined account file runner; this server has neither connected, so nothing was changed'
const ROUTE = /^\/api\/transfers\/convert-addon(?:\/(preview|apply))?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_BODY_BYTES = 2048
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + '/')

/** Pure review: what would move with the addon domain and what blocks it. Nothing here touches the host. */
export function planAddonConversion(snapshot: ConvertAddonSnapshot, input: { domainId: string; username: string; planId: string }, usernameTaken: boolean): ConvertAddonPlan {
  const addon = snapshot.domains.find(domain => domain.id === input.domainId && domain.kind === 'addon')
  if (!addon) return fail('NOT_FOUND', 'addon domain not found', { stateChanged: false })
  const account = snapshot.accounts.find(item => item.id === addon.accountId)
  if (!account) return fail('PRECONDITION_FAILED', 'the addon domain has no saved owner account', { stateChanged: false })
  // Subdomains and aliases hang off their parent by parentId; collect the whole subtree.
  const moved = [addon]
  for (let i = 0; i < moved.length; i++) moved.push(...snapshot.domains.filter(domain => domain.parentId === moved[i]!.id && !moved.includes(domain)))
  const movedIds = new Set(moved.map(domain => domain.id)), names = new Set(moved.map(domain => domain.name))
  const staying = snapshot.domains.filter(domain => domain.accountId === account.id && !movedIds.has(domain.id))
  const conflicts: ConvertAddonPlan['conflicts'] = []
  let username = input.username, valid = true
  try { username = validateUsername(input.username) } catch (error) { if (!isXpanelError(error)) throw error; valid = false; conflicts.push({ kind: 'username-invalid', value: input.username }) }
  if (valid && usernameTaken) conflicts.push({ kind: 'username-taken', value: username })
  const plan = snapshot.plans.find(item => item.id === input.planId)
  if (!plan) conflicts.push({ kind: 'plan-missing', value: input.planId })
  if (account.status !== 'active') conflicts.push({ kind: 'account-inactive', value: account.username })
  if (!inside(addon.docRoot, account.home) || addon.docRoot === account.home) conflicts.push({ kind: 'docroot-outside-home', value: addon.docRoot })
  else if (staying.some(domain => inside(domain.docRoot, addon.docRoot) || inside(addon.docRoot, domain.docRoot))) conflicts.push({ kind: 'docroot-shared', value: addon.docRoot })
  // The same refusals the atomic store move applies, shown before anything is attempted.
  for (const domain of moved) if (!inside(domain.docRoot, addon.docRoot)) conflicts.push({ kind: 'subdomain-docroot-outside', value: domain.name })
  const users = snapshot.serviceUsers.filter(user => movedIds.has(user.domainId))
  for (const user of users) if (Object.entries(user.services).some(([service, on]) => service !== 'email' && on)) conflicts.push({ kind: 'service-user-not-mail', value: user.login })
  const certificates = new Set(moved.flatMap(domain => domain.certificateId ? [domain.certificateId] : []))
  for (const domain of staying) if (domain.certificateId && certificates.has(domain.certificateId)) conflicts.push({ kind: 'certificate-shared', value: domain.name })
  for (const config of snapshot.domainCustomConfigs ?? []) if (movedIds.has(config.domainId)) conflicts.push({ kind: 'custom-configuration', value: moved.find(domain => domain.id === config.domainId)!.name })
  if (plan) {
    const over = (limit: number | 'unlimited', count: number): boolean => limit !== 'unlimited' && count > limit
    if (over(plan.caps.subdomains, moved.filter(domain => domain.kind === 'subdomain').length)) conflicts.push({ kind: 'plan-capacity', value: 'subdomains' })
    if (over(plan.caps.aliasDomains, moved.filter(domain => domain.kind === 'alias').length)) conflicts.push({ kind: 'plan-capacity', value: 'aliasDomains' })
    if (over(plan.caps.mailboxes, users.filter(user => user.services.email).length)) conflicts.push({ kind: 'plan-capacity', value: 'mailboxes' })
  }
  const home = valid ? '/home/' + username : null
  return {
    source: { accountId: account.id, username: account.username, domainId: addon.id, domain: addon.name, docRoot: addon.docRoot },
    target: { username, planId: input.planId, planName: plan?.name ?? null, home, documentRoot: home ? defaultDocRoot({ home, username }, 'primary', addon.name) : null },
    domains: moved.map(domain => ({ id: domain.id, name: domain.name, kind: domain.kind, docRoot: domain.docRoot })),
    mail: {
      mailboxes: snapshot.serviceUsers.filter(user => movedIds.has(user.domainId) && user.services.email).map(user => user.login).sort(),
      otherServiceUsers: snapshot.serviceUsers.filter(user => movedIds.has(user.domainId) && !user.services.email).map(user => user.login).sort(),
    },
    dns: snapshot.zones.filter(zone => names.has(zone.name)).map(zone => ({ zone: zone.name, records: zone.records.length })).sort((a, b) => a.zone.localeCompare(b.zone)),
    certificates: moved.filter(domain => domain.certificateId !== null).length,
    conflicts,
  }
}
/** Binds a reviewed plan to every saved fact it was derived from. */
export const addonConversionRevision = (plan: ConvertAddonPlan, snapshot: ConvertAddonSnapshot): string => {
  const accountDomains = snapshot.domains.filter(domain => domain.accountId === plan.source.accountId)
  return digest([plan, snapshot.accounts.find(account => account.id === plan.source.accountId), accountDomains, snapshot.serviceUsers.filter(user => accountDomains.some(domain => domain.id === user.domainId)), snapshot.zones.filter(zone => plan.dns.some(item => item.zone === zone.name)), snapshot.plans.find(item => item.id === plan.target.planId) ?? null])
}

export function parseConvertAddonInput(body: unknown, apply: boolean): { domainId: string; username: string; planId: string; expectedRevision?: string; confirm?: string } {
  if (!object(body) || keys(body) !== (apply ? 'confirm,domainId,expectedRevision,planId,username' : 'domainId,planId,username')) return invalid(apply ? 'exactly domainId, username, planId, expectedRevision and confirm are required' : 'exactly domainId, username and planId are required')
  if (typeof body.domainId !== 'string' || !UUID.test(body.domainId) || typeof body.planId !== 'string' || !UUID.test(body.planId)) return invalid('select one addon domain and one plan')
  if (typeof body.username !== 'string' || !/^[a-z0-9]{1,32}$/.test(body.username)) return invalid('the new account username must be lower-case letters and digits')
  if (!apply) return { domainId: body.domainId, username: body.username, planId: body.planId }
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision) || typeof body.confirm !== 'string' || body.confirm.length > 300) return invalid('the reviewed revision and confirmation are required')
  return { domainId: body.domainId, username: body.username, planId: body.planId, expectedRevision: body.expectedRevision, confirm: body.confirm }
}
const readBody = async (req: Request): Promise<unknown> => {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}
const same = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

/** Root-only: GET candidates and the conversion journal, POST preview, POST apply (CAS-checked, confirmed, journaled). */
export async function handleConvertAddonRoute(req: Request, url: URL, method: string, ports: ConvertAddonPorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const operation = match[1] ?? 'read'
  const capabilities = ports.execute ? { preview: true, apply: true, reason: 'journaled-move' } : { preview: true, apply: false, reason: 'host-agent-unavailable' }
  const caller = await ports.requireCaller(req)
  await ports.assertRoot(caller, 'transfers.convert-addon')
  const allow = operation === 'read' ? 'GET' : 'POST'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return invalid('addon conversion accepts no selectors')
  if (operation === 'read') {
    const snapshot = await ports.readSnapshot(), owners = new Map(snapshot.accounts.map(account => [account.id, account]))
    const candidates = snapshot.domains.filter(domain => domain.kind === 'addon' && owners.has(domain.accountId)).sort((a, b) => a.name.localeCompare(b.name))
      .map(domain => ({ domainId: domain.id, domain: domain.name, docRoot: domain.docRoot, account: { id: domain.accountId, username: owners.get(domain.accountId)!.username, status: owners.get(domain.accountId)!.status } }))
    const journal = ports.readJournal ? readConversionJournal(await ports.readJournal()).slice(-20).reverse() : []
    return json({ candidates, plans: snapshot.plans.map(plan => ({ id: plan.id, name: plan.name })).sort((a, b) => a.name.localeCompare(b.name)), capabilities, journal })
  }
  const input = parseConvertAddonInput(await readBody(req), operation === 'apply')
  const snapshot = await ports.readSnapshot()
  const plan = planAddonConversion(snapshot, input, await ports.usernameTaken(input.username))
  const revision = addonConversionRevision(plan, snapshot)
  const fresh = await ports.requireCaller(req)
  await ports.assertRoot(fresh, 'transfers.convert-addon')
  if (!same(fresh, caller)) return fail('FORBIDDEN', 'addon conversion authority changed', { stateChanged: false })
  if (operation === 'preview') return json({ plan, revision, capabilities })
  if (input.confirm !== 'convert ' + plan.source.domain) return invalid('type the exact confirmation: convert ' + plan.source.domain)
  if (revision !== input.expectedRevision) return fail('CONFLICT', 'the saved account, domain, mail or DNS state changed; preview again', { stateChanged: false })
  if (plan.conflicts.length) return fail('PRECONDITION_FAILED', 'resolve the listed conflicts before converting', { stateChanged: false, conflicts: plan.conflicts })
  if (!ports.execute) return fail('PRECONDITION_FAILED', CONVERT_ADDON_APPLY_UNAVAILABLE, { stateChanged: false, reason: capabilities.reason })
  return ports.execute(fresh, plan, snapshot)
}
