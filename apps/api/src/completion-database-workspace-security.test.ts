import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import type { Database, DatabaseUser } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { ARGON2 } from '../../../packages/db/src/testing.ts'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const userPassword = 'SyntheticDbPassword!'
const nativeHash = '*' + 'B'.repeat(40)
const defaultPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const cleanup: Array<() => Promise<unknown>> = []
type AgentMode = 'none' | 'applied' | 'rejected' | 'malformed' | 'transport'
type Operation = 'database' | 'user'
type PublicUser = Pick<DatabaseUser, 'id' | 'name' | 'grants'>

const fixture = async () => {
  const database = await dbApi.createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const feature = await state.store.createFeatureList({ name: 'Database workspace policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Database workspace plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 3, aliasDomains: 3, subdomains: 3, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 3, phpWorkers: 4 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.74', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: ARGON2, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@' + username + '.example.test', ipv4: '192.0.2.74', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('dbworka'), other = await account('dbworkb')
  const ownDb = await state.store.createDatabase({ accountId: owner.id, name: owner.username + '_existing' })
  const trashedDb = await state.store.createDatabase({ accountId: owner.id, name: owner.username + '_trashed' })
  await state.store.trashDatabase(trashedDb.id)
  const foreignDb = await state.store.createDatabase({ accountId: other.id, name: other.username + '_existing' })
  const ownUser = await state.store.createDatabaseUser({ accountId: owner.id, name: owner.username + '_seed', authPlugin: 'mysql_native_password', authString: nativeHash })
  const foreignUser = await state.store.createDatabaseUser({ accountId: other.id, name: other.username + '_seed', authPlugin: 'mysql_native_password', authString: nativeHash })
  const principal = await dbApi.createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: ARGON2 })
  await dbApi.createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: ARGON2 })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = 'xp_' + randomUUID()
    const record = await dbApi.createApiToken(database.db, { principalId, name: 'Synthetic database workspace', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return { raw, id: record.id }
  }
  const credential = await token(['databases:read', 'databases:write'])
  const seedIndex = async () => dbApi.reindexFromState(database.db, await state.store.readSnapshot())
  await seedIndex()
  const calls: Array<{ path: string; method: string; principalId: string | null }> = []
  const makeApp = (mode: AgentMode = 'none') => {
    // Declared synthetic global-configuration transport; no MariaDB server or host
    // executor is contacted, and its receipt cannot verify a target database.
    const agent: AgentApp = { subscribe: () => () => {}, fetch: async req => {
      calls.push({ path: new URL(req.url).pathname, method: req.method, principalId: req.headers.get('x-xpanel-principal-id') })
      if (mode === 'transport') throw new Error('Synthetic database apply transport interruption')
      if (mode === 'rejected') return Response.json({ error: 'FORBIDDEN', message: 'Synthetic agent refusal' }, { status: 403 })
      if (mode === 'malformed') return Response.json({ status: 'applied', generation: { id: 1, checksum: 'invalid' } })
      return Response.json({ status: 'applied', generation: { id: 1, status: 'active', checksum: 'a'.repeat(64) }, filesCount: 2, durationMs: 1 })
    } }
    return createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET,
      ...(mode === 'none' ? {} : { agentApp: agent, agentToken: TEST_AGENT_TOKEN }) })
  }
  const app = makeApp()
  const request = (method = 'GET', body?: unknown, options: { path?: string; token?: string | null; application?: ReturnType<typeof createApiApp> } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return (options.application ?? app).fetch(new Request('http://localhost' + (options.path ?? '/api/databases'), { method,
      headers: { ...(options.token === null ? {} : { authorization: 'Bearer ' + (options.token ?? credential.raw) }), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: payload }) }))
  }
  const tree = async () => {
    const result: Record<string, string> = {}
    const walk = async (path: string, relative = '') => {
      for (const item of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        const key = relative ? relative + '/' + item.name : item.name, full = join(path,item.name)
        if (item.isDirectory()) await walk(full,key)
        else result[key] = createHash('sha256').update(await readFile(full)).digest('hex')
      }
    }
    await walk(join(state.rootDir,'accounts')); return result
  }
  const successAudits = async () => (await dbApi.listAudit(database.db)).filter(row => row.outcome === 'ok' && ['database.created','database_user.created'].includes(row.action))
  const images = async () => ({ tree: await tree(),
    accounts: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,* FROM idx_accounts ORDER BY id'),
    databases: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,* FROM idx_databases ORDER BY id'),
    search: await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,kind,entity_id,account_id,owner_id,title,subtitle,keywords FROM search_fts ORDER BY rowid'),
    successAudits: await successAudits(),
  })
  const revoke = () => database.db.query('UPDATE api_tokens SET revoked_at=$1 WHERE id=$2',[new Date().toISOString(),credential.id])
  return { database,state,feature,plan,owner,other,ownDb,trashedDb,foreignDb,ownUser,foreignUser,principal,token,credential,calls,makeApp,request,images,tree,seedIndex,revoke,successAudits }
}

