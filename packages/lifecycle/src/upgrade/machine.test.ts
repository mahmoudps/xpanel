import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { XpanelError, fail } from '@xpanel/core'
import type { OsRelease } from '@xpanel/os'
import { FakeClock, FakeFs, FakeHost, MemoryAudit, RESELLER, ROOT, gate, osRelease } from '../testing/fakes.ts'
import { isCustomerDataPath, normalizeUpgradePlan, readLock, recoverUpgrade, runUpgrade } from './machine.ts'
import type { UpgradePlan } from './machine.ts'
import type { PendingMigration } from './migrations.ts'
import type { AccountIdentity, UnitChange, UpgradePhase, UpgradePorts, UpgradeStatus } from './ports.ts'

const ARCHIVE = '/opt/xpanel/downloads/xpanel-1.1.0.tar.gz'
const ARCHIVE_BYTES = 'release-1.1.0'
const LOCK = '/var/lib/xpanel/upgrade.lock'
const MAINTENANCE = '/var/lib/xpanel/maintenance.json'
const RETIREMENT = '/var/lib/xpanel-lifecycle/backups/retirement-attention.json'
const SNAPSHOT = '/var/lib/xpanel-lifecycle/backups/20261022T013500Z.tar.gz'
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

const alice: AccountIdentity = { username: 'alice', uid: 1001, gid: 1001, slice: 'xpanel-1001.slice', quotas: { diskMb: 5000, ioWriteBps: 10_000_000, memoryMb: 'unlimited' } }
const bob: AccountIdentity = { username: 'bob', uid: 1002, gid: 1002, slice: 'xpanel-1002.slice', quotas: { diskMb: 1000, ioWriteBps: 'unlimited', memoryMb: 512 } }

const argValue = (argv: string[], flag: string): string | undefined =>
  argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1)

interface Row {
  id: string
  fromVersion: string
  toVersion: string
  status: UpgradeStatus
  phase: UpgradePhase | null
  actor: string
  fromSchemaVersion: number
  toSchemaVersion: number | null
  snapshotPath: string | null
  healthReport: Record<string, unknown> | null
  error: string | null
}

interface ControlState {
  schema: number
  applied: string[]
  data: string
  rows: Row[]
}

interface World {
  ports: UpgradePorts
  fs: FakeFs
  host: FakeHost
  clock: FakeClock
  audit: MemoryAudit
  db: ControlState
  dumps: Map<string, ControlState>
  gen: { current: number; activated: number[]; reconciled: number }
  identities: AccountIdentity[]
  served: Map<string, number | null>
  controlPlane: { ok: boolean }
  converged: { value: boolean }
  migrations: PendingMigration[]
  failMigration: number | null
  afterReconcile: (() => void) | null
  units: UnitChange[]
  upgradeUnitActive: boolean
  events: string[]
  maintenanceSeenAtDump: boolean | null
}

const isStateSnapshotTar = (argv: string[]): boolean =>
  argv[0] === '/usr/bin/tar' && argv.includes('--create') && argv.includes('state')

const isStateRestoreTar = (argv: string[]): boolean =>
  argv[0] === '/usr/bin/tar' && argv.includes('--extract') && argv.includes('--directory=/var/lib/xpanel')

const isReleaseUnpackTar = (argv: string[]): boolean =>
  argv[0] === '/usr/bin/tar' && argv.includes('--extract') && !argv.includes('--directory=/var/lib/xpanel')

