import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_COMPRESSOR, backupPartOf, buildControlSnapshot, buildServerBackupArchive, extractBackupPart, listControlSnapshot, listServerBackupArchive, readBackupArchiveListing, readBackupDataManifest } from './acct-backup-archive.ts'
import type { BackupCommand, BackupCommandResult } from './backup-low-priority.ts'
import { BACKUP_LOW_PRIORITY, lowPriorityArgv, runBackupCommand, zstdDecompressed } from './backup-low-priority.ts'

// Fake command runner over real files: it checks the argv each step receives, not GNU tar, gzip or MariaDB themselves.
const account = { username: 'alice', home: '/home/alice', uid: 20014, status: 'active' }
const SHA = 'a'.repeat(64), FILE = 'xpanel-backup-alice-20261028T020000Z.tar.gz', ZST = 'xpanel-backup-alice-20261028T020000Z.tar.zst'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) if (basename(root).startsWith('xpanel-backup-archive-')) await rm(root, { recursive: true, force: true }) })
const temp = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'xpanel-backup-archive-')); roots.push(root); return root }
const ok = (stdoutBytes = 0, stdout = ''): BackupCommandResult => ({ ok: true, code: 0, stdout, stderr: '', stdoutBytes, killed: null })
const fakeRun = (overrides: Partial<Record<'create' | 'append' | 'gzip', BackupCommandResult>> = {}) => vi.fn(async (command: BackupCommand): Promise<BackupCommandResult> => {
  const step = command.argv.includes('--create') ? 'create' : command.argv.includes('--append') ? 'append' : 'gzip'
  if (overrides[step]) return overrides[step]!
  if (command.stdoutPath) await writeFile(command.stdoutPath, step === 'gzip' ? 'gz' : 'tar', { flag: 'wx' })
  return ok(step === 'gzip' ? 2 : 3)
})
const zone = { name: 'alice.example.test', content: JSON.stringify({ id: 'z', accountId: 'a', name: 'alice.example.test', serial: 1, records: [] }) }

