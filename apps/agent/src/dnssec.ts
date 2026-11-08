import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import {
  DNSSEC_ALGORITHMS, DNSSEC_CURRENT_CONFIG_ARGV, dnssecAddKeyArgv, dnssecBindReloadArgv, dnssecDigArgv, dnssecDisableArgv, dnssecKeyArgv, dnssecListKeysArgv,
  dnssecPurgeArgv, dnssecSetNsec3Argv, dnssecShowZoneArgv, dnssecUnsetNsec3Argv, isDnssecAlgorithm, isDnssecKeyId,
} from '../../../packages/os/src/dnssec-command.ts'
import type { DnssecAlgorithm, DnssecKeyVerb } from '../../../packages/os/src/dnssec-command.ts'
import { isServiceDetailZone } from '@xpanel/os'

/**
 * DNSSEC for a zone served by the PowerDNS BIND backend: keys live in the backend's own key store
 * (`bind-dnssec-db`) and PowerDNS signs answers live. pdnsutil is the only writer; the published DNSKEY set and
 * the SOA signature are read back from the local listener, and DS records are computed from the published keys.
 */
export type DnssecKeyType = 'KSK' | 'ZSK' | 'CSK'
export interface DnssecDs { keyTag: number; algorithm: number; digestType: 2 | 4; digest: string }
export interface DnssecKeyView {
  id: number; type: DnssecKeyType; active: boolean; published: boolean; bits: number; algorithm: string; tag: number
  /** RDATA of the DNSKEY the local server publishes for this key, or null until it is observed. */
  dnskey: string | null
  ds: DnssecDs[]
}
export interface DnssecView {
  zone: string
  store: 'ready' | 'unconfigured'
  served: boolean
  signing: 'unsigned' | 'signed' | 'pending'
  nsec: { mode: 'nsec' | 'nsec3'; optOut: boolean; narrow: boolean } | null
  keys: DnssecKeyView[]
  publication: 'none' | 'current' | 'pending'
  dnskeyTtl: number | null
  observedAt: string
}
export type DnssecRequest =
  | { op: 'read' }
  | { op: 'enable'; algorithm: DnssecAlgorithm; layout: 'csk' | 'split' }
  | { op: 'disable' }
  | { op: 'add-key'; type: 'ksk' | 'zsk'; algorithm: DnssecAlgorithm; active: boolean }
  | { op: 'key'; verb: DnssecKeyVerb; keyId: number }
  | { op: 'nsec'; mode: 'nsec' | 'nsec3'; optOut: boolean }
  | { op: 'rollover-start'; keyId: number }
  | { op: 'rollover-finish'; keyId: number; newKeyId: number }
export interface DnssecResult { view: DnssecView; addedKeyIds: number[] }
export type DnssecRun = (argv: string[]) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>

const unchanged = { stateChanged: false }
const unrecognized = (what: string): never => fail('SERVICE_UNAVAILABLE', `PowerDNS ${what} could not be read`, { ...unchanged, reason: 'dnssec_observation_unrecognized' })
const ALGORITHM_NAMES: Record<number, string> = { 8: 'RSASHA256', 10: 'RSASHA512', 13: 'ECDSAP256SHA256', 14: 'ECDSAP384SHA384', 15: 'ED25519' }
const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '')

/** pdnsutil list-keys: `zone TYPE [Act] [Pub] bits algorithm id location tag` per key, after a header. */
export function parseDnssecKeyList(stdout: string, zone: string): Omit<DnssecKeyView, 'dnskey' | 'ds'>[] {
  const keys: Omit<DnssecKeyView, 'dnskey' | 'ds'>[] = []
  for (const line of stdout.split('\n').map(item => item.trim()).filter(Boolean)) {
    const words = line.split(/\s+/)
    if (bare(words[0]!) !== zone) {
      if (/^Zone\s+Type\s/.test(line) || /^-+$/.test(line)) continue
      return unrecognized('key list')
    }
    let at = 2
    const active = words[at] === 'Act' ? (at++, true) : false
    const published = words[at] === 'Pub' ? (at++, true) : false
    const [bits, algorithm, id, location, tag] = words.slice(at)
    if (words.length !== at + 5 || !['KSK', 'ZSK', 'CSK'].includes(words[1]!) || !/^[1-9][0-9]{0,5}$/.test(bits ?? '') || !/^[A-Z0-9-]{2,32}$/.test(algorithm ?? '')
      || !/^[1-9][0-9]{0,8}$/.test(id ?? '') || !location || !/^[0-9]{1,5}$/.test(tag ?? '') || Number(tag) > 65535) return unrecognized('key list')
    keys.push({ id: Number(id), type: words[1] as DnssecKeyType, active, published, bits: Number(bits), algorithm: algorithm!, tag: Number(tag) })
  }
  if (new Set(keys.map(key => key.id)).size !== keys.length) return unrecognized('key list')
  return keys.sort((a, b) => a.id - b.id)
}

