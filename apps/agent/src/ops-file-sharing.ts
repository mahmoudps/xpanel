import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import { MANAGED_EXPORTS_PATH, NFS_ETAB_PATH } from '../../../packages/os/src/ops-file-sharing-command.ts'

/** Server-level NFS exports held as configuration. One managed file, verified against the kernel export table. */
export type SharePermission = 'ro' | 'rw'
export interface ShareClient { host: string; permission: SharePermission; squashRoot: boolean; subtreeCheck: boolean }
export interface Share { id: string; path: string; clients: ShareClient[] }
export interface ShareConfig { shares: Share[] }

export const MAX_SHARES = 200, MAX_CLIENTS = 64
/** Desired shares live in a config file (cPanel-style); the SQLite index is never authoritative for them. */
export const FILE_SHARING_STATE_PATH = 'extended/file-sharing/shares.json'
const SHARE_ID = /^shr_[0-9a-z]{16}$/
// exports(5): exported directories are absolute real paths. xPanel manages only account homes and a dedicated shares root.
const SHARE_ROOTS = ['/home/', '/srv/shares/']
// exports(5) machine specs this grammar accepts: a single host, an IPv4 CIDR, a wildcard FQDN, or everyone (*). No netgroups, no gss.
const HOSTNAME = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/
const WILDCARD_FQDN = /^\*(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/

const isShareObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const isSharePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 1024 && SHARE_ROOTS.some(root => value.startsWith(root)) && value.length > SHARE_ROOTS.find(root => value.startsWith(root))!.length
  && !value.includes('//') && !value.endsWith('/') && !value.split('/').some(part => part === '.' || part === '..') && !/[\u0000-\u001f\u007f-\u009f\s\\]/.test(value)

const isIpv4Cidr = (value: string): boolean => {
  const match = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/.exec(value)
  if (!match) return false
  const prefix = Number(match[2]), octets = match[1]!.split('.').map(Number)
  return prefix <= 32 && octets.every(octet => octet <= 255)
}
export const isShareHost = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 255 && (value === '*' || isIpv4Cidr(value) || (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ? value.split('.').every(octet => Number(octet) <= 255) : HOSTNAME.test(value) || WILDCARD_FQDN.test(value)))

/** Strict share-config parser shared by the API request validator and the agent renderer. */
export function parseShareConfig(value: unknown): ShareConfig {
  if (!isShareObject(value) || Object.keys(value).join() !== 'shares' || !Array.isArray(value.shares) || value.shares.length > MAX_SHARES) return fail('VALIDATION', 'a bounded list of shares is required', { stateChanged: false })
  const ids = new Set<string>(), paths = new Set<string>()
  const shares = value.shares.map(raw => {
    if (!isShareObject(raw) || Object.keys(raw).sort().join() !== 'clients,id,path' || typeof raw.id !== 'string' || !SHARE_ID.test(raw.id) || ids.has(raw.id) || !isSharePath(raw.path) || paths.has(raw.path)
      || !Array.isArray(raw.clients) || raw.clients.length < 1 || raw.clients.length > MAX_CLIENTS) return fail('VALIDATION', 'each share needs an id, a managed path and 1 to 64 clients', { stateChanged: false })
    ids.add(raw.id); paths.add(raw.path)
    const hosts = new Set<string>()
    const clients = raw.clients.map(client => {
      if (!isShareObject(client) || Object.keys(client).sort().join() !== 'host,permission,squashRoot,subtreeCheck' || !isShareHost(client.host) || hosts.has(client.host)
        || (client.permission !== 'ro' && client.permission !== 'rw') || typeof client.squashRoot !== 'boolean' || typeof client.subtreeCheck !== 'boolean') return fail('VALIDATION', 'each client needs a host, permission and squash/subtree options', { stateChanged: false })
      hosts.add(client.host)
      return { host: client.host, permission: client.permission as SharePermission, squashRoot: client.squashRoot, subtreeCheck: client.subtreeCheck }
    })
    return { id: raw.id, path: raw.path, clients }
  })
  return { shares }
}

export const shareConfigRevision = (config: ShareConfig): string =>
  createHash('sha256').update(JSON.stringify(config.shares.map(share => [share.path, share.clients.map(client => [client.host, client.permission, client.squashRoot, client.subtreeCheck])]).sort((a, b) => a[0]! < b[0]! ? -1 : 1))).digest('hex')

const clientOptions = (client: ShareClient): string =>
  `${client.permission},${client.subtreeCheck ? 'subtree_check' : 'no_subtree_check'},${client.squashRoot ? 'root_squash' : 'no_root_squash'},sync`

/** Canonical exports(5) content for the one managed file. Deterministic order so a re-render never rewrites unchanged policy. */
export function renderManagedExports(config: ShareConfig): string {
  const lines = ['# Managed by xPanel. Do not edit; changes are overwritten.']
  for (const share of [...config.shares].sort((a, b) => a.path < b.path ? -1 : 1)) {
    const specs = [...share.clients].sort((a, b) => a.host < b.host ? -1 : 1).map(client => `${client.host}(${clientOptions(client)})`)
    // exports(5): the directory is quoted so a space in a share root never splits the line.
    lines.push(`"${share.path}" ${specs.join(' ')}`)
  }
  return lines.join('\n') + '\n'
}

export type ShareExportState = 'exported' | 'not-exported' | 'conflict'
export interface ShareObservation {
  state: 'read' | 'unavailable'
  managedPresent: boolean
  shares: (Share & { exportState: ShareExportState })[]
  /** Paths in the kernel export table that this server did not configure (e.g. admin's /etc/exports). */
  foreignExports: string[]
  reason: string | null
}

/** /var/lib/nfs/etab: tab-like lines "dir\tclient(options)"; the first field is the exported directory. */
export function parseEtabPaths(text: string): Set<string> {
  const paths = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const path = line.startsWith('"') ? line.slice(1, line.indexOf('"', 1)) : line.split(/\s+/)[0]
    if (path && path.startsWith('/')) paths.add(path)
  }
  return paths
}