const world = (over: { free?: number; os?: OsRelease; transfers?: number } = {}): World => {
  const fs = new FakeFs({
    '/opt/xpanel/releases/1.0.0': { type: 'dir', mode: 0o755 },
    '/opt/xpanel/releases/1.0.0/VERSION': { type: 'file', content: '1.0.0\n', mode: 0o644 },
    '/opt/xpanel/current': { type: 'symlink', target: '/opt/xpanel/releases/1.0.0' },
    '/opt/xpanel/staging': { type: 'dir', mode: 0o755 },
    '/var/lib/xpanel': { type: 'dir', mode: 0o755 },
    '/var/lib/xpanel/state': { type: 'dir', mode: 0o700 },
    [ARCHIVE]: { type: 'file', content: ARCHIVE_BYTES, mode: 0o600 },
    '/home/alice/public_html/index.php': { type: 'file', content: '<?php echo 1;', mode: 0o640 },
    '/home/alice/mail/alice.example/info/cur/1': { type: 'file', content: 'mail', mode: 0o600 },
    '/var/vmail/example.com/info/cur/1': { type: 'file', content: 'mail', mode: 0o600 },
  })
  const host = new FakeHost()
  const w: World = {
    fs,
    host,
    clock: new FakeClock(),
    audit: new MemoryAudit(),
    db: { schema: 4, applied: ['0001', '0002', '0003', '0004'], data: 'desired-state-v4', rows: [] },
    dumps: new Map(),
    gen: { current: 41, activated: [], reconciled: 0 },
    identities: [structuredClone(alice), structuredClone(bob)],
    served: new Map([['alice', 1001]]),
    controlPlane: { ok: true },
    converged: { value: true },
    migrations: [
      { version: 5, name: '0005_accounts_note.sql', contract: false },
      { version: 6, name: '0006_backfill_note.sql', contract: false },
    ],
    failMigration: null,
    afterReconcile: null,
    units: [{ unit: 'nginx.service', needs: 'reload' }, { unit: 'apache2.service', needs: 'reload' }],
    upgradeUnitActive: false,
    events: [],
    maintenanceSeenAtDump: null,
    ports: undefined as unknown as UpgradePorts,
  }
  host.handler = (a) => {
    if (a.kind === 'ensure-dir') { fs.nodes.set(a.path, { type: 'dir', mode: a.mode }); return undefined }
    if (a.kind === 'systemd') { w.events.push(`${a.verb} ${a.unit}`); return undefined }
    if (a.kind !== 'exec') return undefined
    const [cmd] = a.argv
    if (isStateSnapshotTar(a.argv)) {
      const file = argValue(a.argv, '--file') as string
      w.maintenanceSeenAtDump = fs.nodes.has(MAINTENANCE)
      fs.file(file, 'state-tarball')
      w.dumps.set(file, structuredClone(w.db))
    } else if (isStateRestoreTar(a.argv)) {
      const file = argValue(a.argv, '--file') as string
      const snap = w.dumps.get(file)
      if (!snap) return { code: 1, stdout: '', stderr: 'no such snapshot archive' }
      w.db = structuredClone(snap)
    } else if (isReleaseUnpackTar(a.argv)) {
      const dir = argValue(a.argv, '--directory') as string
      fs.file(`${dir}/VERSION`, '1.1.0\n')
      fs.file(`${dir}/bin/xpanel-api`, 'bin')
    } else if (cmd === '/usr/bin/systemctl' && a.argv[1] === 'is-active') {
      return { code: w.upgradeUnitActive ? 0 : 3, stdout: '', stderr: '' }
    }
    return undefined
  }
  const row = (id: string): Row => w.db.rows.find((r) => r.id === id) ?? fail('NOT_FOUND', `no upgrade ${id}`)
  const inFlight = (r: Row): boolean => r.status === 'pending' || r.status === 'running'
  w.ports = {
    // Deliberately synthetic sequencing seam. This does not qualify a native guard or writer barrier.
    safety: {
      withExclusive: async callback => callback(),
      assertOwnedExecution: async () => {},
      assertWritersQuiescent: async () => {},
      assertWriteBarrier: async () => {},
      verifyRelease: async () => {},
      unpackVerifiedRelease: async (path, release) => {
        const result = await host.apply({ kind: 'exec', argv: ['/usr/bin/tar', '--extract', '--gzip', `--file=${release.archivePath}`, `--directory=${path}`, '--no-same-owner', '--no-overwrite-dir'] })
        if (result.code !== 0) throw new Error('synthetic authenticated extraction failed')
      },
      verifyStagedRelease: async () => {},
      assertCompatibility: async () => {},
      snapshotControlPlane: async () => {},
      syncPath: async () => {},
    },
    host,
    fs,
    clock: w.clock,
    audit: w.audit,
    reconciler: {
      currentGeneration: async () => w.gen.current,
      reconcile: async () => {
        w.events.push('reconcile')
        w.gen.reconciled++
        w.gen.current = 41 + w.gen.reconciled
        w.afterReconcile?.()
        return { generationId: w.gen.current, units: w.units }
      },
      activate: async (id) => {
        w.events.push(`activate ${id}`)
        w.gen.activated.push(id)
        w.gen.current = id
        w.identities = [structuredClone(alice), structuredClone(bob)]
        return { units: [{ unit: 'nginx.service', needs: 'reload' }, { unit: 'apache2.service', needs: 'reload' }] }
      },
      status: async () => ({ converged: w.converged.value, drift: w.converged.value ? [] : ['vhost alice.example'] }),
      identities: async () => structuredClone(w.identities),
    },
    migrator: {
      currentSchema: async () => w.db.schema,
      pending: async () => w.migrations.filter((m) => m.version > w.db.schema),
      apply: async () => {
        const applied: string[] = []
        for (const m of w.migrations.filter((x) => x.version > w.db.schema)) {
          if (w.failMigration === m.version) throw new Error(`migration ${m.name} failed: syntax error`)
          w.db.schema = m.version
          w.db.applied.push(m.name)
          w.db.data += `+${m.name}`
          applied.push(m.name)
        }
        return { applied, version: w.db.schema }
      },
    },
    health: {
      servedUid: async (u) => w.served.get(u) ?? null,
      qualifiedControlPlane: async () => w.controlPlane.ok,
    },
    system: {
      freeBytes: async () => over.free ?? 10_000_000,
      os: async () => over.os ?? osRelease('ubuntu', '24.04', 'VERSION_CODENAME=noble\n'),
    },
    transfers: { activeCount: async () => over.transfers ?? 0 },
    history: {
      latest: async () => w.db.rows.at(-1) ?? null,
      create: async (input) => {
        if (w.db.rows.some(inFlight)) fail('CONFLICT', 'another upgrade is in progress')
        const id = `up-${w.db.rows.length + 1}`
        w.db.rows.push({ id, ...input, status: 'pending', phase: null, toSchemaVersion: null, snapshotPath: null, healthReport: null, error: null })
        return { id }
      },
      setPhase: async (id, phase, extra) => {
        const r = row(id)
        if (!inFlight(r)) fail('PRECONDITION_FAILED', `upgrade is already ${r.status}`)
        Object.assign(r, { status: 'running', phase, ...(extra?.snapshotPath ? { snapshotPath: extra.snapshotPath } : {}) })
      },
      finish: async (id, outcome) => {
        const r = row(id)
        if (!inFlight(r)) fail('PRECONDITION_FAILED', `upgrade is already ${r.status}`)
        Object.assign(r, outcome)
      },
    },
  }
  return w
}

const plan = (over: Partial<UpgradePlan> = {}): UpgradePlan => ({
  actor: ROOT,
  os: { family: 'debian' },
  release: { version: '1.1.0', schemaVersion: 6, archivePath: ARCHIVE, sha256: sha(ARCHIVE_BYTES), bytes: 1_000_000 },
  canary: 'alice',
  health: { attempts: 3, intervalMs: 1000 },
  ...over,
})

const customerWrites = (w: World): string[] => w.fs.writes.filter(isCustomerDataPath)
const execPaths = (w: World): string[] =>
  w.host.actions.flatMap((a) => (a.kind === 'exec' ? a.argv.map((x) => (x.includes('=') ? x.slice(x.indexOf('=') + 1) : x)).filter((x) => x.startsWith('/')) : []))
const shared = (w: World): { verb: string; unit: string }[] => w.host.systemd().filter((s) => !s.unit.startsWith('xpanel-'))

