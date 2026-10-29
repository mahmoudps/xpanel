import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />

export interface ContactSnapshot { accountId:string;contactEmail:string;revision:string }
export type ContactStatus='unread'|'reading'|'read'|'stale'|'saving'|'saved'|'failed'|'uncertain'
export interface ContactWorkspaceState { baseline:ContactSnapshot|null;observed:ContactSnapshot|null;draft:string;dirty:boolean;busy:boolean;reading:boolean;uncertain:boolean;status:ContactStatus;message:string }

/** This is a receipt comparison, not a replacement for the server's domain validator. */
export function canonicalContactEmail(raw:string):string {
  if(typeof raw!=='string'||raw.length>254||/[\s\u0000-\u001f\u007f-\u009f]/u.test(raw))throw new Error('invalid_contact_email')
  const at=raw.lastIndexOf('@'),local=raw.slice(0,at),domain=raw.slice(at+1)
  if(at<1||! /^[A-Za-z0-9._%+-]{1,64}$/.test(local)||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain||/[\/@:#?%\[\]\\]/u.test(domain))throw new Error('invalid_contact_email')
  const host=new URL('http://'+domain.normalize('NFC')+'/').hostname.toLowerCase().replace(/\.$/,'')
  if(!host)throw new Error('invalid_contact_email')
  return local+'@'+host
}

export function readContactSnapshot(value:unknown,accountId:string,write=false):ContactSnapshot {
  const v=value as Record<string,unknown>|null
  const context=v?.context as Record<string,unknown>|undefined,preferences=v?.preferences as Record<string,unknown>|undefined,details=v?.details as Record<string,unknown>|undefined
  const uncertain=[v,details].some(o=>!!o&&['unknownOutcome','verificationRequired','needsAttention'].some(k=>o[k]===true))
  if(!v||Array.isArray(v)||uncertain||!context||Array.isArray(context)||context.accountId!==accountId||!preferences||Array.isArray(preferences)||typeof preferences.contactEmail!=='string'||preferences.contactEmail.length>254||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(preferences.contactEmail)||typeof v.revision!=='string'||v.revision.length!==64||!/^[a-f0-9]{64}$/.test(v.revision)||(write&&(v.ok!==true||typeof v.stateChanged!=='boolean')))throw new Error('invalid_contact_receipt')
  if(canonicalContactEmail(preferences.contactEmail)!==preferences.contactEmail)throw new Error('invalid_contact_receipt')
  return {accountId,contactEmail:preferences.contactEmail,revision:v.revision}
}

/** Only an explicit unchanged-state receipt makes a dispatched failure safely retryable. */
export function contactWriteUncertain(value:unknown):boolean {
  const v=value as Record<string,unknown>|null,d=v?.details as Record<string,unknown>|undefined
  const flagged=(o:Record<string,unknown>|null|undefined)=>!!o&&['unknownOutcome','verificationRequired','stateChanged','needsAttention'].some(k=>o[k]===true)
  return flagged(v)||flagged(d)||d?.stateChanged!==false
}

/** Recheck admission at dispatch, after any pre-read awaited by the controller. */
export async function requestContactPreferences(transport:(method:string,path:string,body?:unknown)=>Promise<unknown>,canManage:()=>boolean,method:'GET'|'PATCH',body?:unknown):Promise<unknown> {
  if(method==='PATCH'&&!canManage())throw {details:{stateChanged:false}}
  return transport(method,'/api/account/preferences',body)
}

export function createAccountContactWorkspace(options:{accountId:string;request:(method:'GET'|'PATCH',body?:unknown)=>Promise<unknown>;changed?:(state:ContactWorkspaceState)=>void}) {
  const state:ContactWorkspaceState={baseline:null,observed:null,draft:'',dirty:false,busy:false,reading:false,uncertain:false,status:'unread',message:''}
  let generation=0,editGeneration=0
  const publish=()=>options.changed?.({...state})
  const status=(s:ContactStatus,message='')=>{state.status=s;state.message=message;publish()}
  const snapshot=async()=>readContactSnapshot(await options.request('GET'),options.accountId)
  const install=(value:ContactSnapshot)=>{state.baseline=value;state.observed=value;state.draft=value.contactEmail;state.dirty=false;state.uncertain=false;editGeneration++}
  return {
    state,
    edit(value:string){if(state.busy||state.uncertain)return;state.draft=value;state.dirty=!state.baseline||value!==state.baseline.contactEmail;editGeneration++;publish()},
    async refresh(){
      if(state.busy)return
      const token=++generation,editToken=editGeneration
      state.reading=true;status(state.uncertain?'uncertain':'reading')
      try{
        const value=await snapshot();if(token!==generation)return
        state.observed=value
        if(!state.uncertain&&!state.dirty&&editToken===editGeneration)install(value)
        status(state.uncertain?'uncertain':state.baseline&&state.baseline.revision!==value.revision?'stale':'read')
      }catch{if(token===generation)status(state.uncertain?'uncertain':'failed','read_failed')}
      finally{if(token===generation){state.reading=false;publish()}}
    },
    async reload(confirm:()=>Promise<unknown>){
      if(state.busy)return
      const token=++generation;state.busy=true;state.reading=false;publish()
      try{
        if((state.dirty||state.uncertain)&&await confirm()!==true)return
        if(token!==generation)return
        status('reading');const value=await snapshot();if(token!==generation)return
        install(value);status('read')
      }catch{if(token===generation)status(state.uncertain?'uncertain':'failed','read_failed')}
      finally{if(token===generation){state.busy=false;publish()}}
    },
    async save(){
      if(state.busy||state.reading||state.uncertain||!state.baseline||!state.dirty)return
      const baseline={...state.baseline},raw=state.draft,token=++generation
      let intended:string
      try{intended=canonicalContactEmail(raw)}catch{status('failed','invalid_email');return}
      let dispatched=false;state.busy=true;status('saving')
      try{
        const fresh=await snapshot();if(token!==generation)return
        state.observed=fresh
        if(fresh.revision!==baseline.revision||fresh.contactEmail!==baseline.contactEmail){status('stale','changed_elsewhere');return}
        dispatched=true
        const accepted=readContactSnapshot(await options.request('PATCH',{contactEmail:raw,expectedRevision:baseline.revision}),options.accountId,true)
        if(accepted.contactEmail!==intended)throw new Error('acknowledgement_mismatch')
        const observed=await snapshot();if(token!==generation)return
        if(observed.revision!==accepted.revision||observed.contactEmail!==accepted.contactEmail)throw new Error('readback_mismatch')
        install(observed);status('saved')
      }catch(error){
        if(token!==generation)return
        state.uncertain=dispatched&&contactWriteUncertain(error)
        status(state.uncertain?'uncertain':'failed',dispatched?'save_failed':'read_failed')
      }finally{if(token===generation){state.busy=false;publish()}}
    },
  }
}

function bindAccountContact(askDialog:(options:Record<string,unknown>)=>Promise<unknown>,rtl:boolean) {
  const t=(message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-contact]').forEach(root=>{
    const accountId=root.dataset.contactAccount;if(!accountId)return
    const input=root.querySelector<HTMLInputElement>('[name=contactEmail]'),form=root.querySelector<HTMLFormElement>('[data-contact-form]'),status=root.querySelector<HTMLElement>('[data-contact-status]'),saved=root.querySelector<HTMLElement>('[data-contact-saved]')
    const refresh=root.querySelector<HTMLButtonElement>('[data-contact-refresh]'),reload=root.querySelector<HTMLButtonElement>('[data-contact-reload]'),save=root.querySelector<HTMLButtonElement>('[data-contact-save]')
    const request=(window as Window & {xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
    const blocked=()=>!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const canManage=()=>root.dataset.contactManage==='true'&&!blocked()
    const messages:Record<ContactStatus,string>={unread:t('Saved contact details have not been read.'),reading:t('Reading saved contact details…'),read:t('Saved contact details read.'),stale:t('Saved details changed. Your draft is preserved. Reload explicitly before saving.'),saving:t('Saving contact email…'),saved:t('Contact email saved and read back.'),failed:t('Could not complete the request. Your draft is preserved.'),uncertain:t('The save outcome is unknown. Your draft is preserved. Reload saved details to review before another save.')}
    const workspace=createAccountContactWorkspace({accountId,async request(method,body){
      if(!request)throw new Error('session_request_unavailable')
      return requestContactPreferences(request,canManage,method,body)
    },changed(state){
      if(saved){saved.textContent=state.observed?(state.observed.contactEmail||t('Not set')):t(msgctxt('account-contact-client', 'Not read'));saved.dir=state.observed?.contactEmail?'ltr':document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';saved.style.unicodeBidi='isolate';saved.style.textAlign=rtl?'right':'left'}
      if(input){if(input.value!==state.draft)input.value=state.draft;input.disabled=!canManage()||state.busy||state.uncertain||!state.baseline}
      if(refresh)refresh.disabled=blocked()||state.busy
      if(reload)reload.disabled=!canManage()||state.busy
      if(save)save.disabled=!canManage()||state.busy||state.reading||state.uncertain||!state.baseline||!state.dirty
      if(status){status.dataset.state=state.status;status.textContent=state.message==='invalid_email'?t('Enter a valid contact email without surrounding spaces.'):messages[state.status]}
    }})
    input?.addEventListener('input',()=>{if(canManage())workspace.edit(input.value)})
    form?.addEventListener('submit',event=>{event.preventDefault();if(canManage())void workspace.save()})
    refresh?.addEventListener('click',()=>{if(!blocked())void workspace.refresh()})
    reload?.addEventListener('click',()=>{if(canManage())void workspace.reload(()=>askDialog({title:t('Reload saved contact details?'),body:t('Discard this draft and read the saved contact email? This does not retry a previous save.'),confirm:t('Discard and reload'),danger:true}))})
    window.addEventListener('beforeunload',event=>{if(workspace.state.dirty||workspace.state.uncertain){event.preventDefault();event.returnValue=''}})
    if(refresh)refresh.disabled=blocked()
    if(!blocked())void workspace.refresh()
  })
}

export const ACCOUNT_CONTACT_CLIENT_BINDING=`(()=>{const canonicalContactEmail=${canonicalContactEmail.toString()};const readContactSnapshot=${readContactSnapshot.toString()};const contactWriteUncertain=${contactWriteUncertain.toString()};const requestContactPreferences=${requestContactPreferences.toString()};const createAccountContactWorkspace=${createAccountContactWorkspace.toString()};return ${bindAccountContact.toString()};})()`
