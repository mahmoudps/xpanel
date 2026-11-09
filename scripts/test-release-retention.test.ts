import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatReleaseRetention, planReleaseRetention, pruneReleases, pruneReleasesAfterUpgrade, retentionEntrySafe, runReleaseRetentionCommand } from './release-retention.mjs'
import { CliUsageError, parseLifecycleArgs } from './xpanel-ctl.mjs'

// Real directories under a private fixture prefix, owned by the test user in place of root. The lock, process and
// mount observations are fixture ports; the planning, safety checks, quarantine, records and deletion are the product code.
const R = (version: string) => '/opt/xpanel/releases/' + version
const LIFE = '/var/lib/xpanel-lifecycle'
const sha = (version: string) => createHash('sha256').update('archive-' + version).digest('hex')
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('xpanel-retention-')) throw new Error('test cleanup escaped its fixture')
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-retention-')); roots.push(root)
  const dir = (path: string, mode = 0o755) => mkdirSync(root + path, { recursive: true, mode })
  const file = (path: string, value: unknown, mode = 0o600) => { dir(dirname(path)); writeFileSync(root + path, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode }) }
  for (const version of ['0.1.23', '0.1.32', '0.1.33', '0.1.42', '0.1.43']) {
    file(R(version) + '/scripts/entry.mjs', 'export {}\n', 0o644)
    file(R(version) + '/node_modules/pkg/index.js', 'module.exports = 1\n', 0o644)
    dir(R(version) + '/node_modules/.bin')
    symlinkSync('../pkg/index.js', root + R(version) + '/node_modules/.bin/tool')
  }
  symlinkSync(root + R('0.1.43'), root + '/opt/xpanel/current')
  file('/opt/xpanel/staging/authenticated-0123abcd/scripts/entry.mjs', 'export {}\n', 0o644)
  file(LIFE + '/HEAD', { schemaVersion: 1, phase: 'retired' })
  file(LIFE + '/installation.json', { status: 'active', source: { version: '0.1.43' } })
  file(LIFE + '/bootstrap.json', { version: '0.1.43', releaseRoot: R('0.1.43'), installationTransition: { operationId: uuid(4) } })
  file(LIFE + '/coordinator.json', { helper: { version: '0.1.43', releaseRoot: R('0.1.43') } })
  file(`${LIFE}/coordinator-rotation-${uuid(9)}.json`, { kind: 'xpanel-coordinator-rotation', phase: 'complete' })
  const history = [['0.1.23', '0.1.32'], ['0.1.32', '0.1.33'], ['0.1.33', '0.1.42'], ['0.1.42', '0.1.43']]
  history.forEach(([from, to], index) => transition(uuid(index + 1), from!, to!))
  function transition(id: string, from: string, to: string, phase = 'published', selected: string | null = 'target') {
    file(`${LIFE}/installation-transitions/${id}.json`, { schemaVersion: 1, kind: 'xpanel-installation-transition', operationId: id, phase, selected,
      previousTarget: R(from), target: { version: to, releaseRoot: R(to) } })
  }
  const prepared = (version: string, complete = true) => {
    dir(`${LIFE}/prepared/version-${version}`, 0o700)
    file(`${LIFE}/prepared/${sha(version)}/${complete ? 'prepared' : 'intent'}.json`, { kind: complete ? 'xpanel-prepared-release' : 'xpanel-prepared-release-intent',
      archiveSha256: sha(version), releaseRoot: R(version), version })
  }
  for (const version of ['0.1.32', '0.1.33', '0.1.42', '0.1.43']) prepared(version)
  file('/etc/systemd/system/xpanel-api.service', `[Service]\nExecStart=/usr/bin/node ${R('0.1.43')}/apps/api/src/main.ts\n`, 0o644)
  dir('/etc/systemd/system/multi-user.target.wants')
  symlinkSync('/etc/systemd/system/xpanel-api.service', root + '/etc/systemd/system/multi-user.target.wants/xpanel-api.service')
  const logs: string[] = []
  let locks = 0
  const host = (extra: Record<string, unknown> = {}) => ({ root, uid: process.getuid!(), gid: process.getgid!(), now: () => Date.now() + 86_400_000,
    log: (line: string) => logs.push(line), processReleases: async () => [], mounts: async () => [] as string[],
    withLock: async (work: (assertLocked: () => Promise<void>) => Promise<unknown>) => { locks++; return work(async () => {}) },
    owner: async () => ({ pid: 1, start: '1', bootId: 'this-boot' }), alive: async (owner: { bootId?: string }) => owner?.bootId === 'live-boot', ...extra })
  const present = (path: string) => existsSync(root + path)
  return { root, dir, file, transition, prepared, host, present, logs, locks: () => locks }
}
const codeOf = async (work: Promise<unknown>) => work.then(() => 'NO_ERROR', (error: { code?: string }) => error.code)
const releaseNames = (items: { kind: string; name: string }[]) => items.filter(item => item.kind === 'release').map(item => item.name)