describe('mandatory lifecycle admission', () => {
  it('refuses missing operational safety before any filesystem or host effect', async () => {
    const w = world()
    delete (w.ports as Partial<UpgradePorts> & { safety?: unknown }).safety
    await expect(runUpgrade(w.ports, plan())).rejects.toThrow(/safety admission/)
    expect(w.fs.writes).toEqual([])
    expect(w.host.actions).toEqual([])
    expect(w.db.rows).toEqual([])
  })

  it('rejects malformed recovery before announcing a native operation', async () => {
    const w = world()
    let entered = false
    w.ports.safety.withExclusive = async callback => { entered = true; return callback() }
    await expect(recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: '', canary: null })).rejects.toThrow(XpanelError)
    expect(entered).toBe(false)
    expect(w.fs.writes).toEqual([])
    expect(w.host.actions).toEqual([])
  })
})

const untouchedCustomerData = async (w: World): Promise<void> => {
  expect(customerWrites(w)).toEqual([])
  expect(execPaths(w).filter(isCustomerDataPath)).toEqual([])
  expect(w.host.argv0().filter((b) => /mysql|mariadb/.test(b))).toEqual([])
  expect(await w.fs.readFile('/home/alice/public_html/index.php')).toBe('<?php echo 1;')
  expect(await w.fs.readFile('/home/alice/mail/alice.example/info/cur/1')).toBe('mail')
  expect(await w.fs.readFile('/var/vmail/example.com/info/cur/1')).toBe('mail')
}

