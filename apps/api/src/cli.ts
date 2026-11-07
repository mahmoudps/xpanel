import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import {
  appendAudit,
  createRootPrincipal,
  findPrincipalByUsername,
  isJobStepCompleted,
  latestActive,
  listSecurityQuestions,
  reindexFromState,
  reopenAttentionJob,
  replaceSecurityQuestions,
  setPasswordHash,
  setTotpSecret,
} from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { passwordHashFromInput } from './auth.ts'
import { passwordAllowed } from './password-policy.ts'
import { runPanelAccessCli } from './panel-access-cli.ts'

export interface CliDeps {
  db: Db
  store: StateStore
  agentApp?: AgentApp
  agentToken?: string
  readPassword?: () => Promise<string>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
  data?: unknown
}

const readPlaintextPassword = async (readPassword: () => Promise<string>): Promise<string> => {
  let input: string
  try {
    input = await readPassword()
  } catch {
    return fail('PRECONDITION_FAILED', 'could not read password from standard input')
  }
  const password = input.replace(/\r?\n$/, '')
  // Root recovery never reads hosting state, so the saved strength policy is not loaded here: the 8-character rule applies.
  if (!passwordAllowed(password, 'panel') || Buffer.byteLength(password, 'utf8') > 1024 || /[\r\n]/.test(password)) {
    return fail('VALIDATION', 'password input must be a single line of at least 8 characters and at most 1024 UTF-8 bytes')
  }
  return password
}

/**
 * Executes an `xpanel` administrative CLI command (`status`, `reconcile`, `rollback`,
 * `reindex`, `init-root`, `reset-password`, `disable-2fa`, `recover-provisioning`, `init-quotas`).
 * `reconcile --resolve-failed <generation-id>` clears a journal stuck in needs_attention.
 */
