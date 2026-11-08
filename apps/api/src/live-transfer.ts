import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, DnsRecordType } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { LIVE_TRANSFER_STATE_DIR, movedStatePath } from '../../agent/src/account-edge.ts'
import type { TransferAccountBundle } from './acct-transfer-source.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { NODE_PEER_PREFIX } from './node-link.ts'
import type { NodeLink } from './node-link.ts'
import { exactKeys, panelJson, readPanelConfigBody } from './panel-config-file.ts'

/**
 * The source side of a live transfer. The destination orchestrates; these three steps run here for the node that pulls
 * the account: freeze suspends the account so the final sync sees a still home, cutover repoints its zones and proxies
 * its sites and mail to the destination, and revert undoes either. The record written before each step is what revert
 * reads, so a destination that disappears can still be undone from here.
 */
export const livePeerPath = (username: string, step: 'freeze' | 'cutover' | 'revert'): string => NODE_PEER_PREFIX + '/live/' + username + '/' + step
const ROUTE = /^\/api\/server\/nodes\/peer\/live\/([a-z][a-z0-9]{0,15})\/(freeze|cutover|revert)$/
/** Short enough that resolvers follow the move soon, and follow a revert as soon. */
export const LIVE_CUTOVER_TTL = 300
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const unchanged = { stateChanged: false }
const refuse = (reason: string, message: string): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason })

type ZoneRecord = { id: string; zone: string; name: string; type: DnsRecordType; ttl: number; priority: number | null; content: string }
type SavedZone = { id: string; accountId: string; name: string; serial: number; records: ZoneRecord[] }
export interface LiveSourceRecord {
  version: 1
  accountId: string
  username: string
  session: string
  node: string
  stage: 'frozen' | 'cutover'
  frozenAt: string
  cutoverAt: string | null
  /** the zones as they were, written before the first one changes */
  zones: SavedZone[]
}
export interface LiveSourcePorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getAccountByUsername' | 'listDomains' | 'getDnsZone' | 'saveDnsZone'>
  link: NodeLink
  /** The account suspension of the panel: desired state, sessions, hooks and host apply. */
  setSuspension: (caller: AuthenticatedCaller, account: Account, verb: 'suspend' | 'unsuspend', reason?: string) => Promise<unknown>
  applyAccount: (caller: AuthenticatedCaller, account: Account) => Promise<unknown>
  /** Delivers what Postfix holds for these domains, and says whether anything stayed. */
  drainMail: (caller: AuthenticatedCaller, domains: string[]) => Promise<{ drained: boolean; remaining: number | null }>
}