describe('database workspace API using isolated desired state and real SQLite', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const failures: unknown[] = []
    for (const close of cleanup.splice(0).reverse()) { try { await close() } catch(error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures,'Synthetic database fixture cleanup failed')
  })
  const operation = (kind: Operation, name = 'new') => kind === 'database'
    ? { path: '/api/databases', body: { name: f.owner.username + '_' + name } }
    : { path: '/api/databases/users', body: { name,password:userPassword,databaseId:f.ownDb.id } }
  const unchanged = async (before: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['images']>>) => {
    expect(await f.images()).toEqual(before); expect(f.calls).toEqual([])
  }
  const assertGrant = (user: PublicUser, databaseId: string, privileges = defaultPrivileges) => {
    expect(user.grants).toHaveLength(1)
    expect(user.grants[0]!.databaseId).toBe(databaseId)
    expect([...user.grants[0]!.privileges].sort()).toEqual([...privileges].sort())
  }
  const assertUncertain = async (response: Response) => {
    expect(response.ok).toBe(false)
    expect(await response.json()).toMatchObject({ details: { stateChanged:true,verificationRequired:true,unknownOutcome:true } })
  }

  it('reads only owned databases and users with explicit account context and complete trash metadata', async () => {
    const response = await f.request(), data = await response.json() as { context:{accountId:string};databases:Database[] }
    expect(response.status).toBe(200); expect(data.context).toEqual({accountId:f.owner.id})
    expect(data.databases.map(row=>row.id)).toEqual([f.ownDb.id])
    const complete = await f.request('GET',undefined,{path:'/api/databases?includeTrashed=true'})
    const all = await complete.json() as {context:{accountId:string};databases:Database[]}
    expect(complete.status).toBe(200); expect(all.context).toEqual({accountId:f.owner.id})
    expect(new Set(all.databases.map(row=>row.id))).toEqual(new Set([f.ownDb.id,f.trashedDb.id]))
    expect(all.databases.find(row=>row.id===f.trashedDb.id)!.trashedAt).not.toBeNull()
    const usersResponse = await f.request('GET',undefined,{path:'/api/databases/users'})
    const users = await usersResponse.json() as {context:{accountId:string};users:PublicUser[]}
    expect(usersResponse.status).toBe(200); expect(users.context).toEqual({accountId:f.owner.id})
    expect(users.users).toEqual([{id:f.ownUser.id,name:f.ownUser.name,grants:[]}])
    expect(JSON.stringify({data,all,users})).not.toContain(f.foreignDb.id)
    expect(JSON.stringify(users)).not.toContain(f.foreignUser.id)
    expect(Object.keys(users.users[0]!).sort()).toEqual(['grants','id','name'])
  })

  it('creates a full owned database name with real state/index readback and no native activation claim', async () => {
    const name = f.owner.username+'_created', foreignBefore = await f.state.store.listDatabases(f.other.id,{includeTrashed:true}), before = await f.images()
    const response = await f.request('POST',{name}), data = await response.json() as {database:Database;application:object}
    expect(response.status).toBe(201); expect(data.database).toMatchObject({accountId:f.owner.id,name,engine:'mariadb',trashedAt:null})
    expect(data.application).toEqual({status:'not_requested',targetVerified:false})
    expect(await f.state.store.getDatabase(data.database.id)).toEqual(data.database)
    expect(await f.database.db.query('SELECT id,account_id,name FROM idx_databases WHERE id=$1',[data.database.id])).toEqual([{id:data.database.id,account_id:f.owner.id,name}])
    expect(await f.state.store.listDatabases(f.other.id,{includeTrashed:true})).toEqual(foreignBefore)
    const after = await f.images()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.databases.filter(row=>row.id!==data.database.id)).toEqual(before.databases)
    expect(after.search.filter(row=>!(row.kind==='database' && row.entity_id===data.database.id))).toEqual(before.search)
    expect(f.calls).toEqual([])
    expect(await f.successAudits()).toHaveLength(1)
  })

  it('creates a sanitized standalone user while retaining existing username normalization', async () => {
    const before = await f.images()
    const response = await f.request('POST',{name:'  NeW  ',password:userPassword},{path:'/api/databases/users'})
    const data = await response.json() as {user:PublicUser;application:object}
    expect(response.status).toBe(201); expect(data.user).toEqual({id:expect.any(String),name:f.owner.username+'_new',grants:[]})
    expect(Object.keys(data.user).sort()).toEqual(['grants','id','name'])
    expect(data.application).toEqual({status:'not_requested',targetVerified:false})
    expect(await f.state.store.getDatabaseUser(data.user.id)).toMatchObject({accountId:f.owner.id,name:data.user.name,grants:[]})
    const after = await f.images()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.databases).toEqual(before.databases)
    expect(after.search).toEqual(before.search)
  })

  it('has the complete default initial grant at the first public StateStore return, without a later setGrant mutation', async () => {
    const original = f.state.store.createDatabaseUser.bind(f.state.store)
    let visibleAtReturn: DatabaseUser | null = null
    vi.spyOn(f.state.store,'createDatabaseUser').mockImplementationOnce(async (...args:Parameters<typeof original>) => {
      const saved = await original(...args); visibleAtReturn = await f.state.store.getDatabaseUser(saved.id); return saved
    })
    const separateGrant = vi.spyOn(f.state.store,'setGrant')
    const response = await f.request('POST',{name:'reader',password:userPassword,databaseId:f.ownDb.id},{path:'/api/databases/users'})
    const data = await response.json() as {user:PublicUser;application:object}
    expect(response.status).toBe(201); assertGrant(data.user,f.ownDb.id)
    expect(visibleAtReturn).not.toBeNull(); assertGrant(visibleAtReturn!,f.ownDb.id)
    expect(separateGrant).not.toHaveBeenCalled()
    const readback = await f.request('GET',undefined,{path:'/api/databases/users'})
    expect(((await readback.json()) as {users:PublicUser[]}).users.find(row=>row.id===data.user.id)).toEqual(data.user)
  })

  it('saves an explicitly limited initial grant without adding default privileges', async () => {
    const response = await f.request('POST',{name:'limited',password:userPassword,databaseId:f.ownDb.id,privileges:['SELECT']},{path:'/api/databases/users'})
    expect(response.status).toBe(201)
    assertGrant(((await response.json()) as {user:PublicUser}).user,f.ownDb.id,['SELECT'])
  })

  it.each(['foreign','missing','trashed','bad-privilege'] as const)('refuses %s initial grant before any user, file, index or success audit appears', async kind => {
    const before = await f.images()
    const databaseId = kind==='foreign' ? f.foreignDb.id : kind==='missing' ? randomUUID() : kind==='trashed' ? f.trashedDb.id : f.ownDb.id
    const response = await f.request('POST',{name:'blocked',password:userPassword,databaseId,...(kind==='bad-privilege'?{privileges:['SELECT; DROP DATABASE']}:{})},{path:'/api/databases/users'})
    expect(response.status).toBe(kind==='foreign'?403:kind==='missing'?404:kind==='trashed'?412:422)
    await unchanged(before)
    expect((await f.state.store.listDatabaseUsers(f.owner.id)).some(user=>user.name===f.owner.username+'_blocked')).toBe(false)
  })

  it('rejects privileges without an initial database instead of silently dropping them', async () => {
    const before = await f.images()
    expect((await f.request('POST',{name:'dropped',password:userPassword,privileges:['SELECT']},{path:'/api/databases/users'})).status).toBe(422)
    await unchanged(before)
  })

  it.each(['database-selector','user-secret-fields','password-object','name-object'] as const)('rejects unsupported owner input %s before effects', async kind => {
    const before = await f.images()
    const body = kind==='database-selector' ? {name:f.owner.username+'_invalid',accountId:f.other.id}
      : kind==='user-secret-fields' ? {name:'invalid',password:userPassword,authPlugin:'ed25519',authString:nativeHash}
      : kind==='password-object' ? {name:'invalid',password:{toString:'invalid'}} : {name:{toString:'invalid'},password:userPassword}
    expect((await f.request('POST',body,{path:kind==='database-selector'?'/api/databases':'/api/databases/users'})).status).toBe(422)
    await unchanged(before)
  })

  it('requires the existing database resource scopes for both reads and writes', async () => {
    const before = await f.images(), read = await f.token(['databases:read']), write = await f.token(['databases:write'])
    for(const path of ['/api/databases','/api/databases/users']) {
      expect((await f.request('GET',undefined,{path,token:read.raw})).status).toBe(200)
      expect((await f.request('GET',undefined,{path,token:write.raw})).status).toBe(403)
    }
    for(const kind of ['database','user'] as const) { const item=operation(kind); expect((await f.request('POST',item.body,{path:item.path,token:read.raw})).status).toBe(403) }
    expect((await f.request('GET',undefined,{token:null})).status).toBe(401)
    await unchanged(before)
  })

  it('enforces the mysql-databases feature across owned reads and both create operations', async () => {
    await f.state.store.updateFeatureList(f.feature.id,{disabled:['mysql-databases']})
    const before = await f.images()
    for(const path of ['/api/databases','/api/databases/users']) expect((await f.request('GET',undefined,{path})).status).toBe(403)
    for(const kind of ['database','user'] as const) { const item=operation(kind); expect((await f.request('POST',item.body,{path:item.path})).status).toBe(403) }
    await unchanged(before)
  })

  it('rejects owner tenant query selectors rather than silently ignoring them', async () => {
    const before = await f.images()
    for(const path of ['/api/databases','/api/databases/users']) expect((await f.request('GET',undefined,{path:path+'?accountId='+f.other.id})).status).toBe(422)
    await unchanged(before)
  })

  it.each(['database','user'] as const)('refuses duplicate %s names without replacing existing state', async kind => {
    const before = await f.images(), body = kind==='database' ? {name:f.ownDb.name} : {name:'seed',password:userPassword}
    expect((await f.request('POST',body,{path:kind==='database'?'/api/databases':'/api/databases/users'})).status).toBe(409)
    await unchanged(before)
  })

  it('counts active databases against the current cap while retaining complete trash metadata', async () => {
    await f.state.store.updatePlan(f.plan.id,{caps:{...f.plan.caps,databases:2}})
    expect((await f.request('POST',{name:f.owner.username+'_last'})).status).toBe(201)
    const before = await f.images(), response = await f.request('POST',{name:f.owner.username+'_overflow'})
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500)
    expect(await response.json()).toMatchObject({code:'LIMIT_EXCEEDED'}); await unchanged(before)
  })

  it('requires the raw full owned database name instead of repairing a suffix or foreign prefix', async () => {
    const before = await f.images()
    for(const name of ['suffix',f.other.username+'_foreign']) expect((await f.request('POST',{name})).status).toBe(422)
    await unchanged(before)
  })

  it.each(['database','user'] as const)('rechecks a credential revoked after initial %s authorization before the writer executes', async kind => {
    const before = await f.images()
    if(kind==='database') {
      const original = f.state.store.createDatabase.bind(f.state.store)
      vi.spyOn(f.state.store,'createDatabase').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{await f.revoke();return original(...args)})
    } else {
      const original = f.state.store.createDatabaseUser.bind(f.state.store)
      vi.spyOn(f.state.store,'createDatabaseUser').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{await f.revoke();return original(...args)})
    }
    const item=operation(kind,'revoked')
    expect((await f.request('POST',item.body,{path:item.path})).status).toBe(401)
    await unchanged(before)
  })

  it('rechecks a feature withdrawn after initial user authorization under the writer guard', async () => {
    const original = f.state.store.createDatabaseUser.bind(f.state.store)
    vi.spyOn(f.state.store,'createDatabaseUser').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{
      await f.state.store.updateFeatureList(f.feature.id,{disabled:['mysql-databases']}); return original(...args)
    })
    const before = await f.images(), item=operation('user','withdrawn')
    expect((await f.request('POST',item.body,{path:item.path})).status).toBe(403); await unchanged(before)
  })

  it('rechecks that the initial grant target is active at the atomic user write', async () => {
    const original = f.state.store.createDatabaseUser.bind(f.state.store)
    let expected: Awaited<ReturnType<typeof f.images>> | undefined
    vi.spyOn(f.state.store,'createDatabaseUser').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{
      await f.state.store.trashDatabase(f.ownDb.id); expected=await f.images(); return original(...args)
    })
    const item=operation('user','stale')
    expect((await f.request('POST',item.body,{path:item.path})).status).toBe(412)
    expect(expected).toBeDefined(); await unchanged(expected!)
  })

  it('confines mailbox credentials even when the persisted principal belongs to the hosting account', async () => {
    const mailbox=await f.state.store.createServiceUser({accountId:f.owner.id,login:'inbox@'+f.owner.primaryDomain,passwordHash:ARGON2,
      services:{email:true,ftp:false,webdisk:false},mailboxQuotaMb:100,ftpDir:'public_html'})
    const credential=await f.token(['mailbox:'+mailbox.id]), before=await f.images()
    for(const path of ['/api/databases','/api/databases/users']) expect((await f.request('GET',undefined,{path,token:credential.raw})).status).toBe(403)
    const item=operation('user','mailbox')
    expect((await f.request('POST',item.body,{path:item.path,token:credential.raw})).status).toBe(403); await unchanged(before)
  })

  it('preserves existing administrator account selection and user-creation grammar', async () => {
    const root=await dbApi.createRootPrincipal(f.database.db,{username:'root',passwordHash:ARGON2})
    await dbApi.setPasswordHash(f.database.db,root.id,ARGON2,{forceChange:false})
    const credential=await f.token(['databases:read','databases:write'],root.id)
    const response=await f.request('POST',{accountId:f.other.id,name:'admin',password:userPassword,databaseId:f.foreignDb.id},{path:'/api/databases/users',token:credential.raw})
    expect(response.status).toBe(201)
    const data=await response.json() as {user:PublicUser}; expect(data.user.name).toBe(f.other.username+'_admin'); assertGrant(data.user,f.foreignDb.id)
    expect((await f.state.store.getDatabaseUser(data.user.id))!.accountId).toBe(f.other.id)
  })

  it('retains reseller ownership and method-sensitive ACL checks', async () => {
    const reseller=await f.state.store.createReseller({username:'dbresell',passwordHash:ARGON2,acl:['list-accounts'],maxAccounts:5,totalDiskMb:10000,totalBandwidthMb:100000,oversell:false,nameservers:[],delegatedIps:[]})
    await dbApi.createResellerPrincipal(f.database.db,{id:reseller.id,username:reseller.username,passwordHash:ARGON2})
    await f.state.store.changeOwner(f.owner.id,reseller.id); await f.seedIndex()
    const credential=await f.token(['databases:read','databases:write'],reseller.id),before=await f.images()
    const own=await f.request('GET',undefined,{path:'/api/databases/users?accountId='+f.owner.id,token:credential.raw})
    expect(own.status).toBe(200)
    expect((await f.request('GET',undefined,{path:'/api/databases/users?accountId='+f.other.id,token:credential.raw})).status).toBe(404)
    expect((await f.request('POST',{accountId:f.owner.id,name:'denied',password:userPassword},{path:'/api/databases/users',token:credential.raw})).status).toBe(403)
    await unchanged(before)
  })

  it('restores the database file and targeted SQL preimage when projection apply fails before authority commit', async () => {
    const original=dbApi.prepareDatabaseIndexCreation, before=await f.images()
    vi.spyOn(dbApi,'prepareDatabaseIndexCreation').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{
      const port=await original(...args)
      return {...port,apply:async()=>{await port.apply();throw new Error('Synthetic targeted database projection refusal')}}
    })
    const response=await f.request('POST',{name:f.owner.username+'_indexfailed'})
    expect(response.ok).toBe(false)
    const data=await response.json() as {details:{stateChanged:boolean;unknownOutcome?:boolean}}
    expect(data.details.stateChanged).toBe(false); expect(data.details.unknownOutcome).not.toBe(true)
    await unchanged(before)
  })

  it.each(['rejected','malformed','transport'] as const)('retains the atomic user and grant after a %s synthetic native application', async mode => {
    const response=await f.request('POST',{name:'nativefailed',password:userPassword,databaseId:f.ownDb.id},{path:'/api/databases/users',application:f.makeApp(mode)})
    await assertUncertain(response)
    const user=(await f.state.store.listDatabaseUsers(f.owner.id)).find(row=>row.name===f.owner.username+'_nativefailed')!
    expect(user).toBeDefined(); assertGrant(user,f.ownDb.id)
    expect(f.calls.map(call=>call.path)).toEqual(['/state/apply']); expect(await f.successAudits()).toEqual([])
  })

  it('labels a valid synthetic global receipt without claiming the database target is verified', async () => {
    const response=await f.request('POST',{name:'applied',password:userPassword,databaseId:f.ownDb.id},{path:'/api/databases/users',application:f.makeApp('applied')})
    expect(response.status).toBe(201)
    const data=await response.json() as {user:PublicUser;application:object}; assertGrant(data.user,f.ownDb.id)
    expect(data.application).toEqual({status:'global_configuration_applied',targetVerified:false})
    expect(f.calls).toEqual([{path:'/state/apply',method:'POST',principalId:f.principal.id}])
  })

  it('retains committed state and reports uncertainty when the success audit fails', async () => {
    vi.spyOn(dbApi,'appendAudit').mockRejectedValueOnce(new Error('Synthetic database audit outage'))
    const response=await f.request('POST',{name:'auditfailed',password:userPassword,databaseId:f.ownDb.id},{path:'/api/databases/users'})
    await assertUncertain(response)
    const user=(await f.state.store.listDatabaseUsers(f.owner.id)).find(row=>row.name===f.owner.username+'_auditfailed')!
    expect(user).toBeDefined(); assertGrant(user,f.ownDb.id)
    expect(await f.successAudits()).toEqual([])
  })

  it('rechecks credentials after commit before any configured native dispatch', async () => {
    const original=f.state.store.createDatabaseUser.bind(f.state.store)
    vi.spyOn(f.state.store,'createDatabaseUser').mockImplementationOnce(async (...args:Parameters<typeof original>)=>{
      const result=await original(...args); await f.revoke(); return result
    })
    const response=await f.request('POST',{name:'revokedlater',password:userPassword,databaseId:f.ownDb.id},{path:'/api/databases/users',application:f.makeApp('applied')})
    await assertUncertain(response)
    const user=(await f.state.store.listDatabaseUsers(f.owner.id)).find(row=>row.name===f.owner.username+'_revokedlater')!
    expect(user).toBeDefined(); assertGrant(user,f.ownDb.id)
    expect(f.calls).toEqual([]); expect(await f.successAudits()).toEqual([])
  })
})
