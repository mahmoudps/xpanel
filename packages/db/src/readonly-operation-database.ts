import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, fstatSync, lstatSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite'
import { assertId, fail, XpanelError } from '@xpanel/core'
import { matchesReviewedOperationalMigrations, OPERATIONAL_SCHEMA_VERSION, type OperationalMigrationMode } from './schema.ts'
import { assertMigrationMode, bindMigrationMode, effectiveMigrationMode } from './migration-mode.ts'
import { assertNoActiveDatabaseTransaction, type Row, type SqlRunner, type StrictOperationDatabaseOrigin } from './sql-runner.ts'
import { lexSql } from './sql-lexer.ts'

const readonlyBrand: unique symbol = Symbol('readonlyOperationDatabase')
/** Separate native identity: never registered as a writable/strict transaction runner. */
export interface ReadonlyOperationDatabase extends SqlRunner { readonly [readonlyBrand]: true }
const scopes = new WeakMap<object, Scope>(), current = new AsyncLocalStorage<Scope>()
const prepare = DatabaseSync.prototype.prepare, execute = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close
const iterate = StatementSync.prototype.iterate
const refused = (reason: string): never => fail('PRECONDITION_FAILED', 'read-only operation database observation refused', { reason, stateChanged: false })
const walCollisions = new WeakMap<XpanelError, symbol>()
interface Pin { path: string; handle: FileHandle; initial: BigIntStats }
interface Scope { live: boolean; origin: Readonly<StrictOperationDatabaseOrigin>; verify(): void; verifyAsync(): Promise<void>; inTransaction: boolean }
interface ClosedDatabaseProof { origin: Readonly<StrictOperationDatabaseOrigin>; assertCurrent(): Promise<void>; assertScope(): void }
const equal = (a: BigIntStats, b: BigIntStats, contents = false): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid
  && a.mode === b.mode && a.nlink === b.nlink && (!contents || a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)
const inputValue = (value: unknown): SQLInputValue => {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return refused('primitive_parameters_required')
}
/** Syntax restriction supplements the actual SQLITE_OPEN_READONLY connection. */
export function readonlyOperationSelect(text: string): string {
  if (typeof text !== 'string' || text.length < 1 || text.length > 65536 || text.includes('\0')) return refused('select_required')
  const parts = lexSql(text), code = parts.filter(part => part.kind === 'code').map(part => part.text).join(' ')
  if (!/^\s*SELECT\b/i.test(code) || /;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|load_extension|writefile|eval)\b/i.test(code)
    || /\bpragma_/i.test(code) || parts.some(part => part.kind === 'dollar'
      || part.kind === 'ident' && /(?:pragma_|load_extension|writefile|eval)/i.test(part.text))) return refused('single_readonly_select_required')
  return parts.map(part => part.kind === 'code' ? part.text.replace(/\$(\d+)\b/g, '?$1') : part.text).join('')
}
const registered = (db: unknown): Scope => {
  const scope = db && typeof db === 'object' ? scopes.get(db) : undefined
  if (!scope?.live || current.getStore() !== scope) return refused('unissued_or_retired_reader')
  scope.verify(); return scope
}
/** Native callbacks drop the reader store. Re-enter that same live reader; do not open another connection. */
export async function withVisibleReadonlyOperationDatabase<T>(db: unknown, callback: () => T | Promise<T>): Promise<T> {
  const scope = db && typeof db === 'object' ? scopes.get(db) : undefined
  const visible = current.getStore()
  if (typeof callback !== 'function' || !scope?.live || (visible && visible !== scope)) return refused('unissued_or_retired_reader')
  if (visible === scope) return callback()
  return current.run(scope, () => callback())
}
export function getReadonlyOperationDatabaseOrigin(db: unknown): Readonly<StrictOperationDatabaseOrigin> { return registered(db).origin }
/** Fixed lock-order assertion; only the actual registered reader/transaction can reach this state. */
export function assertReadonlyOperationDatabaseOutsideTransaction(db: unknown): void {
  if (registered(db).inTransaction) return refused('active_read_transaction')
}
export async function assertReadonlyOperationDatabaseCurrent(db: unknown): Promise<void> {
  const scope = registered(db); await scope.verifyAsync(); registered(db)
}

