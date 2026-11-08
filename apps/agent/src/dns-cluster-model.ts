import { createHash, timingSafeEqual } from 'node:crypto'
import { canonicalIp, fail, validateDomainName } from '@xpanel/core'
import type { DnsRecord } from '@xpanel/core'
import { backgroundStateWrite, type DnsZoneState, type StateStore } from '@xpanel/state'
import { services } from '@xpanel/render'
import { secSerialBehind } from './sec-dns-cluster.ts'

/** Saved by the API, mode 0600: outbound tokens live only here and never reach a view, audit row or error. */
export const DNS_CLUSTER_STATE = 'extended/dns/cluster.json'
/** Written by the agent: what each member last did. Rebuildable, holds no secret. */
export const DNS_CLUSTER_RUNTIME = 'extended/dns/cluster-runtime.json'
export const DNS_CLUSTER_ROLES = ['standalone', 'synchronize', 'write-only'] as const
export type DnsClusterRole = typeof DNS_CLUSTER_ROLES[number]
export const DNS_CLUSTER_DEFAULT_THRESHOLD = 10
export const DNS_CLUSTER_PORT = 2087
export const DNS_CLUSTER_MAX_PEERS = 16
export const DNS_CLUSTER_MAX_ZONE_BYTES = 1024 * 1024
export const DNS_CLUSTER_PROTOCOL = 1
export const DNS_CLUSTER_PEER_PREFIX = '/api/cluster/dns/'
export const DNS_CLUSTER_TOKEN = /^xpdc_[A-Za-z0-9_-]{43}$/
export const DNS_CLUSTER_PIN = /^[0-9a-f]{64}$/

export interface DnsClusterMember { name: string; address: string; port: number; pin: string; token: string; role: DnsClusterRole; createdAt: string }
/** A member allowed to call this server. Only the token hash is kept; `issuedBy` is the root every call acts as. */
export interface DnsClusterInbound { name: string; address: string; tokenHash: string; hint: string; issuedBy: string; createdAt: string }
export interface DnsClusterConfig { version: 1; enabled: boolean; failureThreshold: number; members: DnsClusterMember[]; inbound: DnsClusterInbound[]; updatedAt: string | null }
export const DNS_CLUSTER_DEFAULT: DnsClusterConfig = { version: 1, enabled: false, failureThreshold: DNS_CLUSTER_DEFAULT_THRESHOLD, members: [], inbound: [], updatedAt: null }

export type DnsZoneConflict = 'owned_locally' | 'other_origin' | 'modified_here' | 'same_serial' | 'older_serial'
export type DnsMemberState = 'never_contacted' | 'online' | 'outage' | 'pin_mismatch' | 'unauthorized' | 'refused' | 'auto_disabled'
export type DnsMemberFailure = 'pin_mismatch' | 'unreachable' | 'timeout' | 'tls_failed' | 'bad_response' | 'unauthorized' | 'refused' | 'peer_error' | 'reconcile_failed'
export interface DnsZoneAck { serial: number; digest: string; state: 'synced' | 'conflict' | 'rejected' | 'dnssec_signed'; reason: DnsZoneConflict | null; at: string }
export interface DnsMemberRuntime {
  state: DnsMemberState
  failures: number
  failureCode: DnsMemberFailure | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  outageSince: string | null
  nextAttemptAt: string | null
  /** Set when the last pass stopped early, so the next tick carries on without a zone change. */
  pending: boolean
  zones: Record<string, DnsZoneAck>
}
export interface DnsClusterRuntime { version: 1; members: Record<string, DnsMemberRuntime> }
export const emptyMemberRuntime = (): DnsMemberRuntime => ({ state: 'never_contacted', failures: 0, failureCode: null, lastAttemptAt: null, lastSuccessAt: null, outageSince: null, nextAttemptAt: null, pending: true, zones: {} })

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string): boolean => Object.keys(value).sort().join() === keys
const stamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const refused = (message: string): never => fail('VALIDATION', message, { stateChanged: false })

