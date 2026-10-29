import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { ARGON2 } from '../../../packages/db/src/testing.ts'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const cleanup: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const database=await dbApi.createTestDb(); cleanup.push(()=>database.close())
  const state=await createTestStateStore(); cleanup.push(()=>state.close())
  const feature=await state.store.createFeatureList({name:'Grant workspace policy',ownerId:null,disabled:[]})
  const plan=await state.store.createPlan({name:'Grant workspace plan',ownerId:null,featureListId:feature.id,
    resources:{diskMb:1000,bandwidthMbMonth:10000,ioReadBps:1048576,ioWriteBps:1048576,ioReadIops:100,ioWriteIops:100,memoryMb:128,maxProcesses:16,cpuPercent:100},
    caps:{addonDomains:3,aliasDomains:3,subdomains:3,mailboxes:4,forwarders:4,mailingLists:4,ftpAccounts:4,databases:4,phpWorkers:4},
    dedicatedIp:false,shell:'none',defaultMailboxQuotaMb:100})
  await state.store.saveServerIp({address:'192.0.2.76',version:4,prefixLength:24,interfaceName:'test0',role:'shared',ownerKind:'root',ownerId:null,ptrHostname:null,isPrimary:true,notes:''})
  const account=(username:string)=>state.store.createAccount({username,passwordHash:ARGON2,primaryDomain:username+'.example.test',planId:plan.id,ownerId:null,
    contactEmail:'owner@'+username+'.example.test',ipv4:'192.0.2.76',shell:'none',
    php:{version:'8.3',handler:'fpm',fpm:{mode:'ondemand',maxChildren:2,startServers:1,minSpareServers:1,maxSpareServers:1,maxRequests:50,processIdleTimeoutSec:10},ini:{}}})
  const owner=await account('grantown'),other=await account('grantother')
  const ownDb=await state.store.createDatabase({accountId:owner.id,name:owner.username+'_live'})
  const secondDb=await state.store.createDatabase({accountId:owner.id,name:owner.username+'_second'})
  const trashDb=await state.store.createDatabase({accountId:owner.id,name:owner.username+'_trash'});await state.store.trashDatabase(trashDb.id)
  const foreignDb=await state.store.createDatabase({accountId:other.id,name:other.username+'_live'})
  const user=(accountId:string,name:string)=>state.store.createDatabaseUser({accountId,name,authPlugin:'mysql_native_password',authString:'*'+'B'.repeat(40)})
  const ownUser=await user(owner.id,owner.username+'_user'),sibling=await user(owner.id,owner.username+'_other'),foreignUser=await user(other.id,other.username+'_user')
  await state.store.setGrant({databaseUserId:ownUser.id,databaseId:ownDb.id,privileges:['SELECT']})
  await state.store.setGrant({databaseUserId:foreignUser.id,databaseId:foreignDb.id,privileges:['SELECT']})
  const principal=await dbApi.createUserPrincipal(database.db,{username:owner.username,accountId:owner.id,passwordHash:ARGON2})
  const token=async(scopes:string[],principalId=principal.id)=>{
    const raw='xp_'+randomUUID()
    const record=await dbApi.createApiToken(database.db,{principalId,name:'Synthetic grant acceptance',tokenHash:sha256Hex(raw),scopes,expiresAt:new Date(Date.now()+60000).toISOString()})
    return{raw,id:record.id}
  }
  const credential=await token(['databases:read','databases:write'])
  await dbApi.reindexFromState(database.db,await state.store.readSnapshot())
  // No agent or MariaDB transport is supplied: this suite proves desired metadata only.
  const app=createApiApp({db:database.db,store:state.store,serverSecret:TEST_SERVER_SECRET})
  const request=(body?:unknown,options:{method?:string;path?:string;userId?:string;token?:string|null}={})=>app.fetch(new Request(
    'http://localhost'+(options.path??'/api/databases/'+ownDb.id+'/trash'),{
      method:options.method??'POST',headers:{...(options.token===null?{}:{authorization:'Bearer '+(options.token??credential.raw)}),...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }))
  const tree=async()=>{
    const result:Record<string,string>={}
    const walk=async(path:string,relative='')=>{
      for(const item of(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        const key=relative?relative+'/'+item.name:item.name,full=join(path,item.name)
        if(item.isDirectory())await walk(full,key);else result[key]=createHash('sha256').update(await readFile(full)).digest('hex')
      }
    }
    await walk(join(state.rootDir,'accounts'));return result
  }
  const images=async()=>({tree:await tree(),
    accounts:await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,* FROM idx_accounts ORDER BY id'),
    databases:await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,* FROM idx_databases ORDER BY id'),
    search:await database.db.query('SELECT CAST(rowid AS TEXT) AS saved_rowid,kind,entity_id,account_id,owner_id,title,subtitle,keywords FROM search_fts ORDER BY rowid'),
    successAudit:(await dbApi.listAudit(database.db)).filter(row=>row.outcome==='ok'),
  })
  const revoke=()=>database.db.query('UPDATE api_tokens SET revoked_at=$1 WHERE id=$2',[new Date().toISOString(),credential.id])
  return{database,state,feature,owner,other,ownDb,secondDb,trashDb,foreignDb,ownUser,sibling,foreignUser,principal,token,credential,request,images,revoke}
}

describe('recoverable database state API with isolated SQLite and saved configuration',()=>{
  let f:Awaited<ReturnType<typeof fixture>>
  beforeEach(async()=>{f=await fixture()})
  afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close()})
  const trashBody=()=>({expectedTrashedAt:null,confirmation:f.ownDb.name})
  const restoreBody=async()=>({expectedTrashedAt:(await f.state.store.getDatabase(f.trashDb.id))!.trashedAt,confirmation:f.trashDb.name})
  const path=(id:string,verb='trash')=>'/api/databases/'+id+'/'+verb
  const refuse=async(input:unknown,status:number,options:{path?:string;token?:string|null}={})=>{
    const before=await f.images(),response=await f.request(input,options)
    expect(response.status).toBe(status);expect(await f.images()).toEqual(before)
    return response
  }
  it('moves saved metadata to trash without removing files, users or grants',async()=>{
    const beforeUser=await f.state.store.getDatabaseUser(f.ownUser.id),beforeOther=await f.state.store.getDatabase(f.secondDb.id)
    const response=await f.request(trashBody());expect(response.status).toBe(200)
    const body=await response.json(),saved=await f.state.store.getDatabase(f.ownDb.id)
    expect(saved!.trashedAt).toEqual(expect.any(String));expect(body.database).toEqual(saved)
    expect(body.context).toEqual({accountId:f.owner.id});expect(body.stateChanged).toBe(true)
    expect(body.application).toEqual({status:'not_requested',targetVerified:false})
    expect(await f.state.store.getDatabaseUser(f.ownUser.id)).toEqual(beforeUser)
    expect(await f.state.store.getDatabase(f.secondDb.id)).toEqual(beforeOther)
    const rows=await f.database.db.query<{trashed_at:string}>('SELECT trashed_at FROM idx_databases WHERE id=$1',[f.ownDb.id])
    expect(rows[0]!.trashed_at).toBe(saved!.trashedAt)
    const audit=(await dbApi.listAudit(f.database.db)).find(row=>row.action==='database.trashed')
    expect(audit?.outcome).toBe('ok')
  })
  it('restores saved metadata and its scoped index using the captured trash timestamp',async()=>{
    const response=await f.request(await restoreBody(),{path:path(f.trashDb.id,'restore')})
    expect(response.status).toBe(200);const body=await response.json()
    expect(body.database).toMatchObject({id:f.trashDb.id,accountId:f.owner.id,name:f.trashDb.name,trashedAt:null})
    expect(body.stateChanged).toBe(true);expect(body.application.targetVerified).toBe(false)
    const rows=await f.database.db.query<{trashed_at:null}>('SELECT trashed_at FROM idx_databases WHERE id=$1',[f.trashDb.id])
    expect(rows[0]!.trashed_at).toBeNull()
  })
  it('refuses a stale live expectation and a stale restore timestamp before effects',async()=>{
    await refuse({expectedTrashedAt:null,confirmation:f.trashDb.name},409,{path:path(f.trashDb.id)})
    await refuse({expectedTrashedAt:'2025-01-01T00:00:00.000Z',confirmation:f.trashDb.name},409,{path:path(f.trashDb.id,'restore')})
  })
  it('requires the exact current database name confirmation',async()=>{await refuse({...trashBody(),confirmation:f.secondDb.name},409)})
  it.each(['missing-state','missing-confirmation','unknown-selector','bad-state']as const)('rejects %s without effects',async kind=>{
    const body=kind==='missing-state'?{confirmation:f.ownDb.name}:kind==='missing-confirmation'?{expectedTrashedAt:null}
      :kind==='unknown-selector'?{...trashBody(),accountId:f.other.id}:{...trashBody(),expectedTrashedAt:'invalid'}
    await refuse(body,422)
  })
  it('refuses foreign targets and owner query selectors',async()=>{
    await refuse({expectedTrashedAt:null,confirmation:f.foreignDb.name},404,{path:path(f.foreignDb.id)})
    await refuse(trashBody(),422,{path:path(f.ownDb.id)+'?accountId='+f.owner.id})
  })
  it('requires current write scope',async()=>{const read=await f.token(['databases:read']);await refuse(trashBody(),403,{token:read.raw})})
  it('checks the current database limit before restoring',async()=>{
    for(const name of['third','fourth'])await f.state.store.createDatabase({accountId:f.owner.id,name:f.owner.username+'_'+name})
    await refuse(await restoreBody(),422,{path:path(f.trashDb.id,'restore')})
  })
  it('rechecks revoked credentials at the writer boundary',async()=>{
    const original=f.state.store.trashDatabase.bind(f.state.store),before=await f.images()
    vi.spyOn(f.state.store,'trashDatabase').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{await f.revoke();return original(...args)})
    const response=await f.request(trashBody());expect(response.status).toBe(401);expect(await f.images()).toEqual(before)
  })
  it('compares the state current under the lease rather than an earlier route read',async()=>{
    const original=f.state.store.trashDatabase.bind(f.state.store)
    vi.spyOn(f.state.store,'trashDatabase').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{
      await original(f.ownDb.id);return original(...args)
    })
    const response=await f.request(trashBody());expect(response.status).toBe(409)
    expect((await f.state.store.getDatabase(f.ownDb.id))!.trashedAt).not.toBeNull()
    expect((await dbApi.listAudit(f.database.db)).filter(row=>row.action==='database.trashed')).toHaveLength(0)
  })
  it('restores the exact database file when a write fails before commit',async()=>{
    const mutable=f.state.store as unknown as {writeStateJson:(...args:unknown[])=>Promise<void>}
    const original=mutable.writeStateJson.bind(mutable),before=await f.images()
    vi.spyOn(mutable,'writeStateJson').mockImplementationOnce(async(...args)=>{await original(...args);throw new Error('synthetic precommit write failure')})
    const response=await f.request(trashBody());expect(response.status).toBe(503);expect(await f.images()).toEqual(before)
  })
})