describe('lifecycle safety regression oracles (portable ports, not native qualification)', () => {
  it('requires observed writer quiescence after stop before creating a backup or extracting', async () => {
    const w = world()
    w.ports.safety.assertWritersQuiescent = async () => { throw new Error('writer cgroup remains populated') }
    const result = await runUpgrade(w.ports, plan())
    expect(result).toMatchObject({ outcome: 'rollback_failed', hostOutcome: 'rollback_failed' })
    expect(w.host.actions.some(action => action.kind === 'exec' && (isStateSnapshotTar(action.argv) || isReleaseUnpackTar(action.argv)))).toBe(false)
    expect(w.host.systemd().some(action => action.verb === 'restart' || action.verb === 'start')).toBe(false)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(await w.fs.exists(LOCK)).toBe(true)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
  })
  it('never enters the unsafe final upgrade unlink/sync window and retains admission', async () => {
    const w = world()
    const sync = w.ports.safety.syncPath
    let injected = false
    w.ports.safety.syncPath = async path => {
      if (path === '/var/lib/xpanel' && !await w.fs.exists(LOCK) && !await w.fs.exists(MAINTENANCE)) { injected = true; throw new Error('final upgrade retirement fsync failed') }
      await sync(path)
    }
    const observed = await runUpgrade(w.ports, plan())
    expect(observed).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'succeeded' })
    expect(await w.fs.exists(RETIREMENT)).toBe(true)
    const barrierRemains = await w.fs.exists(LOCK) || await w.fs.exists(MAINTENANCE)
    w.ports.safety.syncPath = sync
    w.host.actions.length = 0
    w.clock.t += 60_000
    const next = await runUpgrade(w.ports, plan({ release: { ...plan().release, version: '1.2.0' } }))
    expect({ injected, barrierRemains, nextOutcome: next.outcome, effects: w.host.actions.length }).toEqual({ injected: false, barrierRemains: true, nextOutcome: 'refused', effects: 0 })
  })

  it('never enters the unsafe final recovery unlink/sync window and retains admission', async () => {
    const w = world()
    w.fs.file(LOCK, JSON.stringify({ state: 'rollback-failed', recordId: null, actor: 'root', to: '1.1.0', at: w.clock.now().toISOString() }))
    w.fs.file(MAINTENANCE, '{}')
    const sync = w.ports.safety.syncPath
    let injected = false
    w.ports.safety.syncPath = async path => {
      if (path === '/var/lib/xpanel' && !await w.fs.exists(LOCK) && !await w.fs.exists(MAINTENANCE)) { injected = true; throw new Error('final recovery retirement fsync failed') }
      await sync(path)
    }
    const observed = await recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'observe retirement failure', canary: null })
    expect(observed.status).toBe('retirement_pending')
    expect(await w.fs.exists(RETIREMENT)).toBe(true)
    const barrierRemains = await w.fs.exists(LOCK) || await w.fs.exists(MAINTENANCE)
    w.ports.safety.syncPath = sync
    w.host.actions.length = 0
    const next = await runUpgrade(w.ports, plan())
    expect({ injected, barrierRemains, nextOutcome: next.outcome, effects: w.host.actions.length }).toEqual({ injected: false, barrierRemains: true, nextOutcome: 'refused', effects: 0 })
  })

  for (const recovery of [false, true]) {
    for (const failedPath of [RETIREMENT, '/var/lib/xpanel-lifecycle/backups']) {
      it(`retains every existing barrier when ${recovery ? 'recovery' : 'upgrade'} attention fsync fails at ${failedPath}`, async () => {
        const w = world()
        if (recovery) {
          w.fs.file(LOCK, JSON.stringify({ state: 'rollback-failed', recordId: null, actor: 'root', to: '1.1.0', at: w.clock.now().toISOString() }))
          w.fs.file(MAINTENANCE, '{}')
        }
        const sync = w.ports.safety.syncPath
        let attentionCreated = false
        const writeExclusive = w.ports.fs.writeFileExclusive.bind(w.ports.fs)
        w.ports.fs.writeFileExclusive = async (path, content, mode) => {
          await writeExclusive(path, content, mode)
          if (path === RETIREMENT) attentionCreated = true
        }
        w.ports.safety.syncPath = async path => {
          if (attentionCreated && path === failedPath) throw new Error('attention persistence failed')
          await sync(path)
        }
        const operation = recovery
          ? recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'observe persistence fault', canary: null })
          : runUpgrade(w.ports, plan())
        await expect(operation).rejects.toThrow(/attention persistence failed/)
        expect(await w.fs.exists(LOCK)).toBe(true)
        expect(await w.fs.exists(MAINTENANCE)).toBe(true)
        expect(await w.fs.exists(RETIREMENT)).toBe(true)
        expect(w.audit.actions()).not.toContain('upgrade.retirement_pending')
        w.host.actions.length = 0
        w.ports.safety.syncPath = sync
        expect((await runUpgrade(w.ports, plan())).outcome).toBe('refused')
        expect(w.host.actions).toEqual([])
      })
    }
  }

  it('checks even malformed attention evidence first under exclusion, without assuming a successful prior operation', async () => {
    const w = world()
    w.fs.file(RETIREMENT, '{interrupted-write')
    w.ports.safety.assertOwnedExecution = async () => { throw new Error('must not reach ordinary preflight') }
    expect(await runUpgrade(w.ports, plan())).toMatchObject({ outcome: 'refused', hostOutcome: null, code: 'CONFLICT' })
    expect(w.host.actions).toEqual([])
    expect(w.db.rows).toEqual([])
    expect(await w.fs.readFile(RETIREMENT)).toBe('{interrupted-write')
    expect(await w.fs.exists(LOCK)).toBe(false)
  })
  it('does not snapshot or switch when stopping a writer fails', async () => {
    const w = world()
    const previous = w.host.handler
    w.host.handler = a => a.kind === 'systemd' && a.verb === 'stop'
      ? { code: 1, stdout: '', stderr: 'writer stop failed' } : previous?.(a)
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).not.toBe('succeeded')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.host.actions.some(a => a.kind === 'exec' && isStateSnapshotTar(a.argv))).toBe(false)
    expect(w.host.actions.some(a => a.kind === 'exec' && isReleaseUnpackTar(a.argv))).toBe(false)
    expect(w.host.systemd().some(a => a.verb === 'start' || a.verb === 'restart')).toBe(false)
  })

  it('does not move the pointer, restore a snapshot, activate or start after rollback stop failure', async () => {
    const w = world()
    w.controlPlane.ok = false
    const previous = w.host.handler
    let stops = 0
    w.host.handler = a => a.kind === 'systemd' && a.verb === 'stop' && ++stops > 2
      ? { code: 1, stdout: '', stderr: 'rollback writer stop failed' } : previous?.(a)
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rollback_failed')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    expect(w.host.actions.some(a => a.kind === 'exec' && isStateRestoreTar(a.argv))).toBe(false)
    expect(w.gen.activated).toEqual([])
    const failedStop = w.host.actions.findLastIndex(a => a.kind === 'systemd' && a.verb === 'stop' && a.unit === 'xpanel-api.service')
    expect(w.host.actions.slice(failedStop + 1).some(a => a.kind === 'systemd' && (a.verb === 'start' || a.verb === 'restart'))).toBe(false)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists(LOCK)).toBe(true)
  })

  it('binary rollback keeps current authority and migration data instead of restoring old DB/state', async () => {
    const w = world()
    w.afterReconcile = () => { w.db.data += '+revoked-session+burned-uid+issued-reference' }
    w.controlPlane.ok = false
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'rolled_back' })
    expect(w.db.schema).toBe(6)
    expect(w.db.data).toContain('+revoked-session+burned-uid+issued-reference')
    expect(w.host.actions.some(a => a.kind === 'exec' && isStateRestoreTar(a.argv))).toBe(false)
  })

  it('requires the explicit control-plane backup before extraction or switching', async () => {
    const w = world()
    w.ports.safety.snapshotControlPlane = async () => { throw new Error('WAL-safe backup failed') }
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/WAL-safe backup failed/)
    expect(w.host.actions.some(a => a.kind === 'exec' && isReleaseUnpackTar(a.argv))).toBe(false)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
  })

  it('does not publish a staging tree rejected by the authenticated tree verifier', async () => {
    const w = world()
    w.ports.safety.verifyStagedRelease = async () => { throw new Error('unlisted dependency') }
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
  })

  it('leaves the history row running until the native terminal producer acknowledges retirement', async () => {
    const w = world()
    w.ports.history.finish = async () => { throw new Error('durable history commit failed') }
    expect(await runUpgrade(w.ports, plan())).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'succeeded' })
    expect(w.db.rows[0]?.status).toBe('running')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect((await readLock(w.fs, LOCK))?.state).toBe('retirement-pending')
  })

  it('does not acknowledge success or release admission when final audit persistence fails', async () => {
    const w = world()
    const record = w.ports.audit.record.bind(w.ports.audit)
    w.ports.audit.record = async entry => { if (entry.action === 'upgrade.retirement_pending') throw new Error('durable audit commit failed'); await record(entry) }
    await expect(runUpgrade(w.ports, plan())).rejects.toThrow(/durable audit commit failed/)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect((await readLock(w.fs, LOCK))?.state).toBe('rollback-failed')
  })

  it('does not clear recovery markers on unknown systemd state or audit failure', async () => {
    const w = world()
    w.fs.file(LOCK, JSON.stringify({ state: 'rollback-failed', recordId: null, actor: 'root', to: '1.1.0', at: w.clock.now().toISOString() }))
    w.fs.file(MAINTENANCE, '{}')
    const original = w.host.handler
    w.host.handler = a => a.kind === 'exec' && a.argv.includes('is-active') ? { code: 4, stdout: '', stderr: 'unknown unit' } : original?.(a)
    const input = { actor: ROOT, os: { family: 'debian' as const }, note: 'inspect only', canary: null }
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/state is unknown/)
    expect(await w.fs.exists(LOCK)).toBe(true)
    w.host.handler = original
    w.ports.audit.record = async () => { throw new Error('audit unavailable') }
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/audit unavailable/)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists(LOCK)).toBe(true)
  })
})