/** Fixed product ingress, never a caller path/URI, boolean or supplied assertion port.
 * The producer separately proves retained root intent, actual continuous EX and
 * stopped/drained writers before issuing its scope; it grants no generic writes. */
export async function withReadonlyClosedOperationDatabase<T>(capability: unknown, callback: (db: ReadonlyOperationDatabase) => Promise<T>, migrations: OperationalMigrationMode = 'complete'): Promise<T> {
  const native = await import('../../../scripts/lifecycle-admission.mjs')
  await native.assertLifecycleClosedDatabaseObservationHeld(capability)
  const info = native.getLifecycleClosedDatabaseObservationInfo(capability)
  if (info.purpose !== 'closed-database-observation' || info.database.file !== '/var/lib/xpanel/control.db') return refused('native_closed_database_scope_required')
  const baseline = JSON.stringify(info), origin = Object.freeze({ ...info.database })
  const assertScope = (): void => {
    if (JSON.stringify(native.getLifecycleClosedDatabaseObservationInfo(capability)) !== baseline) return refused('closed_database_scope_changed')
  }
  const assertCurrent = async (): Promise<void> => { assertScope(); await native.assertLifecycleClosedDatabaseObservationHeld(capability); assertScope() }
  return readOperationDatabase(origin.file, callback, migrations, { origin, assertCurrent, assertScope })
}

/** Opens only an existing canonical file. No migrations, PRAGMA setters, recovery, mutex, DDL or index writes.
 * Native consumers supply their fixed path; a path or returned origin alone grants no host-effect authority.
 * SQLite may maintain ordinary WAL reader shared-memory bookkeeping; no business/audit mutation is issued. */
export async function withReadonlyOperationDatabase<T>(path: string, callback: (db: ReadonlyOperationDatabase) => Promise<T>, migrations: OperationalMigrationMode = 'complete'): Promise<T> {
  return readOperationDatabase(path, callback, migrations)
}
/** For read-only observation callbacks. Reopen only after native WAL contention, with all pins retired. */
export async function withReobservedReadonlyOperationDatabase<T>(path: string, callback: (db: ReadonlyOperationDatabase) => Promise<T>, migrations: OperationalMigrationMode = 'complete'): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const observation = Symbol()
    try { return await readOperationDatabase(path, callback, migrations, undefined, observation) }
    catch (error) {
      if (attempt >= 3 || !(error instanceof XpanelError) || walCollisions.get(error) !== observation) throw error
    }
  }
}