describe.skipIf(process.platform === 'win32')('release retention on the live production shape', () => {
  it('dry-run lists every removal and the reason each kept release stays, and removes nothing', async () => {
    const f = fixture()
    const result = await pruneReleases(f.host(), { dryRun: true })
    expect(result.kept).toEqual([{ kind: 'release', name: '0.1.43', reasons: ['current', 'coordinator', 'unit'] }, { kind: 'release', name: '0.1.42', reasons: ['previous'] }])
    expect(releaseNames(result.remove)).toEqual(['0.1.33', '0.1.32', '0.1.23'])
    expect(result.remove.filter(item => item.kind === 'prepared').map(item => item.name).sort())
      .toEqual([sha('0.1.32'), sha('0.1.33'), 'version-0.1.32', 'version-0.1.33'].sort())
    expect(result.remove.filter(item => item.kind === 'staging')).toEqual([{ kind: 'staging', name: 'authenticated-0123abcd', version: null }])
    expect(result.removed).toEqual([])
    for (const version of ['0.1.23', '0.1.32', '0.1.33']) expect(f.present(R(version))).toBe(true)
    expect(f.locks()).toBe(0)
    const text = formatReleaseRetention({ code: 'RELEASE_RETENTION_PLANNED', details: result })
    expect(text).toContain('keep    release 0.1.42: previous')
    expect(text).toContain('remove  release 0.1.23')
    expect(text).toContain(`remove  prepared ${sha('0.1.32')} (0.1.32)`)
    expect(text).not.toContain(f.root)
  })

  it('prunes the old store under the lock, keeps current and previous with their records, and records each removal', async () => {
    const f = fixture()
    const result = await pruneReleases(f.host())
    expect(releaseNames(result.removed)).toEqual(['0.1.33', '0.1.32', '0.1.23'])
    expect(f.locks()).toBe(1)
    for (const version of ['0.1.23', '0.1.32', '0.1.33']) { expect(f.present(R(version))).toBe(false); expect(f.present(`${LIFE}/prepared/version-${version}`)).toBe(false) }
    for (const version of ['0.1.42', '0.1.43']) { expect(f.present(R(version) + '/node_modules/pkg/index.js')).toBe(true); expect(f.present(`${LIFE}/prepared/${sha(version)}/prepared.json`)).toBe(true) }
    expect(f.present('/opt/xpanel/staging/authenticated-0123abcd')).toBe(false)
    expect(readdirSync(f.root + '/opt/xpanel').sort()).toEqual(['current', 'releases', 'staging'])
    expect(readdirSync(f.root + LIFE).some(name => name.startsWith('.retention-'))).toBe(false)
    const [name] = readdirSync(f.root + LIFE + '/release-retention')
    const record = JSON.parse(readFileSync(`${f.root}${LIFE}/release-retention/${name}`, 'utf8'))
    expect(record).toMatchObject({ kind: 'xpanel-release-retention', phase: 'complete', trigger: 'operator', current: '0.1.43' })
    expect(record.removed).toHaveLength(8)
    expect(lstatSync(`${f.root}${LIFE}/release-retention/${name}`).mode & 0o777).toBe(0o600)
    expect(f.logs.filter(line => line.startsWith('xpanel-release-retention: removed kind=release'))).toHaveLength(3)
    expect((await pruneReleases(f.host(), { dryRun: true })).remove).toEqual([])
  })

  it('refuses while a lifecycle operation is open and removes nothing', async () => {
    for (const open of ['barrier', 'head', 'rotation'] as const) {
      const f = fixture()
      if (open === 'barrier') f.file(LIFE + '/writer-barrier.json', { phase: 'pending' }, 0o644)
      if (open === 'head') f.file(LIFE + '/HEAD', { schemaVersion: 1, phase: 'pending' })
      if (open === 'rotation') f.file(`${LIFE}/coordinator-rotation-${uuid(10)}.json`, { kind: 'xpanel-coordinator-rotation', phase: 'selecting' })
      const result = await runReleaseRetentionCommand({ dryRun: false }, f.host())
      expect(result).toEqual({ exitCode: 4, code: 'RELEASE_RETENTION_OPERATION_OPEN', outcome: 'blocked' })
      expect(f.present(R('0.1.23'))).toBe(true)
      expect(f.locks()).toBe(0)
    }
  })

  it('refuses a symlinked, writable-by-others or mounted target and removes nothing', async () => {
    const symlinked = fixture()
    symlinked.file('/outside/keep.txt', 'account data\n', 0o644)
    rmSync(symlinked.root + R('0.1.23'), { recursive: true })
    symlinkSync(symlinked.root + '/outside', symlinked.root + R('0.1.23'))
    expect(await codeOf(pruneReleases(symlinked.host()))).toBe('RELEASE_RETENTION_TARGET_UNSAFE')
    expect(symlinked.present('/outside/keep.txt') && symlinked.present(R('0.1.32'))).toBe(true)

    const writable = fixture()
    chmodSync(writable.root + R('0.1.32') + '/node_modules/pkg/index.js', 0o666)
    expect(await codeOf(pruneReleases(writable.host(), { dryRun: true }))).toBe('RELEASE_RETENTION_TARGET_UNSAFE')
    expect(await codeOf(pruneReleases(writable.host()))).toBe('RELEASE_RETENTION_TARGET_UNSAFE')
    expect(writable.present(R('0.1.23')) && writable.locks() === 0).toBe(true)

    const mounted = fixture()
    expect(await codeOf(pruneReleases(mounted.host({ mounts: async () => [R('0.1.33') + '/node_modules'] })))).toBe('RELEASE_RETENTION_TARGET_UNSAFE')
    expect(mounted.present(R('0.1.33') + '/node_modules/pkg/index.js')).toBe(true)
  })

  it('accepts only root-owned entries on the target filesystem; a hard-linked root file is only unlinked', () => {
    const stat = (uid: bigint, mode: bigint, kind: 'file' | 'dir' | 'link' | 'fifo', dev = 7n) => ({ dev, uid, mode,
      isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir', isFile: () => kind === 'file' })
    expect(retentionEntrySafe(stat(0n, 0o100644n, 'file'), 7n, 0)).toBe(true)
    expect(retentionEntrySafe(stat(1000n, 0o100644n, 'file'), 7n, 0)).toBe(false)
    expect(retentionEntrySafe(stat(0n, 0o100664n, 'file'), 7n, 0)).toBe(false)
    expect(retentionEntrySafe(stat(0n, 0o100644n, 'file', 8n), 7n, 0)).toBe(false)
    expect(retentionEntrySafe(stat(0n, 0o10644n, 'fifo'), 7n, 0)).toBe(false)
    expect(retentionEntrySafe(stat(0n, 0o120777n, 'link'), 7n, 0)).toBe(true)
  })

  it('resumes an interrupted prune: deletes what was quarantined, leaves what was not moved to the fresh plan', async () => {
    const f = fixture(), id = uuid(77)
    const moved = lstatSync(f.root + R('0.1.23'), { bigint: true }), stayed = lstatSync(f.root + R('0.1.32'), { bigint: true })
    f.dir(`/opt/xpanel/.retention-${id}`, 0o700)
    renameSync(f.root + R('0.1.23'), `${f.root}/opt/xpanel/.retention-${id}/release-0.1.23`)
    const target = (version: string, info: { dev: bigint; ino: bigint }) => ({ kind: 'release', name: version, version, path: R(version),
      quarantine: `/opt/xpanel/.retention-${id}/release-${version}`, device: String(info.dev), inode: String(info.ino) })
    const record = { schemaVersion: 1, kind: 'xpanel-release-retention', operationId: id, trigger: 'upgrade', phase: 'quarantining',
      owner: { pid: 1, start: '1', bootId: 'previous-boot' }, current: '0.1.43', kept: [], targets: [target('0.1.23', moved), target('0.1.32', stayed)],
      removed: [], createdAt: new Date().toISOString(), completedAt: null }
    f.file(`${LIFE}/release-retention/${id}.json`, record)
    f.file(`${LIFE}/release-retention/${uuid(78)}.json`, { ...record, operationId: uuid(78), owner: { bootId: 'live-boot' },
      targets: [], phase: 'quarantined' })
    expect(await codeOf(pruneReleases(f.host()))).toBe('RELEASE_RETENTION_BUSY')
    expect(f.present(`/opt/xpanel/.retention-${id}/release-0.1.23`)).toBe(true)
    rmSync(`${f.root}${LIFE}/release-retention/${uuid(78)}.json`)

    const result = await pruneReleases(f.host())
    expect(result.resumed).toEqual([{ kind: 'release', name: '0.1.23', version: '0.1.23' }])
    expect(releaseNames(result.removed)).toEqual(['0.1.33', '0.1.32'])
    expect(f.present(`/opt/xpanel/.retention-${id}`)).toBe(false)
    expect(JSON.parse(readFileSync(`${f.root}${LIFE}/release-retention/${id}.json`, 'utf8'))).toMatchObject({ phase: 'complete', removed: [{ name: '0.1.23' }] })
    expect(f.present(R('0.1.42')) && f.present(R('0.1.43'))).toBe(true)
  })

  it('refuses a retention record whose quarantine path is not the one it derives', async () => {
    const f = fixture(), id = uuid(79)
    f.file(`${LIFE}/release-retention/${id}.json`, { schemaVersion: 1, kind: 'xpanel-release-retention', operationId: id, phase: 'quarantined', owner: null,
      targets: [{ kind: 'release', name: '0.1.23', path: R('0.1.23'), quarantine: '/home/alice', device: '1', inode: '2' }] })
    expect(await codeOf(pruneReleases(f.host()))).toBe('RELEASE_RETENTION_RECORD_UNVERIFIED')
    expect(f.present(R('0.1.23'))).toBe(true)
  })

  it('keeps a newer prepared release, an open preparation with the staging it may use, and recent staging', async () => {
    const f = fixture()
    f.file(R('0.1.44') + '/scripts/entry.mjs', 'export {}\n', 0o644)
    f.prepared('0.1.44')
    const ahead = await pruneReleases(f.host(), { dryRun: true })
    expect(ahead.kept[0]).toEqual({ kind: 'release', name: '0.1.44', reasons: ['prepared'] })
    expect(ahead.remove.some(item => item.version === '0.1.44')).toBe(false)
    expect((await pruneReleases(f.host({ now: () => Date.now() }), { dryRun: true })).kept.at(-1)).toEqual({ kind: 'staging', name: 'authenticated-0123abcd', reasons: ['recent'] })
    f.prepared('0.1.45', false)
    const opening = await pruneReleases(f.host(), { dryRun: true })
    expect(opening.kept.at(-1)).toEqual({ kind: 'staging', name: 'authenticated-0123abcd', reasons: ['preparation-open'] })
    expect(opening.remove.some(item => item.kind === 'staging' || item.version === '0.1.45')).toBe(false)
  })

  it('keeps both sides of an open transition and every release a unit or process names', () => {
    const facts = { current: '0.1.43', helper: '0.1.43', prepared: [], units: ['0.1.32'], processes: ['0.1.23'], staging: [], now: 0,
      releases: ['0.1.23', '0.1.32', '0.1.33', '0.1.42', '0.1.43', '0.1.44'],
      transitions: [{ phase: 'published', selected: 'target', previous: '0.1.42', target: '0.1.43' }, { phase: 'selecting', selected: 'target', previous: '0.1.43', target: '0.1.44' }] }
    const plan = planReleaseRetention(facts)
    expect(plan.kept.map(item => [item.name, item.reasons])).toEqual([['0.1.44', ['transition']], ['0.1.43', ['current', 'transition', 'coordinator']],
      ['0.1.42', ['previous']], ['0.1.32', ['unit']], ['0.1.23', ['process']]])
    expect(plan.remove).toEqual([{ kind: 'release', name: '0.1.33', version: '0.1.33', path: R('0.1.33') }])
  })

  it('refuses when the receipts, the current link and the transition journals disagree', async () => {
    const missing = fixture()
    missing.file(LIFE + '/bootstrap.json', { version: '0.1.43', releaseRoot: R('0.1.43'), installationTransition: { operationId: uuid(55) } })
    expect(await codeOf(pruneReleases(missing.host(), { dryRun: true }))).toBe('RELEASE_RETENTION_CURRENT_UNVERIFIED')
    const receipt = fixture()
    receipt.file(LIFE + '/installation.json', { status: 'active', source: { version: '0.1.42' } })
    expect(await codeOf(pruneReleases(receipt.host(), { dryRun: true }))).toBe('RELEASE_RETENTION_CURRENT_UNVERIFIED')
    const corrupt = fixture()
    corrupt.file(`${LIFE}/installation-transitions/${uuid(2)}.json`, '{"schemaVersion":1', 0o600)
    expect(await codeOf(pruneReleases(corrupt.host(), { dryRun: true }))).toBe('RELEASE_RETENTION_RECORD_UNVERIFIED')
    const writable = fixture()
    chmodSync(writable.root + '/opt/xpanel/releases', 0o777)
    expect(await codeOf(pruneReleases(writable.host(), { dryRun: true }))).toBe('RELEASE_RETENTION_ANCESTRY_UNSAFE')
  })

  it('journals a refused automatic prune and never throws into the upgrade outcome', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(pruneReleasesAfterUpgrade()).resolves.toBeUndefined()
      expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('xpanel-release-retention: upgrade prune withheld code=RELEASE_RETENTION_ROOT_REQUIRED')
    } finally { write.mockRestore() }
  })
})

describe('xpanel-ctl releases prune grammar', () => {
  const reject = (args: string[], code: string) => {
    let thrown: unknown
    try { parseLifecycleArgs(args) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CliUsageError)
    expect((thrown as { code: string }).code).toBe(code)
  }
  it('parses prune and its dry run, and nothing else', () => {
    expect(parseLifecycleArgs(['releases', 'prune'])).toEqual({ schemaVersion: 1, command: 'releases', action: 'prune', mode: 'apply', json: false, assumeYes: false })
    expect(parseLifecycleArgs(['releases', 'prune', '--dry-run', '--json'])).toMatchObject({ command: 'releases', action: 'prune', mode: 'plan', json: true })
    reject(['releases'], 'RELEASES_ACTION_REQUIRED')
    reject(['releases', 'list'], 'RELEASES_ACTION_REQUIRED')
    reject(['releases', 'prune', '--yes'], 'RELEASES_OPTION_NOT_SUPPORTED')
    reject(['releases', 'prune', 'extra'], 'EXTRA_POSITIONAL_ARGUMENT')
    reject(['status', '--dry-run'], 'DRY_RUN_NOT_SUPPORTED')
  })
})
