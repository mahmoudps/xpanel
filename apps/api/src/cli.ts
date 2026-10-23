import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { fail, isXpanelError } from '@xpanel/core'
import {
  appendAudit,
  createRootPrincipal,
  findPrincipalByUsername,
  latestActive,
  reindexFromState,
  setPasswordHash,
  setTotpSecret,
} from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { passwordHashFromInput } from './auth.ts'

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
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 1024 || /[\r\n]/.test(password)) {
    return fail('VALIDATION', 'password input must be a single line of at least 8 characters and at most 1024 UTF-8 bytes')
  }
  return password
}

/**
 * Executes an `xpanel` administrative CLI command (`status`, `reconcile`, `rollback`,
 * `reindex`, `init-root`, `reset-password`, `disable-2fa`).
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
          '  reconcile --resolve-failed <id>      Verify disk, clear a stuck failed generation, then reconcile',
          '  rollback <generation-id>             Restore and reconcile a previous generation',
          '  reindex                              Rebuild SQLite search/cache index from state',
          '  init-root --password-stdin           Provision root once from standard input; requires a password change',
          '  reset-password <username> --password-stdin  Read one password from standard input',
          '  disable-2fa <username>               Disable TOTP 2FA for a principal',
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
          if (rest.includes('--force') || rest.includes('-f') || rest.length !== 2) {
            return fail('VALIDATION', 'usage: xpanel reconcile --resolve-failed <generation-id>')
          }
          const rawGen = rest[resolveAt + 1]
          if (!rawGen || !/^[1-9][0-9]*$/.test(rawGen)) {
            return fail('VALIDATION', 'resolve-failed requires a positive integer generation id')
          }
          const genId = Number(rawGen)
          const res = await callAgent(`/generations/${genId}/resolve-failed`, {})
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
        await setPasswordHash(deps.db, principal.id, passwordHash, {
          forceChange: false,
          clearLockout: true,
          audit: {
            actor: 'cli:root',
            action: 'auth.password_reset',
            target: `principal:${principal.username}`,
            detail: { via: 'cli' },
            outcome: 'ok',
            principalId: principal.id,
          },
        })
        writeOut(`Password reset for "${principal.username}" and active lockouts cleared.`)
        return {
          code: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: { username: principal.username, reset: true },
        }
      }

      case 'disable-2fa': {
        const username = rest[0]?.trim().toLowerCase()
        if (!username || rest.length !== 1) {
          return fail('VALIDATION', 'usage: xpanel disable-2fa <username>')
        }
        const principal = await findPrincipalByUsername(deps.db, username)
        if (!principal) {
          return fail('NOT_FOUND', `principal "${username}" not found`)
        }
        await setTotpSecret(deps.db, principal.id, null, [], {
          clearLockout: true,
          audit: {
            actor: 'cli:root',
            action: 'auth.2fa_disabled',
            target: `principal:${principal.username}`,
            detail: { via: 'cli' },
            outcome: 'ok',
            principalId: principal.id,
          },
        })
        writeOut(`Two-factor authentication disabled for "${principal.username}".`)
        return {
          code: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: { username: principal.username, totpEnabled: false },
        }
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
