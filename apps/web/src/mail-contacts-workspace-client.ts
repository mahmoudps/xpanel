/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
export interface MailContactDraft {fullName:string;email:string;phone:string;organization:string;title:string}
export interface MailContact extends MailContactDraft {id:string;owner:string;groups:string[];shares:{principal:string;permission:'read'|'read-write';sharedAt:string}[];vcard:string;createdAt:string;revision:string}
export interface MailContactsState {contacts:MailContact[];loaded:boolean;selectedId:string;draft:MailContactDraft;dirty:boolean;query:string;busy:boolean;reading:boolean;uncertain:boolean;conflict:boolean;capacity:{ownedContacts:number;maxContacts:number}|null;status:'unread'|'reading'|'read'|'saving'|'saved'|'deleting'|'deleted'|'failed'|'stale'|'uncertain'}
export function contactObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function contactStable(value:unknown):string {if(Array.isArray(value))return '['+value.map(contactStable).join(',')+']';if(contactObject(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+contactStable(value[key])).join(',')+'}';return JSON.stringify(value)??'undefined'}
export function contactReviewFlags(value:unknown):boolean {if(!contactObject(value))return false;return [value,contactObject(value.details)?value.details:{}].some(part=>['unknownOutcome','verificationRequired','needsAttention'].some(key=>part[key]===true))}
export function contactWriteUncertain(error:unknown):boolean {return contactReviewFlags(error)||!contactObject(error)||!contactObject(error.details)||error.details.stateChanged!==false||error.stateChanged===true}
export function canonicalContactDraft(value:MailContactDraft):MailContactDraft {return {fullName:value.fullName.trim(),email:value.email.trim().toLowerCase(),phone:value.phone.trim(),organization:value.organization.trim(),title:value.title.trim()}}
export function readMailContact(value:unknown,mailbox:string):MailContact {
  if(!contactObject(value)||typeof value.id!=='string'||value.id.length!==36||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.id)||typeof value.owner!=='string'||!value.owner||value.owner!==value.owner.trim().toLowerCase()||typeof value.revision!=='string'||value.revision.length!==64||!/^[0-9a-f]{64}$/.test(value.revision)||!Array.isArray(value.groups)||!Array.isArray(value.shares)||typeof value.vcard!=='string'||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw new Error('invalid_contact')
  const draft={} as MailContactDraft
  for(const key of ['fullName','email','phone','organization','title'] as const){const text=value[key];if(typeof text!=='string'||!text.isWellFormed()||/[\r\n\u0000]/u.test(text)||text!==text.trim())throw new Error('invalid_contact_text');draft[key]=text}
  if(!draft.fullName||!draft.email||draft.email!==draft.email.toLowerCase()||!value.groups.every(group=>typeof group==='string'&&group.isWellFormed()&&!/[\r\n\u0000]/u.test(group)))throw new Error('invalid_contact_fields')
  const shares=value.shares.map(raw=>{if(!contactObject(raw)||typeof raw.principal!=='string'||!raw.principal||!['read','read-write'].includes(String(raw.permission))||typeof raw.sharedAt!=='string'||!Number.isFinite(Date.parse(raw.sharedAt)))throw new Error('invalid_contact_share');return {principal:raw.principal,permission:raw.permission as 'read'|'read-write',sharedAt:raw.sharedAt}})
  if(value.owner!==mailbox&&!shares.some(share=>share.principal===mailbox))throw new Error('foreign_contact')
  return {...draft,id:value.id,owner:value.owner,groups:[...value.groups] as string[],shares,vcard:value.vcard,createdAt:value.createdAt,revision:value.revision}
}
export function readMailContacts(value:unknown,mailbox:string):MailContact[]{if(!contactObject(value)||!contactObject(value.context)||value.context.mailbox!==mailbox||contactReviewFlags(value)||!Array.isArray(value.contacts))throw new Error('invalid_contacts_context');const contacts=value.contacts.map(raw=>readMailContact(raw,mailbox));if(new Set(contacts.map(contact=>contact.id)).size!==contacts.length)throw new Error('duplicate_contact');return contacts}
export async function requestMailContacts(transport:(method:string,path:string,body?:unknown)=>Promise<unknown>,admitted:()=>boolean,method:string,path:string,body?:unknown):Promise<unknown>{if(method!=='GET'&&!admitted())throw {details:{stateChanged:false}};return transport(method,path,body)}
export function createMailContactsWorkspace(options:{mailbox:string;request:(method:string,path:string,body?:unknown)=>Promise<unknown>;changed?:(state:MailContactsState)=>void}) {
  const empty=():MailContactDraft=>({fullName:'',email:'',phone:'',organization:'',title:''}),fields=(contact:MailContact):MailContactDraft=>({fullName:contact.fullName,email:contact.email,phone:contact.phone,organization:contact.organization,title:contact.title})
  const clone=(contact:MailContact):MailContact=>({...contact,groups:[...contact.groups],shares:contact.shares.map(share=>({...share}))})
  const state:MailContactsState={contacts:[],loaded:false,selectedId:'',draft:empty(),dirty:false,query:'',busy:false,reading:false,uncertain:false,conflict:false,capacity:null,status:'unread'}
  let baseline:MailContact|null=null,generation=0
  const publish=()=>{state.dirty=contactStable(state.draft)!==contactStable(baseline?fields(baseline):empty());options.changed?.({...state,contacts:state.contacts.map(clone),draft:{...state.draft}})}
  const status=(value:MailContactsState['status'])=>{state.status=value;publish()},locked=()=>state.busy||state.uncertain||state.conflict
  const read=async()=>readMailContacts(await options.request('GET','/api/webmail/contacts'),options.mailbox)
  const changedTarget=(contacts:MailContact[])=>!!baseline&&!contacts.some(contact=>contact.id===baseline!.id&&contact.owner===baseline!.owner&&contact.revision===baseline!.revision)
  const install=(contacts:MailContact[])=>{state.contacts=contacts;state.loaded=true}
  const select=(id:string)=>{const contact=id?state.contacts.find(contact=>contact.id===id):null;if(id&&!contact)throw new Error('missing_contact');baseline=contact?clone(contact):null;state.selectedId=id;state.draft=baseline?fields(baseline):empty();state.conflict=false}
  return {state,
    setCapacity(value:{ownedContacts:number;maxContacts:number}){if(Number.isSafeInteger(value.ownedContacts)&&value.ownedContacts>=0&&Number.isSafeInteger(value.maxContacts)&&value.maxContacts>0){state.capacity={...value};publish()}},
    edit(patch:Partial<MailContactDraft>){if(locked()||!state.loaded||baseline&&baseline.owner!==options.mailbox)return;for(const key of ['fullName','email','phone','organization','title'] as const)if(patch[key]!==undefined)state.draft[key]=patch[key]!;publish()},
    search(query:string){if(state.busy)return;state.query=query;publish()},
    async select(id:string,confirm:()=>Promise<unknown>){if(locked()||state.reading||!state.loaded||id===state.selectedId)return;const token=++generation;state.busy=true;publish();try{if(state.dirty&&await confirm()!==true)return;if(token!==generation)return;select(id);status('read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async discard(confirm:()=>Promise<unknown>){if(locked()||!state.loaded)return;const token=++generation;state.busy=true;publish();try{if(state.dirty&&await confirm()!==true)return;if(token!==generation)return;state.draft=baseline?fields(baseline):empty();status('read')}catch{status('failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async refresh(){if(state.busy)return;const token=++generation;state.reading=true;status(state.uncertain?'uncertain':state.conflict?'stale':'reading');try{const contacts=await read();if(token!==generation)return;install(contacts);if(changedTarget(contacts))state.conflict=true;status(state.uncertain?'uncertain':state.conflict?'stale':'read')}catch{if(token===generation)status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}finally{if(token===generation){state.reading=false;publish()}}},
    async reload(confirm:()=>Promise<unknown>){if(state.busy)return;const token=++generation;state.busy=true;state.reading=false;publish();try{if((state.dirty||state.uncertain||state.conflict)&&await confirm()!==true)return;const contacts=await read();if(token!==generation)return;install(contacts);select('');state.uncertain=false;state.conflict=false;status('read')}catch{if(token===generation)status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}finally{if(token===generation){state.busy=false;publish()}}},
    async save(){
      if(locked()||state.reading||!state.loaded||!state.dirty||baseline&&baseline.owner!==options.mailbox)return
      if(!baseline&&state.capacity&&state.capacity.ownedContacts>=state.capacity.maxContacts){status('failed');return}
      const target=baseline?clone(baseline):null,draft={...state.draft},expected=canonicalContactDraft(draft),token=++generation;let dispatched=false;state.busy=true;status('saving')
      try{
        const before=await read();if(token!==generation)return;install(before)
        if(target&&!before.some(contact=>contact.id===target.id&&contact.owner===target.owner&&contact.revision===target.revision)){state.conflict=true;status('stale');return}
        dispatched=true
        const raw=await options.request(target?'PATCH':'POST','/api/webmail/contacts'+(target?'/'+encodeURIComponent(target.id):''),{...draft,...(target?{expectedRevision:target.revision}:{})})
        if(!contactObject(raw)||!contactObject(raw.context)||raw.context.mailbox!==options.mailbox||raw.stateChanged!==true||contactReviewFlags(raw))throw new Error('invalid_contact_acknowledgement')
        const accepted=readMailContact(raw.contact,options.mailbox)
        if(accepted.owner!==options.mailbox||contactStable(fields(accepted))!==contactStable(expected)||(target?accepted.id!==target.id||accepted.createdAt!==target.createdAt||contactStable(accepted.groups)!==contactStable(target.groups)||contactStable(accepted.shares)!==contactStable(target.shares):before.some(contact=>contact.id===accepted.id)||accepted.groups.length!==0||accepted.shares.length!==0))throw new Error('contact_acknowledgement_mismatch')
        const contacts=await read();if(token!==generation)return
        const saved=contacts.find(contact=>contact.id===accepted.id)
        if(!saved||contactStable(saved)!==contactStable(accepted))throw new Error('contact_readback_mismatch')
        install(contacts);baseline=clone(saved);state.selectedId=saved.id;state.draft=fields(saved);state.conflict=false;state.uncertain=false;status('saved')
      }catch(error){if(token!==generation)return;state.uncertain=dispatched&&contactWriteUncertain(error);if(!state.uncertain&&contactObject(error)&&error.status===409)state.conflict=true;status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}
      finally{if(token===generation){state.busy=false;publish()}}
    },
    async remove(confirm:(name:string,dirty:boolean)=>Promise<unknown>){
      if(locked()||state.reading||!state.loaded||!baseline||baseline.owner!==options.mailbox)return
      const target=clone(baseline),token=++generation;let dispatched=false;state.busy=true;publish()
      try{
        if(await confirm(target.fullName,state.dirty)!==true)return
        if(token!==generation)return
        status('deleting')
        const before=await read();if(token!==generation)return;install(before)
        if(!before.some(contact=>contact.id===target.id&&contact.owner===target.owner&&contact.revision===target.revision)){state.conflict=true;status('stale');return}
        dispatched=true
        const raw=await options.request('DELETE','/api/webmail/contacts/'+encodeURIComponent(target.id),{expectedRevision:target.revision})
        if(!contactObject(raw)||!contactObject(raw.context)||raw.context.mailbox!==options.mailbox||raw.deletedContactId!==target.id||raw.stateChanged!==true||contactReviewFlags(raw))throw new Error('invalid_contact_delete_acknowledgement')
        const contacts=await read();if(token!==generation)return
        if(contacts.some(contact=>contact.id===target.id))throw new Error('contact_delete_readback_mismatch')
        install(contacts);select('');state.uncertain=false;state.conflict=false;status('deleted')
      }catch(error){if(token!==generation)return;state.uncertain=dispatched&&contactWriteUncertain(error);if(!state.uncertain&&contactObject(error)&&error.status===409)state.conflict=true;status(state.uncertain?'uncertain':state.conflict?'stale':'failed')}
      finally{if(token===generation){state.busy=false;publish()}}
    },
  }
}
function bindMailContactsWorkspace(askDialog:(options:Record<string,unknown>)=>Promise<unknown>){
  const t=(message:string,values?:MessageValues)=>xpT(message,values)
  document.querySelectorAll<HTMLElement>('[data-mail-contacts]').forEach(root=>{
    const mailbox=root.dataset.contactMailbox;if(!mailbox)return
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body?:unknown)=>Promise<unknown>}).xpanelSessionRequest
    const blocked=()=>!!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'),admitted=()=>root.dataset.contactManage==='true'&&!blocked()
    const form=root.querySelector<HTMLFormElement>('[data-contact-form]')!,button=(key:string)=>root.querySelector<HTMLButtonElement>('[data-contact-'+key+']')!,rows=root.querySelector<HTMLElement>('[data-contact-rows]')!
    const discard=()=>askDialog({title:t('Discard contact draft?'),body:t('Unsaved contact fields will be cleared. No previous write is retried.'),confirm:t('Discard and continue'),danger:true})
    const messages:Record<MailContactsState['status'],string>={unread:t('Contacts have not been read.'),reading:t('Reading saved contacts…'),read:t('Saved contacts read. Shared contacts are read-only here.'),saving:t('Saving contact and verifying readback…'),saved:t('Contact saved and read back. No mail was sent or synchronized.'),deleting:t('Deleting the reviewed contact and verifying absence…'),deleted:t('Contact deleted and its absence read back. Shared copies are no longer available.'),failed:t('The request could not complete. Your contact draft is preserved.'),stale:t('The saved contact changed. Your draft is preserved. Refresh can inspect; explicitly discard and reload before editing again.'),uncertain:t('The write outcome requires review. Do not retry. Refresh preserves this lock; explicitly reload to continue.')}
    const selectionTargets=new WeakMap<HTMLButtonElement,string>()
    const workspace=createMailContactsWorkspace({mailbox,request:(method,path,body)=>{if(!transport)throw new Error('session_transport_unavailable');return requestMailContacts(transport,admitted,method,path,body)},changed(state){
      root.setAttribute('aria-busy',String(state.busy||state.reading));const status=root.querySelector<HTMLElement>('[data-contact-status]')!;status.dataset.state=state.status;status.textContent=messages[state.status]
      const selected=state.selectedId?state.contacts.find(contact=>contact.id===state.selectedId):null,readonly=!!selected&&selected.owner!==mailbox,disabled=state.busy||state.uncertain||state.conflict||!state.loaded||!admitted()||readonly
      for(const key of ['fullName','email','phone','organization','title'] as const){const input=form.querySelector<HTMLInputElement>('[name='+key+']')!;if(input.value!==state.draft[key])input.value=state.draft[key];input.disabled=disabled}
      button('save').disabled=disabled||state.reading||!state.dirty||!selected&&!!state.capacity&&state.capacity.ownedContacts>=state.capacity.maxContacts;button('discard').disabled=disabled||!state.dirty;button('delete').disabled=disabled||state.reading||!selected;button('new').disabled=!!state.capacity&&state.capacity.ownedContacts>=state.capacity.maxContacts||state.busy||state.reading||state.uncertain||state.conflict||!state.loaded||!admitted();button('refresh').disabled=state.busy||blocked();button('reload').disabled=state.busy||blocked()||!state.loaded&&!state.uncertain
      const search=root.querySelector<HTMLInputElement>('[data-contact-search]')!;search.disabled=state.busy||!state.loaded||blocked();if(search.value!==state.query)search.value=state.query
      root.querySelector<HTMLElement>('[data-contact-selection]')!.textContent=selected?(readonly?t('Shared contact — read-only'):t('Editing saved contact')):t('New contact')
      root.querySelector<HTMLElement>('[data-contact-groups]')!.textContent=selected?selected.groups.join(', ')||t('No groups'):t('No selection')
      root.querySelector<HTMLElement>('[data-contact-access]')!.textContent=selected?(readonly?t('Shared, read-only in this workspace'):t('Owned by this mailbox')):t('New mailbox contact')
      const capacityNote=root.querySelector<HTMLElement>('[data-contact-capacity]');if(capacityNote){capacityNote.textContent='';if(state.capacity){const value=document.createElement('bdi');value.dir='ltr';value.textContent=String(state.capacity.ownedContacts)+' / '+String(state.capacity.maxContacts);capacityNote.append(value,document.createTextNode(' '+(state.capacity.ownedContacts>=state.capacity.maxContacts?t('owned contacts. The contact limit is reached; existing contacts can still be edited or deleted.'):t('owned contacts.'))))}else capacityNote.textContent=t('Contact capacity has not been read.')}
      if(!state.loaded)return
      const query=state.query.toLocaleLowerCase(),visible=state.contacts.filter(contact=>[contact.fullName,contact.email,contact.phone,contact.organization,...contact.groups].some(text=>text.toLocaleLowerCase().includes(query)))
      root.querySelector<HTMLElement>('[data-contact-count]')!.textContent=t('{visible} / {total} contacts',{visible:visible.length,total:state.contacts.length})
      rows.replaceChildren()
      for(const contact of visible){const row=document.createElement('tr'),name=document.createElement('td'),select=document.createElement('button');select.type='button';select.className='xp-btn';select.textContent=contact.fullName;select.dataset.contactSelect=contact.id;select.setAttribute('aria-pressed',String(state.selectedId===contact.id));select.disabled=state.busy||state.reading||state.uncertain||state.conflict||blocked();selectionTargets.set(select,contact.id);name.append(select);row.append(name);for(const [value,technical] of [[contact.email,true],[contact.organization,false],[contact.owner===mailbox?t('Owned'):t('Shared — read-only'),false]] as const){const cell=document.createElement('td');if(technical){const bdi=document.createElement('bdi');bdi.dir='ltr';bdi.className='xp-mono';bdi.textContent=value;cell.append(bdi)}else cell.textContent=value;row.append(cell)}rows.append(row)}
      if(!visible.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.textContent=state.query?t('No contacts match your search.'):t('No saved contacts were returned.');row.append(cell);rows.append(row)}
    }})
    form.addEventListener('input',event=>{if(!admitted())return;const input=event.target as HTMLInputElement;if(['fullName','email','phone','organization','title'].includes(input.name))workspace.edit({[input.name]:input.value})})
    form.addEventListener('submit',event=>{event.preventDefault();if(admitted())void workspace.save().then(()=>{if(workspace.state.status==='saved')window.dispatchEvent(new CustomEvent('xpanel:contacts-changed',{detail:{source:'contact-workspace',mailbox}}))})})
    root.querySelector<HTMLInputElement>('[data-contact-search]')!.addEventListener('input',event=>workspace.search((event.target as HTMLInputElement).value))
    root.addEventListener('click',event=>{const selected=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-contact-select]'):null;if(!selected||selected.disabled||blocked())return;const id=selectionTargets.get(selected);if(id)void workspace.select(id,discard)})
    button('new').addEventListener('click',()=>{if(admitted())void workspace.select('',discard)});button('discard').addEventListener('click',()=>{if(admitted())void workspace.discard(discard)})
    button('refresh').addEventListener('click',()=>{if(!blocked())void workspace.refresh()});button('reload').addEventListener('click',()=>{if(!blocked())void workspace.reload(discard)})
    button('delete').addEventListener('click',()=>{if(admitted())void workspace.remove((name,dirty)=>askDialog({title:t('Delete contact?'),body:name+'\n'+t('This permanently removes the owned contact and its sharing.')+(dirty?'\n'+t('Unsaved field edits will also be discarded.'):'') ,confirm:t('Delete contact'),danger:true})).then(()=>{if(workspace.state.status==='deleted')window.dispatchEvent(new CustomEvent('xpanel:contacts-changed',{detail:{source:'contact-workspace',mailbox}}))})})
    window.addEventListener('xpanel:contacts-changed',event=>{const detail=(event as CustomEvent).detail;if(contactObject(detail)&&detail.mailbox===mailbox&&detail.source!=='contact-workspace')void workspace.refresh()})
    window.addEventListener('xpanel:contact-capacity',event=>{const detail=(event as CustomEvent).detail;if(contactObject(detail)&&detail.mailbox===mailbox&&typeof detail.ownedContacts==='number'&&typeof detail.maxContacts==='number')workspace.setCapacity({ownedContacts:detail.ownedContacts,maxContacts:detail.maxContacts})})
    window.addEventListener('beforeunload',event=>{if(workspace.state.dirty||workspace.state.uncertain||workspace.state.conflict){event.preventDefault();event.returnValue=''}})
    button('refresh').disabled=blocked();if(!blocked())void workspace.refresh()
  })
}
export const contactBrowserBinding=(bind:(...args:never[])=>void,withRuntime=false):string=>`(()=>{const contactObject=${contactObject.toString()};const contactStable=${contactStable.toString()};const contactReviewFlags=${contactReviewFlags.toString()};const contactWriteUncertain=${contactWriteUncertain.toString()};const canonicalContactDraft=${canonicalContactDraft.toString()};const readMailContact=${readMailContact.toString()};const readMailContacts=${readMailContacts.toString()};const requestMailContacts=${requestMailContacts.toString()};const createMailContactsWorkspace=${createMailContactsWorkspace.toString()};return ${withRuntime?"(askDialog)=>("+bind.toString()+")(askDialog,{contactObject,contactStable,contactReviewFlags,contactWriteUncertain,readMailContact,readMailContacts})":bind.toString()};})()`

export const MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING=contactBrowserBinding(bindMailContactsWorkspace)
