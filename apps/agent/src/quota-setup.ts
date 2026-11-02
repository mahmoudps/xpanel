import { isXpanelError } from '@xpanel/core'
import { assertSafeArgv } from '@xpanel/os'
import { createProductionHostTargetMatcher, LinuxHostExecutor, type AgentExecutor } from './executor.ts'
import { createHostJobRun } from './host-job-exec.ts'
import { initializeUserQuota, readBootableKernels, type QuotaInitializationPorts } from './services/quota.ts'

/** The native ports of user quota setup, shared by the root agent route and the installer. */
export const nativeQuotaSetupPorts = (executor: AgentExecutor): QuotaInitializationPorts => {
  const scanRun = createHostJobRun()
  return {
    run: argv => executor.runCommand(argv),
    // shortcut: a filesystem whose scan exceeds 4 minutes fails here as unverified; move the scan to a host job when such hosts appear.
    scan: async argv => {
      assertSafeArgv(argv)
      const scanned = await scanRun(argv, { timeoutMs: 240_000, env: { LC_ALL: 'C' } })
      return { ok: scanned.ok, code: scanned.code ?? 1, stdout: scanned.stdout, stderr: scanned.stderr }
    },
    bootableKernels: readBootableKernels,
    readFile: path => executor.readFile(path),
    writeFile: file => executor.writeFile(file),
  }
}

export const quotaSetupStamp = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, '')

export interface InstallQuotaSetupResult {
  /** 0 enforced, 2 not enforced and nothing changed (operator action required), 1 stopped part-way. */
  readonly exitCode: 0 | 1 | 2
  readonly report: Readonly<Record<string, unknown>>
}

/** Installer step: enforce user quota where the agent's provisioning observer requires it. */
export const installQuotaSetup = async (ports: QuotaInitializationPorts, path: string, now: Date): Promise<InstallQuotaSetupResult> => {
  try {
    const result = await initializeUserQuota(ports, path, quotaSetupStamp(now))
    return { exitCode: 0, report: { status: result.changed ? 'enabled' : 'already_enforced', filesystem: result.filesystem,
      filesystemType: result.filesystemType, fstabBackup: result.fstabBackup } }
  } catch (error) {
    const detail = isXpanelError(error) ? error.detail : {}
    const reason = isXpanelError(error) ? error.message : 'user quota setup failed'
    if (detail.stateChanged === false) return { exitCode: 2, report: { status: 'pending', reason, filesystemType: detail.filesystemType ?? null } }
    return { exitCode: 1, report: { status: 'unverified', reason, step: detail.step ?? null, fstabBackup: detail.fstabBackup ?? null } }
  }
}

if (import.meta.main) {
  const executor = new LinuxHostExecutor({ trustedHostTargetMatcher: createProductionHostTargetMatcher() })
  const { exitCode, report } = await installQuotaSetup(nativeQuotaSetupPorts(executor), process.argv[2] ?? '/home', new Date())
  process.stdout.write(JSON.stringify(report) + '\n')
  process.exitCode = exitCode
}
