import { createStrictTestDb } from './strict-test-db.ts'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { link, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from './client.ts'
import { assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, closeSqliteRunner, getStrictDatabaseIdentity, getStrictOperationDatabaseOrigin, sqliteRunner } from './sql-runner.ts'

const handles: DbHandle[] = []
afterEach(async () => { for (const h of handles.splice(0).reverse()) await h.close() })
const fresh = async () => { const h = await createStrictTestDb(); handles.push(h); return h }
const filename = async (h: DbHandle) => (await h.db.query<{ name: string; file: string }>('PRAGMA database_list')).find(row => row.name === 'main')!.file
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('physical SQLite admission, async scope and connection lifetime', () => {
  it('accepts only the exact registered public runner, freezes its methods and rejects transaction runners and closed providers', async () => {
    const h = await fresh()
    expect(() => assertRegisteredDatabaseRunner(h.db)).not.toThrow()
    let invoked = false
    const fake = { transaction() { invoked = true; return Promise.resolve({ file: 'copied' }) } }
    for (const provider of [fake, { ...h.db }, new Proxy(h.db, {}), { transaction: h.db.transaction, query: h.db.query, exec: h.db.exec }]) {
      expect(() => assertRegisteredDatabaseRunner(provider)).toThrow('a registered public database runner is required')
    }
    expect(invoked).toBe(false)
    expect(Object.isFrozen(h.db)).toBe(true)
    expect(() => Object.defineProperty(h.db, 'transaction', { value: fake.transaction })).toThrow()
    await h.db.transaction(async tx => {
      expect(() => assertRegisteredDatabaseRunner(tx)).toThrow('a registered public database runner is required')
      expect(Object.isFrozen(tx)).toBe(true)
      expect(() => Object.defineProperty(tx, 'query', { value: h.db.query })).toThrow()
      expect(await tx.query('SELECT 1 AS n')).toEqual([{ n: 1 }])
    })
    await h.close()
    expect(() => assertRegisteredDatabaseRunner(h.db)).toThrow('database connection is closing or closed')
  })

  it('promptly rejects opposite public queries inside two independent strict operation transactions and leaves both queues usable', async () => {
    const source = `import{DatabaseSync}from'node:sqlite';import{sqliteRunner,closeSqliteRunner}from ${JSON.stringify(new URL('./sql-runner.ts', import.meta.url).href)};
      const {mkdtemp,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const directory=await mkdtemp(join(tmpdir(),'xpanel-strict-cross-'));const{createDb}=await import(${JSON.stringify(new URL('./client.ts', import.meta.url).href)});const keepAlive=setInterval(()=>{},1000);const ah=createDb(join(directory,'a.sqlite'),{durability:'strict'}),bh=createDb(join(directory,'b.sqlite'),{durability:'strict'}),a=ah.db,b=bh.db;
      let entered=0,release;const both=new Promise(r=>release=r);const results=[];
      const run=(own,opposite,name,rollback)=>own.transaction(async tx=>{await tx.query('SELECT 1');if(++entered===2){console.log('BOTH_ENTERED');release()}await both;
      try{await opposite.query('SELECT 2');results.push(name+':accepted')}catch(e){results.push(name+':'+e.message)}if(rollback)throw new Error('owned rollback')});
      const outcomes=await Promise.allSettled([run(a,b,'a',false),run(b,a,'b',true)]);
      const rows=await Promise.all([a.query('SELECT 3 AS n'),b.query('SELECT 4 AS n')]);await ah.close();await bh.close();await rm(directory,{recursive:true,force:true});clearInterval(keepAlive);
      console.log(JSON.stringify({results:results.sort(),outcomes:outcomes.map(x=>x.status),rows}));`
    const result = await new Promise<{ out: string; err: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } })
      let out = ''; let err = ''; let timedOut = false
      let timer = setTimeout(() => { timedOut = true; child.kill() }, 10_000)
      child.stdout.on('data', chunk => {
        out += chunk
        if (out.includes('BOTH_ENTERED')) { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; child.kill() }, 2500) }
      })
      child.stderr.on('data', chunk => { err += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ out, err, code, timedOut }) })
    })
    expect(result.timedOut, result.err + result.out).toBe(false)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('BOTH_ENTERED')
    expect(JSON.parse(result.out.trim().split('\n').at(-1)!)).toEqual({
      results: ['a:use the provided transaction runner inside a transaction', 'b:use the provided transaction runner inside a transaction'],
      outcomes: ['fulfilled', 'rejected'], rows: [[{ n: 3 }], [{ n: 4 }]],
    })
  })

  it('rejects raw forged drivers, including objects with the native prototype, despite believable PRAGMAs', async () => {
    const h = await fresh()
    const origin = await h.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    const fakePrepare = (sql: string) => ({
      all: () => [{ name: 'main', file: origin.file }],
      get: () => sql.includes('journal_mode') ? { journal_mode: 'wal' } : sql.includes('synchronous') ? { synchronous: 2 } : sql.includes('foreign_keys') ? { foreign_keys: 1 } : { issuer_id: origin.issuerId, schema_version: 2 },
      columns: () => [], run: () => ({}),
    })
    for (const prototype of [Object.prototype, DatabaseSync.prototype]) {
      const fake = Object.assign(Object.create(prototype), { prepare: fakePrepare, exec() {}, close() {} }) as DatabaseSync
      expect(() => sqliteRunner(fake, { strictDurability: true })).toThrow()
    }
    const memory = new DatabaseSync(':memory:')
    try {
      Object.defineProperty(memory, 'prepare', { value: fakePrepare, configurable: true })
      expect(() => sqliteRunner(memory, { strictDurability: true })).toThrow()
    } finally { memory.close() }
  })

  it('uses genuine transaction methods even when a real connection has an overridden exec', async () => {
    const h = await fresh()
    Object.defineProperty(h.sqlite, 'exec', { value() {}, configurable: true })
    await expect(h.db.transaction(async tx => {
      await tx.query("INSERT INTO jobs(id,kind,actor) VALUES('22222222-2222-4222-8222-222222222222','backup.create','root')")
      throw new Error('actual rollback required')
    })).rejects.toThrow('actual rollback required')
    expect((await h.db.query<{ n: number }>('SELECT count(*) AS n FROM jobs'))[0]?.n).toBe(0)
  })

  it('reuses one runner per actual connection, including memory, and refuses a policy relabel', async () => {
    const sqlite = new DatabaseSync(':memory:')
    const first = sqliteRunner(sqlite)
    expect(sqliteRunner(sqlite)).toBe(first)
    expect(() => sqliteRunner(sqlite, { strictDurability: true })).toThrow(/different registered/)
    await closeSqliteRunner(first)
    await closeSqliteRunner(first)
    await expect(first.query('SELECT 1')).rejects.toThrow(/closing or closed/)
  })

  it('rejects same-file descendant queries, scripts, transactions and close without deadlocking', async () => {
    const h = await fresh(); const other = createDb(await filename(h), { durability: 'strict' }); handles.push(other)
    let leaked: typeof h.db | undefined
    await h.db.transaction(async tx => {
      leaked = tx
      await tx.query('SELECT 1')
      await expect(h.db.query('SELECT 1')).rejects.toThrow(/provided transaction runner/)
      await expect(other.db.query('SELECT 1')).rejects.toThrow(/provided transaction runner/)
      await expect(other.db.exec('SELECT 1;')).rejects.toThrow(/provided transaction runner/)
      await expect(other.db.transaction(async () => undefined)).rejects.toThrow(/nested/)
      await expect(other.close()).rejects.toThrow(/active database transaction/)
      expect(() => assertNoActiveDatabaseTransaction()).toThrow(/outer database transaction/)
    })
    await expect(leaked!.query('SELECT 1')).rejects.toThrow(/not active/)
    expect(() => getStrictDatabaseIdentity(leaked!)).toThrow(/not active/)
    expect(await other.db.query('SELECT 1 AS n')).toEqual([{ n: 1 }])
  })

  it('queues independent calls but refuses synchronous connection setup during admitted work', async () => {
    const h = await fresh(); const file = await filename(h)
    const other = createDb(file, { durability: 'strict' }); handles.push(other)
    const entered = deferred(); const release = deferred()
    const writer = h.db.transaction(async tx => { await tx.query("INSERT INTO jobs(id,kind,actor) VALUES('11111111-1111-4111-8111-111111111111','backup.create','root')"); entered.resolve(); await release.promise })
    await entered.promise
    let readCompleted = false
    const reader = other.db.query<{ n: number }>('SELECT count(*) AS n FROM jobs').then(rows => { readCompleted = true; return rows })
    expect(readCompleted).toBe(false)
    expect(() => createDb(file, { durability: 'strict' })).toThrow(/setup must wait/)
    release.resolve()
    await writer
    expect((await reader)[0]?.n).toBe(1)
  })

  it('drains admitted work before close, rejects new work, and reopens without a leaked scheduler', async () => {
    const h = await fresh(); const file = await filename(h)
    const entered = deferred(); const release = deferred()
    const writer = h.db.transaction(async tx => { await tx.query('SELECT 1'); entered.resolve(); await release.promise })
    await entered.promise
    const close = h.close()
    await expect(h.db.query('SELECT 1')).rejects.toThrow(/closing or closed/)
    release.resolve()
    await writer
    await close
    await closeSqliteRunner(h.runner)
    // createTestDb owns and removes its directory on close; a normal independent handle has its own lifetime below.
    const freshHandle = await fresh(); const liveFile = await filename(freshHandle)
    const extra = createDb(liveFile, { durability: 'strict' }); handles.push(extra)
    const origin = await extra.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    await extra.close()
    const reopened = createDb(liveFile, { durability: 'strict' }); handles.push(reopened)
    expect(await reopened.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))).toEqual(origin)
  })

  it('distinguishes an SQLite-created database copy even when its persisted issuer was copied', async () => {
    const h = await fresh(); const file = await filename(h); const copy = join(dirname(file), 'copy.sqlite')
    const original = await h.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    await h.db.query('VACUUM INTO $1', [copy])
    const other = createDb(copy, { durability: 'strict' }); handles.push(other)
    const copied = await other.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    expect(copied.issuerId).toBe(original.issuerId)
    expect(copied.file).not.toBe(original.file)
    expect(`${copied.device}:${copied.inode}`).not.toBe(`${original.device}:${original.inode}`)
  })

  it('rejects hardlinked database aliases rather than using different WAL sidecars', async () => {
    const h = await fresh(); const file = await filename(h); const alias = join(dirname(file), 'hardlink.sqlite')
    await link(file, alias)
    expect(() => createDb(alias, { durability: 'strict' })).toThrow(/exactly one hard link/)
    await expect(h.db.transaction(async tx => tx.query('SELECT 1'))).rejects.toThrow(/exactly one hard link/)
  })

  it.runIf(process.platform !== 'win32')('canonicalizes a symlink alias before opening SQLite and shares its admission gate', async () => {
    const h = await fresh(); const file = await filename(h); const alias = join(dirname(file), 'symlink.sqlite')
    await symlink(file, alias)
    const other = createDb(alias, { durability: 'strict' }); handles.push(other)
    expect(await other.db.transaction(async tx => getStrictDatabaseIdentity(tx))).toEqual(await h.db.transaction(async tx => getStrictDatabaseIdentity(tx)))
    await h.db.transaction(async () => { await expect(other.db.query('SELECT 1')).rejects.toThrow(/provided transaction runner/) })
  })
})
