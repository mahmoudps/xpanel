import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import * as archives from './account-backup.ts'
import { accountBackupPreview, downloadAccountBackup, handleAccountBackupAgentRequest, inspectAccountBackupArchive, previewAccountBackup, restoreAccountBackupWithRecovery } from './account-backup-workspace.ts'
import type { AccountBackupIdentity, AccountHomeEntry } from './account-backup-workspace.ts'
import { FakeHostExecutor } from './executor.ts'

// Actual tar.gz and filesystem descriptors. Privileged execution/home reads are explicit fakes;
// these tests do not qualify Linux uid isolation, native tar execution or disaster recovery.
const account: AccountBackupIdentity = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', home: '/home/alice', uid: 20014, gid: 20014, status: 'active' }
const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const roots: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const currentFile = (path: string, text: string): AccountHomeEntry => ({ path, type: 'file', bytes: Buffer.byteLength(text), mode: 0o640, uid: account.uid, gid: account.gid, links: 1, mtimeMs: 1, sha256: digest(text) })
const fixture = async (entries: Parameters<typeof buildTar>[0] = [{ name: './public_html/index.html', content: 'new', mode: 0o640 }]) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-account-backup-')); roots.push(root)
  await mkdir(join(root, account.username), { mode: 0o700 })
  const bytes = await buildTar(entries, { gzip: true })
  await writeFile(join(root, account.username, file), bytes, { mode: 0o600 })
  return { root, bytes, path: join(root, account.username, file) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(root))
    if (!child || child === '..' || isAbsolute(child) || child.startsWith('..' + sep) || basename(root).indexOf('xpanel-account-backup-') !== 0) throw new Error('refusing unrelated fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

describe('account archive inspection and ownership', () => {
  it('inspects real gzip bytes and reports exact file digests', async () => {
    const f = await fixture()
    const result = await inspectAccountBackupArchive({ root: f.root, account, file })
    expect(result).toMatchObject({ file, bytes: f.bytes.length, sha256: digest(f.bytes), files: [{ path: 'public_html/index.html', bytes: 3, mode: 0o640, sha256: digest('new') }] })
  })
  it('binds every compressed byte of an archive larger than the filesystem read chunk', async () => {
    const f = await fixture([{ name: 'large.bin', content: randomBytes(180000), mode: 0o640 }])
    expect(f.bytes.length).toBeGreaterThan(65536)
    expect((await inspectAccountBackupArchive({ root: f.root, account, file })).sha256).toBe(digest(f.bytes))
  })
  it.each([
    [{ name: '../outside', content: 'escape' }], [{ name: '/absolute', content: 'escape' }],
    [{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }],
    [{ name: 'link', type: 'link', linkname: 'public_html/index.html' }],
    [{ name: 'fifo', type: 'fifo' }],
    [{ name: 'same', content: 'a' }, { name: 'same', content: 'b' }],
  ].map(entries => ({ entries })))('rejects unsafe archive members before any restore effect: %j', async ({ entries }) => {
    const f = await fixture(entries as Parameters<typeof buildTar>[0])
    const executor = new FakeHostExecutor(), recovery = vi.fn()
    await expect(restoreAccountBackupWithRecovery({ executor, root: f.root, account, file, expectedRevision: '0'.repeat(64), confirmation: account.username, readCurrent: async () => [], createRecovery: recovery })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(executor.executedActions).toHaveLength(0); expect(recovery).not.toHaveBeenCalled()
  })
  it('refuses corrupt compressed bytes, foreign names, nonregular files and hard-linked archives', async () => {
    const f = await fixture()
    await expect(inspectAccountBackupArchive({ root: f.root, account, file: file.replace('alice', 'bob') })).rejects.toMatchObject({ code: 'VALIDATION' })
    const second = 'xpanel-backup-alice-20261026T100001Z.tar.gz'
    await link(f.path, join(f.root, account.username, second))
    await expect(archives.openAccountBackupArchive(f.root, account, file)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await rm(join(f.root, account.username, second))
    await writeFile(f.path, 'not a gzip archive')
    await expect(inspectAccountBackupArchive({ root: f.root, account, file })).rejects.toMatchObject({ code: 'VALIDATION' })
    await rm(f.path); await mkdir(f.path)
    await expect(archives.openAccountBackupArchive(f.root, account, file)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('binds differences to archive bytes, current contents and the persistent account identity', () => {
    const inventory = { file, bytes: 123, sha256: digest('archive'), files: [
      { path: 'add.txt', bytes: 3, sha256: digest('new'), mode: 0o640 },
      { path: 'change.txt', bytes: 3, sha256: digest('new'), mode: 0o640 },
      { path: 'same.txt', bytes: 4, sha256: digest('same'), mode: 0o640 },
      { path: 'mail/domain/inbox', bytes: 4, sha256: digest('mail'), mode: 0o640 },
    ], parts: [] }
    const current = [currentFile('change.txt', 'old'), currentFile('same.txt', 'same'), currentFile('keep.txt', 'keep')]
    const preview = accountBackupPreview(account, inventory, current)
    expect(preview.counts).toEqual({ add: 1, replace: 1, unchanged: 1, keep: 1, 'preserve-mail': 1 })
    expect(preview.mailPreserved).toBe(true)
    expect(accountBackupPreview({ ...account, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, inventory, current).revision).not.toBe(preview.revision)
    expect(accountBackupPreview(account, { ...inventory, sha256: digest('changed archive') }, current).revision).not.toBe(preview.revision)
    expect(accountBackupPreview(account, inventory, [currentFile('change.txt', 'other'), ...current.slice(1)]).revision).not.toBe(preview.revision)
    expect(() => accountBackupPreview(account, { ...inventory, files: [{ ...inventory.files[0]!, path: 'blocked/file' }] }, [{ ...currentFile('blocked', ''), type: 'symlink' }])).toThrow()
  })
  it('does not expose legacy username archives to a new account namespace or allocate on a read', async () => {
    const f = await fixture(), executor = new FakeHostExecutor(), authorized = vi.fn()
    const withAccountLease = async <T>(operation: (current: AccountBackupIdentity) => Promise<T>): Promise<T> => { authorized(); return operation(account) }
    const response = await handleAccountBackupAgentRequest(new Request('http://agent.local/accounts/alice/backup-workspace'), { root: f.root, account, executor, withAccountLease })
    expect(await response.json()).toEqual({ backups: [] })
    expect(await readFile(f.path)).toEqual(f.bytes)
    expect(executor.executedActions).toHaveLength(0)
    expect(authorized).toHaveBeenCalledTimes(1)
  })
  it('refuses an identity changed under the lease before accessing archives', async () => {
    const f = await fixture(), executor = new FakeHostExecutor()
    await expect(handleAccountBackupAgentRequest(new Request('http://agent.local/accounts/alice/backup-workspace'), { root: f.root, account, executor,
      withAccountLease: async operation => operation({ ...account, uid: account.uid + 1 }) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(executor.executedActions).toHaveLength(0)
  })
})

describe('actual archive descriptor downloads', () => {
  it('streams the pinned bytes even after the pathname is replaced', async () => {
    const f = await fixture([{ name: 'data.bin', content: randomBytes(160000), mode: 0o640 }])
    expect(f.bytes.length).toBeGreaterThan(65536)
    const response = await downloadAccountBackup({ root: f.root, account, file })
    await rename(f.path, f.path + '.retained')
    await writeFile(f.path, 'replacement')
    expect(response.headers.get('content-length')).toBe(String(f.bytes.length))
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="' + file + '"')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes)
  })
  it('closes the actual retained descriptor when the response is cancelled', async () => {
    const f = await fixture(), original = archives.openAccountBackupArchive
    let closed = 0
    vi.spyOn(archives, 'openAccountBackupArchive').mockImplementation(async (...args) => {
      const opened = await original(...args), close = opened.handle.close.bind(opened.handle)
      vi.spyOn(opened.handle, 'close').mockImplementation(async () => { closed++; await close() })
      return opened
    })
    const response = await downloadAccountBackup({ root: f.root, account, file })
    await response.body!.cancel()
    expect(closed).toBe(1)
  })
})

describe('recovery-bound home restore with a declared fake host', () => {
  it('requires the reviewed revision, retains a real recovery archive and checks restored contents', async () => {
    const f = await fixture(), home = [currentFile('public_html/index.html', 'old')]
    const readCurrent = async () => structuredClone(home)
    const reviewed = await previewAccountBackup({ root: f.root, account, file, readCurrent })
    const executor = new FakeHostExecutor()
    // This portable fixture records intended Linux actions; Windows temp paths are not native argv proof.
    vi.spyOn(executor, 'runCommand').mockImplementation(async argv => { executor.executedCommands.push(argv); return { ok: true, code: 0, stderr: '', stdout: './public_html/index.html\n' } })
    vi.spyOn(executor, 'runAction').mockImplementation(async action => { executor.executedActions.push(action); if (action.kind === 'exec' && action.argv.includes('--extract')) home[0] = currentFile('public_html/index.html', 'new') })
    const recoveryFile = 'xpanel-backup-alice-20261026T100002Z-abcdef012345.tar.gz'
    const recoveryBytes = await buildTar([{ name: './public_html/index.html', content: 'old', mode: 0o640 }], { gzip: true })
    const createRecovery = vi.fn(async () => { await writeFile(join(f.root, account.username, recoveryFile), recoveryBytes, { mode: 0o600 }); return { file: recoveryFile, bytes: recoveryBytes.length } })
    await expect(restoreAccountBackupWithRecovery({ executor, root: f.root, account, file, expectedRevision: '0'.repeat(64), confirmation: account.username, readCurrent, createRecovery })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(createRecovery).not.toHaveBeenCalled(); expect(executor.executedActions).toHaveLength(0)
    const unrelatedRecovery = await buildTar([{ name: 'unrelated.txt', content: 'old' }], { gzip: true })
    await expect(restoreAccountBackupWithRecovery({ executor, root: f.root, account, file, expectedRevision: reviewed.revision, confirmation: account.username, readCurrent,
      createRecovery: async () => { await writeFile(join(f.root, account.username, recoveryFile), unrelatedRecovery, { mode: 0o600 }); return { file: recoveryFile, bytes: unrelatedRecovery.length } } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(executor.executedActions).toHaveLength(0)
    const result = await restoreAccountBackupWithRecovery({ executor, root: f.root, account, file, expectedRevision: reviewed.revision, confirmation: account.username, readCurrent, createRecovery })
    expect(result).toMatchObject({ file, scope: 'home', mailPreserved: true, contentReadback: 'matched', recovery: { file: recoveryFile, bytes: recoveryBytes.length } })
    expect(await readFile(join(f.root, account.username, recoveryFile))).toEqual(recoveryBytes)
    const extraction = executor.executedActions.find(action => action.kind === 'exec' && action.argv.includes('--extract'))
    expect(extraction).toMatchObject({ kind: 'exec', runAsUser: account.username })
    expect(extraction?.kind === 'exec' && extraction.argv.includes('--exclude=./mail') && extraction.argv.includes('--exclude=./etc') && !extraction.argv.some(arg => arg.includes('*'))).toBe(true)
  })
})
