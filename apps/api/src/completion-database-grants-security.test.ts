import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@xpanel/db'
import type { DatabaseUser } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { ARGON2 } from '../../../packages/db/src/testing.ts'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

type PublicUser = Pick<DatabaseUser,'id'|'name'|'grants'>
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
    'http://localhost'+(options.path??'/api/databases/users/'+(options.userId??ownUser.id)+'/grants'),{
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

describe('conditional database grant API with isolated SQLite and desired state',()=>{
  let f:Awaited<ReturnType<typeof fixture>>
  beforeEach(async()=>{f=await fixture()})
  afterEach(async()=>{
    vi.restoreAllMocks();const failures:unknown[]=[]
    for(const close of cleanup.splice(0).reverse()){try{await close()}catch(error){failures.push(error)}}
    if(failures.length)throw new AggregateError(failures,'Synthetic grant fixture cleanup failed')
  })
  const body=()=>({databaseId:f.ownDb.id,privileges:['SELECT','UPDATE'],expectedPrivileges:['SELECT']})
  const assertGrant=(user:PublicUser,databaseId:string,privileges:string[])=>{
    const grant=user.grants.find(item=>item.databaseId===databaseId)
    expect(grant).toBeDefined();expect([...grant!.privileges].sort()).toEqual([...privileges].sort())
  }
  const safeFailure=async(response:Response,status:number,before:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['images']>>)=>{
    expect(response.status).toBe(status);expect(await f.images()).toEqual(before)
  }
  const assertUnrelated=async(before:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['images']>>)=>{
    const after=await f.images(),target=f.owner.username+'/db-users/'+f.ownUser.name+'.json'
    const withoutTarget=(tree:Record<string,string>)=>Object.fromEntries(Object.entries(tree).filter(([path])=>path!==target))
    expect(withoutTarget(after.tree)).toEqual(withoutTarget(before.tree))
    expect(after.accounts).toEqual(before.accounts);expect(after.databases).toEqual(before.databases);expect(after.search).toEqual(before.search)
  }

  it('adds a grant only when the last read had no grant and returns safe owned readback',async()=>{
    const before=await f.images(),response=await f.request({databaseId:f.secondDb.id,privileges:['INSERT'],expectedPrivileges:null})
    expect(response.status).toBe(200)
    const data=await response.json() as{user:PublicUser;context:{accountId:string};application:object;stateChanged:boolean}
    expect(data.context).toEqual({accountId:f.owner.id});expect(data.stateChanged).toBe(true)
    expect(data.application).toEqual({status:'not_requested',targetVerified:false})
    expect(Object.keys(data.user).sort()).toEqual(['grants','id','name'])
    expect(data.user.id).toBe(f.ownUser.id);expect(data.user.name).toBe(f.ownUser.name)
    assertGrant(data.user,f.secondDb.id,['INSERT']);assertGrant(data.user,f.ownDb.id,['SELECT'])
    const readback=await f.request(undefined,{method:'GET',path:'/api/databases/users'})
    expect(readback.status).toBe(200)
    expect(((await readback.json())as{users:PublicUser[]}).users.find(user=>user.id===f.ownUser.id)).toEqual(data.user)
    await assertUnrelated(before)
  })

  it('replaces only the selected existing grant and preserves unrelated grants and users',async()=>{
    await f.state.store.setGrant({databaseUserId:f.ownUser.id,databaseId:f.secondDb.id,privileges:['DELETE']})
    const before=await f.images(),response=await f.request(body())
    expect(response.status).toBe(200)
    const data=await response.json()as{user:PublicUser}
    assertGrant(data.user,f.ownDb.id,['SELECT','UPDATE']);assertGrant(data.user,f.secondDb.id,['DELETE'])
    expect((await f.state.store.getDatabaseUser(f.ownUser.id))!.grants).toEqual(data.user.grants)
    await assertUnrelated(before)
  })

  it.each(['null','different-array']as const)('refuses stale expected privileges %s before writing',async kind=>{
    const before=await f.images(),response=await f.request({...body(),expectedPrivileges:kind==='null'?null:['DELETE']})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({code:'CONFLICT',details:{stateChanged:false}})
    expect(await f.images()).toEqual(before)
  })

  it('compares the grant current under the writer lease instead of an earlier route snapshot',async()=>{
    const original=f.state.store.setGrant.bind(f.state.store)
    let committed:Awaited<ReturnType<typeof f.images>>|undefined
    vi.spyOn(f.state.store,'setGrant').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{
      await original({databaseUserId:f.ownUser.id,databaseId:f.ownDb.id,privileges:['DELETE']})
      committed=await f.images();return original(...args)
    })
    const response=await f.request(body())
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({details:{stateChanged:false}})
    expect(committed).toBeDefined();expect(await f.images()).toEqual(committed)
    assertGrant((await f.state.store.getDatabaseUser(f.ownUser.id))!,f.ownDb.id,['DELETE'])
  })

  it.each(['foreign-user','foreign-database','trashed-database','missing-database','missing-user']as const)('refuses %s with no file or index effects',async kind=>{
    const before=await f.images()
    const databaseId=kind==='foreign-database'?f.foreignDb.id:kind==='trashed-database'?f.trashDb.id:kind==='missing-database'?randomUUID():f.ownDb.id
    const userId=kind==='foreign-user'?f.foreignUser.id:kind==='missing-user'?randomUUID():f.ownUser.id
    const response=await f.request({databaseId,privileges:['INSERT'],expectedPrivileges:null},{userId})
    await safeFailure(response,kind==='foreign-database'?403:kind==='trashed-database'?412:404,before)
  })

  it.each(['missing-expected','invalid-expected','missing-database','unknown-field']as const)('rejects %s owner input before effects',async kind=>{
    const before=await f.images()
    const input=kind==='missing-expected'?{databaseId:f.ownDb.id,privileges:['UPDATE']}
      :kind==='invalid-expected'?{...body(),expectedPrivileges:[]}
      :kind==='missing-database'?{privileges:['UPDATE'],expectedPrivileges:null}
      :{...body(),accountId:f.other.id}
    await safeFailure(await f.request(input),422,before)
  })

  it('rejects empty or unknown desired privileges instead of granting or revoking something else',async()=>{
    const before=await f.images()
    for(const privileges of[[],['SELECT; DROP DATABASE']])await safeFailure(await f.request({...body(),privileges}),422,before)
  })

  it('rejects owner query selectors',async()=>{
    const before=await f.images(),path='/api/databases/users/'+f.ownUser.id+'/grants?accountId='+f.other.id
    await safeFailure(await f.request(body(),{path}),422,before)
  })

  it('requires write scope and authenticated ownership',async()=>{
    const read=await f.token(['databases:read']),before=await f.images()
    await safeFailure(await f.request(body(),{token:read.raw}),403,before)
    await safeFailure(await f.request(body(),{token:null}),401,before)
  })

  it('enforces the mysql-databases feature on grant changes',async()=>{
    await f.state.store.updateFeatureList(f.feature.id,{disabled:['mysql-databases']})
    const before=await f.images();await safeFailure(await f.request(body()),403,before)
  })

  it('refuses a credential revoked while the grant writer is queued behind the held lease',async()=>{
    const original=f.state.store.setGrant.bind(f.state.store),before=await f.images()
    vi.spyOn(f.state.store,'setGrant').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{
      const lease=await f.state.store.getWriterLock().acquire()
      let pending:ReturnType<typeof original>|undefined
      try{pending=original(...args);await f.revoke()}finally{await lease.release()}
      return await pending!
    })
    await safeFailure(await f.request(body()),401,before)
  })

  it.each(['feature','account-status']as const)('rechecks fresh %s before the grant write',async kind=>{
    const original=f.state.store.setGrant.bind(f.state.store)
    let current:Awaited<ReturnType<typeof f.images>>|undefined
    vi.spyOn(f.state.store,'setGrant').mockImplementationOnce(async(...args:Parameters<typeof original>)=>{
      if(kind==='feature')await f.state.store.updateFeatureList(f.feature.id,{disabled:['mysql-databases']})
      else await f.state.store.suspendAccount(f.owner.id,'Synthetic grant authorization withdrawal')
      current=await f.images();return original(...args)
    })
    const response=await f.request(body());expect(current).toBeDefined();await safeFailure(response,403,current!)
  })

  it('restores the exact previous user file after an ordinary write failure before commit',async()=>{
    type Writer={writeStateJson:(lease:unknown,path:string,data:unknown,mode?:number)=>Promise<void>}
    const writer=f.state.store as unknown as Writer,original=writer.writeStateJson.bind(writer)
    const target=join(f.state.rootDir,'accounts',f.owner.username,'db-users',f.ownUser.name+'.json')
    let injected=false
    vi.spyOn(writer,'writeStateJson').mockImplementation(async(...args:Parameters<typeof original>)=>{
      await original(...args)
      if(args[1]===target&&!injected){injected=true;throw new Error('Synthetic grant write refusal before authority commit')}
    })
    const before=await f.images(),response=await f.request(body())
    expect(injected).toBe(true);expect(response.ok).toBe(false)
    const data=await response.json()as{details:{stateChanged:boolean;unknownOutcome?:boolean}}
    expect(data.details.stateChanged).toBe(false);expect(data.details.unknownOutcome).not.toBe(true)
    expect(await f.images()).toEqual(before)
  })

  it('preserves the administrator legacy grant body without a required expected snapshot',async()=>{
    const root=await dbApi.createRootPrincipal(f.database.db,{username:'root',passwordHash:ARGON2})
    await dbApi.setPasswordHash(f.database.db,root.id,ARGON2,{forceChange:false})
    const credential=await f.token(['databases:read','databases:write'],root.id)
    const response=await f.request({databaseId:f.foreignDb.id,privileges:['SELECT','UPDATE']},{userId:f.foreignUser.id,token:credential.raw})
    expect(response.status).toBe(200)
    const data=await response.json()as{user:PublicUser}
    expect(data.user.id).toBe(f.foreignUser.id);assertGrant(data.user,f.foreignDb.id,['SELECT','UPDATE'])
  })
})
