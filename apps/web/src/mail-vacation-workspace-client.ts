import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'

const formatMailDateTime = formatDisplayDateTime

export interface MailVacationFields {enabled:boolean;subject:string;body:string;htmlBody:string;startDate:string|null;endDate:string|null;replyIntervalHours:number}
export interface MailVacationConfig extends MailVacationFields {mailbox:string;compiledSieve:string;updatedAt:string}
export interface MailVacationSnapshot {mailbox:string;vacation:MailVacationConfig|null;revision:string;application:{state:'applied'|'pending'|'failed';reason:string|null}}
export interface MailVacationDraft {enabled:boolean;subject:string;body:string;htmlBody:string;startDate:string;endDate:string;replyIntervalHours:string}
export interface MailVacationState {loaded:boolean;snapshot:MailVacationSnapshot|null;draft:MailVacationDraft;dirty:boolean;busy:boolean;reading:boolean;conflict:boolean;uncertain:boolean;status:'unread'|'reading'|'read'|'saving'|'saved'|'failed'|'stale'|'uncertain'}
export function vacationObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function vacationStable(value:unknown):string {if(Array.isArray(value))return '['+value.map(vacationStable).join(',')+']';if(vacationObject(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+vacationStable(value[key])).join(',')+'}';return JSON.stringify(value)??'undefined'}
export function vacationReviewFlags(value:unknown):boolean {if(!vacationObject(value))return false;return [value,vacationObject(value.details)?value.details:{}].some(part=>['unknownOutcome','verificationRequired','needsAttention'].some(key=>part[key]===true))}
export function vacationWriteUncertain(error:unknown):boolean {return vacationReviewFlags(error)||!vacationObject(error)||error.stateChanged===true||!vacationObject(error.details)||error.details.stateChanged!==false}
export function vacationUtc(value:unknown):string|null {if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('invalid_whole_second_utc');return value}
export function vacationPickerValue(value:string):string {return value.endsWith('Z')?value.slice(0,-1):value}
/** UTC conversion retains fractional milliseconds; validation refuses them, never rounds. */
export function vacationFromPicker(value:string):string {if(!value)return '';const date=new Date(value+'Z');return Number.isFinite(date.getTime())?date.toISOString():value}
export function vacationFields(value:unknown):MailVacationFields {
  if(!vacationObject(value)||typeof value.enabled!=='boolean'||typeof value.subject!=='string'||!value.subject.isWellFormed()||value.subject.trim().length>256||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.subject)||typeof value.body!=='string'||typeof value.htmlBody!=='string'||!value.body.isWellFormed()||!value.htmlBody.isWellFormed()||new TextEncoder().encode(value.body).length>65536||new TextEncoder().encode(value.htmlBody).length>65536||!Number.isSafeInteger(value.replyIntervalHours)||Number(value.replyIntervalHours)<1||Number(value.replyIntervalHours)>8760)throw new Error('invalid_vacation_fields')
  const startDate=vacationUtc(value.startDate),endDate=vacationUtc(value.endDate);if(startDate&&endDate&&Date.parse(endDate)<=Date.parse(startDate))throw new Error('invalid_vacation_order')
  return {enabled:value.enabled,subject:value.subject,body:value.body,htmlBody:value.htmlBody,startDate,endDate,replyIntervalHours:value.replyIntervalHours as number}
}
export function vacationDraftFields(draft:MailVacationDraft):MailVacationFields {if(!/^\d+$/.test(draft.replyIntervalHours))throw new Error('invalid_reply_interval');return vacationFields({...draft,startDate:draft.startDate||null,endDate:draft.endDate||null,replyIntervalHours:Number(draft.replyIntervalHours)})}
export function readMailVacation(value:unknown,mailbox:string):MailVacationSnapshot {
  if(!vacationObject(value)||!vacationObject(value.context)||value.context.mailbox!==mailbox||typeof value.revision!=='string'||value.revision.length!==64||!/^[0-9a-f]{64}$/.test(value.revision)||vacationReviewFlags(value)||!vacationObject(value.application)||!['applied','pending','failed'].includes(String(value.application.state))||!(value.application.reason===null||typeof value.application.reason==='string'))throw new Error('invalid_vacation_context')
  let vacation:MailVacationConfig|null=null
  if(value.vacation!==null){const raw=value.vacation;if(!vacationObject(raw)||raw.mailbox!==mailbox||typeof raw.compiledSieve!=='string'||typeof raw.updatedAt!=='string'||!Number.isFinite(Date.parse(raw.updatedAt))||new Date(raw.updatedAt).toISOString()!==raw.updatedAt)throw new Error('invalid_vacation_record');const fields=vacationFields(raw);if(fields.subject!==fields.subject.trim())throw new Error('noncanonical_vacation_subject');vacation={...fields,mailbox,compiledSieve:raw.compiledSieve,updatedAt:raw.updatedAt}}
  return {mailbox,vacation,revision:value.revision,application:{state:value.application.state as 'applied'|'pending'|'failed',reason:value.application.reason as string|null}}
}
export async function requestMailVacation(transport:(method:string,path:string,body?:unknown)=>Promise<unknown>,admitted:()=>boolean,method:string,path:string,body?:unknown):Promise<unknown>{if(method!=='GET'&&!admitted())throw {details:{stateChanged:false}};return transport(method,path,body)}
export function createMailVacationWorkspace(options:{mailbox:string;request:(method:string,path:string,body?:unknown)=>Promise<unknown>;changed?:(state:MailVacationState)=>void}) {
  const empty=():MailVacationDraft=>({enabled:false,subject:'',body:'',htmlBody:'',startDate:'',endDate:'',replyIntervalHours:''})
  const clone=(snapshot:MailVacationSnapshot):MailVacationSnapshot=>({...snapshot,vacation:snapshot.vacation?{...snapshot.vacation}:null,application:{...snapshot.application}})
  const toDraft=(snapshot:MailVacationSnapshot):MailVacationDraft=>snapshot.vacation?{enabled:snapshot.vacation.enabled,subject:snapshot.vacation.subject,body:snapshot.vacation.body,htmlBody:snapshot.vacation.htmlBody,startDate:snapshot.vacation.startDate??'',endDate:snapshot.vacation.endDate??'',replyIntervalHours:String(snapshot.vacation.replyIntervalHours)}:empty()
  const state:MailVacationState={loaded:false,snapshot:null,draft:empty(),dirty:false,busy:false,reading:false,conflict:false,uncertain:false,status:'unread'}
  let baseline:MailVacationSnapshot|null=null,generation=0
  const publish=()=>{state.dirty=vacationStable(state.draft)!==vacationStable(baseline?toDraft(baseline):empty());options.changed?.({...state,snapshot:state.snapshot?clone(state.snapshot):null,draft:{...state.draft}})}
  const status=(value:MailVacationState['status'])=>{state.status=value;publish()},locked=()=>state.busy||state.conflict||state.uncertain
  const read=async()=>readMailVacation(await options.request('GET','/api/webmail/vacation'),options.mailbox)
  const adopt=(snapshot:MailVacationSnapshot)=>{state.snapshot=snapshot;state.loaded=true;baseline=clone(snapshot);state.draft=toDraft(snapshot)}
  const changed=(snapshot:MailVacationSnapshot)=>!!baseline&&(snapshot.revision!==baseline.revision||vacationStable(snapshot.vacation)!==vacationStable(baseline.vacation))
  return {state,
    edit(patch:Partial<MailVacationDraft>){if(locked()||!state.loaded)return;for(const key of ['subject','body','htmlBody','startDate','endDate','replyIntervalHours'] as const)if(patch[key]!==undefined)state.draft[key]=patch[key]!;if(patch.enabled!==undefined)state.draft.enabled=patch.enabled;publish()},
    async discard(confirm:()=>Promise<unknown>){if(locked()||!state.loaded)return;const token=++generation;state.busy=true;publish();try{if(state.dirty&&await confirm()!==true)return;if(token!==generation)return;state.draft=baseline?toDraft(baseline):empty();status('read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async refresh(){if(state.busy)return;const token=++generation;state.reading=true;status(state.uncertain?'uncertain':state.conflict?'stale':'reading');try{const snapshot=await read();if(token!==generation)return;if(!state.loaded)adopt(snapshot);else{state.snapshot=snapshot;if(changed(snapshot))state.conflict=true}status(state.uncertain?'uncertain':state.conflict?'stale':'read')}catch{if(token===generation)status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}finally{if(token===generation){state.reading=false;publish()}}},
    async reload(confirm:()=>Promise<unknown>){if(state.busy)return;const token=++generation;state.busy=true;state.reading=false;publish();try{if((state.dirty||state.conflict||state.uncertain)&&await confirm()!==true)return;const snapshot=await read();if(token!==generation)return;adopt(snapshot);state.conflict=false;state.uncertain=false;status('read')}catch{if(token===generation)status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async save(){
      if(locked()||state.reading||!state.loaded||!state.dirty||!baseline)return
      let desired:MailVacationFields;try{desired=vacationDraftFields(state.draft)}catch{status('failed');return}
      const expected={...desired,subject:desired.subject.trim()},captured=clone(baseline),token=++generation;let dispatched=false;state.busy=true;status('saving')
      try{
        const before=await read();if(token!==generation)return;state.snapshot=before
        if(before.revision!==captured.revision||vacationStable(before.vacation)!==vacationStable(captured.vacation)){state.conflict=true;status('stale');return}
        dispatched=true
        const raw=await options.request('PUT','/api/webmail/vacation',{...desired,expectedRevision:captured.revision})
        if(!vacationObject(raw)||raw.stateChanged!==true)throw new Error('invalid_vacation_acknowledgement')
        const accepted=readMailVacation(raw,options.mailbox)
        if(!accepted.vacation||vacationStable(vacationFields(accepted.vacation))!==vacationStable(expected))throw new Error('vacation_acknowledgement_mismatch')
        const verified=await read();if(token!==generation)return
        if(vacationStable(verified)!==vacationStable(accepted))throw new Error('vacation_readback_mismatch')
        adopt(verified);state.conflict=false;state.uncertain=false;status('saved')
      }catch(error){if(token!==generation)return;state.uncertain=dispatched&&vacationWriteUncertain(error);if(!state.uncertain&&vacationObject(error)&&error.status===409)state.conflict=true;status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}
      finally{if(token===generation){state.busy=false;publish()}}
    },
  }
}
function bindMailVacationWorkspace(askDialog:(options:Record<string,unknown>)=>Promise<unknown>){
  const t=(message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-vacation]').forEach(root=>{
    const mailbox=root.dataset.vacationMailbox;if(!mailbox)return
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
    const blocked=()=>!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'),admitted=()=>root.dataset.vacationManage==='true'&&!blocked()
    const compact=root.dataset.vacationCompact==='true',form=root.querySelector<HTMLElement>('[data-vacation-form]')!,button=(key:string)=>root.querySelector<HTMLButtonElement>('[data-vacation-'+key+']')!,panel=root.querySelector<HTMLElement>('[data-vacation-panel]')!
    const toggle=(open:boolean)=>{panel.hidden=!open;button('open').hidden=open||!compact;button('open').setAttribute('aria-expanded',String(open));if(!open&&compact)button('open').focus()}
    const discard=()=>askDialog({title:t('Discard responder draft?'),body:t('Unsaved responder fields will be discarded. No previous write is retried.'),confirm:t('Discard and continue'),danger:true})
    const messages:Record<MailVacationState['status'],string>={unread:t('Responder configuration has not been read.'),reading:t('Reading saved responder configuration…'),read:t('Saved configuration read.'),saving:t('Saving requested configuration and verifying readback…'),saved:t('Saved and read back.'),failed:t('The request could not complete. Check whole UTC seconds, schedule order and the 1 to 8760 hour interval. Your draft is preserved.'),stale:t('Saved configuration changed. Refresh preserves this draft and lock; explicitly discard and reload before another save.'),uncertain:t('The write outcome requires review. Do not retry. Refresh keeps this lock; explicitly reload to continue.')}
    let savedRevision=''
    const workspace=createMailVacationWorkspace({mailbox,request:(method,path,body)=>{if(!transport)throw new Error('session_transport_unavailable');return requestMailVacation(transport,admitted,method,path,body)},changed(state){
      root.setAttribute('aria-busy',String(state.busy||state.reading));const status=root.querySelector<HTMLElement>('[data-vacation-status]')!;status.dataset.state=state.status;status.textContent=messages[state.status]
      const disabled=state.busy||state.uncertain||state.conflict||!state.loaded||!admitted()
      for(const key of ['subject','body','htmlBody','startDate','endDate','replyIntervalHours'] as const){const input=form.querySelector<HTMLInputElement|HTMLTextAreaElement>('[name='+key+']')!,value=key==='startDate'||key==='endDate'?vacationPickerValue(state.draft[key]):state.draft[key];if(input.value!==value)input.value=value;input.disabled=disabled}
      const enabled=form.querySelector<HTMLInputElement>('[name=enabled]')!;enabled.checked=state.draft.enabled;enabled.disabled=disabled
      button('save').disabled=disabled||state.reading||!state.dirty;button('refresh').disabled=state.busy||blocked();button('reload').disabled=state.busy||blocked()||!state.loaded&&!state.uncertain;button('cancel').disabled=state.busy||state.uncertain||state.conflict||blocked()||!compact&&!state.dirty;button('open').disabled=state.busy||blocked()
      const snapshot=state.snapshot,record=snapshot?.vacation
      const host=!snapshot?'':snapshot.application.state==='applied'?t('applied on the mail server'):snapshot.application.state==='pending'?t('saved, not applied yet'):snapshot.application.reason?t('not applied: {reason}',{reason:snapshot.application.reason}):t('not applied')
      root.querySelector<HTMLElement>('[data-vacation-requested]')!.textContent=!state.loaded?t('Not read'):!record?t('Off; no saved configuration'):record.enabled?t('On · {state}',{state:host}):t('Off · {state}',{state:host})
      const recordLine=root.querySelector<HTMLElement>('[data-vacation-record]')!
      recordLine.textContent=!state.loaded?t('Saved record not read.'):!record?t('No saved responder record. These fields are an unsaved draft; choose an interval before saving.') : ''
      if(state.loaded&&record){
        const address=document.createElement('bdi'),updatedAt=document.createElement('bdi')
        address.dir='ltr';address.className='xp-mono';address.textContent=mailbox
        updatedAt.dir='ltr';updatedAt.className='xp-mono';updatedAt.textContent=formatMailDateTime(record.updatedAt)
        const nodes:Record<string,Node>={'{mailbox}':address,'{time}':updatedAt}
        recordLine.append(...t('Saved responder configuration for {mailbox} · {time}').split(/(\{\w+\})/).filter(Boolean).map(part=>nodes[part]??part))
      }
      // Only a saved Sieve rule is technical source; read states are human text outside the code panel.
      const sieve=state.loaded&&record?record.compiledSieve:null,empty=root.querySelector<HTMLElement>('[data-vacation-preview-empty]')
      root.querySelector<HTMLElement>('[data-vacation-preview]')!.textContent=sieve??''
      root.querySelector<HTMLElement>('[data-vacation-preview]')!.hidden=sieve===null
      if(empty){empty.hidden=sieve!==null;empty.textContent=!state.loaded?t('No responder configuration has been read.'):t('No saved Sieve rule.')}
      if(compact&&state.status==='saved'&&!state.busy&&snapshot&&savedRevision!==snapshot.revision){savedRevision=snapshot.revision;toggle(false)}
    }})
    form.addEventListener('input',event=>{if(!admitted())return;const input=event.target as HTMLInputElement|HTMLTextAreaElement,key=input.name;if(key==='enabled')workspace.edit({enabled:(input as HTMLInputElement).checked});else if(['subject','body','htmlBody','replyIntervalHours'].includes(key))workspace.edit({[key]:input.value});else if(key==='startDate'||key==='endDate')workspace.edit({[key]:vacationFromPicker(input.value)})})
    button('save').addEventListener('click',()=>{if(admitted())void workspace.save()})
    button('open').addEventListener('click',()=>{if(!blocked()&&!workspace.state.busy)toggle(true)})
    button('cancel').addEventListener('click',()=>{if(blocked()||workspace.state.busy)return;if(compact&&!workspace.state.dirty&&!workspace.state.uncertain&&!workspace.state.conflict){toggle(false);return}void workspace.discard(discard).then(()=>{if(compact&&!workspace.state.dirty&&!workspace.state.conflict&&!workspace.state.uncertain)toggle(false)})})
    button('refresh').addEventListener('click',()=>{if(!blocked())void workspace.refresh()});button('reload').addEventListener('click',()=>{if(!blocked())void workspace.reload(discard)})
    window.addEventListener('beforeunload',event=>{if(workspace.state.dirty||workspace.state.uncertain||workspace.state.conflict){event.preventDefault();event.returnValue=''}})
    button('refresh').disabled=blocked();button('open').disabled=blocked();if(!blocked())void workspace.refresh()
  })
}
export const MAIL_VACATION_WORKSPACE_CLIENT_BINDING=`(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const vacationObject=${vacationObject.toString()};const vacationStable=${vacationStable.toString()};const vacationReviewFlags=${vacationReviewFlags.toString()};const vacationWriteUncertain=${vacationWriteUncertain.toString()};const vacationUtc=${vacationUtc.toString()};const vacationPickerValue=${vacationPickerValue.toString()};const vacationFromPicker=${vacationFromPicker.toString()};const vacationFields=${vacationFields.toString()};const vacationDraftFields=${vacationDraftFields.toString()};const readMailVacation=${readMailVacation.toString()};const requestMailVacation=${requestMailVacation.toString()};const createMailVacationWorkspace=${createMailVacationWorkspace.toString()};return ${bindMailVacationWorkspace.toString()};})()`