/** pdnsutil show-zone: `Zone has NSEC semantics` or `Zone has [NARROW ]hashed NSEC3 semantics, configuration: 1 F I S`. */
export function parseDnssecNsec(stdout: string): DnssecView['nsec'] {
  if (/^Zone has NSEC semantics\s*$/m.test(stdout)) return { mode: 'nsec', optOut: false, narrow: false }
  const match = /^Zone has (NARROW )?hashed NSEC3 semantics, configuration: 1 ([01]) [0-9]+ \S+\s*$/m.exec(stdout)
  return match ? { mode: 'nsec3', optOut: match[2] === '1', narrow: !!match[1] } : null
}

interface PublishedKey { ttl: number; flags: number; protocol: number; algorithm: number; key: string }
/** `dig +noall +answer +nosplit` DNSKEY lines at the zone apex; RRSIG lines are counted separately. */
export function parseDnssecDnskeys(stdout: string, zone: string): { keys: PublishedKey[]; signed: boolean } {
  const keys: PublishedKey[] = []
  let signed = false
  for (const line of stdout.split('\n').map(item => item.trim()).filter(item => item && !item.startsWith(';'))) {
    const words = line.split(/\s+/)
    if (bare(words[0]!) !== zone || words[2] !== 'IN') return unrecognized('DNSKEY answer')
    if (words[3] === 'RRSIG') { signed ||= words[4] === 'DNSKEY'; continue }
    if (words[3] !== 'DNSKEY' || words.length !== 8 || !/^[0-9]{1,10}$/.test(words[1]!) || !/^(256|257)$/.test(words[4]!) || words[5] !== '3' || !/^[0-9]{1,3}$/.test(words[6]!) || !/^[A-Za-z0-9+/]+={0,2}$/.test(words[7]!)) return unrecognized('DNSKEY answer')
    keys.push({ ttl: Number(words[1]), flags: Number(words[4]), protocol: 3, algorithm: Number(words[6]), key: words[7]! })
  }
  return { keys, signed }
}
/** True when the SOA answer carries its RRSIG; null when the server gave no SOA (zone not served). */
export function parseDnssecSoa(stdout: string, zone: string): boolean | null {
  const lines = stdout.split('\n').map(item => item.trim()).filter(item => item && !item.startsWith(';')).map(line => line.split(/\s+/))
  if (lines.some(words => bare(words[0]!) !== zone || words[2] !== 'IN' || !['SOA', 'RRSIG'].includes(words[3]!))) return unrecognized('SOA answer')
  if (!lines.some(words => words[3] === 'SOA')) return null
  return lines.some(words => words[3] === 'RRSIG' && words[4] === 'SOA')
}

const ownerWire = (zone: string): Buffer => Buffer.concat([...zone.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])), Buffer.from([0])])
const dnskeyRdata = (key: Omit<PublishedKey, 'ttl'>): Buffer => Buffer.concat([Buffer.from([key.flags >> 8, key.flags & 0xff, key.protocol, key.algorithm]), Buffer.from(key.key, 'base64')])
/** RFC 4034 appendix B key tag. */
export function dnssecKeyTag(key: Omit<PublishedKey, 'ttl'>): number {
  let sum = 0
  for (const [index, byte] of dnskeyRdata(key).entries()) sum += index & 1 ? byte : byte << 8
  return (sum + ((sum >> 16) & 0xffff)) & 0xffff
}
/** RFC 4509 SHA-256 and RFC 6605 SHA-384 DS digests; RFC 8624 retires SHA-1 for delegation. */
export function dnssecDsRecords(zone: string, key: Omit<PublishedKey, 'ttl'>): DnssecDs[] {
  const data = Buffer.concat([ownerWire(zone), dnskeyRdata(key)])
  return ([[2, 'sha256'], [4, 'sha384']] as const).map(([digestType, hash]) => ({ keyTag: dnssecKeyTag(key), algorithm: key.algorithm, digestType, digest: createHash(hash).update(data).digest('hex').toUpperCase() }))
}

