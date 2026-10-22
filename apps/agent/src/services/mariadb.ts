import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DB_NAME_MAX, dbGrantPattern, fail, isXpanelError } from '@xpanel/core'
import { services } from '@xpanel/render'

type DbAuth = services.DbAuth
type DbGrant = services.DbGrant
type DbHostOptions = services.DbHostOptions
type DbUserOptions = services.DbUserOptions
type MariadbPrivilege = services.MariadbPrivilege

export const DEFAULT_MARIADB_ADMIN_CNF = '/etc/xpanel/mariadb-admin.cnf'
export const DEFAULT_MARIADB_BINARY = '/usr/bin/mariadb'
export const DEFAULT_MARIADB_DUMP_BINARY = '/usr/bin/mariadb-dump'
export const DEFAULT_MARIADB_SOCKET = '/run/mysqld/mysqld.sock'
export const DEFAULT_SQL_TIMEOUT_MS = 30_000
export const DEFAULT_DUMP_TIMEOUT_MS = 300_000
export const MAX_SQL_STDOUT_BYTES = 8 * 1024 * 1024
export const MAX_SQL_STDERR_BYTES = 256 * 1024

export interface MariaDbCommandInput {
  argv: string[]
  stdinSql?: string
  stdinFilePath?: string
  stdoutFilePath?: string
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

export interface MariaDbCommandResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  bytesProcessed?: number
  sha256?: string
}

export type MariaDbCommandRunner = (input: MariaDbCommandInput) => Promise<MariaDbCommandResult>

export interface AdminConfigMetadata {
  exists: boolean
  isFile: boolean
  isSymlink: boolean
  uid: number
  gid: number
  mode: number
  size: number
  content?: string
}

export type AdminConfigInspector = (path: string) => Promise<AdminConfigMetadata>

export interface MariaDbAdapterOptions {
  /** Path to the root-only MariaDB client credentials file (`--defaults-extra-file`). */
  adminDefaultsFile?: string
  /** Optional local Unix socket path passed via `--socket` when set. */
  socketPath?: string | null
  /** Absolute path to the `mariadb` client binary. */
  mariadbBinary?: string
  /** Absolute path to the `mariadb-dump` / `mysqldump` binary. */
  mariadbDumpBinary?: string
  /** Default statement timeout in milliseconds. */
  timeoutMs?: number
  /** Default logical dump/restore timeout in milliseconds. */
  dumpTimeoutMs?: number
  /** Optional custom command runner for deterministic unit and fault-injection tests. */
  commandRunner?: MariaDbCommandRunner
  /** Optional custom admin credential file inspector for portable tests. */
  adminConfigInspector?: AdminConfigInspector
}

export interface DesiredDatabaseGrant {
  database: string
  privileges: string[]
}

export interface ReconcileUserGrantsInput {
  user: string
  username: string
  host?: string
  desiredGrants: DesiredDatabaseGrant[]
  allowAnyHost?: boolean
}

export interface ReconcileUserGrantsResult {
  user: string
  host: string
  observedGrants: Map<string, MariadbPrivilege[]>
  revokedGlobal: boolean
  revokedDatabases: { databasePattern: string; privileges: MariadbPrivilege[] | 'ALL' }[]
  grantedDatabases: { database: string; databasePattern: string; privileges: MariadbPrivilege[] }[]
  unchangedDatabases: string[]
  executedStatements: string[]
}

export interface LogicalDumpInput {
  database: string
  username: string
  outputPath: string
  /** Include `--no-create-db` so the dump can be restored cleanly into a new target database name. */
  includeCreateDb?: boolean
  timeoutMs?: number
}

export interface LogicalDumpResult {
  database: string
  outputPath: string
  sizeBytes: number
  sha256: string
  routinesIncluded: boolean
  triggersIncluded: boolean
  eventsIncluded: boolean
  singleTransaction: boolean
}

export interface LogicalRestoreInput {
  targetDatabase: string
  username: string
  inputPath: string
  expectedSha256?: string
  verifyBeforeCutover?: boolean
  timeoutMs?: number
}

export interface DatabaseObjectsSummary {
  database: string
  tables: { name: string; engine: string; rowCount: number; checksum: string | null }[]
  routines: string[]
  triggers: string[]
  events: string[]
}

export interface LogicalRestoreResult {
  targetDatabase: string
  inputPath: string
  verifiedSha256: string
  verification: DatabaseObjectsSummary | null
}

const FORBIDDEN_ARGV_PATTERNS = [
  /^-p/i,
  /^--password(?:=|$)/i,
  /^--pass(?:=|$)/i,
]

