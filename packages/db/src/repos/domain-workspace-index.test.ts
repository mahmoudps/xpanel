import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account, Domain, DomainWorkspaceTransition } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { prepareDomainIndexTransition } from './domain-workspace-index.ts'
import { syncAccountContactIndex } from './reindex.ts'

const handles: TestDbHandle[] = []
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })
const accountFixture = (name: string, uid: number): Account => ({
  id: randomUUID(), username: name, uid, gid: uid, home: '/home/' + name, primaryDomain: name + '.example.test',
  planId: randomUUID(), ownerId: randomUUID(), status: 'active', suspendReason: null, suspendedAt: null,
  contactEmail: name + '@example.test', ipv4: '192.0.2.' + (uid - 20000), shell: 'none', createdAt: '2020-01-01T00:00:00.000Z',
} as Account)
const domainFixture = (account: Account, name: string): Domain => ({
  id: randomUUID(), accountId: account.id, name, kind: 'addon', parentId: null, docRoot: account.home + '/' + name,
  siteType: 'proxy', upstream: 'http://127.0.0.1:3000', redirect: { to: 'https://redirect.example.test/path', code: 302 },
  php: { version: '8.3', handler: 'fpm', ini: {} }, wildcard: true, certificateId: randomUUID(), suspended: true,
  expiresAt: '2030-01-01T00:00:00.000Z', pathQuotaMb: 'unlimited',
} as Domain)
const fresh = async () => {
  const database = await createTestDb(); handles.push(database)
  const account = accountFixture('domainowner', 20041), neighbor = accountFixture('domainneighbor', 20042)
  const target = domainFixture(account, 'owned.example.test'), other = domainFixture(neighbor, 'neighbor.example.test')
  await syncAccountContactIndex(database.db, neighbor)
  await seedDomain(database, other, '10')
  await seedSearch(database, other, '10')
  return { database, account, neighbor, target, other }
}
const seedDomain = (h: TestDbHandle, d: Domain, rowid = '100') => h.db.query(
  `INSERT INTO idx_domains (rowid,id,account_id,name,kind,parent_id,doc_root,site_type,upstream,redirect_to,redirect_code,
   php_version,php_handler,wildcard,certificate_id,suspended,expires_at,path_quota_mb,created_at,updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
  [rowid,d.id,d.accountId,d.name,d.kind,d.parentId,d.docRoot,d.siteType,d.upstream,d.redirect?.to ?? null,d.redirect?.code ?? null,
    d.php.version,d.php.handler,d.wildcard ? 1 : 0,d.certificateId,d.suspended ? 1 : 0,d.expiresAt,
    d.pathQuotaMb === 'unlimited' ? null : d.pathQuotaMb,'2018-01-02T03:04:05.000Z','2019-01-02T03:04:05.000Z'],
)
const seedSearch = (h: TestDbHandle, d: Domain, rowid: string, kind = 'domain', accountId = d.accountId) => h.db.query(
  'INSERT INTO search_fts (rowid,kind,entity_id,account_id,owner_id,title,subtitle,keywords) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
  [rowid,kind,d.id,accountId,'legacy-owner',d.name,'Legacy subtitle','Legacy exact search terms'],
)
const snapshot = async (h: TestDbHandle) => ({
  accounts: await h.db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM idx_accounts ORDER BY id'),
  domains: await h.db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM idx_domains ORDER BY id'),
  search: await h.db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM search_fts ORDER BY rowid'),
})
const transition = (account: Account, before: Domain[], after: Domain[]): DomainWorkspaceTransition => ({
  account, before, after, affectedIds: [...new Set([...before,...after].map(domain => domain.id))],
})

describe('conditional domain workspace index transition', () => {
  it('prepares read-only and makes rollback before apply a no-op', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target); await seedSearch(f.database,f.target,'100')
    const before = await snapshot(f.database)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{ ...f.target,docRoot:f.account.home+'/new-root' }]))
    expect(await snapshot(f.database)).toEqual(before)
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('projects all current domain fields and search text without creating a missing account index', async () => {
    const f = await fresh(), before = await snapshot(f.database)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[],[f.target])); await handle.apply()
    const rows = await f.database.db.query('SELECT * FROM idx_domains WHERE id=$1',[f.target.id])
    expect(rows).toEqual([{
      id:f.target.id,account_id:f.account.id,name:f.target.name,kind:'addon',parent_id:null,doc_root:f.target.docRoot,site_type:'proxy',
      upstream:f.target.upstream,redirect_to:f.target.redirect!.to,redirect_code:302,php_version:'8.3',php_handler:'fpm',wildcard:1,
      certificate_id:f.target.certificateId,suspended:1,expires_at:f.target.expiresAt,path_quota_mb:null,created_at:f.account.createdAt,
      updated_at:expect.any(String),
    }])
    expect(await f.database.db.query("SELECT kind,entity_id,account_id,owner_id,title,subtitle,keywords FROM search_fts WHERE kind='domain' AND entity_id=$1",[f.target.id])).toEqual([{
      kind:'domain',entity_id:f.target.id,account_id:f.account.id,owner_id:f.account.ownerId,title:f.target.name,
      subtitle:'domainowner (addon)',keywords:f.target.docRoot+' proxy php8.3',
    }])
    expect((await snapshot(f.database)).accounts).toEqual(before.accounts)
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('never refreshes existing account rows or account search entries', async () => {
    const f = await fresh(); await syncAccountContactIndex(f.database.db,f.account)
    await f.database.db.query('UPDATE idx_accounts SET contact_email=$1,updated_at=$2 WHERE id=$3',['cached@example.test','2017-01-01T00:00:00.000Z',f.account.id])
    const before = await snapshot(f.database)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[],[f.target])); await handle.apply()
    const current = await snapshot(f.database)
    expect(current.accounts).toEqual(before.accounts)
    expect(current.search.filter(row=>row.kind==='account')).toEqual(before.search.filter(row=>row.kind==='account'))
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('updates parent and alias projections then restores every field, duplicate search entry and original timestamp', async () => {
    const f = await fresh(), alias = { ...domainFixture(f.account,'alias.example.test'),kind:'alias' as const,parentId:f.target.id,docRoot:f.target.docRoot }
    await seedDomain(f.database,f.target); await seedDomain(f.database,alias,'101')
    await seedSearch(f.database,f.target,'100'); await seedSearch(f.database,f.target,'101'); await seedSearch(f.database,alias,'102')
    await f.database.db.query('UPDATE search_fts SET owner_id=NULL,title=NULL,subtitle=$1,keywords=$2 WHERE rowid=$3',['Quoted "legacy" subtitle','old\\search terms','101'])
    await seedSearch(f.database,f.target,'103','account')
    const before = await snapshot(f.database), root = f.account.home+'/changed-root'
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target,alias],[{...f.target,docRoot:root,pathQuotaMb:0},{...alias,docRoot:root}]))
    await handle.apply()
    expect(await f.database.db.query('SELECT doc_root FROM idx_domains WHERE account_id=$1',[f.account.id])).toEqual([{doc_root:root},{doc_root:root}])
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('deletes only affected domain rows and domain-kind search records then restores them exactly', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target); await seedSearch(f.database,f.target,'100'); await seedSearch(f.database,f.target,'101','account')
    const before = await snapshot(f.database), handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[]))
    await handle.apply()
    const current = await snapshot(f.database)
    expect(current.domains.map(row=>row.id)).toEqual([f.other.id])
    expect(current.search.some(row=>row.kind==='domain' && row.entity_id===f.target.id)).toBe(false)
    expect(current.search.some(row=>row.kind==='account' && row.entity_id===f.target.id)).toBe(true)
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('restores absent target index state even when authoritative before records existed', async () => {
    const f = await fresh(), before = await snapshot(f.database)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{...f.target,docRoot:f.account.home+'/new'}]))
    await handle.apply(); await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('preserves exact 64-bit rowids for both domain and search preimages', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target,'9007199254740993'); await seedSearch(f.database,f.target,'9007199254740995')
    const before = await snapshot(f.database)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{...f.target,docRoot:f.account.home+'/new'}]))
    await handle.apply(); await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it('refuses an unrelated indexed name collision during read-only preparation', async () => {
    const f = await fresh(), before = await snapshot(f.database)
    await expect(prepareDomainIndexTransition(f.database.db,transition(f.account,[],[{...f.target,name:f.other.name.toUpperCase()}]))).rejects.toMatchObject({code:'CONFLICT'})
    expect(await snapshot(f.database)).toEqual(before)
  })

  it.each(['domain','search'] as const)('refuses foreign %s preimages without changing them', async kind => {
    const f = await fresh()
    if(kind==='domain') await seedDomain(f.database,{...f.target,accountId:f.neighbor.id})
    else await seedSearch(f.database,f.target,'100','domain',f.neighbor.id)
    const before = await snapshot(f.database)
    await expect(prepareDomainIndexTransition(f.database.db,transition(f.account,[],[f.target]))).rejects.toMatchObject({code:'FORBIDDEN'})
    expect(await snapshot(f.database)).toEqual(before)
  })

  it.each(['duplicate-id','missing-id','foreign-before','foreign-after'] as const)('refuses inconsistent transition scope %s without writes', async kind => {
    const f = await fresh(), input = transition(f.account,[f.target],[f.target])
    if(kind==='duplicate-id') input.affectedIds=[f.target.id,f.target.id]
    if(kind==='missing-id') input.affectedIds=[]
    if(kind==='foreign-before') input.before=[{...f.target,accountId:f.neighbor.id}]
    if(kind==='foreign-after') input.after=[{...f.target,accountId:f.neighbor.id}]
    const before = await snapshot(f.database)
    await expect(prepareDomainIndexTransition(f.database.db,input)).rejects.toThrow()
    expect(await snapshot(f.database)).toEqual(before)
  })

  it('pins accepted scalar records and affected IDs against later caller mutation', async () => {
    const f = await fresh(), input = transition(f.account,[],[f.target]), expected = f.target.docRoot
    const handle = await prepareDomainIndexTransition(f.database.db,input)
    f.target.docRoot='/unreviewed-root'; f.target.accountId=f.neighbor.id
    ;(input.affectedIds as string[]).push(f.other.id)
    await handle.apply()
    expect(await f.database.db.query('SELECT account_id,doc_root FROM idx_domains WHERE id=$1',[f.target.id])).toEqual([{account_id:f.account.id,doc_root:expected}])
    expect(await f.database.db.query('SELECT id FROM idx_domains WHERE id=$1',[f.other.id])).toHaveLength(1)
  })

  it('refuses applying over an index changed after preparation', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{...f.target,docRoot:f.account.home+'/next'}]))
    await f.database.db.query('UPDATE idx_domains SET doc_root=$1 WHERE id=$2',[f.account.home+'/intervening',f.target.id])
    const before = await snapshot(f.database)
    await expect(handle.apply()).rejects.toMatchObject({code:'CONFLICT'}); expect(await snapshot(f.database)).toEqual(before)
  })

  it('refuses stale rollback rather than overwriting an intervening target update', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target)
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{...f.target,docRoot:f.account.home+'/next'}])); await handle.apply()
    await f.database.db.query('UPDATE idx_domains SET doc_root=$1 WHERE id=$2',[f.account.home+'/intervening',f.target.id])
    const before = await snapshot(f.database)
    await expect(handle.rollback()).rejects.toMatchObject({code:'CONFLICT'}); expect(await snapshot(f.database)).toEqual(before)
  })

  it('rolls back an actual SQLite apply failure after deleting search entries', async () => {
    const f = await fresh(); await seedDomain(f.database,f.target); await seedSearch(f.database,f.target,'100')
    await f.database.db.exec("CREATE TRIGGER reject_domain_projection BEFORE UPDATE ON idx_domains BEGIN SELECT RAISE(ABORT,'Synthetic domain projection refusal'); END")
    const before = await snapshot(f.database), handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[{...f.target,docRoot:f.account.home+'/next'}]))
    await expect(handle.apply()).rejects.toThrow(); expect(await snapshot(f.database)).toEqual(before)
    await handle.rollback(); expect(await snapshot(f.database)).toEqual(before)
  })

  it.each(['domain-rowid','search-rowid','domain-name'] as const)('preserves a new neighbor when restoring collides on %s', async collision => {
    const f = await fresh(); await seedDomain(f.database,f.target); await seedSearch(f.database,f.target,'100')
    const handle = await prepareDomainIndexTransition(f.database.db,transition(f.account,[f.target],[])); await handle.apply()
    const newcomer = domainFixture(f.neighbor,collision==='domain-name' ? f.target.name : 'new-neighbor.example.test')
    if(collision==='search-rowid') await seedSearch(f.database,newcomer,'100')
    else await seedDomain(f.database,newcomer,collision==='domain-rowid' ? '100' : '200')
    const before = await snapshot(f.database)
    await expect(handle.rollback()).rejects.toThrow(); expect(await snapshot(f.database)).toEqual(before)
  })
})