describe('runUpgrade: success', () => {
  it('switches atomically, reloads shared services and keeps UIDs, slices and quotas', async () => {
    const w = world()
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'succeeded' })
    expect(r.from).toBe('1.0.0')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    expect(await w.fs.readFile('/opt/xpanel/releases/1.1.0/VERSION')).toBe('1.1.0\n')
    expect(await w.fs.exists('/opt/xpanel/releases/1.0.0')).toBe(true)
    expect(w.db.schema).toBe(6)
    expect(w.identities).toEqual([alice, bob])

    expect(r.snapshot).toBe(SNAPSHOT)
    const dump = w.host.actions.find((a) => a.kind === 'exec' && isStateSnapshotTar(a.argv))
    expect(dump).toEqual({
      kind: 'exec',
      argv: ['/usr/bin/tar', '--create', '--gzip', `--file=${SNAPSHOT}`, '--directory=/var/lib/xpanel', 'state'],
      runAsUser: 'root',
    })
    expect(w.host.actions.find((a) => a.kind === 'ensure-dir')).toEqual({
      kind: 'ensure-dir',
      path: '/var/lib/xpanel-lifecycle/backups',
      mode: 0o700,
      owner: 'root',
      group: 'root',
    })
    expect(r.previousGeneration).toBe(41)
    expect(r.newGeneration).toBe(42)

    expect(shared(w)).toEqual([{ verb: 'reload', unit: 'nginx.service' }, { verb: 'reload', unit: 'apache2.service' }])
    expect(w.events).toEqual(['stop xpanel-api.service', 'stop xpanel-agent.service', 'restart xpanel-api.service', 'restart xpanel-agent.service', 'reconcile', 'reload nginx.service', 'reload apache2.service'])
    expect(w.host.actions).toContainEqual({ kind: 'ensure-dir', path: '/var/lib/xpanel/acme', mode: 0o755, owner: 'root', group: 'root' })
    expect(w.host.actions.some(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/setfacl')).toBe(true)

    const linkWrites = w.fs.writes.filter((p) => p.startsWith('/opt/xpanel/.current-') || p === '/opt/xpanel/current')
    expect(linkWrites).toEqual(['/opt/xpanel/.current-20261022T013500Z', '/opt/xpanel/.current-20261022T013500Z', '/opt/xpanel/current'])

    expect(w.db.rows).toHaveLength(1)
    expect(w.db.rows[0]).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', status: 'running', phase: 'health-check', fromSchemaVersion: 4, toSchemaVersion: null, snapshotPath: SNAPSHOT })
    expect(w.db.rows[0]?.healthReport).toBeNull()
    expect(JSON.parse((await w.fs.readFile(RETIREMENT))!).report).toMatchObject({ generations: { previous: 41, next: 42 }, migrations: ['0005_accounts_note.sql', '0006_backfill_note.sql'], health: [], rollbackErrors: [] })
    expect(w.audit.actions()).toEqual(['upgrade.started', 'upgrade.retirement_pending'])
    expect(w.audit.entries[1]).toMatchObject({ actor: 'root:root', outcome: 'failed', target: 'xpanel', detail: { from: '1.0.0', to: '1.1.0' } })

    expect(w.maintenanceSeenAtDump).toBe(true)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists(LOCK)).toBe(true)
    expect(w.host.argv0().every((b) => b.startsWith('/usr/bin/'))).toBe(true)
    await untouchedCustomerData(w)
  })

  it('restarts a shared unit only when the reconciler says reload cannot apply the change', async () => {
    const w = world()
    w.units = [{ unit: 'nginx.service', needs: 'reload' }, { unit: 'pdns.service', needs: 'restart' }]
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('retirement_pending')
    expect(shared(w)).toEqual([{ verb: 'reload', unit: 'nginx.service' }, { verb: 'restart', unit: 'pdns.service' }])
  })

  it('retries the health gate before declaring success', async () => {
    const w = world()
    let calls = 0
    w.ports.health.qualifiedControlPlane = async () => ++calls >= 2
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('retirement_pending')
    expect(w.clock.sleeps).toEqual([1000])
  })

  it('accepts an unchanged schema with no pending migrations, without a canary', async () => {
    const w = world()
    w.migrations = []
    const r = await runUpgrade(w.ports, plan({ canary: null, release: { ...plan().release, schemaVersion: 4 } }))
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'succeeded' })
    expect(w.db.schema).toBe(4)
  })

  it('runs on the EL family with the same absolute tools', async () => {
    const w = world({ os: osRelease('centos', '10', 'PLATFORM_ID="platform:el10"\n') })
    expect((await runUpgrade(w.ports, plan({ os: { family: 'rhel' } }))).outcome).toBe('retirement_pending')
  })
})

