import { fail, msgid } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { isPearCommand, isPearPackageName, pearArgv, pearCommandPath, pearLibraryDir, pearPackageName } from '../../../packages/os/src/pear-command.ts'
import { isSoftwareCenterCommand, softwareCenterArgv } from '../../../packages/os/src/software-center-command.ts'
import type { HostJobPlan } from './host-job-contract.ts'

export const PEAR_JOB_KIND = 'php.pear.package'
const unchanged = { stateChanged: false }
export interface PearPackageRow { name: string; version: string; state: string }
export interface PearSearchRow { name: string; version: string; summary: string }
export interface PearView { version: string; state: 'read' | 'not_installed' | 'unavailable'; reason: string | null; library: string; requiredPackage: string; packages: PearPackageRow[] }
type Family = 'debian' | 'rhel'
export interface PearHost { family: Family; phpBinary: (version: string) => string; present: (path: string, kind: 'file' | 'directory') => Promise<boolean | null>; run: (argv: string[]) => Promise<{ ok: boolean; stdout: string }> }

const supported = (version: unknown): version is string => typeof version === 'string' && (SUPPORTED_PHP_VERSIONS as readonly string[]).includes(version)
export const assertPearVersion = (version: unknown): string => supported(version) ? version : fail('VALIDATION', 'a supported PHP version is required', unchanged)

/** `pear list`: "Package Version State" rows below the channel header; "(no packages installed...)" means an empty library. */
export function parsePearList(stdout: string): PearPackageRow[] {
  const rows: PearPackageRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,63})\s+([0-9][0-9A-Za-z.]{0,31})\s+(stable|beta|alpha|devel|snapshot)\s*$/.exec(line)
    if (match) rows.push({ name: match[1]!, version: match[2]!, state: match[3]! })
  }
  return rows
}
/** `pear search`: "Name  1.2.3 (stable)  summary" rows; the versionless rows of retired packages are left out because they cannot be installed. */
export function parsePearSearch(stdout: string): PearSearchRow[] {
  const rows: PearSearchRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,63})\s+([0-9][0-9A-Za-z.]{0,31}) \((?:stable|beta|alpha|devel|snapshot)\)\s*(.{0,200})$/.exec(line)
    if (match) rows.push({ name: match[1]!, version: match[2]!, summary: match[3]!.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() })
  }
  return rows.slice(0, 100)
}

export async function observePear(host: PearHost, version: string): Promise<PearView> {
  const library = pearLibraryDir(version), requiredPackage = pearPackageName(host.family, version), base = { version, library, requiredPackage }
  const pearcmd = pearCommandPath(host.family, version), php = host.phpBinary(version)
  if (await host.present(pearcmd, 'file') !== true || await host.present(php, 'file') !== true) return { ...base, state: 'not_installed', reason: 'pear_not_installed', packages: [] }
  const result = await host.run(pearArgv(php, pearcmd, version, 'list')).catch(() => null)
  if (!result?.ok) return { ...base, state: 'unavailable', reason: 'pear_list_failed', packages: [] }
  return { ...base, state: 'read', reason: null, packages: parsePearList(result.stdout) }
}

export async function searchPear(host: PearHost, version: string, name: unknown): Promise<PearSearchRow[]> {
  if (!isPearPackageName(name)) return fail('VALIDATION', 'a package name is required', unchanged)
  const pearcmd = pearCommandPath(host.family, version)
  if (await host.present(pearcmd, 'file') !== true) return fail('PRECONDITION_FAILED', 'PEAR is not installed for this PHP version', { ...unchanged, reason: 'pear_not_installed' })
  const result = await host.run(pearArgv(host.phpBinary(version), pearcmd, version, 'search', name)).catch(() => null)
  return result?.ok ? parsePearSearch(result.stdout) : fail('SERVICE_UNAVAILABLE', 'the PEAR channel could not be searched', { ...unchanged, reason: 'pear_search_failed' })
}

/** The distribution package that provides pearcmd.php; it succeeds only when that file is there afterwards. */
export function buildPearSetupPlan(host: Pick<PearHost, 'family' | 'present'>, version: string): HostJobPlan {
  const name = pearPackageName(host.family, version), pearcmd = pearCommandPath(host.family, version)
  return {
    kind: PEAR_JOB_KIND + '.setup', summary: `Install PEAR for PHP ${version}`, accountId: null, fingerprint: { version, name }, detail: { version, name },
    steps: [{ id: 'install', title: msgid('Install PEAR for this PHP version'), argv: softwareCenterArgv(host.family === 'debian' ? 'apt-install' : 'dnf-install', [name]), timeoutMs: 600_000, mutates: true }],
    policy: isSoftwareCenterCommand,
    verify: async () => ({ ok: await host.present(pearcmd, 'file') === true, detail: { pearcmd } }),
  }
}

export function buildPearPlan(host: Pick<PearHost, 'family' | 'phpBinary'>, input: { version: string; operation: 'install' | 'upgrade' | 'uninstall'; name: string }): HostJobPlan {
  const { version, operation, name } = input
  if (!isPearPackageName(name)) return fail('VALIDATION', 'a package name is required', unchanged)
  const argv = pearArgv(host.phpBinary(version), pearCommandPath(host.family, version), version, operation, name)
  return {
    kind: PEAR_JOB_KIND, summary: `PEAR ${operation} ${name} for PHP ${version}`, accountId: null, fingerprint: { version, operation, name }, detail: { version, operation, name },
    steps: [{ id: 'pear', title: msgid('Change the PEAR package for this PHP version'), argv, timeoutMs: 300_000, mutates: true }],
    policy: isPearCommand,
  }
}
