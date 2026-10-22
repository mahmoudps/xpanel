import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fail, isUnlimited, isXpanelError, suspensionEffects } from '@xpanel/core'
import type { Account, Limit, OsProfile, Plan, RenderedFile } from '@xpanel/core'
import { services, system } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import { JailedFileManager } from '../file-manager.ts'
import type { AccountFileRunner, FileEntry } from '../file-manager.ts'

type FtpUserInput = services.FtpUserInput

export const DEFAULT_PURE_PW_BINARY = '/usr/bin/pure-pw'
export const DEFAULT_PURE_QUOTACHECK_BINARY = '/usr/sbin/pure-quotacheck'
export const DEFAULT_PURE_FTPD_CONF_DIR = '/etc/pure-ftpd/conf'
export const DEFAULT_PASSIVE_PORT_RANGE: readonly [number, number] = [30_000, 35_000]

export type PureFtpdTlsMode = 'required' | 'optional'

export interface PureFtpdTlsPolicy {
  /** `'required'` sets Pure-FTPd TLS=2 (rejects cleartext auth/data); `'optional'` sets TLS=1. Cleartext-only (0) is forbidden. */
  mode: PureFtpdTlsMode
  certFile?: string
  passivePortRange?: readonly [number, number]
}

export interface PureFtpdAdapterOptions {
  executor: AgentExecutor
  os: OsProfile
  passwdFile?: string
  pdbFile?: string
  confDir?: string
  purePwBinary?: string
  pureQuotacheckBinary?: string
  quotaFilesystem?: string | null
  tlsPolicy?: PureFtpdTlsPolicy
  accountFileRunner?: AccountFileRunner
}

export interface ReconcileFtpUsersInput {
  accounts: readonly Account[]
  plansById: ReadonlyMap<string, Plan>
  users: readonly FtpUserInput[]
  runQuotacheck?: boolean
}

export interface ReconcileFtpUsersResult {
  passwdFilePath: string
  pdbFilePath: string
  activeLogins: string[]
  revokedLogins: string[]
  syncedQuotas: { username: string; uid: number; blockSoftKb: number; blockHardKb: number }[]
  tlsMode: PureFtpdTlsMode
}

export interface StreamingFtpUploadInput {
  account: Pick<Account, 'username' | 'uid' | 'gid' | 'home' | 'status'>
  diskQuotaMb: Limit
  relativePath: string
  chunks: AsyncIterable< Uint8Array | Buffer | string > | Iterable< Uint8Array | Buffer | string >
  maxBytes?: number
  currentUsedBytes?: number
  mode?: number
  overwrite?: boolean
  signal?: AbortSignal
}

export interface StreamingFtpUploadResult {
  path: string
  bytesWritten: number
  sha256: string
  entry: FileEntry
}

const assertSafeUnixPath = (what: string, p: unknown): string => {
  if (typeof p !== 'string' || p.length < 2 || p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p)) {
    return fail('VALIDATION', `${what} must be a canonical absolute path`)
  }
  if (!p.startsWith('/') || posix.normalize(p) !== p || p.endsWith('/')) {
    return fail('VALIDATION', `${what} must be a normalized absolute Linux path`, { path: p })
  }
  return p
}

/**
 * Extracts login names from an existing `/etc/pure-ftpd/pureftpd.passwd` file.
 */
export const parsePasswdLogins = (content: string | null): string[] => {
  if (!content) return []
  const logins: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx > 0) {
      logins.push(line.slice(0, idx))
    }
  }
  return [...new Set(logins)].sort((a, b) => a.localeCompare(b))
}

/**
 * Computes the effective FTP quota in MB for a user, bounded by the owning account's plan disk quota.
 */
export const computeEffectiveFtpQuotaMb = (userQuotaMb: Limit | undefined, accountDiskMb: Limit): Limit => {
  if (accountDiskMb === 'unlimited') {
    return userQuotaMb ?? 'unlimited'
  }
  if (userQuotaMb === undefined || isUnlimited(userQuotaMb)) {
    return accountDiskMb
  }
  return Math.min(userQuotaMb, accountDiskMb)
}

/**
 * Renders the hardened Pure-FTPd daemon configuration files (chroot confinement, PureDB path,
 * TLS enforcement, passive port range, and anonymous access prohibition).
 */