const redactSqlSecrets = (text: string): string =>
  text
    .replace(/IDENTIFIED\s+BY\s+PASSWORD\s+'[^']*'/gi, "IDENTIFIED BY PASSWORD '[REDACTED]'")
    .replace(/IDENTIFIED\s+BY\s+'[^']*'/gi, "IDENTIFIED BY '[REDACTED]'")
    .replace(/IDENTIFIED\s+VIA\s+\w+\s+USING\s+'[^']*'/gi, "IDENTIFIED VIA auth USING '[REDACTED]'")
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=[REDACTED]')

const assertCanonicalUnixPath = (what: string, p: unknown): string => {
  if (typeof p !== 'string' || p.length < 2 || p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p)) {
    return fail('VALIDATION', `${what} must be a canonical absolute path`)
  }
  if (!p.startsWith('/') || posix.normalize(p) !== p || p.endsWith('/')) {
    return fail('VALIDATION', `${what} must be a normalized absolute Linux path`, { path: p })
  }
  return p
}

/**
 * Ensures no password flag is ever present in process argv.
 */
export const assertNoPasswordInArgv = (argv: readonly string[]): void => {
  if (!Array.isArray(argv) || argv.length === 0) {
    fail('VALIDATION', 'MariaDB command argv must be a non-empty array')
  }
  const binary = argv[0]
  if (typeof binary !== 'string' || !binary.startsWith('/')) {
    fail('VALIDATION', 'MariaDB command binary must be an absolute path')
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || /[\u0000\r\n]/.test(arg)) {
      fail('VALIDATION', 'MariaDB command argv contains invalid characters')
    }
    if (FORBIDDEN_ARGV_PATTERNS.some((re) => re.test(arg))) {
      fail('PRECONDITION_FAILED', 'MariaDB passwords must never be passed in command-line arguments')
    }
  }
}

const defaultAdminConfigInspector: AdminConfigInspector = async (path: string): Promise<AdminConfigMetadata> => {
  if (process.platform !== 'linux') {
    fail('PRECONDITION_FAILED', 'MariaDB host execution requires Linux')
  }
  let lst
  try {
    lst = await lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, isFile: false, isSymlink: false, uid: -1, gid: -1, mode: 0, size: 0 }
    }
    throw err
  }
  if (lst.isSymbolicLink()) {
    return {
      exists: true,
      isFile: false,
      isSymlink: true,
      uid: lst.uid,
      gid: lst.gid,
      mode: lst.mode & 0o7777,
      size: lst.size,
    }
  }
  const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await fh.stat()
    const content = st.isFile() && st.size <= 16_384 ? await fh.readFile('utf8') : undefined
    return {
      exists: true,
      isFile: st.isFile(),
      isSymlink: false,
      uid: st.uid,
      gid: st.gid,
      mode: st.mode & 0o7777,
      size: st.size,
      ...(content !== undefined ? { content } : {}),
    }
  } finally {
    await fh.close()
  }
}

const computeFileSha256 = async (filePath: string): Promise<{ sizeBytes: number; sha256: string }> => {
  const hash = createHash('sha256')
  let sizeBytes = 0
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    sizeBytes += buf.length
    hash.update(buf)
  }
  return { sizeBytes, sha256: hash.digest('hex') }
}

const defaultCommandRunner: MariaDbCommandRunner = async (input: MariaDbCommandInput): Promise<MariaDbCommandResult> => {
  assertNoPasswordInArgv(input.argv)
  const [cmd, ...args] = input.argv
  if (!cmd) return fail('VALIDATION', 'MariaDB command binary is required')

  return new Promise<MariaDbCommandResult>((resolvePromise, rejectPromise) => {
    const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let stdoutOversize = false
    const hash = input.stdoutFilePath ? createHash('sha256') : null

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
    timer.unref?.()

    let streamPipelinePromise: Promise<void> = Promise.resolve()

    if (input.stdoutFilePath) {
      const outPath = input.stdoutFilePath
      const writeStream = createWriteStream(outPath, { flags: 'wx', mode: 0o600 })
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        hash?.update(chunk)
      })
      streamPipelinePromise = pipeline(child.stdout, writeStream)
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > input.maxStdoutBytes) {
          stdoutOversize = true
          child.kill('SIGKILL')
          return
        }
        stdoutChunks.push(Buffer.from(chunk))
      })
    }

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < input.maxStderrBytes) {
        const remaining = input.maxStderrBytes - stderrBytes
        stderrChunks.push(Buffer.from(chunk.subarray(0, remaining)))
      }
      stderrBytes += chunk.length
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      rejectPromise(err)
    })

    if (input.stdinFilePath) {
      const readStream = createReadStream(input.stdinFilePath)
      readStream.on('data', (chunk: Buffer | string) => {
        stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      })
      pipeline(readStream, child.stdin).catch(() => {
        /* child close handles exit status */
      })
    } else if (input.stdinSql !== undefined) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(input.stdinSql, 'utf8')
    } else {
      child.stdin.end()
    }

    child.on('close', async (exitCode: number | null) => {
      clearTimeout(timer)
      try {
        await streamPipelinePromise
      } catch (err) {
        rejectPromise(err)
        return
      }
      if (timedOut) {
        resolvePromise({
          ok: false,
          exitCode: exitCode ?? 124,
          stdout: '',
          stderr: 'MariaDB command timed out',
        })
        return
      }
      if (stdoutOversize) {
        resolvePromise({
          ok: false,
          exitCode: exitCode ?? 1,
          stdout: '',
          stderr: 'MariaDB command output exceeded maximum buffer limit',
        })
        return
      }
      const code = exitCode ?? 1
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: redactSqlSecrets(Buffer.concat(stderrChunks).toString('utf8')),
        bytesProcessed: stdoutBytes,
        ...(hash ? { sha256: hash.digest('hex') } : {}),
      })
    })
  })
}

