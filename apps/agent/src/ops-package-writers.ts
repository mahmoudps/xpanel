import { readdir, readFile } from 'node:fs/promises'
import { msgid } from '@xpanel/core'
import { DPKG_AUDIT_ARGV, RPMDB_VERIFY_ARGV } from '../../../packages/os/src/repair-command.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobStepRun, HostJobVerification } from './host-job-contract.ts'
import { parseDpkgAudit } from './repair-center.ts'
import type { RepairCommandResult } from './repair-center.ts'

export type PackageSafetyFamily = 'debian' | 'rhel'
export type PackageDatabaseState = 'clean' | 'interrupted' | 'damaged' | 'not-read'
export interface PackageWriter { pid: number; command: string }
export interface PackageSafety { state: 'read' | 'unavailable'; writers: PackageWriter[]; database: PackageDatabaseState }
export type PackageSafetyRefusal = 'package-safety-unverified' | 'competing-package-writer' | 'package-database-not-clean'
export interface PackageSafetyPorts {
  /** Entries of /proc, or null when the process table cannot be listed. */
  listProcesses(): Promise<string[] | null>
  /** proc(5) /proc/[pid]/comm; null when the process exited meanwhile. */
  readComm(pid: string): Promise<string | null>
  run(argv: string[]): Promise<RepairCommandResult>
  selfPid: number
}

/** proc(5): comm is the executable name truncated to TASK_COMM_LEN-1 = 15 bytes ("unattended-upgr").
 * packagekitd idles permanently and takes the package lock only inside a transaction, which apt/dnf readers report as busy. */
export const PACKAGE_WRITER_COMMANDS: Readonly<Record<PackageSafetyFamily, readonly string[]>> = {
  debian: ['apt', 'apt-get', 'aptitude', 'dpkg', 'unattended-upgr', 'apt-check'],
  rhel: ['dnf', 'dnf-3', 'dnf5', 'yum', 'rpm', 'microdnf', 'dnf-automatic'],
}
const MAX_PROCESSES = 65_536
const DATABASE_COMMANDS: readonly (readonly string[])[] = [DPKG_AUDIT_ARGV, RPMDB_VERIFY_ARGV]
export const isPackageSafetyCommand = (argv: readonly unknown[]): boolean => Array.isArray(argv) && DATABASE_COMMANDS.some(expected => expected.length === argv.length && expected.every((value, index) => value === argv[index]))

const unavailable = (): PackageSafety => ({ state: 'unavailable', writers: [], database: 'not-read' })

/** dpkg(1) --audit (empty = consistent) and rpmdb(8) --verifydb (exit 0, no output = intact). Anything else is not-read. */
export function classifyPackageDatabase(family: PackageSafetyFamily, result: RepairCommandResult | null): PackageDatabaseState {
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.timedOut) return 'not-read'
  if (family === 'debian') {
    const parsed = parseDpkgAudit(result)
    return parsed.state === 'ok' ? 'clean' : parsed.state === 'problem' ? 'interrupted' : 'not-read'
  }
  if (result.ok && result.code === 0 && !result.stdout.trim() && !result.stderr.trim()) return 'clean'
  return !result.ok && /database disk image is malformed|DB_RUNRECOVERY|database corruption/i.test(result.stdout + '\n' + result.stderr) ? 'damaged' : 'not-read'
}

/** Read-only: competing package-manager processes outside the agent, plus the package database consistency check. */
export async function observePackageSafety(family: PackageSafetyFamily, ports: PackageSafetyPorts): Promise<PackageSafety> {
  if (family !== 'debian' && family !== 'rhel') return unavailable()
  let entries: string[] | null
  try { entries = await ports.listProcesses() } catch { return unavailable() }
  if (!Array.isArray(entries) || entries.length > MAX_PROCESSES) return unavailable()
  const names = PACKAGE_WRITER_COMMANDS[family], writers: PackageWriter[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || !/^[1-9][0-9]{0,9}$/.test(entry) || Number(entry) === ports.selfPid) continue
    let comm: string | null
    try { comm = await ports.readComm(entry) } catch { comm = null }
    const command = typeof comm === 'string' ? comm.replace(/\n$/, '') : ''
    if (names.includes(command)) writers.push({ pid: Number(entry), command })
  }
  let result: RepairCommandResult | null = null
  try { result = await ports.run([...(family === 'debian' ? DPKG_AUDIT_ARGV : RPMDB_VERIFY_ARGV)]) } catch { result = null }
  writers.sort((left, right) => left.pid - right.pid)
  return { state: 'read', writers, database: classifyPackageDatabase(family, result) }
}

export const packageSafetyRefusal = (safety: PackageSafety): PackageSafetyRefusal | null =>
  safety.state !== 'read' ? 'package-safety-unverified' : safety.writers.length ? 'competing-package-writer' : safety.database !== 'clean' ? 'package-database-not-clean' : null

export const REPAIR_ROUTE = '/whm/monitoring/repair'

/**
 * Adds competing-writer fencing before every step and a database recovery check when the job settles.
 * The finalizer runs on success, failure and cancellation; an inconsistent database makes the job an
 * unknown outcome that points at the repair center instead of reporting a clean failure.
 */
export function withPackageSafety(plan: HostJobPlan, family: PackageSafetyFamily, observe: () => Promise<PackageSafety>, refuse: (reason: PackageSafetyRefusal) => never): HostJobPlan {
  const before = plan.beforeStep, policy = plan.policy
  return {
    ...plan,
    detail: { ...plan.detail, competingWritersChecked: true, recoveryRoute: REPAIR_ROUTE },
    policy: argv => policy(argv) || isPackageSafetyCommand(argv),
    beforeStep: async (step: HostJobCommandStep) => {
      if (before) await before(step)
      const reason = packageSafetyRefusal(await observe())
      if (reason) return refuse(reason)
    },
    finalize: async (run: HostJobStepRun): Promise<HostJobVerification> => {
      const argv = family === 'debian' ? DPKG_AUDIT_ARGV : RPMDB_VERIFY_ARGV
      let result: RepairCommandResult | null = null
      try { const raw = await run({ id: 'package-database-check', title: msgid('Check the package database'), argv: [...argv], env: { LC_ALL: 'C' }, timeoutMs: 120_000, mutates: false }); result = { ok: raw.ok, code: raw.code, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.timedOut } } catch { result = null }
      const database = classifyPackageDatabase(family, result)
      return { ok: database === 'clean', detail: { packageDatabase: database, ...(database === 'clean' ? {} : { recoveryRequired: true, recoveryRoute: REPAIR_ROUTE }) } }
    },
  }
}

export const nativePackageSafetyPorts = (run: PackageSafetyPorts['run']): PackageSafetyPorts => ({
  listProcesses: async () => { try { return await readdir('/proc') } catch { return null } },
  readComm: async pid => { try { return await readFile('/proc/' + pid + '/comm', 'utf8') } catch { return null } },
  run, selfPid: process.pid,
})
