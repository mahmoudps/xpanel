import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StateStore, WriterLock, type StoredAccount } from '@xpanel/state'
import { createDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import { createRootPrincipal } from './principals.ts'
import { syncAccountContactIndex } from './reindex.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const account: StoredAccount = {
  id: '8ed693da-74d1-4f27-9903-e252cd1d2094', username: 'contactowner', uid: 20001, gid: 20001,
  home: '/home/contactowner', primaryDomain: 'contactowner.example.test', planId: '166f276c-4d07-4a76-ae62-327c9f6c0c39',
  ownerId: null, status: 'active', suspendReason: null, suspendedAt: null, contactEmail: 'old@example.test',
  ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z',
}
let base: string
let template: string
const handles: DbHandle[] = []
const directories: string[] = []
const children: (() => Promise<void>)[] = []

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'xpanel-contact-recovery-'))
  template = join(base, 'template.sqlite')
  const prepared = createDb(template)
  try {
    await migrate(prepared.db)
    await createRootPrincipal(prepared.db, { username: 'recoveryroot', passwordHash: HASH })
  } finally { await prepared.close() }
})
afterEach(async () => {
  for (const close of children.splice(0)) await close()
  for (const handle of handles.splice(0)) await handle.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

const fixture = async () => {
  const directory = await mkdtemp(join(base, 'case-'))
  directories.push(directory)
  const dbPath = join(directory, 'index.sqlite')
  await copyFile(template, dbPath)
  const database = createDb(dbPath)
  handles.push(database)
  const root = join(directory, 'state'), accountDir = join(root, 'accounts', account.username)
  await mkdir(accountDir, { recursive: true })
  const accountPath = join(accountDir, 'account.json')
  const raw = ' \n' + JSON.stringify(account, null, 3) + '\r\n'
  await writeFile(accountPath, raw)
  await syncAccountContactIndex(database.db, account)
  const neighbor = { ...account, id: randomUUID(), username: 'neighbor', uid: 20002, gid: 20002, home: '/home/neighbor', primaryDomain: 'neighbor.example.test' }
  await syncAccountContactIndex(database.db, neighbor)
  const sentinel = await database.db.query('SELECT * FROM principals ORDER BY id')
  const neighborBefore = await database.db.query('SELECT * FROM idx_accounts WHERE id=$1', [neighbor.id])
  const store = new StateStore(root)
  store.registerAccountContactIndexRecovery(current => syncAccountContactIndex(database.db, current))
  return { directory, root, dbPath, database, accountPath, raw, store, sentinel, neighbor, neighborBefore }
}

const interruptedUpdate = async (
  f: Awaited<ReturnType<typeof fixture>>,
  phase: 'json' | 'sql' | 'committed' | 'committed-marker',
  readProbe?: { blocked: () => void; proceed: Promise<void> },
) => {
  const stateUrl = pathToFileURL(resolve('packages/state/src/index.ts')).href
  const dbUrl = pathToFileURL(resolve('packages/db/src/index.ts')).href
  const coreUrl = pathToFileURL(resolve('packages/core/src/index.ts')).href
  const script = `
    import { StateStore, WriterLock } from ${JSON.stringify(stateUrl)};
    import { createDb, prepareAccountContactIndexRollback, syncAccountContactIndex } from ${JSON.stringify(dbUrl)};
    import { accountContactRevision } from ${JSON.stringify(coreUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    const phase=${JSON.stringify(phase)}, db=createDb(${JSON.stringify(f.dbPath)}), store=new StateStore(${JSON.stringify(f.root)});
    const account=await store.getAccount(${JSON.stringify(account.id)});
    const pause=async()=>{ process.send({ready:true}); await new Promise(()=>{ globalThis.__hold=setInterval(()=>{},1000); }); };
    if(${Boolean(readProbe)}) {
      try {
        const admitted=await new WriterLock(store.rootDir,{acquireTimeoutMs:40,retryIntervalMs:5}).acquire();
        await admitted.release();
        throw new Error('writer unexpectedly entered a protected projection read');
      } catch(error) {
        if(error.code!=='CONFLICT') throw error;
        process.send({blocked:true});
      }
      await new Promise(done=>process.once('message',done));
    }
    await store.updateAccountContactEmail(account.id,'new@example.test',{
      expectedContactRevision:accountContactRevision(account), authorize:async()=>{},
      prepareIndex:current=>prepareAccountContactIndexRollback(db.db,current.id),
      synchronizeIndex:async current=>{
        if(phase==='json') await pause();
        await syncAccountContactIndex(db.db,current);
        if(phase==='sql') await pause();
        if(phase==='committed-marker') {
          const authority=JSON.parse(await readFile(store.writerLock.authorityFilePath,'utf8'));
          const owner=JSON.parse(await readFile(store.writerLock.ownerFilePath,'utf8'));
          await writeFile(store.writerLock.authorityFilePath,JSON.stringify({...authority,revision:authority.revision+1,committedLeaseId:owner.leaseId}));
          await pause();
        }
      }
    });
    await pause();`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostics = ''
  child.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  const exited = new Promise<void>(done => child.once('close', () => done()))
  const close = async () => { if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited }
  children.push(close)
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('contact writer fixture timed out: ' + diagnostics)) }, 5000)
    child.on('message', value => {
      if (value && typeof value === 'object' && 'blocked' in value) {
        readProbe!.blocked()
        void readProbe!.proceed.then(() => { if (child.connected) child.send({ proceed: true }) })
      } else { clearTimeout(timeout); done() }
    })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('contact writer exited before interruption: ' + diagnostics)) })
  })
  await close()
}