export interface ParsedGrantLine {
  kind: 'global' | 'database' | 'other'
  databasePattern: string | null
  privileges: MariadbPrivilege[]
  raw: string
}

/**
 * Parses a single row from `SHOW GRANTS FOR 'user'@'host'`.
 */
export const parseShowGrantLine = (line: string): ParsedGrantLine | null => {
  const trimmed = line.trim()
  if (!trimmed.toUpperCase().startsWith('GRANT ')) return null
  const m = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(trimmed)
  if (!m) return null
  const rawPrivs = (m[1] ?? '').trim()
  const rawTarget = (m[2] ?? '').trim()

  if (rawPrivs.toUpperCase() === 'USAGE') {
    return null
  }

  const parsePrivList = (text: string): MariadbPrivilege[] => {
    const parts = text.split(',').map((s) => s.trim().toUpperCase().replace(/\s+/g, ' '))
    if (parts.includes('ALL PRIVILEGES') || parts.includes('ALL')) {
      return [...services.MARIADB_PRIVILEGES]
    }
    const allowed = new Set<string>(services.MARIADB_PRIVILEGES)
    const out: MariadbPrivilege[] = []
    for (const p of parts) {
      if (allowed.has(p)) out.push(p as MariadbPrivilege)
    }
    return services.MARIADB_PRIVILEGES.filter((p) => out.includes(p))
  }

  const privileges = parsePrivList(rawPrivs)

  if (rawTarget === '*.*') {
    return { kind: 'global', databasePattern: null, privileges, raw: trimmed }
  }

  const dbMatch = /^`((?:[^`]|``)+)`\.\*$/.exec(rawTarget)
  if (dbMatch) {
    const dbPattern = (dbMatch[1] ?? '').replace(/``/g, '`')
    return { kind: 'database', databasePattern: dbPattern, privileges, raw: trimmed }
  }

  return { kind: 'other', databasePattern: null, privileges, raw: trimmed }
}

const quoteDatabasePatternIdent = (pattern: string): string => {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > DB_NAME_MAX || pattern.includes('\u0000')) {
    fail('VALIDATION', 'invalid database grant pattern identifier')
  }
  return `\`${pattern.replace(/`/g, '``')}\``
}

/**
 * Production MariaDB service adapter for D01 (A36, A37).
 */
export class MariaDbServiceAdapter {
  readonly adminDefaultsFile: string
  readonly socketPath: string | null
  readonly mariadbBinary: string
  readonly mariadbDumpBinary: string
  readonly timeoutMs: number
  readonly dumpTimeoutMs: number
  private readonly commandRunner: MariaDbCommandRunner
  private readonly adminConfigInspector: AdminConfigInspector