const recordPath = (root: string, accountId: string): string => join(root, LIVE_TRANSFER_STATE_DIR, accountId + '.json')
const readRecord = async (root: string, accountId: string): Promise<LiveSourceRecord | null> => {
  const raw = await readJsonIfExists<LiveSourceRecord>(recordPath(root, accountId))
  if (raw === null) return null
  return raw.version === 1 && raw.accountId === accountId && Array.isArray(raw.zones) ? raw : fail('PRECONDITION_FAILED', 'the saved live transfer requires inspection', unchanged)
}
const nextSerial = (previous: number): number => Math.max(Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')) * 100 + 1, previous + 1)
/** Records at the source address move to the destination; everything else, MX targets included, follows those names. */
export const movedZoneRecords = (records: readonly ZoneRecord[], from: string, to: string): ZoneRecord[] =>
  records.map(record => record.type === 'A' && record.content === from ? { ...record, content: to, ttl: LIVE_CUTOVER_TTL } : record)

/** The desired state the first copy was built from; a change during the copy means the destination copy is not the account. */
export const liveStateDigest = (bundle: TransferAccountBundle): string =>
  createHash('sha256').update(JSON.stringify({ domains: bundle.domains, databases: bundle.databases.map(db => db.name), databaseUsers: bundle.databaseUsers, mailboxes: bundle.mailboxes, zones: bundle.zones, cron: bundle.cron, edge: bundle.edge ?? null })).digest('hex')

export async function handleLiveSourceRoute(request: Request, url: URL, method: string, ports: LiveSourcePorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const caller = await ports.requireCaller(request)
  await ports.assertRoot(caller, 'server.live.peer')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'live transfer routes accept no selectors', unchanged)
  const username = match[1]!, step = match[2] as 'freeze' | 'cutover' | 'revert', { store, link } = ports
  const peer = await link.peerOf(caller), body = await readPanelConfigBody(request, 4096)
  if (!exactKeys(body, step === 'cutover' ? ['session', 'ipv4'] : ['session']) || typeof body.session !== 'string' || !UUID.test(body.session)) return fail('VALIDATION', 'a session is required', unchanged)
  if (step === 'cutover' && (typeof body.ipv4 !== 'string' || !isIPv4(body.ipv4))) return fail('VALIDATION', 'the destination address is required', unchanged)
  const session = body.session
  const account = await store.getAccountByUsername(username) ?? fail('NOT_FOUND', 'account not found', { ...unchanged, reason: 'account_not_found' })
  const write = async (record: LiveSourceRecord): Promise<void> => {
    const lease = await store.getWriterLock().acquire()
    try { await atomicWriteJson(recordPath(store.rootDir, account.id), record, 0o600, () => lease.assertFencingToken()); await lease.commitAuthority() } finally { await lease.release() }
  }
  const writeMoved = async (ipv4: string | null): Promise<void> => {
    const lease = await store.getWriterLock().acquire()
    try { await atomicWriteJson(join(store.rootDir, movedStatePath(account.id)), { version: 1, ipv4, hostname: peer.hostname, movedAt: link.now().toISOString() }, 0o640, () => lease.assertFencingToken()); await lease.commitAuthority() } finally { await lease.release() }
  }
  const audit = (action: string, detail: Record<string, unknown>) => ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target: 'account:' + username, detail: { session, node: peer.hostname, ...detail }, outcome: 'ok' })
  const record = await readRecord(store.rootDir, account.id)
  if (record && (record.session !== session || record.node !== peer.id)) return fail('CONFLICT', 'another live transfer holds this account', { ...unchanged, reason: 'live_transfer_running' })

  if (step === 'freeze') {
    if (!record && account.status !== 'active') return fail('CONFLICT', 'only an active account can be moved live', { ...unchanged, reason: 'account_not_active' })
    if (!record) await write({ version: 1, accountId: account.id, username, session, node: peer.id, stage: 'frozen', frozenAt: link.now().toISOString(), cutoverAt: null, zones: [] })
    // before the suspension, so the apply it runs already holds mail back
    await writeMoved(null)
    // a suspension that failed left the record behind; asking again finishes it
    if (account.status === 'active') await ports.setSuspension(caller, account, 'suspend', 'Live transfer to ' + peer.hostname)
    // Mail already queued here would land after the final sync read the mailboxes, and be lost.
    const queue = await ports.drainMail(caller, (await store.listDomains()).filter(domain => domain.accountId === account.id).map(domain => domain.name))
    if (!queue.drained) return fail('PRECONDITION_FAILED', 'mail for this account is still queued here', { stateChanged: true, reason: 'live_mail_queued', remaining: queue.remaining })
    await audit('transfer.live.frozen', {})
    return panelJson({ frozen: true, repeated: record !== null })
  }
  if (step === 'cutover') {
    if (!record) return refuse('live_transfer_not_frozen', 'the account is not frozen for this transfer')
    if (record.stage === 'cutover') return panelJson({ cutover: true, repeated: true, zones: record.zones.length })
    const ipv4 = body.ipv4 as string, domains = (await store.listDomains()).filter(domain => domain.accountId === account.id)
    const zones = (await Promise.all(domains.map(domain => store.getDnsZone(domain.name)))).filter(zone => zone !== null && zone.accountId === account.id) as unknown as SavedZone[]
    const at = link.now().toISOString(), saved: LiveSourceRecord = { ...record, stage: 'cutover', cutoverAt: at, zones }
    await write(saved)
    for (const zone of zones) await store.saveDnsZone({ ...zone, serial: nextSerial(zone.serial), records: movedZoneRecords(zone.records, account.ipv4, ipv4) } as never)
    await writeMoved(ipv4)
    await ports.applyAccount(caller, await store.getAccountByUsername(username) ?? account)
    await audit('transfer.live.cutover', { zones: zones.length, ipv4 })
    return panelJson({ cutover: true, repeated: false, zones: zones.length })
  }
  if (!record) return panelJson({ reverted: false })
  for (const zone of record.zones) {
    const current = await store.getDnsZone(zone.name)
    await store.saveDnsZone({ ...zone, serial: nextSerial(Math.max(zone.serial, current?.serial ?? 0)) } as never)
  }
  await rm(join(store.rootDir, movedStatePath(account.id)), { force: true })
  const current = await store.getAccountByUsername(username) ?? account
  // an operator may already have unsuspended it; the host still has to learn the restored zones
  if (current.status === 'suspended') await ports.setSuspension(caller, current, 'unsuspend')
  else await ports.applyAccount(caller, current)
  await rm(recordPath(store.rootDir, account.id), { force: true })
  await audit('transfer.live.reverted', { stage: record.stage })
  return panelJson({ reverted: true })
}