describe('runUpgrade: rollback after the switch', () => {
  it('rolls back binaries and reconciles current authority when the canary is not served by its own uid', async () => {
    const w = world()
    w.served.set('alice', 33)
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'rolled_back' })
    expect(r.reason).toMatch(/canary alice served by uid 33 instead of 1001/)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.db).toMatchObject({ schema: 6, data: 'desired-state-v4+0005_accounts_note.sql+0006_backfill_note.sql', applied: ['0001', '0002', '0003', '0004', '0005_accounts_note.sql', '0006_backfill_note.sql'] })
    expect(w.gen.activated).toEqual([])
    expect(w.gen.current).toBe(43)
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
    expect(w.clock.sleeps).toEqual([1000, 1000])

    const restore = w.host.actions.find((a) => a.kind === 'exec' && isStateRestoreTar(a.argv))
    expect(restore).toBeUndefined()
    expect(shared(w).every((s) => s.verb === 'reload')).toBe(true)
    expect(w.events.slice(7)).toEqual([
      'stop xpanel-api.service', 'stop xpanel-agent.service', 'start xpanel-api.service', 'start xpanel-agent.service',
      'reconcile', 'reload nginx.service', 'reload apache2.service',
    ])

    expect(w.db.rows).toHaveLength(1)
    expect(w.db.rows[0]).toMatchObject({ status: 'running', phase: 'rollback', actor: 'root', fromVersion: '1.0.0', toVersion: '1.1.0', toSchemaVersion: null })
    expect(w.db.rows[0]?.error).toBeNull()
    expect(r.reason).toMatch(/canary/)
    expect(w.audit.entries.at(-1)).toMatchObject({ action: 'upgrade.retirement_pending', actor: 'root:root', outcome: 'failed', detail: { from: '1.0.0', to: '1.1.0' } })
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists(LOCK)).toBe(true)
    await untouchedCustomerData(w)

    w.served.set('alice', 1001)
    w.host.actions.length = 0
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('refused')
    expect(w.host.actions).toEqual([])
  })

  it('retains attention when current-authority reconciliation cannot recover UID or quota drift', async () => {
    const w = world()
    w.afterReconcile = () => {
      const a = w.identities[0] as AccountIdentity
      a.uid = 2001
      const b = w.identities[1] as AccountIdentity
      b.quotas = { ...b.quotas, diskMb: 'unlimited' }
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rollback_failed')
    expect(r.reason).toMatch(/alice uid\/gid 1001\/1001 became 2001\/1001/)
    expect(r.reason).toMatch(/bob quota diskMb 1000 became unlimited/)
    expect(w.identities).not.toEqual([alice, bob])
    expect(w.gen.activated).toEqual([])
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
  })

  it('rolls back when the qualified control-plane readiness fails or a probe throws', async () => {
    const w = world()
    w.ports.health.qualifiedControlPlane = async () => { throw new Error('connection refused') }
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'rolled_back' })
    expect(r.reason).toMatch(/qualified control-plane readiness probe failed: connection refused/)
  })

  it('does not accept a missing qualified control-plane observation as healthy', async () => {
    const w = world()
    w.ports.health.qualifiedControlPlane = async () => undefined as unknown as boolean
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'rolled_back' })
    expect(r.reason).toMatch(/qualified control-plane readiness failed/)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
  })

  it('rolls back when the reconcile or a panel restart fails', async () => {
    const w = world()
    w.ports.reconciler.reconcile = async () => { throw new Error('nginx -t failed') }
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('rollback_failed')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')

    const v = world()
    const orig = v.host.handler
    v.host.handler = (a) => (a.kind === 'systemd' && a.verb === 'restart' && a.unit === 'xpanel-agent.service' ? { code: 1, stdout: '', stderr: 'failed' } : orig?.(a))
    const r = await runUpgrade(v.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'rolled_back' })
    expect(r.reason).toMatch(/restart xpanel-agent.service exited 1/)
    expect(v.db.schema).toBe(6)
  })

  it('reports rollback_failed, keeps the lock and maintenance, and blocks until recovery', async () => {
    const w = world()
    w.controlPlane.ok = false
    const originalCompatibility = w.ports.safety.assertCompatibility
    w.ports.safety.assertCompatibility = async input => {
      if (input.direction === 'rollback' && await w.fs.readlink('/opt/xpanel/current') === '/opt/xpanel/releases/1.1.0') throw new Error('old reader compatibility is unproven')
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rollback_failed')
    expect(r.rollbackErrors.join()).toMatch(/old reader compatibility is unproven/)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    expect(w.db.rows[0]).toMatchObject({ status: 'running', phase: 'rollback' })
    expect(w.db.rows[0]?.error).toBeNull()
    expect(r.rollbackErrors.join()).toMatch(/compatibility is unproven/)
    expect((await readLock(w.fs, LOCK))?.state).toBe('rollback-failed')
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(true)
    expect(w.audit.actions().at(-1)).toBe('upgrade.rollback_failed')

    const again = await runUpgrade(w.ports, plan())
    expect(again).toMatchObject({ outcome: 'refused', code: 'CONFLICT' })
    expect(again.reason).toMatch(/durable lifecycle retirement/)

    const input = { actor: ROOT, os: { family: 'debian' as const }, note: 'restored the state directory by hand', canary: 'alice' }
    await expect(recoverUpgrade(w.ports, { ...input, note: '' })).rejects.toThrow(XpanelError)
    await expect(recoverUpgrade(w.ports, { ...input, actor: RESELLER })).rejects.toThrow(/only root/)
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/qualified control-plane readiness failed/)
    w.controlPlane.ok = true
    w.upgradeUnitActive = true
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/still running/)
    w.upgradeUnitActive = false
    w.ports.safety.assertCompatibility = originalCompatibility
    // Explicit operator repair in this in-memory diagnostic; recovery itself never moves the link.
    w.fs.nodes.set('/opt/xpanel/current', { type: 'symlink', target: '/opt/xpanel/releases/1.0.0' })
    const rec = await recoverUpgrade(w.ports, input)
    expect(rec).toMatchObject({ status: 'retirement_pending', version: '1.0.0', closedRecordId: null })
    expect(rec.problems.join()).toMatch(/durable lifecycle retirement/)
    expect(await w.fs.exists(LOCK)).toBe(true)
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(w.audit.entries.at(-1)).toMatchObject({ action: 'upgrade.recovery_observed', outcome: 'failed', detail: { note: 'restored the state directory by hand' } })

    expect((await runUpgrade(w.ports, plan())).code).toBe('CONFLICT')
    await w.fs.remove('/opt/xpanel/releases/1.1.0')
    w.db = { schema: 4, applied: ['0001', '0002', '0003', '0004'], data: 'desired-state-v4', rows: w.db.rows }
    w.host.actions.length = 0
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('refused')
    expect(w.host.actions).toEqual([])
  })
})

