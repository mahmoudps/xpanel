import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { applyDnsZoneCopy, DNS_CLUSTER_RUNTIME, DNS_CLUSTER_STATE, dnsZoneCopyFromText, emptyMemberRuntime, readDnsClusterConfig } from './dns-cluster-model.ts'
import type { DnsClusterConfig, DnsClusterMember, DnsClusterRuntime, DnsMemberFailure, DnsMemberRuntime, DnsZoneConflict, DnsZoneDecision } from './dns-cluster-model.ts'
import { dnsClusterPinnedCall, DnsClusterTransportError } from './dns-cluster-transport.ts'
import type { DnsClusterCall, DnsClusterResponse } from './dns-cluster-transport.ts'
import { secQuerySoa } from './sec-dns-cluster.ts'
import type { SecQuerySoa } from './sec-dns-cluster.ts'

export const DNS_CLUSTER_PASS_LIMIT = 64
export const DNS_CLUSTER_HEARTBEAT_MS = 300_000
const MAX_BACKOFF_MS = 3_600_000
const COMMIT_TIMEOUT_MS = 180_000

export interface LocalZone { zone: string; serial: number; digest: string; text: string }
export interface DnsClusterSyncDeps {
  rootDir: string
  store: Pick<StateStore, 'listDnsZones' | 'getDnsZone' | 'saveDnsZone'>
  /** The rendered file PowerDNS serves, because it carries the mail records and the serial that state does not. */
  readZoneFile: (zone: string) => Promise<string | null>
  /** Changes on every zone file publish, so an idle tick reads no zones. */
  zoneStamp: () => Promise<number | null>
  /** A signed zone is withheld, because a member without its keys would answer unsigned under a published DS. Null: the key store was not read. */
  signedZone: (zone: string) => Promise<boolean | null>
  reconcile: () => Promise<boolean>
  audit: (entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  call?: DnsClusterCall
  querySoa?: SecQuerySoa
  now?: () => Date
}
export type DnsClusterSyncMode = 'push' | 'pull'
export interface DnsClusterSyncRequest { mode: DnsClusterSyncMode; zone: string | null; member: string | null; includeMissing: boolean; force: boolean }
export interface DnsClusterMemberOutcome {
  member: string
  state: DnsMemberRuntime['state']
  written: number; removed: number; unchanged: number
  conflicts: { zone: string; reason: DnsZoneConflict | 'rejected' }[]
  withheld: string[]
  failure: DnsMemberFailure | null
  /** One zone only: the serial the member answers on port 53 after its reload. */
  verified: { zone: string; serial: number | null; inSync: boolean } | null
  skipped: 'standalone' | 'auto_disabled' | 'write_only' | null
}
const outcomeOf = (member: string, state: DnsMemberRuntime['state']): DnsClusterMemberOutcome => ({ member, state, written: 0, removed: 0, unchanged: 0, conflicts: [], withheld: [], failure: null, verified: null, skipped: null })
const failureOf = (error: unknown): DnsMemberFailure => error instanceof DnsClusterTransportError ? error.kind : 'bad_response'
const statusFailure = (status: number): DnsMemberFailure | null => status === 401 ? 'unauthorized' : status === 403 ? 'refused' : status >= 500 || status === 0 ? 'peer_error' : null
const pathOf = (zone: string): string => 'zones/' + encodeURIComponent(zone)

/** Reads the runtime file; an unreadable one rebuilds from nothing, which only repeats pushes. */
export async function readDnsClusterRuntime(rootDir: string): Promise<DnsClusterRuntime> {
  try {
    const raw = JSON.parse(await readFile(join(rootDir, DNS_CLUSTER_RUNTIME), 'utf8')) as DnsClusterRuntime
    return raw && raw.version === 1 && raw.members && typeof raw.members === 'object' ? raw : { version: 1, members: {} }
  } catch { return { version: 1, members: {} } }
}
export async function readDnsClusterConfigFile(rootDir: string): Promise<DnsClusterConfig | null> {
  let text: string
  try { text = await readFile(join(rootDir, DNS_CLUSTER_STATE), 'utf8') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? readDnsClusterConfig(null) : null }
  try { return readDnsClusterConfig(JSON.parse(text)) } catch { return null }
}

/**
 * Zones this server is the source of, as PowerDNS serves them. A copy held for another member is never sent on.
 * `names` holds every source zone, so a file that is missing or unreadable for now never reads as a removal.
 */
export async function readLocalZones(deps: { store: Pick<StateStore, 'listDnsZones'>; readZoneFile: DnsClusterSyncDeps['readZoneFile'] }): Promise<{ zones: LocalZone[]; names: Set<string> }> {
  const zones: LocalZone[] = [], names = new Set<string>()
  for (const zone of (await deps.store.listDnsZones()).filter(item => !item.replica)) {
    names.add(zone.name)
    const text = await deps.readZoneFile(zone.name)
    if (text === null) continue
    try { const copy = dnsZoneCopyFromText(zone.name, text); zones.push({ zone: zone.name, serial: copy.serial, digest: copy.digest, text }) } catch { continue }
  }
  return { zones, names }
}

export interface DnsClusterSync {
  tick(): Promise<void>
  run(request: DnsClusterSyncRequest): Promise<{ observedAt: string; mode: DnsClusterSyncMode; members: DnsClusterMemberOutcome[] }>
  reset(member: string): Promise<boolean>
}

/** Runs on the agent's existing minute tick. No member, no work: nothing here owns a timer or a daemon. */
export function createDnsClusterSync(deps: DnsClusterSyncDeps): DnsClusterSync {
  const call = deps.call ?? dnsClusterPinnedCall, query = deps.querySoa ?? secQuerySoa, now = deps.now ?? (() => new Date())
  let busy = false, lastStamp: number | null = null
  const saveRuntime = (runtime: DnsClusterRuntime): Promise<void> => atomicWriteJson(join(deps.rootDir, DNS_CLUSTER_RUNTIME), runtime, 0o640)
  const memberRuntime = (runtime: DnsClusterRuntime, name: string): DnsMemberRuntime => runtime.members[name] ??= emptyMemberRuntime()
  // A member removed and added back starts clean: the acknowledgements of the old one prove nothing.
  const forgetRemoved = (runtime: DnsClusterRuntime, config: DnsClusterConfig): boolean => {
    const gone = Object.keys(runtime.members).filter(name => !config.members.some(member => member.name === name))
    for (const name of gone) delete runtime.members[name]
    return gone.length > 0
  }
  const prefix = '/api/cluster/dns/'

  const failed = async (config: DnsClusterConfig, member: DnsClusterMember, state: DnsMemberRuntime, code: DnsMemberFailure): Promise<void> => {
    const at = now()
    state.failures += 1; state.failureCode = code; state.outageSince ??= at.toISOString(); state.pending = true
    state.nextAttemptAt = new Date(at.getTime() + Math.min(60_000 * 2 ** Math.min(state.failures - 1, 20), MAX_BACKOFF_MS)).toISOString()
    if (state.failures >= config.failureThreshold) {
      const first = state.state !== 'auto_disabled'
      state.state = 'auto_disabled'; state.nextAttemptAt = null
      // A failed audit row is what the WHM notification list reads.
      if (first) await deps.audit({ action: 'dns.cluster.member_disabled', target: 'dns-member:' + member.name, outcome: 'failed', detail: { failures: state.failures, failure: code } }).catch(() => {})
      return
    }
    state.state = code === 'pin_mismatch' ? 'pin_mismatch' : code === 'unauthorized' ? 'unauthorized' : code === 'refused' ? 'refused' : 'outage'
  }
  const succeeded = (state: DnsMemberRuntime): void => {
    const at = now().toISOString()
    Object.assign(state, { state: 'online', failures: 0, failureCode: null, lastSuccessAt: at, outageSince: null, nextAttemptAt: null })
  }
  /** Returns the response, or null after recording a member failure. */
  const command = async (config: DnsClusterConfig, member: DnsClusterMember, state: DnsMemberRuntime, method: 'GET' | 'PUT' | 'DELETE' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<DnsClusterResponse | null> => {
    state.lastAttemptAt = now().toISOString()
    let response: DnsClusterResponse
    try { response = await call(member, { method, path: prefix + path, ...(body === undefined ? {} : { body }), ...(timeoutMs ? { timeoutMs } : {}) }) }
    catch (error) { await failed(config, member, state, failureOf(error)); return null }
    const code = statusFailure(response.status)
    if (code) { await failed(config, member, state, code); return null }
    return response
  }

  const push = async (config: DnsClusterConfig, member: DnsClusterMember, state: DnsMemberRuntime, options: { zone: string | null; force: boolean; retry: boolean }): Promise<DnsClusterMemberOutcome> => {
    const outcome = outcomeOf(member.name, state.state), lastContact = state.lastAttemptAt
    const read = await readLocalZones(deps), local = read.zones.filter(zone => !options.zone || zone.zone === options.zone)
    const at = now().toISOString()
    const work: LocalZone[] = []
    for (const zone of local) {
      const ack = state.zones[zone.zone]
      if (ack && ack.digest === zone.digest && ack.serial === zone.serial && (ack.state === 'synced' || !options.retry && ack.state !== 'dnssec_signed')) { outcome.unchanged += 1; continue }
      work.push(zone)
    }
    const gone = options.zone ? [] : Object.keys(state.zones).filter(zone => !read.names.has(zone))
    for (const zone of gone) if (state.zones[zone]!.state === 'dnssec_signed') delete state.zones[zone]
    const removals = gone.filter(zone => state.zones[zone] && (options.retry || state.zones[zone]!.state === 'synced'))
    state.pending = work.length + removals.length > DNS_CLUSTER_PASS_LIMIT
    let changed = false, spent = 0
    for (const zone of work) {
      if (spent++ >= DNS_CLUSTER_PASS_LIMIT) break
      const signed = await deps.signedZone(zone.zone)
      if (signed !== false) {
        if (signed) state.zones[zone.zone] = { serial: zone.serial, digest: zone.digest, state: 'dnssec_signed', reason: null, at }; else state.pending = true
        outcome.withheld.push(zone.zone)
        continue
      }
      const response = await command(config, member, state, 'PUT', pathOf(zone.zone), { serial: zone.serial, text: zone.text, force: options.force })
      if (!response) { outcome.failure = state.failureCode; return outcome }
      const body = (response.body ?? {}) as { outcome?: string; reason?: DnsZoneConflict }
      if (response.status === 200 && (body.outcome === 'written' || body.outcome === 'unchanged')) {
        state.zones[zone.zone] = { serial: zone.serial, digest: zone.digest, state: 'synced', reason: null, at }
        if (body.outcome === 'written') { outcome.written += 1; changed = true } else outcome.unchanged += 1
      } else if (response.status === 409 && typeof body.reason === 'string') {
        state.zones[zone.zone] = { serial: zone.serial, digest: zone.digest, state: 'conflict', reason: body.reason, at }
        outcome.conflicts.push({ zone: zone.zone, reason: body.reason })
      } else {
        state.zones[zone.zone] = { serial: zone.serial, digest: zone.digest, state: 'rejected', reason: null, at }
        outcome.conflicts.push({ zone: zone.zone, reason: 'rejected' })
      }
    }
    for (const zone of removals) {
      if (spent++ >= DNS_CLUSTER_PASS_LIMIT) break
      const response = await command(config, member, state, 'DELETE', pathOf(zone))
      if (!response) { outcome.failure = state.failureCode; return outcome }
      if (response.status === 200) { delete state.zones[zone]; outcome.removed += 1; changed = true }
      else {
        const reason = ((response.body ?? {}) as { reason?: DnsZoneConflict }).reason
        state.zones[zone] = { ...state.zones[zone]!, state: 'conflict', reason: reason ?? null, at }
        outcome.conflicts.push({ zone, reason: reason ?? 'rejected' })
      }
    }
    if (changed) {
      const response = await command(config, member, state, 'POST', 'commit', {}, COMMIT_TIMEOUT_MS)
      if (!response) { outcome.failure = state.failureCode; return outcome }
      if (response.status !== 200 || (response.body as { outcome?: string } | null)?.outcome !== 'applied') { await failed(config, member, state, 'reconcile_failed'); outcome.failure = 'reconcile_failed'; return outcome }
    }
    // A pass that sent nothing proves nothing about the member.
    if (state.lastAttemptAt !== lastContact) succeeded(state)
    outcome.state = state.state
    if (options.zone && local.length && !outcome.withheld.length) {
      const answer = await query(member.address, options.zone).catch(() => ({ error: 'failed' as const }))
      const serial = 'serial' in answer ? answer.serial : null
      outcome.verified = { zone: options.zone, serial, inSync: serial === local[0]!.serial }
    }
    return outcome
  }

  const pull = async (config: DnsClusterConfig, member: DnsClusterMember, state: DnsMemberRuntime, options: { zone: string | null; includeMissing: boolean }): Promise<DnsClusterMemberOutcome> => {
    const outcome = outcomeOf(member.name, state.state)
    const listed = await command(config, member, state, 'GET', 'zones')
    if (!listed) { outcome.failure = state.failureCode; return outcome }
    const rows = (listed.body as { zones?: { zone: string; serial: number; origin: string }[] } | null)?.zones
    if (!Array.isArray(rows)) { await failed(config, member, state, 'bad_response'); outcome.failure = 'bad_response'; return outcome }
    const at = now().toISOString()
    let changed = false, spent = 0
    for (const row of rows) {
      if (row.origin !== 'local' || options.zone && row.zone !== options.zone) continue
      const held = await deps.store.getDnsZone(row.zone)
      if (!held && !options.includeMissing) continue
      if (held?.replica?.peer === member.name && held.serial === row.serial) { outcome.unchanged += 1; continue }
      if (spent++ >= DNS_CLUSTER_PASS_LIMIT) { state.pending = true; break }
      const response = await command(config, member, state, 'GET', pathOf(row.zone))
      if (!response) { outcome.failure = state.failureCode; return outcome }
      const text = (response.body as { text?: unknown } | null)?.text
      if (response.status !== 200 || typeof text !== 'string') { outcome.conflicts.push({ zone: row.zone, reason: 'rejected' }); continue }
      let decision: DnsZoneDecision
      try { decision = await applyDnsZoneCopy(deps.store, member.name, dnsZoneCopyFromText(row.zone, text), { id: randomUUID(), at, recordId: randomUUID }) }
      catch { outcome.conflicts.push({ zone: row.zone, reason: 'rejected' }); continue }
      if (decision.action === 'conflict') outcome.conflicts.push({ zone: row.zone, reason: decision.reason })
      else if (decision.action === 'write') { outcome.written += 1; changed = true }
      else outcome.unchanged += 1
    }
    if (changed && !await deps.reconcile()) { await failed(config, member, state, 'reconcile_failed'); outcome.failure = 'reconcile_failed'; return outcome }
    succeeded(state)
    outcome.state = state.state
    return outcome
  }

  const exclusive = async <T>(work: () => Promise<T>, whenBusy: () => T): Promise<T> => {
    if (busy) return whenBusy()
    busy = true
    try { return await work() } finally { busy = false }
  }
  return {
    tick: () => exclusive(async () => {
      const config = await readDnsClusterConfigFile(deps.rootDir)
      if (!config?.enabled) return
      const members = config.members.filter(member => member.role !== 'standalone')
      if (!members.length) return
      const stamp = await deps.zoneStamp(), runtime = await readDnsClusterRuntime(deps.rootDir), at = now()
      const moved = stamp !== lastStamp
      let dirty = forgetRemoved(runtime, config)
      for (const member of members) {
        const state = memberRuntime(runtime, member.name)
        if (state.state === 'auto_disabled' || state.nextAttemptAt && Date.parse(state.nextAttemptAt) > at.getTime()) continue
        const beat = !state.lastAttemptAt || at.getTime() - Date.parse(state.lastAttemptAt) >= DNS_CLUSTER_HEARTBEAT_MS
        const lastContact = state.lastAttemptAt
        if (moved || state.pending) { await push(config, member, state, { zone: null, force: false, retry: false }); dirty = true }
        if (beat && state.lastAttemptAt === lastContact) { const response = await command(config, member, state, 'GET', 'hello'); if (response) succeeded(state); dirty = true }
      }
      lastStamp = stamp
      if (dirty) await saveRuntime(runtime)
    }, () => undefined),
    run: request => exclusive(async () => {
      const config = await readDnsClusterConfigFile(deps.rootDir)
      if (!config) return fail('PRECONDITION_FAILED', 'the saved DNS cluster configuration is invalid', { stateChanged: false, reason: 'cluster_config_invalid' })
      if (!config.enabled) return fail('PRECONDITION_FAILED', 'DNS clustering is turned off', { stateChanged: false, reason: 'cluster_disabled' })
      const runtime = await readDnsClusterRuntime(deps.rootDir), outcomes: DnsClusterMemberOutcome[] = []
      forgetRemoved(runtime, config)
      for (const member of config.members.filter(item => !request.member || item.name === request.member)) {
        const state = memberRuntime(runtime, member.name), skipped = member.role === 'standalone' ? 'standalone' as const : state.state === 'auto_disabled' ? 'auto_disabled' as const : request.mode === 'pull' && member.role === 'write-only' ? 'write_only' as const : null
        if (skipped) { outcomes.push({ ...outcomeOf(member.name, state.state), skipped }); continue }
        outcomes.push(request.mode === 'push' ? await push(config, member, state, { zone: request.zone, force: request.force, retry: true }) : await pull(config, member, state, request))
      }
      await saveRuntime(runtime)
      return { observedAt: now().toISOString(), mode: request.mode, members: outcomes }
    }, () => fail('CONFLICT', 'a cluster synchronisation is already running', { stateChanged: false, reason: 'cluster_sync_running' })),
    reset: name => exclusive(async () => {
      const runtime = await readDnsClusterRuntime(deps.rootDir), state = runtime.members[name]
      if (!state) return false
      Object.assign(state, { state: 'never_contacted', failures: 0, failureCode: null, outageSince: null, nextAttemptAt: null, pending: true })
      await saveRuntime(runtime)
      return true
    }, () => fail('CONFLICT', 'a cluster synchronisation is already running', { stateChanged: false, reason: 'cluster_sync_running' })),
  }
}

export const dnsZoneDirStamp = (zoneDir: string) => async (): Promise<number | null> => {
  try { return (await stat(zoneDir)).mtimeMs } catch { return null }
}
