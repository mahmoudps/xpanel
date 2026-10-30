import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { cpmoveEntries } from '../../../packages/lifecycle/src/testing/cpanel-fixture.ts'
import { StagingSink, assertTarMembers, createTransferTaskController, handleTransferTaskRoute, lowPriorityArgv, tarCompareProblems } from './lifecycle-transfer-tasks.ts'
import type { TransferCommand, TransferTask, TransferTaskDeps } from './lifecycle-transfer-tasks.ts'

// Agent unit layer: real files in a temporary directory, fake command runner, MariaDB, download and certificate ports.
const cleanup: string[] = []
// the ledger write after a task settles may still be finishing; Windows refuses to remove an open file
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) })
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const account = (username = 'alice'): Account => ({ id: randomUUID(), username, uid: 20001, gid: 20001, home: '/home/' + username, primaryDomain: username + '.example.test', planId: randomUUID(), ownerId: null, status: 'active', suspendReason: null, contactEmail: 'a@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00.000Z' })

const setup = async (overrides: Partial<TransferTaskDeps> & { compare?: string; failOn?: string } = {}, initialTasks?: TransferTask[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'xp-transfer-')); cleanup.push(dir)
  const commands: TransferCommand[] = [], installed: string[] = []
  const alice = account(), certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem')
  await writeFile(certPath, 'CERT'); await writeFile(keyPath, 'KEY')
  const deps: TransferTaskDeps = {
    root: join(dir, 'transfers'), restoreStaging: join(dir, 'restores'), stateRoot: join(dir, 'state'),
    store: {
      getAccountByUsername: async username => username === alice.username ? alice : username === 'bob' ? account('bob') : null,
      readSnapshot: async () => ({ databases: [{ id: 'd1', accountId: alice.id, engine: 'mariadb', name: 'alice_wp', trashedAt: null }, { id: 'd2', accountId: alice.id, engine: 'mariadb', name: 'alice_old', trashedAt: '2026-01-01T00:00:00.000Z' }],
        certificates: [{ id: 'c1', accountId: alice.id, names: ['alice.example.test'], certPath, keyPath, chainPath: null } as never], domains: [] }),
    },
    run: async command => {
      commands.push(command)
      if (overrides.failOn && command.argv.join(' ').includes(overrides.failOn)) return { code: 2, stdout: '', stderr: 'synthetic failure' }
      if (command.stdoutFile) await writeFile(command.stdoutFile, command.argv[0] === '/usr/bin/tar' ? 'HOME-ARCHIVE' : '-- dump of ' + command.argv.at(-1))
      if (command.argv.includes('--compare')) return { code: overrides.compare ? 1 : 0, stdout: overrides.compare ?? '', stderr: '' }
      if (command.argv.includes('--create') && command.argv.some(arg => arg.startsWith('--file='))) await writeFile(command.argv.find(arg => arg.startsWith('--file='))!.slice(7), 'STAGED')
      return { code: 0, stdout: command.argv.includes('--list') ? './\n./public_html/index.php\n' : '', stderr: '' }
    },
    mariadb: { adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', mariadbBinary: '/usr/bin/mariadb', mariadbDumpBinary: '/usr/bin/mariadb-dump', verifyAdminConfig: async () => undefined, verifyDatabaseObjects: async () => ({ tables: [1, 2] }) },
    installCertificate: async (target, domain, fullchain, key) => { installed.push(target.username + ':' + domain + ':' + fullchain + ':' + key); return { certificate: { id: randomUUID(), names: [domain], certPath: '/x/cert', keyPath: '/x/key', notAfter: '2027-06-01T00:00:00.000Z' } } },
    ...overrides,
  }
  if (initialTasks) {
    await mkdir(deps.root!, { recursive: true })
    await writeFile(join(deps.root!, 'tasks.json'), JSON.stringify(initialTasks))
  }
  const controller = createTransferTaskController(deps)
  const settled = async (task: TransferTask): Promise<TransferTask> => {
    for (let i = 0; i < 400; i++) { const current = await controller.get(task.id); if (current.state !== 'queued' && current.state !== 'running') return current; await new Promise(resolve => setTimeout(resolve, 5)) }
    throw new Error('task did not settle')
  }
  return { dir, deps, controller, commands, installed, alice, settled }
}

