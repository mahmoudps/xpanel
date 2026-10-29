import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'

const formatMailDateTime = formatDisplayDateTime


export interface FolderSummary {
  uid:number;from:string;to:string;subject:string;receivedAt:string;unread:boolean;sizeBytes:number
  uidValidityObserved:boolean;uidValidity?:number
  fromName?:string;cc?:string;preview?:string;attachments?:Array<{name:string;sizeBytes:number}>
}
export interface FolderMessage extends FolderSummary { body:string }
export interface FolderList {mailbox:string;folder:string;complete:true;messages:FolderSummary[];capabilities:{move:boolean}}
export interface FolderMove {ok:true;mailbox:string;from:string;sourceUid:number;sourceUidValidity:number;folder:string;uid:number|null;destinationUidKnown:boolean;stateChanged:boolean;uidValidityObserved:boolean;uidValidity?:number}
export type FolderStatus='unread'|'reading'|'read'|'saving'|'saved'|'failed'|'uncertain'
export interface FolderWorkspaceState {
  mailbox:string;folder:string;messages:FolderSummary[];loaded:boolean;canMove:boolean;selectedUid:number|null;message:FolderMessage|null
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
  for(const k of ['fromName','cc','preview'] as const)if(v[k]!==undefined){if(typeof v[k]!=='string')throw new Error('invalid_message');result[k]=v[k]}
  if(v.attachments!==undefined){
    if(!Array.isArray(v.attachments))throw new Error('invalid_attachments')
    result.attachments=v.attachments.map(item=>{const a=mailFolderObject(item);if(typeof a.name!=='string'||typeof a.sizeBytes!=='number'||!Number.isFinite(a.sizeBytes)||a.sizeBytes<0)throw new Error('invalid_attachment');return {name:a.name,sizeBytes:a.sizeBytes}})
  }
  if(body){if(typeof v.body!=='string')throw new Error('invalid_body');return {...result,body:v.body}}
  return result
}
export function readFolderList(value:unknown,mailbox:string,folder:string):FolderList {
  const v=mailFolderObject(value),cap=mailFolderObject(v.capabilities)
  if(mailFolderFlags(v)||v.mailbox!==mailbox||v.folder!==folder||v.complete!==true||!Array.isArray(v.messages)||typeof cap.move!=='boolean')throw new Error('invalid_list')
  const messages=v.messages.map(item=>readFolderSummary(item,folder)),ids=new Set(messages.map(item=>item.uid))
  if(ids.size!==messages.length)throw new Error('duplicate_uid')
  if(new Set(messages.filter(item=>item.uidValidityObserved).map(item=>item.uidValidity)).size>1)throw new Error('inconsistent_uid_validity')
  return {mailbox,folder,complete:true,messages,capabilities:{move:cap.move}}
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
  const state:FolderWorkspaceState={mailbox,folder,messages:[],loaded:false,canMove:false,selectedUid:null,message:null,status:'unread',reason:'',busy:false,reading:false,uncertain:false,undo:null}
  let listGeneration=0,readGeneration=0
  const publish=()=>options.changed?.({...state})
  const status=(next:FolderStatus,reason='')=>{state.status=next;state.reason=reason;publish()}
  const list=async(selected=folder)=>readFolderList(await options.send('GET','/api/webmail/inbox?folder='+encodeURIComponent(selected)),mailbox,selected)
  const read=async(selected:string,uid:number)=>readFolderMessage(await options.send('GET','/api/webmail/inbox/'+mailFolderUid(uid)+'?folder='+encodeURIComponent(selected)),mailbox,selected,uid)
  const install=(view:FolderList)=>{
    state.messages=view.messages;state.loaded=true;state.canMove=view.capabilities.move
    if(state.selectedUid!==null&&!view.messages.some(m=>m.uid===state.selectedUid)){state.selectedUid=null;state.message=null;readGeneration++}
  }
  const refresh=async(review=false)=>{
    if(state.busy||state.reading)return
    const token=++listGeneration;state.reading=true;status(state.uncertain?'uncertain':'reading')
    try{const view=await list();if(token!==listGeneration)return;install(view);if(review){state.uncertain=false;state.undo=null}status(state.uncertain?'uncertain':'read',review?'reviewed':'')}
    catch{if(token===listGeneration)status(state.uncertain?'uncertain':'failed','read_failed')}
    finally{if(token===listGeneration){state.reading=false;publish()}}
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
    state,refresh:()=>refresh(),review:()=>refresh(true),move:(to:string)=>move(to),restore:()=>move('INBOX'),undo:()=>move(state.undo?.to??folder,true),
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
    let filter='all',lastRows:FolderSummary[]|null=null,lastMessage:FolderMessage|null|undefined
    const blocked=()=>!root.isConnected||root.dataset.mailFolderWorkspace!=='true'||root.dataset.mailbox!==mailbox||root.dataset.mailFolder!==folder||!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled,[data-capability-state="unavailable"],[data-page-state="unavailable"],[data-readonly="true"],[data-qualified="false"]')
    const send=async(method:'GET'|'POST',path:string,body?:unknown)=>{
      const transport=(window as unknown as {xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
      if(blocked()||typeof transport!=='function')throw {details:{stateChanged:false}}
      return transport(method,path,body)
    }
    const set=(node:ParentNode,selector:string,value:string)=>{const target=node.querySelector<HTMLElement>(selector);if(target){target.textContent=value;target.dir=/detail-(?:from|to|cc|date)\]|mail-time/.test(selector)?'ltr':'auto';target.style.unicodeBidi='isolate';target.style.textAlign=rtl?'right':'left'}}
    const size=(bytes:number)=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB'
    const stamp=(raw:string,compact=false)=>{const date=new Date(raw);if(Number.isNaN(date.getTime()))return raw;if(compact)return date.toISOString().slice(11,16);const full=formatMailDateTime(raw);return full==='—'?formatMailDateTime(date):full}
    let invalidated=false,refreshTimer:number|undefined
    const scheduleRefresh=()=>{if(refreshTimer!==undefined)return;refreshTimer=window.setTimeout(()=>{refreshTimer=undefined;if(blocked()||workspace.state.busy||workspace.state.reading||workspace.state.uncertain)return;invalidated=false;void workspace.refresh()},50)}
    const filterRows=()=>{
      const q=(query?.value??'').trim().toLowerCase();let shown=0
      list.querySelectorAll<HTMLElement>('[data-mail-open]').forEach(button=>{const hit=(filter!=='unread'||button.dataset.unread==='true')&&(filter!=='attachments'||button.dataset.attach==='1')&&(!q||(button.dataset.search??'').toLowerCase().includes(q));button.parentElement!.hidden=!hit;if(hit)shown++})
      if(pager&&workspace.state.loaded)pager.textContent=t('{shown} of {total}',{shown,total:workspace.state.messages.length})
      root.querySelectorAll<HTMLElement>('[data-mail-filter]').forEach(button=>{const on=button.dataset.mailFilter===filter;button.setAttribute('aria-pressed',String(on));button.style.background=on?'light-dark(#FFFFFF,var(--xp-bg-surface))':'transparent';button.style.fontWeight=on?'600':'500'})
      let note=root.querySelector<HTMLElement>('[data-mail-filter-empty]')
      if(workspace.state.loaded&&shown===0){if(!note){note=document.createElement('p');note.dataset.mailFilterEmpty='true';note.style.cssText='margin:0;padding:32px 24px;font-size:14px;line-height:1.75;text-align:center';list.after(note)}note.textContent=workspace.state.messages.length?t('No messages match this search or filter.'):t('No messages in this folder.')}
      else note?.remove()
    }
    const paintRows=(state:FolderWorkspaceState)=>{
      list.replaceChildren()
      state.messages.forEach(message=>{
        const fragment=rowTemplate.content.cloneNode(true) as DocumentFragment,button=fragment.querySelector<HTMLElement>('[data-mail-open]')!
        button.dataset.mailOpen='uid-'+message.uid;button.dataset.mailUid=String(message.uid);button.dataset.unread=String(message.unread);button.dataset.attach=message.attachments?.length?'1':'0';button.dataset.search=[message.fromName,message.from,message.subject,message.preview].join(' ')
        button.setAttribute('aria-label',[message.fromName??message.from,message.subject,stamp(message.receivedAt)].join('. '))
        set(fragment,'[data-mail-name]',message.fromName??message.from);set(fragment,'[data-mail-subject]',message.subject);set(fragment,'[data-mail-time] time',stamp(message.receivedAt,true));set(fragment,'[data-mail-preview]',message.preview??'')
        fragment.querySelectorAll<HTMLElement>('[data-mail-name],[data-mail-subject],[data-mail-time]').forEach(node=>{node.style.fontWeight=message.unread?'600':'400'})
        const attachmentIcon=fragment.querySelector<SVGElement>('[data-mail-time] svg');if(attachmentIcon)attachmentIcon.style.display=message.attachments?.length?'':'none'
        const time=fragment.querySelector('time');if(time){time.setAttribute('datetime',message.receivedAt);time.title=stamp(message.receivedAt);time.style.cssText='max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}
        const timeHolder=fragment.querySelector<HTMLElement>('[data-mail-time]');if(timeHolder){timeHolder.style.maxWidth='45%';timeHolder.style.minWidth='0'}
        const dot=fragment.querySelector<HTMLElement>('[data-mail-dot]');if(dot)dot.style.background=message.unread?'light-dark(#1D5BD6,var(--xp-accent))':'transparent'
        list.append(fragment)
      })
      root.querySelectorAll('[data-mail-empty-list],[data-mail-list-state]').forEach(node=>node.remove())
      const count=root.querySelector<HTMLElement>('[data-mail-count-summary]');if(count)count.textContent=t('{count} messages',{count:state.messages.length})
      root.dataset.listState=state.messages.length?'messages':'empty'
      filterRows()
    }
    const paintMessage=(message:FolderMessage|null)=>{
      if(!message){if(empty)article.replaceChildren(empty.content.cloneNode(true));return}
      const fragment=readingTemplate.content.cloneNode(true) as DocumentFragment
      set(fragment,'[data-mail-detail-subject]',message.subject);set(fragment,'[data-mail-detail-name]',message.fromName??message.from);set(fragment,'[data-mail-detail-from]','<'+message.from+'>');set(fragment,'[data-mail-detail-to]',message.to);set(fragment,'[data-mail-detail-cc]',message.cc??'')
      const cc=fragment.querySelector('[data-mail-detail-cc]');if(cc?.parentElement){cc.parentElement.hidden=!message.cc;cc.parentElement.style.display=message.cc?'grid':'none'}
      set(fragment,'[data-mail-detail-date]',stamp(message.receivedAt));fragment.querySelector('[data-mail-detail-date]')?.setAttribute('datetime',message.receivedAt)
      const date=fragment.querySelector<HTMLElement>('[data-mail-detail-date]');if(date)date.style.overflowWrap='anywhere'
      set(fragment,'[data-mail-detail-avatar]',(message.fromName??message.from).slice(0,2));set(fragment,'[data-mail-detail-auth]',t('DKIM / SPF / DMARC: not checked'))
      const body=fragment.querySelector<HTMLElement>('[data-mail-detail-body]');if(body){body.textContent=message.body;body.dir='auto';body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere'}
      const attachments=fragment.querySelector<HTMLElement>('[data-mail-detail-attachments]')
      if(attachments&&!attachments.matches('[data-mail-attachments]')){
        const ul=attachments.querySelector('ul'),sample=ul?.firstElementChild?.cloneNode(true) as HTMLElement|undefined
        if(!message.attachments?.length)attachments.remove()
        else if(ul&&sample){ul.replaceChildren();message.attachments.forEach(file=>{const item=sample.cloneNode(true) as HTMLElement,button=item.querySelector('button')!;button.disabled=true;button.setAttribute('aria-label',file.name+', '+size(file.sizeBytes));const labels=button.querySelectorAll('span');if(labels[0])labels[0].textContent=file.name.split('.').pop()?.slice(0,4).toUpperCase()??'FILE';if(labels[2])labels[2].textContent=file.name;if(labels[3])labels[3].textContent=size(file.sizeBytes);ul.append(item)});set(attachments,'h3',t('{count} attachments',{count:message.attachments.length}))}
      }
      fragment.querySelectorAll<HTMLAnchorElement>('[data-mail-reply]').forEach(link=>{const href=new URL('/mail/compose',window.location.href);href.searchParams.set('mode',link.dataset.mailReply!);href.searchParams.set('uid',String(message.uid));href.searchParams.set('folder',folder);link.href=href.pathname+href.search})
      article.replaceChildren(fragment)
      // state.message is installed only by the existing validated detail read.
      const uidValidity=mailFolderObservedUidValidity(message)
      if(uidValidity!==null&&message.uid<=4294967295&&!blocked())article.dispatchEvent(new CustomEvent('xpanel:mail-message-read',{bubbles:true,detail:{mailbox,folder,uid:message.uid,uidValidity,uidValidityObserved:true}}))
    }
    const messages:Record<FolderStatus,string>={unread:t('Folder data has not been read yet.'),reading:t('Reading this folder…'),read:t('Folder data read.'),saving:t('Checking and moving the message…'),saved:t('Move verified by readback.'),failed:t('The operation failed. The last loaded data is preserved.'),uncertain:t('Move outcome is unverified. Review this folder before another move.')}
    const workspace=createMailFolderWorkspace({mailbox,folder,send,confirm:async(from,to)=>askDialog({title:t('Move this message?'),body:t('Move from {from} to {to}?', { from, to }),confirm:t('Move')}),changed:state=>{
      if(blocked())return
      if(state.loaded&&lastRows!==state.messages){lastRows=state.messages;paintRows(state)}
      if(lastMessage!==state.message){lastMessage=state.message;paintMessage(state.message)}
      list.querySelectorAll<HTMLElement>('[data-mail-open]').forEach(button=>{const selected=Number(button.dataset.mailUid)===state.selectedUid;button.setAttribute('aria-current',String(selected));button.style.background=selected?'light-dark(#F3F7FE,var(--xp-accent-soft))':'light-dark(#FFFFFF,var(--xp-bg-surface))';button.style.boxShadow=selected?(rtl?'inset -3px 0 0 light-dark(#1D5BD6,var(--xp-accent))':'inset 3px 0 0 light-dark(#1D5BD6,var(--xp-accent))'):'none';(button as HTMLButtonElement).disabled=state.busy})
      status.dataset.state=state.status;status.textContent=state.reason==='identity_unobserved'||state.reason==='identity_changed'?t('Message identity is unverified or changed. Read it again before moving.'):state.reason==='message_changed'?t('The message changed. Read it again before moving.'):state.reason==='reviewed'?t('Folder reviewed. The previous move remains unverified.'):messages[state.status]
      if(state.loaded&&!state.canMove&&state.status==='read')status.textContent+=' '+t('Message moves are unavailable for this mailbox transport.')
      const review=root.querySelector<HTMLButtonElement>('[data-mail-folder-review]');if(review){review.hidden=!state.uncertain;review.disabled=state.busy||state.reading}
      const undo=root.querySelector<HTMLElement>('[data-mail-undo]');if(undo)undo.hidden=!state.undo||state.uncertain
      root.querySelectorAll<HTMLButtonElement>('[data-mail-action="delete"],[data-mail-action="restore"],[data-mail-action="move"],[data-mail-action="toggle-move"],[data-mail-action="undo"]').forEach(button=>{const identityReady=button.dataset.mailAction==='undo'?!!state.undo&&mailFolderObservedUidValidity(state.undo.message)===state.undo.uidValidity:mailFolderObservedUidValidity(state.message)!==null;button.disabled=state.busy||state.reading||state.uncertain||!state.canMove||!identityReady})
      const refresh=root.querySelector<HTMLButtonElement>('[data-mail-action="refresh"]');if(refresh)refresh.disabled=state.busy
      if(invalidated&&!state.busy&&!state.reading&&!state.uncertain)scheduleRefresh()
    }})
    query?.addEventListener('input',filterRows)
    query?.form?.addEventListener('submit',event=>{event.preventDefault();filterRows()})
    try{const q=new URL(window.location.href).searchParams.get('q');if(query&&q!==null)query.value=q}catch{/* Keep the current search. */}
    root.addEventListener('click',event=>{
      const target=event.target as Element|null;if(!target?.closest||blocked())return
      const row=target.closest<HTMLElement>('[data-mail-open]');if(row){void workspace.open(Number(row.dataset.mailUid));return}
      const filterButton=target.closest<HTMLElement>('[data-mail-filter]');if(filterButton){filter=filterButton.dataset.mailFilter??'all';filterRows();return}
      const action=target.closest<HTMLButtonElement>('[data-mail-action]');if(!action||action.disabled)return
      const name=action.dataset.mailAction
      if(name==='refresh')void workspace.refresh()
      if(name==='review')void workspace.review()
      if(name==='delete')void workspace.move('Trash')
      if(name==='restore')void workspace.restore()
      if(name==='undo')void workspace.undo()
      if(name==='move'){const to=action.dataset.folder;if(to)void workspace.move(to);root.querySelector('[data-mail-move]')?.remove()}
      if(name==='toggle-move'){
        const old=root.querySelector('[data-mail-move]');if(old){old.remove();action.setAttribute('aria-expanded','false');return}
        if(workspace.state.busy||workspace.state.uncertain||!workspace.state.canMove||mailFolderObservedUidValidity(workspace.state.message)===null)return
        const menu=document.createElement('ul');menu.id='move-list';menu.dataset.mailMove='true';menu.style.cssText='position:absolute;top:50px;inset-inline-start:0;z-index:2;list-style:none;margin:0;padding:6px;min-width:200px;max-width:calc(100vw - 48px);border-radius:10px;border:1px solid light-dark(#E2E6EC,var(--xp-border));background:light-dark(#FFFFFF,var(--xp-bg-surface));box-shadow:0 8px 24px rgba(16,24,40,.12);display:flex;flex-direction:column;gap:2px'
        try{const targets=JSON.parse(root.dataset.moveTargets??'[]') as Array<{id:string;label:string}>;targets.forEach(item=>{if(canonicalMailFolder(item.id)!==item.id||item.id===folder||typeof item.label!=='string')return;const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.dataset.mailAction='move';button.dataset.folder=item.id;button.textContent=item.label;button.style.cssText='width:100%;min-height:44px;padding:0 12px;border:none;background:transparent;font:inherit;text-align:start;color:light-dark(#101828,var(--xp-text-primary))';li.append(button);menu.append(li)})}catch{return}
        action.parentElement?.append(menu);action.setAttribute('aria-expanded','true')
      }
    })
    document.addEventListener('xpanel:mail-invalidated',event=>{const detail=(event as CustomEvent<{mailbox?:unknown}>).detail;if(detail?.mailbox===mailbox&&!blocked()){invalidated=true;scheduleRefresh()}})
    window.addEventListener('beforeunload',event=>{if(workspace.state.busy||workspace.state.uncertain){event.preventDefault();event.returnValue=''}})
    if(!blocked())void workspace.refresh()
  })
}

export const MAIL_FOLDER_WORKSPACE_CLIENT_BINDING=`(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const canonicalMailFolder=${canonicalMailFolder.toString()};const mailFolderUid=${mailFolderUid.toString()};const mailFolderUidValidity=${mailFolderUidValidity.toString()};const mailFolderObservedUidValidity=${mailFolderObservedUidValidity.toString()};const mailFolderObject=${mailFolderObject.toString()};const mailFolderFlags=${mailFolderFlags.toString()};const readFolderSummary=${readFolderSummary.toString()};const readFolderList=${readFolderList.toString()};const readFolderMessage=${readFolderMessage.toString()};const readFolderMove=${readFolderMove.toString()};const mailFolderWriteUncertain=${mailFolderWriteUncertain.toString()};const mailFolderFingerprint=${mailFolderFingerprint.toString()};const createMailFolderWorkspace=${createMailFolderWorkspace.toString()};return ${bindMailFolderWorkspace.toString()};})()`