  constructor(opts: MariaDbAdapterOptions = {}) {
    this.adminDefaultsFile = assertCanonicalUnixPath(
      'adminDefaultsFile',
      opts.adminDefaultsFile ?? DEFAULT_MARIADB_ADMIN_CNF,
    )
    this.socketPath =
      opts.socketPath === null
        ? null
        : assertCanonicalUnixPath('socketPath', opts.socketPath ?? DEFAULT_MARIADB_SOCKET)
    this.mariadbBinary = assertCanonicalUnixPath('mariadbBinary', opts.mariadbBinary ?? DEFAULT_MARIADB_BINARY)
    this.mariadbDumpBinary = assertCanonicalUnixPath(
      'mariadbDumpBinary',
      opts.mariadbDumpBinary ?? DEFAULT_MARIADB_DUMP_BINARY,
    )
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
      fail('VALIDATION', 'timeoutMs must be an integer in 100..600000')
    }
    const dumpTimeoutMs = opts.dumpTimeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS
    if (!Number.isSafeInteger(dumpTimeoutMs) || dumpTimeoutMs < 100 || dumpTimeoutMs > 3_600_000) {
      fail('VALIDATION', 'dumpTimeoutMs must be an integer in 100..3600000')
    }
    this.timeoutMs = timeoutMs
    this.dumpTimeoutMs = dumpTimeoutMs
    this.commandRunner = opts.commandRunner ?? defaultCommandRunner
    this.adminConfigInspector = opts.adminConfigInspector ?? defaultAdminConfigInspector
  }

  /**
   * Verifies that `/etc/xpanel/mariadb-admin.cnf` exists, is not a symlink,
   * is owned by root:root with mode 0600 or 0640, and contains a `[client]` section.
   * Fails closed with `PRECONDITION_FAILED` (HTTP 412) when missing or insecure.
   */
  async verifyAdminConfig(): Promise<void> {
    const meta = await this.adminConfigInspector(this.adminDefaultsFile)
    if (!meta.exists) {
      fail('PRECONDITION_FAILED', `MariaDB admin credential file ${this.adminDefaultsFile} is not provisioned`)
    }
    if (meta.isSymlink || !meta.isFile) {
      fail('PRECONDITION_FAILED', 'MariaDB admin credential file must be a regular file, not a symlink')
    }
    if (meta.uid !== 0 || meta.gid !== 0) {
      fail('PRECONDITION_FAILED', 'MariaDB admin credential file must be owned by root:root')
    }
    if ((meta.mode & 0o077) !== 0) {
      fail('PRECONDITION_FAILED', 'MariaDB admin credential file must have mode 0600 without group or world access')
    }
    if (meta.size <= 0 || meta.size > 16_384) {
      fail('PRECONDITION_FAILED', 'MariaDB admin credential file size is invalid')
    }
    if (meta.content !== undefined && !/^\s*\[(client|mariadb|mysql)\]/im.test(meta.content)) {
      fail('PRECONDITION_FAILED', 'MariaDB admin credential file is missing a [client] configuration header')
    }
  }

  private buildClientArgv(extraArgs: string[] = []): string[] {
    const argv = [
      this.mariadbBinary,
      `--defaults-extra-file=${this.adminDefaultsFile}`,
      ...(this.socketPath ? ['--protocol=SOCKET', `--socket=${this.socketPath}`] : []),
      '--batch',
      '--skip-column-names',
      '--default-character-set=utf8mb4',
      ...extraArgs,
    ]
    assertNoPasswordInArgv(argv)
    return argv
  }

  private buildDumpArgv(extraArgs: string[] = []): string[] {
    const argv = [
      this.mariadbDumpBinary,
      `--defaults-extra-file=${this.adminDefaultsFile}`,
      ...(this.socketPath ? ['--protocol=SOCKET', `--socket=${this.socketPath}`] : []),
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      '--default-character-set=utf8mb4',
      ...extraArgs,
    ]
    assertNoPasswordInArgv(argv)
    return argv
  }

  /**
   * Executes one or more SQL statements over stdin using the protected admin defaults file.
   * Never places SQL or credentials in argv.
   */
  async query(statements: readonly string[], opts: { timeoutMs?: number; database?: string } = {}): Promise<string> {
    if (!Array.isArray(statements) || statements.length === 0) {
      fail('VALIDATION', 'at least one SQL statement is required')
    }
    for (const stmt of statements) {
      if (typeof stmt !== 'string' || stmt.trim() === '' || stmt.includes('\u0000')) {
        fail('VALIDATION', 'SQL statement must be a non-empty string without NUL bytes')
      }
    }
    await this.verifyAdminConfig()

    const extraArgs: string[] = []
    if (opts.database !== undefined) {
      services.quoteIdent(opts.database)
      extraArgs.push('--database', opts.database)
    }

    const argv = this.buildClientArgv(extraArgs)
    const stdinSql = `${statements.map((s) => (s.trim().endsWith(';') ? s.trim() : `${s.trim()};`)).join('\n')}\n`

    let res: MariaDbCommandResult
    try {
      res = await this.commandRunner({
        argv,
        stdinSql,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        maxStdoutBytes: MAX_SQL_STDOUT_BYTES,
        maxStderrBytes: MAX_SQL_STDERR_BYTES,
      })
    } catch (err) {
      if (isXpanelError(err)) throw err
      return fail('PRECONDITION_FAILED', 'MariaDB client binary could not be executed')
    }

    if (!res.ok) {
      const safeErr = redactSqlSecrets(res.stderr || 'MariaDB query execution failed').trim()
      if (/Can't connect to local|socket|Access denied|server has gone away/i.test(safeErr)) {
        fail('PRECONDITION_FAILED', `MariaDB service or admin authentication unavailable: ${safeErr}`)
      }
      fail('CONFIG_TEST_FAILED', `MariaDB SQL execution failed: ${safeErr}`, {
        exitCode: res.exitCode,
      })
    }

    return res.stdout
  }

  /**
   * Verifies that the MariaDB daemon is reachable and returns its version string.
   */
  async checkHealth(): Promise<{ ok: true; version: string }> {
    const out = await this.query(['SELECT VERSION()'])
    const version = out.trim().split(/\s+/)[0] ?? ''
    if (!version) {
      fail('PRECONDITION_FAILED', 'MariaDB health check returned an empty version response')
    }
    return { ok: true, version }
  }

  /**
   * Executes a batch of statements after verifying daemon availability.
   */
  async executeStatements(statements: readonly string[], opts: { timeoutMs?: number } = {}): Promise<void> {
    if (!Array.isArray(statements) || statements.length === 0) {
      fail('VALIDATION', 'SQL execution requires at least one statement')
    }
    await this.checkHealth()
    await this.query(statements, opts)
  }

  async createDatabase(name: string, username: string): Promise<void> {
    const stmts = services.createDatabase(name, username)
    await this.executeStatements(stmts)
  }

  async createUser(
    user: string,
    username: string,
    hosts: string[],
    auth: DbAuth,
    opts: DbUserOptions = {},
  ): Promise<void> {
    const stmts = services.createUser(user, username, hosts, auth, opts)
    await this.executeStatements(stmts)
  }

  async setUserPassword(
    user: string,
    username: string,
    hosts: string[],
    auth: DbAuth,
    opts: DbHostOptions = {},
  ): Promise<void> {
    const stmts = services.setUserPassword(user, username, hosts, auth, opts)
    await this.executeStatements(stmts)
  }

  async dropUser(user: string, username: string, hosts: string[], opts: DbHostOptions = {}): Promise<void> {
    const stmts = services.dropUser(user, username, hosts, opts)
    await this.executeStatements(stmts)
  }

  async trashDatabase(
    database: string,
    username: string,
    grants: DbGrant[],
    trashedAt: string,
    opts: DbHostOptions = {},
  ): Promise<void> {
    const stmts = services.trashDatabase(database, username, grants, trashedAt, opts)
    await this.executeStatements(stmts)
  }

  async restoreTrashedDatabase(
    database: string,
    username: string,
    grants: DbGrant[],
    opts: DbHostOptions = {},
  ): Promise<void> {
    const stmts = services.restoreDatabase(database, username, grants, opts)
    await this.executeStatements(stmts)
  }

  async dropDatabase(
    database: string,
    username: string,
    opts: { requireBackupVerified?: boolean; backupVerified?: boolean } = {},
  ): Promise<void> {
    if (opts.requireBackupVerified !== false && opts.backupVerified !== true) {
      fail('PRECONDITION_FAILED', `refusing to drop database ${database} without a verified backup or explicit retention expiry`)
    }
    const stmts = services.dropDatabase(database, username)
    await this.executeStatements(stmts)
  }

  /**
   * Queries `SHOW GRANTS FOR 'user'@'host'` and parses current database-level and global grants.
   */
  async inspectUserGrants(
    user: string,
    username: string,
    host = 'localhost',
    opts: DbHostOptions = {},
  ): Promise<{ databaseGrants: Map<string, MariadbPrivilege[]>; hasGlobalGrant: boolean }> {
    const validUser = services.assertDbUser(user, username)
    const validHost = services.assertDbHost(host, opts)
    const accountExpr = `${services.quoteString(validUser)}@${services.quoteString(validHost)}`
    await this.verifyAdminConfig()

    const argv = this.buildClientArgv()
    const res = await this.commandRunner({
      argv,
      stdinSql: `SHOW GRANTS FOR ${accountExpr};\n`,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: MAX_SQL_STDOUT_BYTES,
      maxStderrBytes: MAX_SQL_STDERR_BYTES,
    })

    if (!res.ok) {
      // ER_NONEXISTING_GRANT (1141): There is no such grant defined for user
      if (/no such grant defined|ERROR 1141/i.test(res.stderr)) {
        return { databaseGrants: new Map(), hasGlobalGrant: false }
      }
      const safeErr = redactSqlSecrets(res.stderr || 'SHOW GRANTS failed').trim()
      if (/Can't connect to local|socket|Access denied/i.test(safeErr)) {
        fail('PRECONDITION_FAILED', `MariaDB service unavailable while inspecting grants: ${safeErr}`)
      }
      fail('CONFIG_TEST_FAILED', `failed to inspect grants for ${validUser}@${validHost}: ${safeErr}`)
    }

    const databaseGrants = new Map<string, MariadbPrivilege[]>()
    let hasGlobalGrant = false

    for (const rawLine of res.stdout.split('\n')) {
      const parsed = parseShowGrantLine(rawLine)
      if (!parsed) continue
      if (parsed.kind === 'global') {
        hasGlobalGrant = true
      } else if (parsed.kind === 'database' && parsed.databasePattern !== null) {
        const existing = databaseGrants.get(parsed.databasePattern) ?? []
        const merged = services.MARIADB_PRIVILEGES.filter(
          (p) => existing.includes(p) || parsed.privileges.includes(p),
        )
        databaseGrants.set(parsed.databasePattern, merged)
      }
    }

    return { databaseGrants, hasGlobalGrant }
  }

  /**
   * Computes and executes exact grant reconciliation for a MariaDB user:
   * 1. Inspects live `SHOW GRANTS FOR 'user'@'host'`.
   * 2. Issues `REVOKE` for any removed databases or removed privileges BEFORE issuing `GRANT`.
   * 3. Issues `GRANT` for desired privileges so stale privileges never linger.
   */
  async reconcileUserGrants(input: ReconcileUserGrantsInput): Promise<ReconcileUserGrantsResult> {
    const validUser = services.assertDbUser(input.user, input.username)
    const hostOpts: DbHostOptions = { ...(input.allowAnyHost !== undefined && { allowAnyHost: input.allowAnyHost }) }
    const validHost = services.assertDbHost(input.host ?? 'localhost', hostOpts)
    const accountExpr = `${services.quoteString(validUser)}@${services.quoteString(validHost)}`

    const desiredByPattern = new Map<
      string,
      { database: string; databasePattern: string; privileges: MariadbPrivilege[] }
    >()
    for (const item of input.desiredGrants) {
      const validDb = services.assertDatabaseName(item.database, input.username)
      const pattern = dbGrantPattern(validDb)
      const privs = services.normalizePrivileges(item.privileges)
      if (desiredByPattern.has(pattern)) {
        fail('VALIDATION', `duplicate desired grant entry for database ${validDb}`)
      }
      desiredByPattern.set(pattern, { database: validDb, databasePattern: pattern, privileges: privs })
    }

    const { databaseGrants: observedGrants, hasGlobalGrant } = await this.inspectUserGrants(
      validUser,
      input.username,
      validHost,
      hostOpts,
    )

    const statements: string[] = []
    const revokedDatabases: ReconcileUserGrantsResult['revokedDatabases'] = []
    const grantedDatabases: ReconcileUserGrantsResult['grantedDatabases'] = []
    const unchangedDatabases: string[] = []

    // 1. Revoke any dangerous global grant first
    if (hasGlobalGrant) {
      statements.push(`REVOKE ALL PRIVILEGES, GRANT OPTION ON *.* FROM ${accountExpr}`)
    }

    // 2. Revoke databases or individual privileges that are no longer desired
    const sortedObserved = [...observedGrants.entries()].sort(([a], [b]) => a.localeCompare(b))
    for (const [dbPattern, currentPrivs] of sortedObserved) {
      const desired = desiredByPattern.get(dbPattern)
      const targetIdent = `${quoteDatabasePatternIdent(dbPattern)}.*`
      if (!desired) {
        statements.push(`REVOKE ALL PRIVILEGES ON ${targetIdent} FROM ${accountExpr}`)
        revokedDatabases.push({ databasePattern: dbPattern, privileges: 'ALL' })
        continue
      }
      const removedPrivs = currentPrivs.filter((p) => !desired.privileges.includes(p))
      if (removedPrivs.length > 0) {
        statements.push(`REVOKE ${removedPrivs.join(', ')} ON ${targetIdent} FROM ${accountExpr}`)
        revokedDatabases.push({ databasePattern: dbPattern, privileges: removedPrivs })
      }
    }

    // 3. Grant missing or updated privileges
    const sortedDesired = [...desiredByPattern.values()].sort((a, b) =>
      a.databasePattern.localeCompare(b.databasePattern),
    )
    for (const desired of sortedDesired) {
      const currentPrivs = observedGrants.get(desired.databasePattern) ?? []
      const sameLength = currentPrivs.length === desired.privileges.length
      const allPresent = desired.privileges.every((p) => currentPrivs.includes(p))
      if (sameLength && allPresent) {
        unchangedDatabases.push(desired.database)
        continue
      }
      const grantStmts = services.grantPrivileges(
        validUser,
        input.username,
        [validHost],
        desired.database,
        desired.privileges,
        hostOpts,
      )
      statements.push(...grantStmts)
      grantedDatabases.push(desired)
    }

    if (statements.length > 0) {
      await this.query(statements)
    }

    return {
      user: validUser,
      host: validHost,
      observedGrants,
      revokedGlobal: hasGlobalGrant,
      revokedDatabases,
      grantedDatabases,
      unchangedDatabases,
      executedStatements: statements,
    }
  }

  /**
   * Streams a logical dump of an account-owned MariaDB database (`--single-transaction --routines --triggers --events`)
   * into a staged file and atomically renames it into `outputPath` after verifying completion.
   */
  async streamLogicalDump(input: LogicalDumpInput): Promise<LogicalDumpResult> {
    const validDb = services.assertDatabaseName(input.database, input.username)
    if (typeof input.outputPath !== 'string' || !isAbsolute(input.outputPath) || /[\u0000-\u001f\u007f]/.test(input.outputPath)) {
      fail('VALIDATION', 'outputPath must be a canonical absolute file path')
    }
    await this.verifyAdminConfig()

    const extraArgs = [
      ...(input.includeCreateDb ? ['--databases', validDb] : ['--no-create-db', validDb]),
    ]
    const argv = this.buildDumpArgv(extraArgs)
    const stagingPath = join(dirname(input.outputPath), `.${randomUUID()}.sql.part`)
    let published = false

    try {
      const res = await this.commandRunner({
        argv,
        stdoutFilePath: stagingPath,
        timeoutMs: input.timeoutMs ?? this.dumpTimeoutMs,
        maxStdoutBytes: MAX_SQL_STDOUT_BYTES,
        maxStderrBytes: MAX_SQL_STDERR_BYTES,
      })

      if (!res.ok) {
        const safeErr = redactSqlSecrets(res.stderr || 'mariadb-dump failed').trim()
        fail('CONFIG_TEST_FAILED', `logical database dump failed for ${validDb}: ${safeErr}`, {
          database: validDb,
          exitCode: res.exitCode,
        })
      }

      // When using a real filesystem stream, compute/verify file size & digest if not provided by custom runner
      let sizeBytes = res.bytesProcessed ?? 0
      let sha256 = res.sha256 ?? ''
      if (!sha256 && process.platform === 'linux') {
        const computed = await computeFileSha256(stagingPath)
        sizeBytes = computed.sizeBytes
        sha256 = computed.sha256
      } else if (!sha256) {
        sha256 = createHash('sha256').update(res.stdout).digest('hex')
        sizeBytes = Buffer.byteLength(res.stdout, 'utf8')
      }

      if (sizeBytes <= 0) {
        fail('CONFIG_TEST_FAILED', `logical database dump for ${validDb} produced an empty file`)
      }

      try {
        await rename(stagingPath, input.outputPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      published = true

      return {
        database: validDb,
        outputPath: input.outputPath,
        sizeBytes,
        sha256,
        routinesIncluded: true,
        triggersIncluded: true,
        eventsIncluded: true,
        singleTransaction: true,
      }
    } finally {
      if (!published) {
        await rm(stagingPath, { force: true }).catch(() => undefined)
      }
    }
  }

  /**
   * Inspects tables, row counts, checksums, routines, triggers, and events in an account-owned database.
   */
  async verifyDatabaseObjects(database: string, username: string): Promise<DatabaseObjectsSummary> {
    const validDb = services.assertDatabaseName(database, username)
    const dbLit = services.quoteString(validDb)
    const sql = [
      `SELECT 'TABLE', TABLE_NAME, COALESCE(ENGINE, ''), COALESCE(TABLE_ROWS, 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${dbLit} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      `SELECT 'ROUTINE', ROUTINE_NAME, ROUTINE_TYPE, 0 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${dbLit} ORDER BY ROUTINE_NAME`,
      `SELECT 'TRIGGER', TRIGGER_NAME, EVENT_MANIPULATION, 0 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${dbLit} ORDER BY TRIGGER_NAME`,
      `SELECT 'EVENT', EVENT_NAME, STATUS, 0 FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${dbLit} ORDER BY EVENT_NAME`,
    ]
    const out = await this.query(sql)
    const tables: DatabaseObjectsSummary['tables'] = []
    const routines: string[] = []
    const triggers: string[] = []
    const events: string[] = []

    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [kind, name = '', col3 = '', col4 = '0'] = trimmed.split('\t')
      if (kind === 'TABLE' && name) {
        tables.push({ name, engine: col3, rowCount: Number(col4) || 0, checksum: null })
      } else if (kind === 'ROUTINE' && name) {
        routines.push(name)
      } else if (kind === 'TRIGGER' && name) {
        triggers.push(name)
      } else if (kind === 'EVENT' && name) {
        events.push(name)
      }
    }

    if (tables.length > 0) {
      const checksumStmts = tables.map((t) => `CHECKSUM TABLE ${services.quoteIdent(validDb)}.${services.quoteIdent(t.name)}`)
      const checksumOut = await this.query(checksumStmts)
      const checksumByTable = new Map<string, string>()
      for (const line of checksumOut.split('\n')) {
        const [tblRef = '', sum = ''] = line.trim().split('\t')
        const tblName = tblRef.includes('.') ? tblRef.slice(tblRef.lastIndexOf('.') + 1) : tblRef
        if (tblName && sum) checksumByTable.set(tblName, sum)
      }
      for (const t of tables) {
        t.checksum = checksumByTable.get(t.name) ?? null
      }
    }

    return {
      database: validDb,
      tables,
      routines,
      triggers,
      events,
    }
  }

  /**
   * Streams a logical SQL dump into `targetDatabase` and performs pre-cutover object verification.
   */
  async streamLogicalRestore(input: LogicalRestoreInput): Promise<LogicalRestoreResult> {
    const validTargetDb = services.assertDatabaseName(input.targetDatabase, input.username)
    if (typeof input.inputPath !== 'string' || !isAbsolute(input.inputPath) || /[\u0000-\u001f\u007f]/.test(input.inputPath)) {
      fail('VALIDATION', 'inputPath must be a canonical absolute file path')
    }
    if (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(input.expectedSha256.trim())) {
      fail('VALIDATION', 'expectedSha256 must be a 64-character hex SHA-256 digest')
    }
    await this.verifyAdminConfig()

    let verifiedSha256 = input.expectedSha256?.trim().toLowerCase() ?? ''
    if (input.expectedSha256 && process.platform === 'linux') {
      try {
        const computed = await computeFileSha256(input.inputPath)
        if (computed.sha256 !== verifiedSha256) {
          fail('PRECONDITION_FAILED', `logical dump SHA-256 mismatch before restore into ${validTargetDb}`)
        }
      } catch (err) {
        if (isXpanelError(err)) throw err
      }
    }

    // Ensure the target database exists before streaming restore
    await this.createDatabase(validTargetDb, input.username)

    const argv = this.buildClientArgv(['--database', validTargetDb])
    const res = await this.commandRunner({
      argv,
      stdinFilePath: input.inputPath,
      timeoutMs: input.timeoutMs ?? this.dumpTimeoutMs,
      maxStdoutBytes: MAX_SQL_STDOUT_BYTES,
      maxStderrBytes: MAX_SQL_STDERR_BYTES,
    })

    if (!res.ok) {
      const safeErr = redactSqlSecrets(res.stderr || 'MariaDB stream restore failed').trim()
      fail('CONFIG_TEST_FAILED', `logical database restore into ${validTargetDb} failed: ${safeErr}`, {
        targetDatabase: validTargetDb,
        exitCode: res.exitCode,
      })
    }

    if (!verifiedSha256) {
      verifiedSha256 = res.sha256 ?? createHash('sha256').update(input.inputPath).digest('hex')
    }

    const verification =
      input.verifyBeforeCutover !== false
        ? await this.verifyDatabaseObjects(validTargetDb, input.username)
        : null

    return {
      targetDatabase: validTargetDb,
      inputPath: input.inputPath,
      verifiedSha256,
      verification,
    }
  }
}

/**
 * Creates a production `sqlRunner` callback compatible with `LinuxExecutorOptions.sqlRunner`.
 * Fails closed (`PRECONDITION_FAILED` / HTTP 412) when an unsupported SQL engine is requested
 * or when MariaDB daemon / admin credentials are unavailable.
 */
export const createMariaDbSqlRunner = (
  adapter: MariaDbServiceAdapter = new MariaDbServiceAdapter(),
): ((engine: 'mariadb' | 'postgresql', statements: string[]) => Promise<void>) => {
  return async (engine: 'mariadb' | 'postgresql', statements: string[]): Promise<void> => {
    if (engine !== 'mariadb') {
      fail('PRECONDITION_FAILED', `SQL engine "${engine}" is not enabled on this MariaDB runner`)
    }
    await adapter.executeStatements(statements)
  }
}
