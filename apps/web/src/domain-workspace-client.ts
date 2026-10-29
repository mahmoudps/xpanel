import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />
export interface DomainWorkspaceRow {id:string;accountId:string;name:string;kind:'primary'|'addon'|'subdomain'|'alias';parentId:string|null;docRoot:string;siteType:'php'|'static'|'proxy'|'node'|'python';upstream:string|null;redirect:{to:string;code:301|302}|null;php:{version:string;handler:string;fpm:Record<string,string|number>;ini:Record<string,string>};wildcard:boolean;certificateId:string|null;suspended:boolean;expiresAt:string|null;pathQuotaMb:number|'unlimited';ipv4?:string|null;ipv6?:string|null;proxy?:{websocket:boolean;hostHeader:'client'|'upstream';headers:{name:string;value:string}[]}}
export interface DomainWorkspaceView {context:{accountId:string;home:string};revision:string;domains:DomainWorkspaceRow[];limits:{addonDomains:number|'unlimited';aliasDomains:number|'unlimited';subdomains:number|'unlimited'};removals:{domainId:string;canRemove:boolean;childCount:number;serviceUserCount:number}[];application:{status:'unverified'|'not_requested'|'global_configuration_applied';targetVerified:false}}
export interface DomainCreateDraft {name:string;kind:'addon'|'subdomain'|'alias';parentId:string;docRoot:string;siteType:'php'|'static'}
export interface DomainWorkspaceState {view:DomainWorkspaceView|null;observed:DomainWorkspaceView|null;draft:DomainCreateDraft;selected:DomainWorkspaceRow|null;rootDraft:string;mode:'create'|'settings';dirty:boolean;busy:boolean;reading:boolean;uncertain:boolean;status:'unread'|'reading'|'read'|'stale'|'saving'|'saved'|'failed'|'uncertain';application:DomainWorkspaceView['application']|null}
export function domainObject(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)}
export function domainSafeText(v:unknown,max=4096):v is string{return typeof v==='string'&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v)}
export function domainCanonicalName(raw:string):string {
  if(!domainSafeText(raw,1024)||!raw||/[\s\/@:#?%\[\]\\]/u.test(raw))throw new Error('invalid_domain_name')
  const host=new URL('http://'+raw.normalize('NFC')+'/').hostname.toLowerCase().replace(/\.$/,'')
  if(!host||host.length>253)throw new Error('invalid_domain_name');return host
}
/** Boundary comparison only; the server retains protected-folder and filesystem authority. */
export function domainRoot(home:string,value:string):string {
  if(!domainSafeText(home)||!home.startsWith('/')||home.endsWith('/')||!domainSafeText(value)||!value||value.includes('\\'))throw new Error('invalid_document_root')
  const relative=value.startsWith('/')?(value.startsWith(home+'/')?value.slice(home.length+1):''):value
  if(!relative||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('invalid_document_root')
  return home+'/'+relative
}
export function domainStable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(domainStable).join(',')+']'
  if(domainObject(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+domainStable(value[key])).join(',')+'}'
  return JSON.stringify(value)??'undefined'
}
export function domainWriteUncertain(error:unknown):boolean {
  const v=domainObject(error)?error:{},d=domainObject(v.details)?v.details:{}
  return [v,d].some(o=>['stateChanged','unknownOutcome','verificationRequired','needsAttention'].some(key=>o[key]===true))||d.stateChanged!==false
}
export function domainPhpSettings(value:unknown):boolean {
  if(!domainObject(value)||!domainSafeText(value.version,64)||!value.version||!['fpm','cgi','suphp','lsphp'].includes(String(value.handler))||!domainObject(value.fpm)||!domainObject(value.ini))return false
  const fpm=value.fpm,ini=value.ini
  return ['ondemand','dynamic','static'].includes(String(fpm.mode))&&['maxChildren','startServers','minSpareServers','maxSpareServers','maxRequests','processIdleTimeoutSec'].every(k=>typeof fpm[k]==='number'&&Number.isSafeInteger(fpm[k])&&Number(fpm[k])>=0)&&Object.entries(ini).every(([k,v])=>domainSafeText(k)&&domainSafeText(v))
}
export function domainPhpLabel(row:DomainWorkspaceRow):string{return row.siteType==='php'?row.php.version:xpT('Not used')}
export function readDomainWorkspace(value:unknown,expected:{accountId:string;home:string}):DomainWorkspaceView {
  const bad=()=>{throw new Error('invalid_domain_workspace')}
  if(!domainObject(value)||!domainObject(value.context)||value.context.accountId!==expected.accountId||value.context.home!==expected.home||typeof value.revision!=='string'||value.revision.length!==64||!/^[a-f0-9]{64}$/.test(value.revision)||!Array.isArray(value.domains)||!Array.isArray(value.removals)||!domainObject(value.limits)||!domainObject(value.application))return bad()
  if(!['unverified','not_requested','global_configuration_applied'].includes(String(value.application.status))||value.application.targetVerified!==false||[value,domainObject(value.details)?value.details:{}].some(v=>['unknownOutcome','verificationRequired','needsAttention'].some(k=>v[k]===true)))return bad()
  const limit=(v:unknown)=>v==='unlimited'||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
  const limits=value.limits
  if(!['addonDomains','aliasDomains','subdomains'].every(k=>limit(limits[k])))return bad()
  const ids=new Set<string>(),names=new Set<string>()
  for(const raw of value.domains){
    if(!domainObject(raw)||!domainSafeText(raw.id,128)||!raw.id||ids.has(raw.id)||raw.accountId!==expected.accountId||!domainSafeText(raw.name,253)||!raw.name||domainCanonicalName(raw.name)!==raw.name||names.has(raw.name)||!['primary','addon','subdomain','alias'].includes(String(raw.kind))||!(raw.parentId===null||domainSafeText(raw.parentId,128)&&!!raw.parentId)||!domainSafeText(raw.docRoot)||!['php','static','proxy','node','python'].includes(String(raw.siteType))||!(raw.upstream===null||domainSafeText(raw.upstream))||!(raw.redirect===null||domainObject(raw.redirect)&&domainSafeText(raw.redirect.to)&&typeof raw.redirect.code==='number'&&[301,302].includes(raw.redirect.code))||!domainPhpSettings(raw.php)||typeof raw.wildcard!=='boolean'||typeof raw.suspended!=='boolean'||!(raw.certificateId===null||domainSafeText(raw.certificateId,128)&&!!raw.certificateId)||!(raw.expiresAt===null||domainSafeText(raw.expiresAt,128))||!limit(raw.pathQuotaMb)||!['ipv4','ipv6'].every(k=>raw[k]===undefined||raw[k]===null||domainSafeText(raw[k],128))||!(raw.proxy===undefined||raw.siteType==='proxy'&&domainObject(raw.proxy)&&typeof raw.proxy.websocket==='boolean'&&['client','upstream'].includes(String(raw.proxy.hostHeader))&&Array.isArray(raw.proxy.headers)&&raw.proxy.headers.length<=8&&raw.proxy.headers.every(h=>domainObject(h)&&domainSafeText(h.name,64)&&domainSafeText(h.value,256))))return bad()
    domainRoot(expected.home,raw.docRoot);ids.add(raw.id);names.add(raw.name)
  }
  const rows=value.domains as unknown as DomainWorkspaceRow[]
  if(rows.filter(r=>r.kind==='primary').length>1)return bad()
  for(const row of rows){
    if(['primary','addon'].includes(row.kind)&&row.parentId!==null)return bad()
    if(row.kind==='alias'||row.kind==='subdomain'){
      const parent=rows.find(r=>r.id===row.parentId);if(!parent||parent.kind==='alias'||parent.id===row.id)return bad()
      if(row.kind==='alias'&&(row.docRoot!==parent.docRoot||row.siteType!==parent.siteType||row.upstream!==parent.upstream||domainStable(row.php)!==domainStable(parent.php)||domainStable(row.redirect)!==domainStable(parent.redirect)))return bad()
    }
    const seen=new Set<string>();let current:DomainWorkspaceRow|undefined=row
    while(current?.parentId){if(seen.has(current.id))return bad();seen.add(current.id);current=rows.find(r=>r.id===current!.parentId)}
  }
  const removalIds=new Set<string>()
  for(const raw of value.removals){if(!domainObject(raw)||typeof raw.domainId!=='string'||!ids.has(raw.domainId)||removalIds.has(raw.domainId)||typeof raw.canRemove!=='boolean'||!['childCount','serviceUserCount'].every(k=>typeof raw[k]==='number'&&Number.isSafeInteger(raw[k])&&Number(raw[k])>=0))return bad();const row=rows.find(r=>r.id===raw.domainId)!;if(raw.childCount!==rows.filter(r=>r.parentId===row.id).length||raw.canRemove&&(row.kind==='primary'||Number(raw.childCount)>0||Number(raw.serviceUserCount)>0))return bad();removalIds.add(raw.domainId)}
  if(removalIds.size!==ids.size)return bad()
  return JSON.parse(JSON.stringify({context:value.context,revision:value.revision,domains:value.domains,limits:value.limits,removals:value.removals,application:value.application})) as DomainWorkspaceView
}
export async function requestDomainWorkspace(transport:(method:string,path:string,body?:unknown)=>Promise<unknown>,admitted:()=>boolean,method:string,path:string,body?:unknown):Promise<unknown>{if(method!=='GET'&&!admitted())throw {details:{stateChanged:false}};return transport(method,path,body)}
export function createDomainWorkspace(options:{accountId:string;home:string;request:(method:string,path:string,body?:unknown)=>Promise<unknown>;changed?:(state:DomainWorkspaceState)=>void}) {
  const blank=():DomainCreateDraft=>({name:'',kind:'addon',parentId:'',docRoot:'',siteType:'php'})
  const state:DomainWorkspaceState={view:null,observed:null,draft:blank(),selected:null,rootDraft:'',mode:'create',dirty:false,busy:false,reading:false,uncertain:false,status:'unread',application:null}
  let generation=0,editGeneration=0
  const publish=()=>options.changed?.({...state}),status=(s:DomainWorkspaceState['status'])=>{state.status=s;publish()}
  const read=async()=>readDomainWorkspace(await options.request('GET','/api/domains'),options)
  const install=(view:DomainWorkspaceView)=>{state.view=view;state.observed=view;state.draft=blank();state.selected=null;state.rootDraft='';state.mode='create';state.dirty=false;state.uncertain=false;editGeneration++}
  const locked=()=>state.busy||state.uncertain
  const identity=(view:DomainWorkspaceView)=>domainStable({domains:view.domains.slice().sort((a,b)=>a.id.localeCompare(b.id)),limits:view.limits,removals:view.removals.slice().sort((a,b)=>a.domainId.localeCompare(b.domainId))})
  const confirmDiscard=async(confirm:()=>Promise<unknown>)=>!state.dirty||await confirm()===true
  async function mutate(method:string,path:string,body:Record<string,unknown>,verify:(accepted:Record<string,unknown>,view:DomainWorkspaceView,before:DomainWorkspaceView)=>boolean){
    if(locked()||state.reading||!state.view)return
    const baseline=state.view,token=++generation;let dispatched=false;state.busy=true;status('saving')
    try{
      const fresh=await read();if(token!==generation)return;state.observed=fresh
      if(fresh.revision!==baseline.revision||identity(fresh)!==identity(baseline)){status('stale');return}
      dispatched=true;const raw=await options.request(method,path,{...body,expectedRevision:baseline.revision})
      const accepted=readDomainWorkspace(raw,options)
      if(!domainObject(raw)||raw.stateChanged!==true||!verify(raw,accepted,baseline))throw new Error('invalid_domain_acknowledgement')
      const observed=await read();if(token!==generation)return
      const rows=(view:DomainWorkspaceView)=>view.domains.slice().sort((a,b)=>a.id.localeCompare(b.id))
      if(observed.revision!==accepted.revision||domainStable(rows(observed))!==domainStable(rows(accepted))||domainStable(observed.limits)!==domainStable(accepted.limits)||domainStable(observed.removals.slice().sort((a,b)=>a.domainId.localeCompare(b.domainId)))!==domainStable(accepted.removals.slice().sort((a,b)=>a.domainId.localeCompare(b.domainId))))throw new Error('domain_readback_mismatch')
      install(observed);state.application=accepted.application;status('saved')
    }catch(error){if(token!==generation)return;state.uncertain=dispatched&&domainWriteUncertain(error);status(state.uncertain?'uncertain':'failed')}
    finally{if(token===generation){state.busy=false;publish()}}
  }
  return {
    state,
    editCreate(patch:Partial<DomainCreateDraft>){if(locked()||state.mode==='settings')return;state.mode='create';state.selected=null;state.draft={...state.draft,...patch};state.dirty=state.draft.name!==''||state.draft.kind!=='addon'||state.draft.docRoot!==''||state.draft.siteType!=='php';editGeneration++;publish()},
    editRoot(value:string){if(locked()||!state.selected||state.selected.kind==='alias')return;state.rootDraft=value;state.dirty=value!==state.selected.docRoot;editGeneration++;publish()},
    async refresh(){if(state.busy)return;const token=++generation,editToken=editGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading');try{const view=await read();if(token!==generation)return;state.observed=view;if(!state.uncertain&&!state.dirty&&editToken===editGeneration){const selectedId=state.selected?.id;install(view);if(selectedId){const row=view.domains.find(r=>r.id===selectedId);if(row){state.selected=row;state.rootDraft=row.docRoot;state.mode='settings'}}}status(state.uncertain?'uncertain':state.view&&state.view.revision!==view.revision?'stale':'read')}catch{if(token===generation)status(state.uncertain?'uncertain':'failed')}finally{if(token===generation){state.reading=false;publish()}}},
    async reload(confirm:()=>Promise<unknown>){if(state.busy)return;const token=++generation;state.busy=true;state.reading=false;publish();try{if((state.dirty||state.uncertain)&&await confirm()!==true)return;const view=await read();if(token!==generation)return;install(view);state.application=null;status('read')}catch{if(token===generation)status(state.uncertain?'uncertain':'failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async select(id:string,confirm:()=>Promise<unknown>){if(locked()||state.reading||!state.view)return;const token=++generation;state.busy=true;publish();try{if(!await confirmDiscard(confirm))return;const view=await read();if(token!==generation)return;const row=view.domains.find(r=>r.id===id);if(!row)throw new Error('missing_selected_domain');install(view);state.selected=row;state.rootDraft=row.docRoot;state.mode='settings';status('read')}catch{if(token===generation)status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async cancel(confirm:()=>Promise<unknown>){if(locked())return;const token=++generation;state.busy=true;state.reading=false;publish();try{if(!await confirmDiscard(confirm))return;if(token!==generation)return;state.draft=blank();state.selected=null;state.rootDraft='';state.mode='create';state.dirty=false;editGeneration++;status(state.view&&state.observed&&state.view.revision!==state.observed.revision?'stale':'read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async create(){if(locked()||state.reading||!state.view||!state.dirty)return;const draft={...state.draft},before=state.view;let name:string,root:string|undefined;try{name=domainCanonicalName(draft.name);if(!['addon','subdomain','alias'].includes(draft.kind)||!['php','static'].includes(draft.siteType))throw new Error('invalid_draft');if(draft.kind!=='addon'&&!before.domains.some(r=>r.id===draft.parentId&&r.kind!=='alias'))throw new Error('invalid_parent');if(draft.kind!=='alias'&&draft.docRoot!=='')root=domainRoot(options.home,draft.docRoot)}catch{status('failed');return}
      const body:Record<string,unknown>={name:draft.name,kind:draft.kind};if(draft.kind!=='addon')body.parentId=draft.parentId;if(draft.kind!=='alias'){body.siteType=draft.siteType;if(draft.docRoot!=='')body.docRoot=draft.docRoot}
      await mutate('POST','/api/domains',body,(raw,view,baseline)=>{
        if(!domainObject(raw.domain))return false;const acknowledged=raw.domain;const row=view.domains.find(r=>r.id===acknowledged.id);if(!row||domainStable(row)!==domainStable(acknowledged)||baseline.domains.some(r=>r.id===row.id)||row.name!==name||row.kind!==draft.kind||row.parentId!==(draft.kind==='addon'?null:draft.parentId)||view.domains.length!==baseline.domains.length+1||!baseline.domains.every(old=>view.domains.some(saved=>domainStable(saved)===domainStable(old))))return false
        if(draft.kind==='alias'){const parent=baseline.domains.find(r=>r.id===draft.parentId)!;return row.docRoot===parent.docRoot&&row.siteType===parent.siteType&&domainStable(row.php)===domainStable(parent.php)}
        return row.siteType===draft.siteType&&domainRoot(options.home,row.docRoot)===(root??options.home+'/domains/'+name+'/public_html')
      })
    },
    async saveRoot(){if(locked()||!state.selected||!state.dirty||state.selected.kind==='alias')return;const selected=JSON.parse(JSON.stringify(state.selected)) as DomainWorkspaceRow,rawRoot=state.rootDraft;let root:string;try{root=domainRoot(options.home,rawRoot)}catch{status('failed');return}
      await mutate('PATCH','/api/domains/'+encodeURIComponent(selected.id),{docRoot:rawRoot},(raw,view,baseline)=>{
        const row=view.domains.find(r=>r.id===selected.id);if(!row||!domainObject(raw.domain)||domainStable(row)!==domainStable(raw.domain)||domainStable({...row,docRoot:selected.docRoot})!==domainStable(selected)||domainRoot(options.home,row.docRoot)!==root)return false
        return view.domains.length===baseline.domains.length&&baseline.domains.every(old=>{const expected=old.id===selected.id||old.kind==='alias'&&old.parentId===selected.id?{...old,docRoot:root}:old;return view.domains.some(saved=>domainStable(saved)===domainStable(expected))})
      })
    },
    async remove(id:string,confirm:(row:Readonly<DomainWorkspaceRow>)=>Promise<unknown>){
      if(locked()||state.reading||state.dirty||!state.view)return;const baseline=state.view,row=baseline.domains.find(r=>r.id===id),permission=baseline.removals.find(r=>r.domainId===id);if(!row||row.kind==='primary'||!permission?.canRemove){status('failed');return}
      const selected=JSON.parse(JSON.stringify(row)) as DomainWorkspaceRow,token=++generation;state.busy=true;publish();let approved=false
      try{approved=await confirm(Object.freeze(selected))===selected.name}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}
      if(!approved||token!==generation)return
      await mutate('DELETE','/api/domains/'+encodeURIComponent(selected.id),{confirmName:selected.name},(raw,view,before)=>raw.ok===true&&domainObject(raw.removed)&&raw.removed.id===selected.id&&raw.removed.name===selected.name&&!view.domains.some(r=>r.id===selected.id)&&view.domains.length===before.domains.length-1&&before.domains.filter(r=>r.id!==selected.id).every(r=>view.domains.some(n=>domainStable(n)===domainStable(r))))
    },
  }
}

function bindDomainWorkspace(askDialog:(options:Record<string,unknown>)=>Promise<unknown>){
  const t=(message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-domain-workspace]').forEach(root=>{
    const accountId=root.dataset.domainAccount,home=root.dataset.domainHome;if(!accountId||!home)return
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
    const blocked=()=>!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'),admitted=()=>root.dataset.domainManage==='true'&&!blocked()
    const form=root.querySelector<HTMLFormElement>('[data-domain-create]')!,settings=root.querySelector<HTMLFormElement>('[data-domain-settings-form]')!,status=root.querySelector<HTMLElement>('[data-domain-status]')!
    const createControl=(name:string)=>form?.querySelector<HTMLInputElement|HTMLSelectElement>('[name="'+name+'"]')
    const discard=()=>askDialog({title:t('Discard this draft?'),body:t('The saved configuration will be read again. No previous mutation is retried.'),confirm:t('Discard and continue'),danger:true})
    const button=(name:string)=>root.querySelector<HTMLButtonElement>('[data-domain-'+name+']')
    const fact=(list:HTMLElement,label:string,value:string)=>{const wrapper=document.createElement('div');wrapper.className='xp-extension__fact';const title=document.createElement('dt'),body=document.createElement('dd'),technical=document.createElement('bdi');title.textContent=label;technical.dir='ltr';technical.textContent=value;body.append(technical);wrapper.append(title,body);list.append(wrapper)}
    const messages:Record<DomainWorkspaceState['status'],string>={unread:t(msgctxt('domain-workspace-client', 'Saved configuration has not been read.')),reading:t(msgctxt('domain-workspace-client', 'Reading saved configuration…')),read:t('Saved configuration read. Native serving remains unverified.'),stale:t('Saved configuration changed. Your draft is preserved; explicitly reload before saving.'),saving:t('Saving and checking configuration…'),saved:t('Configuration saved and read back. Serving, DNS and TLS remain unverified.'),failed:t('The request could not complete. Your draft is preserved.'),uncertain:t('The outcome requires review. Your draft is preserved. Explicitly reload saved configuration before another mutation.')}
    let painted=''
    const workspace=createDomainWorkspace({accountId,home,request:async(method,path,body)=>{if(!transport)throw new Error('session_request_unavailable');return requestDomainWorkspace(transport,admitted,method,path,body)},changed(state){
      status.dataset.state=state.status;status.textContent=messages[state.status];root.setAttribute('aria-busy',String(state.busy||state.reading))
      const view=state.observed,disabled=state.busy||state.uncertain||!state.view||!admitted()
      if(button('refresh'))button('refresh')!.disabled=state.busy||blocked()
      if(button('reload'))button('reload')!.disabled=state.busy||blocked()||!state.view&&!state.uncertain
      form?.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('[name],button').forEach(c=>{c.disabled=disabled||state.mode==='settings'})
      if(button('create-submit'))button('create-submit')!.disabled=disabled||state.reading||!state.dirty||state.mode!=='create'
      if(button('create-cancel'))button('create-cancel')!.disabled=disabled||!state.dirty
      if(form){for(const key of ['name','kind','parentId','docRoot','siteType'] as const){const c=createControl(key);if(c&&c.value!==state.draft[key])c.value=state.draft[key]}}
      const parent=view?.domains.find(r=>r.id===state.draft.parentId),alias=state.draft.kind==='alias'
      root.querySelector<HTMLElement>('[data-domain-parent-field]')!.hidden=state.draft.kind==='addon'
      root.querySelector<HTMLElement>('[data-domain-alias-help]')!.hidden=!alias
      root.querySelector<HTMLElement>('[data-domain-root-help]')!.hidden=alias
      if(alias){const c=createControl('docRoot');if(c){c.value=parent?.docRoot??'';c.disabled=true}const site=createControl('siteType');if(site){site.value=parent?.siteType??'php';site.disabled=true}}
      const php=root.querySelector<HTMLInputElement>('[data-domain-php]');if(php){php.value=(alias?parent:view?.domains.find(r=>r.kind==='primary'))?.php.version??t(msgctxt('domain-workspace-client', 'Not read'));php.disabled=true}
      if(view){
        const key=domainStable(view);if(key!==painted){painted=key;const list=root.querySelector<HTMLElement>('[data-domain-rows]')!;list.textContent='';
          for(const row of view.domains){const tr=document.createElement('tr');tr.dataset.domainId=row.id;const cell=(value:string,technical=false)=>{const td=document.createElement('td');if(technical){const bdi=document.createElement('bdi');bdi.dir='ltr';bdi.className='xp-mono';bdi.textContent=value;td.append(bdi)}else td.textContent=value;tr.append(td);return td};cell(row.name,true);cell(row.kind==='primary'?t('Primary'):row.kind==='addon'?t('Addon'):row.kind==='alias'?t('Alias'):t(msgctxt('domain-workspace-client', 'Subdomain')));cell(row.docRoot,true);
            const wc=cell(''),label=document.createElement('label'),check=document.createElement('input');label.className='xp-domain-check';check.type='checkbox';check.disabled=true;check.checked=row.wildcard;check.setAttribute('aria-label',t('Saved wildcard binding'));label.append(check,document.createTextNode(t('Configured')));wc.append(label)
            const ssl=cell(row.certificateId?t('Certificate configured; coverage unverified'):t('No certificate configured'));ssl.dataset.domainCertificate='unverified';cell(domainPhpLabel(row),row.siteType==='php');cell(row.siteType,true)
            const action=cell(''),open=document.createElement('button');open.type='button';open.className='xp-btn';open.dataset.domainSettings=row.id;open.textContent=t('Settings');action.append(open)
            const more=document.createElement('details'),summary=document.createElement('summary'),remove=document.createElement('button');summary.textContent=t('More');remove.type='button';remove.className='xp-btn';remove.dataset.domainRemove=row.id;remove.textContent=t('Remove saved domain');more.append(summary,remove);action.append(more)
            const removal=view.removals.find(r=>r.domainId===row.id)!;if(!removal.canRemove){const reason=document.createElement('p');reason.textContent=row.kind==='primary'?t('Primary lifecycle only'):t('Dependent records: {count}',{count:removal.childCount+removal.serviceUserCount});action.append(reason)}list.append(tr)
          }
          if(!view.domains.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.textContent=t('No saved domains were returned.');tr.append(td);list.append(tr)}
          const parents=createControl('parentId') as HTMLSelectElement|null;if(parents){parents.textContent='';const empty=document.createElement('option');empty.value='';empty.textContent=t('Choose a parent domain');parents.append(empty);for(const row of view.domains.filter(r=>r.kind!=='alias')){const option=document.createElement('option');option.value=row.id;option.textContent=row.name;parents.append(option)}parents.value=state.draft.parentId}
          const limits=root.querySelector<HTMLElement>('[data-domain-limits]')!;limits.textContent='';for(const [kind,key,label]of [['addon','addonDomains',t('Addon domains')],['alias','aliasDomains',t('Aliases')],['subdomain','subdomains',t('Subdomains')]] as const){const cap=view.limits[key];fact(limits,label,String(view.domains.filter(r=>r.kind===kind).length)+' / '+(cap==='unlimited'?t('Unlimited'):String(cap)))}
          const primary=root.querySelector<HTMLInputElement>('[data-domain-primary-name]');if(primary)primary.value=view.domains.find(r=>r.kind==='primary')?.name??t(msgctxt('domain-workspace-client', 'Not read'))
        }
        root.querySelector<HTMLElement>('[data-domain-count]')!.textContent=t('{count} saved names',{count:view.domains.length})
      }
      root.querySelectorAll<HTMLButtonElement>('[data-domain-settings]').forEach(c=>{c.disabled=blocked()||state.busy||state.uncertain||state.reading})
      root.querySelectorAll<HTMLButtonElement>('[data-domain-remove]').forEach(c=>{c.disabled=disabled||state.reading||state.dirty||!view?.removals.find(r=>r.domainId===c.dataset.domainRemove)?.canRemove})
      const panel=root.querySelector<HTMLElement>('[data-domain-settings-panel]')!;panel.hidden=state.mode!=='settings'||!state.selected
      if(state.selected){root.querySelector<HTMLElement>('[data-domain-selected-name]')!.textContent=state.selected.name;const c=settings.querySelector<HTMLInputElement>('[name=docRoot]')!;if(c.value!==state.rootDraft)c.value=state.rootDraft;c.disabled=disabled||state.selected.kind==='alias'}
      if(button('save-root'))button('save-root')!.disabled=disabled||state.reading||!state.dirty||state.selected?.kind==='alias'
      if(button('cancel-edit'))button('cancel-edit')!.disabled=state.busy||state.uncertain
      const review=root.querySelector<HTMLElement>('[data-domain-create-review]');if(review){review.textContent='';fact(review,t('Kind'),state.draft.kind);fact(review,t('Name'),state.draft.name||t('Not entered'));fact(review,t('Document root'),alias?parent?.docRoot??t('Select a parent'):state.draft.docRoot||t('Server default inside account home'));fact(review,t('Runtime'),alias?parent?.siteType??t('Select a parent'):state.draft.siteType)}
      const application=state.application??view?.application;root.querySelector<HTMLElement>('[data-domain-application]')!.textContent=application?.status==='global_configuration_applied'?t('A global configuration receipt was returned. This domain’s serving, DNS and TLS remain unverified.'):application?.status==='not_requested'?t('Native application was not requested. Serving, DNS and TLS remain unverified.'):t('Native serving, DNS and TLS have not been verified.')
    }})
    form?.addEventListener('input',event=>{if(!admitted()||!(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement))return;const key=event.target.name;if(['name','kind','parentId','docRoot','siteType'].includes(key))workspace.editCreate({[key]:event.target.value})})
    form?.addEventListener('change',event=>{if(!admitted()||!(event.target instanceof HTMLSelectElement))return;const key=event.target.name;if(['kind','parentId','siteType'].includes(key))workspace.editCreate({[key]:event.target.value})})
    form?.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.create()})
    settings?.querySelector<HTMLInputElement>('[name=docRoot]')?.addEventListener('input',event=>{if(admitted())workspace.editRoot((event.target as HTMLInputElement).value)})
    settings?.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.saveRoot()})
    button('refresh')?.addEventListener('click',()=>{if(!blocked())void workspace.refresh()});button('reload')?.addEventListener('click',()=>{if(!blocked())void workspace.reload(discard)})
    for(const key of ['create-cancel','cancel-edit'])button(key)?.addEventListener('click',()=>{if(!blocked())void workspace.cancel(discard)})
    root.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-domain-settings],[data-domain-remove]'):null;if(!target||target.disabled||blocked())return;if(target.dataset.domainSettings)void workspace.select(target.dataset.domainSettings,discard);else if(target.dataset.domainRemove&&admitted())void workspace.remove(target.dataset.domainRemove,row=>askDialog({title:t('Remove saved domain'),body:row.name,label:t('Type the domain name to confirm'),input:true,value:'',preserveWhitespace:true,confirm:t('Remove saved domain'),danger:true}))})
    window.addEventListener('beforeunload',event=>{if(workspace.state.dirty||workspace.state.uncertain){event.preventDefault();event.returnValue=''}})
    if(button('refresh'))button('refresh')!.disabled=blocked();if(!blocked())void workspace.refresh()
  })
}
export const DOMAIN_WORKSPACE_CLIENT_BINDING=`(()=>{const domainObject=${domainObject.toString()};const domainSafeText=${domainSafeText.toString()};const domainCanonicalName=${domainCanonicalName.toString()};const domainRoot=${domainRoot.toString()};const domainStable=${domainStable.toString()};const domainWriteUncertain=${domainWriteUncertain.toString()};const domainPhpSettings=${domainPhpSettings.toString()};const domainPhpLabel=${domainPhpLabel.toString()};const readDomainWorkspace=${readDomainWorkspace.toString()};const requestDomainWorkspace=${requestDomainWorkspace.toString()};const createDomainWorkspace=${createDomainWorkspace.toString()};return ${bindDomainWorkspace.toString()};})()`