describe('runUpgrade: failures before the switch', () => {
  it('a failing migration never switches and removes the unpacked release', async () => {
    const w = world()
    w.failMigration = 6
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/0006_backfill_note.sql failed/)
    expect(w.fs.writes).not.toContain('/opt/xpanel/current')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.db.schema).toBe(5)
    expect(w.host.actions.some((a) => a.kind === 'exec' && isStateRestoreTar(a.argv))).toBe(false)
    expect(w.gen.reconciled).toBe(0)
    expect(w.host.systemd()).toEqual([
      { verb: 'stop', unit: 'xpanel-api.service' }, { verb: 'stop', unit: 'xpanel-agent.service' },
      { verb: 'start', unit: 'xpanel-api.service' }, { verb: 'start', unit: 'xpanel-agent.service' },
    ])
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
    expect(w.db.rows[0]).toMatchObject({ status: 'running', phase: 'migrate', toSchemaVersion: null })
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists(LOCK)).toBe(true)
    await untouchedCustomerData(w)

    w.failMigration = null
    w.clock.t += 60_000
    w.host.actions.length = 0
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('refused')
    expect(w.host.actions).toEqual([])
    expect(w.db.applied.at(-1)).toBe('0005_accounts_note.sql')
  })

  it('a contract migration is rejected before anything is applied', async () => {
    const w = world()
    w.migrations = [{ version: 5, name: '0005_drop_legacy_contract.sql', contract: true }, { version: 6, name: '0006_x.sql', contract: false }]
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/contract step/)
    expect(w.db.schema).toBe(4)
    expect(w.fs.writes).not.toContain('/opt/xpanel/current')
  })

  it('a migrator that ends on the wrong schema is not switched to', async () => {
    const w = world()
    w.ports.migrator.apply = async () => ({ applied: ['0005_accounts_note.sql'], version: 5 })
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/schema is 5 after migrating, release expects 6/)
  })

  it('a failing snapshot stops before unpacking', async () => {
    const w = world()
    w.host.handler = (a) => (a.kind === 'exec' && isStateSnapshotTar(a.argv) ? { code: 1, stdout: '', stderr: 'state archive failed' } : undefined)
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/state archive failed/)
    expect(w.host.actions.filter((a) => a.kind === 'exec' && isReleaseUnpackTar(a.argv))).toEqual([])
    expect(w.db.rows[0]).toMatchObject({ status: 'running', phase: 'snapshot' })
  })

  it('an archive whose VERSION marker differs is not switched to and staging is cleaned', async () => {
    const w = world()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      const res = await orig?.(a)
      if (a.kind === 'exec' && isReleaseUnpackTar(a.argv)) w.fs.file(`${argValue(a.argv, '--directory')}/VERSION`, '9.9.9')
      return res
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/reports version 9.9.9/)
    expect(w.fs.children('/opt/xpanel/staging')).toEqual([])
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
  })

  it('unpacks with argv only into staging, never over the running release', async () => {
    const w = world()
    await runUpgrade(w.ports, plan())
    const tar = w.host.actions.find((a) => a.kind === 'exec' && isReleaseUnpackTar(a.argv))
    expect(tar).toEqual({ kind: 'exec', argv: ['/usr/bin/tar', '--extract', '--gzip', `--file=${ARCHIVE}`, '--directory=/opt/xpanel/staging/1.1.0-20261022T013500Z', '--no-same-owner', '--no-overwrite-dir'] })
    expect(w.fs.writes.filter((p) => p.startsWith('/opt/xpanel/releases/1.0.0'))).toEqual([])
  })

  it('re-verifies the archive right before root unpacks it', async () => {
    const w = world()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      if (a.kind === 'exec' && isStateSnapshotTar(a.argv)) w.fs.file(ARCHIVE, 'swapped release')
      return orig?.(a)
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(r.reason).toMatch(/changed after the preflight checksum/)
    expect(w.host.actions.some((a) => a.kind === 'exec' && isReleaseUnpackTar(a.argv))).toBe(false)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.fs.children('/opt/xpanel/staging')).toEqual([])
  })

  it('writes the maintenance flag world-readable so the unprivileged API can explain the 503', async () => {
    const w = world()
    let mode: number | null = null
    const orig = w.host.handler
    w.host.handler = async (a) => {
      if (a.kind === 'exec' && isStateSnapshotTar(a.argv)) {
        const n = w.fs.nodes.get(MAINTENANCE)
        mode = n?.type === 'file' ? n.mode : null
      }
      return orig?.(a)
    }
    await runUpgrade(w.ports, plan())
    expect(mode).toBe(0o644)
  })

  it('a link switch that fails leaves the old release current', async () => {
    const w = world()
    w.fs.failWhen = (op, p) => op === 'rename' && p === '/opt/xpanel/current'
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'retirement_pending', hostOutcome: 'failed' })
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.gen.reconciled).toBe(0)
  })
})

