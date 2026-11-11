import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
// Module-local alias: the binding source defines it again from ASCII_BYTES_BINDING.
const formatClientBytes = canonicalFormatClientBytes

const formatMailDateTime = formatDisplayDateTime


export interface FolderSummary {
  uid:number;from:string;to:string;subject:string;receivedAt:string;unread:boolean;sizeBytes:number
  uidValidityObserved:boolean;uidValidity?:number;flagged?:boolean
  fromName?:string;cc?:string;preview?:string;attachments?:Array<{name:string;sizeBytes:number}>
}
export interface FolderMessage extends FolderSummary { body:string;hasRemoteImages?:boolean;remoteImages?:Array<{src:string;alt:string}> }
export interface FolderList {mailbox:string;folder:string;complete:true;messages:FolderSummary[];capabilities:{move:boolean;flag?:boolean};total?:number;offset?:number;hasMore?:boolean;nextOffset?:number|null}
export interface FolderMove {ok:true;mailbox:string;from:string;sourceUid:number;sourceUidValidity:number;folder:string;uid:number|null;destinationUidKnown:boolean;stateChanged:boolean;uidValidityObserved:boolean;uidValidity?:number}
export interface FolderFlag {ok:true;mailbox:string;folder:string;uid:number;uidValidity:number;flagged:boolean;stateChanged:boolean}
export type FolderStatus='unread'|'reading'|'read'|'saving'|'saved'|'failed'|'uncertain'
export interface FolderWorkspaceState {
  mailbox:string;folder:string;messages:FolderSummary[];loaded:boolean;canMove:boolean;canFlag:boolean;selectedUid:number|null;message:FolderMessage|null
  total:number|null;hasMore:boolean;nextOffset:number|null
  status:FolderStatus;reason:string;busy:boolean;reading:boolean;uncertain:boolean;undo:{folder:string;uid:number;uidValidity:number;to:string;message:FolderMessage}|null
}

