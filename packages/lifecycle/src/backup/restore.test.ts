import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { stepPaths } from '../steps.ts'
import type { ExecIoStep, LifecycleStep } from '../steps.ts'
import { isUnder } from '../validate.ts'
import { buildManifest } from './manifest.ts'
import type { BackupManifest, ManifestFile } from './manifest.ts'
import { MAX_ARGV_PATHS, diffArchive, restorePlan } from './restore.ts'
import type { ListingEntry, RestoreRequest } from './restore.ts'

const h = (c: string): string => c.repeat(64).slice(0, 64)
const file = (path: string, sha: string, size = 10): ManifestFile => ({ path, part: path.startsWith('home/') ? 'home' : path.startsWith('mysql/') ? 'databases' : 'mail-config', type: 'file', size, sha256: sha })

const manifest: BackupManifest = buildManifest(
  { format: 'xpanel-backup', version: 1, account: { username: 'alice', primaryDomain: 'alice.example' }, parts: ['home', 'databases', 'mail-config'], created: '2026-10-20T00:00:00Z', databases: ['alice_shop', 'alice_wp'] },
  [
    file('home/public_html/index.php', h('a')),
    file('home/public_html/new.php', h('b')),
    file('home/notes.txt', h('c')),
    { path: 'home/www', part: 'home', type: 'symlink', size: 0, sha256: h('d') },
    file('mysql/alice_wp.sql', h('e')),
    file('mysql/alice_shop.sql', h('e')),
    file('mail-config.json', h('f')),
  ],
)

const listing: ListingEntry[] = [
  { path: 'public_html/index.php', type: 'file', size: 10, sha256: h('9') },
  { path: 'notes.txt', type: 'file', size: 10, sha256: h('c') },
  { path: 'www', type: 'file', size: 0, sha256: h('d') },
  { path: 'public_html/uploaded-after-backup.jpg', type: 'file', size: 5, sha256: h('1') },
]

const WORK = '/var/lib/xpanel/backups/work/restore-alice-20261022T013500Z'

const req = (over: Partial<RestoreRequest> = {}): RestoreRequest => ({
  os: { family: 'rhel' },
  account: { username: 'alice', home: '/home/alice', primaryDomain: 'alice.example', domains: [] },
  manifest,
  archivePath: '/var/lib/xpanel/backups/uploads/alice/backup.tar.gz',
  parts: ['home', 'databases', 'mail-config'],
  stamp: '20261022T013500Z',
  ...over,
})

const allArgv = (steps: LifecycleStep[]): string[] => steps.flatMap((s) => (s.kind === 'exec' || s.kind === 'exec-io' ? s.argv : []))
const DELETING_FLAGS = ['--recursive-unlink', '--unlink-first', '--remove-files', '--delete', '--overwrite']

describe('diffArchive', () => {
  it('splits archive vs disk into added, changed, unchanged and missing', () => {
    expect(diffArchive(manifest, listing)).toEqual({
      added: ['public_html/new.php'],
      changed: ['public_html/index.php', 'www'],
      unchanged: ['notes.txt'],
      missingInArchive: ['public_html/uploaded-after-backup.jpg'],
    })
  })

  it('handles an empty home and an empty archive', () => {
    expect(diffArchive(manifest, []).added).toHaveLength(4)
    const noHome = buildManifest({ ...manifest, parts: ['databases'], databases: ['alice_wp'] }, [file('mysql/alice_wp.sql', h('e'))])
    expect(diffArchive(noHome, listing)).toEqual({ added: [], changed: [], unchanged: [], missingInArchive: listing.map((l) => l.path).sort() })
  })

  it('counts a size change with the same digest as changed', () => {
    expect(diffArchive(manifest, [{ path: 'notes.txt', type: 'file', size: 11, sha256: h('c') }]).changed).toEqual(['notes.txt'])
  })

  it('rejects hostile listings', () => {
    for (const bad of [
      [{ path: '../etc/passwd', type: 'file', size: 1, sha256: h('a') }],
      [{ path: '/etc/passwd', type: 'file', size: 1, sha256: h('a') }],
      [{ path: 'a', type: 'fifo', size: 1, sha256: h('a') }],
      [{ path: 'a', type: 'file', size: -1, sha256: h('a') }],
      [{ path: 'a', type: 'file', size: 1, sha256: 'nothex' }],
      [{ path: 'a', type: 'file', size: 1, sha256: h('a') }, { path: 'a', type: 'file', size: 1, sha256: h('a') }],
      'not a list',
    ]) expect(() => diffArchive(manifest, bad as ListingEntry[])).toThrow(XpanelError)
  })
})

