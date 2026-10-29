import { Resolver } from 'node:dns/promises'
import { readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { SEC_PDNS_CONF } from '../../../packages/os/src/sec-host-command.ts'
import type { SecDnsPeer } from './sec-policy.ts'
import type { SecReadText } from './sec-waf.ts'

export const SEC_DNS_DROP_IN = 'xpanel-cluster.conf'
export const SEC_DNS_VERIFY_ZONE_LIMIT = 200
export interface SecPdnsSettings { launch: string | null; primary: boolean | null; disableAxfr: boolean; allowAxfrIps: string[]; alsoNotify: string[]; includeDir: string | null }
export interface SecDnsClusterObservation {
  observedAt: string
  state: 'read' | 'not_installed' | 'unavailable'
  settings: SecPdnsSettings | null
  /** single_node: no saved peers. applied: every saved peer may transfer and is notified. drift: the running configuration differs. */
  application: 'single_node' | 'applied' | 'drift' | 'unavailable'
  peers: { name: string; address: string; transferAllowed: boolean | null; notified: boolean | null }[]
}
export type SecSoaAnswer = { serial: number } | { error: 'not_served' | 'refused' | 'unreachable' | 'failed' }
export type SecQuerySoa = (server: string, zone: string) => Promise<SecSoaAnswer>
export type SecZoneTransferState = 'in_sync' | 'behind' | 'ahead' | 'not_served' | 'refused' | 'unreachable' | 'local_unavailable'
export interface SecPeerVerification {
  observedAt: string
  peer: SecDnsPeer
  zones: { zone: string; localSerial: number | null; peerSerial: number | null; state: SecZoneTransferState }[]
  counts: Record<SecZoneTransferState, number>
  truncated: boolean
}
export type SecListDir = (path: string) => Promise<string[] | null>

const BOOL = (value: string | undefined): boolean | null => value === undefined ? null : /^(yes|true|on|1)$/i.test(value) ? true : /^(no|false|off|0)$/i.test(value) ? false : null
const listOf = (value: string | undefined): string[] => value === undefined ? [] : value.split(/[\s,]+/).filter(Boolean)
// PowerDNS Authoritative settings: "key=value" lines, '#' comments; files in include-dir are read in name order after the main file, later values win.
export function parseSecPdnsSettings(texts: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (const text of texts) for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const match = /^([a-z][a-z0-9-]{0,63})\s*=\s*(.*)$/.exec(line)
    if (match) values.set(match[1]!, match[2]!.trim())
  }
  return values
}
const settingsOf = (values: Map<string, string>): SecPdnsSettings => ({
  launch: values.get('launch') ?? null,
  // "primary" replaced "master" in 4.5; either name is honoured.
  primary: BOOL(values.get('primary') ?? values.get('master')),
  disableAxfr: BOOL(values.get('disable-axfr')) === true,
  // Documented default when the setting is absent.
  allowAxfrIps: values.has('allow-axfr-ips') ? listOf(values.get('allow-axfr-ips')) : ['127.0.0.0/8', '::1'],
  alsoNotify: listOf(values.get('also-notify')),
  includeDir: values.get('include-dir') || null,
})
const listConf: SecListDir = path => readdir(path).then(names => names, () => null)

export async function readSecPdnsSettings(input: { family: string; readText: SecReadText; listDir?: SecListDir }): Promise<SecPdnsSettings | null | 'absent'> {
  if (input.family !== 'debian' && input.family !== 'rhel') return null
  const main = await input.readText(SEC_PDNS_CONF[input.family])
  if (main === null) return 'absent'
  const base = parseSecPdnsSettings([main]), dir = base.get('include-dir')
  if (!dir) return settingsOf(base)
  if (!posix.isAbsolute(dir) || posix.normalize(dir) !== dir.replace(/\/+$/, '')) return null
  const names = await (input.listDir ?? listConf)(dir)
  if (names === null) return null
  const files = names.filter(name => /^[A-Za-z0-9_.-]{1,64}\.conf$/.test(name)).sort().slice(0, 32)
  const texts = [main]
  for (const name of files) { const text = await input.readText(posix.join(dir, name)); if (text === null) return null; texts.push(text) }
  return settingsOf(parseSecPdnsSettings(texts))
}
const allows = (settings: SecPdnsSettings, address: string): boolean => !settings.disableAxfr && settings.allowAxfrIps.some(entry => entry === address || entry === address + (address.includes(':') ? '/128' : '/32'))
const notifies = (settings: SecPdnsSettings, address: string): boolean => settings.alsoNotify.some(entry => entry === address || entry === (address.includes(':') ? `[${address}]:53` : `${address}:53`))

