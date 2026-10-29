import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { PHP_DPKG_QUERY_ARGV, PHP_RPM_QUERY_ARGV, isPhpInventoryProbeVersion, phpBinaryProbeArgv } from '../../../packages/os/src/php-inventory-command.ts'
export { PHP_BINARY_PROBE, PHP_DPKG_QUERY_ARGV, PHP_RPM_QUERY_ARGV, phpBinaryProbeArgv } from '../../../packages/os/src/php-inventory-command.ts'

export interface PhpInventoryCommandResult { ok: boolean; stdout: string; stderr: string }
export type PhpInventoryRun = (argv: string[]) => Promise<PhpInventoryCommandResult>
// -n is deliberate: a root inventory probe must not load a tenant-influenced php.ini,
// auto-prepend file, or configured extension. This is a binary probe, not an FPM request.
const MAX_PACKAGE_OUTPUT = 2 * 1024 * 1024
const MAX_PACKAGE_LINES = 20000
const MAX_BINARY_OUTPUT = 32768
const supported = new Set<string>(SUPPORTED_PHP_VERSIONS)

export interface PhpInstalledPackage { name: string; version: string; component: string }
export type PhpBinaryObservation = {
  state: 'read'; scope: 'cli-without-ini'; version: string; sapi: 'cli'; builtInExtensions: string[]
} | { state: 'unavailable'; scope: 'cli-without-ini'; reason: 'unsupported-version' | 'binary-unavailable' | 'invalid-binary-observation' }
export interface PhpInventoryVersion {
  version: string
  supported: boolean
  packages: PhpInstalledPackage[]
  binary: PhpBinaryObservation
  extensionEnablement: 'not-read'
  fpmRequest: 'not-read'
}
export interface PhpRuntimeInventory {
  state: 'read' | 'unavailable'
  source: 'dpkg' | 'rpm' | null
  observedAt: string
  versions: PhpInventoryVersion[]
  reason?: 'package-inventory-unavailable' | 'invalid-package-inventory'
  capabilities: { packageWrite: false; defaultWrite: false; iniWrite: false; extensionWrite: false; functionPolicyWrite: false }
}

const immutableCapabilities = (): PhpRuntimeInventory['capabilities'] => ({ packageWrite: false, defaultWrite: false, iniWrite: false, extensionWrite: false, functionPolicyWrite: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const command = async (run: PhpInventoryRun, argv: readonly string[]): Promise<PhpInventoryCommandResult> => {
  try { return await run([...argv]) } catch { return { ok: false, stdout: '', stderr: '' } }
}

/** Parses package database observations; desired account/domain versions are never inputs. */
export function parsePhpPackages(stdout: string, source: 'dpkg' | 'rpm'): Map<string, PhpInstalledPackage[]> {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_PACKAGE_OUTPUT || /[\u0000\r]/.test(stdout)) throw new Error('invalid_package_inventory')
  const lines = stdout.split('\n').filter(Boolean)
  if (lines.length > MAX_PACKAGE_LINES) throw new Error('invalid_package_inventory')
  const versions = new Map<string, PhpInstalledPackage[]>()
  const seen = new Set<string>()
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length !== 3) throw new Error('invalid_package_inventory')
    const [rawName, packageVersion, status] = parts as [string, string, string]
    if (!/^[a-zA-Z0-9][a-zA-Z0-9+_.:-]{0,127}$/.test(rawName) || !/^[^\s\u0000-\u001f\u007f]{1,256}$/.test(packageVersion) || status.length > 80 || /[\u0000-\u001f\u007f]/.test(status)) throw new Error('invalid_package_inventory')
    if (source === 'dpkg' ? status !== 'install ok installed' : status !== 'installed') continue
    const name = rawName.replace(/:[a-z0-9_-]+$/, '')
    const debian = /^php([5-9]\.[0-9]{1,2})(?:-([a-z0-9][a-z0-9-]{0,63}))?$/.exec(name)
    const remi = /^php([5-9])([0-9]{1,2})-php(?:-([a-z0-9][a-z0-9-]{0,63}))?$/.exec(name)
    const lsphp = /^lsphp([5-9])([0-9]{1,2})(?:-([a-z0-9][a-z0-9-]{0,63}))?$/.exec(name)
    const system = /^php(?:-([a-z0-9][a-z0-9-]{0,63}))?$/.exec(name)
    const systemVersion = system ? /^(?:[0-9]+:)?([5-9]\.[0-9]{1,2})\.[0-9]/.exec(packageVersion)?.[1] : undefined
    if (!debian && !remi && !lsphp && !systemVersion) continue
    const version = debian?.[1] ?? (remi ? remi[1] + '.' + remi[2] : lsphp ? lsphp[1] + '.' + lsphp[2] : systemVersion!)
    const component = debian ? debian[2] ?? 'runtime' : remi ? remi[3] ?? 'runtime' : lsphp ? lsphp[3] ?? 'runtime' : system![1] ?? 'runtime'
    const key = version + '\0' + rawName
    if (seen.has(key)) throw new Error('duplicate_package_inventory')
    seen.add(key)
    const packages = versions.get(version) ?? []
    packages.push({ name: rawName, version: packageVersion, component })
    versions.set(version, packages)
    if (versions.size > 32 || packages.length > 256) throw new Error('package_inventory_capacity')
  }
  for (const packages of versions.values()) packages.sort((left, right) => left.name.localeCompare(right.name))
  return versions
}