export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<CliResult> => {
  const outLines: string[] = []
  const errLines: string[] = []
  const writeOut = (line: string): void => {
    outLines.push(line)
    deps.stdout?.(line)
  }
  const writeErr = (line: string): void => {
    errLines.push(line)
    deps.stderr?.(line)
  }

  const normalized = argv[0] === 'xpanel' ? argv.slice(1) : [...argv]
  const [command, ...rest] = normalized

  const callAgent = async (path: string, body: Record<string, unknown>): Promise<Response> => {
    if (!deps.agentApp || !deps.agentToken) fail('PRECONDITION_FAILED', 'authenticated privileged agent connection is required')
    const principal = await findPrincipalByUsername(deps.db, 'root')
    if (!principal || principal.disabled || principal.kind !== 'root') fail('PRECONDITION_FAILED', 'an active root principal is required')
    return deps.agentApp!.fetch(new Request(`http://agent.local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...agentCallerHeaders({ principalId: principal!.id, token: deps.agentToken! }) },
      body: JSON.stringify(body),
    }))
  }

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      writeOut(
        [
          'Usage: xpanel <command> [options]',
          'Commands:',
          '  status                               Show panel, server, and generation status',
          '  reconcile [--force]                  Compile desired state and reconcile host',
          '  reconcile --resolve-failed <id> [--attest-pre-actions]  Verify disk, clear a stuck failed generation, then reconcile',
          '  rollback <generation-id>             Restore and reconcile a previous generation',
          '  reindex                              Rebuild SQLite search/cache index from state',
          '  init-root --password-stdin           Provision root once from standard input; requires a password change',
          '  reset-password <username> --password-stdin  Read one password from standard input; also removes security questions',
          '  disable-2fa <username> [--confirm]   Recover an enrolled factor with explicit confirmation',
          '  panel-access show | reset <part>     Show or clear allowlists, entrance, response, basic auth, stopped entry points or temporary links',
          '  recover-provisioning <job-id> --attest-host-recovered  Requeue an account whose host step was interrupted, after reconcile',
          '  init-quotas [--path <dir>]           Enable enforced user disk quota on the filesystem of account homes (default /home)',
          '  repair-state-ownership               Root-only: give the xpanel user the state tree',
        ].join('\n'),
      )
      return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n') }
    }

    switch (command) {
      case 'status': {
        const [setupComplete, settings, accounts, resellers, currentGeneration] = await Promise.all([
          deps.store.isSetupComplete(),
          deps.store.getServerSettings(),
          deps.store.listAccounts(),
          deps.store.listResellers(),
          latestActive(deps.db),
        ])
        const data = {
          ok: true,
          setupComplete,
          hostname: settings?.hostname ?? null,
          engine: settings?.engine ?? null,
          accountsCount: accounts.length,
          resellersCount: resellers.length,
          currentGeneration,
        }
        writeOut(
          `xPanel status: setup=${setupComplete ? 'complete' : 'pending'} engine=${data.engine ?? 'unconfigured'} accounts=${accounts.length} generation=${currentGeneration?.id ?? 'none'}`,
        )
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data }
      }

      case 'reconcile': {
        const resolveAt = rest.indexOf('--resolve-failed')
        if (resolveAt !== -1) {
          const attest = rest.includes('--attest-pre-actions')
          if (rest.includes('--force') || rest.includes('-f') || rest.length !== (attest ? 3 : 2) || rest[resolveAt + 1] === '--attest-pre-actions') {
            return fail('VALIDATION', 'usage: xpanel reconcile --resolve-failed <generation-id> [--attest-pre-actions]')
          }
          const rawGen = rest[resolveAt + 1]
          if (!rawGen || !/^[1-9][0-9]*$/.test(rawGen)) {
            return fail('VALIDATION', 'resolve-failed requires a positive integer generation id')
          }
          const genId = Number(rawGen)
          // Attestation is the operator's explicit, audited statement that host prerequisite effects were checked.
          const res = await callAgent(`/generations/${genId}/resolve-failed`, attest ? { attestPreActions: true } : {})
          const body = (await res.json()) as Record<string, unknown>
          if (!res.ok) {
            writeErr(`Resolve failed generation ${genId} refused: ${JSON.stringify(body)}`)
            return { code: 1, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
          }
          writeOut(`Resolved failed generation ${genId} after checking on-disk state. Run xpanel reconcile to continue.`)
          return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
        }
        const force = rest.includes('--force') || rest.includes('-f')
        const res = await callAgent('/reconcile', { force })
        const body = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          writeErr(`Reconcile failed: ${JSON.stringify(body)}`)
          return { code: 1, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
        }
        writeOut(`Reconcile ${String(body.status ?? 'ok')}`)
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
      }

      case 'rollback': {
        const rawGen = rest[0]
        const genId = Number(rawGen)
        if (!rawGen || !Number.isSafeInteger(genId) || genId < 1) {
          return fail('VALIDATION', 'rollback requires a positive integer <generation-id>')
        }
        const res = await callAgent(`/generations/${genId}/rollback`, {})
        const body = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          writeErr(`Rollback to generation ${genId} failed: ${JSON.stringify(body)}`)
          return { code: 1, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
        }
        writeOut(`Rolled back to generation ${genId}`)
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
      }

      case 'reindex': {
        const snapshot = await deps.store.readSnapshot()
        const result = await reindexFromState(deps.db, snapshot)
        await appendAudit(deps.db, {
          actor: 'cli:root',
          action: 'cli.reindex',
          target: 'sqlite:index',
          detail: { ...result },
          outcome: 'ok',
        })
        writeOut(
          `Reindexed state (${result.accounts} accounts, ${result.domains} domains, ${result.resellers} resellers, ${result.plans} plans)`,
        )
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: result }
      }

      case 'init-root': {
        if (rest.length !== 1 || rest[0] !== '--password-stdin' || !deps.readPassword) {
          return fail('VALIDATION', 'usage: xpanel init-root --password-stdin')
        }
        if (await findPrincipalByUsername(deps.db, 'root')) {
          return fail('CONFLICT', 'root is already initialized; use reset-password for recovery')
        }
        const password = await readPlaintextPassword(deps.readPassword)
        const passwordHash = await passwordHashFromInput({ password })
        await deps.db.transaction(async (tx) => {
          const root = await createRootPrincipal(tx, { username: 'root', passwordHash, forcePasswordChange: true })
          await appendAudit(tx, {
            actor: 'cli:root',
            action: 'auth.root_initialized',
            target: 'principal:root',
            detail: { via: 'cli', forcePasswordChange: true },
            outcome: 'ok',
            principalId: root.id,
          })
        })
        writeOut('Root initialized. Change the password at first sign-in before administering the server. Two-factor authentication stays optional until it is enrolled.')
        return {
          code: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: { username: 'root', initialized: true, forcePasswordChange: true },
        }
      }

      case 'reset-password': {
        const username = rest[0]?.trim().toLowerCase()
        const isStdinMode = rest.length === 1 || (rest.length === 2 && rest[1] === '--password-stdin')
        const inlinePassword =
          rest.length === 2 && rest[1] !== '--password-stdin' && !rest[1]?.startsWith('--')
            ? rest[1]
            : rest.length === 3 && rest[1] === '--password'
              ? rest[2]
              : undefined
        if (!username || (!isStdinMode && !inlinePassword) || (isStdinMode && !deps.readPassword)) {
          return fail('VALIDATION', 'usage: xpanel reset-password <username> [--password-stdin]')
        }
        const principal = await findPrincipalByUsername(deps.db, username)
        if (!principal) {
          return fail('NOT_FOUND', `principal "${username}" not found`)
        }
        const password = inlinePassword
          ? await readPlaintextPassword(async () => inlinePassword)
          : await readPlaintextPassword(deps.readPassword!)
        const passwordHash = await passwordHashFromInput({ password })
        const securityQuestions = (await listSecurityQuestions(deps.db, principal.id)).length
        await setPasswordHash(deps.db, principal.id, passwordHash, {
          forceChange: false,
          clearLockout: true,
          audit: {
            actor: 'cli:root',
            action: 'auth.password_reset',
            target: `principal:${principal.username}`,
            detail: { via: 'cli', securityQuestionsRemoved: securityQuestions },
            outcome: 'ok',
            principalId: principal.id,
          },
        })
        // Shell recovery must get the user back in: forgotten answers would otherwise still block the new password.
        await replaceSecurityQuestions(deps.db, principal.id, [])
        writeOut(`Password reset for "${principal.username}" and active lockouts cleared.${securityQuestions ? ' Security questions were removed.' : ''}`)
        return {
          code: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: { username: principal.username, reset: true },
        }
      }

      case 'disable-2fa': {
        const username = rest[0]?.trim().toLowerCase()
        const confirmed = rest.length === 2 && rest[1] === '--confirm'
        if (!username || (rest.length !== 1 && !confirmed)) {
          return fail('VALIDATION', 'usage: xpanel disable-2fa <username> [--confirm]')
        }
        const principal = await findPrincipalByUsername(deps.db, username)
        if (!principal) {
          return fail('NOT_FOUND', `principal "${username}" not found`)
        }
        if (principal.totpEnabled && !confirmed) {
          return fail('VALIDATION', 'usage: xpanel disable-2fa <username> --confirm; enrolled-factor recovery revokes active sessions and API tokens')
        }
        await setTotpSecret(deps.db, principal.id, null, [], {
          clearLockout: true,
          audit: {
            actor: 'cli:root',
            action: 'auth.2fa_disabled',
            target: `principal:${principal.username}`,
            detail: { via: 'cli', severity: 'high', confirmed, reason: 'operator_factor_recovery' },
            outcome: 'ok',
            principalId: principal.id,
          },
        })
        writeOut(`Two-factor authentication disabled for "${principal.username}".`)
        writeErr('Operator factor recovery completed; active sessions and API tokens were revoked. Two-factor enrollment remains optional.')
        return {
          code: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: { username: principal.username, totpEnabled: false },
        }
      }

      case 'panel-access': {
        const data = await runPanelAccessCli(rest, { db: deps.db, store: deps.store, writeOut })
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data }
      }

      case 'init-quotas': {
        if (!(rest.length === 0 || (rest.length === 2 && rest[0] === '--path' && rest[1]?.startsWith('/')))) {
          return fail('VALIDATION', 'usage: xpanel init-quotas [--path <dir>]')
        }
        const res = await callAgent('/host/quota/initialize', rest.length ? { path: rest[1] } : {})
        const body = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          writeErr(`Quota setup refused: ${JSON.stringify(body)}`)
          return { code: 1, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
        }
        writeOut(body.changed === true
          ? `User quota is now enforced on ${String(body.filesystem)} (${String(body.filesystemType)}). /etc/fstab backup: ${String(body.fstabBackup ?? 'not needed')}. Run xpanel reconcile --force to apply account limits.`
          : `User quota is already enforced on ${String(body.filesystem)}; nothing changed.`)
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: body }
      }

      case 'recover-provisioning': {
        const jobId = rest[0]
        if (rest.length !== 2 || rest[1] !== '--attest-host-recovered' || !jobId || !isUuid(jobId)) {
          return fail('VALIDATION', 'usage: xpanel recover-provisioning <job-id> --attest-host-recovered')
        }
        // The attestation is the operator's audited review of the interrupted host attempt. It replays nothing:
        // the next request for the same account reruns the host step and its independent observation.
        const reopened = await reopenAttentionJob(deps.db, { jobId }, async (tx, job) => {
          const hostAttempt = job.checkpointData.hostAttempt
          if (job.kind !== 'account.provision' || !isJobStepCompleted(job, 'reconcile_host_intent') || isJobStepCompleted(job, 'reconcile_host')
            || typeof hostAttempt !== 'number') {
            return fail('PRECONDITION_FAILED', 'the job is not an account provisioning job interrupted in its host step')
          }
          await appendAudit(tx, {
            actor: 'cli:root',
            action: 'account.provision.host_recovery_attested',
            target: `job:${job.id}`,
            detail: { via: 'cli', jobId: job.id, hostAttempt, username: job.detail.username ?? null },
            outcome: 'ok',
          })
          return { hostRecoveredAttempt: hostAttempt }
        })
        writeOut(`Provisioning job ${reopened.id} is queued again. Repeat the account request to rerun and verify its host step.`)
        return { code: 0, stdout: outLines.join('\n'), stderr: errLines.join('\n'), data: { jobId: reopened.id, status: reopened.status } }
      }

      default:
        return fail('VALIDATION', `unknown CLI command "${command}"`)
    }
  } catch (err) {
    const message = isXpanelError(err) ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
    writeErr(message)
    return {
      code: 1,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    }
  }
}