export interface FileSharingNativeProvider {
  /** Current managed exports file, or null when absent. */
  readManaged(): Promise<string | null>
  /** /var/lib/nfs/etab contents, or null when the NFS server is not present. */
  readEtab(): Promise<string | null>
  /** Atomically replace only the managed file with content. beforeCommit re-checks authority immediately before the rename. */
  writeManaged(content: string, beforeCommit: () => Promise<void>): Promise<void>
  /** Remove the managed file (an empty configuration unexports every managed share). */
  removeManaged(): Promise<void>
  /** exportfs(8) -ra; rejects when re-export reports an error so a bad table is never treated as applied. */
  reexport(): Promise<boolean>
}

/** Read-only truthful observation: the kernel export table decides which configured shares are actually active. */
export async function observeFileSharing(config: ShareConfig, provider: FileSharingNativeProvider | null): Promise<ShareObservation> {
  if (!provider) return { state: 'unavailable', managedPresent: false, shares: [], foreignExports: [], reason: 'nfs_server_unavailable' }
  let managed: string | null, etab: string | null
  try { managed = await provider.readManaged(); etab = await provider.readEtab() } catch { return { state: 'unavailable', managedPresent: false, shares: [], foreignExports: [], reason: 'nfs_observation_unverified' } }
  if (etab === null) return { state: 'unavailable', managedPresent: managed !== null, shares: [], foreignExports: [], reason: 'nfs_server_unavailable' }
  const exported = parseEtabPaths(etab), expected = renderManagedExports(config), configuredPaths = new Set(config.shares.map(share => share.path))
  const shares = config.shares.map(share => ({ ...share, exportState: (exported.has(share.path) ? (managed === expected ? 'exported' : 'conflict') : 'not-exported') as ShareExportState }))
  const foreignExports = [...exported].filter(path => !configuredPaths.has(path)).sort()
  return { state: 'read', managedPresent: managed !== null, shares, foreignExports, reason: null }
}

/** Every configured path is exported and nothing managed lingers; the managed file matches the rendered policy exactly. */
function verifyApplied(config: ShareConfig, managed: string | null, etab: string | null): boolean {
  if (etab === null) return false
  const expected = config.shares.length ? renderManagedExports(config) : null
  if (managed !== expected) return false
  const exported = parseEtabPaths(etab)
  return config.shares.every(share => exported.has(share.path))
}