export function canonicalMailFolder(value:unknown):string {
  if(typeof value!=='string')throw new Error('invalid_folder')
  const folder=value.trim()
  if(!/^(?:INBOX|Sent|Drafts|Junk|Trash|Archive|[A-Za-z][A-Za-z0-9._-]{0,40})$/.test(folder))throw new Error('invalid_folder')
  return folder
}
export function mailFolderUid(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw new Error('invalid_uid')
  return value
}
export function mailFolderUidValidity(value:unknown):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>4294967295)throw new Error('invalid_uid_validity')
  return value
}
export function mailFolderObservedUidValidity(message:Pick<FolderSummary,'uidValidityObserved'|'uidValidity'>|null|undefined):number|null {
  return message?.uidValidityObserved===true?mailFolderUidValidity(message.uidValidity):null
}
export function mailFolderObject(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_receipt')
  return value as Record<string,unknown>
}
export function mailFolderFlags(value:unknown):boolean {
  if(!value||typeof value!=='object')return false
  const v=value as Record<string,unknown>,d=v.details as Record<string,unknown>|undefined
  return [v,d].some(o=>!!o&&['unknownOutcome','verificationRequired','needsAttention'].some(k=>o[k]===true))
}
export function readFolderSummary(value:unknown,folder:string,body=false):FolderSummary|FolderMessage {
  const v=mailFolderObject(value),uid=mailFolderUid(v.uid)
  if(v.folder!==undefined&&v.folder!==folder)throw new Error('wrong_folder')
  for(const k of ['from','to','subject','receivedAt'])if(typeof v[k]!=='string')throw new Error('invalid_message')
  if(typeof v.unread!=='boolean'||typeof v.sizeBytes!=='number'||!Number.isFinite(v.sizeBytes)||v.sizeBytes<0)throw new Error('invalid_message')
  if(v.uidValidityObserved!==undefined&&typeof v.uidValidityObserved!=='boolean')throw new Error('invalid_uid_validity')
  const result:FolderSummary={uid,from:v.from as string,to:v.to as string,subject:v.subject as string,receivedAt:v.receivedAt as string,unread:v.unread,sizeBytes:v.sizeBytes,uidValidityObserved:v.uidValidityObserved===true}
  if(result.uidValidityObserved)result.uidValidity=mailFolderUidValidity(v.uidValidity)
  if(v.flagged!==undefined){if(typeof v.flagged!=='boolean')throw new Error('invalid_message');result.flagged=v.flagged}
  for(const k of ['fromName','cc','preview'] as const)if(v[k]!==undefined){if(typeof v[k]!=='string')throw new Error('invalid_message');result[k]=v[k]}
  if(v.attachments!==undefined){
    if(!Array.isArray(v.attachments))throw new Error('invalid_attachments')
    result.attachments=v.attachments.map(item=>{const a=mailFolderObject(item);if(typeof a.name!=='string'||typeof a.sizeBytes!=='number'||!Number.isFinite(a.sizeBytes)||a.sizeBytes<0)throw new Error('invalid_attachment');return {name:a.name,sizeBytes:a.sizeBytes}})
  }
  if(body){
    if(typeof v.body!=='string')throw new Error('invalid_body')
    const full:FolderMessage={...result,body:v.body}
    if(v.hasRemoteImages!==undefined){if(typeof v.hasRemoteImages!=='boolean')throw new Error('invalid_message');full.hasRemoteImages=v.hasRemoteImages}
    if(v.remoteImages!==undefined){
      if(!Array.isArray(v.remoteImages))throw new Error('invalid_remote_images')
      full.remoteImages=v.remoteImages.map(item=>{const img=mailFolderObject(item);if(typeof img.src!=='string'||!/^https?:\/\/[^\s"'<>]+$/i.test(img.src)||typeof img.alt!=='string')throw new Error('invalid_remote_image');return {src:img.src,alt:img.alt}})
    }
    return full
  }
  return result
}
export function readFolderList(value:unknown,mailbox:string,folder:string):FolderList {
  const v=mailFolderObject(value),cap=mailFolderObject(v.capabilities)
  if(mailFolderFlags(v)||v.mailbox!==mailbox||v.folder!==folder||v.complete!==true||!Array.isArray(v.messages)||typeof cap.move!=='boolean'||(cap.flag!==undefined&&typeof cap.flag!=='boolean'))throw new Error('invalid_list')
  const messages=v.messages.map(item=>readFolderSummary(item,folder)),ids=new Set(messages.map(item=>item.uid))
  if(ids.size!==messages.length)throw new Error('duplicate_uid')
  if(new Set(messages.filter(item=>item.uidValidityObserved).map(item=>item.uidValidity)).size>1)throw new Error('inconsistent_uid_validity')
  const out:FolderList={mailbox,folder,complete:true,messages,capabilities:{move:cap.move,...(cap.flag===undefined?{}:{flag:cap.flag})}}
  if(v.total!==undefined){if(typeof v.total!=='number'||!Number.isSafeInteger(v.total)||v.total<0)throw new Error('invalid_list');out.total=v.total}
  if(v.offset!==undefined){if(typeof v.offset!=='number'||!Number.isSafeInteger(v.offset)||v.offset<0)throw new Error('invalid_list');out.offset=v.offset}
  if(v.hasMore!==undefined){if(typeof v.hasMore!=='boolean')throw new Error('invalid_list');out.hasMore=v.hasMore}
  if(v.nextOffset!==undefined){if(v.nextOffset!==null&&(typeof v.nextOffset!=='number'||!Number.isSafeInteger(v.nextOffset)||v.nextOffset<0))throw new Error('invalid_list');out.nextOffset=v.nextOffset}
  return out
}
export function readFolderFlag(value:unknown,mailbox:string,folder:string,uid:number,uidValidity:number,expectedFlagged:boolean):FolderFlag {
  const v=mailFolderObject(value)
  mailFolderUidValidity(uidValidity)
  if(mailFolderFlags(v)||v.ok!==true||v.mailbox!==mailbox||v.folder!==folder||v.uid!==uid||v.uidValidity!==uidValidity||v.flagged!==expectedFlagged||v.stateChanged!==true)throw new Error('invalid_flag')
  return {ok:true,mailbox,folder,uid,uidValidity,flagged:expectedFlagged,stateChanged:true}
}
export function readFolderMessage(value:unknown,mailbox:string,folder:string,uid:number):FolderMessage {
  const v=mailFolderObject(value)
  if(mailFolderFlags(v)||v.mailbox!==mailbox||v.folder!==folder)throw new Error('wrong_context')
  const message=readFolderSummary(v.message,folder,true) as FolderMessage
  if(message.uid!==uid)throw new Error('wrong_uid')
  return message
}
export function readFolderMove(value:unknown,mailbox:string,from:string,sourceUid:number,folder:string,sourceUidValidity:number):FolderMove {
  const v=mailFolderObject(value)
  mailFolderUidValidity(sourceUidValidity)
  if(mailFolderFlags(v)||v.ok!==true||v.mailbox!==mailbox||v.from!==from||v.sourceUid!==sourceUid||v.sourceUidValidity!==sourceUidValidity||v.folder!==folder||typeof v.stateChanged!=='boolean'||typeof v.destinationUidKnown!=='boolean'||typeof v.uidValidityObserved!=='boolean')throw new Error('invalid_move')
  if(from===folder){
    if(v.stateChanged||v.destinationUidKnown||v.uid!==sourceUid||v.uidValidityObserved||v.uidValidity!==undefined)throw new Error('invalid_noop')
    return {ok:true,mailbox,from,sourceUid,sourceUidValidity,folder,uid:sourceUid,destinationUidKnown:false,stateChanged:false,uidValidityObserved:false}
  }
  if(!v.stateChanged)throw new Error('invalid_move')
  if(!v.destinationUidKnown){
    if(v.uid!==null||v.uidValidityObserved||v.uidValidity!==undefined)throw new Error('unknown_uid')
    return {ok:true,mailbox,from,sourceUid,sourceUidValidity,folder,uid:null,destinationUidKnown:false,stateChanged:true,uidValidityObserved:false}
  }
  const uid=mailFolderUid(v.uid)
  if(v.uidValidityObserved!==true)throw new Error('unknown_uid_validity')
  return {ok:true,mailbox,from,sourceUid,sourceUidValidity,folder,uid,destinationUidKnown:true,stateChanged:true,uidValidityObserved:true,uidValidity:mailFolderUidValidity(v.uidValidity)}
}
export function mailFolderWriteUncertain(value:unknown):boolean {
  const v=value as Record<string,unknown>|null,d=v?.details as Record<string,unknown>|undefined
  return mailFolderFlags(value)||v?.stateChanged===true||d?.stateChanged===true||!(v?.stateChanged===false||d?.stateChanged===false)
}
/** Message equality is bounded readback evidence, not IMAP UIDVALIDITY or atomic CAS. */
export function mailFolderFingerprint(message:FolderMessage):string {
  return JSON.stringify([message.from,message.to,message.subject,message.receivedAt,message.cc??'',message.body,message.attachments??[]])
}

export function createMailFolderWorkspace(options:{mailbox:string;folder:string;send:(method:'GET'|'POST',path:string,body?:unknown)=>Promise<unknown>;confirm?:(from:string,to:string)=>Promise<unknown>;changed?:(state:FolderWorkspaceState)=>void}) {
  const mailbox=options.mailbox,folder=canonicalMailFolder(options.folder)
  if(!mailbox)throw new Error('invalid_mailbox')
  const state:FolderWorkspaceState={mailbox,folder,messages:[],loaded:false,canMove:false,canFlag:false,selectedUid:null,message:null,total:null,hasMore:false,nextOffset:null,status:'unread',reason:'',busy:false,reading:false,uncertain:false,undo:null}
  let listGeneration=0,readGeneration=0
  const publish=()=>options.changed?.({...state})
  const status=(next:FolderStatus,reason='')=>{state.status=next;state.reason=reason;publish()}
  const list=async(selected=folder,offset?:number)=>readFolderList(await options.send('GET','/api/webmail/inbox?folder='+encodeURIComponent(selected)+(offset===undefined?'':'&offset='+offset+'&limit=50')),mailbox,selected)
  const read=async(selected:string,uid:number,remoteImages=false)=>readFolderMessage(await options.send('GET','/api/webmail/inbox/'+mailFolderUid(uid)+'?folder='+encodeURIComponent(selected)+(remoteImages?'&remoteImages=1':'')),mailbox,selected,uid)
  const install=(view:FolderList)=>{
    state.messages=view.messages;state.loaded=true;state.canMove=view.capabilities.move;state.canFlag=view.capabilities.flag===true
    state.total=view.total??view.messages.length;state.hasMore=view.hasMore===true;state.nextOffset=view.nextOffset??null
    if(state.selectedUid!==null&&!view.messages.some(m=>m.uid===state.selectedUid)){state.selectedUid=null;state.message=null;readGeneration++}
  }
  const refresh=async(review=false)=>{
    if(state.busy||state.reading)return
    const token=++listGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading')
    try{const view=await list();if(token!==listGeneration)return;install(view);if(review){state.uncertain=false;state.undo=null}status(state.uncertain?'uncertain':'read',review?'reviewed':'')}
    catch{if(token===listGeneration)status(state.uncertain?'uncertain':'failed','read_failed')}
    finally{if(token===listGeneration){state.reading=false;publish()}}
  }
  const loadOlder=async()=>{
    if(state.busy||state.reading||!state.loaded||!state.hasMore||state.nextOffset===null)return
    const token=++listGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading')
    try{
      const view=await list(folder,state.nextOffset)
      if(token!==listGeneration)return
      const seen=new Set(state.messages.map(m=>m.uid))
      const merged=[...state.messages,...view.messages.filter(m=>!seen.has(m.uid))]
      if(new Set(merged.filter(m=>m.uidValidityObserved).map(m=>m.uidValidity)).size>1)throw new Error('inconsistent_uid_validity')
      state.messages=merged;state.total=view.total??merged.length;state.hasMore=view.hasMore===true;state.nextOffset=view.nextOffset??null
      status(state.uncertain?'uncertain':'read')
    }catch{if(token===listGeneration)status(state.uncertain?'uncertain':'failed','read_failed')}
    finally{if(token===listGeneration){state.reading=false;publish()}}
  }
  const toggleFlag=async(uidInput?:number)=>{
    if(state.busy||state.reading||state.uncertain||!state.loaded||!state.canFlag)return
    const uid=uidInput??state.selectedUid
    if(uid===null||uid===undefined)return
    const target=state.message?.uid===uid?state.message:state.messages.find(m=>m.uid===uid)
    if(!target)return
    const uidValidity=mailFolderObservedUidValidity(target)
    if(uidValidity===null){status('failed','identity_unobserved');return}
    const nextFlag=!(target.flagged===true)
    state.busy=true;++listGeneration;++readGeneration
    let dispatched=false,acknowledged=false
    status('saving','flag_saving')
    try{
      dispatched=true
      readFolderFlag(await options.send('POST','/api/webmail/inbox/'+uid+'/flag',{folder,uidValidity,flagged:nextFlag}),mailbox,folder,uid,uidValidity,nextFlag)
      acknowledged=true
      state.messages=state.messages.map(m=>m.uid===uid?{...m,flagged:nextFlag}:m)
      if(state.message?.uid===uid)state.message={...state.message,flagged:nextFlag}
      status('saved','flag_saved')
    }catch(error){
      if(acknowledged||(dispatched&&mailFolderWriteUncertain(error))){state.uncertain=true;state.undo=null;status('uncertain','flag_unverified')}
      else status('failed','flag_failed')
    }finally{state.busy=false;publish()}
  }
  const loadRemoteImages=async()=>{
    if(state.busy||state.reading||!state.message)return
    const uid=state.message.uid
    const token=++readGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading')
    try{
      const message=await read(folder,uid,true)
      if(token!==readGeneration||state.selectedUid!==uid)return
      state.message=message
      status(state.uncertain?'uncertain':'read','images_loaded')
    }catch{if(token===readGeneration)status(state.uncertain?'uncertain':'failed','read_failed')}
    finally{if(token===readGeneration){state.reading=false;publish()}}
  }
  const move=async(toValue:string,undo=false)=>{
    if(state.busy||state.reading||state.uncertain||!state.loaded||!state.canMove)return
    let to:string;try{to=canonicalMailFolder(toValue)}catch{status('failed','invalid_folder');return}
    const previousUndo=state.undo
    const from=undo?previousUndo?.folder:folder,uid=undo?previousUndo?.uid:state.selectedUid
    if(!from||uid===null||uid===undefined)return
    const baseline=undo?previousUndo?.message:state.message
    if(!baseline||baseline.uid!==uid)return
    const uidValidity=mailFolderObservedUidValidity(baseline)
    if(uidValidity===null||(undo&&previousUndo?.uidValidity!==uidValidity)){status('failed','identity_unobserved');return}
    state.busy=true;++listGeneration;++readGeneration
    let dispatched=false,acknowledged=false
    status('saving')
    try{
      if(options.confirm&&await options.confirm(from,to)!==true){status('read');return}
      const source=await read(from,uid)
      if(mailFolderObservedUidValidity(source)!==uidValidity){if(undo)state.undo=null;status('failed','identity_changed');return}
      if(mailFolderFingerprint(source)!==mailFolderFingerprint(baseline)){status('failed','message_changed');return}
      // The transport port rechecks current admission immediately before this POST.
      dispatched=true
      const ack=readFolderMove(await options.send('POST','/api/webmail/inbox/'+uid+'/move',{from,folder:to,uidValidity}),mailbox,from,uid,to,uidValidity)
      if(!ack.stateChanged){status('read');return}
      acknowledged=true
      if(!ack.destinationUidKnown||ack.uid===null||ack.uidValidityObserved!==true||ack.uidValidity===undefined)throw new Error('destination_unknown')
      const destination=await read(to,ack.uid)
      if(mailFolderObservedUidValidity(destination)!==ack.uidValidity)throw new Error('destination_namespace_changed')
      if(mailFolderFingerprint(destination)!==mailFolderFingerprint(source))throw new Error('readback_mismatch')
      const sourceView=await list(from)
      if(sourceView.messages.some(m=>m.uid===uid&&!(m.uidValidityObserved&&m.uidValidity!==uidValidity)))throw new Error('source_still_present')
      const view=from===folder?sourceView:await list()
      install(view)
      if(undo&&to===folder){state.selectedUid=ack.uid;state.message=destination}
      state.undo=undo?null:{folder:to,uid:ack.uid,uidValidity:ack.uidValidity,to:from,message:destination}
      status('saved')
    }catch(error){
      if(acknowledged||(dispatched&&mailFolderWriteUncertain(error))){state.uncertain=true;state.undo=null;status('uncertain','move_unverified')}
      else status('failed','move_failed')
    }finally{state.busy=false;publish()}
  }
  return {
    state,refresh:()=>refresh(),review:()=>refresh(true),loadOlder:()=>loadOlder(),toggleFlag:(uid?:number)=>toggleFlag(uid),loadRemoteImages:()=>loadRemoteImages(),move:(to:string)=>move(to),restore:()=>move('INBOX'),undo:()=>move(state.undo?.to??folder,true),
    async open(value:number){
      if(state.busy)return
      let uid:number;try{uid=mailFolderUid(value)}catch{status('failed','invalid_uid');return}
      if(!state.messages.some(item=>item.uid===uid))return
      const token=++readGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading')
      try{const message=await read(folder,uid);if(token!==readGeneration||!state.messages.some(item=>item.uid===uid))return;state.selectedUid=uid;state.message=message;status(state.uncertain?'uncertain':'read')}
      catch{if(token===readGeneration)status(state.uncertain?'uncertain':'failed','read_failed')}
      finally{if(token===readGeneration){state.reading=false;publish()}}
    },
  }
}

export function bindMailFolderWorkspace(askDialog:(options:Record<string,unknown>)=>Promise<unknown>,rtl:boolean):void {
  const t=(message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-folder-workspace="true"]').forEach(root=>{
    if(root.dataset.folderBound==='true')return
    root.dataset.folderBound='true'
    const mailbox=root.dataset.mailbox??'',folder=root.dataset.mailFolder??'INBOX'
    const list=root.querySelector<HTMLElement>('[data-mail-list]'),article=root.querySelector<HTMLElement>('[data-mail-article]'),status=root.querySelector<HTMLElement>('[data-mail-folder-status]')
    const rowTemplate=root.querySelector<HTMLTemplateElement>('[data-mail-folder-row-template]'),readingTemplate=root.querySelector<HTMLTemplateElement>('[data-mail-folder-reading-template]'),empty=root.querySelector<HTMLTemplateElement>('#xmail-empty')
    const query=root.querySelector<HTMLInputElement>('#xmail-query'),pager=root.querySelector<HTMLElement>('[data-mail-pager]')
    if(!list||!article||!rowTemplate||!readingTemplate||!status)return
    try{mailRequireTemplates(root,[['mail-folder-message-row','li'],['mail-folder-message-reading','div'],['mail-folder-filter-empty','p'],['mail-folder-move-menu','ul'],['mail-folder-move-choice','li',['label'],[['label','button',{type:'button'}]]],['mail-folder-attachment-info','li',['button','badge','name','size'],[['button','button',{type:'button'}],['name','bdi'],['size','bdi']]]]);for(const [name,tag,selectors] of [['mail-folder-message-row','li',['[data-mail-open]','[data-mail-name]','[data-mail-subject]','[data-mail-time] time','[data-mail-preview]']],['mail-folder-message-reading','div',['[data-mail-detail-subject]','[data-mail-detail-name]','[data-mail-detail-from]','[data-mail-detail-to]','[data-mail-detail-date]','[data-mail-detail-body]']]] as const){const fragment=mailTemplate(root,name,tag);for(const selector of selectors)if(!fragment.querySelector(selector))throw new Error('invalid_mail_folder_template')}}catch{root.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(control=>{control.disabled=true});status.dataset.state='unavailable';status.textContent=t('Unavailable');return}
    let filter='all',lastRows:FolderSummary[]|null=null,lastMessage:FolderMessage|null|undefined
    const blocked=()=>!root.isConnected||root.dataset.mailFolderWorkspace!=='true'||root.dataset.mailbox!==mailbox||root.dataset.mailFolder!==folder||!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled,[data-capability-state="unavailable"],[data-page-state="unavailable"],[data-readonly="true"],[data-qualified="false"]')
    const send=async(method:'GET'|'POST',path:string,body?:unknown)=>{
      const transport=(window as unknown as {xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
      if(blocked()||typeof transport!=='function')throw {details:{stateChanged:false}}
      return transport(method,path,body)
    }
    const set=(node:ParentNode,selector:string,value:string)=>{const target=node.querySelector<HTMLElement>(selector);if(target){const technical=/detail-(?:from|to|cc|date)\]|mail-time/.test(selector);let content=target.tagName==='BDI'?target:target.querySelector<HTMLElement>('bdi');if(!content&&technical){content=document.createElement('bdi');content.dir='ltr';target.replaceChildren(content)}if(content){content.textContent=value;content.dir=technical?'ltr':'auto'}else{target.textContent=value;target.dir='auto'}}}
    const size=(bytes:number)=> formatClientBytes(bytes)
    const stamp=(raw:string,compact=false)=>{const date=new Date(raw);if(Number.isNaN(date.getTime()))return raw;if(compact)return date.toISOString().slice(11,16);const full=formatMailDateTime(raw);return full==='—'?formatMailDateTime(date):full}
    let invalidated=false,refreshTimer:number|undefined,qrBusy=false
    const scheduleRefresh=()=>{if(refreshTimer!==undefined)return;refreshTimer=window.setTimeout(()=>{refreshTimer=undefined;if(blocked()||workspace.state.busy||workspace.state.reading||workspace.state.uncertain)return;invalidated=false;void workspace.refresh()},50)}
    const syncQuickReply=()=>{
      const qrBody=article.querySelector<HTMLTextAreaElement>('[data-mail-qr-body]')
      const qrSend=article.querySelector<HTMLButtonElement>('[data-mail-action="quick-reply-send"]')
      if(!qrBody||!qrSend)return
      const canEdit=!blocked()&&!qrBusy&&!workspace.state.busy&&workspace.state.message!==null
      qrBody.disabled=!canEdit
      qrSend.disabled=!canEdit||qrBody.value.trim().length===0
    }
    const filterRows=()=>{
      const q=(query?.value??'').trim().toLowerCase();let shown=0
      list.querySelectorAll<HTMLElement>('[data-mail-open]').forEach(button=>{const hit=(filter!=='unread'||button.dataset.unread==='true')&&(filter!=='starred'||button.dataset.starred==='true')&&(filter!=='attachments'||button.dataset.attach==='1')&&(!q||(button.dataset.search??'').toLowerCase().includes(q));button.parentElement!.hidden=!hit;if(hit)shown++})
      const totalCount=workspace.state.total??workspace.state.messages.length
      if(pager&&workspace.state.loaded){pager.textContent=t('{shown} of {total}',{shown,total:totalCount});pager.dataset.loaded=String(workspace.state.messages.length);pager.dataset.total=String(totalCount)}
      const olderButton=root.querySelector<HTMLButtonElement>('[data-mail-action="load-older"]')
      if(olderButton){olderButton.hidden=!workspace.state.hasMore;olderButton.disabled=workspace.state.busy||workspace.state.reading}
      const paginationNote=root.querySelector<HTMLElement>('[data-mail-pagination-note]')
      if(paginationNote&&workspace.state.loaded){paginationNote.textContent=workspace.state.hasMore?t('Older messages are available on the mail server.'):t('All messages in this folder are shown.')}
      root.querySelectorAll<HTMLElement>('[data-mail-filter]').forEach(button=>{const on=button.dataset.mailFilter===filter;button.setAttribute('aria-pressed',String(on))})
      let note=root.querySelector<HTMLElement>('[data-mail-filter-empty]')
      if(workspace.state.loaded&&shown===0){if(!note){note=mailTemplate(root,'mail-folder-filter-empty','p');list.after(note)}note.textContent=workspace.state.messages.length?t('No messages match this search or filter.'):t('No messages in this folder.')}
      else note?.remove()
    }
    const paintRows=(state:FolderWorkspaceState)=>{
      list.replaceChildren()
      state.messages.forEach(message=>{
        const fragment=mailTemplate(root,'mail-folder-message-row','li'),button=fragment.querySelector<HTMLElement>('[data-mail-open]')!
        const starred=message.flagged===true
        button.dataset.mailOpen='uid-'+message.uid;button.dataset.mailUid=String(message.uid);button.dataset.unread=String(message.unread);button.dataset.starred=String(starred);button.dataset.attach=message.attachments?.length?'1':'0';button.dataset.search=[message.fromName,message.from,message.subject,message.preview].join(' ')
        button.setAttribute('aria-label',[...(starred?[t('Starred')]:[]),message.fromName??message.from,message.subject,stamp(message.receivedAt)].join('. '))
        set(fragment,'[data-mail-name]',message.fromName??message.from);set(fragment,'[data-mail-subject]',message.subject);set(fragment,'[data-mail-time] time',stamp(message.receivedAt,true));set(fragment,'[data-mail-preview]',message.preview??'')
        set(fragment,'[data-mail-row-avatar]',(message.fromName??message.from).trim().charAt(0))
        const starWrap=fragment.querySelector<HTMLElement>('[data-mail-row-star]');if(starWrap)starWrap.hidden=!starred
        const clipWrap=fragment.querySelector<HTMLElement>('[data-mail-row-clip]')
        if(clipWrap)clipWrap.hidden=!message.attachments?.length
        else{const attachmentIcon=fragment.querySelector<SVGElement>('[data-mail-time] svg');if(attachmentIcon)attachmentIcon.toggleAttribute('hidden',!message.attachments?.length)}
        const time=fragment.querySelector('time');if(time){time.setAttribute('datetime',message.receivedAt);time.title=stamp(message.receivedAt)}

        list.append(fragment)
      })
      root.querySelectorAll('[data-mail-empty-list],[data-mail-list-state]').forEach(node=>node.remove())
      const count=root.querySelector<HTMLElement>('[data-mail-count-summary]');if(count)count.textContent=t('{count} messages',{count:state.total??state.messages.length})
      root.dataset.listState=state.messages.length?'messages':'empty'
      filterRows()
    }
    const paintMessage=(message:FolderMessage|null)=>{
      if(!message){if(empty)article.replaceChildren(empty.content.cloneNode(true));return}
      const existingDraft=article.querySelector<HTMLTextAreaElement>('[data-mail-qr-body]')?.value??''
      const sameUid=article.querySelector<HTMLElement>('[data-mail-attachments]')?.dataset.uid===String(message.uid)
      const fragment=mailTemplate(root,'mail-folder-message-reading','div')
      set(fragment,'[data-mail-detail-subject]',message.subject);set(fragment,'[data-mail-detail-name]',message.fromName??message.from);set(fragment,'[data-mail-detail-from]','<'+message.from+'>');set(fragment,'[data-mail-detail-to]',message.to);set(fragment,'[data-mail-detail-cc]',message.cc??'')
      const cc=fragment.querySelector('[data-mail-detail-cc]');if(cc?.parentElement){cc.parentElement.hidden=!message.cc;cc.parentElement.dataset.mailCcVisible=String(!!message.cc)}
      set(fragment,'[data-mail-detail-date]',stamp(message.receivedAt));fragment.querySelector('[data-mail-detail-date]')?.setAttribute('datetime',message.receivedAt)

      set(fragment,'[data-mail-detail-avatar]',(message.fromName??message.from).slice(0,2));set(fragment,'[data-mail-detail-auth]',t('DKIM / SPF / DMARC: not checked'))
      const starBtn=fragment.querySelector<HTMLButtonElement>('[data-mail-action="star"]')
      if(starBtn){
        const starred=message.flagged===true
        starBtn.setAttribute('aria-pressed',String(starred))
        starBtn.title=starred?t('Remove star'):t('Star message')
        const lbl=starBtn.querySelector<HTMLElement>('.v2-mail-actions__label');if(lbl)lbl.textContent=starred?t('Starred'):t('Star')
      }
      const remoteNotice=fragment.querySelector<HTMLElement>('[data-mail-remote-notice]')
      const remoteGallery=fragment.querySelector<HTMLElement>('[data-mail-remote-images]')
      if(remoteGallery){
        remoteGallery.replaceChildren()
        if(message.remoteImages&&message.remoteImages.length>0){
          message.remoteImages.forEach(item=>{
            if(!/^https?:\/\/[^\s"'<>]+$/i.test(item.src))return
            const img=document.createElement('img')
            img.referrerPolicy='no-referrer'
            img.loading='lazy'
            img.alt=item.alt
            img.src=item.src
            remoteGallery.append(img)
          })
          remoteGallery.hidden=remoteGallery.childElementCount===0
          if(remoteNotice)remoteNotice.hidden=true
        }else if(message.remoteImages!==undefined){
          remoteGallery.hidden=true
          if(remoteNotice){
            remoteNotice.hidden=false
            const txt=remoteNotice.querySelector<HTMLElement>('[data-mail-remote-notice-text] span');if(txt)txt.textContent=t('No displayable remote images remained after tracking-pixel filtering.')
            const btn=remoteNotice.querySelector<HTMLButtonElement>('[data-mail-action="load-images"]');if(btn)btn.hidden=true
          }
        }else{
          remoteGallery.hidden=true
          if(remoteNotice)remoteNotice.hidden=message.hasRemoteImages!==true
        }
      }
      const body=fragment.querySelector<HTMLElement>('[data-mail-detail-body]');if(body){body.textContent=message.body;body.dir='auto'}
      const qrBody=fragment.querySelector<HTMLTextAreaElement>('[data-mail-qr-body]');if(qrBody&&sameUid&&existingDraft)qrBody.value=existingDraft
      const attachments=fragment.querySelector<HTMLElement>('[data-mail-detail-attachments]')
      if(attachments&&!attachments.hasAttribute('data-mail-attachments')){
        const ul=attachments.querySelector('ul')
        if(!message.attachments?.length)attachments.remove()
        else if(ul){ul.replaceChildren();message.attachments.forEach(file=>{const item=mailTemplate(root,'mail-folder-attachment-info','li',['button','badge','name','size']),button=mailSlot<HTMLButtonElement>(item,'button','button');button.disabled=true;button.setAttribute('aria-label',file.name+', '+size(file.sizeBytes));mailSlot(item,'badge').textContent=file.name.split('.').pop()?.slice(0,4).toUpperCase()??'FILE';mailSlot(item,'name','bdi').textContent=file.name;mailSlot(item,'size','bdi').textContent=size(file.sizeBytes);ul.append(item)});set(attachments,'h3',t('{count} attachments',{count:message.attachments.length}))}
      }
      fragment.querySelectorAll<HTMLAnchorElement>('[data-mail-reply]').forEach(link=>{const href=new URL('/mail/compose',window.location.href);href.searchParams.set('mode',link.dataset.mailReply!);href.searchParams.set('uid',String(message.uid));href.searchParams.set('folder',folder);link.href=href.pathname+href.search})
      article.replaceChildren(fragment)
      syncQuickReply()
      // state.message is installed only by the existing validated detail read.
      const uidValidity=mailFolderObservedUidValidity(message)
      if(uidValidity!==null&&message.uid<=4294967295&&!blocked())article.dispatchEvent(new CustomEvent('xpanel:mail-message-read',{bubbles:true,detail:{mailbox,folder,uid:message.uid,uidValidity,uidValidityObserved:true}}))
    }
    const sendQuickReply=async()=>{
      if(blocked()||qrBusy||workspace.state.busy||!workspace.state.message)return
      const qrBody=article.querySelector<HTMLTextAreaElement>('[data-mail-qr-body]')
      const qrStatus=article.querySelector<HTMLElement>('[data-mail-qr-status]')
      const text=(qrBody?.value??'').trim()
      if(!qrBody||!text)return
      const current=workspace.state.message
      const rawSubject=current.subject.trim()
      const subject=/^re:/i.test(rawSubject)?rawSubject:'Re: '+(rawSubject||t('(no subject)'))
      qrBusy=true;syncQuickReply()
      if(qrStatus){qrStatus.hidden=false;qrStatus.dataset.state='sending';qrStatus.textContent=t('Sending reply…')}
      try{
        const raw=mailFolderObject(await send('POST','/api/webmail/send',{to:current.from,cc:'',bcc:'',subject,text}))
        if(mailFolderFlags(raw)||raw.mailbox!==mailbox||typeof raw.messageId!=='string'||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(raw.messageId.trim())||typeof raw.savedToSent!=='boolean')throw new Error('invalid_send_receipt')
        qrBody.value=''
        if(qrStatus){qrStatus.hidden=false;qrStatus.dataset.state='sent';qrStatus.textContent=raw.savedToSent?t('Reply sent and saved to Sent.'):t('Reply sent. Sent copy was not saved.')}
      }catch{
        if(qrStatus){qrStatus.hidden=false;qrStatus.dataset.state='failed';qrStatus.textContent=t('The reply could not be sent. Your draft was kept.')}
      }finally{qrBusy=false;syncQuickReply()}
    }
    const messages:Record<FolderStatus,string>={unread:t('Folder data has not been read yet.'),reading:t('Reading this folder…'),read:t('Folder data read.'),saving:t('Checking and moving the message…'),saved:t('Move verified by readback.'),failed:t('The operation failed. The last loaded data is preserved.'),uncertain:t('Move outcome is unverified. Review this folder before another move.')}
    const workspace=createMailFolderWorkspace({mailbox,folder,send,confirm:async(from,to)=>askDialog({title:t('Move this message?'),body:t('Move from {from} to {to}?', { from, to }),confirm:t('Move')}),changed:state=>{
      if(blocked())return
      if(state.loaded&&lastRows!==state.messages){lastRows=state.messages;paintRows(state)}
      if(lastMessage!==state.message){lastMessage=state.message;paintMessage(state.message)}
      list.querySelectorAll<HTMLElement>('[data-mail-open]').forEach(button=>{const selected=Number(button.dataset.mailUid)===state.selectedUid;button.setAttribute('aria-current',String(selected));(button as HTMLButtonElement).disabled=state.busy})
      status.dataset.state=state.status;status.textContent=state.reason==='identity_unobserved'||state.reason==='identity_changed'?t('Message identity is unverified or changed. Read it again before moving.'):state.reason==='message_changed'?t('The message changed. Read it again before moving.'):state.reason==='reviewed'?t('Folder reviewed. The previous move remains unverified.'):state.reason==='flag_saving'?t('Updating message star…'):state.reason==='flag_saved'?t('Message star updated.'):state.reason==='images_loaded'?t('Remote images loaded for this message.'):messages[state.status]
      if(state.loaded&&!state.canMove&&state.status==='read')status.textContent+=' '+t('Message moves are unavailable for this mailbox transport.')
      const review=root.querySelector<HTMLButtonElement>('[data-mail-folder-review]');if(review){review.hidden=!state.uncertain;review.disabled=state.busy||state.reading}
      const undo=root.querySelector<HTMLElement>('[data-mail-undo]');if(undo)undo.hidden=!state.undo||state.uncertain
      root.querySelectorAll<HTMLButtonElement>('[data-mail-action="delete"],[data-mail-action="restore"],[data-mail-action="move"],[data-mail-action="toggle-move"],[data-mail-action="undo"]').forEach(button=>{const identityReady=button.dataset.mailAction==='undo'?!!state.undo&&mailFolderObservedUidValidity(state.undo.message)===state.undo.uidValidity:mailFolderObservedUidValidity(state.message)!==null;button.disabled=state.busy||state.reading||state.uncertain||!state.canMove||!identityReady})
      root.querySelectorAll<HTMLButtonElement>('[data-mail-action="star"]').forEach(button=>{const identityReady=mailFolderObservedUidValidity(state.message)!==null;button.disabled=state.busy||state.reading||state.uncertain||!state.canFlag||!identityReady})
      root.querySelectorAll<HTMLButtonElement>('[data-mail-action="load-images"]').forEach(button=>{button.disabled=state.busy||state.reading||!state.message})
      const olderButton=root.querySelector<HTMLButtonElement>('[data-mail-action="load-older"]');if(olderButton){olderButton.hidden=!state.hasMore;olderButton.disabled=state.busy||state.reading}
      const refresh=root.querySelector<HTMLButtonElement>('[data-mail-action="refresh"]');if(refresh)refresh.disabled=state.busy
      syncQuickReply()
      if(invalidated&&!state.busy&&!state.reading&&!state.uncertain)scheduleRefresh()
    }})
    query?.addEventListener('input',filterRows)
    query?.form?.addEventListener('submit',event=>{event.preventDefault();filterRows()})
    root.addEventListener('input',event=>{
      const target=event.target as Element|null
      if(target?.matches?.('[data-mail-qr-body]'))syncQuickReply()
    })
    try{const q=new URL(window.location.href).searchParams.get('q');if(query&&q!==null)query.value=q}catch{/* Keep the current search. */}
    root.addEventListener('click',event=>{
      const target=event.target as Element|null;if(!target?.closest||blocked())return
      const row=target.closest<HTMLElement>('[data-mail-open]');if(row){void workspace.open(Number(row.dataset.mailUid));return}
      const filterButton=target.closest<HTMLElement>('[data-mail-filter]');if(filterButton){filter=filterButton.dataset.mailFilter??'all';filterRows();return}
      const action=target.closest<HTMLButtonElement>('[data-mail-action]');if(!action||action.disabled)return
      const name=action.dataset.mailAction
      if(name==='refresh')void workspace.refresh()
      if(name==='review')void workspace.review()
      if(name==='load-older')void workspace.loadOlder()
      if(name==='star')void workspace.toggleFlag()
      if(name==='load-images')void workspace.loadRemoteImages()
      if(name==='quick-reply-send')void sendQuickReply()
      if(name==='delete')void workspace.move('Trash')
      if(name==='restore')void workspace.restore()
      if(name==='undo')void workspace.undo()
      if(name==='move'){const to=action.dataset.folder;if(to)void workspace.move(to);root.querySelector('[data-mail-move]')?.remove()}
      if(name==='toggle-move'){
        const old=root.querySelector('[data-mail-move]');if(old){old.remove();action.setAttribute('aria-expanded','false');return}
        if(workspace.state.busy||workspace.state.uncertain||!workspace.state.canMove||mailFolderObservedUidValidity(workspace.state.message)===null)return
        const menu=mailTemplate(root,'mail-folder-move-menu','ul')
        try{const targets=JSON.parse(root.dataset.moveTargets??'[]') as Array<{id:string;label:string}>;targets.forEach(item=>{if(canonicalMailFolder(item.id)!==item.id||item.id===folder||typeof item.label!=='string')return;const li=mailTemplate(root,'mail-folder-move-choice','li',['label']),button=mailSlot<HTMLButtonElement>(li,'label','button');button.dataset.folder=item.id;button.textContent=item.label;menu.append(li)})}catch{return}
        action.parentElement?.append(menu);action.setAttribute('aria-expanded','true')
      }
    })
    document.addEventListener('xpanel:mail-invalidated',event=>{const detail=(event as CustomEvent<{mailbox?:unknown}>).detail;if(detail?.mailbox===mailbox&&!blocked()){invalidated=true;scheduleRefresh()}})
    window.addEventListener('beforeunload',event=>{if(workspace.state.busy||workspace.state.uncertain){event.preventDefault();event.returnValue=''}})
    if(!blocked())void workspace.refresh()
  })
}

export const MAIL_FOLDER_WORKSPACE_CLIENT_BINDING=`(()=>{const formatClientBytes=${ASCII_BYTES_BINDING};${MAIL_CLIENT_TEMPLATE_KIT}const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const canonicalMailFolder=${canonicalMailFolder.toString()};const mailFolderUid=${mailFolderUid.toString()};const mailFolderUidValidity=${mailFolderUidValidity.toString()};const mailFolderObservedUidValidity=${mailFolderObservedUidValidity.toString()};const mailFolderObject=${mailFolderObject.toString()};const mailFolderFlags=${mailFolderFlags.toString()};const readFolderSummary=${readFolderSummary.toString()};const readFolderList=${readFolderList.toString()};const readFolderFlag=${readFolderFlag.toString()};const readFolderMessage=${readFolderMessage.toString()};const readFolderMove=${readFolderMove.toString()};const mailFolderWriteUncertain=${mailFolderWriteUncertain.toString()};const mailFolderFingerprint=${mailFolderFingerprint.toString()};const createMailFolderWorkspace=${createMailFolderWorkspace.toString()};return ${bindMailFolderWorkspace.toString()};})()`
