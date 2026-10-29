import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore, WriterLease } from '@xpanel/state'
import type { DomainForwarder, EmailForwarder } from '../extended-routes.ts'
import { canonicalForwarderAddress } from './forwarder-validation.ts'
import type { MailRoutingRecordState, MailRoutingStatusView } from './routing-application.ts'
import { mailboxJson, methodNotAllowed, strictMailboxBody } from './folder-admin.ts'
import type { SealedMailboxAuditEvent, SealedMailboxSession } from './folder-admin.ts'

export const MAILBOX_FORWARD_LIMIT = 10
const LOOP_SEARCH_MAX = 10000
const KEYS = ['destinations', 'keepCopy', 'expectedRevision'] as const

export interface MailboxForwardersPorts {
  /** Fresh sealed-mailbox authority (server: authorizeNativeMailboxRequest with webmail-forwarders); never request input. */
  open: (request: Request) => Promise<SealedMailboxSession>
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getAccount' | 'getPlan'>
  audit: (request: Request, event: SealedMailboxAuditEvent) => Promise<void>
  /** The account forwarders route writes the same file; both advance the revision and apply it on the host. */
  routing: {
    status: () => Promise<MailRoutingStatusView>
    commit: (lease: WriterLease) => Promise<number>
    /** a failed configuration test restores `previous` and throws */
    apply: (request: Request, revision: number, previous: readonly EmailForwarder[] | null) => Promise<MailRoutingStatusView>
  }
  now?: () => Date
}
export type MailboxForwardersReview = 'managed_elsewhere' | 'duplicate_records'
export interface MailboxForwardersView {
  context: { mailbox: string }
  forwarding: { id: string; destinations: string[]; keepCopy: true; createdAt: string } | null
  revision: string
  limit: number
  review: MailboxForwardersReview | null
  /** host state of the mailbox's own forwarder; null when it has none */
  application: MailRoutingRecordState | null
}

