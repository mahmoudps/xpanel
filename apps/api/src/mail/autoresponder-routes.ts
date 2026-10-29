// /api/mail/autoresponders: the account's autoresponders. A mailbox answers with its own vacation
// (saved through /api/webmail/vacation); any other address of the account's domains answers through
// a hidden user (render mail-autoreply.ts), saved here in extended/mail/autoresponders.json.
import { createHash, randomUUID } from 'node:crypto'
import { assessMailboxMetadataAuthority, fail } from '@xpanel/core'
import type { Account, Id } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { StateStore, WriterLease } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import { assertAccountFeatures, isMailboxPrincipal } from '../authorization.ts'
import type { ExtendedRouteHelpers } from '../extended-routes.ts'
import { canonicalForwarderAddress } from './forwarder-validation.ts'
import { resolveMailboxMetadataAuthority } from './metadata-authority.ts'
import type { MailRoutingStatusView } from './routing-application.ts'
import { parseVacationFields, projectVacationWorkspace, vacationWorkspaceRevision, type VacationWorkspaceFields } from './vacation-workspace.ts'

export interface AddressAutoresponder extends VacationWorkspaceFields { id: Id; accountId: Id; address: string; createdAt: string; updatedAt: string }

export interface AutoresponderRoutePorts {
  store: StateStore
  ext: { readOrDefault<T>(relPath: string, fallback: T): Promise<T>; write<T>(relPath: string, value: T): Promise<T> }
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  requireResolvedAccount: (caller: AuthenticatedCaller, requested: Id | null | undefined, action: string) => Promise<Account>
  emitAudit: ExtendedRouteHelpers['emitAudit']
  readRoutingStatus: () => Promise<MailRoutingStatusView>
  commitRoutingRevision: (lease: WriterLease) => Promise<number>
  /** applies on the host; a failed configuration test restores `previous` and throws */
  applyRouting: (caller: AuthenticatedCaller, revision: number, restore: { relPath: string; previous: unknown }) => Promise<MailRoutingStatusView>
}

const FILE = 'mail/autoresponders.json'
const MAX_PER_ACCOUNT = 500
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
export const autoresponderRevision = (record: AddressAutoresponder): string => createHash('sha256').update(JSON.stringify(record)).digest('hex')