export function parsePhpBinaryObservation(stdout: string, version: string): PhpBinaryObservation {
  try {
    if (Buffer.byteLength(stdout) > MAX_BINARY_OUTPUT) throw new Error('invalid_php_probe')
    const value: unknown = JSON.parse(stdout)
    if (!object(value) || typeof value.version !== 'string' || !/^[5-9]\.[0-9]{1,2}\.[0-9]{1,3}(?:[-+.a-zA-Z0-9_]{0,64})$/.test(value.version) || !value.version.startsWith(version + '.') || value.sapi !== 'cli' || !Array.isArray(value.builtInExtensions) || value.builtInExtensions.length > 256) throw new Error('invalid_php_probe')
    const extensions = value.builtInExtensions.map(item => {
      if (typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_ -]{0,63}$/.test(item) || item.trim() !== item) throw new Error('invalid_php_probe')
      return item
    })
    if (new Set(extensions.map(item => item.toLowerCase())).size !== extensions.length) throw new Error('duplicate_php_probe_extension')
    return { state: 'read', scope: 'cli-without-ini', version: value.version, sapi: 'cli', builtInExtensions: extensions.sort((left, right) => left.localeCompare(right)) }
  } catch { return { state: 'unavailable', scope: 'cli-without-ini', reason: 'invalid-binary-observation' } }
}

/** Fixed, read-only package and no-INI binary probes. No package/configuration writes occur. */
export async function readPhpRuntimeInventory(run: PhpInventoryRun, source: 'dpkg' | 'rpm', now: () => Date = () => new Date()): Promise<PhpRuntimeInventory> {
  const observedAt = now().toISOString()
  if (!['dpkg', 'rpm'].includes(source)) return { state: 'unavailable', source: null, observedAt, versions: [], reason: 'package-inventory-unavailable', capabilities: immutableCapabilities() }
  const result = await command(run, source === 'dpkg' ? PHP_DPKG_QUERY_ARGV : PHP_RPM_QUERY_ARGV)
  if (!result.ok) return { state: 'unavailable', source: null, observedAt, versions: [], reason: 'package-inventory-unavailable', capabilities: immutableCapabilities() }
  let packages: Map<string, PhpInstalledPackage[]>
  try { packages = parsePhpPackages(result.stdout, source) }
  catch { return { state: 'unavailable', source, observedAt, versions: [], reason: 'invalid-package-inventory', capabilities: immutableCapabilities() } }
  const versions = await Promise.all([...packages].sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true })).map(async ([version, entries]): Promise<PhpInventoryVersion> => {
    let binary: PhpBinaryObservation = { state: 'unavailable', scope: 'cli-without-ini', reason: 'unsupported-version' }
    if (supported.has(version) && isPhpInventoryProbeVersion(version)) {
      const systemPackage = entries.some(entry => /^php(?:-(?:cli|fpm|common))?(?::[a-z0-9_-]+)?$/.test(entry.name)) && !entries.some(entry => /^php[5-9][0-9]{1,2}-php/.test(entry.name))
      const probe = await command(run, phpBinaryProbeArgv(version, source, systemPackage))
      binary = probe.ok ? parsePhpBinaryObservation(probe.stdout, version) : { state: 'unavailable', scope: 'cli-without-ini', reason: 'binary-unavailable' }
    }
    return { version, supported: supported.has(version), packages: entries, binary, extensionEnablement: 'not-read', fpmRequest: 'not-read' }
  }))
  return { state: 'read', source, observedAt, versions, capabilities: immutableCapabilities() }
}