const expectPreserved = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(await f.database.db.query('SELECT * FROM principals ORDER BY id')).toEqual(f.sentinel)
  expect(await f.database.db.query('SELECT * FROM idx_accounts WHERE id=$1', [f.neighbor.id])).toEqual(f.neighborBefore)
}

describe('contact projection crash recovery with real process interruption', () => {
  it.each(['json', 'sql'] as const)('repairs the canonical projection after interruption at %s and retains mutex identity', async phase => {
    const f = await fixture()
    await interruptedUpdate(f, phase)
    const before = await lstat(f.store.writerLock.mutexFilePath, { bigint: true })
    await f.store.writerLock.waitForUnlocked()
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
    expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: account.contactEmail }])
    expect(await f.database.db.query("SELECT keywords FROM search_fts WHERE kind='account' AND entity_id=$1", [account.id])).toEqual([{ keywords: `${account.contactEmail} ${account.ipv4} uid:${account.uid} ${account.status}` }])
    const after = await lstat(f.store.writerLock.mutexFilePath, { bigint: true })
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    await expect(readFile(f.store.writerLock.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const authority = await readFile(f.store.writerLock.authorityFilePath)
    await f.store.writerLock.waitForUnlocked()
    expect(await readFile(f.store.writerLock.authorityFilePath)).toEqual(authority)
    await expectPreserved(f)
  })

  it('keeps a committed update when the writer is killed after authority commit', async () => {
    const f = await fixture()
    await interruptedUpdate(f, 'committed')
    await f.store.writerLock.waitForUnlocked()
    expect((await f.store.getAccount(account.id))?.contactEmail).toBe('new@example.test')
    expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: 'new@example.test' }])
    await expectPreserved(f)
  })

  it('fails closed without the repair port and retains evidence when the repair itself fails', async () => {
    const f = await fixture()
    await interruptedUpdate(f, 'sql')
    const intent = await readFile(f.store.writerLock.intentFilePath)
    const interrupted = await readFile(f.accountPath)
    await expect(new StateStore(f.root).writerLock.waitForUnlocked()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await readFile(f.accountPath)).toEqual(interrupted)
    expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    f.store.registerAccountContactIndexRecovery(async () => { throw new Error('index unavailable') })
    await expect(f.store.writerLock.waitForUnlocked()).rejects.toThrow('index unavailable')
    expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    f.store.registerAccountContactIndexRecovery(current => syncAccountContactIndex(f.database.db, current))
    await f.store.writerLock.waitForUnlocked()
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
    expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: account.contactEmail }])
    await expectPreserved(f)
  })

  it('repairs a committed orphan marker without replaying its old account preimage', async () => {
    const f = await fixture()
    // The child models authority publication before intent cleanup, then is killed
    // while retaining its real OS lease. No normal release can pre-recover it.
    await interruptedUpdate(f, 'committed-marker')
    expect(await readFile(f.store.writerLock.intentFilePath, 'utf8')).toContain('updateAccountContactEmail')
    let repaired = 0
    f.store.registerAccountContactIndexRecovery(async current => { repaired++; await syncAccountContactIndex(f.database.db, current) })
    await f.store.writerLock.waitForUnlocked()
    expect(repaired).toBe(1)
    expect((await f.store.getAccount(account.id))?.contactEmail).toBe('new@example.test')
    expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: 'new@example.test' }])
    await expectPreserved(f)
  })

  it('refuses a different canonical account identity before replaying any preimage', async () => {
    const f = await fixture()
    await interruptedUpdate(f, 'sql')
    const replacement = JSON.stringify({ ...account, id: randomUUID(), contactEmail: 'replacement@example.test' })
    await writeFile(f.accountPath, replacement)
    const intent = await readFile(f.store.writerLock.intentFilePath)
    await expect(f.store.writerLock.waitForUnlocked()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(f.accountPath, 'utf8')).toBe(replacement)
    expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    await expectPreserved(f)
  })

  it('excludes a real competing writer through the SQL read, then repairs its precommit crash before the next read', async () => {
    const f = await fixture()
    let blocked!: () => void, blockFailed!: (error: unknown) => void, proceed!: () => void
    const observedBlock = new Promise<void>((done, reject) => { blocked = done; blockFailed = reject })
    const releaseRead = new Promise<void>(done => { proceed = done })
    let mutation: Promise<void> | undefined
    let observed: { contact_email: unknown }[] | undefined
    try {
      observed = await f.store.withRecoveredAccountProjection(async () => {
        mutation = interruptedUpdate(f, 'sql', { blocked, proceed: releaseRead })
        void mutation.catch(blockFailed)
        await observedBlock
        return f.database.db.query<{ contact_email: unknown }>('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])
      })
    } finally { proceed() }
    expect(observed).toEqual([{ contact_email: account.contactEmail }])
    await mutation!
    // The deliberately interrupted writer really published an uncommitted SQL
    // projection. A bare wait-then-query would be vulnerable to this interval.
    expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: 'new@example.test' }])
    const repaired = await f.store.withRecoveredAccountProjection(() => f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id]))
    expect(repaired).toEqual([{ contact_email: account.contactEmail }])
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
    await expectPreserved(f)
  })

  it('releases a failed projection read, rejects nested guards across stores, and preserves authority on clean reads', async () => {
    const f = await fixture()
    await f.store.writerLock.waitForUnlocked()
    const authority = await readFile(f.store.writerLock.authorityFilePath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    const failure = new Error('projection query failed')
    await expect(f.store.withRecoveredAccountProjection(async () => { throw failure })).rejects.toBe(failure)
    const observed = await f.store.withRecoveredAccountProjection(async () => {
      await expect(new WriterLock(f.root).waitForUnlocked()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(new StateStore(f.root).readSnapshot()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(f.store.readSnapshot()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      return f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])
    })
    expect(observed).toEqual([{ contact_email: account.contactEmail }])
    const after = await readFile(f.store.writerLock.authorityFilePath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    expect(after).toEqual(authority)
    await expectPreserved(f)
  })
})