/** Only the key store setting is kept from the effective configuration, which can also hold secrets. */
export const dnssecStoreConfigured = (stdout: string): boolean => stdout.split('\n').some(line => /^\s*bind-dnssec-db\s*=\s*\S+/.test(line))

export function parseDnssecRequest(raw: unknown): DnssecRequest {
  const bad = (): never => fail('VALIDATION', 'unsupported DNSSEC request', unchanged)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad()
  const body = raw as Record<string, unknown>, keys = Object.keys(body).sort().join()
  const id = (value: unknown): number => isDnssecKeyId(value) ? value : bad()
  switch (body.op) {
    case 'read': case 'disable': return keys === 'op' ? { op: body.op } : bad()
    case 'enable': return keys === 'algorithm,layout,op' && isDnssecAlgorithm(body.algorithm) && (body.layout === 'csk' || body.layout === 'split') ? { op: 'enable', algorithm: body.algorithm, layout: body.layout } : bad()
    case 'add-key': return keys === 'active,algorithm,op,type' && (body.type === 'ksk' || body.type === 'zsk') && isDnssecAlgorithm(body.algorithm) && typeof body.active === 'boolean' ? { op: 'add-key', type: body.type, algorithm: body.algorithm, active: body.active } : bad()
    case 'key': return keys === 'keyId,op,verb' && ['activate', 'deactivate', 'publish', 'unpublish', 'remove'].includes(body.verb as string) ? { op: 'key', verb: body.verb as DnssecKeyVerb, keyId: id(body.keyId) } : bad()
    case 'nsec': return keys === 'mode,op,optOut' && (body.mode === 'nsec' || body.mode === 'nsec3') && typeof body.optOut === 'boolean' && (body.mode === 'nsec3' || !body.optOut) ? { op: 'nsec', mode: body.mode, optOut: body.optOut } : bad()
    case 'rollover-start': return keys === 'keyId,op' ? { op: 'rollover-start', keyId: id(body.keyId) } : bad()
    case 'rollover-finish': return keys === 'keyId,newKeyId,op' ? { op: 'rollover-finish', keyId: id(body.keyId), newKeyId: id(body.newKeyId) } : bad()
    default: return bad()
  }
}

const algorithmShorthand = (name: string): DnssecAlgorithm | null => {
  const number = Object.entries(ALGORITHM_NAMES).find(([, label]) => label === name)?.[0]
  return (Object.entries(DNSSEC_ALGORITHMS).find(([, value]) => String(value) === number)?.[0] as DnssecAlgorithm | undefined) ?? null
}

/** Reads the zone's key store, signing state and publication; never changes anything. */
export async function readDnssecView(run: DnssecRun, zone: string, now: () => Date = () => new Date()): Promise<DnssecView> {
  if (!isServiceDetailZone(zone)) return fail('VALIDATION', 'a lowercase zone name is required', unchanged)
  const config = await run([...DNSSEC_CURRENT_CONFIG_ARGV])
  if (!config.ok) return fail('SERVICE_UNAVAILABLE', 'the DNS server is not answering', { ...unchanged, reason: 'dns_service_unavailable' })
  const soa = await run(dnssecDigArgv(zone, 'SOA'))
  const signedSoa = soa.ok ? parseDnssecSoa(soa.stdout, zone) : null
  const base = { zone, served: signedSoa !== null, observedAt: now().toISOString() }
  if (!dnssecStoreConfigured(config.stdout)) return { ...base, store: 'unconfigured', signing: 'unsigned', nsec: null, keys: [], publication: 'none', dnskeyTtl: null }
  const listed = await run(dnssecListKeysArgv(zone))
  if (!listed.ok) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC key store could not be read', { ...unchanged, reason: 'dnssec_key_store_unreadable' })
  const keys = parseDnssecKeyList(listed.stdout, zone)
  const shown = keys.length ? await run(dnssecShowZoneArgv(zone)) : null
  if (shown && !shown.ok) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC zone settings could not be read', { ...unchanged, reason: 'dnssec_key_store_unreadable' })
  const answer = keys.length ? await run(dnssecDigArgv(zone, 'DNSKEY')) : null
  const published = answer?.ok ? parseDnssecDnskeys(answer.stdout, zone) : { keys: [], signed: false }
  const views: DnssecKeyView[] = keys.map(key => {
    const algorithm = algorithmShorthand(key.algorithm)
    const match = published.keys.find(item => dnssecKeyTag(item) === key.tag && (algorithm === null || item.algorithm === DNSSEC_ALGORITHMS[algorithm]))
    return { ...key, dnskey: match ? `${match.flags} 3 ${match.algorithm} ${match.key}` : null, ds: match && match.flags === 257 ? dnssecDsRecords(zone, match) : [] }
  })
  const expected = views.filter(key => key.published), current = expected.length === published.keys.length && expected.every(key => key.dnskey !== null)
  const signing = !keys.length ? 'unsigned' : signedSoa === true && published.signed && current ? 'signed' : 'pending'
  return { ...base, store: 'ready', signing, nsec: shown ? parseDnssecNsec(shown.stdout) : null, keys: views,
    publication: !keys.length ? 'none' : current ? 'current' : 'pending', dnskeyTtl: published.keys.length ? Math.max(...published.keys.map(item => item.ttl)) : null }
}