async function readOperationDatabase<T>(path: string, callback: (db: ReadonlyOperationDatabase) => Promise<T>, migrations: OperationalMigrationMode, closed?: ClosedDatabaseProof, observation?: symbol): Promise<T> {
  const walCollision = (reason: string): never => {
    if (observation === undefined) return refused(reason)
    const error = new XpanelError('PRECONDITION_FAILED', 'read-only operation database observation refused', { reason, stateChanged: false })
    walCollisions.set(error, observation)
    throw error
  }
  assertNoActiveDatabaseTransaction()
  assertMigrationMode(migrations)
  if (closed) await closed.assertCurrent()
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return refused('linux_root_required')
  if (!closed && process.version !== 'v26.12.1') return refused('pinned_wal_initialization_runtime_required')
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || typeof callback !== 'function') return refused('canonical_existing_path_required')
  const pins: Pin[] = [], sidecars: Pin[] = [], file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let database: DatabaseSync | undefined, scope: Scope | undefined, verifyClosedRetirement: (() => Promise<void>) | undefined
  try {
    const initial = await file.stat({ bigint: true })
    if (!initial.isFile() || initial.nlink !== 1n || (initial.mode & 0o007n) !== 0n) return refused('protected_database_required')
    const ancestors: string[] = []
    for (let parent = dirname(path); ; parent = dirname(parent)) { ancestors.unshift(parent); if (dirname(parent) === parent) break }
    for (const parent of ancestors) {
      const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      let info: BigIntStats
      try { info = await handle.stat({ bigint: true }) } catch (error) { await handle.close(); throw error }
      pins.push({ path: parent, handle, initial: info })
      if (!info.isDirectory() || info.isSymbolicLink() || !((info.uid === 0n && (info.mode & 0o022n) === 0n)
        || (info.uid === initial.uid && info.gid === initial.gid && (info.mode & 0o007n) === 0n))) return refused('database_ancestry_unprotected')
    }
    // Read-only SQLite can otherwise initialize missing sidecars in a writable
    // directory. This observer requires an already open WAL environment; absence
    // is an availability refusal, never permission to initialize or ignore a WAL.
    for (const suffix of closed ? [] : ['-wal', '-shm']) {
      let handle: FileHandle
      try { handle = await open(path + suffix, constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refused('existing_wal_sidecars_required'); throw error }
      let info: BigIntStats
      try { info = await handle.stat({ bigint: true }) } catch (error) { await handle.close(); throw error }
      sidecars.push({ path: path + suffix, handle, initial: info })
      if (!info.isFile() || info.nlink !== 1n || info.uid !== initial.uid || info.gid !== initial.gid || (info.mode & 0o007n) !== 0n)
        return refused('database_sidecar_unprotected')
    }
    const absentSidecars = (): void => {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (lstatSync(path + suffix, { bigint: true, throwIfNoEntry: false })) return refused('closed_database_sidecar_present')
      }
    }
    const assertSidecar = (expected: BigIntStats, held: BigIntStats, named: BigIntStats, contents: boolean, reason: string): void => {
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || !equal(expected, held) || !equal(expected, named)) return refused(reason)
      if (contents && (!equal(expected, held, true) || !equal(expected, named, true))) {
        if (held.size !== expected.size || held.mtimeNs !== expected.mtimeNs) return walCollision(reason)
        return refused(reason)
      }
    }
    const physical = (): void => {
      if (closed) { closed.assertScope(); absentSidecars() }
      const held = fstatSync(file.fd, { bigint: true }), named = lstatSync(path, { bigint: true })
      if (!named.isFile() || named.isSymbolicLink() || realpathSync.native(path) !== path || !equal(initial, held, true) || !equal(initial, named, true)) return refused('database_inode_or_content_changed')
      for (const pin of pins) {
        const held = fstatSync(pin.handle.fd, { bigint: true }), named = lstatSync(pin.path, { bigint: true })
        if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !equal(pin.initial, held, Boolean(closed)) || !equal(pin.initial, named, Boolean(closed))) return refused('database_ancestor_changed')
      }
      for (const pin of sidecars) {
        const held = fstatSync(pin.handle.fd, { bigint: true }), named = lstatSync(pin.path, { bigint: true }), contents = pin.path.endsWith('-wal')
        assertSidecar(pin.initial, held, named, contents, 'database_sidecar_changed')
      }
      if (closed) absentSidecars()
    }
    physical()
    const wal = sidecars.find(pin => pin.path === path + '-wal')
    const hashWal = (expected: BigIntStats): string => {
      if (!wal || expected.size < 0n || expected.size > 2n * 1024n * 1024n * 1024n) return refused('database_wal_initialization_size_limit')
      const assertPinned = (): void => {
        const held = fstatSync(wal.handle.fd, { bigint: true }), named = lstatSync(wal.path, { bigint: true })
        assertSidecar(expected, held, named, true, 'database_wal_initialization_changed')
      }
      assertPinned()
      const hash = createHash('sha256'), block = Buffer.alloc(1024 * 1024)
      let offset = 0
      while (offset < Number(expected.size)) {
        const bytes = readSync(wal.handle.fd, block, 0, Math.min(block.length, Number(expected.size) - offset), offset)
        if (!bytes) return refused('database_wal_initialization_short_read')
        hash.update(block.subarray(0, bytes)); offset += bytes
      }
      assertPinned(); return hash.digest('hex')
    }
    const walBeforeOpenSha256 = wal ? hashWal(wal.initial) : undefined
    physical()
    const initializationDirectories = (): void => {
      for (const pin of pins) {
        const held = fstatSync(pin.handle.fd, { bigint: true }), named = lstatSync(pin.path, { bigint: true })
        if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
          // Live writers keep other files beside the database (bandwidth.json is rewritten every minute), so a changed
          // ancestor is contention like a moving WAL: a reobserved reader discards this attempt and proves a fresh one.
          || !equal(pin.initial, held, true) || !equal(pin.initial, named, true)) return walCollision('database_initialization_ancestor_changed')
      }
    }
    if (wal) initializationDirectories()
    const finishWalInitialization = (): void => {
      if (!wal) return
      // SQLite's Unix VFS fchown()s the WAL on its first root read, even when
      // UID/GID already match. After discarding all initialization reads, bind
      // fresh proof to the unchanged inode, protection, length, mtime and bytes.
      // Directory timestamps reject a temporary replacement at the same name;
      // hashes alone cannot prove that no transient byte mutation took place.
      initializationDirectories()
      const initialized = fstatSync(wal.handle.fd, { bigint: true })
      if (!equal(wal.initial, initialized) || initialized.ctimeNs < wal.initial.ctimeNs) return refused('database_wal_initialization_changed')
      if (initialized.size !== wal.initial.size || initialized.mtimeNs !== wal.initial.mtimeNs) return walCollision('database_wal_initialization_changed')
      if (hashWal(initialized) !== walBeforeOpenSha256) return refused('database_wal_initialization_changed')
      initializationDirectories()
      wal.initial = initialized
      physical()
    }
    const hashClosedFile = async (): Promise<string> => {
      physical()
      if (initial.size < 100n || initial.size > 2n * 1024n * 1024n * 1024n) return refused('closed_database_observation_size_limit')
      const hash = createHash('sha256'), block = Buffer.alloc(1024 * 1024)
      let offset = 0
      while (offset < Number(initial.size)) {
        const result = await file.read(block, 0, Math.min(block.length, Number(initial.size) - offset), offset)
        if (!result.bytesRead) return refused('closed_database_short_read')
        if (offset === 0 && (!block.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || block[18] !== 2 || block[19] !== 2)) return refused('closed_wal_header_required')
        hash.update(block.subarray(0, result.bytesRead)); offset += result.bytesRead
      }
      physical(); return hash.digest('hex')
    }
    const closedSha256 = closed ? await hashClosedFile() : undefined
    const checkClosed = async (verifyBytes = false): Promise<void> => {
      if (!closed) return
      await closed.assertCurrent(); physical()
      if (verifyBytes && await hashClosedFile() !== closedSha256) return refused('closed_database_bytes_changed')
      await closed.assertCurrent(); physical()
    }
    if (closed) { await checkClosed(); verifyClosedRetirement = () => checkClosed(true) }
    // URI processing is native Node SQLite behavior. Immutable is available only
    // after native EX/stopped proof and strict absence/header/physical/hash pins.
    const filename = closed ? pathToFileURL(path).href + '?mode=ro&immutable=1' : path
    database = new DatabaseSync(filename, { readOnly: true, timeout: 1000, allowExtension: false })
    const native = database
    const queryNative = <R extends Row = Row>(sql: string, params: readonly unknown[] = []): R[] => {
      if (params.length > 128) return refused('parameter_limit')
      const statement = Reflect.apply(prepare, native, [sql]) as StatementSync
      const rows: R[] = []
      for (const row of Reflect.apply(iterate, statement, params.map(inputValue)) as Iterable<Row>) {
        if (rows.length >= 10000) return refused('row_limit')
        rows.push({ ...row } as R)
      }
      return rows
    }
    const readOrigin = (): Readonly<StrictOperationDatabaseOrigin> => {
      physical()
      const main = queryNative('PRAGMA database_list').filter(row => row.name === 'main')
      const journal = queryNative('PRAGMA main.journal_mode')[0]?.journal_mode
      // Immutable SQLite may project DELETE although the retained file header is
      // WAL. The closed path already validated both persisted header version bytes.
      if (main.length !== 1 || main[0]?.file !== path || (closed ? !['wal', 'delete'].includes(String(journal)) : journal !== 'wal')) return refused('canonical_wal_required')
      const rows = queryNative('SELECT issuer_id,schema_version,migration_checksums_json FROM operational_identity WHERE singleton=1'), value = rows[0]
      if (rows.length !== 1 || value?.schema_version !== OPERATIONAL_SCHEMA_VERSION || !matchesReviewedOperationalMigrations(value.migration_checksums_json,
        queryNative('SELECT version,name,checksum FROM xpanel_schema_migrations ORDER BY version'), effectiveMigrationMode(migrations))) return refused('reviewed_schema_required')
      const origin = Object.freeze({ file: path, device: String(initial.dev), inode: String(initial.ino), issuerId: assertId(value.issuer_id, 'issuerId') })
      if (closed && (['file', 'device', 'inode', 'issuerId'] as const).some(key => origin[key] !== closed.origin[key])) return refused('closed_database_origin_mismatch')
      physical(); return origin
    }
    const dataVersion = (): number => {
      const value = queryNative('PRAGMA main.data_version')[0]?.data_version
      if (!Number.isSafeInteger(value) || Number(value) < 1) return refused('database_data_version_unavailable')
      return Number(value)
    }
    if (!closed) {
      // Complete the initial read transaction, discard its scalar and purge
      // unpinned pages before the final WAL reconciliation. data_version has
      // no NeedSchema flag; no pre-proof page/header value becomes authority.
      // The next strict read reloads page1 from the verified stable WAL bytes.
      dataVersion()
      queryNative('PRAGMA shrink_memory')
      finishWalInitialization()
    }
    const version = closed ? undefined : dataVersion(), origin = readOrigin()
    if (!closed && dataVersion() !== version) return walCollision('database_changed_during_capture')
    scope = { live: true, origin, inTransaction: false, verify() {
      if (!this.live || current.getStore() !== this) return refused('retired_reader')
      if (closed) closed.assertScope()
      if (!closed && dataVersion() !== version) return walCollision('database_wal_generation_changed')
      if (JSON.stringify(readOrigin()) !== JSON.stringify(origin)) return refused('database_issuer_or_schema_changed')
      if (!closed && dataVersion() !== version) return walCollision('database_wal_generation_changed')
    }, async verifyAsync() { this.verify(); await checkClosed(); this.verify() } }
    const state = scope
    const transaction = async <R>(work: (tx: SqlRunner) => Promise<R>): Promise<R> => {
      registered(reader); assertNoActiveDatabaseTransaction()
      if (state.inTransaction) return refused('nested_read_transaction')
      state.inTransaction = true
      let active = true
      const tx: SqlRunner = Object.freeze({
        async query<R extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
          if (!active || !state.inTransaction) return refused('retired_read_transaction')
          registered(tx); const rows = queryNative<R>(readonlyOperationSelect(sql), params); registered(tx); return rows
        },
        exec: async () => refused('readonly_exec_forbidden'), transaction: async () => refused('nested_read_transaction'),
      })
      scopes.set(tx, state); bindMigrationMode(tx, migrations)
      try {
        await state.verifyAsync()
        Reflect.apply(execute, native, ['BEGIN DEFERRED'])
        const value = await work(tx); registered(tx)
        Reflect.apply(execute, native, ['COMMIT']); await state.verifyAsync(); registered(reader); return value
      } catch (error) { try { Reflect.apply(execute, native, ['ROLLBACK']) } catch {} throw error }
      finally { active = false; state.inTransaction = false; scopes.delete(tx) }
    }
    const reader: ReadonlyOperationDatabase = Object.freeze({
      [readonlyBrand]: true as const,
      query: <R extends Row = Row>(sql: string, params?: readonly unknown[]) => transaction(tx => tx.query<R>(sql, params)),
      transaction, exec: async () => refused('readonly_exec_forbidden'),
    })
    scopes.set(reader, state); bindMigrationMode(reader, migrations)
    return await current.run(state, async () => { await state.verifyAsync(); const value = await callback(reader); await state.verifyAsync(); return value })
  } finally {
    if (scope) scope.live = false
    try { if (database) Reflect.apply(close, database, []); if (verifyClosedRetirement) await verifyClosedRetirement() }
    finally { const closed = await Promise.allSettled([...sidecars, ...pins].reverse().map(pin => pin.handle.close()).concat(file.close())); const failures = closed.filter(row => row.status === 'rejected'); if (failures.length) throw new AggregateError(failures.map(row => row.reason), 'read-only database pins did not retire') }
  }
}
