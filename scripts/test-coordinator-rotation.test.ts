import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { assertCoordinatorRotationContext, classifyCoordinatorRotationImage, parseCoordinatorRotationRequest } from './coordinator-rotation.mjs'

const request = () => ({ operationId: '12345678-1234-1234-1234-123456789abc', mode: 'apply' })
describe('explicit fixed coordinator rotation; portable grammar and image model only', () => {
  it.each(['apply', 'recover', 'rollback'])('keeps %s a distinct root product operation', mode => {
    expect(parseCoordinatorRotationRequest({ ...request(), mode })).toEqual({ ...request(), mode })
  })
  it.each(['unit', 'actor', 'nodePath', 'source', 'ready', 'force', 'ignoreOwnership'])('rejects caller supplied %s', key => {
    expect(() => parseCoordinatorRotationRequest({ ...request(), [key]: true })).toThrow('COORDINATOR_ROTATION_REQUEST_INVALID')
  })
  it('rejects an accessor before reading a proposed operation mode', () => {
    let read = false
    const value = request()
    Object.defineProperty(value, 'mode', { enumerable: true, get() { read = true; return 'apply' } })
    expect(() => parseCoordinatorRotationRequest(value)).toThrow('COORDINATOR_ROTATION_REQUEST_INVALID')
    expect(read).toBe(false)
  })
  it('refuses foreign images at every lost-reply point instead of selecting a convenient direction', () => {
    const previous = 'a'.repeat(64), next = 'b'.repeat(64), foreign = 'c'.repeat(64)
    expect(classifyCoordinatorRotationImage(previous, previous, next)).toBe('previous')
    expect(classifyCoordinatorRotationImage(next, previous, next)).toBe('next')
    for (const actual of [foreign, null, Object(previous), '../unit']) expect(classifyCoordinatorRotationImage(actual, previous, next)).toBe('foreign')
  })
})

describe('a rotation rollback never selects the previous helper over a migrated database', () => {
  it('binds the journal to the HEAD every upgrade rewrites before its migrate phase', () => {
    const origin = { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: '12345678-1234-1234-1234-123456789abc' }
    const intent = { origin, installedReceiptSha256: 'a'.repeat(64), headSha256: 'b'.repeat(64) }
    expect(() => assertCoordinatorRotationContext(intent, { origin, installedReceiptSha256: 'a'.repeat(64), headSha256: 'b'.repeat(64) })).not.toThrow()
    for (const changed of [{ headSha256: 'c'.repeat(64) }, { installedReceiptSha256: 'c'.repeat(64) }, { origin: { ...origin, inode: '3' } }])
      expect(() => assertCoordinatorRotationContext(intent, { origin, installedReceiptSha256: 'a'.repeat(64), headSha256: 'b'.repeat(64), ...changed })).toThrow('COORDINATOR_ROTATION_CONTEXT_CHANGED')
    const rotation = readFileSync(new URL('./coordinator-rotation.mjs', import.meta.url), 'utf8')
    expect(rotation).toContain('assertCoordinatorRotationContext(intent, { origin, installedReceiptSha256: installed.sha256, headSha256: head.sha256 })')
    // Upgrade admission publishes the pending HEAD before the upgrade callback, and so before any migration runs.
    const safety = readFileSync(new URL('./lifecycle-root-safety.mjs', import.meta.url), 'utf8')
    const head = safety.indexOf("await durableJson(HEAD, { ...head.value, sequence, phase: 'pending'"), run = safety.indexOf('const result = await callback()')
    expect(head).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(head)
  })
})