export const renderPureFtpdDaemonConfigs = (opts: {
  confDir?: string
  pdbFile?: string
  tlsPolicy?: PureFtpdTlsPolicy
}): RenderedFile[] => {
  const confDir = assertSafeUnixPath('confDir', opts.confDir ?? DEFAULT_PURE_FTPD_CONF_DIR)
  const pdbFile = assertSafeUnixPath('pdbFile', opts.pdbFile ?? services.FTP_PDB_FILE)
  const mode = opts.tlsPolicy?.mode ?? 'required'
  if (mode !== 'required' && mode !== 'optional') {
    fail('VALIDATION', 'Pure-FTPd TLS policy mode must be "required" or "optional"; plaintext-only FTP is forbidden')
  }
  const tlsValue = mode === 'required' ? '2' : '1'
  const range = opts.tlsPolicy?.passivePortRange ?? DEFAULT_PASSIVE_PORT_RANGE
  const [minPort, maxPort] = range
  if (
    !Number.isSafeInteger(minPort) ||
    !Number.isSafeInteger(maxPort) ||
    minPort < 1024 ||
    maxPort > 65535 ||
    minPort >= maxPort
  ) {
    fail('VALIDATION', 'Pure-FTPd passivePortRange must be a valid [min, max] port pair in 1024..65535')
  }

  const mkFile = (name: string, val: string): RenderedFile => ({
    path: `${confDir}/${name}`,
    content: `${val}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  })

  return [
    mkFile('ChrootEveryone', 'yes'),
    mkFile('NoAnonymous', 'yes'),
    mkFile('PAMAuthentication', 'no'),
    mkFile('UnixAuthentication', 'no'),
    mkFile('PureDB', pdbFile),
    mkFile('TLS', tlsValue),
    mkFile('PassivePortRange', `${minPort} ${maxPort}`),
    mkFile('CreateHomeDir', 'no'),
    mkFile('CustomerProof', 'yes'),
  ]
}

/**
 * Production Pure-FTPd & Streaming File/Quota Service Adapter (D04 — A40).
 */
export class PureFtpdServiceAdapter {
  readonly executor: AgentExecutor
  readonly os: OsProfile
  readonly passwdFile: string
  readonly pdbFile: string
  readonly confDir: string
  readonly purePwBinary: string
  readonly pureQuotacheckBinary: string
  readonly quotaFilesystem: string | null
  readonly tlsPolicy: PureFtpdTlsPolicy
  private readonly accountFileRunner: AccountFileRunner | undefined

  constructor(opts: PureFtpdAdapterOptions) {
    if (!opts?.executor || !opts?.os) {
      fail('VALIDATION', 'PureFtpdServiceAdapter requires executor and os')
    }
    this.executor = opts.executor
    this.os = opts.os
    this.passwdFile = assertSafeUnixPath('passwdFile', opts.passwdFile ?? services.FTP_PASSWD_FILE)
    this.pdbFile = assertSafeUnixPath('pdbFile', opts.pdbFile ?? services.FTP_PDB_FILE)
    this.confDir = assertSafeUnixPath('confDir', opts.confDir ?? DEFAULT_PURE_FTPD_CONF_DIR)
    this.purePwBinary = assertSafeUnixPath('purePwBinary', opts.purePwBinary ?? DEFAULT_PURE_PW_BINARY)
    this.pureQuotacheckBinary = assertSafeUnixPath(
      'pureQuotacheckBinary',
      opts.pureQuotacheckBinary ?? DEFAULT_PURE_QUOTACHECK_BINARY,
    )
    this.quotaFilesystem = opts.quotaFilesystem ?? null
    const tlsPolicy = opts.tlsPolicy ?? { mode: 'required', passivePortRange: DEFAULT_PASSIVE_PORT_RANGE }
    if (tlsPolicy.mode !== 'required' && tlsPolicy.mode !== 'optional') {
      fail('VALIDATION', 'Pure-FTPd TLS policy mode must be "required" or "optional"; plaintext-only FTP is forbidden')
    }
    this.tlsPolicy = tlsPolicy
    this.accountFileRunner = opts.accountFileRunner
  }

  /**
   * Reconciles Pure-FTPd daemon settings, virtual user database (`/etc/pure-ftpd/pureftpd.passwd` -> `pureftpd.pdb`),
   * account UID/GID >= 1000 identity checks, chroot paths, account suspension revocation, and disk quotas.
   *
   * Even when the last FTP user is deleted or suspended, writes the empty `pureftpd.passwd` and runs
   * `pure-pw mkdb` so stale credentials in `pureftpd.pdb` are immediately revoked.
   */
  async reconcileUsers(input: ReconcileFtpUsersInput): Promise<ReconcileFtpUsersResult> {
    const accountsByUsername = new Map<string, Account>()
    for (const acc of input.accounts) {
      services.assertAccount(acc)
      accountsByUsername.set(acc.username, acc)
    }

    const previousPasswdContent = await this.executor.readFile(this.passwdFile)
    const previousLogins = parsePasswdLogins(previousPasswdContent)

    const validatedUsers: FtpUserInput[] = []
    for (const u of input.users) {
      const checkedAccount = services.assertAccount(u.account)
      const owningAccount = accountsByUsername.get(checkedAccount.username)
      if (!owningAccount) {
        return fail('FORBIDDEN', `FTP user "${u.login}" references unknown hosting account "${checkedAccount.username}"`)
      }
      if (
        owningAccount.uid !== checkedAccount.uid ||
        owningAccount.gid !== checkedAccount.gid ||
        owningAccount.home !== checkedAccount.home
      ) {
        fail(
          'FORBIDDEN',
          `FTP user "${u.login}" UID/GID/home mismatch with owning account "${owningAccount.username}"`,
          {
            login: u.login,
            expectedUid: owningAccount.uid,
            actualUid: checkedAccount.uid,
          },
        )
      }

      const plan = input.plansById.get(owningAccount.planId)
      const accountDiskMb: Limit = plan?.resources.diskMb ?? 'unlimited'
      const effectiveQuotaMb = computeEffectiveFtpQuotaMb(u.quotaMb, accountDiskMb)

      const effects = suspensionEffects(owningAccount)
      const accountFtpDenied =
        owningAccount.status !== 'active' ||
        effects.some((e) => e.subsystem === 'ftp-login' && e.state === 'denied')

      validatedUsers.push({
        ...u,
        account: {
          username: owningAccount.username,
          uid: owningAccount.uid,
          gid: owningAccount.gid,
          home: owningAccount.home,
        },
        quotaMb: effectiveQuotaMb,
        suspended: Boolean(u.suspended) || accountFtpDenied,
      })
    }

    // Render passwd file (omits suspended users, sorts active lines, enforces mode 0600 root:root)
    const rendered = services.renderFtpPasswd(validatedUsers, {
      passwdFile: this.passwdFile,
      pdbFile: this.pdbFile,
    })

    const daemonFiles = renderPureFtpdDaemonConfigs({
      confDir: this.confDir,
      pdbFile: this.pdbFile,
      tlsPolicy: this.tlsPolicy,
    })

    await this.executor.runAction({
      kind: 'ensure-dir',
      path: posix.dirname(this.passwdFile),
      mode: 0o755,
      owner: 'root',
      group: 'root',
    })
    await this.executor.runAction({
      kind: 'ensure-dir',
      path: this.confDir,
      mode: 0o755,
      owner: 'root',
      group: 'root',
    })

    for (const df of daemonFiles) {
      await this.executor.writeFile(df)
    }

    // Always write passwdFile and run pure-pw mkdb even when rendered.file.content is empty
    await this.executor.writeFile(rendered.file)

    const mkdbRes = await this.executor.runCommand([
      this.purePwBinary,
      'mkdb',
      this.pdbFile,
      '-f',
      this.passwdFile,
    ])
    if (!mkdbRes.ok) {
      // Restore previous passwd file if mkdb fails so passwd and pdb do not diverge
      if (previousPasswdContent !== null) {
        await this.executor.writeFile({
          path: this.passwdFile,
          content: previousPasswdContent,
          mode: 0o600,
          owner: 'root',
          group: 'root',
        }).catch(() => undefined)
      }
      fail('CONFIG_TEST_FAILED', `pure-pw mkdb failed: ${mkdbRes.stderr || mkdbRes.stdout}`, {
        exitCode: mkdbRes.code,
      })
    }

    const activeLogins = parsePasswdLogins(rendered.file.content)
    const activeSet = new Set(activeLogins)
    const revokedLogins = previousLogins.filter((login) => !activeSet.has(login))

    // Synchronize kernel quotas and optional pure-quotacheck for active accounts
    const syncedQuotas: ReconcileFtpUsersResult['syncedQuotas'] = []
    for (const acc of input.accounts) {
      if (acc.status === 'terminating') continue
      const plan = input.plansById.get(acc.planId)
      if (!plan) continue
      const q = system.quotaBlocksKb(plan.resources.diskMb)
      if (this.quotaFilesystem !== null) {
        await this.executor.runAction({
          kind: 'set-quota',
          user: acc.username,
          blockSoftKb: q.blockSoftKb,
          blockHardKb: q.blockHardKb,
          filesystem: this.quotaFilesystem,
        })
      }
      if (input.runQuotacheck) {
        const qcRes = await this.executor.runCommand([
          this.pureQuotacheckBinary,
          '-u',
          String(acc.uid),
          '-d',
          acc.home,
        ])
        if (!qcRes.ok) {
          fail('CONFIG_TEST_FAILED', `pure-quotacheck failed for ${acc.username}: ${qcRes.stderr || qcRes.stdout}`)
        }
      }
      syncedQuotas.push({
        username: acc.username,
        uid: acc.uid,
        blockSoftKb: q.blockSoftKb,
        blockHardKb: q.blockHardKb,
      })
    }

    return {
      passwdFilePath: this.passwdFile,
      pdbFilePath: this.pdbFile,
      activeLogins,
      revokedLogins,
      syncedQuotas,
      tlsMode: this.tlsPolicy.mode,
    }
  }

  /**
   * Streams an upload into the account home via the confined `JailedFileManager` / `AccountFileRunner`,
   * enforcing backpressure, maximum byte limits, account disk quota, and cancellation without corrupting
   * any existing file on failure.
   */
  async streamUploadToAccount(input: StreamingFtpUploadInput): Promise<StreamingFtpUploadResult> {
    const checkedAccount = services.assertAccount(input.account)
    if (input.account.status !== 'active') {
      fail('FORBIDDEN', `account "${checkedAccount.username}" is not active`)
    }
    const maxBytes = input.maxBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      fail('VALIDATION', 'maxBytes must be a positive integer')
    }
    const quotaBytes =
      input.diskQuotaMb === 'unlimited' ? Number.POSITIVE_INFINITY : input.diskQuotaMb * 1024 * 1024
    const currentUsedBytes = input.currentUsedBytes ?? 0

    const fm = new JailedFileManager(checkedAccount.home, input.diskQuotaMb, {
      account: checkedAccount,
      ...(this.accountFileRunner ? { runner: this.accountFileRunner } : {}),
    })

    const buffers: Buffer[] = []
    let bytesWritten = 0
    const hash = createHash('sha256')

    try {
      for await (const chunk of input.chunks) {
        if (input.signal?.aborted) {
          fail('CONFIG_TEST_FAILED', 'streaming file upload was aborted by caller')
        }
        const buf =
          typeof chunk === 'string'
            ? Buffer.from(chunk, 'utf8')
            : Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk)

        bytesWritten += buf.length
        if (bytesWritten > maxBytes) {
          fail('LIMIT_EXCEEDED', `upload stream exceeded maximum allowed size of ${maxBytes} bytes`, {
            bytesWritten,
            maxBytes,
          })
        }
        if (currentUsedBytes + bytesWritten > quotaBytes) {
          fail('LIMIT_EXCEEDED', `upload stream exceeded account disk quota (${String(input.diskQuotaMb)} MB)`, {
            bytesWritten,
            diskQuotaMb: input.diskQuotaMb,
          })
        }
        hash.update(buf)
        buffers.push(buf)
      }
    } catch (err) {
      buffers.length = 0
      if (isXpanelError(err)) throw err
      return fail('CONFIG_TEST_FAILED', 'upload stream interrupted before completion')
    }

    const fullContent = Buffer.concat(buffers).toString('utf8')
    const entry = await fm.writeText(input.relativePath, fullContent, {
      overwrite: input.overwrite ?? true,
      ...(input.mode !== undefined && { mode: input.mode }),
    })

    return {
      path: entry.path,
      bytesWritten,
      sha256: hash.digest('hex'),
      entry,
    }
  }
}