const signingKey = (key: Pick<DnssecKeyView, 'type'>): boolean => key.type !== 'ZSK'

/** Refusals that keep a signed zone verifiable; the API layer adds ownership, rollover timing and confirmation. */
export function assertDnssecChange(view: DnssecView, request: Exclude<DnssecRequest, { op: 'read' }>): void {
  const refuse = (message: string, reason: string): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason })
  if (view.store !== 'ready') refuse('this DNS server has no DNSSEC key store configured', 'dnssec_key_store_unavailable')
  if (!view.served) refuse('the zone is not served by the local DNS server', 'zone_not_published')
  const key = (id: number): DnssecKeyView => view.keys.find(item => item.id === id) ?? fail('NOT_FOUND', 'DNSSEC key not found', unchanged)
  if (request.op === 'enable' && view.keys.length) refuse('the zone already has DNSSEC keys', 'dnssec_already_enabled')
  if (request.op !== 'enable' && request.op !== 'disable' && !view.keys.length) refuse('DNSSEC is not enabled for this zone', 'dnssec_not_enabled')
  if (request.op === 'disable' && !view.keys.length) refuse('DNSSEC is not enabled for this zone', 'dnssec_not_enabled')
  if (request.op === 'key') {
    const target = key(request.keyId)
    const remaining = view.keys.filter(item => item.id !== target.id && item.active)
    if ((request.verb === 'deactivate' || request.verb === 'remove') && target.active && !remaining.some(signingKey)) refuse('the zone needs another active signing key first; turn DNSSEC off instead', 'last_active_key')
    if (request.verb === 'unpublish' && target.active) refuse('an active key must stay published', 'active_key_unpublished')
    if (request.verb === 'activate' && !target.published) refuse('publish the key before activating it', 'key_unpublished')
  }
  if (request.op === 'rollover-start') {
    if (view.keys.length >= 6) refuse('the zone already holds the maximum of 6 keys', 'dnssec_key_limit')
    if (!key(request.keyId).active) refuse('only an active key can be rolled over', 'key_inactive')
  }
  if (request.op === 'rollover-finish') {
    const old = key(request.keyId), next = key(request.newKeyId)
    if (old.id === next.id || old.type !== next.type || old.algorithm !== next.algorithm || !old.active || !next.published) refuse('the keys are not a started rollover pair', 'rollover_mismatch')
    if (view.publication !== 'current') refuse('the new key is not published by the DNS server yet', 'rollover_unpublished')
  }
  if (request.op === 'add-key' && view.keys.length >= 6) refuse('the zone already holds the maximum of 6 keys', 'dnssec_key_limit')
}

