import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import {DB_PRIVILEGES} from '@xpanel/core'
import {generateMailboxPassword} from './password-generate-client.ts'
import {DISPLAY_DATETIME_BINDING,formatDisplayDateTime as canonicalFormatDisplayDateTime} from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime=canonicalFormatDisplayDateTime
export const WORKSPACE_DB_PRIVILEGES:readonly string[]=DB_PRIVILEGES
export interface WorkspaceDatabase {id:string;accountId:string;engine:'mariadb';name:string;trashedAt:string|null}
export interface WorkspaceDatabaseUser {id:string;name:string;grants:{databaseId:string;privileges:string[]}[]}
export interface DatabaseWorkspaceView {accountId:string;databases:WorkspaceDatabase[];users:WorkspaceDatabaseUser[]}
export interface DatabaseWorkspaceState {view:DatabaseWorkspaceView|null;observed:DatabaseWorkspaceView|null;databaseDraft:string;userDraft:{name:string;databaseId:string;privileges:string[]};target:{id:string;name:string}|null;grantDraft:{userId:string;databaseId:string;privileges:string[]};grantExpected:readonly string[]|null|undefined;grantTarget:{userName:string;databaseName:string}|null;grantDirty:boolean;grantConflict:boolean;hasPassword:boolean;dirty:boolean;busy:boolean;reading:boolean;uncertain:boolean;status:'unread'|'reading'|'read'|'stale'|'saving'|'saved'|'failed'|'uncertain';lifecycleReview:boolean;lastOperation:'database'|'user'|'grant'|'trash'|'restore'|null;application:{status:'not_requested'|'global_configuration_applied';targetVerified:false}|null}
export function databaseObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function databaseId(value:unknown):value is string{return typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)}
export function databaseSafeText(value:unknown,max=1024):value is string{return typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)}
export function databaseOwnedName(username:string,value:unknown,user=false):string {
  if(!databaseSafeText(value,64)||!value.startsWith(username+'_')||! /^[a-z0-9][a-z0-9_]*$/.test(value.slice(username.length+1))||value.length+(value.match(/_/g)?.length??0)>64||user&&value.length>32)throw new Error('invalid_owned_database_name')
  return value
}
export function canonicalDatabaseUserName(username:string,raw:string):string {const value=raw.trim().toLowerCase();return databaseOwnedName(username,value.startsWith(username+'_')?value:username+'_'+value,true)}
export function databasePrivileges(value:unknown):string[]{if(!Array.isArray(value)||!value.length||!value.every(v=>typeof v==='string'&&WORKSPACE_DB_PRIVILEGES.includes(v)))throw new Error('invalid_database_privileges');return value.includes('ALL PRIVILEGES')?['ALL PRIVILEGES']:[...new Set(value as string[])].sort()}
export function databaseStable(value:unknown):string {if(Array.isArray(value))return '['+value.map(databaseStable).join(',')+']';if(databaseObject(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+databaseStable(value[k])).join(',')+'}';return JSON.stringify(value)??'undefined'}
export function databaseWriteUncertain(error:unknown):boolean {const value=databaseObject(error)?error:{},details=databaseObject(value.details)?value.details:{};return [value,details].some(v=>['stateChanged','unknownOutcome','verificationRequired','needsAttention'].some(k=>v[k]===true))||details.stateChanged!==false}
export function readWorkspaceDatabase(value:unknown,pin:{accountId:string;username:string}):WorkspaceDatabase {
  if(!databaseObject(value)||!databaseId(value.id)||value.accountId!==pin.accountId||value.engine!=='mariadb'||!(value.trashedAt===null||databaseSafeText(value.trashedAt,128)&&Number.isFinite(Date.parse(value.trashedAt))))throw new Error('invalid_database_record')
  return {id:value.id,accountId:pin.accountId,engine:'mariadb',name:databaseOwnedName(pin.username,value.name),trashedAt:value.trashedAt as string|null}
}
export function readWorkspaceDatabaseUser(value:unknown,pin:{accountId:string;username:string},databases:readonly WorkspaceDatabase[]):WorkspaceDatabaseUser {
  if(!databaseObject(value)||!databaseId(value.id)||value.accountId!==undefined&&value.accountId!==pin.accountId||Object.keys(value).some(k=>/password|auth|secret|credential|token|hash/i.test(k))||!Array.isArray(value.grants))throw new Error('invalid_database_user')
  const ids=new Set<string>(),grants:{databaseId:string;privileges:string[]}[]=[]
  for(const raw of value.grants){if(!databaseObject(raw)||!databaseId(raw.databaseId)||ids.has(raw.databaseId)||!databases.some(db=>db.id===raw.databaseId))throw new Error('invalid_database_grant');ids.add(raw.databaseId);grants.push({databaseId:raw.databaseId,privileges:databasePrivileges(raw.privileges)})}
  return {id:value.id,name:databaseOwnedName(pin.username,value.name,true),grants:grants.sort((a,b)=>a.databaseId.localeCompare(b.databaseId))}
}
export function readDatabaseWorkspace(databasesPayload:unknown,usersPayload:unknown,pin:{accountId:string;username:string}):DatabaseWorkspaceView {
  const context=(v:unknown)=>databaseObject(v)&&databaseObject(v.context)&&v.context.accountId===pin.accountId&&[v,databaseObject(v.details)?v.details:{}].every(part=>!['unknownOutcome','verificationRequired','needsAttention'].some(k=>part[k]===true))&&(v.application===undefined||databaseObject(v.application)&&v.application.targetVerified===false&&['unverified','not_requested','global_configuration_applied'].includes(String(v.application.status)))
  if(!context(databasesPayload)||!context(usersPayload)||!databaseObject(databasesPayload)||!databaseObject(usersPayload)||!Array.isArray(databasesPayload.databases)||!Array.isArray(usersPayload.users))throw new Error('invalid_database_workspace')
  const databases=databasesPayload.databases.map(value=>readWorkspaceDatabase(value,pin)),users=usersPayload.users.map(value=>readWorkspaceDatabaseUser(value,pin,databases))
  if(new Set(databases.map(v=>v.id)).size!==databases.length||new Set(databases.map(v=>v.name)).size!==databases.length||new Set(users.map(v=>v.id)).size!==users.length||new Set(users.map(v=>v.name)).size!==users.length)throw new Error('duplicate_database_record')
  return {accountId:pin.accountId,databases,users}
}
export function readDatabaseApplication(value:unknown,pin:{accountId:string}):{status:'not_requested'|'global_configuration_applied';targetVerified:false} {
  if(!databaseObject(value)||value.context!==undefined&&(!databaseObject(value.context)||value.context.accountId!==pin.accountId)||!databaseObject(value.application)||!['not_requested','global_configuration_applied'].includes(String(value.application.status))||value.application.targetVerified!==false||[value,databaseObject(value.details)?value.details:{}].some(v=>['unknownOutcome','verificationRequired','needsAttention'].some(k=>v[k]===true)))throw new Error('invalid_database_application_receipt')
  return {status:value.application.status as 'not_requested'|'global_configuration_applied',targetVerified:false}
}
export async function requestDatabaseWorkspace(transport:(method:string,path:string,body?:unknown)=>Promise<unknown>,admitted:()=>boolean,method:string,path:string,body?:unknown):Promise<unknown>{if(method!=='GET'&&!admitted())throw {details:{stateChanged:false}};return transport(method,path,body)}
export function createDatabaseWorkspace(options:{accountId:string;username:string;home:string;request:(method:string,path:string,body?:unknown)=>Promise<unknown>;changed?:(state:DatabaseWorkspaceState)=>void;clearSecret?:()=>void}) {
  const defaults=()=>({name:'',databaseId:'',privileges:['DELETE','INSERT','SELECT','UPDATE']})
  const state:DatabaseWorkspaceState={view:null,observed:null,databaseDraft:'',userDraft:defaults(),target:null,grantDraft:{userId:'',databaseId:'',privileges:[]},grantExpected:undefined,grantTarget:null,grantDirty:false,grantConflict:false,hasPassword:false,dirty:false,busy:false,reading:false,uncertain:false,status:'unread',lifecycleReview:false,lastOperation:null,application:null}
  let password='',generation=0,editGeneration=0
  let grantBaseline:Readonly<{userId:string;databaseId:string;userName:string;databaseName:string;expectedPrivileges:readonly string[]|null}>|null=null
  const publish=()=>{state.grantDirty=!!grantBaseline&&databaseStable(state.grantDraft.privileges)!==databaseStable(grantBaseline.expectedPrivileges??[]);state.dirty=state.databaseDraft!==''||state.userDraft.name!==''||state.userDraft.databaseId!==''||state.hasPassword||state.grantDirty;options.changed?.({...state,userDraft:{...state.userDraft,privileges:[...state.userDraft.privileges]},grantDraft:{...state.grantDraft,privileges:[...state.grantDraft.privileges]},grantExpected:state.grantExpected?[...state.grantExpected]:state.grantExpected})}
  const status=(value:DatabaseWorkspaceState['status'])=>{state.status=value;publish()},locked=()=>state.busy||state.uncertain||state.lifecycleReview
  const clearSecret=()=>{password='';state.hasPassword=false;options.clearSecret?.()}
  const read=async()=>{const databases=await options.request('GET','/api/databases?includeTrashed=true');const users=await options.request('GET','/api/databases/users');return readDatabaseWorkspace(databases,users,options)}
  const grantChanged=(view:DatabaseWorkspaceView)=>{if(!grantBaseline)return false;const user=view.users.find(u=>u.id===grantBaseline!.userId),db=view.databases.find(d=>d.id===grantBaseline!.databaseId&&d.trashedAt===null);return !user||!db||user.name!==grantBaseline.userName||db.name!==grantBaseline.databaseName||databaseStable(user.grants.find(g=>g.databaseId===db.id)?.privileges??null)!==databaseStable(grantBaseline.expectedPrivileges)}
  const install=(view:DatabaseWorkspaceView)=>{state.view=view;state.observed=view;state.grantConflict=grantChanged(view)}
  const targetChanged=(view:DatabaseWorkspaceView)=>!!state.target&&!view.databases.some(db=>db.id===state.target!.id&&db.name===state.target!.name&&db.trashedAt===null)||grantChanged(view)
  const captureGrant=(view:DatabaseWorkspaceView,userId:string,databaseId:string)=>{
    const user=userId?view.users.find(u=>u.id===userId):null,db=databaseId?view.databases.find(d=>d.id===databaseId&&d.trashedAt===null):null
    if(userId&&!user||databaseId&&!db)throw new Error('invalid_grant_target')
    const expected=user&&db?user.grants.find(g=>g.databaseId===db.id)?.privileges??null:undefined
    grantBaseline=user&&db?Object.freeze({userId:user.id,databaseId:db.id,userName:user.name,databaseName:db.name,expectedPrivileges:expected?Object.freeze([...expected]):null}):null
    state.grantDraft={userId,databaseId,privileges:expected?[...expected]:[]};state.grantExpected=expected?[...expected]:expected;state.grantTarget=user&&db?{userName:user.name,databaseName:db.name}:null;state.grantConflict=false
  }
  async function saveGrant(){
    if(locked()||state.reading||!state.view||!grantBaseline||!state.grantDirty)return
    if(state.grantConflict){status('stale');return}
    const target=grantBaseline;let desired:string[]
    try{desired=databasePrivileges(state.grantDraft.privileges)}catch{status('failed');return}
    const token=++generation;let dispatched=false;state.busy=true;state.lastOperation='grant';status('saving')
    try{
      const before=await read();if(token!==generation)return;state.observed=before
      const user=before.users.find(u=>u.id===target.userId),db=before.databases.find(d=>d.id===target.databaseId&&d.trashedAt===null)
      if(!user||!db||user.name!==target.userName||db.name!==target.databaseName||databaseStable(user.grants.find(g=>g.databaseId===target.databaseId)?.privileges??null)!==databaseStable(target.expectedPrivileges)){state.grantConflict=true;status('stale');return}
      dispatched=true
      const raw=await options.request('POST','/api/databases/users/'+encodeURIComponent(target.userId)+'/grants',{databaseId:target.databaseId,privileges:desired,expectedPrivileges:target.expectedPrivileges?[...target.expectedPrivileges]:null})
      const application=readDatabaseApplication(raw,options)
      if(!databaseObject(raw))throw new Error('invalid_grant_receipt')
      const accepted=readWorkspaceDatabaseUser(raw.user,options,before.databases)
      if(accepted.id!==target.userId||accepted.name!==target.userName||databaseStable(accepted.grants.find(g=>g.databaseId===target.databaseId)?.privileges??null)!==databaseStable(desired))throw new Error('grant_acknowledgement_mismatch')
      const observed=await read();if(token!==generation)return
      const saved=observed.users.find(u=>u.id===target.userId),savedDb=observed.databases.find(d=>d.id===target.databaseId&&d.name===target.databaseName&&d.trashedAt===null)
      if(!savedDb||!saved||databaseStable(saved)!==databaseStable(accepted))throw new Error('grant_readback_mismatch')
      install(observed);captureGrant(observed,target.userId,target.databaseId);state.application=application;state.uncertain=false;editGeneration++;status('saved')
    }catch(error){if(token!==generation)return;state.uncertain=dispatched&&databaseWriteUncertain(error);const conflict=!state.uncertain&&databaseObject(error)&&error.status===409;if(conflict)state.grantConflict=true;status(state.uncertain?'uncertain':conflict?'stale':'failed')}
    finally{if(token===generation){state.busy=false;publish()}}
  }
  async function changeDatabaseState(captured:WorkspaceDatabase,kind:'trash'|'restore',confirm:(target:Readonly<WorkspaceDatabase>,kind:'trash'|'restore')=>Promise<unknown>){
    if(locked()||state.reading||!state.view)return
    let target:Readonly<WorkspaceDatabase>
    try{target=Object.freeze(readWorkspaceDatabase(captured,options));if(kind==='trash'?target.trashedAt!==null:target.trashedAt===null||new Date(target.trashedAt).toISOString()!==target.trashedAt)throw new Error('invalid_lifecycle_target')}catch{status('failed');return}
    const token=++generation;let dispatched=false;state.busy=true;state.lastOperation=kind;publish()
    try{
      if(await confirm(target,kind)!==true)return
      if(token!==generation)return
      status('saving');const before=await read();if(token!==generation)return;state.observed=before
      const current=before.databases.find(db=>db.id===target.id)
      if(!current||databaseStable(current)!==databaseStable(target)){state.lifecycleReview=true;status('stale');return}
      dispatched=true
      const raw=await options.request('POST','/api/databases/'+encodeURIComponent(target.id)+'/'+kind,{expectedTrashedAt:target.trashedAt,confirmation:target.name}),application=readDatabaseApplication(raw,options)
      if(!databaseObject(raw)||raw.stateChanged!==true)throw new Error('invalid_database_lifecycle_receipt')
      const accepted=readWorkspaceDatabase(raw.database,options)
      if(accepted.id!==target.id||accepted.name!==target.name||(kind==='trash'?accepted.trashedAt===null||new Date(accepted.trashedAt).toISOString()!==accepted.trashedAt:accepted.trashedAt!==null))throw new Error('database_lifecycle_ack_mismatch')
      const observed=await read();if(token!==generation)return
      const saved=observed.databases.find(db=>db.id===target.id)
      if(!saved||databaseStable(saved)!==databaseStable(accepted))throw new Error('database_lifecycle_readback_mismatch')
      install(observed);state.application=application;state.lifecycleReview=false;state.uncertain=false;editGeneration++;status('saved')
    }catch(error){if(token!==generation)return;state.uncertain=dispatched&&databaseWriteUncertain(error);if(!state.uncertain&&databaseObject(error)&&[409,412].includes(Number(error.status)))state.lifecycleReview=true;status(state.uncertain?'uncertain':state.lifecycleReview?'stale':'failed')}
    finally{if(token===generation){state.busy=false;publish()}}
  }
  async function write(kind:'database'|'user'){
    if(locked()||state.reading||!state.view)return
    let intended:string,privileges:string[]=[]
    const rawDatabase=state.databaseDraft,rawUser=state.userDraft.name,target=state.target?{...state.target}:null,selectedId=state.userDraft.databaseId
    try{if(kind==='database')intended=databaseOwnedName(options.username,options.username+'_'+rawDatabase);else {intended=canonicalDatabaseUserName(options.username,rawUser);if(password.length<8||password.length>256)throw new Error('invalid_password');if(selectedId){if(!target||target.id!==selectedId)throw new Error('invalid_initial_grant');privileges=databasePrivileges(state.userDraft.privileges)}}}catch{status('failed');return}
    const token=++generation;let dispatched=false;state.busy=true;state.lastOperation=kind;status('saving')
    try{
      const before=await read();if(token!==generation)return;state.observed=before
      if(kind==='database'&&before.databases.some(db=>db.name===intended)||kind==='user'&&before.users.some(user=>user.name===intended)){status('failed');return}
      if(kind==='user'&&selectedId&&!before.databases.some(db=>db.id===selectedId&&db.name===target!.name&&db.trashedAt===null)){status('stale');return}
      const body:Record<string,unknown>=kind==='database'?{name:options.username+'_'+rawDatabase}:{name:rawUser,password}
      if(kind==='user'&&selectedId){body.databaseId=selectedId;body.privileges=privileges}
      dispatched=true
      let pending:Promise<unknown>
      try{pending=options.request('POST',kind==='database'?'/api/databases':'/api/databases/users',body)}finally{if(kind==='user')clearSecret()}
      const raw=await pending,application=readDatabaseApplication(raw,options)
      if(!databaseObject(raw))throw new Error('invalid_creation_receipt')
      const created=kind==='database'?readWorkspaceDatabase(raw.database,options):readWorkspaceDatabaseUser(raw.user,options,before.databases)
      if(created.name!==intended||(kind==='database'?before.databases:before.users).some(row=>row.id===created.id))throw new Error('creation_target_mismatch')
      if(kind==='database'&&(created as WorkspaceDatabase).trashedAt!==null)throw new Error('new_database_trashed')
      if(kind==='user'){const expected=selectedId?[{databaseId:selectedId,privileges}]:[];if(databaseStable((created as WorkspaceDatabaseUser).grants)!==databaseStable(expected))throw new Error('initial_grant_mismatch')}
      const observed=await read();if(token!==generation)return
      const found=(kind==='database'?observed.databases:observed.users).find(row=>row.id===created.id)
      if(!found||databaseStable(found)!==databaseStable(created))throw new Error('creation_readback_mismatch')
      install(observed);state.application=application;state.uncertain=false
      if(kind==='database')state.databaseDraft='';else {state.userDraft=defaults();state.target=null;clearSecret()}
      editGeneration++;status('saved')
    }catch(error){if(token!==generation)return;state.uncertain=dispatched&&databaseWriteUncertain(error);status(state.uncertain?'uncertain':'failed')}
    finally{if(token===generation){state.busy=false;publish()}}
  }
  return {
    state,
    editDatabase(value:string){if(locked())return;state.databaseDraft=value;editGeneration++;publish()},
    editUser(patch:Partial<DatabaseWorkspaceState['userDraft']>){if(locked())return;state.userDraft={...state.userDraft,...patch,privileges:patch.privileges?[...patch.privileges]:state.userDraft.privileges};if(patch.databaseId!==undefined){const row=(state.observed??state.view)?.databases.find(db=>db.id===patch.databaseId&&db.trashedAt===null);state.target=row?{id:row.id,name:row.name}:null}editGeneration++;publish()},
    editPassword(value:string){if(locked())return;password=value;state.hasPassword=value.length>0;editGeneration++;publish()},
    async selectGrant(patch:{userId?:string;databaseId?:string},confirm:()=>Promise<unknown>){if(locked()||state.reading||!state.view)return;const userId=patch.userId??state.grantDraft.userId,databaseId=patch.databaseId??state.grantDraft.databaseId;if(userId===state.grantDraft.userId&&databaseId===state.grantDraft.databaseId)return;const token=++generation;state.busy=true;publish();try{if(state.grantDirty&&await confirm()!==true)return;if(token!==generation)return;captureGrant(state.observed??state.view,userId,databaseId);editGeneration++;status('read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    editGrantPrivileges(values:string[]){if(locked()||state.reading||!grantBaseline)return;try{state.grantDraft.privileges=values.length?databasePrivileges(values):[];editGeneration++;publish()}catch{status('failed')}},
    async discardGrant(confirm:()=>Promise<unknown>){if(locked()||state.reading||!grantBaseline)return;const token=++generation;state.busy=true;publish();try{if(state.grantDirty&&await confirm()!==true)return;if(token!==generation)return;state.grantDraft.privileges=[...(grantBaseline.expectedPrivileges??[])];editGeneration++;status(state.grantConflict?'stale':'read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    saveGrant,changeDatabaseState,
    async refresh(){if(state.busy)return;const token=++generation,editToken=editGeneration;state.reading=true;status(state.uncertain?'uncertain':state.lifecycleReview?'stale':'reading');try{const view=await read();if(token!==generation)return;state.observed=view;state.grantConflict=grantChanged(view);if(!state.uncertain&&!state.dirty&&editToken===editGeneration)install(view);status(state.uncertain?'uncertain':state.lifecycleReview||targetChanged(view)?'stale':'read')}catch{if(token===generation)status(state.uncertain?'uncertain':state.lifecycleReview?'stale':'failed')}finally{if(token===generation){state.reading=false;publish()}}},
    async reload(confirm:()=>Promise<unknown>){if(state.busy)return;const token=++generation;state.busy=true;state.reading=false;publish();try{if((state.dirty||state.uncertain||state.lifecycleReview)&&await confirm()!==true)return;const view=await read();if(token!==generation)return;install(view);state.databaseDraft='';state.userDraft=defaults();state.target=null;grantBaseline=null;state.grantDraft={userId:'',databaseId:'',privileges:[]};state.grantExpected=undefined;state.grantTarget=null;state.grantConflict=false;state.application=null;state.uncertain=false;state.lifecycleReview=false;clearSecret();editGeneration++;status('read')}catch{if(token===generation)status(state.uncertain?'uncertain':'failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async clear(kind:'database'|'user',confirm:()=>Promise<unknown>){if(locked())return;const token=++generation;state.busy=true;state.reading=false;publish();try{const dirty=kind==='database'?state.databaseDraft!=='':state.userDraft.name!==''||state.userDraft.databaseId!==''||state.hasPassword;if(dirty&&await confirm()!==true)return;if(token!==generation)return;if(kind==='database')state.databaseDraft='';else {state.userDraft=defaults();state.target=null;clearSecret()}editGeneration++;status('read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    createDatabase:()=>write('database'),createUser:()=>write('user'),
  }
}
function bindDatabaseWorkspace(askDialog:(options:Record<string,unknown>)=>Promise<unknown>){
  const t=(message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-database-workspace]').forEach(root=>{
    const accountId=root.dataset.dbAccount,username=root.dataset.dbUsername,home=root.dataset.dbHome;if(!accountId||!username||!home)return
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
    const blocked=()=>!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'),admitted=()=>root.dataset.dbManage==='true'&&!blocked()
    const databaseForm=root.querySelector<HTMLFormElement>('[data-db-create]')!,userForm=root.querySelector<HTMLFormElement>('[data-dbu-create]')!,grantForm=root.querySelector<HTMLFormElement>('[data-db-grant-form]')!,passwordInput=userForm.querySelector<HTMLInputElement>('[name=password]')!,status=root.querySelector<HTMLElement>('[data-db-status]')!
    const button=(key:string)=>root.querySelector<HTMLButtonElement>('[data-'+key+']')
    const discard=()=>askDialog({title:t('Discard drafts and review saved configuration?'),body:t('Unsaved fields and the entered password will be cleared. No previous write is retried.'),confirm:t('Discard and continue'),danger:true})
    const discardGrant=()=>askDialog({title:t('Discard this grant draft?'),body:t('Only unsaved privilege changes for this selection will be discarded. Database and user creation drafts are preserved. No write is sent.'),confirm:t('Discard grant changes'),danger:true})
    const messages:Record<DatabaseWorkspaceState['status'],string>={unread:t('Saved database and user records have not been read.'),reading:t('Reading owned database configuration…'),read:t('Saved configuration read. Service and connections remain unverified.'),stale:t('The selected grant target changed or is unavailable. Your draft is preserved. Choose an active database explicitly.'),saving:t('Saving configuration and checking readback…'),saved:t('Configuration saved and read back. Service, authentication and connections remain unverified.'),failed:t('The request could not complete. Metadata drafts are preserved. Re-enter the password if it was dispatched.'),uncertain:t('The write outcome requires review. Do not retry. Refresh preserves this lock; explicitly reload saved configuration to continue.')}
    const contracts={database:{row:'database-row',empty:'database-empty',slots:['name','size','tables','users','collation','last-write']},user:{row:'database-user-row',empty:'database-user-empty',slots:['name','grants','last-connection']},trash:{row:'database-trash-row',empty:'database-trash-empty',slots:['name','trashed','retention']}} as const
    const contract=(body:HTMLElement)=>body.hasAttribute('data-db-rows')?contracts.database:body.hasAttribute('data-dbu-rows')?contracts.user:contracts.trash
    const templates=new Map(Object.values(contracts).flatMap(item=>[[item.row,clientTemplate(root,item.row)],[item.empty,clientTemplate(root,item.empty)]] as const))
    const factTemplate=clientTemplate(root,'database-fact'),tokenTemplate=clientTemplate(root,'database-token')
    for(const item of Object.values(contracts)){cloneClientTemplate(templates.get(item.row)!,'tr',item.slots);cloneClientTemplate(templates.get(item.empty)!,'tr',['message'])}
    cloneClientTemplate(factTemplate,'div',['label','value']);cloneClientTemplate(tokenTemplate,'bdi',['value'])
    const fact=(list:HTMLElement,label:string,value:string)=>{const wrapper=cloneClientTemplate(factTemplate,'div',['label','value']);clientTemplateSlot(wrapper,'label').textContent=label;clientTemplateSlot(wrapper,'value').textContent=value;list.append(wrapper)}
    const row=(body:HTMLElement,id:string,values:{text:string;technical?:boolean}[],_actions:string[])=>{const item=contract(body),tr=cloneClientTemplate(templates.get(item.row)!,'tr',item.slots);tr.dataset.databaseId=id;item.slots.forEach((slot,index)=>{clientTemplateSlot(tr,slot).textContent=values[index]!.text});body.append(tr);return tr}
    const empty=(body:HTMLElement,_columns:number,text:string)=>{if(body.children.length)return;const item=contract(body),tr=cloneClientTemplate(templates.get(item.empty)!,'tr',['message']);clientTemplateSlot(tr,'message','td').textContent=text;body.append(tr)}
    const lifecycleTargets=new WeakMap<HTMLButtonElement,{target:WorkspaceDatabase;kind:'trash'|'restore'}>()
    let painted=''
    const workspace=createDatabaseWorkspace({accountId,username,home,request:async(method,path,body)=>{if(!transport)throw new Error('session_request_unavailable');return requestDatabaseWorkspace(transport,admitted,method,path,body)},clearSecret(){passwordInput.value='';passwordInput.type='password';button('dbu-reveal')?.setAttribute('aria-pressed','false');if(button('dbu-reveal'))button('dbu-reveal')!.textContent=t('Show password')},changed(state){
      status.dataset.state=state.status;status.textContent=state.status==='stale'&&state.lifecycleReview?t('The database changed. Refresh can inspect current metadata; explicitly discard drafts and reload before another change.'):state.status==='stale'&&state.grantConflict?t('Saved privileges changed. Your grant draft and captured baseline are preserved. Refresh to inspect, then explicitly discard drafts and reload before editing this grant again.'):messages[state.status];root.setAttribute('aria-busy',String(state.busy||state.reading))
      const disabled=state.busy||state.uncertain||state.lifecycleReview||!state.view||!admitted(),view=state.observed
      for(const form of [databaseForm,userForm])form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('[name],button').forEach(c=>{c.disabled=disabled})
      const grantDisabled=disabled||state.reading
      grantForm.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('[name],button').forEach(c=>{c.disabled=grantDisabled})
      button('db-grant-save')!.disabled=grantDisabled||!state.grantTarget||!state.grantDirty||!state.grantDraft.privileges.length||state.grantConflict
      button('db-grant-discard')!.disabled=grantDisabled||!state.grantDirty
      button('db-grant-advanced-toggle')!.disabled=grantDisabled||!state.grantTarget
      button('db-refresh')!.disabled=state.busy||blocked();button('db-reload')!.disabled=state.busy||blocked()||!state.view&&!state.uncertain
      button('db-create-submit')!.disabled=disabled||state.reading||!state.databaseDraft
      button('dbu-create-submit')!.disabled=disabled||state.reading||!state.userDraft.name||!state.hasPassword
      button('db-clear')!.disabled=disabled||!state.databaseDraft;button('dbu-clear')!.disabled=disabled||!state.userDraft.name&&!state.userDraft.databaseId&&!state.hasPassword
      const name=databaseForm.querySelector<HTMLInputElement>('[name=name]')!;if(name.value!==state.databaseDraft)name.value=state.databaseDraft
      const userName=userForm.querySelector<HTMLInputElement>('[name=name]')!;if(userName.value!==state.userDraft.name)userName.value=state.userDraft.name
      const fullName=username+'_'+state.databaseDraft
      root.querySelector<HTMLElement>('[data-db-full-name]')!.textContent=t('Full name: {name} · {units} / 64 grant-name units (underscores count twice)',{name:fullName,units:fullName.length+(fullName.match(/_/g)?.length??0)})
      if(state.lastOperation==='user'&&!state.hasPassword)root.querySelector<HTMLElement>('[data-dbu-secret-note]')!.textContent=t('The entered password was cleared locally. Saved credentials are never returned.')
      const target=userForm.querySelector<HTMLSelectElement>('[name=databaseId]')!
      if(view){const key=databaseStable(view);if(key!==painted){painted=key;const dbRows=root.querySelector<HTMLElement>('[data-db-rows]')!,userRows=root.querySelector<HTMLElement>('[data-dbu-rows]')!,trashRows=root.querySelector<HTMLElement>('[data-db-trash-rows]')!;dbRows.textContent='';userRows.textContent='';trashRows.textContent='';
        for(const db of view.databases){if(db.trashedAt===null){const users=view.users.filter(user=>user.grants.some(grant=>grant.databaseId===db.id)).map(user=>user.name).join(', ');const rendered=row(dbRows,db.id,[{text:db.name,technical:true},{text:t(msgctxt('database-workspace-client', 'Not read'))},{text:t(msgctxt('database-workspace-client', 'Not read'))},{text:users||t('No saved grants'),technical:!!users},{text:t(msgctxt('database-workspace-client', 'Not read'))},{text:t(msgctxt('database-workspace-client', 'Not read'))}],[t(msgctxt('database-workspace-client', 'Rename')),t('Move to trash')]);const action=clientTemplateSlot(rendered,'trash','button') as HTMLButtonElement;action.dataset.dbTrashAction=db.id;lifecycleTargets.set(action,{target:{...db},kind:'trash'})}else {const rendered=row(trashRows,db.id,[{text:db.name,technical:true},{text:formatDisplayDateTime(db.trashedAt),technical:true},{text:t(msgctxt('database-workspace-client', 'Not read'))}],[t('Restore'),t(msgctxt('database-workspace-client', 'Drop permanently'))]);const time=clientTemplateSlot(rendered,'trashed','time') as HTMLTimeElement;time.dateTime=db.trashedAt;const action=clientTemplateSlot(rendered,'restore','button') as HTMLButtonElement;action.dataset.dbRestoreAction=db.id;lifecycleTargets.set(action,{target:{...db},kind:'restore'})}}
        for(const user of view.users){const grants=user.grants.map(grant=>{const db=view.databases.find(r=>r.id===grant.databaseId)!;return (db.trashedAt?t('{database} [trashed]',{database:db.name}):db.name)+': '+grant.privileges.join(', ')}).join(' · ');const rendered=row(userRows,user.id,[{text:user.name,technical:true},{text:grants||t('No privileges'),technical:!!grants},{text:t(msgctxt('database-workspace-client', 'Not read'))}],[t('Privileges'),t('Change password'),t('Delete')]);clientTemplateSlot(rendered,'privileges','button').dataset.dbEditGrants=user.id}
        empty(dbRows,7,t('No active saved databases were returned.'));empty(userRows,4,t('No saved database users were returned.'));empty(trashRows,4,t('Trash is empty in the saved metadata.'))
        target.textContent='';const none=document.createElement('option');none.value='';none.textContent=t('No initial grant');target.append(none);for(const db of view.databases.filter(db=>db.trashedAt===null)){const option=document.createElement('option');option.value=db.id;option.textContent=db.name;target.append(option)}
        const fill=(select:HTMLSelectElement,prompt:string,records:readonly {id:string;name:string}[])=>{select.textContent='';const empty=document.createElement('option');empty.value='';empty.textContent=prompt;select.append(empty);for(const record of records){const option=document.createElement('option');option.value=record.id;option.textContent=record.name;select.append(option)}}
        fill(grantForm.querySelector<HTMLSelectElement>('[name=userId]')!,t('Choose a user'),view.users)
        fill(grantForm.querySelector<HTMLSelectElement>('[name=databaseId]')!,t('Choose an active database'),view.databases.filter(db=>db.trashedAt===null))
        const counts=root.querySelector<HTMLElement>('[data-db-counts]')!;counts.textContent='';fact(counts,t('Databases'),String(view.databases.filter(db=>db.trashedAt===null).length));fact(counts,t('Database users'),String(view.users.length));fact(counts,t('Size on disk'),t(msgctxt('database-workspace-client', 'Not read')));fact(counts,t(msgctxt('database-workspace-client', 'In trash')),String(view.databases.filter(db=>db.trashedAt!==null).length))
      }}
      if(state.userDraft.databaseId&&!Array.from(target.options).some(o=>o.value===state.userDraft.databaseId)){const option=document.createElement('option');option.value=state.userDraft.databaseId;option.textContent=t('{database} — unavailable',{database:state.target?.name??t('Selected database')});option.disabled=true;target.append(option)}target.value=state.userDraft.databaseId
      const privileges=root.querySelector<HTMLElement>('[data-dbu-initial-privileges]')!;privileges.hidden=!state.userDraft.databaseId
      userForm.querySelectorAll<HTMLInputElement>('[name=privileges]').forEach(c=>{c.checked=state.userDraft.privileges.includes(c.value);c.disabled=disabled||!state.userDraft.databaseId||state.userDraft.privileges.includes('ALL PRIVILEGES')&&c.value!=='ALL PRIVILEGES'})
      root.querySelectorAll<HTMLButtonElement>('[data-db-edit-grants],[data-db-trash-action],[data-db-restore-action]').forEach(c=>{c.disabled=grantDisabled})
      for(const key of ['userId','databaseId'] as const){const select=grantForm.querySelector<HTMLSelectElement>('[name='+key+']')!,id=state.grantDraft[key];if(id&&!Array.from(select.options).some(option=>option.value===id)){const option=document.createElement('option');option.value=id;option.disabled=true;option.textContent=(key==='userId'?state.grantTarget?.userName:state.grantTarget?.databaseName)??t('Unavailable target');select.append(option)}select.value=id}
      grantForm.querySelectorAll<HTMLInputElement>('[name=privileges]').forEach(c=>{c.checked=state.grantDraft.privileges.includes(c.value);c.disabled=grantDisabled||!state.grantTarget||state.grantDraft.privileges.includes('ALL PRIVILEGES')&&c.value!=='ALL PRIVILEGES'})
      const grantText=(selector:string,label:string,privileges:readonly string[]|null|undefined)=>{const node=root.querySelector<HTMLElement>(selector)!;node.replaceChildren(document.createTextNode(label));if(state.grantTarget){for(const value of [state.grantTarget.userName,state.grantTarget.databaseName]){const bdi=cloneClientTemplate(tokenTemplate,'bdi',['value']);bdi.textContent=value;node.append(document.createTextNode(' · '),bdi)}}if(privileges===null)node.append(document.createTextNode(' · '+t('No existing grant')));else if(privileges!==undefined){for(const privilege of privileges){const bdi=document.createElement('bdi');bdi.dir='ltr';bdi.textContent=privilege;node.append(document.createTextNode(' · '),bdi)}if(!privileges.length)node.append(document.createTextNode(' · '+t('Choose at least one privilege; revocation is unavailable here.')))}}
      grantText('[data-db-grant-current]',state.grantExpected===undefined?t('Choose both targets to read their saved grant.'):t('Captured saved grant'),state.grantExpected)
      grantText('[data-db-grant-preview]',state.grantTarget?t('Desired grants'):t('No grant change is drafted.'),state.grantTarget?state.grantDraft.privileges:undefined)
      root.querySelector<HTMLElement>('[data-db-application]')!.textContent=state.application?.status==='global_configuration_applied'?t('A global configuration receipt was returned. MariaDB service, grants and connections remain unverified.'):state.application?.status==='not_requested'?t('Native application was not requested. MariaDB service, grants and connections remain unverified.'):t('MariaDB service, grants and connections remain unverified.')
    }})
    databaseForm.querySelector<HTMLInputElement>('[name=name]')!.addEventListener('input',event=>{if(admitted())workspace.editDatabase((event.target as HTMLInputElement).value)})
    userForm.querySelector<HTMLInputElement>('[name=name]')!.addEventListener('input',event=>{if(admitted())workspace.editUser({name:(event.target as HTMLInputElement).value})})
    passwordInput.addEventListener('input',()=>{if(admitted())workspace.editPassword(passwordInput.value)})
    userForm.querySelector<HTMLSelectElement>('[name=databaseId]')!.addEventListener('change',event=>{if(admitted())workspace.editUser({databaseId:(event.target as HTMLSelectElement).value})})
    userForm.querySelectorAll<HTMLInputElement>('[name=privileges]').forEach(c=>c.addEventListener('change',()=>{if(!admitted())return;const current=workspace.state.userDraft.privileges;if(c.value==='ALL PRIVILEGES')workspace.editUser({privileges:c.checked?['ALL PRIVILEGES']:[]});else workspace.editUser({privileges:c.checked?[...current.filter(v=>v!=='ALL PRIVILEGES'),c.value]:current.filter(v=>v!==c.value)})}))
    for(const key of ['userId','databaseId'] as const)grantForm.querySelector<HTMLSelectElement>('[name='+key+']')!.addEventListener('change',event=>{if(admitted())void workspace.selectGrant({[key]:(event.target as HTMLSelectElement).value},discardGrant)})
    grantForm.querySelectorAll<HTMLInputElement>('[name=privileges]').forEach(c=>c.addEventListener('change',()=>{if(!admitted())return;const current=workspace.state.grantDraft.privileges;workspace.editGrantPrivileges(c.value==='ALL PRIVILEGES'?(c.checked?['ALL PRIVILEGES']:[]):c.checked?[...current.filter(v=>v!=='ALL PRIVILEGES'),c.value]:current.filter(v=>v!==c.value))}))
    grantForm.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.saveGrant()})
    root.addEventListener('click',event=>{const action=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-db-trash-action],[data-db-restore-action]'):null;if(!action||action.disabled||!admitted())return;const captured=lifecycleTargets.get(action);if(!captured)return;void workspace.changeDatabaseState(captured.target,captured.kind,(target,kind)=>askDialog({title:kind==='trash'?t('Move database to trash?'):t('Restore database configuration?'),body:kind==='trash'?t('Move the saved configuration for {name}. No permanent purge or native database effect is verified. Other drafts are preserved.',{name:target.name}):t('Restore the saved configuration for {name}. No permanent purge or native database effect is verified. Other drafts are preserved.',{name:target.name}),confirm:kind==='trash'?t('Move to trash'):t('Restore configuration'),danger:kind==='trash'}))})
    root.addEventListener('click',event=>{const edit=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-db-edit-grants]'):null;if(!edit||edit.disabled||!admitted())return;const userId=edit.dataset.dbEditGrants!;void workspace.selectGrant({userId,databaseId:''},discardGrant).then(()=>{if(workspace.state.grantDraft.userId===userId){grantForm.scrollIntoView({block:'start'});grantForm.querySelector<HTMLSelectElement>('[name=databaseId]')!.focus()}})})
    button('db-grant-discard')!.addEventListener('click',()=>{if(admitted())void workspace.discardGrant(discardGrant)})
    button('db-grant-advanced-toggle')!.addEventListener('click',()=>{const toggle=button('db-grant-advanced-toggle')!;if(!admitted()||toggle.disabled)return;const extra=root.querySelector<HTMLElement>('[data-db-grant-advanced]')!;extra.hidden=!extra.hidden;toggle.setAttribute('aria-expanded',String(!extra.hidden));toggle.textContent=extra.hidden?t('Show {count} advanced privileges', { count: extra.querySelectorAll('input').length }):t('Hide advanced privileges')})
    databaseForm.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.createDatabase()});userForm.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.createUser()})
    button('db-refresh')!.addEventListener('click',()=>{if(!blocked())void workspace.refresh()});button('db-reload')!.addEventListener('click',()=>{if(!blocked())void workspace.reload(discard)})
    button('db-clear')!.addEventListener('click',()=>{if(admitted())void workspace.clear('database',discard)});button('dbu-clear')!.addEventListener('click',()=>{if(admitted())void workspace.clear('user',discard)})
    button('dbu-generate')!.addEventListener('click',()=>{if(!admitted()||workspace.state.busy||workspace.state.uncertain||passwordInput.disabled)return;try{const generated=generateMailboxPassword();passwordInput.value=generated;workspace.editPassword(generated);root.querySelector<HTMLElement>('[data-dbu-secret-note]')!.textContent=t('Password generated locally. No changes have been sent.')}catch{root.querySelector<HTMLElement>('[data-dbu-secret-note]')!.textContent=t('Secure generation is unavailable. Enter a password yourself.')}})
    button('dbu-reveal')!.addEventListener('click',()=>{if(!admitted()||passwordInput.disabled)return;const show=passwordInput.type==='password';passwordInput.type=show?'text':'password';button('dbu-reveal')!.setAttribute('aria-pressed',String(show));button('dbu-reveal')!.textContent=show?t('Hide password'):t('Show password')})
    window.addEventListener('beforeunload',event=>{if(workspace.state.dirty||workspace.state.uncertain||workspace.state.lifecycleReview){event.preventDefault();event.returnValue=''}})
    button('db-refresh')!.disabled=blocked();if(!blocked())void workspace.refresh()
  })
}
export const DATABASE_WORKSPACE_CLIENT_BINDING=`(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const WORKSPACE_DB_PRIVILEGES=${JSON.stringify(WORKSPACE_DB_PRIVILEGES)};const generateMailboxPassword=${generateMailboxPassword.toString()};const databaseObject=${databaseObject.toString()};const databaseId=${databaseId.toString()};const databaseSafeText=${databaseSafeText.toString()};const databaseOwnedName=${databaseOwnedName.toString()};const canonicalDatabaseUserName=${canonicalDatabaseUserName.toString()};const databasePrivileges=${databasePrivileges.toString()};const databaseStable=${databaseStable.toString()};const databaseWriteUncertain=${databaseWriteUncertain.toString()};const readWorkspaceDatabase=${readWorkspaceDatabase.toString()};const readWorkspaceDatabaseUser=${readWorkspaceDatabaseUser.toString()};const readDatabaseWorkspace=${readDatabaseWorkspace.toString()};const readDatabaseApplication=${readDatabaseApplication.toString()};const requestDatabaseWorkspace=${requestDatabaseWorkspace.toString()};const createDatabaseWorkspace=${createDatabaseWorkspace.toString()};return ${bindDatabaseWorkspace.toString()};})()`