export async function observeSecDnsCluster(input: { family: string; peers: readonly SecDnsPeer[]; readText: SecReadText; listDir?: SecListDir; now?: () => Date }): Promise<SecDnsClusterObservation> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const settings = await readSecPdnsSettings(input).catch(() => null)
  if (settings === 'absent') return { observedAt, state: 'not_installed', settings: null, application: 'unavailable', peers: input.peers.map(peer => ({ ...peer, transferAllowed: null, notified: null })) }
  if (!settings) return { observedAt, state: 'unavailable', settings: null, application: 'unavailable', peers: input.peers.map(peer => ({ ...peer, transferAllowed: null, notified: null })) }
  const peers = input.peers.map(peer => ({ ...peer, transferAllowed: allows(settings, peer.address), notified: notifies(settings, peer.address) }))
  const application = !peers.length ? 'single_node' : settings.primary === true && peers.every(peer => peer.transferAllowed && peer.notified) ? 'applied' : 'drift'
  return { observedAt, state: 'read', settings, application, peers }
}

/** RFC 1982 serial arithmetic: is a strictly behind b? */
const behind = (a: number, b: number): boolean => a !== b && ((a < b && b - a < 2 ** 31) || (a > b && a - b > 2 ** 31))
export const secQuerySoa: SecQuerySoa = async (server, zone) => {
  // shortcut: c-ares does not expose the AA flag, so a recursive peer answer is not distinguished; upgrade to dig +norec during native qualification.
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  resolver.setServers([server])
  try { const soa = await resolver.resolveSoa(zone); return Number.isSafeInteger(soa.serial) ? { serial: soa.serial } : { error: 'failed' } }
  catch (error) {
    const code = (error as { code?: string }).code
    return { error: code === 'ENOTFOUND' || code === 'ENODATA' ? 'not_served' : code === 'EREFUSED' ? 'refused' : code === 'ETIMEOUT' || code === 'ECONNREFUSED' ? 'unreachable' : 'failed' }
  }
}

/** Compares the SOA serial this server publishes with what the peer answers, zone by zone (bounded, at most 8 queries in flight). */
export async function verifySecDnsPeer(input: { peer: SecDnsPeer; zones: readonly string[]; query?: SecQuerySoa; localServer?: string; now?: () => Date }): Promise<SecPeerVerification> {
  const query = input.query ?? secQuerySoa, local = input.localServer ?? '127.0.0.1'
  const zones = [...new Set(input.zones)].sort().slice(0, SEC_DNS_VERIFY_ZONE_LIMIT), rows: SecPeerVerification['zones'] = new Array(zones.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < zones.length) {
      const index = next++, zone = zones[index]!
      const [mine, theirs] = await Promise.all([query(local, zone).catch((): SecSoaAnswer => ({ error: 'failed' })), query(input.peer.address, zone).catch((): SecSoaAnswer => ({ error: 'failed' }))])
      const localSerial = 'serial' in mine ? mine.serial : null, peerSerial = 'serial' in theirs ? theirs.serial : null
      const state: SecZoneTransferState = localSerial === null ? 'local_unavailable' : peerSerial === null ? ('error' in theirs && theirs.error !== 'failed' ? theirs.error : 'unreachable')
        : peerSerial === localSerial ? 'in_sync' : behind(peerSerial, localSerial) ? 'behind' : 'ahead'
      rows[index] = { zone, localSerial, peerSerial, state }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, zones.length) }, worker))
  const counts = { in_sync: 0, behind: 0, ahead: 0, not_served: 0, refused: 0, unreachable: 0, local_unavailable: 0 }
  for (const row of rows) counts[row.state]++
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), peer: { ...input.peer }, zones: rows, counts, truncated: new Set(input.zones).size > zones.length }
}