/** Fully qualified, because the name is the TLS server name and the identity zone copies carry. */
export function dnsClusterName(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('.')) return refused('the member name must be a full host name')
  return validateDomainName(value)
}
export function dnsClusterAddress(value: unknown): string {
  if (typeof value !== 'string') return refused('the member address must be one IP address')
  try { return canonicalIp(value, 'member address').address } catch { return refused('the member address must be one IP address') }
}
export function dnsClusterPort(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : refused('the member port must be 1 to 65535')
}
export function dnsClusterPin(value: unknown): string {
  return typeof value === 'string' && DNS_CLUSTER_PIN.test(value) ? value : refused('the TLS pin must be 64 lowercase hexadecimal characters')
}
export function dnsClusterToken(value: unknown): string {
  return typeof value === 'string' && DNS_CLUSTER_TOKEN.test(value) ? value : refused('the member token is not a cluster token')
}
export function dnsClusterRole(value: unknown): DnsClusterRole {
  return (DNS_CLUSTER_ROLES as readonly unknown[]).includes(value) ? value as DnsClusterRole : refused('the member role must be standalone, synchronize or write-only')
}
export function dnsClusterThreshold(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : refused('the failure threshold must be 1 to 1000')
}
const unique = (items: readonly { name: string }[]): boolean => new Set(items.map(item => item.name)).size === items.length

/** The saved file, or null when it does not match its grammar exactly. */
export function readDnsClusterConfig(raw: unknown): DnsClusterConfig | null {
  if (raw === null || raw === undefined) return structuredClone(DNS_CLUSTER_DEFAULT)
  try {
    if (!object(raw) || !exact(raw, 'enabled,failureThreshold,inbound,members,updatedAt,version') || raw.version !== 1 || typeof raw.enabled !== 'boolean' || !Array.isArray(raw.members) || !Array.isArray(raw.inbound)
      || raw.members.length > DNS_CLUSTER_MAX_PEERS || raw.inbound.length > DNS_CLUSTER_MAX_PEERS || raw.updatedAt !== null && !stamp(raw.updatedAt)) return null
    const members = raw.members.map((item: unknown): DnsClusterMember => {
      if (!object(item) || !exact(item, 'address,createdAt,name,pin,port,role,token') || !stamp(item.createdAt)) throw new Error('member')
      return { name: dnsClusterName(item.name), address: dnsClusterAddress(item.address), port: dnsClusterPort(item.port), pin: dnsClusterPin(item.pin), token: dnsClusterToken(item.token), role: dnsClusterRole(item.role), createdAt: item.createdAt }
    })
    const inbound = raw.inbound.map((item: unknown): DnsClusterInbound => {
      if (!object(item) || !exact(item, 'address,createdAt,hint,issuedBy,name,tokenHash') || !stamp(item.createdAt) || typeof item.tokenHash !== 'string' || !DNS_CLUSTER_PIN.test(item.tokenHash)
        || typeof item.hint !== 'string' || !/^[A-Za-z0-9_-]{4}$/.test(item.hint) || typeof item.issuedBy !== 'string' || item.issuedBy.length > 64) throw new Error('inbound')
      return { name: dnsClusterName(item.name), address: dnsClusterAddress(item.address), tokenHash: item.tokenHash, hint: item.hint, issuedBy: item.issuedBy, createdAt: item.createdAt }
    })
    if (!unique(members) || !unique(inbound)) return null
    return { version: 1, enabled: raw.enabled, failureThreshold: dnsClusterThreshold(raw.failureThreshold), members, inbound, updatedAt: raw.updatedAt as string | null }
  } catch { return null }
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
/** Covers token digests, never token bytes. */
export function dnsClusterRevision(raw: unknown): string {
  const config = readDnsClusterConfig(raw)
  return sha256(JSON.stringify(config ? { ...config, members: config.members.map(member => ({ ...member, token: sha256(member.token) })) } : { invalid: true }))
}
export const dnsClusterTokenHash = sha256
export const dnsClusterTokenMatches = (token: string, hash: string): boolean => timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(hash, 'hex'))