describe('transfer host tasks', () => {
  it('packages the home as the account user, each live database and each certificate with digests', async () => {
    const t = await setup()
    const task = await t.settled(await t.controller.start({ kind: 'package', username: 'alice' }))
    expect(task.state).toBe('succeeded')
    const artifacts = task.result!.artifacts as { name: string; bytes: number; sha256: string }[]
    expect(artifacts.map(item => item.name)).toEqual(['cert-0.pem', 'db-alice_wp.sql', 'home.tar.gz', 'key-0.pem'])
    expect(artifacts.find(item => item.name === 'home.tar.gz')).toEqual({ name: 'home.tar.gz', bytes: 12, sha256: sha('HOME-ARCHIVE') })
    expect(t.commands[0]).toMatchObject({ asUser: 'alice', argv: ['/usr/bin/tar', '--create', '--gzip', '--directory=/home/alice', '--exclude=./.xpanel-backup-*', '--', '.'] })
    expect(t.commands[1]!.argv).toEqual(expect.arrayContaining(['--single-transaction', '--routines', '--triggers', '--events', '--no-create-db', 'alice_wp']))
    expect(t.commands.some(command => command.argv.includes('alice_old'))).toBe(false)
    expect(task.result!.certificates).toEqual([{ id: 'c1', names: ['alice.example.test'], cert: 'cert-0.pem', key: 'key-0.pem' }])
    expect((await t.controller.openArtifact(task.id, 'home.tar.gz')).bytes).toBe(12)
    await expect(t.controller.openArtifact(task.id, '../tasks.json')).rejects.toThrow(/not found/)
  })
  it('runs every command at the lowest CPU and IO priority, as the account when asked', () => {
    expect(lowPriorityArgv({ argv: ['/usr/bin/tar', '--list'], asUser: 'alice' })).toEqual(['/usr/sbin/runuser', '-u', 'alice', '--', '/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '2', '-n', '7', '/usr/bin/tar', '--list'])
    expect(lowPriorityArgv({ argv: ['/usr/bin/mariadb-dump'] }).slice(0, 7)).toEqual(['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '2', '-n'])
  })
  it('stores fetched artifacts only when size and SHA-256 match, and never keeps a mismatching file', async () => {
    const good = Buffer.from('HOME-ARCHIVE'), urls: string[] = []
    const t = await setup({ download: async ({ url, token }) => { urls.push(url + ' ' + token); return (async function* () { yield url.endsWith('home.tar.gz') ? good : Buffer.from('tampered') })() } })
    const ok = await t.settled(await t.controller.start({ kind: 'fetch', username: 'alice', url: 'https://source.example.test/api/transfers/source/accounts/alice/package/' + randomUUID(), token: 'xp_secret', tlsFingerprint: null, artifacts: [{ name: 'home.tar.gz', bytes: good.length, sha256: sha(good) }] }))
    expect(ok.state).toBe('succeeded'); expect(urls[0]).toMatch(/\/home\.tar\.gz xp_secret$/)
    expect(await readFile(join(t.deps.root!, 'incoming', ok.id, 'home.tar.gz'), 'utf8')).toBe('HOME-ARCHIVE')
    expect(JSON.stringify(await readFile(join(t.deps.root!, 'tasks.json'), 'utf8'))).not.toContain('xp_secret')
    const bad = await t.settled(await t.controller.start({ kind: 'fetch', username: 'alice', url: 'https://source.example.test/p', token: 'xp_secret', tlsFingerprint: null, artifacts: [{ name: 'db-alice_wp.sql', bytes: 8, sha256: sha('expected') }] }))
    expect(bad).toMatchObject({ state: 'failed', error: expect.stringMatching(/does not match its signed size and SHA-256/) })
    expect(await readdir(join(t.deps.root!, 'incoming', bad.id))).toEqual([])
    await expect(t.controller.start({ kind: 'fetch', username: 'alice', url: 'http://source.example.test/p', token: 'x', tlsFingerprint: null, artifacts: [] })).rejects.toThrow(/https/)
  })
  it('restores the home as the account, compares it with the archive, loads renamed databases and installs certificates', async () => {
    const t = await setup({ download: async ({ url }) => (async function* () { yield Buffer.from(url.endsWith('.pem') ? 'PEM' : 'DATA') })() })
    const artifacts = ['home.tar.gz', 'db-alice_wp.sql', 'cert-0.pem', 'key-0.pem'].map(name => ({ name, bytes: name.endsWith('.pem') ? 3 : 4, sha256: sha(name.endsWith('.pem') ? 'PEM' : 'DATA') }))
    const fetched = await t.settled(await t.controller.start({ kind: 'fetch', username: 'bob', url: 'https://source.example.test/p', token: 't', tlsFingerprint: null, artifacts }))
    const restored = await t.settled(await t.controller.start({ kind: 'restore', username: 'bob', fetch: fetched.id, databases: [{ artifact: 'db-alice_wp.sql', target: 'bob_wp' }], certificates: [{ cert: 'cert-0.pem', key: 'key-0.pem', domain: 'bob.example.test' }] }))
    expect(restored).toMatchObject({ state: 'succeeded', result: { home: { compared: true }, databases: [{ name: 'bob_wp', tables: 2 }], certificates: [{ domain: 'bob.example.test' }] } })
    const extract = t.commands.find(command => command.argv.includes('--extract'))!
    expect(extract).toMatchObject({ asUser: 'bob' }); expect(extract.argv).toEqual(expect.arrayContaining(['--directory=/home/bob', '--no-same-owner', '--no-overwrite-dir']))
    expect(t.commands.find(command => command.argv.includes('--database=bob_wp'))?.stdinFile).toMatch(/db-alice_wp\.sql$/)
    expect(t.installed).toEqual(['bob:bob.example.test:PEM:PEM'])
    await expect(readdir(join(t.deps.root!, 'incoming', fetched.id))).rejects.toThrow()
  })
  it('fails a restore whose home differs from the archive and refuses databases outside the account', async () => {
    const t = await setup({ compare: './public_html/index.php: Contents differ\n./x: Mode differs\n', download: async () => (async function* () { yield Buffer.from('DATA') })() })
    const fetched = await t.settled(await t.controller.start({ kind: 'fetch', username: 'bob', url: 'https://s.example.test/p', token: 't', tlsFingerprint: null, artifacts: [{ name: 'home.tar.gz', bytes: 4, sha256: sha('DATA') }] }))
    const restored = await t.settled(await t.controller.start({ kind: 'restore', username: 'bob', fetch: fetched.id, databases: [], certificates: [] }))
    expect(restored).toMatchObject({ state: 'failed', error: expect.stringMatching(/differs from the archive: \.\/public_html\/index\.php: Contents differ$/) })
    expect(tarCompareProblems('./a: Mode differs\n./b: Uid differs\n./c: Mod time differs')).toEqual([])
    expect(() => assertTarMembers('./ok\n../../etc/passwd\n')).toThrow(/outside the account home/)
    await expect(t.controller.start({ kind: 'restore', username: 'bob', fetch: fetched.id, databases: [{ artifact: 'db-alice_wp.sql', target: 'bob wp' }], certificates: [] })).rejects.toThrow(/database mapping/)
  })
  it('keeps a second task queued until the first task finishes', async () => {
    let enterFirstHome!: () => void, releaseFirstHome!: () => void
    const firstHomeEntered = new Promise<void>(resolve => { enterFirstHome = resolve })
    const firstHomeReleased = new Promise<void>(resolve => { releaseFirstHome = resolve })
    const commands: TransferCommand[] = []
    const t = await setup({ run: async command => {
      commands.push(command)
      if (command.argv[0] === '/usr/bin/tar') {
        if (commands.length === 1) { enterFirstHome(); await firstHomeReleased }
        await writeFile(command.stdoutFile!, 'HOME-ARCHIVE')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (command.argv[0] === '/usr/bin/mariadb-dump') return { code: 2, stdout: '', stderr: 'synthetic failure' }
      throw new Error('unexpected package command')
    } })
    const first = await t.controller.start({ kind: 'package', username: 'alice' })
    await firstHomeEntered
    let second: TransferTask | undefined
    let settledSecond!: TransferTask
    try {
      second = await t.controller.start({ kind: 'package', username: 'alice' })
      expect([first.state, second.state]).toEqual(['queued', 'queued'])
      expect(await t.controller.get(first.id)).toMatchObject({ state: 'running' })
      expect(await t.controller.get(second.id)).toMatchObject({ state: 'queued' })
      expect(commands).toHaveLength(1)
      expect(commands[0]!.stdoutFile).toContain(first.id)
    } finally {
      releaseFirstHome()
      settledSecond = await t.settled(second ?? first)
    }
    expect(await t.controller.get(first.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/dump of alice_wp failed: synthetic failure/) })
    expect(settledSecond).toMatchObject({ state: 'failed', error: expect.stringMatching(/dump of alice_wp failed: synthetic failure/) })
    expect(commands.map(command => command.argv[0])).toEqual(['/usr/bin/tar', '/usr/bin/mariadb-dump', '/usr/bin/tar', '/usr/bin/mariadb-dump'])
    expect(commands[2]!.stdoutFile).toContain(second!.id)
  })
  it('recovers saved running and queued tasks as interrupted without changing completed tasks', async () => {
    const createdAt = '2026-10-29T00:00:00.000Z', restartedAt = '2026-10-29T01:00:00.000Z'
    const completed: TransferTask = { id: randomUUID(), kind: 'package', username: 'alice', state: 'succeeded', createdAt, updatedAt: createdAt, owner: randomUUID(), result: { artifacts: [] }, error: null }
    const running: TransferTask = { ...completed, id: randomUUID(), state: 'running', result: null }
    const queued: TransferTask = { ...running, id: randomUUID(), state: 'queued' }
    const t = await setup({ now: () => new Date(restartedAt) }, [running, queued, completed])
    const interrupted = { state: 'interrupted', error: 'the agent restarted during this task; nothing more ran', updatedAt: restartedAt }
    expect(await t.controller.get(running.id)).toEqual({ ...running, ...interrupted })
    expect(await t.controller.get(queued.id)).toEqual({ ...queued, ...interrupted })
    expect(await t.controller.get(completed.id)).toEqual(completed)
    expect(t.commands).toEqual([])
  })
  it('inspects an uploaded cPanel archive into a review plan without staging references', async () => {
    const t = await setup({ now: () => new Date('2027-01-01T00:00:00Z') })
    const id = randomUUID()
    await mkdir(join(t.deps.stateRoot, 'extended', 'transfers', 'cpanel'), { recursive: true })
    await writeFile(join(t.deps.stateRoot, 'extended', 'transfers', 'cpanel', id + '.tar.gz'), await buildTar(cpmoveEntries(), { gzip: true }))
    const task = await t.settled(await t.controller.start({ kind: 'cpanel-inspect', archive: id }))
    expect(task.state).toBe('succeeded')
    const plan = task.result!.plan as { account: { username: string }; databases: object[]; certificates: object[]; cronJobs: unknown[] }
    expect(plan.account.username).toBe('bob')
    expect(plan.databases.every(db => !('sql' in db))).toBe(true)
    expect(JSON.stringify(plan)).not.toContain('PRIVATE KEY')
    expect(plan.cronJobs).toEqual([{ schedule: '* * * * *', command: '/home/bob/x.sh' }])
    await expect(t.controller.start({ kind: 'cpanel-inspect', archive: randomUUID() })).rejects.toThrow(/not on this server/)
  })
  it('restores a cPanel home through the staged tree and loads each dump into its reviewed name', async () => {
    const t = await setup({ now: () => new Date('2027-01-01T00:00:00Z') })
    const id = randomUUID(), bytes = await buildTar(cpmoveEntries(), { gzip: true })
    await mkdir(join(t.deps.stateRoot, 'extended', 'transfers', 'cpanel'), { recursive: true })
    await writeFile(join(t.deps.stateRoot, 'extended', 'transfers', 'cpanel', id + '.tar.gz'), bytes)
    const task = await t.settled(await t.controller.start({ kind: 'cpanel-restore', username: 'bob', archive: id, sha256: sha(bytes), databases: [{ sourceName: 'bob_wp', target: 'bob_wp' }], certificates: [] }))
    expect(task).toMatchObject({ state: 'succeeded', result: { home: { compared: true }, databases: [{ name: 'bob_wp', tables: 2 }] } })
    expect(t.commands.find(command => command.argv.includes('--database=bob_wp'))?.stdinFile).toMatch(/sql[\\/]bob_wp/)
    expect(t.commands.find(command => command.argv.includes('--extract'))).toMatchObject({ asUser: 'bob' })
    const changed = await t.settled(await t.controller.start({ kind: 'cpanel-restore', username: 'bob', archive: id, sha256: sha('other'), databases: [], certificates: [] }))
    expect(changed).toMatchObject({ state: 'failed', error: expect.stringMatching(/changed since it was reviewed/) })
  })
  it('stages archive content only inside its own tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xp-stage-')); cleanup.push(dir)
    const sink = new StagingSink(dir)
    const body = (async function* () { yield Buffer.from('x') })()
    await expect(sink.put({ part: 'home', path: '../escape', type: 'file', mode: 0o644, size: 1, mtime: null, linkTarget: null }, body)).rejects.toThrow(/unsafe/)
    expect(await sink.put({ part: 'home', path: 'public_html/a.txt', type: 'file', mode: 0o644, size: 1, mtime: null, linkTarget: null }, (async function* () { yield Buffer.from('A') })())).toMatch(/home[\\/]public_html[\\/]a\.txt$/)
    expect(await readFile(join(dir, 'home', 'public_html', 'a.txt'), 'utf8')).toBe('A')
  })
  it('serves the host routes to root only, streams packaged artifacts and accepts no selectors', async () => {
    const t = await setup()
    let root = true
    const call = (path: string, method = 'GET', body?: unknown) => { const url = new URL('http://agent.local' + path); return handleTransferTaskRoute(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), url, method, { authorize: async () => { if (!root) fail('FORBIDDEN', 'root required') }, controller: t.controller }) }
    const started = await call('/transfers/tasks', 'POST', { kind: 'package', username: 'alice' })
    expect(started!.status).toBe(202)
    const task = await t.settled(((await started!.json()) as { task: TransferTask }).task)
    const artifact = await call('/transfers/packages/' + task.id + '/home.tar.gz')
    expect(artifact!.status).toBe(200)
    expect(Object.fromEntries(artifact!.headers)).toMatchObject({ 'content-type': 'application/octet-stream', 'content-length': '12', 'content-disposition': 'attachment; filename="home.tar.gz"' })
    expect(await artifact!.text()).toBe('HOME-ARCHIVE')
    await expect(call('/transfers/tasks/' + task.id + '?x=1')).rejects.toThrow(/no selectors/)
    expect((await call('/transfers/tasks', 'GET'))!.status).toBe(405)
    root = false
    await expect(call('/transfers/tasks/' + task.id)).rejects.toThrow(/root required/)
    expect(await call('/host/other')).toBeNull()
  })
})
