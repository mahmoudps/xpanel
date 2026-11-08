import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan, ServiceUser } from '@xpanel/core'
import { mailboxFoldersArgv } from '../../../packages/os/src/mailbox-maintenance-command.ts'
import { isExpungeFolder, mailboxExpungeArgv, parseExpungeQuery } from '../../../packages/os/src/mailbox-expunge-command.ts'
import { parseMailboxStatus } from './mailbox-maintenance.ts'
import type { FoldersRead, MaintenanceRun } from './mailbox-maintenance.ts'
import type { AgentCallerIdentity } from './server.ts'

/** cPanel Email Disk Usage: the account owner reads one mailbox's folders and clears messages by a preset or a typed query. */
export const EMAIL_DISK_USAGE_FEATURE = 'email-disk-usage'
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/email\/disk-usage(\/cleanup)?$/
const unchanged = { stateChanged: false }
export const CLEANUP_PRESETS: Readonly<Record<string, readonly string[]>> = { 'older-than-year': ['BEFORE', '365d'], 'larger-than-30mb': ['LARGER', '30M'], read: ['SEEN'], all: ['ALL'] }
export interface EmailDiskUsageView { mailbox: string; observedAt: string; folders: FoldersRead }
export interface CleanupRequest { mailbox: string; folder: string; preset: string; query: string | null; terms: readonly string[]; expected: string }

/** The confirmation must name the folder, so a stale or scripted form cannot delete from another one. */
export function parseCleanupRequest(raw: unknown): CleanupRequest {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null, invalid = (message: string): never => fail('VALIDATION', message, unchanged)
  if (!body || Object.keys(body).sort().join() !== 'confirmFolder,folder,mailbox,preset,query') return invalid('mailbox, folder, preset, query and confirmFolder are required')
  if (typeof body.mailbox !== 'string' || !isExpungeFolder(body.folder) || typeof body.preset !== 'string') return invalid('choose a mailbox, a folder and a cleanup')
  if (body.confirmFolder !== body.folder) return invalid('type the folder name to confirm permanent deletion')
  if (body.preset === 'custom') {
    const terms = parseExpungeQuery(body.query)
    return terms ? { mailbox: body.mailbox, folder: body.folder, preset: 'custom', query: body.query as string, terms, expected: body.folder } : invalid('enter a search such as LARGER 10M or BEFORE 2025-01-01; an empty search is refused')
  }
  const preset = Object.hasOwn(CLEANUP_PRESETS, body.preset) ? CLEANUP_PRESETS[body.preset]! : null
  return preset && body.query === null ? { mailbox: body.mailbox, folder: body.folder, preset: body.preset, query: null, terms: preset, expected: body.folder } : invalid('unknown cleanup')
}

export interface EmailDiskUsageRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listServiceUsers(accountId: string): Promise<ServiceUser[]> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Null off a native host: the page says so and nothing is simulated. */
  run: MaintenanceRun | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
  now?: () => Date
}

export async function handleEmailDiskUsageRoute(req: Request, url: URL, method: string, deps: EmailDiskUsageRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const cleanup = !!match[2]
  if (method !== (cleanup ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: cleanup ? 'POST' : 'GET' } })
  const { caller } = deps
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'Email Disk Usage requires the signed-in account owner', unchanged)
  let request: CleanupRequest | null = null, mailbox: string
  if (cleanup) {
    if (url.search) return fail('VALIDATION', 'cleanup takes no query selectors', unchanged)
    const text = await req.text()
    if (text.length > 2048) return fail('VALIDATION', 'cleanup request is too large', unchanged)
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'cleanup request must be JSON', unchanged) }
    request = parseCleanupRequest(raw); mailbox = request.mailbox
  } else {
    const value = url.searchParams.get('mailbox')
    if (!value || [...url.searchParams.keys()].join() !== 'mailbox') return fail('VALIDATION', 'choose one mailbox', unchanged)
    mailbox = value
  }
  const account = await deps.store.getAccountByUsername(match[1]!)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<void> => {
      const principal = await deps.currentPrincipal(), plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== fresh.id || fresh.username !== match[1] || fresh.status !== 'active' || !features || features.disabled.includes(EMAIL_DISK_USAGE_FEATURE)) return fail('FORBIDDEN', 'current account owner is not authorized for Email Disk Usage', unchanged)
    }
    await authorize()
    if (!(await deps.store.listServiceUsers(fresh.id)).some(user => user.login === mailbox && user.services.email)) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    if (!deps.run) return fail('PRECONDITION_FAILED', 'mailbox storage cannot be read on this host', unchanged)
    const read = async (): Promise<EmailDiskUsageView> => {
      const result = await deps.run!(mailboxFoldersArgv(mailbox)).catch(() => null)
      return { mailbox, observedAt: (deps.now ?? (() => new Date()))().toISOString(), folders: parseMailboxStatus(result) }
    }
    if (!request) return json(await read())
    const before = await read()
    if (before.folders.state !== 'read') return fail('SERVICE_UNAVAILABLE', 'the mailbox could not be read, so nothing was deleted', unchanged)
    if (!before.folders.folders.some(folder => folder.name === request.folder)) return fail('NOT_FOUND', 'folder not found', unchanged)
    await authorize()
    const argv = mailboxExpungeArgv(mailbox, request.folder, request.terms), detail = { mailbox, folder: request.folder, preset: request.preset }
    const result = await deps.run(argv).catch(() => null)
    if (!result?.ok) {
      await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'email.disk_usage.cleanup', target: 'mailbox:' + mailbox, outcome: 'failed', detail }).catch(() => undefined)
      return fail('SERVICE_UNAVAILABLE', 'the cleanup could not be confirmed; read the mailbox before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    const after = await read(), size = (view: EmailDiskUsageView): number | null => view.folders.folders.find(folder => folder.name === request.folder)?.vsizeBytes ?? null
    const beforeSize = size(before), afterSize = size(after)
    await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'email.disk_usage.cleanup', target: 'mailbox:' + mailbox, outcome: 'ok', detail: { ...detail, ...(beforeSize !== null && afterSize !== null ? { freedBytes: Math.max(0, beforeSize - afterSize) } : {}) } })
      .catch(error => { if (isXpanelError(error)) throw error; return fail('SERVICE_UNAVAILABLE', 'the cleanup ran but could not be recorded', { stateChanged: true, verificationRequired: true }) })
    return json({ ...after, freedBytes: beforeSize !== null && afterSize !== null ? Math.max(0, beforeSize - afterSize) : null })
  })
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
