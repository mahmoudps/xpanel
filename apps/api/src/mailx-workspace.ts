import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import {
  MAILX_DEFAULTS, MAILX_PARSERS, isMailxInvalid, isMailxRelayPassword, isMailxSection, mailxCompositeRevision, mailxRevision, mailxStatePath, parseMailxArchive, readMailxArchiveStored, readMailxStored,
} from '../../agent/src/mailx-policy.ts'
import type { MailxArchivePolicy, MailxArchiveStored, MailxPolicies, MailxRelayPolicy, MailxSection, MailxStored } from '../../agent/src/mailx-policy.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'

export interface MailxWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'assertCanAccessAccount' | 'emitAudit'> {
  store: StateStore
  /** Authenticated agent transport for /host/mailx/*; absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  now?: () => Date
}
type SectionState = 'not-saved' | 'applied' | 'pending' | 'unavailable'
export type MailxHost = 'connected' | 'not-connected' | 'unverified'
export type MailxReconcile = 'applied' | 'unchanged' | 'failed' | 'unknown' | 'unavailable'
/** `reconcile` is the generation that renders the spam milter, mailbox Sieve scripts and mailing lists. */
export interface MailxApplication { outcome: 'applied' | 'rolled-back' | 'nothing' | 'refused' | 'unknown' | 'not-connected'; verificationRequired: boolean; spam: 'applied' | 'unavailable' | 'not-saved' | 'rolled-back' | null; mailboxes?: 'applied' | 'unavailable' | 'not-saved' | 'rolled-back' | null; reconcile?: MailxReconcile | null }
export interface MailxHostStatus {
  observedAt: string; revision: string; postfix: 'read' | 'unavailable'
  engine: { engine: 'rspamd' | 'spamassassin' | null; units: Record<string, 'active' | 'inactive' | 'not-installed' | 'unknown'>; wiring: 'wired' | 'not-wired' | 'unknown' }
  sections: Record<MailxSection, SectionState>
}

const unchanged = { stateChanged: false }
const review = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const STATES = ['not-saved', 'applied', 'pending', 'unavailable'], UNIT_STATES = ['active', 'inactive', 'not-installed', 'unknown']
const RECONCILE = ['applied', 'unchanged', 'failed', 'unknown', 'unavailable']
const invalidHost = (): never => { throw new Error('invalid_mailx_host') }

/** Whitelists the agent status: fixed keys and closed vocabularies only. */
export function projectMailxHostStatus(value: unknown): MailxHostStatus {
  if (!object(value) || !iso(value.observedAt) || !hex(value.revision) || !['read', 'unavailable'].includes(String(value.postfix)) || !object(value.engine) || !object(value.sections) || !object(value.engine.units)) return invalidHost()
  const engine = value.engine, units = engine.units as Record<string, unknown>
  if (![null, 'rspamd', 'spamassassin'].includes(engine.engine as string) || !['wired', 'not-wired', 'unknown'].includes(String(engine.wiring))
    || !exact(units, ['rspamd.service', 'spamassassin.service', 'spamd.service']) || Object.values(units).some(item => !UNIT_STATES.includes(String(item)))) return invalidHost()
  const sections = value.sections as Record<string, unknown>
  if (!exact(sections, ['spam', 'relay', 'bcc', 'marketing']) || Object.values(sections).some(item => !STATES.includes(String(item)))) return invalidHost()
  return { observedAt: value.observedAt, revision: value.revision, postfix: value.postfix as 'read', engine: { engine: engine.engine as 'rspamd' | null, units: { ...units } as MailxHostStatus['engine']['units'], wiring: engine.wiring as 'wired' },
    sections: { ...sections } as MailxHostStatus['sections'] }
}
function projectApply(value: unknown): MailxApplication {
  if (!object(value) || !['applied', 'unknown', 'rolled-back', 'nothing'].includes(String(value.outcome)) || typeof value.verificationRequired !== 'boolean' || !['applied', 'unavailable', 'not-saved', 'rolled-back'].includes(String(value.spam))) return invalidHost()
  if ((value.outcome === 'unknown') !== value.verificationRequired) return invalidHost()
  if (!['applied', 'unavailable', 'not-saved', 'rolled-back'].includes(String(value.mailboxes)) || !RECONCILE.includes(String(value.reconcile)) || value.reconcile === 'unknown' && value.outcome !== 'unknown') return invalidHost()
  return { outcome: value.outcome as MailxApplication['outcome'], verificationRequired: value.verificationRequired, spam: value.spam as MailxApplication['spam'], mailboxes: value.mailboxes as MailxApplication['spam'], reconcile: value.reconcile as MailxReconcile }
}

async function boundedBody(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !req.body) return fail('VALIDATION', 'JSON is required', unchanged)
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: unknown
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 128 * 1024) { await reader.cancel(); return fail('VALIDATION', 'mail policy request exceeds its bound', unchanged) } chunks.push(part.value) }
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('VALIDATION', 'valid UTF-8 JSON is required', unchanged) }
  } finally { reader.releaseLock() }
  if (!exact(raw, keys)) return fail('VALIDATION', 'mail policy request requires only supported fields', unchanged)
  if (!hex(raw.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be the captured revision', unchanged)
  return raw
}
const parse = <T>(read: () => T): T => { try { return read() } catch (error) { if (isMailxInvalid(error)) return fail('VALIDATION', `invalid mail policy field: ${error.field}`, { ...unchanged, field: error.field }); throw error } }

const sectionPath = (store: StateStore, section: MailxSection): string => join(store.rootDir, ...mailxStatePath(section + '.json'))
const archivePath = (store: StateStore, accountId: string): string => join(store.rootDir, ...mailxStatePath('archive', accountId + '.json'))
async function loadSection<S extends MailxSection>(store: StateStore, section: S): Promise<MailxStored<S> | null> {
  const raw = await readJsonIfExists<unknown>(sectionPath(store, section))
  try { return raw === null ? null : readMailxStored(section, raw) } catch { return fail('PRECONDITION_FAILED', 'saved mail policy requires review', { ...unchanged, reason: 'saved_policy_review' }) }
}
async function loadArchive(store: StateStore, accountId: string): Promise<MailxArchiveStored | null> {
  const raw = await readJsonIfExists<unknown>(archivePath(store, accountId))
  try { return raw === null ? null : readMailxArchiveStored(accountId, raw) } catch { return fail('PRECONDITION_FAILED', 'saved archive policy requires review', { ...unchanged, reason: 'saved_policy_review' }) }
}
const publicPolicy = (section: MailxSection, stored: MailxStored | null): Record<string, unknown> => {
  const policy = { ...(stored?.policy ?? MAILX_DEFAULTS[section]) } as Record<string, unknown>
  return section === 'relay' ? { ...policy, passwordSet: !!stored?.secret } : policy
}

/** Server mail policy (/whm/email/spam|relay|bcc|marketing) and the owner archive (/email/archive). Saves first, then applies through the agent. */
export function createMailxWorkspaceRoutes(helpers: MailxWorkspaceHelpers) {
  const now = () => (helpers.now ?? (() => new Date()))()
  const status = async (caller: AuthenticatedCaller, path: string): Promise<{ host: MailxHost; status: unknown }> => {
    if (!helpers.callHost) return { host: 'not-connected', status: null }
    try { return { host: 'connected', status: await helpers.callHost(caller, path) } } catch { return { host: 'unverified', status: null } }
  }
  const apply = async (caller: AuthenticatedCaller, path: string): Promise<MailxApplication> => {
    if (!helpers.callHost) return { outcome: 'not-connected', verificationRequired: false, spam: null }
    let revision: string
    try { revision = mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) } catch { return { outcome: 'refused', verificationRequired: false, spam: null } }
    try { return projectApply(await helpers.callHost(caller, path, { revision })) } catch (error) {
      return isXpanelError(error) && error.detail?.stateChanged === false ? { outcome: 'refused', verificationRequired: false, spam: null } : { outcome: 'unknown', verificationRequired: true, spam: null }
    }
  }
  const audit = async (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, failed = false): Promise<void> => {
    try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target, outcome: failed ? 'failed' : 'ok', detail }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'saved mail policy requires audit review', review) }
  }
  const sameCaller = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

  const server = async (req: Request, url: URL, method: string, section: MailxSection | 'apply'): Promise<Response> => {
    const action = 'server.mail-policy.' + section, initial = await helpers.requireCaller(req)
    await helpers.assertRoot(initial, action)
    const allowed = section === 'apply' ? ['POST'] : ['GET', 'PUT']
    if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
    if (url.search) return fail('VALIDATION', 'mail policy routes accept no selectors', unchanged)
    const fresh = async (): Promise<AuthenticatedCaller> => {
      const current = await helpers.requireCaller(req)
      await helpers.assertRoot(current, action)
      return sameCaller(current, initial) ? current : fail('FORBIDDEN', 'mail policy authority changed', unchanged)
    }
    const view = async (target: MailxSection, caller: AuthenticatedCaller, application: MailxApplication | null = null) => {
      const stored = await loadSection(helpers.store, target), observed = await status(caller, '/host/mailx/state')
      let host: MailxHostStatus | null = null, hostState: MailxHost = observed.host
      if (observed.status !== null) try { host = projectMailxHostStatus(observed.status) } catch { hostState = 'unverified' }
      return { section: target, saved: !!stored, revision: mailxRevision(target, stored), policy: publicPolicy(target, stored), defaults: publicPolicy(target, null),
        updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null, host: hostState, observedAt: host?.observedAt ?? null,
        state: !stored ? 'not-saved' : host ? host.sections[target] : 'unavailable', engine: target === 'spam' && host ? host.engine : null, application }
    }
    if (section === 'apply') {
      const body = await boundedBody(req, ['expectedRevision'])
      const saved = await readMailxSaved(helpers.store.rootDir)
      if (mailxCompositeRevision(saved) !== body.expectedRevision) return fail('CONFLICT', 'saved mail policy changed; reload before applying', unchanged)
      const caller = await fresh(), application = await apply(caller, '/host/mailx/apply')
      await audit(caller, 'server.mail_policy.applied', 'server:mail-policy', { outcome: application.outcome }, application.outcome === 'unknown')
      return json({ application })
    }
    if (method === 'GET') { const caller = await fresh(), body = await view(section, caller); await fresh(); return json({ ...body, compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) }) }
    const body = await boundedBody(req, section === 'relay' ? ['policy', 'expectedRevision', 'password'] : ['policy', 'expectedRevision'])
    const policy = parse(() => MAILX_PARSERS[section](body.policy)) as MailxPolicies[typeof section]
    if (section === 'relay' && body.password !== null && !isMailxRelayPassword(body.password)) return fail('VALIDATION', 'the relay password must be 1 to 256 printable characters without edge spaces', { ...unchanged, field: 'password' })
    const lease = await helpers.store.getWriterLock().acquire()
    let wrote = false, same = false, caller = initial
    const save = async (): Promise<void> => {
      let stored: MailxStored
      caller = await fresh(); await lease.assertFencingToken()
      const before = await loadSection(helpers.store, section)
      if (mailxRevision(section, before) !== body.expectedRevision) return fail('CONFLICT', 'mail policy changed; reload before saving', unchanged)
      const base = { section, policy, updatedAt: now().toISOString(), updatedBy: caller.principal.username }
      if (section === 'relay') {
        const relay = policy as MailxRelayPolicy, password = body.password as string | null
        // null keeps the saved password; a username without any password cannot authenticate.
        const secret = relay.username === null ? null : password !== null ? { password, version: randomUUID() } : before?.secret ?? null
        if (relay.username !== null && !secret) return fail('VALIDATION', 'a relay username requires a password', { ...unchanged, field: 'password' })
        stored = { section, policy, secret, updatedAt: base.updatedAt, updatedBy: base.updatedBy } as MailxStored
      } else stored = base as MailxStored
      if (before && JSON.stringify(before.policy) === JSON.stringify(policy) && (section !== 'relay' || body.password === null)) { same = true; return }
      caller = await fresh(); await lease.assertFencingToken(); wrote = true
      await atomicWriteJson(sectionPath(helpers.store, section), stored, section === 'relay' ? 0o600 : 0o640, () => lease.assertFencingToken())
      const after = await loadSection(helpers.store, section)
      if (JSON.stringify(after) !== JSON.stringify(stored)) throw new Error('mailx_readback_mismatch')
    }
    try { await save() } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'mail policy save outcome requires inspection', review)
      throw error
    } finally { await lease.release() }
    if (same) return json({ ...await view(section, await fresh()), stateChanged: false })
    const application = await apply(await fresh(), '/host/mailx/apply')
    await audit(caller, `server.mail_policy.${section}_saved`, 'server:mail-policy', { outcome: application.outcome, ...(section === 'relay' ? { passwordChanged: body.password !== null } : {}) }, application.outcome === 'unknown')
    return json({ ...await view(section, await fresh(), application), stateChanged: true })
  }

  const ownerAuthorize = async (req: Request, original?: AuthenticatedCaller, current?: Account, tools: readonly string[] = ['email-accounts', 'email-archive']) => {
    const caller = await helpers.requireCaller(req)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller) || original && !sameCaller(original, caller)) return fail('FORBIDDEN', 'the current hosting account owner is required', unchanged)
    const account = current ?? await helpers.store.getAccount(caller.principal.accountId)
    if (!account || account.id !== caller.principal.accountId || account.username !== caller.principal.username || account.status !== 'active') return fail('FORBIDDEN', 'the active hosting account owner is required', unchanged)
    await helpers.assertCanAccessAccount(caller, account, tools.includes('email-archive') ? 'mail.archive' : 'mail.tools')
    await assertAccountFeatures(helpers.store, caller, account, tools)
    return { caller, account }
  }
  /** Archive targets are the owner's own domains and their existing mailboxes; nothing comes from the request but names. */
  const choices = async (account: Account) => {
    const domains = (await helpers.store.listDomains({ accountId: account.id })).filter(domain => domain.accountId === account.id).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
    const users = (await helpers.store.listServiceUsers(account.id)).filter(user => user.accountId === account.id && user.services.email)
    return domains.map(domain => ({ domain: domain.name, mailboxes: users.filter(user => user.login.toLowerCase().endsWith('@' + domain.name.toLowerCase())).map(user => user.login.toLowerCase()).sort().slice(0, 1000) }))
  }
  const archiveView = async (caller: AuthenticatedCaller, account: Account, stored: MailxArchiveStored | null, application: MailxApplication | null = null) => {
    const observed = await status(caller, '/host/mailx/accounts/' + account.username + '/archive')
    let host: MailxHost = observed.host, read: { observedAt: string; state: SectionState; jobsAvailable: boolean; rows: Map<string, { admission: string; conflicts: string[] }> } | null = null
    if (observed.status !== null) try {
      const raw = observed.status
      if (!object(raw) || !iso(raw.observedAt) || !STATES.includes(String(raw.state)) || typeof raw.jobsAvailable !== 'boolean' || !Array.isArray(raw.domains) || raw.domains.length > 200) throw new Error()
      const rows = new Map(raw.domains.map(row => {
        if (!object(row) || typeof row.domain !== 'string' || !['eligible', 'account-inactive', 'domain-missing', 'mailbox-missing'].includes(String(row.admission)) || !Array.isArray(row.conflicts) || row.conflicts.some(item => !['incoming', 'outgoing'].includes(item))) throw new Error()
        return [row.domain, { admission: row.admission as string, conflicts: [...row.conflicts] as string[] }] as const
      }))
      read = { observedAt: raw.observedAt, state: raw.state as SectionState, jobsAvailable: raw.jobsAvailable, rows }
    } catch { host = 'unverified' }
    return { context: { account: account.username }, saved: !!stored, revision: mailxRevision('archive', stored), choices: await choices(account),
      policy: stored?.policy ?? { domains: [] }, updatedAt: stored?.updatedAt ?? null, host, observedAt: read?.observedAt ?? null, state: !stored ? 'not-saved' : read?.state ?? 'unavailable',
      rows: (stored?.policy.domains ?? []).map(row => ({ domain: row.domain, admission: read?.rows.get(row.domain)?.admission ?? null, conflicts: read?.rows.get(row.domain)?.conflicts ?? [] })),
      capabilities: { retentionJobs: read?.jobsAvailable ?? false }, application }
  }
  const archive = async (req: Request, url: URL, method: string, retention: boolean): Promise<Response> => {
    const initial = await ownerAuthorize(req)
    const allowed = retention ? ['POST'] : ['GET', 'PUT']
    if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
    if (url.search) return fail('VALIDATION', 'archive routes accept no account, mailbox or path selectors', unchanged)
    const fresh = async (account?: Account) => (await ownerAuthorize(req, initial.caller, account)).caller
    if (method === 'GET') {
      const stored = await loadArchive(helpers.store, initial.account.id), body = await archiveView(initial.caller, initial.account, stored)
      await fresh()
      return json({ ...body, compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) })
    }
    if (retention) {
      const body = await boundedBody(req, ['domain', 'expectedRevision'])
      if (typeof body.domain !== 'string' || body.domain.length > 253) return fail('VALIDATION', 'an archive domain is required', unchanged)
      const stored = await loadArchive(helpers.store, initial.account.id)
      if (mailxRevision('archive', stored) !== body.expectedRevision) return fail('CONFLICT', 'archive policy changed; reload before running retention', unchanged)
      if (!stored?.policy.domains.some(row => row.domain === body.domain)) return fail('NOT_FOUND', 'archive domain not found', unchanged)
      if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'no protected host agent is connected, so nothing was started', unchanged)
      const caller = await fresh(), revision = mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir))
      const reply = await helpers.callHost(caller, '/host/mailx/accounts/' + initial.account.username + '/retention', { revision, domain: body.domain })
      if (!object(reply) || !object(reply.job) || typeof reply.job.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(reply.job.id) || typeof reply.job.status !== 'string') return fail('SERVICE_UNAVAILABLE', 'retention job submission requires review', review)
      await audit(caller, 'mail.archive.retention_requested', 'domain:' + body.domain, { jobId: reply.job.id })
      return json({ job: { id: reply.job.id, status: reply.job.status } }, 202)
    }
    const body = await boundedBody(req, ['policy', 'expectedRevision'])
    const policy: MailxArchivePolicy = parse(() => parseMailxArchive(body.policy))
    let caller = initial.caller, wrote = false, stored: MailxArchiveStored | null = null
    const lease = await helpers.store.getWriterLock().acquire()
    try {
      const current = await ownerAuthorize(req, initial.caller)
      caller = current.caller
      const owned = await choices(current.account)
      for (const row of policy.domains) if (!owned.find(item => item.domain === row.domain)?.mailboxes.includes(row.mailbox)) return fail('VALIDATION', 'archive targets must be your own domains and an existing mailbox on that domain', { ...unchanged, field: 'domains' })
      const before = await loadArchive(helpers.store, current.account.id)
      if (mailxRevision('archive', before) !== body.expectedRevision) return fail('CONFLICT', 'archive policy changed; reload before saving', unchanged)
      const next: MailxArchiveStored = { accountId: current.account.id, policy, updatedAt: now().toISOString(), updatedBy: caller.principal.username }
      caller = await fresh(current.account); await lease.assertFencingToken(); wrote = true
      await atomicWriteJson(archivePath(helpers.store, current.account.id), next, 0o640, () => lease.assertFencingToken())
      if (JSON.stringify(await loadArchive(helpers.store, current.account.id)) !== JSON.stringify(next)) throw new Error('mailx_readback_mismatch')
      stored = next
    } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'archive policy save outcome requires inspection', review)
      throw error
    } finally { await lease.release() }
    const application = await apply(await fresh(), '/host/mailx/accounts/' + initial.account.username + '/apply')
    await audit(caller, 'mail.archive.saved', 'account:' + initial.account.username, { domains: policy.domains.length, outcome: application.outcome }, application.outcome === 'unknown')
    return json({ ...await archiveView(await fresh(), initial.account, stored, application), stateChanged: true })
  }

  /**
   * Owner mail tools: native state of each mailbox's spam preferences, filter training as a host job, the delivery
   * state of each mailing list, and the capabilities this server cannot provide (BoxTrapper, list moderation).
   */
  const MAIL_TOOLS = ['email-accounts', 'spam-filters']
  const MAILBOX_STATES = ['none', 'saved', 'review'], NATIVE_STATES = ['not-saved', 'applied', 'pending', 'unavailable']
  const toolsView = async (caller: AuthenticatedCaller, account: Account) => {
    const observed = await status(caller, '/host/mailx/accounts/' + account.username + '/mailboxes')
    let host: MailxHost = observed.host, read: { observedAt: string; engine: string | null; wiring: string; jobsAvailable: boolean; mailboxes: unknown[] } | null = null
    if (observed.status !== null) try {
      const raw = observed.status
      if (!object(raw) || !iso(raw.observedAt) || !object(raw.engine) || ![null, 'rspamd', 'spamassassin'].includes(raw.engine.engine as string) || !['wired', 'not-wired', 'unknown'].includes(String(raw.engine.wiring))
        || typeof raw.jobsAvailable !== 'boolean' || !Array.isArray(raw.mailboxes) || raw.mailboxes.length > 1000) throw new Error()
      const keys = ['allowlist', 'filtering', 'score', 'blocklist', 'spamBox']
      const mailboxes = raw.mailboxes.map(row => {
        if (!object(row) || typeof row.mailbox !== 'string' || row.mailbox.length > 254 || !MAILBOX_STATES.includes(String(row.preference)) || !NATIVE_STATES.includes(String(row.native))
          || !(row.effects === null || exact(row.effects, keys) && keys.every(key => typeof (row.effects as Record<string, unknown>)[key] === 'boolean')) || (row.preference === 'saved') !== (row.effects !== null)) throw new Error()
        return { mailbox: row.mailbox, preference: row.preference, native: row.native, effects: row.effects }
      })
      read = { observedAt: raw.observedAt, engine: raw.engine.engine as string | null, wiring: String(raw.engine.wiring), jobsAvailable: raw.jobsAvailable, mailboxes }
    } catch { host = 'unverified' }
    return { context: { account: account.username }, host, observedAt: read?.observedAt ?? null, engine: read ? { engine: read.engine, wiring: read.wiring } : null,
      mailboxes: read?.mailboxes ?? [], compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)),
      capabilities: { learning: !!read?.engine && read.jobsAvailable, boxTrapper: false } }
  }
  const LIST_TOOLS = ['email-accounts', 'mailing-lists']
  const LIST_STATES = ['delivering', 'pending', 'disabled', 'restricted', 'empty', 'review', 'conflict']
  /** Lists are observed by the agent: delivering only when the live alias table holds the rendered line. */
  const listsView = async (caller: AuthenticatedCaller, account: Account) => {
    const observed = await status(caller, '/host/mailx/accounts/' + account.username + '/lists')
    let host: MailxHost = observed.host, read: { observedAt: string; aliases: string; lists: { address: string; members: number; state: string }[] } | null = null
    if (observed.status !== null) try {
      const raw = observed.status
      if (!exact(raw, ['observedAt', 'aliases', 'lists']) || !iso(raw.observedAt) || !['read', 'unavailable'].includes(String(raw.aliases)) || !Array.isArray(raw.lists) || raw.lists.length > 1000) throw new Error()
      const lists = raw.lists.map(row => {
        if (!exact(row, ['address', 'members', 'state']) || typeof row.address !== 'string' || row.address.length > 254 || !Number.isSafeInteger(row.members) || (row.members as number) < 0 || (row.members as number) > 10000 || !LIST_STATES.includes(String(row.state))) throw new Error()
        return { address: row.address, members: row.members as number, state: row.state as string }
      })
      read = { observedAt: raw.observedAt, aliases: String(raw.aliases), lists }
    } catch { host = 'unverified' }
    return { context: { account: account.username }, host, observedAt: read?.observedAt ?? null, aliases: read?.aliases ?? null, lists: read?.lists ?? [],
      compositeRevision: mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)), capabilities: { moderation: false, archive: false } }
  }
  const lists = async (req: Request, url: URL, method: string): Promise<Response> => {
    const initial = await ownerAuthorize(req, undefined, undefined, LIST_TOOLS)
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
    if (url.search) return fail('VALIDATION', 'mailing list delivery accepts no account, list or path selectors', unchanged)
    const fresh = async () => (await ownerAuthorize(req, initial.caller, undefined, LIST_TOOLS)).caller
    if (method === 'GET') { const body = await listsView(initial.caller, initial.account); await fresh(); return json(body) }
    const body = await boundedBody(req, ['expectedRevision'])
    if (mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) !== body.expectedRevision) return fail('CONFLICT', 'saved mail policy changed; reload before applying', unchanged)
    const caller = await fresh(), application = await apply(caller, '/host/mailx/accounts/' + initial.account.username + '/apply')
    await audit(caller, 'mail.lists.applied', 'account:' + initial.account.username, { outcome: application.outcome, reconcile: application.reconcile ?? null }, application.outcome === 'unknown')
    return json({ application, ...await listsView(await fresh(), initial.account) })
  }
  const tools = async (req: Request, url: URL, method: string, op: 'view' | 'learn' | 'apply'): Promise<Response> => {
    const initial = await ownerAuthorize(req, undefined, undefined, MAIL_TOOLS)
    const allowed = op === 'view' ? 'GET' : 'POST'
    if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
    if (url.search) return fail('VALIDATION', 'mail tools accept no account, mailbox or path selectors', unchanged)
    const fresh = async () => (await ownerAuthorize(req, initial.caller, undefined, MAIL_TOOLS)).caller
    if (op === 'view') { const body = await toolsView(initial.caller, initial.account); await fresh(); return json(body) }
    if (op === 'apply') {
      const body = await boundedBody(req, ['expectedRevision'])
      if (mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) !== body.expectedRevision) return fail('CONFLICT', 'saved mail policy changed; reload before applying', unchanged)
      const caller = await fresh(), application = await apply(caller, '/host/mailx/accounts/' + initial.account.username + '/apply')
      await audit(caller, 'mail.tools.applied', 'account:' + initial.account.username, { outcome: application.outcome }, application.outcome === 'unknown')
      return json({ application })
    }
    const body = await boundedBody(req, ['mailbox', 'direction', 'expectedRevision'])
    if (typeof body.mailbox !== 'string' || !['spam', 'ham'].includes(String(body.direction))) return fail('VALIDATION', 'a mailbox and the spam or ham direction are required', unchanged)
    const owned = (await helpers.store.listServiceUsers(initial.account.id)).some(user => user.accountId === initial.account.id && user.services.email && user.login.toLowerCase() === body.mailbox)
    if (!owned) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    if (mailxCompositeRevision(await readMailxSaved(helpers.store.rootDir)) !== body.expectedRevision) return fail('CONFLICT', 'saved mail policy changed; reload before training', unchanged)
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'no protected host agent is connected, so nothing was started', unchanged)
    const caller = await fresh()
    const reply = await helpers.callHost(caller, '/host/mailx/accounts/' + initial.account.username + '/learn', { mailbox: body.mailbox, direction: body.direction })
    if (!object(reply) || !object(reply.job) || typeof reply.job.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(reply.job.id) || typeof reply.job.status !== 'string') return fail('SERVICE_UNAVAILABLE', 'training job submission requires review', review)
    await audit(caller, 'mail.spam.learn_requested', 'mailbox:' + body.mailbox, { jobId: reply.job.id, direction: body.direction })
    return json({ job: { id: reply.job.id, status: reply.job.status } }, 202)
  }

  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const match = /^\/api\/server\/mailx\/([a-z]+)$/.exec(url.pathname)
    if (match) return isMailxSection(match[1]) || match[1] === 'apply' ? server(req, url, method, match[1] as MailxSection | 'apply') : null
    if (url.pathname === '/api/account/mailx/archive' || url.pathname === '/api/account/mailx/archive/retention') return archive(req, url, method, url.pathname.endsWith('/retention'))
    if (url.pathname === '/api/account/mailx/mail-tools/lists') return lists(req, url, method)
    const toolsMatch = /^\/api\/account\/mailx\/mail-tools(?:\/(learn|apply))?$/.exec(url.pathname)
    if (toolsMatch) return tools(req, url, method, (toolsMatch[1] ?? 'view') as 'view' | 'learn' | 'apply')
    return null
  }
}