export interface FileSharingApplyResult { active: ShareObservation; appliedRevision: string }

/**
 * Writes the one managed exports file and re-exports, verifying the kernel table, or restores the exact preimage.
 * A failed re-export whose rollback cannot be verified is an unknown outcome, never a silent partial export.
 */
export async function applyFileSharingConfig(config: ShareConfig, expectedActiveRevision: string, provider: FileSharingNativeProvider | null, authorize: () => Promise<void>): Promise<FileSharingApplyResult> {
  if (!provider) return fail('PRECONDITION_FAILED', 'the NFS server is unavailable; saved shares have not changed active exports', { stateChanged: false })
  await authorize()
  const beforeManaged = await provider.readManaged(), beforeEtab = await provider.readEtab()
  if (beforeEtab === null) return fail('PRECONDITION_FAILED', 'the NFS export table could not be read; nothing was changed', { stateChanged: false })
  const beforeConfig = parseManagedExports(beforeManaged)
  if (shareConfigRevision(beforeConfig) !== expectedActiveRevision) return fail('CONFLICT', 'active exports changed; reload before applying', { stateChanged: false })
  const rendered = config.shares.length ? renderManagedExports(config) : null
  if (beforeManaged === rendered && verifyApplied(config, beforeManaged, beforeEtab)) return { active: await observeFileSharing(config, provider), appliedRevision: shareConfigRevision(config) }
  let attempted = false
  try {
    await authorize()
    if (rendered === null) await provider.removeManaged()
    else await provider.writeManaged(rendered, async () => { await authorize(); attempted = true })
    attempted = true
    if (!await provider.reexport()) throw new Error('reexport_failed')
    await authorize()
    const managed = await provider.readManaged(), etab = await provider.readEtab()
    if (!verifyApplied(config, managed, etab)) throw new Error('export_unverified')
    return { active: await observeFileSharing(config, provider), appliedRevision: shareConfigRevision(config) }
  } catch (error) {
    if (!attempted) throw error
    let restored = false
    try {
      if (beforeManaged === null) await provider.removeManaged(); else await provider.writeManaged(beforeManaged, async () => { await authorize() })
      restored = await provider.reexport() && verifyApplied(beforeConfig, await provider.readManaged(), await provider.readEtab())
    } catch { restored = false }
    return fail('SERVICE_UNAVAILABLE', restored ? 'the export change failed and the previous exports were restored' : 'the export outcome is unknown; review NFS exports before retrying', { stateChanged: !restored, attempted: true, rolledBack: restored, verificationRequired: !restored, unknownOutcome: !restored })
  }
}

const OPTIONS_LINE = /^"([^"]+)"\s+(.+)$/
const CLIENT_SPEC = /^(\S+?)\(([a-z_,]+)\)$/
/** Parses a managed file this module wrote back into its policy, so the active revision never depends on the desired input.
 * Any line that is not in the canonical shape makes the whole file an empty, non-matching policy (apply refuses on CONFLICT). */
export function parseManagedExports(managed: string | null): ShareConfig {
  if (managed === null) return { shares: [] }
  const shares: Share[] = []
  let index = 0
  for (const raw of managed.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = OPTIONS_LINE.exec(line)
    if (!match || !isSharePath(match[1])) return { shares: [] }
    const clients: ShareClient[] = []
    for (const spec of match[2]!.split(/\s+/)) {
      const parts = CLIENT_SPEC.exec(spec)
      if (!parts || !isShareHost(parts[1])) return { shares: [] }
      const options = parts[2]!.split(',')
      const permission = options.includes('rw') ? 'rw' : options.includes('ro') ? 'ro' : null
      if (!permission) return { shares: [] }
      clients.push({ host: parts[1]!, permission, squashRoot: options.includes('root_squash'), subtreeCheck: options.includes('subtree_check') })
    }
    if (!clients.length) return { shares: [] }
    shares.push({ id: 'shr_' + (index++).toString().padStart(16, '0'), path: match[1]!, clients })
  }
  return { shares }
}

/** Raw saved-file revision for optimistic concurrency, computed over the stored value as written. */
export const savedShareConfigRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')