const ADDED_ID = /^([1-9][0-9]{0,8})\s*$/
/** Applies one checked change with pdnsutil, then purges the zone's cached answers and reads the result back. */
export async function runDnssecChange(run: DnssecRun, zone: string, request: Exclude<DnssecRequest, { op: 'read' }>, now?: () => Date): Promise<DnssecResult> {
  const before = await readDnssecView(run, zone, now)
  assertDnssecChange(before, request)
  const addedKeyIds: number[] = []
  let changed = false
  const step = async (argv: string[]): Promise<string> => {
    const result = await run(argv)
    if (!result.ok) return fail('SERVICE_UNAVAILABLE', 'PowerDNS refused the DNSSEC change', { stateChanged: changed, ...(changed ? { verificationRequired: true } : {}), reason: 'dnssec_change_refused' })
    changed = true
    return result.stdout
  }
  const add = async (type: 'ksk' | 'zsk', algorithm: DnssecAlgorithm, active: boolean): Promise<void> => {
    const id = ADDED_ID.exec(await step(dnssecAddKeyArgv(zone, type, algorithm, active, true)))
    if (!id) return fail('SERVICE_UNAVAILABLE', 'PowerDNS added a key without reporting its id', { stateChanged: true, verificationRequired: true, reason: 'dnssec_change_unverified' })
    addedKeyIds.push(Number(id[1]))
  }
  const target = (id: number): DnssecKeyView => before.keys.find(item => item.id === id)!
  try {
    if (request.op === 'enable') {
      await add('ksk', request.algorithm, true)
      if (request.layout === 'split') await add('zsk', request.algorithm, true)
    } else if (request.op === 'disable') await step(dnssecDisableArgv(zone))
    else if (request.op === 'add-key') await add(request.type, request.algorithm, request.active)
    else if (request.op === 'key') await step(dnssecKeyArgv(request.verb, zone, request.keyId))
    else if (request.op === 'nsec') await step(request.mode === 'nsec3' ? dnssecSetNsec3Argv(zone, request.optOut) : dnssecUnsetNsec3Argv(zone))
    else if (request.op === 'rollover-start') {
      // A ZSK is pre-published inactive (RFC 6781 4.1.1.1); a KSK or CSK signs alongside the old one (double signature).
      const old = target(request.keyId), algorithm = algorithmShorthand(old.algorithm)
      if (!algorithm) return fail('PRECONDITION_FAILED', 'the key uses an algorithm this panel does not offer', { ...unchanged, reason: 'algorithm_unsupported' })
      await add(old.type === 'ZSK' ? 'zsk' : 'ksk', algorithm, old.type !== 'ZSK')
    } else {
      const old = target(request.keyId)
      if (old.type === 'ZSK') {
        await step(dnssecKeyArgv('activate', zone, request.newKeyId))
        await step(dnssecKeyArgv('deactivate', zone, request.keyId))
      } else await step(dnssecKeyArgv('remove', zone, request.keyId))
    }
    if (request.op === 'nsec' || request.op === 'disable') await step(dnssecBindReloadArgv(zone))
    await step(dnssecPurgeArgv(zone))
  } catch (error) {
    if (changed && isXpanelError(error) && error.detail?.stateChanged !== true) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC change was only partly applied', { stateChanged: true, verificationRequired: true, reason: 'dnssec_change_partial' })
    throw error
  }
  let view: DnssecView
  try { view = await readDnssecView(run, zone, now) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the DNSSEC change was applied but could not be read back', { stateChanged: true, verificationRequired: true, reason: 'dnssec_change_unverified' }) }
  if (!dnssecChangeVisible(before, view, request, addedKeyIds)) return fail('SERVICE_UNAVAILABLE', 'the DNSSEC key store does not show the change', { stateChanged: true, verificationRequired: true, reason: 'dnssec_change_unverified' })
  return { view, addedKeyIds }
}

/** The key store, which pdnsutil wrote, must show the change; publication may trail by the server's key cache. */
export function dnssecChangeVisible(before: DnssecView, after: DnssecView, request: Exclude<DnssecRequest, { op: 'read' }>, added: readonly number[]): boolean {
  const key = (id: number) => after.keys.find(item => item.id === id)
  switch (request.op) {
    case 'enable': case 'add-key': case 'rollover-start': return added.every(id => key(id) !== undefined) && after.keys.length === before.keys.length + added.length
    case 'disable': return after.keys.length === 0
    case 'nsec': return after.nsec?.mode === request.mode && after.nsec.optOut === request.optOut
    case 'key': {
      const found = key(request.keyId)
      return request.verb === 'remove' ? !found : !!found && (request.verb === 'activate' ? found.active : request.verb === 'deactivate' ? !found.active : request.verb === 'publish' ? found.published : !found.published)
    }
    case 'rollover-finish': {
      const old = key(request.keyId), next = key(request.newKeyId)
      return !!next && next.active && (before.keys.find(item => item.id === request.keyId)?.type === 'ZSK' ? !!old && !old.active : !old)
    }
  }
}
