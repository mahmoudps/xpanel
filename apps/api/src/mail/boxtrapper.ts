import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { assessMailboxMetadataAuthority, fail, isXpanelError, normalizeMailboxMetadataAddress } from '@xpanel/core'
import type { Account, MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore, WriterLease } from '@xpanel/state'
import { BOXTRAPPER_DEFAULTS, BOXTRAPPER_DEFAULT_TEMPLATES, parseBoxTrapperConfig } from '../../../agent/src/boxtrapper-policy.ts'
import type { BoxTrapperConfig } from '../../../agent/src/boxtrapper-policy.ts'
import { BOXTRAPPER_ACTIONS, BOXTRAPPER_ID, BOXTRAPPER_MAX_IDS } from '../../../../packages/os/src/boxtrapper-command.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { assertAccountFeatures, isMailboxPrincipal } from '../authorization.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority } from './metadata-authority.ts'
import { freshMailboxTool, mailboxToolBody, mailboxToolObject, mailboxToolRevision, openMailboxTool, MAILBOX_TOOL_UNCHANGED } from './mailbox-spam-authority.ts'
import type { MailboxToolsPorts } from './mailbox-spam-authority.ts'
import type { MailboxSpamRouting } from './mailbox-spam.ts'

/**
 * BoxTrapper of one mailbox, from the mailbox's own session or its account owner. Settings are saved here and rendered by
 * the host reconcile. Lists, queue and log belong to the account: every read and change goes to the host, which runs the
 * delivery program as the account, and every answer is re-validated because the account can edit those files.
 */
const FEATURES = ['email-accounts', 'sender-verification']
const LIST_NAMES = ['allow', 'ignore', 'deny'] as const
const MAX_LISTS_BYTES = 60 * 1024
const uncertain = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const review = (): never => fail('PRECONDITION_FAILED', 'saved BoxTrapper settings require review', { ...MAILBOX_TOOL_UNCHANGED, reason: 'saved_settings_review' })
const hostReview = (): never => fail('SERVICE_UNAVAILABLE', 'the BoxTrapper answer from the host requires review', MAILBOX_TOOL_UNCHANGED)
const object = mailboxToolObject
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const hostDay = (value: unknown): string => value === 'latest' ? 'latest' : isDay(value) ? value.replaceAll('-', '') : fail('VALIDATION', 'a day is YYYY-MM-DD or latest', MAILBOX_TOOL_UNCHANGED)
const days = (value: unknown): string[] => Array.isArray(value) && value.length <= 60 && value.every(isDay) ? value as string[] : hostReview()

export interface BoxTrapperLists { allow: string[]; ignore: string[]; deny: string[] }
const readHostLists = (value: unknown): BoxTrapperLists => {
  if (!object(value) || !LIST_NAMES.every(name => Array.isArray(value[name]) && (value[name] as unknown[]).length <= 1000 && (value[name] as unknown[]).every(line => short(line, 400)))) return hostReview()
  return { allow: value.allow as string[], ignore: value.ignore as string[], deny: value.deny as string[] }
}
const LIST_RULE = /^(?:(?:from|to|subject)\s+\S.{0,299}|[^\s]{1,300})$/i
function parseLists(value: unknown): BoxTrapperLists {
  if (!object(value) || Object.keys(value).sort().join() !== 'allow,deny,ignore') return fail('VALIDATION', 'allow, ignore and deny lists are required', MAILBOX_TOOL_UNCHANGED)
  const lists = Object.fromEntries(LIST_NAMES.map(name => {
    const rows = value[name]
    if (!Array.isArray(rows) || rows.length > 1000) return fail('VALIDATION', 'a list holds at most 1000 rules', { ...MAILBOX_TOOL_UNCHANGED, field: name })
    const lines = rows.map(line => typeof line === 'string' ? line.trim() : '')
    if (lines.some(line => !LIST_RULE.test(line))) return fail('VALIDATION', 'a rule is from, to or subject and a pattern, or a sender pattern', { ...MAILBOX_TOOL_UNCHANGED, field: name, reason: 'boxtrapper_rule_invalid' })
    return [name, [...new Set(lines)]]
  })) as unknown as BoxTrapperLists
  return Buffer.byteLength(JSON.stringify(lists)) > MAX_LISTS_BYTES ? fail('LIMIT_EXCEEDED', 'the lists exceed 60 KiB', MAILBOX_TOOL_UNCHANGED) : lists
}
const readQueue = (value: unknown) => {
  if (!object(value) || !Array.isArray(value.days) || value.days.length > 60 || !(value.day === null || isDay(value.day)) || !Array.isArray(value.rows) || value.rows.length > 500) return hostReview()
  return { day: value.day, days: value.days.map(item => object(item) && isDay(item.day) && count(item.count) ? { day: item.day, count: item.count } : hostReview()),
    rows: value.rows.map(row => object(row) && typeof row.id === 'string' && BOXTRAPPER_ID.test(row.id) && short(row.at, 30) && short(row.from, 254) && short(row.subject, 300) && count(row.size) ? { id: row.id, at: row.at, from: row.from, subject: row.subject, size: row.size } : hostReview()) }
}
const readQueued = (value: unknown) => {
  if (!object(value) || typeof value.found !== 'boolean') return hostReview()
  if (!value.found) return fail('NOT_FOUND', 'the held message is gone', MAILBOX_TOOL_UNCHANGED)
  return short(value.id, 64) && short(value.at, 30) && short(value.from, 254) && short(value.subject, 300) && short(value.headers, 300_000) && short(value.body, 300_000) && typeof value.truncated === 'boolean'
    ? { id: value.id, at: value.at, from: value.from, subject: value.subject, headers: value.headers, body: value.body, truncated: value.truncated } : hostReview()
}
const readLog = (value: unknown) => object(value) && (value.day === null || isDay(value.day)) && Array.isArray(value.lines) && value.lines.length <= 1000 && value.lines.every(line => short(line, 1200))
  ? { day: value.day, days: days(value.days), lines: value.lines as string[] } : hostReview()