const unchanged = { stateChanged: false }
const sameSession = (left: SealedMailboxSession, right: SealedMailboxSession): boolean => !!right?.record
  && (['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).every(key => left.record[key] === right.record[key]) && left.password === right.password
const sealed = (session: SealedMailboxSession): SealedMailboxSession & { mailbox: string } => {
  const mailbox = typeof session?.record?.mailbox === 'string' ? session.record.mailbox.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+$/.test(mailbox) ? { ...session, mailbox } : fail('PRECONDITION_FAILED', 'mailbox access is unavailable', unchanged)
}
const file = (store: MailboxForwardersPorts['store'], name: string): string => join(store.rootDir, 'extended', 'mail', name)
const review = (): never => fail('PRECONDITION_FAILED', 'saved forwarding configuration requires review by the account owner', { ...unchanged, reason: 'forwarders_unreadable' })
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512

async function readList<T>(store: MailboxForwardersPorts['store'], name: string, valid: (item: Record<string, unknown>) => boolean): Promise<T[]> {
  const value = await readJsonIfExists<unknown>(file(store, name))
  if (value === null) return []
  return Array.isArray(value) && value.every(item => !!item && typeof item === 'object' && !Array.isArray(item) && valid(item as Record<string, unknown>)) ? value as T[] : review()
}
const readForwarders = (store: MailboxForwardersPorts['store']) => readList<EmailForwarder>(store, 'forwarders.json', item => text(item.id) && text(item.sourceAddress)
  && Array.isArray(item.destinations) && item.destinations.every(text) && (item.accountId === null || text(item.accountId)))
const readDomainForwarders = (store: MailboxForwardersPorts['store']) => readList<DomainForwarder>(store, 'domain-forwarders.json', item => text(item.sourceDomain) && text(item.targetDomain))

/** Records whose source is the sealed mailbox; another account's record for the same address blocks editing. */
function scope(list: readonly EmailForwarder[], mailbox: string, accountId: string) {
  const matching = list.filter(item => item.sourceAddress.toLowerCase() === mailbox)
  const own = matching.filter(item => item.accountId === accountId)
  const blocked: MailboxForwardersReview | null = own.length !== matching.length ? 'managed_elsewhere' : own.length > 1 ? 'duplicate_records' : null
  return { matching, own: blocked ? null : own[0] ?? null, review: blocked }
}
/** Current-value identity over every record with this source, intentionally not a counter. */
export const mailboxForwardersRevision = (mailbox: string, accountId: string, matching: readonly EmailForwarder[]): string => createHash('sha256')
  .update(JSON.stringify({ namespace: 'xpanel-mailbox-forwarders:v1', accountId, mailbox,
    records: matching.map(item => ({ id: item.id, accountId: item.accountId, sourceAddress: item.sourceAddress, destinations: item.destinations, createdAt: item.createdAt })) }))
  .digest('hex')
const view = (mailbox: string, accountId: string, list: readonly EmailForwarder[], status: MailRoutingStatusView): MailboxForwardersView => {
  const scoped = scope(list, mailbox, accountId), own = scoped.own
  const application = own ? status.record('forwarder', own.id, { domain: mailbox.slice(mailbox.lastIndexOf('@') + 1) }) : null
  return { context: { mailbox }, forwarding: own ? { id: own.id, destinations: [...own.destinations], keepCopy: true, createdAt: own.createdAt } : null,
    revision: mailboxForwardersRevision(mailbox, accountId, scoped.matching), limit: MAILBOX_FORWARD_LIMIT, review: scoped.review, application }
}

/**
 * True when mail addressed to `start` can reach `mailbox` through saved address or domain forwarders on this server.
 * virtual(5): an exact user@domain entry wins over @domain; "@domain @otherdomain" keeps the user part.
 */
export function forwardsBackTo(start: string, mailbox: string, forwarders: readonly EmailForwarder[], domains: readonly DomainForwarder[]): boolean {
  const edges = new Map<string, string[]>()
  for (const item of forwarders) {
    const key = item.sourceAddress.toLowerCase()
    edges.set(key, [...edges.get(key) ?? [], ...item.destinations.map(target => target.toLowerCase())])
  }
  const domainEdges = new Map(domains.map(item => [item.sourceDomain.toLowerCase(), item.targetDomain.toLowerCase()]))
  const seen = new Set<string>(), queue = [start.toLowerCase()]
  for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
    if (address === mailbox) return true
    if (seen.has(address)) continue
    if (seen.size >= LOOP_SEARCH_MAX) return fail('PRECONDITION_FAILED', 'the forwarding chain is too large to check for loops', { ...unchanged, reason: 'loop_check_incomplete' })
    seen.add(address)
    const exact = edges.get(address), at = address.lastIndexOf('@'), target = at > 0 ? domainEdges.get(address.slice(at + 1)) : undefined
    if (exact) queue.push(...exact)
    else if (target) queue.push(address.slice(0, at + 1) + target)
  }
  return false
}

function parseRequest(body: Record<string, unknown>): { destinations: string[]; expectedRevision: string } {
  const values = body.destinations
  if (!Array.isArray(values)) return fail('VALIDATION', 'destinations must be a list of addresses', unchanged)
  if (values.length > MAILBOX_FORWARD_LIMIT) return fail('LIMIT_EXCEEDED', `a mailbox forwards to at most ${MAILBOX_FORWARD_LIMIT} addresses`, { ...unchanged, reason: 'forward_limit', limit: MAILBOX_FORWARD_LIMIT })
  const destinations = values.map(canonicalForwarderAddress)
  if (new Set(destinations).size !== destinations.length) return fail('VALIDATION', 'each destination address may appear once', unchanged)
  // packages/render mail domainMaps always keeps the mailbox copy when it forwards an existing mailbox.
  if (body.keepCopy !== true) return fail('VALIDATION', 'the mail server always keeps a copy in this mailbox; forwarding without a copy is not supported', { ...unchanged, reason: 'keep_copy_required' })
  const revision = body.expectedRevision
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) return fail('VALIDATION', 'expectedRevision must be an exact lowercase SHA-256 revision', unchanged)
  return { destinations, expectedRevision: revision }
}