describe('lifecycle helper migration modes', () => {
  it('names the pre-migration mode for rotation and keeps the complete set for coordinator install', () => {
    const rotation = readFileSync(new URL('./coordinator-rotation.mjs', import.meta.url), 'utf8')
    expect(rotation).toContain("await observePreparedAdoptionSource(prepared, 'pre-migration')")
    expect(rotation).toContain("withCoordinatorDatabaseAuthority('pre-migration', async ")
    const install = readFileSync(new URL('./coordinator-install.mjs', import.meta.url), 'utf8')
    expect(install.match(/withCoordinatorDatabaseAuthority\('complete', async /g)).toHaveLength(2)
    expect(install).toContain('await observePreparedAdoptionSource(prepared)\n')
  })
  it('names the pre-migration mode where the target release reads the host database before its migrate phase', () => {
    const bootstrap = readFileSync(new URL('./install-bootstrap.mjs', import.meta.url), 'utf8')
    expect(bootstrap).toContain("observeInstalledAcquisitionSource() { return observeFinalizationSource(false, 'pre-migration') }")
    expect(bootstrap).toContain("return observeFinalizationSource(true, 'complete')")
    const safety = readFileSync(new URL('./lifecycle-root-safety.mjs', import.meta.url), 'utf8')
    for (const site of ["createDb(DATABASE, { durability: 'strict', migrations: 'pre-migration' })", "reader => readBootstrapDatabase(reader, scope), 'pre-migration')",
      "withReadonlyClosedOperationDatabase(scope.capability, observeReader, 'pre-migration') : withReadonlyOperationDatabase(DATABASE, observeReader, 'pre-migration')",
      "withReader = work => withReadonlyOperationDatabase(DATABASE, work, 'pre-migration')"]) expect(safety).toContain(site)
    expect(safety).not.toContain("createDb(DATABASE, { durability: 'strict' })")
    const handoff = readFileSync(new URL('../apps/agent/src/upgrade-coordinator-bootstrap.ts', import.meta.url), 'utf8')
    expect(handoff).toContain("createDb(path, { durability: 'strict', migrations: 'pre-migration' })")
  })
})

describe('coordinator database observations retire before host effects', () => {
  const fixture = () => {
    const file = '/var/lib/xpanel/control.db'
    const origin = { file, device: '1', inode: '2', issuerId: '12345678-1234-1234-1234-123456789abc' }
    const binding = { databaseFile: file, databaseDevice: '1', databaseInode: '2', issuerId: origin.issuerId }
    let currentOrigin = origin, root = { id: 'root1', kind: 'root', disabled: false, forcePasswordChange: false }
    let readers = 0
    const observe = vi.fn(async (path: string, run: (reader: unknown) => Promise<string>, migrations: string) => {
      expect(path).toBe(file)
      expect(migrations).toBe('pre-migration')
      readers++
      try { return await run({ query: async () => [{ id: root.id }] }) } finally { readers-- }
    })
    const held = vi.fn(async () => { expect(readers).toBe(0) })
    const source = readFileSync(new URL('./coordinator-install.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('export async function withCoordinatorDatabaseAuthority(')
    const end = source.indexOf('\nasync function withExistingRegistrationGuard(', start)
    const authority = new Function('DATABASE', 'withLifecycleWriterAdmission', 'withReopenedReadonlyHostOperationGuard', 'readTrustedFile',
      'withReobservedReadonlyOperationDatabase', 'getReadonlyOperationDatabaseOrigin', 'getPrincipal', 'assertReadonlyOperationDatabaseCurrent',
      'assertHostOperationGuardHeld', 'fail', source.slice(start, end).replace(/^export /, '') + '\nreturn withCoordinatorDatabaseAuthority'
    )(file, (run: () => unknown) => run(), (_path: string, options: unknown, run: (guard: object, value: typeof binding) => unknown) => { expect(options).toEqual({ migrations: 'pre-migration' }); return run({}, binding) },
      async () => ({ bytes: Buffer.from(JSON.stringify({ origin })), sha256: 'a'.repeat(64) }), observe, () => currentOrigin, () => root,
      async () => { expect(readers).toBe(1) }, held, (code: string) => { throw new Error(code) })
    return { authority, observe, held, readerCount: () => readers,
      changeOrigin: () => { currentOrigin = { ...origin, inode: '4' } },
      changeRoot: () => { root = { ...root, id: 'root2' } } }
  }

  it('uses a new scoped reader for each recheck and keeps all host effects outside it', async () => {
    const f = fixture()
    await f.authority('pre-migration', async ({ assertDatabaseAuthority }: { assertDatabaseAuthority: () => Promise<void> }) => {
      expect(f.readerCount()).toBe(0)
      await assertDatabaseAuthority()
      expect(f.readerCount()).toBe(0)
      await assertDatabaseAuthority()
      expect(f.readerCount()).toBe(0)
    })
    expect(f.observe).toHaveBeenCalledTimes(3)
    expect(f.held).toHaveBeenCalledTimes(2)
  })

  it.each(['database', 'root'] as const)('refuses a changed %s on a fresh read', async target => {
    const f = fixture()
    await expect(f.authority('pre-migration', async ({ assertDatabaseAuthority }: { assertDatabaseAuthority: () => Promise<void> }) => {
      if (target === 'database') f.changeOrigin(); else f.changeRoot()
      await assertDatabaseAuthority()
    })).rejects.toThrow(target === 'database' ? 'COORDINATOR_DATABASE_CHANGED' : 'COORDINATOR_AUTHORITY_CHANGED')
    expect(f.readerCount()).toBe(0)
  })
})