export interface BoxTrapperView {
  context: { mailbox: string }
  revision: string
  saved: boolean
  config: BoxTrapperConfig
  updatedAt: string | null
  defaults: typeof BOXTRAPPER_DEFAULT_TEMPLATES
  review: 'mailbox_metadata_binding_unverified' | null
  /** ready: Pigeonhole's external programs module exists. active: the mailbox's delivery script is on the host. */
  host: { state: 'connected' | 'not-connected' | 'unverified'; ready: boolean | null; active: boolean | null }
  lists: BoxTrapperLists | null
  listsRevision: string | null
}
interface Scope {
  root: string
  authority: MailboxMetadataAuthority
  writer: StateStore['getWriterLock'] extends () => infer L ? L : never
  fresh: () => Promise<void>
  /** Null without a connected host agent. */
  host: ((call: Record<string, unknown>, mutation: boolean) => Promise<unknown>) | null
  routing: { commit: MailboxSpamRouting['commit']; apply: (revision: number, restore: { path: string; previous: unknown }) => Promise<{ nativeApplied: boolean }> }
  audit: (event: 'updated' | 'lists_saved' | 'queue_action', detail: Record<string, unknown>) => Promise<void>
  now: () => Date
}
const recordPath = (root: string, mailbox: string): string => join(root, 'extended', 'webmail', 'boxtrapper', encodeURIComponent(mailbox) + '.json')
const revisionOf = (authority: MailboxMetadataAuthority, config: BoxTrapperConfig, updatedAt: string | null): string => createHash('sha256').update(JSON.stringify({ namespace: 'mailbox-boxtrapper:v1', authority, config, updatedAt })).digest('hex')