/** The record set a member serves: ids and SOA excluded, so both ends of a copy hash the same text alike. */
export function dnsZoneDigest(records: readonly Pick<DnsRecord, 'name' | 'type' | 'ttl' | 'content' | 'priority'>[]): string {
  return sha256(records.map(record => [record.name, record.type, record.ttl, record.priority ?? '', record.content].join('\t')).sort().join('\n'))
}
export interface DnsZoneCopy { zone: string; serial: number; digest: string; records: Omit<DnsRecord, 'id'>[] }
/** Parses a rendered zone file under the same rules as a zone import; a record the state cannot hold is refused. */
export function dnsZoneCopyFromText(zone: string, text: string): DnsZoneCopy {
  if (Buffer.byteLength(text) > DNS_CLUSTER_MAX_ZONE_BYTES) return refused('the zone text is too large')
  const parsed = services.parseBindZone(text, { origin: zone })
  if (parsed.skipped.length) return refused('the zone text holds records this server cannot store')
  const soa = parsed.records.filter(record => record.type === 'SOA')
  if (soa.length !== 1) return refused('the zone text must hold exactly one SOA record')
  const serial = Number(soa[0]!.content.trim().split(/\s+/)[2])
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > services.MAX_SERIAL) return refused('the zone SOA serial is invalid')
  const records = parsed.records.filter(record => record.type !== 'SOA').map(record => ({ zone, name: record.name, type: record.type as DnsRecord['type'], ttl: record.ttl, content: record.content, priority: record.priority ?? null }))
  return { zone, serial, digest: dnsZoneDigest(records), records }
}

export type DnsZoneDecision = { action: 'write' | 'unchanged' } | { action: 'conflict'; reason: DnsZoneConflict }
const conflict = (reason: DnsZoneConflict): DnsZoneDecision => ({ action: 'conflict', reason })
/** Who holds a zone decides whether a copy lands. An account zone or another member's copy is never overwritten, even when forced. */
export function decideDnsZone(current: DnsZoneState | null, incoming: { peer: string; serial: number; digest: string }, force = false): DnsZoneDecision {
  if (!current) return { action: 'write' }
  if (current.accountId !== null || !current.replica) return conflict('owned_locally')
  if (current.replica.peer !== incoming.peer) return conflict('other_origin')
  if (!force && dnsZoneDigest(current.records) !== current.replica.digest) return conflict('modified_here')
  if (incoming.digest === current.replica.digest && incoming.serial === current.serial) return { action: 'unchanged' }
  if (force) return { action: 'write' }
  if (incoming.serial === current.serial) return conflict('same_serial')
  return secSerialBehind(incoming.serial, current.serial) ? conflict('older_serial') : { action: 'write' }
}
export function decideDnsZoneRemoval(current: DnsZoneState | null, peer: string): DnsZoneDecision {
  if (!current) return { action: 'unchanged' }
  if (current.accountId !== null || !current.replica) return conflict('owned_locally')
  if (current.replica.peer !== peer) return conflict('other_origin')
  return dnsZoneDigest(current.records) === current.replica.digest ? { action: 'write' } : conflict('modified_here')
}
/** Applies one member's zone copy to this server's state; the decision reruns under the writer lease that saves it. */
export async function applyDnsZoneCopy(store: Pick<StateStore, 'getDnsZone' | 'saveDnsZone'>, peer: string, copy: DnsZoneCopy, input: { id: string; at: string; force?: boolean; recordId: () => string }): Promise<DnsZoneDecision> {
  let decision: DnsZoneDecision = { action: 'unchanged' }
  const held = await store.getDnsZone(copy.zone), incoming = { peer, serial: copy.serial, digest: copy.digest }
  const first = decideDnsZone(held, incoming, input.force)
  if (first.action !== 'write') return first
  const next: DnsZoneState = { id: held?.id ?? input.id, accountId: null, name: copy.zone, serial: copy.serial, records: copy.records.map(record => ({ ...record, id: input.recordId() })), replica: { peer, digest: copy.digest, at: input.at } }
  const stop = new Error('dns_cluster_zone_decided')
  try {
    await backgroundStateWrite(() => store.saveDnsZone(next, { dnsGuard: async current => { decision = decideDnsZone(current, incoming, input.force); if (decision.action !== 'write') throw stop } }))
  } catch (error) { if (error !== stop) throw error }
  return decision
}
/** A removal arriving from a member, decided again under the writer lease that deletes. */
export async function removeDnsZoneCopy(store: Pick<StateStore, 'getDnsZone' | 'deleteDnsZone'>, peer: string, zone: string): Promise<DnsZoneDecision> {
  let decision = decideDnsZoneRemoval(await store.getDnsZone(zone), peer)
  if (decision.action !== 'write') return decision
  const stop = new Error('dns_cluster_zone_decided')
  try { await backgroundStateWrite(() => store.deleteDnsZone(zone, { dnsGuard: async current => { decision = decideDnsZoneRemoval(current, peer); if (decision.action !== 'write') throw stop } })) }
  catch (error) { if (error !== stop) throw error }
  return decision
}