/** pdns.conf drop-in: send NOTIFY for changed serials and admit AXFR only from loopback and the saved peers. */
export function renderSecDnsClusterDropIn(peers: readonly SecDnsPeer[]): string {
  const addresses = peers.map(peer => peer.address)
  return ['# Managed by xPanel: DNS cluster peers. Manual edits are replaced on the next apply.', `primary=${addresses.length ? 'yes' : 'no'}`,
    `allow-axfr-ips=${['127.0.0.0/8', '::1', ...addresses].join(',')}`, ...(addresses.length ? [`also-notify=${addresses.join(',')}`] : []), ''].join('\n')
}

export interface SecDnsApplyPorts {
  family: string
  powerdnsUnit: string
  readText: SecReadText
  listDir?: SecListDir
  writeFile: (file: RenderedFile) => Promise<void>
  removePath: (path: string) => Promise<void>
  runAction: (action: HostAction) => Promise<void>
  /** proves the restarted server answers for a hosted zone; null when nothing is hosted */
  probe: () => Promise<boolean | null>
  authorize: () => Promise<void>
}
export interface SecDnsApplyResult { outcome: 'applied' | 'unchanged'; observation: SecDnsClusterObservation }

/** Writes only our drop-in in the configured include-dir, restarts PowerDNS and re-reads the running settings; any unproven effect is rolled back. */
export async function applySecDnsCluster(peers: readonly SecDnsPeer[], ports: SecDnsApplyPorts): Promise<SecDnsApplyResult> {
  const blocked = (message: string, reason: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false, reason })
  const settings = await readSecPdnsSettings(ports).catch(() => null)
  if (!settings || settings === 'absent') return blocked('PowerDNS settings could not be read', 'powerdns_unreadable')
  if (!settings.includeDir) return blocked('pdns.conf has no include-dir, so a managed drop-in would not be read', 'include_dir_missing')
  const path = posix.join(settings.includeDir, SEC_DNS_DROP_IN)
  if (!path.startsWith('/etc/powerdns/')) return blocked('the include-dir is outside the reviewed PowerDNS configuration path', 'include_dir_not_admitted')
  const previous = await ports.readText(path), content = renderSecDnsClusterDropIn(peers)
  const observe = () => observeSecDnsCluster({ family: ports.family, peers, readText: ports.readText, ...(ports.listDir ? { listDir: ports.listDir } : {}) })
  if (previous === content) return { outcome: 'unchanged', observation: await observe() }
  await ports.authorize()
  try {
    await ports.writeFile({ path, content, mode: 0o644, owner: 'root', group: 'root' })
    await ports.runAction({ kind: 'systemd', verb: 'restart', unit: ports.powerdnsUnit })
    const observation = await observe()
    const expected = peers.length ? observation.application === 'applied' : observation.application === 'single_node' && observation.settings?.primary === false
    if (!expected || await ports.probe() === false) throw new Error('cluster_apply_unverified')
    return { outcome: 'applied', observation }
  } catch {
    let restored = false
    try {
      if (previous === null) await ports.removePath(path); else await ports.writeFile({ path, content: previous, mode: 0o644, owner: 'root', group: 'root' })
      await ports.runAction({ kind: 'systemd', verb: 'restart', unit: ports.powerdnsUnit })
      restored = (await ports.readText(path)) === previous && await ports.probe() !== false
    } catch { restored = false }
    return fail('SERVICE_UNAVAILABLE', restored ? 'the cluster settings were not confirmed and the previous PowerDNS configuration was restored' : 'the PowerDNS configuration outcome is unknown and requires review',
      { stateChanged: !restored, rolledBack: restored, verificationRequired: !restored, unknownOutcome: !restored })
  }
}
