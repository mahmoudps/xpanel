import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'vitest'
import { assertInstallFinalizationExclusivePhysicalHeld } from './lifecycle-admission.mjs'

// Executes the production orchestration functions with isolated admission/DB ports.
// This is connection-lifetime regression evidence, never native acceptance or a
// ready-shaped provider. No platform spoof, server, SQLite file or authority mint.
const source = await readFile(new URL('./install-finalization-native.mjs', import.meta.url), 'utf8')
const section = (from: string, to: string) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert(start >= 0 && end > start, 'production orchestration section exists')
  return source.slice(start, end)
}
function harness() {
  const events: string[] = [], active = new AsyncLocalStorage<unknown>()
  let held: 'none' | 'SH' | 'EX' = 'none', readerLive = false, writerLive = false, stateLive = false
  const check = (v: unknown, code: string) => { if (!v) throw new Error(code) }
  const origin = { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: 'issuer' }
  let currentOrigin = { ...origin }, principal = { id: 'root-id', username: 'root', kind: 'root', disabled: false, forcePasswordChange: false }
  const assertSH = async () => { check(held === 'SH', 'physical SH required') }
  const assertEX = async () => { check(held === 'EX', 'physical EX required') }
  const reader = { query: async () => [{ id: principal.id }], transaction: async (run: (tx: unknown) => unknown) => run(reader) }
  const writer = { query: reader.query, transaction: async (run: (tx: unknown) => unknown) => run(writer) }
  const dbApi = {
    getReadonlyOperationDatabaseOrigin(db: unknown) { check(readerLive && db === reader, 'actual reader required'); return currentOrigin },
    getStrictOperationDatabaseOrigin(db: unknown) { check(writerLive && db === writer, 'actual writer required'); return currentOrigin },
    getPrincipal: async () => ({ ...principal }),
    assertReadonlyOperationDatabaseCurrent: async () => check(readerLive, 'reader retired'),
    async withReadonlyOperationDatabase(_path: string, run: (db: unknown) => Promise<unknown>) {
      await assertSH(); check(!writerLive && !readerLive, 'overlapping database connection')
      readerLive = true; events.push('reader:open')
      try { return await run(reader) } finally { readerLive = false; events.push('reader:close') }
    },
    createDb() {
      check(held !== 'none' && !readerLive && !writerLive, 'writer before admission or overlapping reader')
      writerLive = true; events.push('writer:open:' + held)
      return { db: writer, close: async () => { writerLive = false; events.push('writer:close:' + held) } }
    },
    async withHostOperationGuard(db: unknown, _options: unknown, run: (guard: unknown) => Promise<unknown>) {
      check(writerLive && db === writer && held === 'EX', 'guard requires admitted writer')
      events.push('guard:open'); try { return await run({}) } finally { events.push('guard:close') }
    },
  }
  const scope: any = { dbApi, db: null, databaseAccess: null, phase: 'new', live: true, capability: {},
    kind: 'install', databaseInfo: { dev: 1n, ino: 2n }, origin: null, originBinding: null, root: null,
    flights: new Set(), startupDeadline: Date.now() + 60_000,
    store: {
      readSnapshot: async () => { throw new Error('recoverOrphan path must never run') },
      async withReadonlyObservation(run: (observation: any) => Promise<unknown>) {
        check(held !== 'none', 'state before admission'); stateLive = true; events.push('state:open')
        try { return await run({ snapshot: { accounts: [], revision: 1, checksum: 'state' }, assertCurrent: async () => check(stateLive, 'state retired') }) }
        finally { stateLive = false; events.push('state:close') }
      },
    },
  }
  const withSH = async (run: () => Promise<unknown>) => {
    check(held === 'none', 'nested admission'); held = 'SH'; events.push('SH:open')
    try { return await run() } finally { check(!readerLive && !writerLive && !stateLive, 'resource crossed SH retirement'); held = 'none'; events.push('SH:close') }
  }
  const withEX = async (_cap: unknown, run: () => Promise<unknown>) => {
    check(held === 'none' && !readerLive && !writerLive && !stateLive, 'resource crossed SH to EX')
    held = 'EX'; events.push('EX:open')
    try { return await run() } finally { check(!readerLive && !writerLive && !stateLive, 'resource crossed EX retirement'); held = 'none'; events.push('EX:close') }
  }
  const bindingFor = (v: typeof origin) => ({ databaseFile: v.file, databaseDevice: v.device, databaseInode: v.inode, issuerId: v.issuerId })
  const implementation = section('async function assertDatabasePhase(', 'async function rootInTransaction(')
    + section('async function rootInTransaction(', 'function assertCompletionScope(')
    + section('async function readScopeSnapshot(', 'async function assertCapturedInstallSource(')
    + section('function ports(scope)', 'export async function runNativeInstallFinalization(')
  const api = new Function('check', 'assertBase', 'assertLifecycleWriterAdmissionHeld', 'assertInstallFinalizationExclusivePhysicalHeld',
    'DATABASE', 'canonical', 'bindingFor', 'active', 'withLifecycleWriterAdmission', 'withInstallFinalizationExclusiveAdmission', 'nativeFilesystem',
    implementation + '\nreturn { ports, withFinalizationReadonlyDatabase, withFinalizationWriterDatabase, readScopeSnapshot, rootInTransaction }')(
      check, async (s: unknown) => check(s === scope && scope.live, 'native scope missing'), assertSH, assertEX,
      origin.file, JSON.stringify, bindingFor, active, withSH, withEX, () => ({}))
  return { api, scope, events, withSH, withEX, setOrigin: (value: typeof origin) => { currentOrigin = value }, origin,
    setPrincipal: (value: typeof principal) => { principal = value }, principal }
}