describe('server backup archive build', () => {
  it('streams the home as the account, appends root-written dumps and zones with a manifest and publishes only the complete gzip', async () => {
    const root = await temp(), run = fakeRun()
    const dump = vi.fn(async (_account: unknown, name: string, path: string) => { await writeFile(path, 'dump of ' + name, { flag: 'wx' }); return { bytes: 12, sha256: SHA } })
    const built = await buildServerBackupArchive({ root, account, databases: ['alice_wp', 'alice_shop', 'alice_wp'], zones: [zone], excludeMail: true, compression: 'gzip', now: new Date('2026-10-28T02:00:00.000Z'), deps: { run, dump } })
    expect(built).toEqual({ file: FILE, bytes: 2, databases: ['alice_shop', 'alice_wp'], zones: ['alice.example.test'] })
    expect(await readdir(join(root, 'alice'))).toEqual([built.file])
    expect(await readFile(join(root, 'alice', built.file), 'utf8')).toBe('gz')
    const [create, append, gzip] = run.mock.calls.map(call => call[0])
    expect(create).toMatchObject({ runAsUser: 'alice', argv: ['/usr/bin/tar', '--create', '--file=-', '--directory=/home/alice', '--exclude=./.xpanel-backup-*', '--exclude=./mail', '--exclude=./etc', '--', '.'] })
    expect(append!.runAsUser).toBeUndefined()
    expect(append!.argv).toEqual(expect.arrayContaining(['/usr/bin/tar', '--append', '--owner=0', '--group=0', '--', '.xpanel-backup-data']))
    expect(gzip).toMatchObject({ argv: ['/usr/bin/gzip', '-c', '-n', '-6'], maxStdoutBytes: 2 * 1024 * 1024 * 1024 })
    expect(dump.mock.calls.map(call => call[1])).toEqual(['alice_shop', 'alice_wp'])
  })
  it('writes a Zstandard schedule as one .tar.zst through zstd level 3, one thread, with the frame checksum', async () => {
    const root = await temp(), run = fakeRun(), dump = vi.fn(async () => ({ bytes: 1, sha256: SHA }))
    const built = await buildServerBackupArchive({ root, account, databases: [], zones: [], excludeMail: false, compression: 'zstd', now: new Date('2026-10-28T02:00:00.000Z'), deps: { run, dump } })
    expect(built.file).toBe(ZST)
    expect(await readdir(join(root, 'alice'))).toEqual([ZST])
    expect(run.mock.calls.at(-1)![0]).toMatchObject({ argv: ['/usr/bin/zstd', '-q', '-c', '-3', '--check', '--single-thread'], maxStdoutBytes: 2 * 1024 * 1024 * 1024 })
    expect(run.mock.calls.at(-1)![0].stdinPath).toMatch(/\/home\.tar$/)
    const control = await buildControlSnapshot({ root, stateDir: '/var/lib/xpanel/state', copyDatabase: async path => { await writeFile(path, 'sqlite', { flag: 'wx' }) }, run: fakeRun(), compression: 'zstd', now: new Date('2026-10-28T02:00:00.000Z') })
    expect(control.file).toBe('xpanel-control-20261028T020000Z.tar.zst')
  })
  it('refuses foreign parts, keeps no partial archive on failure and never overwrites an archive', async () => {
    const root = await temp(), dump = vi.fn(async () => ({ bytes: 1, sha256: SHA }))
    const base = { root, account, zones: [], excludeMail: false, compression: 'gzip' as const }
    await expect(buildServerBackupArchive({ ...base, databases: ['bob_wp'], deps: { run: fakeRun(), dump } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(buildServerBackupArchive({ ...base, databases: [], zones: [{ name: '../etc', content: '{}' }], deps: { run: fakeRun(), dump } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(buildServerBackupArchive({ ...base, databases: [], deps: { run: fakeRun({ create: { ...ok(), ok: false, code: 2, stderr: 'tar: /home/alice: Cannot open' } }), dump } })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message: expect.stringContaining('Cannot open') })
    await expect(buildServerBackupArchive({ ...base, databases: [], deps: { run: fakeRun({ gzip: { ...ok(), ok: false, code: 137, killed: 'output limit' } }), dump } })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(await readdir(join(root, 'alice'))).toEqual([])
    // GNU tar exit 1 (a file changed while read) still produces a complete archive.
    const now = new Date('2026-10-28T03:00:00.000Z')
    await buildServerBackupArchive({ ...base, databases: [], now, deps: { run: fakeRun({ create: { ...ok(3), ok: false, code: 1 } }), dump } })
    await expect(buildServerBackupArchive({ ...base, databases: [], now, deps: { run: fakeRun(), dump } })).rejects.toThrow()
  })
  it('takes the control snapshot from the state directory plus a database copy, outside every account directory', async () => {
    const root = await temp(), run = fakeRun(), copyDatabase = vi.fn(async (path: string) => { await writeFile(path, 'sqlite', { flag: 'wx' }) })
    const built = await buildControlSnapshot({ root, stateDir: '/var/lib/xpanel/state', copyDatabase, run, compression: 'gzip', now: new Date('2026-10-28T02:00:00.000Z') })
    expect(built).toEqual({ file: 'xpanel-control-20261028T020000Z.tar.gz', bytes: 2 })
    expect(await readdir(join(root, '_control'))).toEqual([built.file])
    expect(run.mock.calls[0]![0]).toMatchObject({ argv: ['/usr/bin/tar', '--create', '--file=-', '--directory=/var/lib/xpanel/state', '--', '.'] })
    expect(run.mock.calls[0]![0].runAsUser).toBeUndefined()
    expect(run.mock.calls[1]![0].argv).toEqual(expect.arrayContaining(['--append', '--', 'control.db']))
    expect(copyDatabase).toHaveBeenCalledTimes(1)
    const listing = vi.fn(async () => ok(0, './\n./accounts/alice.json\ncontrol.db\n'))
    expect(await listControlSnapshot({ root, file: built.file, run: listing })).toEqual({ members: 3 })
    await expect(listControlSnapshot({ root, file: built.file, run: vi.fn(async () => ok(0, './\n')) })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(listControlSnapshot({ root, file: '../x.tar.gz', run: listing })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('archive listing and manifest', () => {
  it('reads the part members and refuses escaping paths or a planted home copy of the data directory', () => {
    expect(readBackupArchiveListing('./\n./public_html/index.html\n.xpanel-backup-data/\n.xpanel-backup-data/databases/\n.xpanel-backup-data/databases/alice_wp.sql\n.xpanel-backup-data/dns/alice.example.test.json\n.xpanel-backup-data/manifest.json\n'))
      .toEqual({ members: 7, databases: ['alice_wp'], zones: ['alice.example.test'], manifest: true })
    expect(readBackupArchiveListing('./\n./caf\\303\\251.txt\n')).toEqual({ members: 2, databases: [], zones: [], manifest: false })
    for (const listing of ['/etc/passwd\n', './a/../../b\n', './.xpanel-backup-data/databases/alice_wp.sql\n', '.xpanel-backup-data/databases/alice_wp.sql\n', '.xpanel-backup-data/notes.txt\n.xpanel-backup-data/manifest.json\n'])
      expect(() => readBackupArchiveListing(listing)).toThrow()
    expect(backupPartOf('.xpanel-backup-data/dns/alice.example.test.json')).toEqual({ part: 'dns', name: 'alice.example.test' })
    expect(backupPartOf('public_html/.xpanel-backup-data/databases/alice_wp.sql')).toBeNull()
  })
  it('accepts only a manifest of the account own databases and valid zones', () => {
    const manifest = { version: 1, username: 'alice', databases: [{ name: 'alice_wp', bytes: 10, sha256: SHA }], zones: [{ name: 'alice.example.test', bytes: 5, sha256: SHA }] }
    expect(readBackupDataManifest(manifest, 'alice').zones).toHaveLength(1)
    for (const raw of [{ ...manifest, username: 'bob' }, { ...manifest, databases: [{ name: 'bob_wp', bytes: 10, sha256: SHA }] }, { ...manifest, zones: [{ name: 'a/b', bytes: 1, sha256: SHA }] }, { ...manifest, databases: [manifest.databases[0], manifest.databases[0]] }, { ...manifest, extra: 1 }])
      expect(() => readBackupDataManifest(raw, 'alice')).toThrow()
  })
  it('lists and extracts one part at low priority with exact sizes', async () => {
    const commands: BackupCommand[] = []
    const run = vi.fn(async (command: BackupCommand) => {
      commands.push(command)
      if (command.argv.includes('--list')) return ok(0, './\n.xpanel-backup-data/databases/alice_wp.sql\n.xpanel-backup-data/manifest.json\n')
      return ok(command.argv.at(-1) === '.xpanel-backup-data/databases/alice_wp.sql' ? 10 : 9)
    })
    expect(await listServerBackupArchive({ root: '/backups', account, file: FILE, run })).toMatchObject({ databases: ['alice_wp'], zones: [] })
    expect(commands[0]!.argv).toEqual(['/usr/bin/tar', '--list', '--gzip', '--file=/backups/alice/' + FILE])
    const expected = { name: 'alice_wp', bytes: 10, sha256: SHA }
    expect(await extractBackupPart({ root: '/backups', account, file: FILE, part: 'database', name: 'alice_wp', expected, outputPath: '/stage/x.sql', run })).toEqual(expected)
    await expect(extractBackupPart({ root: '/backups', account, file: FILE, part: 'dns', name: 'alice.example.test', expected: { ...expected, name: 'alice.example.test' }, outputPath: '/stage/y.json', run })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const failed = vi.fn(async () => ({ ...ok(), ok: false, code: 2, stderr: 'gzip: stdin: invalid compressed data--crc error' }))
    await expect(listServerBackupArchive({ root: '/backups', account, file: FILE, run: failed })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('reads a .tar.zst archive only with tar --zstd, and a failed read never lists it', async () => {
    const commands: BackupCommand[] = []
    const run = vi.fn(async (command: BackupCommand) => { commands.push(command); return command.argv.includes('--list') ? ok(0, './\n') : ok(10) })
    await listServerBackupArchive({ root: '/backups', account, file: ZST, run })
    await extractBackupPart({ root: '/backups', account, file: ZST, part: 'database', name: 'alice_wp', expected: { name: 'alice_wp', bytes: 10, sha256: SHA }, outputPath: '/stage/x.sql', run })
    await listControlSnapshot({ root: '/backups', file: 'xpanel-control-20261028T020000Z.tar.zst', run: vi.fn(async () => ok(0, 'control.db\n')) })
    expect(commands.map(command => command.argv.slice(0, 3))).toEqual([['/usr/bin/tar', '--list', '--zstd'], ['/usr/bin/tar', '--extract', '--zstd']])
    const failed = vi.fn(async () => ({ ...ok(), ok: false, code: 2, stderr: 'zstd: /*stdin*\\: checksum error' }))
    await expect(listServerBackupArchive({ root: '/backups', account, file: ZST, run: failed })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('prefixes every backup command with nice and ionice, and runuser for account work', () => {
    expect(lowPriorityArgv({ argv: ['/usr/bin/tar', '--create'], runAsUser: 'alice' })).toEqual([...BACKUP_LOW_PRIORITY, '/usr/sbin/runuser', '-u', 'alice', '--', '/usr/bin/tar', '--create'])
    expect(BACKUP_LOW_PRIORITY).toEqual(['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '2', '-n', '7'])
    for (const command of [{ argv: ['tar'] }, { argv: [] }, { argv: ['/usr/bin/tar'], runAsUser: 'Root' }]) expect(() => lowPriorityArgv(command)).toThrow()
  })
  // Runs on the Linux lab host (nice, ionice, echo, yes present); skipped on other platforms.
  it.runIf(process.platform === 'linux')('runs a real low-priority child, writes stdout to a new file and kills it past the output bound', async () => {
    const root = await temp()
    expect(await runBackupCommand({ argv: ['/bin/echo', 'archive'], stdoutPath: join(root, 'out'), maxStdoutBytes: 100 })).toMatchObject({ ok: true, stdoutBytes: 8, killed: null })
    expect(await readFile(join(root, 'out'), 'utf8')).toBe('archive\n')
    await expect(runBackupCommand({ argv: ['/bin/echo', 'again'], stdoutPath: join(root, 'out'), maxStdoutBytes: 100 })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await runBackupCommand({ argv: ['/usr/bin/yes'], maxStdoutBytes: 1024 })).toMatchObject({ ok: false, killed: 'output limit' })
    expect(await runBackupCommand({ argv: ['/bin/cat'], stdinText: 'batch\n', maxStdoutBytes: 100 })).toMatchObject({ ok: true, stdout: 'batch\n' })
  })
  // Real GNU tar and zstd on the Linux lab host: the frame checksum gates the archive read in both readers.
  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/zstd'))('round-trips a real .tar.zst and refuses it after one changed byte', async () => {
    const root = await temp(), home = join(root, 'home'), dir = join(root, 'alice')
    await mkdir(home); await mkdir(dir); await writeFile(join(home, 'index.php'), '<?php echo "hello";\n'.repeat(200))
    expect(await runBackupCommand({ argv: ['/usr/bin/tar', '--create', '--file=-', `--directory=${home}`, '--', '.'], stdoutPath: join(root, 'home.tar'), maxStdoutBytes: 1 << 20 })).toMatchObject({ ok: true })
    expect(await runBackupCommand({ argv: BACKUP_COMPRESSOR.zstd, stdinPath: join(root, 'home.tar'), stdoutPath: join(dir, ZST), maxStdoutBytes: 1 << 20 })).toMatchObject({ ok: true })
    expect(await listServerBackupArchive({ root, account, file: ZST, run: runBackupCommand })).toMatchObject({ members: 2, manifest: false })
    const bytes = await readFile(join(dir, ZST)), tar = await readFile(join(root, 'home.tar'))
    const read = async (): Promise<Buffer> => { const parts: Buffer[] = []; for await (const chunk of zstdDecompressed((async function* () { yield bytes })())) parts.push(chunk); return Buffer.concat(parts) }
    expect((await read()).equals(tar)).toBe(true)
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 2) ^ 0xff, bytes.length - 2)
    await writeFile(join(dir, ZST), bytes)
    await expect(listServerBackupArchive({ root, account, file: ZST, run: runBackupCommand })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'the backup archive failed its integrity read' })
    await expect(read()).rejects.toMatchObject({ code: 'VALIDATION', message: 'the Zstandard archive failed its integrity check' })
  })
})
