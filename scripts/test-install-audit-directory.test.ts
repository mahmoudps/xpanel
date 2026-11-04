import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// Actual initializer orchestration with isolated directory/admission ports.
// No host, SQL connection, native capability or installed evidence is produced.
const source = await readFile(new URL('./install-finalization-native.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function initializeDefaultRootOperationAuditDirectory(')
const implementation = source.slice(start, source.indexOf('\nfunction ports(', start))
const PARENT = '/var/lib/xpanel-agent', AUDIT = PARENT + '/operation-audit'
const check = (value: unknown, code: string) => { if (!value) throw Object.assign(new Error(code), { code }) }
type Row = { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint; link: boolean }

function fixture(existing?: Partial<Row>, failure?: 'mkdir-reply' | 'parent-replacement' | 'child-replacement' | 'close') {
  const events: string[] = [], rows = new Map<string, Row>()
  rows.set(PARENT, { dev: 1n, ino: 2n, uid: 0n, gid: 0n, mode: 0o40700n, link: false })
  if (existing) rows.set(AUDIT, { dev: 1n, ino: 3n, uid: 0n, gid: 0n, mode: 0o40700n, link: false, ...existing })
  const scope: any = { phase: 'held', guard: {}, capability: {}, context: {}, observation: {}, intent: null, changed: false }
  const stat = (row: Row) => ({ ...row, isDirectory: () => true, isSymbolicLink: () => row.link })
  const program = new Function('check', 'assertInstallFinalizationExclusiveHeld', 'assertCurrent', 'withTrustedDirectory', 'open', 'lstat', 'mkdir', 'constants',
    implementation + '\nreturn initializeDefaultRootOperationAuditDirectory')(
      check, async () => { events.push('EX'); check(scope.phase === 'held' && !!scope.guard, 'NO_MODEL_EX') },
      async () => { events.push('current'); check(scope.phase === 'held' && !!scope.guard, 'NO_MODEL_GUARD') },
      async (path: string, callback: (value: unknown) => Promise<unknown>) => {
        check(path === PARENT, 'UNEXPECTED_PARENT'); return callback({ verify: async () => { events.push('ancestors') } })
      }, async (path: string) => {
        const held = rows.get(path); check(held, 'UNEXPECTED_OPEN'); events.push('open:' + path)
        return { stat: async () => stat(held!), chown: async (uid: number, gid: number) => {
          events.push('chown'); held!.uid = BigInt(uid); held!.gid = BigInt(gid)
          if (failure === 'child-replacement') rows.set(AUDIT, { ...held!, ino: 99n, gid: 987n })
        }, chmod: async (mode: number) => { events.push('chmod'); held!.mode = 0o40000n | BigInt(mode) },
        sync: async () => { events.push('sync:' + path) }, close: async () => {
          events.push('close:' + path); if (failure === 'close' && path === AUDIT) throw new Error('simulated close failure')
        } }
      }, async (path: string) => {
        const row = rows.get(path); if (!row) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); return stat(row)
      }, async (path: string) => {
        check(path === AUDIT && !rows.has(path), 'UNEXPECTED_MKDIR'); events.push('mkdir')
        rows.set(path, { dev: 1n, ino: 3n, uid: 0n, gid: 987n, mode: 0o40700n, link: false })
        if (failure === 'parent-replacement') rows.set(PARENT, { ...rows.get(PARENT)!, ino: 99n })
        if (failure === 'mkdir-reply') throw Object.assign(new Error('simulated lost mkdir reply'), { code: 'EIO' })
      }, { O_RDONLY: 0, O_DIRECTORY: 1, O_NOFOLLOW: 2 })
  return { scope, events, rows, run: () => program(scope) }
}

describe('fixed default operation audit directory initialization', () => {
  it('requires EX and the native host guard before directory IO', async () => {
    const f = fixture(); f.scope.phase = 'capturing'
    await expect(f.run()).rejects.toMatchObject({ code: 'INSTALL_AUDIT_EXCLUSIVE_REQUIRED' })
    expect(f.events).toEqual([])
  })
  it('claims only the new FD as root:root and syncs it before its parent', async () => {
    const f = fixture(); await f.run()
    expect(f.rows.get(AUDIT)).toMatchObject({ uid: 0n, gid: 0n, mode: 0o40700n })
    expect(f.scope.changed).toBe(true)
    expect(f.events.indexOf('EX')).toBeLessThan(f.events.indexOf('mkdir'))
    expect(f.events.indexOf('chown')).toBeLessThan(f.events.indexOf('sync:' + AUDIT))
    expect(f.events.indexOf('sync:' + AUDIT)).toBeLessThan(f.events.indexOf('sync:' + PARENT))
    expect(f.events).toContain('close:' + AUDIT); expect(f.events).toContain('close:' + PARENT)
  })
  it('accepts an existing private directory without repairing or rewriting it', async () => {
    const f = fixture({}); await f.run()
    expect(f.events).not.toContain('mkdir'); expect(f.events).not.toContain('chown'); expect(f.events).not.toContain('chmod')
    expect(f.scope.changed).toBe(false)
  })
  it('refuses existing foreign owner, group, permissions or symbolic name without repair', async () => {
    for (const changed of [{ uid: 999n }, { gid: 987n }, { mode: 0o40755n }, { link: true }]) {
      const f = fixture(changed)
      await expect(f.run()).rejects.toMatchObject({ code: 'INSTALL_AUDIT_DIRECTORY_UNSAFE' })
      expect(f.events).not.toContain('chown'); expect(f.events).not.toContain('chmod'); expect(f.scope.changed).toBe(false)
      expect(f.rows.get(AUDIT)).toMatchObject(changed)
    }
  })
  it('preserves uncertain mkdir effects and refuses parent or child replacement', async () => {
    for (const failure of ['mkdir-reply', 'parent-replacement', 'child-replacement'] as const) {
      const f = fixture(undefined, failure)
      await expect(f.run()).rejects.toThrow()
      expect(f.scope.changed).toBe(true); expect(f.rows.has(AUDIT)).toBe(true)
      expect(f.events).toContain('close:' + PARENT)
      if (failure === 'child-replacement') expect(f.rows.get(AUDIT)!.gid).toBe(987n)
    }
  })
  it('does not acknowledge a close failure after the new directory is visible', async () => {
    const f = fixture(undefined, 'close')
    await expect(f.run()).rejects.toBeInstanceOf(AggregateError)
    expect(f.scope.changed).toBe(true); expect(f.events).toContain('close:' + PARENT)
  })
})