async function readStored(root: string, authority: MailboxMetadataAuthority): Promise<{ stored: Record<string, unknown> | null; matched: boolean; config: BoxTrapperConfig; updatedAt: string | null }> {
  const stored = await readJsonIfExists<unknown>(recordPath(root, authority.mailbox))
  if (stored === null) return { stored: null, matched: false, config: BOXTRAPPER_DEFAULTS, updatedAt: null }
  if (!object(stored)) return review()
  if (assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority, authority) !== 'match') return { stored, matched: false, config: BOXTRAPPER_DEFAULTS, updatedAt: null }
  try { return { stored, matched: true, config: parseBoxTrapperConfig(stored), updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null } } catch { return review() }
}
async function readView(scope: Scope): Promise<BoxTrapperView> {
  const { stored, matched, config, updatedAt } = await readStored(scope.root, scope.authority)
  const host: BoxTrapperView['host'] = { state: scope.host ? 'connected' : 'not-connected', ready: null, active: null }
  let lists: BoxTrapperLists | null = null, listsRevision: string | null = null
  if (scope.host) try {
    const status = await scope.host({ op: 'status' }, false)
    if (!object(status) || typeof status.ready !== 'boolean' || typeof status.script !== 'boolean') return hostReview()
    host.ready = status.ready; host.active = status.script
    if (status.ready) {
      const read = await scope.host({ op: 'lists' }, false)
      if (!object(read) || !short(read.revision, 64)) return hostReview()
      lists = readHostLists(read.lists); listsRevision = read.revision
    }
  } catch { host.state = 'unverified'; host.ready = null; host.active = null; lists = null; listsRevision = null }
  return { context: { mailbox: scope.authority.mailbox }, revision: revisionOf(scope.authority, config, updatedAt), saved: matched, config, updatedAt, defaults: BOXTRAPPER_DEFAULT_TEMPLATES,
    review: stored !== null && !matched ? 'mailbox_metadata_binding_unverified' : null, host, lists, listsRevision }
}
function assertOwnAddresses(config: BoxTrapperConfig, mailbox: string): void {
  if (config.extraAddresses.includes(mailbox)) return fail('VALIDATION', 'extra addresses exclude the mailbox itself', { ...MAILBOX_TOOL_UNCHANGED, field: 'extraAddresses' })
  // A copy back to this mailbox would loop through the filter.
  if ([mailbox, ...config.extraAddresses].some(address => config.forward.includes(address))) return fail('VALIDATION', 'the forward list excludes the addresses of this mailbox', { ...MAILBOX_TOOL_UNCHANGED, field: 'forward', reason: 'boxtrapper_forward_loop' })
}
async function save(scope: Scope, body: Record<string, unknown>): Promise<Response> {
  const config = parseBoxTrapperConfig(body.config), authority = scope.authority, path = recordPath(scope.root, authority.mailbox)
  assertOwnAddresses(config, authority.mailbox)
  if (!mailboxToolRevision(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be the captured revision', MAILBOX_TOOL_UNCHANGED)
  const lease: WriterLease = await scope.writer.acquire()
  let attempted = false, revision = 0, previous: unknown = null
  try {
    await scope.fresh()
    const before = await readStored(scope.root, authority)
    if (before.stored) assertMailboxMetadataAuthority(before.stored.mailbox, before.stored.ownerAuthority, authority)
    if (revisionOf(authority, before.config, before.updatedAt) !== body.expectedRevision) return fail('CONFLICT', 'BoxTrapper settings changed; reload before saving', MAILBOX_TOOL_UNCHANGED)
    if (before.stored && JSON.stringify(before.config) === JSON.stringify(config)) return mailboxJson({ ...await readView(scope), stateChanged: false })
    const updatedAt = scope.now().toISOString(), record = { ...config, mailbox: authority.mailbox, ownerAuthority: authority, updatedAt }
    await scope.fresh(); await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(path, record, 0o640, () => lease.assertFencingToken())
    if (JSON.stringify((await readStored(scope.root, authority)).config) !== JSON.stringify(config)) throw new Error('boxtrapper_readback_mismatch')
    previous = before.stored; revision = await scope.routing.commit(lease)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the BoxTrapper settings outcome requires inspection', uncertain)
    if (isXpanelError(error)) throw error
    return review()
  } finally { await lease.release() }
  const { nativeApplied } = await scope.routing.apply(revision, { path, previous })
  try { await scope.audit('updated', { enabled: config.enabled, forward: config.forward.length, revision, nativeApplied }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'saved BoxTrapper settings require audit review', uncertain) }
  return mailboxJson({ ...await readView(scope), stateChanged: true, nativeApplied })
}
/** Queue, message, log, list and queue action calls; `args` is the one operation's fields. */
async function queue(scope: Scope, body: Record<string, unknown>): Promise<Response> {
  const op = body.op, args = object(body.args) ? body.args : fail('VALIDATION', 'operation arguments are required', MAILBOX_TOOL_UNCHANGED)
  if (!scope.host) return fail('PRECONDITION_FAILED', 'the queue is read on the host, and no host agent is connected', { ...MAILBOX_TOOL_UNCHANGED, reason: 'host_agent_unavailable' })
  await scope.fresh()
  if (op === 'queue') return mailboxJson(readQueue(await scope.host({ op: 'queue', day: hostDay(args.day) }, false)))
  if (op === 'log') return mailboxJson(readLog(await scope.host({ op: 'log', day: hostDay(args.day) }, false)))
  if (op === 'message') {
    if (typeof args.id !== 'string' || !BOXTRAPPER_ID.test(args.id)) return fail('VALIDATION', 'a held message id is required', MAILBOX_TOOL_UNCHANGED)
    return mailboxJson(readQueued(await scope.host({ op: 'message', id: args.id }, false)))
  }
  if (op === 'lists') {
    const lists = parseLists(args.lists)
    if (!mailboxToolRevision(args.revision)) return fail('VALIDATION', 'the read lists revision is required', MAILBOX_TOOL_UNCHANGED)
    const reply = await scope.host({ op: 'lists-set', revision: args.revision, encoded: Buffer.from(JSON.stringify(lists)).toString('base64') }, true)
    if (!object(reply) || typeof reply.saved !== 'boolean') return hostReview()
    if (!reply.saved) return reply.reason === 'lists_changed' ? fail('CONFLICT', 'the lists changed while delivering mail; reload before saving', MAILBOX_TOOL_UNCHANGED) : fail('VALIDATION', 'the host refused these lists', MAILBOX_TOOL_UNCHANGED)
    try { await scope.audit('lists_saved', { allow: lists.allow.length, ignore: lists.ignore.length, deny: lists.deny.length }) } catch { return fail('SERVICE_UNAVAILABLE', 'saved lists require audit review', uncertain) }
    return mailboxJson({ lists: readHostLists(reply.lists), listsRevision: short(reply.revision, 64) ? reply.revision : hostReview(), stateChanged: true })
  }
  if (op === 'act') {
    const ids = args.ids
    if (!(BOXTRAPPER_ACTIONS as readonly unknown[]).includes(args.action) || !Array.isArray(ids) || !ids.length || ids.length > BOXTRAPPER_MAX_IDS || ids.some(id => typeof id !== 'string' || !BOXTRAPPER_ID.test(id)) || new Set(ids).size !== ids.length) return fail('VALIDATION', `an action applies to 1 to ${BOXTRAPPER_MAX_IDS} held messages`, MAILBOX_TOOL_UNCHANGED)
    const reply = await scope.host({ op: 'act', action: args.action, ids }, true)
    if (!object(reply) || !count(reply.done) || !count(reply.failed)) return hostReview()
    try { await scope.audit('queue_action', { action: args.action, requested: ids.length, done: reply.done, failed: reply.failed }) } catch { return fail('SERVICE_UNAVAILABLE', 'the queue action requires audit review', uncertain) }
    return mailboxJson({ done: reply.done, failed: reply.failed, stateChanged: reply.done > 0 })
  }
  return fail('VALIDATION', 'unknown queue operation', MAILBOX_TOOL_UNCHANGED)
}

export interface MailboxBoxTrapperPorts extends MailboxToolsPorts {
  store: Omit<MailboxToolsPorts['store'], 'getAccount'> & { getAccount(id: string): Promise<Account | null> }
  routing: MailboxSpamRouting
  callHost: ((request: Request, username: string, body: unknown, mutation: boolean) => Promise<unknown>) | null
}
/** Xmail: GET and PUT /api/webmail/boxtrapper, POST /api/webmail/boxtrapper/queue. The mailbox comes only from the sealed session. */
export async function handleMailboxBoxTrapperRoute(request: Request, url: URL, method: string, ports: MailboxBoxTrapperPorts): Promise<Response | null> {
  const queued = url.pathname === '/api/webmail/boxtrapper/queue'
  if (!queued && url.pathname !== '/api/webmail/boxtrapper') return null
  const allowed = queued ? ['POST'] : ['GET', 'PUT']
  if (!allowed.includes(method)) return methodNotAllowed(allowed)
  if (url.search) return fail('VALIDATION', 'BoxTrapper accepts no selectors', MAILBOX_TOOL_UNCHANGED)
  const body = method === 'GET' ? null : await mailboxToolBody(request, url, queued ? ['op', 'args'] : ['config', 'expectedRevision'])
  const selected = await openMailboxTool(request, ports), account = await ports.store.getAccount(selected.authority.accountId)
  if (!account) return fail('FORBIDDEN', 'mailbox account is unavailable', MAILBOX_TOOL_UNCHANGED)
  const callHost = ports.callHost, mailbox = selected.authority.mailbox
  const scope: Scope = { root: ports.store.rootDir, authority: selected.authority, writer: ports.store.getWriterLock(), fresh: () => freshMailboxTool(request, ports, selected),
    host: callHost ? (call, mutation) => callHost(request, account.username, { mailbox, call }, mutation) : null,
    routing: { commit: ports.routing.commit, apply: (revision, restore) => ports.routing.apply(request, revision, restore) },
    audit: (event, detail) => ports.audit(request, { action: 'webmail.boxtrapper.' + event, mailbox, detail }), now: ports.now ?? (() => new Date()) }
  return body === null ? mailboxJson(await readView(scope)) : queued ? queue(scope, body) : save(scope, body)
}

export interface OwnerBoxTrapperPorts {
  store: StateStore
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  emitAudit: (input: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; principalId: string; detail?: Record<string, unknown> }) => Promise<unknown>
  routing: MailboxSpamRouting
  callHost: ((caller: AuthenticatedCaller, username: string, body: unknown, mutation: boolean) => Promise<unknown>) | null
  now?: () => Date
}
const OWNER_ROUTE = /^\/api\/mail\/boxtrapper(?:\/([^/]+)(\/queue)?)?$/
/** xPanel: the account owner lists its mailboxes and manages each one. */
export async function handleOwnerBoxTrapperRoute(req: Request, url: URL, method: string, ports: OwnerBoxTrapperPorts): Promise<Response | null> {
  const match = OWNER_ROUTE.exec(url.pathname)
  if (!match) return null
  const queued = !!match[2], listing = !match[1], allowed = listing ? ['GET'] : queued ? ['POST'] : ['GET', 'PUT']
  if (!allowed.includes(method)) return methodNotAllowed(allowed)
  if (url.search) return fail('VALIDATION', 'BoxTrapper accepts no selectors', MAILBOX_TOOL_UNCHANGED)
  const owner = async (): Promise<{ caller: AuthenticatedCaller; account: Account }> => {
    const caller = await ports.requireCaller(req)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'the hosting account owner is required', MAILBOX_TOOL_UNCHANGED)
    const account = await ports.store.getAccount(caller.principal.accountId)
    if (!account || account.username !== caller.principal.username || account.status !== 'active') return fail('FORBIDDEN', 'the active hosting account owner is required', MAILBOX_TOOL_UNCHANGED)
    await ports.assertCanAccessAccount(caller, account, 'mail.boxtrapper')
    await assertAccountFeatures(ports.store, caller, account, FEATURES)
    return { caller, account }
  }
  const { caller, account } = await owner(), root = ports.store.rootDir
  if (listing) {
    const users = (await ports.store.listServiceUsers(account.id)).filter(user => user.accountId === account.id && user.services.email).map(user => user.login.toLowerCase()).sort().slice(0, 1000)
    const mailboxes = await Promise.all(users.map(async mailbox => {
      const stored = await readJsonIfExists<unknown>(recordPath(root, mailbox)).catch(() => null)
      return { mailbox, enabled: object(stored) && stored.enabled === true }
    }))
    return mailboxJson({ mailboxes })
  }
  let decoded: string
  try { decoded = decodeURIComponent(match[1]!) } catch { return fail('VALIDATION', 'a mailbox address is required', MAILBOX_TOOL_UNCHANGED) }
  const mailbox = normalizeMailboxMetadataAddress(decoded)
  if (!mailbox) return fail('VALIDATION', 'a mailbox address is required', MAILBOX_TOOL_UNCHANGED)
  const body = method === 'GET' ? null : await mailboxToolBody(req, url, queued ? ['op', 'args'] : ['config', 'expectedRevision'])
  const authority = await captureMailboxMetadataAuthority(ports.store, mailbox).catch(error => isXpanelError(error) ? fail('NOT_FOUND', 'mailbox not found', MAILBOX_TOOL_UNCHANGED) : Promise.reject(error))
  if (authority.accountId !== account.id) return fail('NOT_FOUND', 'mailbox not found', MAILBOX_TOOL_UNCHANGED)
  const callHost = ports.callHost
  const scope: Scope = { root, authority, writer: ports.store.getWriterLock(), now: ports.now ?? (() => new Date()),
    fresh: async () => { const current = await owner(); if (current.caller.principal.id !== caller.principal.id || JSON.stringify(await captureMailboxMetadataAuthority(ports.store, mailbox)) !== JSON.stringify(authority)) return fail('FORBIDDEN', 'mailbox authorization changed', MAILBOX_TOOL_UNCHANGED) },
    host: callHost ? (call, mutation) => callHost(caller, account.username, { mailbox, call }, mutation) : null,
    routing: { commit: ports.routing.commit, apply: (revision, restore) => ports.routing.apply(req, revision, restore) },
    audit: async (event, detail) => { await ports.emitAudit({ actor: caller.principal.username, action: 'mail.boxtrapper.' + event, target: 'mailbox:' + mailbox, outcome: 'ok', principalId: caller.principal.id, detail }) } }
  return body === null ? mailboxJson(await readView(scope)) : queued ? queue(scope, body) : save(scope, body)
}