/** /api/webmail/forwarders: the sealed mailbox's own forwarder record in the shared account forwarders file. */
export async function handleMailboxForwardersRoute(request: Request, url: URL, method: string, ports: MailboxForwardersPorts): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/forwarders') return null
  if (method !== 'GET' && method !== 'PUT') return methodNotAllowed(['GET', 'PUT'])
  if (method === 'GET') {
    if (url.search) return fail('VALIDATION', 'mailbox forwarders accept no query selectors', unchanged)
    const session = sealed(await ports.open(request))
    const result = view(session.mailbox, session.record.accountId, await readForwarders(ports.store), await ports.routing.status())
    if (!sameSession(session, await ports.open(request))) return fail('FORBIDDEN', 'mailbox session changed; sign in again', unchanged)
    return mailboxJson(result)
  }
  let input: ReturnType<typeof parseRequest>
  try { input = parseRequest(await strictMailboxBody(request, url, KEYS, KEYS)) } catch (error) {
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
    throw error
  }
  const session = sealed(await ports.open(request)), { mailbox } = session, { accountId } = session.record
  const fresh = async (): Promise<void> => { if (!sameSession(session, await ports.open(request))) fail('FORBIDDEN', 'mailbox session changed; sign in again', unchanged) }
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false, operation: 'created' | 'updated' | 'deleted', after: EmailForwarder[], previous: EmailForwarder[] | null, revision: number
  try {
    await fresh()
    const account = await ports.store.getAccount(accountId)
    if (!account || account.id !== accountId || account.status !== 'active') return fail('FORBIDDEN', 'mailbox account is unavailable', unchanged)
    previous = await readJsonIfExists<EmailForwarder[]>(file(ports.store, 'forwarders.json'))
    const list = await readForwarders(ports.store), domains = await readDomainForwarders(ports.store)
    const scoped = scope(list, mailbox, accountId)
    if (scoped.review) return fail('PRECONDITION_FAILED', 'forwarding for this address is managed by the account owner', { ...unchanged, reason: scoped.review })
    if (input.expectedRevision !== mailboxForwardersRevision(mailbox, accountId, scoped.matching)) return fail('CONFLICT', 'forwarders changed; reload before saving', unchanged)
    const loop = input.destinations.find(target => target === mailbox || forwardsBackTo(target, mailbox, list, domains))
    if (loop) return fail('VALIDATION', 'forwarding to this address would send mail back to this mailbox', { ...unchanged, reason: 'FORWARD_LOOP', destination: loop })
    const own = scoped.own
    if ((own?.destinations ?? []).join('\n') === input.destinations.join('\n')) return mailboxJson({ ...view(mailbox, accountId, list, await ports.routing.status()), stateChanged: false })
    if (!own) {
      const plan = await ports.store.getPlan(account.planId), cap = plan?.caps.forwarders
      if (cap === undefined) return fail('PRECONDITION_FAILED', 'the account plan is unavailable', unchanged)
      if (cap !== 'unlimited' && list.filter(item => item.accountId === accountId).length >= cap) return fail('CONFLICT', 'the account forwarder limit has been reached', { ...unchanged, reason: 'account_forwarder_limit' })
    }
    const record: EmailForwarder = own ? { ...own, destinations: input.destinations } : { id: randomUUID(), accountId, sourceAddress: mailbox, destinations: input.destinations, createdAt: (ports.now ?? (() => new Date()))().toISOString() }
    operation = !input.destinations.length ? 'deleted' : own ? 'updated' : 'created'
    const next = operation === 'deleted' ? list.filter(item => item !== own) : own ? list.map(item => item === own ? record : item) : [...list, record]
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    await atomicWriteJson(file(ports.store, 'forwarders.json'), next, 0o640, () => lease.assertFencingToken())
    after = await readForwarders(ports.store)
    const confirmed = scope(after, mailbox, accountId)
    if (confirmed.review || (operation === 'deleted' ? confirmed.own !== null : confirmed.own?.id !== record.id || confirmed.own.destinations.join('\n') !== record.destinations.join('\n'))) throw new Error('forwarder readback mismatch')
    revision = await ports.routing.commit(lease)
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the forwarder change could not be verified; review it before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
    throw error
  } finally { await lease.release() }
  const result = view(mailbox, accountId, after, await ports.routing.apply(request, revision, previous))
  try {
    await ports.audit(request, { action: 'webmail.forwarder.' + operation, mailbox, detail: { destinations: input.destinations, keepCopy: true, application: result.application?.state ?? 'applied', revision } })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the forwarder change was saved but could not be recorded; review it before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return mailboxJson({ ...result, stateChanged: true, operation })
}