export function createAutoresponderRoutes(ports: AutoresponderRoutePorts) {
  const view = async (account: Account, status: MailRoutingStatusView) => {
    const mailboxes = (await ports.store.listServiceUsers(account.id)).filter(user => user.services.email).map(user => user.login.toLowerCase()).sort()
    const autoresponders: Record<string, unknown>[] = []
    for (const mailbox of mailboxes) {
      const stored = await ports.ext.readOrDefault<{ mailbox: string; enabled: boolean; ownerAuthority?: unknown } | null>(`webmail/vacation/${encodeURIComponent(mailbox)}.json`, null)
      const authority = await resolveMailboxMetadataAuthority(ports.store, mailbox)
      if (!stored || !stored.enabled || !authority || assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority as never, authority) !== 'match') continue
      const record = stored as unknown as Parameters<typeof projectVacationWorkspace>[0]
      autoresponders.push({ kind: 'mailbox', address: mailbox, ...projectVacationWorkspace(record), revision: vacationWorkspaceRevision(record),
        application: status.record('autoresponder', mailbox, { mailbox }) })
    }
    for (const record of await ports.ext.readOrDefault<AddressAutoresponder[]>(FILE, [])) {
      if (record.accountId !== account.id || !record.enabled) continue
      const { id: _id, accountId: _account, createdAt: _created, ...fields } = record
      autoresponders.push({ kind: 'address', mailbox: null, ...fields, revision: autoresponderRevision(record),
        application: status.record('autoresponder', record.address, { mailbox: services.autoreplyAddress(account.id, record.address) }) })
    }
    return { context: { accountId: account.id }, mailboxes, autoresponders }
  }

  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/mail/autoresponders' || !['GET', 'PUT', 'DELETE'].includes(method)) return null
    const caller = await ports.requireCaller(req)
    if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'mailbox principals manage their own vacation responder')
    const account = await ports.requireResolvedAccount(caller, url.searchParams.get('accountId'), method === 'GET' ? 'mailbox.access' : 'mail.autoresponder.manage')
    await assertAccountFeatures(ports.store, caller, account, ['email-accounts'])
    if (method === 'GET') return json(await view(account, await ports.readRoutingStatus()))
    await assertAccountFeatures(ports.store, caller, account, ['autoresponders'])
    let body: unknown
    try { body = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object')
    const { address: rawAddress, expectedRevision, ...rest } = body as Record<string, unknown>
    if (method === 'DELETE' && Object.keys(rest).length) return fail('VALIDATION', 'address and expectedRevision are the only removal fields')
    const address = canonicalForwarderAddress(rawAddress)
    const domain = address.slice(address.lastIndexOf('@') + 1)
    if (!(await ports.store.listDomains()).some(item => item.accountId === account.id && item.name === domain)) return fail('NOT_FOUND', 'domain not found')
    if (!(expectedRevision === null || expectedRevision === undefined || typeof expectedRevision === 'string' && /^[0-9a-f]{64}$/.test(expectedRevision))) return fail('VALIDATION', 'expectedRevision must be null or a SHA-256 revision')
    const fields = method === 'PUT' ? parseVacationFields(rest) : null
    if (method === 'PUT' && Object.keys(rest).some(key => !['enabled', 'subject', 'body', 'htmlBody', 'startDate', 'endDate', 'replyIntervalHours'].includes(key))) return fail('VALIDATION', 'unsupported autoresponder field')
    const lease = await ports.store.getWriterLock().acquire()
    let previous: AddressAutoresponder[] | null
    let revision: number
    try {
      const fresh = await ports.requireCaller(req)
      if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'autoresponder authorization changed', { stateChanged: false })
      previous = await ports.ext.readOrDefault<AddressAutoresponder[] | null>(FILE, null)
      const list = previous ?? []
      const current = list.find(record => record.address === address)
      if (current && current.accountId !== account.id) return fail('NOT_FOUND', 'autoresponder not found')
      if ((current ? autoresponderRevision(current) : null) !== (expectedRevision ?? null)) return fail('CONFLICT', 'autoresponder changed; reload before saving', { stateChanged: false })
      let next: AddressAutoresponder[]
      if (fields) {
        const user = await ports.store.getServiceUserByLogin(address)
        if (user?.services.email) return fail('CONFLICT', 'this address is a mailbox; set the mailbox autoresponder instead', { stateChanged: false })
        const forwarders = await ports.ext.readOrDefault<{ sourceAddress?: string; action?: string }[]>('mail/forwarders.json', [])
        if (forwarders.some(item => item.sourceAddress?.toLowerCase() === address && item.action === 'reject')) return fail('CONFLICT', 'this address rejects mail', { stateChanged: false })
        const lists = await ports.ext.readOrDefault<{ address?: string }[]>('mail/mailing-lists.json', [])
        if (lists.some(item => item.address?.toLowerCase() === address)) return fail('CONFLICT', 'this address is a mailing list', { stateChanged: false })
        if (!current && list.filter(record => record.accountId === account.id).length >= MAX_PER_ACCOUNT) return fail('LIMIT_EXCEEDED', `an account has at most ${MAX_PER_ACCOUNT} address autoresponders`)
        const now = new Date().toISOString()
        next = [...list.filter(record => record !== current), { id: current?.id ?? randomUUID(), accountId: account.id, address, ...fields, createdAt: current?.createdAt ?? now, updatedAt: now }]
      } else {
        if (!current) return fail('NOT_FOUND', 'autoresponder not found')
        next = list.filter(record => record !== current)
      }
      await lease.assertFencingToken()
      await ports.ext.write(FILE, next)
      revision = await ports.commitRoutingRevision(lease)
    } finally { await lease.release() }
    const status = await ports.applyRouting(caller, revision, { relPath: FILE, previous })
    await ports.emitAudit({ actor: caller.principal.username, action: fields ? 'mail.autoresponder.updated' : 'mail.autoresponder.deleted', target: 'autoresponder:' + address,
      detail: { enabled: fields?.enabled ?? false, revision }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
    return json({ ...(await view(account, status)), revision })
  }
}
