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
const SNAPSHOT = '/var/lib/xpanel/snapshots/20261022T013500Z.dump'
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

/** The control DB: schema, desired state and the upgrades table all live in it (and in its dumps). */
interface ControlDb {
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
  db: ControlDb
  dumps: Map<string, ControlDb>
  gen: { current: number; activated: number[]; reconciled: number }
  identities: AccountIdentity[]
  served: Map<string, number | null>
  login: { ok: boolean }
  converged: { value: boolean }
  migrations: PendingMigration[]
  failMigration: number | null
  afterReconcile: (() => void) | null
  units: UnitChange[]
  upgradeUnitActive: boolean
  events: string[]
  maintenanceSeenAtDump: boolean | null
}

const world = (over: { free?: number; os?: OsRelease; transfers?: number } = {}): World => {
  const fs = new FakeFs({
    '/opt/xpanel/releases/1.0.0': { type: 'dir', mode: 0o755 },
    '/opt/xpanel/releases/1.0.0/VERSION': { type: 'file', content: '1.0.0\n', mode: 0o644 },
    '/opt/xpanel/current': { type: 'symlink', target: '/opt/xpanel/releases/1.0.0' },
    '/opt/xpanel/staging': { type: 'dir', mode: 0o755 },
    '/var/lib/xpanel': { type: 'dir', mode: 0o755 },
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
    login: { ok: true },
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
    if (cmd === '/usr/bin/pg_dump') {
      const file = argValue(a.argv, '--file') as string
      w.maintenanceSeenAtDump = fs.nodes.has(MAINTENANCE)
      fs.file(file, 'dump')
      w.dumps.set(file, structuredClone(w.db))
    }
    if (cmd === '/usr/bin/pg_restore') {
      const snap = w.dumps.get(a.argv[a.argv.length - 1] as string)
      if (!snap) return { code: 1, stdout: '', stderr: 'no such dump' }
      w.db = structuredClone(snap)
    }
    if (cmd === '/usr/bin/tar') {
      const dir = argValue(a.argv, '--directory') as string
      fs.file(`${dir}/VERSION`, '1.1.0\n')
      fs.file(`${dir}/bin/xpanel-api`, 'bin')
    }
    if (cmd === '/usr/bin/systemctl' && a.argv[1] === 'is-active') return { code: w.upgradeUnitActive ? 0 : 3, stdout: '', stderr: '' }
    return undefined
  }
  const row = (id: string): Row => w.db.rows.find((r) => r.id === id) ?? fail('NOT_FOUND', `no upgrade ${id}`)
  const inFlight = (r: Row): boolean => r.status === 'pending' || r.status === 'running'
  w.ports = {
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
      panelLogin: async () => w.login.ok,
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

const untouchedCustomerData = async (w: World): Promise<void> => {
  expect(customerWrites(w)).toEqual([])
  expect(execPaths(w).filter(isCustomerDataPath)).toEqual([])
  expect(w.host.argv0().filter((b) => /mysql|mariadb/.test(b))).toEqual([])
  expect(await w.fs.readFile('/home/alice/public_html/index.php')).toBe('<?php echo 1;')
  expect(await w.fs.readFile('/home/alice/mail/alice.example/info/cur/1')).toBe('mail')
  expect(await w.fs.readFile('/var/vmail/example.com/info/cur/1')).toBe('mail')
}

describe('runUpgrade: success', () => {
  it('switches atomically, reloads shared services and keeps UIDs, slices and quotas', async () => {
    const w = world()
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('succeeded')
    expect(r.from).toBe('1.0.0')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    expect(await w.fs.readFile('/opt/xpanel/releases/1.1.0/VERSION')).toBe('1.1.0\n')
    expect(await w.fs.exists('/opt/xpanel/releases/1.0.0')).toBe(true)
    expect(w.db.schema).toBe(6)
    expect(w.identities).toEqual([alice, bob])

    expect(r.snapshot).toBe(SNAPSHOT)
    const dump = w.host.actions.find((a) => a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_dump')
    expect(dump).toEqual({ kind: 'exec', argv: ['/usr/bin/pg_dump', '--no-password', '--format=custom', `--file=${SNAPSHOT}`, '--dbname=xpanel'], runAsUser: 'postgres' })
    expect(w.host.actions.find((a) => a.kind === 'ensure-dir')).toEqual({ kind: 'ensure-dir', path: '/var/lib/xpanel/snapshots', mode: 0o700, owner: 'postgres', group: 'postgres' })
    expect(r.previousGeneration).toBe(41)
    expect(r.newGeneration).toBe(42)

    expect(shared(w)).toEqual([{ verb: 'reload', unit: 'nginx.service' }, { verb: 'reload', unit: 'apache2.service' }])
    // new code is loaded first, so the new agent builds the generation
    expect(w.events).toEqual(['restart xpanel-api.service', 'restart xpanel-agent.service', 'reconcile', 'reload nginx.service', 'reload apache2.service'])

    const linkWrites = w.fs.writes.filter((p) => p.startsWith('/opt/xpanel/.current-') || p === '/opt/xpanel/current')
    expect(linkWrites).toEqual(['/opt/xpanel/.current-20261022T013500Z', '/opt/xpanel/.current-20261022T013500Z', '/opt/xpanel/current'])

    expect(w.db.rows).toHaveLength(1)
    expect(w.db.rows[0]).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', status: 'succeeded', phase: 'health-check', fromSchemaVersion: 4, toSchemaVersion: 6, snapshotPath: SNAPSHOT, error: null })
    expect(w.db.rows[0]?.healthReport).toMatchObject({ generations: { previous: 41, next: 42 }, migrations: ['0005_accounts_note.sql', '0006_backfill_note.sql'], health: [], rollbackErrors: [] })
    expect(w.audit.actions()).toEqual(['upgrade.started', 'upgrade.succeeded'])
    expect(w.audit.entries[1]).toMatchObject({ actor: 'root:root', outcome: 'ok', target: 'xpanel', detail: { from: '1.0.0', to: '1.1.0' } })

    expect(w.maintenanceSeenAtDump).toBe(true)
    expect(await w.fs.exists(MAINTENANCE)).toBe(false)
    expect(await w.fs.exists(LOCK)).toBe(false)
    expect(w.host.argv0().every((b) => b.startsWith('/usr/bin/'))).toBe(true)
    await untouchedCustomerData(w)
  })

  it('restarts a shared unit only when the reconciler says reload cannot apply the change', async () => {
    const w = world()
    w.units = [{ unit: 'nginx.service', needs: 'reload' }, { unit: 'pdns.service', needs: 'restart' }]
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
    expect(shared(w)).toEqual([{ verb: 'reload', unit: 'nginx.service' }, { verb: 'restart', unit: 'pdns.service' }])
  })

  it('retries the health gate before declaring success', async () => {
    const w = world()
    let calls = 0
    w.ports.health.panelLogin = async () => ++calls >= 2
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
    expect(w.clock.sleeps).toEqual([1000])
  })

  it('accepts an unchanged schema with no pending migrations, without a canary', async () => {
    const w = world()
    w.migrations = []
    const r = await runUpgrade(w.ports, plan({ canary: null, release: { ...plan().release, schemaVersion: 4 } }))
    expect(r.outcome).toBe('succeeded')
    expect(w.db.schema).toBe(4)
  })

  it('runs on the EL family with the same absolute tools', async () => {
    const w = world({ os: osRelease('centos', '10', 'PLATFORM_ID="platform:el10"\n') })
    expect((await runUpgrade(w.ports, plan({ os: { family: 'rhel' } }))).outcome).toBe('succeeded')
  })
})

describe('runUpgrade: rollback after the switch', () => {
  it('rolls back link, snapshot and generation when the canary is not served by its own uid', async () => {
    const w = world()
    w.served.set('alice', 33)
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rolled_back')
    expect(r.reason).toMatch(/canary alice served by uid 33 instead of 1001/)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.db).toMatchObject({ schema: 4, data: 'desired-state-v4', applied: ['0001', '0002', '0003', '0004'] })
    expect(w.gen.activated).toEqual([41])
    expect(w.gen.current).toBe(41)
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
    expect(w.clock.sleeps).toEqual([1000, 1000])

    const restore = w.host.actions.find((a) => a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_restore')
    expect(restore).toEqual({ kind: 'exec', argv: ['/usr/bin/pg_restore', '--no-password', '--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--dbname=xpanel', SNAPSHOT], runAsUser: 'postgres' })
    expect(shared(w).every((s) => s.verb === 'reload')).toBe(true)
    expect(w.events.slice(5)).toEqual([
      'stop xpanel-api.service', 'stop xpanel-agent.service', 'start xpanel-api.service', 'start xpanel-agent.service',
      'activate 41', 'reload nginx.service', 'reload apache2.service',
    ])

    // the row lives in the control DB: it is settled after the restore, so it survives it
    expect(w.db.rows).toHaveLength(1)
    expect(w.db.rows[0]).toMatchObject({ status: 'rolled_back', phase: 'rollback', actor: 'root', fromVersion: '1.0.0', toVersion: '1.1.0', toSchemaVersion: 4 })
    expect(w.db.rows[0]?.error).toMatch(/canary/)
    expect(w.audit.entries.at(-1)).toMatchObject({ action: 'upgrade.rolled_back', actor: 'root:root', outcome: 'failed', detail: { from: '1.0.0', to: '1.1.0' } })
    expect(await w.fs.exists(MAINTENANCE)).toBe(false)
    expect(await w.fs.exists(LOCK)).toBe(false)
    await untouchedCustomerData(w)

    // the next attempt starts again from the stable state
    w.served.set('alice', 1001)
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
  })

  it('rolls back when the reconcile changes an account uid or quota', async () => {
    const w = world()
    w.afterReconcile = () => {
      const a = w.identities[0] as AccountIdentity
      a.uid = 2001
      const b = w.identities[1] as AccountIdentity
      b.quotas = { ...b.quotas, diskMb: 'unlimited' }
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rolled_back')
    expect(r.reason).toMatch(/alice uid\/gid 1001\/1001 became 2001\/1001/)
    expect(r.reason).toMatch(/bob quota diskMb 1000 became unlimited/)
    expect(w.identities).toEqual([alice, bob])
  })

  it('rolls back when the panel login fails or a probe throws', async () => {
    const w = world()
    w.ports.health.panelLogin = async () => { throw new Error('connection refused') }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rolled_back')
    expect(r.reason).toMatch(/panel login probe failed: connection refused/)
  })

  it('rolls back when the reconcile or a panel restart fails', async () => {
    const w = world()
    w.ports.reconciler.reconcile = async () => { throw new Error('nginx -t failed') }
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('rolled_back')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')

    const v = world()
    const orig = v.host.handler
    v.host.handler = (a) => (a.kind === 'systemd' && a.verb === 'restart' && a.unit === 'xpanel-agent.service' ? { code: 1, stdout: '', stderr: 'failed' } : orig?.(a))
    const r = await runUpgrade(v.ports, plan())
    expect(r.outcome).toBe('rolled_back')
    expect(r.reason).toMatch(/restart xpanel-agent.service exited 1/)
    expect(v.db.schema).toBe(4)
  })

  it('reports rollback_failed, keeps the lock and maintenance, and blocks until recovery', async () => {
    const w = world()
    w.login.ok = false
    const orig = w.host.handler
    w.host.handler = (a) => (a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_restore' ? { code: 1, stdout: '', stderr: 'disk full' } : orig?.(a))
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('rollback_failed')
    expect(r.rollbackErrors.join()).toMatch(/pg_restore .* exited 1: disk full/)
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.db.rows[0]).toMatchObject({ status: 'failed', phase: 'rollback' })
    expect(w.db.rows[0]?.error).toMatch(/disk full/)
    expect((await readLock(w.fs, LOCK))?.state).toBe('rollback-failed')
    expect(await w.fs.exists(MAINTENANCE)).toBe(true)
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(true)
    expect(w.audit.actions().at(-1)).toBe('upgrade.rollback_failed')

    const again = await runUpgrade(w.ports, plan())
    expect(again).toMatchObject({ outcome: 'refused', code: 'CONFLICT' })
    expect(again.reason).toMatch(/failed to roll back; recover it first/)

    const input = { actor: ROOT, os: { family: 'debian' as const }, note: 'restored the control DB by hand', canary: 'alice' }
    await expect(recoverUpgrade(w.ports, { ...input, note: '' })).rejects.toThrow(XpanelError)
    await expect(recoverUpgrade(w.ports, { ...input, actor: RESELLER })).rejects.toThrow(/only root/)
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/panel login failed/)
    w.login.ok = true
    w.upgradeUnitActive = true
    await expect(recoverUpgrade(w.ports, input)).rejects.toThrow(/still running/)
    w.upgradeUnitActive = false
    w.host.handler = orig
    const rec = await recoverUpgrade(w.ports, input)
    expect(rec).toEqual({ version: '1.0.0', closedRecordId: null, problems: [] })
    expect(await w.fs.exists(LOCK)).toBe(false)
    expect(await w.fs.exists(MAINTENANCE)).toBe(false)
    expect(w.audit.entries.at(-1)).toMatchObject({ action: 'upgrade.recovered', outcome: 'ok', detail: { note: 'restored the control DB by hand' } })

    expect((await runUpgrade(w.ports, plan())).code).toBe('CONFLICT')
    await w.fs.remove('/opt/xpanel/releases/1.1.0')
    w.db = { schema: 4, applied: ['0001', '0002', '0003', '0004'], data: 'desired-state-v4', rows: w.db.rows }
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
  })
})

describe('runUpgrade: failures before the switch', () => {
  it('a failing migration never switches and removes the unpacked release', async () => {
    const w = world()
    w.failMigration = 6
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/0006_backfill_note.sql failed/)
    expect(w.fs.writes).not.toContain('/opt/xpanel/current')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    // the expand-only step that succeeded stays; the running release ignores it
    expect(w.db.schema).toBe(5)
    expect(w.host.argv0()).not.toContain('/usr/bin/pg_restore')
    expect(w.gen.reconciled).toBe(0)
    expect(w.host.systemd()).toEqual([])
    expect(await w.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
    expect(w.db.rows[0]).toMatchObject({ status: 'failed', phase: 'migrate', toSchemaVersion: null })
    expect(await w.fs.exists(MAINTENANCE)).toBe(false)
    expect(await w.fs.exists(LOCK)).toBe(false)
    await untouchedCustomerData(w)

    w.failMigration = null
    w.clock.t += 60_000
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
    expect(w.db.applied.slice(-2)).toEqual(['0005_accounts_note.sql', '0006_backfill_note.sql'])
  })

  it('a contract migration is rejected before anything is applied', async () => {
    const w = world()
    w.migrations = [{ version: 5, name: '0005_drop_legacy_contract.sql', contract: true }, { version: 6, name: '0006_x.sql', contract: false }]
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/contract step/)
    expect(w.db.schema).toBe(4)
    expect(w.fs.writes).not.toContain('/opt/xpanel/current')
  })

  it('a migrator that ends on the wrong schema is not switched to', async () => {
    const w = world()
    w.ports.migrator.apply = async () => ({ applied: ['0005_accounts_note.sql'], version: 5 })
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/schema is 5 after migrating, release expects 6/)
  })

  it('a failing snapshot stops before unpacking', async () => {
    const w = world()
    w.host.handler = (a) => (a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_dump' ? { code: 1, stdout: '', stderr: 'peer auth failed' } : undefined)
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/peer auth failed/)
    expect(w.host.argv0()).toEqual(['/usr/bin/pg_dump'])
    expect(w.db.rows[0]).toMatchObject({ status: 'failed', phase: 'snapshot' })
  })

  it('an archive whose VERSION marker differs is not switched to and staging is cleaned', async () => {
    const w = world()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      const res = await orig?.(a)
      if (a.kind === 'exec' && a.argv[0] === '/usr/bin/tar') w.fs.file(`${argValue(a.argv, '--directory')}/VERSION`, '9.9.9')
      return res
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/reports version 9.9.9/)
    expect(w.fs.children('/opt/xpanel/staging')).toEqual([])
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
  })

  it('unpacks with argv only into staging, never over the running release', async () => {
    const w = world()
    await runUpgrade(w.ports, plan())
    const tar = w.host.actions.find((a) => a.kind === 'exec' && a.argv[0] === '/usr/bin/tar')
    expect(tar).toEqual({ kind: 'exec', argv: ['/usr/bin/tar', '--extract', '--gzip', `--file=${ARCHIVE}`, '--directory=/opt/xpanel/staging/1.1.0-20261022T013500Z', '--no-same-owner', '--no-overwrite-dir'] })
    expect(w.fs.writes.filter((p) => p.startsWith('/opt/xpanel/releases/1.0.0'))).toEqual([])
  })

  it('re-verifies the archive right before root unpacks it', async () => {
    const w = world()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      // the tarball is replaced between the preflight checksum and the unpack
      if (a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_dump') w.fs.file(ARCHIVE, 'swapped release')
      return orig?.(a)
    }
    const r = await runUpgrade(w.ports, plan())
    expect(r.outcome).toBe('failed')
    expect(r.reason).toMatch(/changed after the preflight checksum/)
    expect(w.host.argv0()).not.toContain('/usr/bin/tar')
    expect(await w.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
    expect(w.fs.children('/opt/xpanel/staging')).toEqual([])
  })

  it('writes the maintenance flag world-readable so the unprivileged API can explain the 503', async () => {
    const w = world()
    let mode: number | null = null
    const orig = w.host.handler
    w.host.handler = async (a) => {
      if (a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_dump') {
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
    expect(r.outcome).toBe('failed')
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
    expect((await runUpgrade(world({ free: 2_000_000 }).ports, plan())).outcome).toBe('succeeded')
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

  it('refuses a concurrent upgrade and releases the lock afterwards', async () => {
    const w = world()
    const g = gate()
    const orig = w.host.handler
    w.host.handler = async (a) => {
      if (a.kind === 'exec' && a.argv[0] === '/usr/bin/pg_dump') await g.promise
      return orig?.(a)
    }
    const first = runUpgrade(w.ports, plan())
    await new Promise((r) => setTimeout(r, 5))
    expect((await readLock(w.fs, LOCK))).toMatchObject({ state: 'running', recordId: 'up-1', actor: 'root', to: '1.1.0' })
    const second = await runUpgrade(w.ports, plan())
    expect(second).toMatchObject({ outcome: 'refused', code: 'CONFLICT' })
    g.open()
    expect((await first).outcome).toBe('succeeded')
    expect(await w.fs.exists(LOCK)).toBe(false)
  })

  it('refuses after a crash until recovery closes the stale row', async () => {
    const w = world()
    w.db.rows.push({ id: 'up-0', fromVersion: '0.9.0', toVersion: '1.0.0', status: 'running', phase: 'migrate', actor: 'root', fromSchemaVersion: 3, toSchemaVersion: null, snapshotPath: null, healthReport: null, error: null })
    w.fs.file(MAINTENANCE, '{}')
    expect(await runUpgrade(w.ports, plan())).toMatchObject({ outcome: 'refused', code: 'PRECONDITION_FAILED' })
    const rec = await recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'host rebooted mid-upgrade', canary: null })
    expect(rec.closedRecordId).toBe('up-0')
    expect(w.db.rows[0]).toMatchObject({ status: 'failed' })
    expect(w.db.rows[0]?.error).toMatch(/interrupted during migrate; recovered by root/)
    expect(await w.fs.exists(MAINTENANCE)).toBe(false)
    expect((await runUpgrade(w.ports, plan())).outcome).toBe('succeeded')
    await expect(recoverUpgrade(w.ports, { actor: ROOT, os: { family: 'debian' }, note: 'again', canary: null })).rejects.toThrow(/nothing to recover/)
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
    // anything an unprivileged process can write could be swapped between the checksum and the unpack
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
    expect(() => normalizeUpgradePlan({ ...p, panelUnits: [] })).toThrow(/at least one panel unit/)
    expect(() => normalizeUpgradePlan({ ...p, controlDb: { name: 'xpanel; drop', osUser: 'postgres' } })).toThrow(XpanelError)
    expect(() => normalizeUpgradePlan({ ...p, controlDb: { name: 'xpanel', osUser: '-oProxyCommand' } })).toThrow(XpanelError)
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
    for (const p of ['/opt/xpanel/current', '/var/lib/xpanel/snapshots/x.dump', '/homework']) expect(isCustomerDataPath(p), p).toBe(false)
  })
})