describe('restorePlan', () => {
  it('restores only added and changed files and never deletes files missing from the archive', () => {
    const diff = diffArchive(manifest, listing)
    const p = restorePlan(req({ diff }))
    expect(p.homePaths).toEqual(['public_html/index.php', 'public_html/new.php', 'www'])
    const extract = p.steps.find((s): s is ExecIoStep => s.kind === 'exec-io' && s.argv[0] === '/usr/bin/tar')
    expect(extract).toEqual({
      kind: 'exec-io',
      argv: ['/usr/bin/tar', '--extract', '--gzip', '--file=-', '--directory=/home/alice', '--no-same-owner', '--no-overwrite-dir', '--no-wildcards', '--', './public_html/index.php', './public_html/new.php', './www'],
      runAsUser: 'alice',
      stdinFrom: `${WORK}/home.tar.gz`,
    })
    expect(p.steps.filter((s) => s.kind === 'remove-path')).toEqual([{ kind: 'remove-path', path: WORK }])
    expect(allArgv(p.steps).filter((a) => DELETING_FLAGS.some((f) => a.startsWith(f)))).toEqual([])
    expect(JSON.stringify(p.steps)).not.toContain('uploaded-after-backup.jpg')
    expect(p.steps[0]).toEqual({ kind: 'verify-archive', path: '/var/lib/xpanel/backups/uploads/alice/backup.tar.gz', username: 'alice' })
  })

  it('restoring databases does not touch the home', () => {
    const p = restorePlan(req({ parts: ['databases'], databases: ['alice_wp'] }))
    expect(p.steps.flatMap(stepPaths).filter((x) => isUnder(x, '/home/alice'))).toEqual([])
    expect(allArgv(p.steps).filter((a) => a.includes('/home'))).toEqual([])
    expect(p.homePaths).toEqual([])
    expect(p.steps.map((s) => s.kind)).toEqual(['verify-archive', 'ensure-dir', 'exec', 'desired-state', 'reconcile', 'exec-io', 'remove-path'])
    expect(p.steps.find((s): s is ExecIoStep => s.kind === 'exec-io')).toEqual({
      kind: 'exec-io',
      argv: ['/usr/bin/mariadb', '--no-defaults', '--user=alice', '--batch', '--sandbox', '--one-database', '--default-character-set=utf8mb4', 'alice_wp'],
      runAsUser: 'alice',
      stdinFrom: `${WORK}/mysql/alice_wp.sql`,
    })
    const outer = p.steps.find((s) => s.kind === 'exec')
    expect(outer?.kind === 'exec' && outer.argv.slice(-2)).toEqual(['--', 'mysql/alice_wp.sql'])
    expect(p.steps).toContainEqual({ kind: 'desired-state', op: 'ensure-database', username: 'alice', database: 'alice_wp' })
  })

  it('restores every database by default, each through the sandboxed client as the account', () => {
    const p = restorePlan(req({ parts: ['databases'] }))
    expect(p.databases).toEqual(['alice_shop', 'alice_wp'])
    const imports = p.steps.filter((s): s is ExecIoStep => s.kind === 'exec-io')
    expect(imports.map((s) => [s.argv.at(-1), s.runAsUser, s.argv.includes('--sandbox')])).toEqual([['alice_shop', 'alice', true], ['alice_wp', 'alice', true]])
  })

  it('merges mail config through desired state instead of writing files', () => {
    const p = restorePlan(req({ parts: ['mail-config'] }))
    expect(p.steps).toContainEqual({ kind: 'desired-state', op: 'merge-mail-config', username: 'alice', from: `${WORK}/mail-config.json` })
    expect(p.steps.some((s) => s.kind === 'exec-io')).toBe(false)
    expect(p.steps.flatMap(stepPaths).filter((x) => isUnder(x, '/home/alice'))).toEqual([])
  })

  it('skips home extraction when nothing changed and falls back to the whole archive for huge diffs', () => {
    const none = restorePlan(req({ parts: ['home'], diff: { added: [], changed: [], unchanged: ['notes.txt'], missingInArchive: [] } }))
    expect(none.steps.some((s) => s.kind === 'exec-io' || s.kind === 'exec')).toBe(false)
    expect(none.homePaths).toEqual([])

    const many = Array.from({ length: MAX_ARGV_PATHS + 1 }, (_, i) => file(`home/f${i}`, h('a')))
    const big = buildManifest({ ...manifest, parts: ['home'], databases: [] }, many)
    const p = restorePlan(req({ manifest: big, parts: ['home'], diff: { added: many.map((f) => f.path.slice(5)), changed: [], unchanged: [], missingInArchive: [] } }))
    expect(p.homePaths).toBe('all')
    const extract = p.steps.find((s): s is ExecIoStep => s.kind === 'exec-io')
    expect(extract?.argv).not.toContain('--')
    expect(allArgv(p.steps).filter((a) => DELETING_FLAGS.some((f) => a.startsWith(f)))).toEqual([])
  })

  it('a home restore without a diff extracts the whole home archive as the account', () => {
    const p = restorePlan(req({ parts: ['home'] }))
    expect(p.homePaths).toBe('all')
    expect(p.steps.filter((s): s is ExecIoStep => s.kind === 'exec-io').map((s) => s.runAsUser)).toEqual(['alice'])
  })

  it('rejects mismatched or hostile requests', () => {
    const other = buildManifest({ ...manifest, account: { username: 'bob', primaryDomain: 'bob.example' }, databases: ['bob_wp'] }, [file('home/x', h('a')), file('mysql/bob_wp.sql', h('b')), file('mail-config.json', h('c'))])
    expect(() => restorePlan(req({ manifest: other }))).toThrow(/use an import/)
    expect(() => restorePlan(req({ diff: { added: ['../../etc/shadow'], changed: [], unchanged: [], missingInArchive: [] } }))).toThrow(XpanelError)
    expect(() => restorePlan(req({ diff: { added: ['--to-command=sh'], changed: [], unchanged: [], missingInArchive: [] } }))).toThrow(/not in the backup/)
    expect(() => restorePlan(req({ databases: ['alice_other'] }))).toThrow(XpanelError)
    expect(() => restorePlan(req({ parts: [] }))).toThrow(XpanelError)
    expect(() => restorePlan(req({ archivePath: '/tmp/../etc/x' }))).toThrow(XpanelError)
    expect(() => restorePlan(req({ archivePath: '/home/alice/backups/x.tar.gz' }))).toThrow(/outside the home/)
    // root reads the archive: no path inside any account's home, which could be a symlink to /etc/shadow
    expect(() => restorePlan(req({ archivePath: '/home/bob/backup.tar.gz' }))).toThrow(/outside the homes/)
    expect(() => restorePlan(req({ archivePath: '/home2/alice/backup.tar.gz' }))).toThrow(/outside the homes/)
    expect(() => restorePlan(req({ stamp: '$(id)' }))).toThrow(XpanelError)
    expect(() => restorePlan(req({ manifest: { ...manifest, files: [] } }))).toThrow(XpanelError)
    const homeOnly = buildManifest({ ...manifest, parts: ['home'], databases: [] }, [file('home/x', h('a'))])
    expect(() => restorePlan(req({ manifest: homeOnly, parts: ['databases'] }))).toThrow(/does not contain/)
  })
})