describe('finalization connection lifetime under actual orchestration with isolated ports', () => {
  it('keeps the native EX assertion branded and refuses fake capabilities before IO', async () => {
    for (const capability of [null, {}, { phase: 'held', root: true }]) {
      await assert.rejects(assertInstallFinalizationExclusivePhysicalHeld(capability), /INSTALL_FINALIZATION_EXCLUSIVE_REQUIRED/)
    }
  })
  it('has no second factory writable-open or mutating StateStore read outside the guarded helpers', () => {
    assert.equal(source.match(/\.createDb\(/g)?.length, 1)
    assert.equal(source.match(/\.readSnapshot\(/g)?.length ?? 0, 0)
    assert(!section('async function runNativeFinalization(', '\n  return output\n}').includes('.createDb('))
  })
  it('rejects writable open and state recovery before admission for both entry kinds', async () => {
    for (const kind of ['install', 'adopt']) {
      const h = harness(); h.scope.kind = kind; h.scope.phase = 'capturing'
      await assert.rejects(h.api.withFinalizationWriterDatabase(h.scope, async () => {}), /physical SH required/)
      await assert.rejects(h.api.withFinalizationReadonlyDatabase(h.scope, async () => {}), /physical SH required/)
      await assert.rejects(h.api.readScopeSnapshot(h.scope), /physical SH required/)
      assert.deepEqual(h.events, [])
    }
  })
  it('closes readonly DB and state before EX, then opens writer before the host guard', async () => {
    const h = harness(), p = h.api.ports(h.scope)
    await p.withSharedAdmission(async () => {
      await h.api.readScopeSnapshot(h.scope)
      await h.scope.db.transaction((tx: unknown) => h.api.rootInTransaction(h.scope, tx))
      h.scope.context = {}; h.scope.observation = {}; h.events.push('captured')
    })
    assert.equal(h.scope.db, null)
    await p.withExclusiveAdmission(async () => { h.events.push('effect:EX') })
    assert.deepEqual(h.events, ['SH:open', 'reader:open', 'state:open', 'state:close', 'captured', 'reader:close', 'SH:close',
      'EX:open', 'writer:open:EX', 'guard:open', 'effect:EX', 'guard:close', 'writer:close:EX', 'EX:close'])
  })
  it('closes startup writer in its separate SH before the readiness reader or EX', async () => {
    const h = harness(); h.scope.phase = 'capturing'
    await h.withSH(() => h.api.withFinalizationWriterDatabase(h.scope, async () => { h.events.push('startup:effect') }))
    h.scope.phase = 'new'
    await h.api.ports(h.scope).withSharedAdmission(async () => { h.events.push('readiness') })
    assert(h.events.indexOf('state:close') < h.events.indexOf('writer:open:SH'))
    assert(h.events.indexOf('writer:close:SH') < h.events.indexOf('SH:close'))
    assert(h.events.indexOf('SH:close') < h.events.indexOf('reader:open'))
    assert(h.events.indexOf('reader:open') < h.events.indexOf('readiness'))
  })
  it('forbids the startup write exception for populated adoption and retains the fresh zero-account gate', async () => {
    const h = harness(); h.scope.phase = 'capturing'; h.scope.kind = 'adopt'
    await assert.rejects(h.withSH(() => h.api.withFinalizationWriterDatabase(h.scope, async () => {})), /INSTALL_STARTUP_SCOPE_REQUIRED/)
    h.scope.kind = 'install'
    h.scope.store.withReadonlyObservation = async (run: any) => run({ snapshot: { accounts: [{}] }, assertCurrent: async () => {} })
    await assert.rejects(h.withSH(() => h.api.withFinalizationWriterDatabase(h.scope, async () => {})), /INSTALL_FINALIZATION_STATE_CHANGED/)
    assert(!h.events.some(event => event.startsWith('writer:open')))
  })
  it('revalidates persisted origin and root when EX reopens, closing a rejected writer before effects', async () => {
    for (const change of ['origin', 'root']) {
      const h = harness(), p = h.api.ports(h.scope)
      await p.withSharedAdmission(async () => { h.scope.context = {}; h.scope.observation = {} })
      if (change === 'origin') h.setOrigin({ ...h.origin, issuerId: 'replacement' })
      else h.setPrincipal({ ...h.principal, id: 'replacement' })
      await assert.rejects(p.withExclusiveAdmission(async () => { throw new Error('effect must not run') }), /INSTALL_FINALIZATION_(DATABASE|ROOT)_CHANGED/)
      assert.equal(h.scope.db, null)
      assert(!h.events.includes('guard:open'))
      assert(h.events.includes('writer:close:EX'))
    }
  })
  it('retires DB/state scopes on thrown capture and EX callback without leaking into a successor', async () => {
    const h = harness()
    await assert.rejects(h.api.ports(h.scope).withSharedAdmission(async () => { await h.api.readScopeSnapshot(h.scope); throw new Error('capture failed') }), /capture failed/)
    assert.equal(h.scope.db, null); assert.equal(h.events.at(-1), 'SH:close')
    h.scope.context = {}; h.scope.observation = {}
    await assert.rejects(h.api.ports(h.scope).withExclusiveAdmission(async () => { throw new Error('effect failed') }), /effect failed/)
    assert.equal(h.scope.db, null); assert.equal(h.events.at(-1), 'EX:close')
  })
})
