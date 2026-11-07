import { canonicalIp } from '@xpanel/core'
import type { HostAction, RenderedFile, ServerIpEntry } from '@xpanel/core'
import type { StateSnapshot } from '@xpanel/state'
import type { ServerInterface } from './server-observation.ts'

/**
 * Pool addresses bound as interface aliases (cPanel "Add a New IP Address"). A oneshot unit binds them again at boot;
 * the reconcile binds and unbinds them at once with `ip addr`. Only addresses this unit added are ever removed: the
 * default address and any address the host configured itself are never touched, nor an interface the host did not report.
 */
export const IP_ALIASES_UNIT = 'xpanel-ip-aliases.service'
export const IP_ALIASES_UNIT_PATH = `/etc/systemd/system/${IP_ALIASES_UNIT}`
const IP = '/usr/sbin/ip'
const IFNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/

export interface IpAlias { address: string; prefixLength: number; interfaceName: string }
export type IpAliasSkip = 'interface_unreported' | 'host_configured' | 'host_unobserved'

const key = (alias: IpAlias): string => `${alias.address}/${alias.prefixLength} ${alias.interfaceName}`
const argv = (verb: 'replace' | 'del', alias: IpAlias): string[] => [IP, 'addr', verb, `${alias.address}/${alias.prefixLength}`, 'dev', alias.interfaceName]

/** Reviewed grammar: ip addr replace|del <canonical address>/<prefix> dev <interface>, nothing else. */
export function isIpAliasCommand(command: readonly string[]): boolean {
  if (command.length !== 6 || command[0] !== IP || command[1] !== 'addr' || (command[2] !== 'replace' && command[2] !== 'del') || command[4] !== 'dev' || !IFNAME.test(command[5] ?? '')) return false
  const [address, prefix, ...rest] = (command[3] ?? '').split('/')
  if (rest.length || address === undefined || prefix === undefined || !/^[1-9][0-9]{0,2}$/.test(prefix)) return false
  try {
    const ip = canonicalIp(address)
    return ip.address === address && Number(prefix) <= (ip.version === 4 ? 32 : 128)
  } catch { return false }
}

/** The aliases a previous generation bound, read back from its unit; lines outside the grammar are not ours. */
export function parseManagedAliases(unit: string | null): IpAlias[] {
  if (unit === null) return []
  return unit.split('\n').flatMap(line => {
    if (!line.startsWith('ExecStart=')) return []
    const command = line.slice('ExecStart='.length).trim().split(' ')
    if (!isIpAliasCommand(command) || command[2] !== 'replace') return []
    const [address, prefix] = command[3]!.split('/')
    return [{ address: address!, prefixLength: Number(prefix), interfaceName: command[5]! }]
  })
}

export function renderIpAliasesUnit(aliases: readonly IpAlias[]): RenderedFile {
  return {
    path: IP_ALIASES_UNIT_PATH,
    content: ['# Managed by xPanel: IP pool aliases, bound again at boot', '[Unit]', 'Description=xPanel IP pool aliases', 'Wants=network-online.target', 'After=network-online.target', '',
      '[Service]', 'Type=oneshot', 'RemainAfterExit=yes', ...aliases.map(alias => `ExecStart=${argv('replace', alias).join(' ')}`), '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n'),
    mode: 0o644, owner: 'root', group: 'root',
  }
}

/**
 * Aliases for the pool, given the observed interfaces (null when they could not be read: nothing then changes) and the
 * aliases the live unit names. Returns the unit to render (null when none is managed), the immediate `ip addr` actions
 * and the entries left alone with the reason.
 */
export function planIpAliases(pool: readonly ServerIpEntry[], interfaces: readonly ServerInterface[] | null, managed: readonly IpAlias[]):
  { file: RenderedFile | null; actions: HostAction[]; skipped: { address: string; reason: IpAliasSkip }[] } {
  const keep = (aliases: readonly IpAlias[]): HostAction[] => aliases.length ? [{ kind: 'systemd-daemon-reload' }, { kind: 'systemd', verb: 'enable', unit: IP_ALIASES_UNIT }] : []
  if (interfaces === null) {
    return { file: managed.length ? renderIpAliasesUnit(managed) : null, actions: keep(managed), skipped: pool.filter(entry => !entry.isPrimary).map(entry => ({ address: entry.address, reason: 'host_unobserved' as const })) }
  }
  const reported = new Map(interfaces.filter(item => !item.loopback).map(item => [item.name, item]))
  const bound = (alias: IpAlias, anywhere = false): boolean => interfaces.some(item => (anywhere || item.name === alias.interfaceName)
    && item.addresses.some(address => canonicalIp(address.address).address === alias.address && (anywhere || address.prefixLength === alias.prefixLength)))
  const managedKeys = new Set(managed.map(key))
  const desired: IpAlias[] = [], skipped: { address: string; reason: IpAliasSkip }[] = []
  for (const entry of pool) {
    const alias = { address: entry.address, prefixLength: entry.prefixLength, interfaceName: entry.interfaceName }
    const ours = managedKeys.has(key(alias))
    if (!reported.has(alias.interfaceName)) { skipped.push({ address: alias.address, reason: 'interface_unreported' }); continue }
    if (!ours && (entry.isPrimary || bound(alias, true))) { if (!entry.isPrimary) skipped.push({ address: alias.address, reason: 'host_configured' }); continue }
    desired.push(alias)
  }
  const desiredKeys = new Set(desired.map(key)), primaries = new Set(pool.filter(entry => entry.isPrimary).map(entry => entry.address))
  const add = desired.filter(alias => !bound(alias))
  const remove = managed.filter(alias => !desiredKeys.has(key(alias)) && reported.has(alias.interfaceName) && bound(alias) && !primaries.has(alias.address))
  desired.sort((a, b) => key(a).localeCompare(key(b)))
  return {
    file: desired.length ? renderIpAliasesUnit(desired) : null,
    actions: [...add.map((alias): HostAction => ({ kind: 'exec', argv: argv('replace', alias) })), ...remove.map((alias): HostAction => ({ kind: 'exec', argv: argv('del', alias) })), ...keep(desired)],
    skipped,
  }
}

/**
 * Release holds a verified generation of `snapshot` makes safe to clear: that generation serves none of the account's
 * sites on the held address (the account is gone, terminating or on other addresses) and every address the account
 * uses now is bound on the host.
 */
export function releasableHolds(pool: readonly ServerIpEntry[], snapshot: Pick<StateSnapshot, 'accounts'>, bound: ReadonlySet<string>): { id: string; since: string }[] {
  return pool.flatMap(entry => {
    if (!entry.releasing) return []
    const account = snapshot.accounts.find(item => item.id === entry.releasing!.accountId)
    if (account && account.status !== 'terminating') {
      const uses = [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].filter((raw): raw is string => raw != null).map(raw => canonicalIp(raw).address)
      if (uses.includes(entry.address) || uses.some(address => !bound.has(address))) return []
    }
    return [{ id: entry.id, since: entry.releasing.since }]
  })
}