describe('runUpgrade: refusals', () => {
  const refused = async (w: World, p = plan()) => {
    const r = await runUpgrade(w.ports, p)
    expect(r.outcome).toBe('refused')
    expect(w.db.rows).toHaveLength(0)
    expect(w.host.actions).toEqual([])
    expect(await w.fs.exists(LOCK)).toBe(false)
    expect(w.audit.entries.at(-1)).toMatchObject({ action: 'upgrade.refused', outcome: 'denied' })
    return r
  }

  it('refuses on preflight failures with the full check report', async () => {
    const r = await refused(world({ free: 1_999_999 }))
    expect(r.code).toBe('PRECONDITION_FAILED')
    expect(r.checks.find((c) => c.id === 'disk-space')?.ok).toBe(false)
    expect((await refused(world({ transfers: 1 }))).reason).toMatch(/transfer/)
    expect((await refused(world({ os: osRelease('centos', '7') }))).reason).toMatch(/end-of-life/)
    expect((await refused(world(), plan({ release: { ...plan().release, version: '1.0.0' } }))).reason).toMatch(/not newer/)
    expect((await refused(world(), plan({ release: { ...plan().release, schemaVersion: 3 } }))).reason).toMatch(/older/)
  })

  it('accepts exactly twice the release size', async () => {
    expect((await runUpgrade(world({ free: 2_000_000 }).ports, plan())).outcome).toBe('retirement_pending')
  })

  it('refuses a tampered archive, a missing canary, drift, an existing release dir and a broken link', async () => {
    expect((await refused(world(), plan({ release: { ...plan().release, sha256: sha('other') } }))).code).toBe('VALIDATION')
    expect((await refused(world(), plan({ canary: 'carol' }))).code).toBe('NOT_FOUND')
    const drifted = world()
    drifted.converged.value = false
    expect((await refused(drifted)).reason).toMatch(/not converged/)
    const exists = world()
    exists.fs.nodes.set('/opt/xpanel/releases/1.1.0', { type: 'dir', mode: 0o755 })
    expect((await refused(exists)).code).toBe('CONFLICT')
    const broken = world()
    broken.fs.nodes.set('/opt/xpanel/current', { type: 'symlink', target: '/tmp/evil' })
    expect((await refused(broken)).reason).toMatch(/does not point at a release/)
  })

  it('refuses while the lock file is held and leaves it alone', async () => {
    const w = world()
    w.fs.file(LOCK, '{}')
    const r = await runUpgrade(w.ports, plan())
    expect(r).toMatchObject({ outcome: 'refused', code: 'CONFLICT' })
    expect(r.reason).toMatch(/another upgrade is in progress/)
    expect(await w.fs.readFile(LOCK)).toBe('{}')
  })

  it('refuses a concurrent upgrade and retains the terminal attention barrier', async () => {
    const w = world()
    const g = gate()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      if (a.kind === 'exec' && isStateSnapshotTar(a.argv)) await g.promise
      return orig?.(a)
    }
    const first = runUpgrade(w.ports, plan())
    await new Promise((r) => setTimeout(r, 5))
    expect((await readLock(w.fs, LOCK))).toMatchObject({ state: 'running', recordId: 'up-1', actor: 'root', to: '1.1.0' })
    const second = await runUpgrade(w.ports, plan())
    expect(second).toMatchObject({ outcome: 'refused', code: 'CONFLICT' })
    g.open()
    expect((await first).outcome).toBe('retirement_pending')
    expect(await w.fs.exists(LOCK)).toBe(true)
  })

  it('records interrupted recovery but refuses new work while retirement is unqualified', async () => {
    const w = world()
    w.db.rows.push({ id: 'up-0', fromVersion: '0.9.0', toVersion: '1.0.0', status: 'running', phase: 'migrate', actor: 'root', fromSchemaVersion: 3, toSchemaVersion: null, snapshotPath: null, healthReport: null, error: null })
    w.fs.file(MAINTENANCE, '{}')
    expect(await runUpgrade(w.ports, plan())).toMatchObject({ outcome: 'refused', code: 'PRECONDITION_FAILED' })
    const rec = await recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'host rebooted mid-upgrade', canary: null })
    expect(rec.recordId).toBe('up-0')
    expect(rec.closedRecordId).toBeNull()
    expect(w.db.rows[0]).toMatchObject({ status: 'running' })
    expect(w.db.rows[0]?.error).toBeNull()
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    w.host.actions.length = 0
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('refused')
    expect(w.host.actions).toEqual([])
    expect(await recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'again', canary: null })).toMatchObject({ status: 'retirement_pending', recordId: 'up-0', closedRecordId: null })
  })
})

describe('upgrade plan validation', () => {
  it('rejects hostile plan values', () => {
    const p = plan()
    expect(() => normalizeUpgradePlan({ ...p, actor: RESELLER })).toThrow(/only root/)
    expect(() => normalizeUpgradePlan({ ...p, actor: { ...ROOT, username: 'root\nforged' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, os: { family: 'arch' as never } })).toThrow(/unknown os family/)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, version: '../../etc' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, archivePath: '/tmp/a b.tar.gz' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, archivePath: 'relative.tar.gz' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, archivePath: '/home/alice/x.tar.gz' } })).toThrow(/must be inside \/opt\/xpanel\/downloads/)
    for (const writable of ['/tmp/xpanel-1.1.0.tar.gz', '/var/lib/xpanel/downloads/xpanel-1.1.0.tar.gz', '/opt/xpanel/downloads/sub/x.tar.gz', '/opt/xpanel/x.tar.gz']) {
      expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, archivePath: writable } }), writable).toThrow(/must be inside/)
    }
    expect(() => normalizeUpgradePlan({ ...p, layout: { downloadsDir: '/opt/xpanel/releases/dl' } })).toThrow(/must not nest/)
    expect(() => normalizeUpgradePlan({ ...p, layout: { downloadsDir: '/var/tmp/dl' } })).toThrow(/inside/)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, sha256: 'ABC' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, release: { ...p.release, bytes: 0 } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, canary: 'root' })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, panelUnits: ['nginx; reboot'] })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, panelUnits: ['xpanel-api.service', 'xpanel-upgrade.service'] })).toThrow(/runs the upgrade/)
    expect(() => normalizeUpgradePlan({ ...p, panelUnits: ['xpanel-api.service', 'xpanel-lifecycle.service'] })).toThrow(/runs the upgrade/)
    expect(() => normalizeUpgradePlan({ ...p, panelUnits: [] })).toThrow(/at least one panel unit/)
    expect(() => normalizeUpgradePlan({ ...p, panelUser: '-oProxyCommand' })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, health: { attempts: 0, intervalMs: 1 } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, health: { attempts: 3, intervalMs: -1 } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, layout: { snapshotsDir: '/home/backups' } })).toThrow(/customer data/)
    expect(() => normalizeUpgradePlan({ ...p, layout: { releasesDir: '/srv/releases' } })).toThrow(/inside/)
    expect(() => normalizeUpgradePlan({ ...p, layout: { currentLink: '/usr/local/current' } })).toThrow(/inside/)
    expect(() => normalizeUpgradePlan({ ...p, layout: { lockFile: '/tmp/upgrade.lock' } })).toThrow(/inside/)
    expect(() => normalizeUpgradePlan({ ...p, layout: { stagingDir: '/opt/xpanel/releases/staging' } })).toThrow(/nest/)
  })

  it('classifies customer data paths', () => {
    for (const p of ['/home/alice', '/home2/bob/x', '/var/vmail/a', '/var/lib/mysql/alice_db', '/var/mail/alice']) expect(isCustomerDataPath(p), p).toBe(true)
    for (const p of ['/opt/xpanel/current', '/var/lib/xpanel/snapshots/x.tar.gz', '/homework']) expect(isCustomerDataPath(p), p).toBe(false)
  })
})
