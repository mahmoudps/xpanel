// @vitest-environment jsdom
import { renderXmailInbox, xmailInboxFromProps } from './board-port/xmail-inbox.ts'
import {runInNewContext} from 'node:vm'
import {describe,expect,it} from 'vitest'
import {MAIL_FOLDER_WORKSPACE_CLIENT_BINDING,canonicalMailFolder,createMailFolderWorkspace,mailFolderUid,mailFolderUidValidity,mailFolderWriteUncertain,readFolderList,readFolderMessage,readFolderMove,type FolderMessage} from './mail-folder-workspace-client.ts'

const mailbox='Owner.Local@tenant.test'
// Declared in-memory transport namespaces; no real mailbox/service qualification.
const namespace=(folder:string)=>folder==='Sent'?800:folder==='Trash'?900:folder==='INBOX'?1000:1100
const message=(uid=1,body='Plain text\r\nnext line',uidValidity=800):FolderMessage=>({uid,from:'',to:'',subject:'',receivedAt:'original mail date',unread:true,sizeBytes:32,body,attachments:[{name:'a.txt',sizeBytes:4}],uidValidityObserved:true,uidValidity})
const list=(folder='Sent',messages=[message()],extra:Record<string,unknown>={})=>({mailbox,folder,complete:true,messages,capabilities:{move:true},...extra})
const read=(folder='Sent',item:unknown=message(),extra:Record<string,unknown>={})=>({mailbox,folder,message:item,...extra})
const ack=(extra:Record<string,unknown>={})=>{const from=typeof extra.from==='string'?extra.from:'Sent',folder=typeof extra.folder==='string'?extra.folder:'Trash',known=extra.destinationUidKnown!==false&&extra.stateChanged!==false;return {ok:true,mailbox,from,sourceUid:1,sourceUidValidity:namespace(from),folder,uid:101,destinationUidKnown:known,stateChanged:true,uidValidityObserved:known,...(known?{uidValidity:namespace(folder)}:{}),...extra}}
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r});return {promise,resolve}}
const fixture=async(options:{folder?:string;confirm?:(from:string,to:string)=>Promise<unknown>;override?:(method:string,path:string,body:unknown)=>unknown|Promise<unknown>}={})=>{
  const folder=options.folder??'Sent',folders=new Map<string,FolderMessage[]>([[folder,[message(1,undefined,namespace(folder)),message(2,'Second message',namespace(folder))]],['INBOX',[]],['Trash',folder==='Trash'?[message(1,undefined,namespace(folder)),message(2,'Second message',namespace(folder))]:[]]])
  const calls:Array<{method:string;path:string;body:unknown}>=[];let nextUid=101
  const workspace=createMailFolderWorkspace({mailbox,folder,confirm:options.confirm??(async()=>true),send:async(method,path,body)=>{
    calls.push({method,path,body})
    const replaced=await options.override?.(method,path,body);if(replaced!==undefined)return replaced
    const url=new URL(path,'http://fixture.test'),selected=url.searchParams.get('folder')??folder,uid=Number(url.pathname.match(/inbox\/(\d+)/)?.[1])
    if(method==='GET'&&!uid)return list(selected,folders.get(selected)??[])
    if(method==='GET'){const item=folders.get(selected)?.find(item=>item.uid===uid);if(!item)throw {details:{stateChanged:false}};return read(selected,item)}
    const intent=body as {from:string;folder:string;uidValidity:number},source=folders.get(intent.from)??[],item=source.find(item=>item.uid===uid)
    if(!item)throw {details:{stateChanged:false}}
    if(item.uidValidityObserved!==true||intent.uidValidity!==item.uidValidity)throw {details:{stateChanged:false}}
    if(intent.from===intent.folder)return ack({from:intent.from,sourceUid:uid,folder:intent.folder,uid,stateChanged:false})
    const target={...item,uid:nextUid++,uidValidityObserved:true,uidValidity:namespace(intent.folder)};folders.set(intent.from,source.filter(item=>item.uid!==uid));folders.set(intent.folder,[...(folders.get(intent.folder)??[]),target])
    return ack({from:intent.from,sourceUid:uid,folder:intent.folder,uid:target.uid})
  }})
  await workspace.refresh();await workspace.open(1)
  return {workspace,calls,folders}
}

describe('mail folder wire context',()=>{
  it.each(['INBOX','Sent','Drafts','Junk','Trash','Archive','INBOX.Custom-1','Customers_2026.Archive'])('retains the existing folder grammar %s',folder=>{expect(canonicalMailFolder(folder)).toBe(folder)})
  it('preserves canonical custom case while using the backend whitespace rule',()=>{expect(canonicalMailFolder(' Archive ')).toBe('Archive')})
  it.each([null,{},'', '../Sent','Sent/Child','x'.repeat(42)])('rejects unsupported folder values %j',folder=>{expect(()=>canonicalMailFolder(folder)).toThrow()})
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',null])('rejects an invalid UID %j',uid=>{expect(()=>mailFolderUid(uid)).toThrow()})
  it('does not impose a new 32-bit limit or date/header format',()=>{const item=message(4294967296,'');expect(readFolderMessage(read('Drafts',item),mailbox,'Drafts',item.uid)).toEqual(item)})
  it.each([{mailbox:'foreign@tenant.test'},{folder:'INBOX'},{complete:false},{capabilities:{}},{messages:null},{messages:[message(),message()]},{messages:[{...message(),folder:'Trash'}]},{messages:[{...message(),sizeBytes:-1}]}])('rejects a malformed or cross-context list %j',extra=>{expect(()=>readFolderList(list('Sent',[message()],extra),mailbox,'Sent')).toThrow()})
  it('accepts empty verified lists and strips unrelated message fields',()=>{expect(readFolderList(list('Sent',[]),mailbox,'Sent').messages).toEqual([]);expect(readFolderList(list('Sent',[{...message(),secret:'not copied'} as FolderMessage]),mailbox,'Sent').messages[0]).not.toHaveProperty('secret')})
  it.each([{mailbox:'other'},{folder:'Trash'},{message:message(2)},{message:{...message(),body:null}},{verificationRequired:true}])('rejects wrong read identity and malformed bodies %j',extra=>{expect(()=>readFolderMessage(read('Sent',message(),extra),mailbox,'Sent',1)).toThrow()})
  it.each([{sourceUid:2},{sourceUidValidity:801},{uidValidityObserved:false},{uidValidity:0},{from:'Drafts'},{folder:'INBOX'},{mailbox:'other'},{uid:null},{uid:1,destinationUidKnown:false},{ok:false},{unknownOutcome:true},{stateChanged:false}])('rejects ambiguous move receipts %j',extra=>{expect(()=>readFolderMove(ack(extra),mailbox,'Sent',1,'Trash',800)).toThrow()})
  it('represents an acknowledged move with no destination mapping without guessing a UID',()=>{expect(readFolderMove(ack({uid:null,destinationUidKnown:false}),mailbox,'Sent',1,'Trash',800).uid).toBeNull()})
  it('accepts only the exact same-folder unchanged receipt',()=>{expect(readFolderMove(ack({folder:'Sent',uid:1,stateChanged:false}),mailbox,'Sent',1,'Sent',800).stateChanged).toBe(false);expect(()=>readFolderMove(ack({folder:'Sent',uid:9,stateChanged:false}),mailbox,'Sent',1,'Sent',800)).toThrow()})
  it.each([new Error('offline'),{status:422},{details:{stateChanged:false,unknownOutcome:true}},{stateChanged:true,details:{stateChanged:false}},{verificationRequired:true,details:{stateChanged:false}}])('locks an ambiguous dispatched failure %j',error=>{expect(mailFolderWriteUncertain(error)).toBe(true)})
  it('uses explicit unchanged-state evidence without treating a status code as proof',()=>{expect(mailFolderWriteUncertain({status:412,details:{stateChanged:false}})).toBe(false)})
  it('serializes a standalone binding with no module closure',()=>{const bind=runInNewContext(MAIL_FOLDER_WORKSPACE_CLIENT_BINDING,{document:{querySelectorAll(){return []}}});expect(typeof bind).toBe('function');expect(()=>bind(async()=>true,false)).not.toThrow()})
})

describe('mail folder selection and reversible actions',()=>{
  it('lists and reads the selected folder without assuming Inbox',async()=>{const {workspace,calls}=await fixture({folder:'Drafts'});expect(workspace.state.message?.body).toBe('Plain text\r\nnext line');expect(calls.map(c=>c.path)).toEqual(['/api/webmail/inbox?folder=Drafts','/api/webmail/inbox/1?folder=Drafts']);expect(workspace.state.status).toBe('read')})
  it('keeps the last verified list and selected body on read failure',async()=>{let fail=false;const {workspace}=await fixture({override:(method,path)=>fail&&method==='GET'?Promise.reject(new Error(path)):undefined});const selected=workspace.state.message;fail=true;await workspace.refresh();await workspace.open(2);expect(workspace.state.messages).toHaveLength(2);expect(workspace.state.message).toBe(selected);expect(workspace.state.selectedUid).toBe(1);expect(workspace.state.status).toBe('failed')})
  it('does not replace a real list with malformed data or fake empty success',async()=>{let corrupt=false;const {workspace}=await fixture({override:(method,path)=>corrupt&&method==='GET'&&!path.match(/inbox\/\d/)?{mailbox,folder:'Sent'}:undefined});corrupt=true;await workspace.refresh();expect(workspace.state.messages).toHaveLength(2);expect(workspace.state.status).toBe('failed')})
  it('ignores a late prior selection while allowing the next message read',async()=>{const pending=deferred();let hold=false;const {workspace}=await fixture({override:(method,path)=>hold&&method==='GET'&&path.includes('/1?')?pending.promise:undefined});hold=true;const first=workspace.open(1);await workspace.open(2);pending.resolve(read());await first;expect(workspace.state.selectedUid).toBe(2);expect(workspace.state.message?.body).toBe('Second message')})
  it('confirms before dispatch and preserves selection when cancelled',async()=>{const {workspace,calls}=await fixture({confirm:async()=>false});await workspace.move('Trash');expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(workspace.state.selectedUid).toBe(1);expect(workspace.state.status).toBe('read')})
  it('prevents duplicate move dispatch while confirmation is pending',async()=>{const confirmation=deferred();const {workspace,calls}=await fixture({confirm:()=>confirmation.promise});const first=workspace.move('Trash');await workspace.move('INBOX');confirmation.resolve(true);await first;expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(workspace.state.status).toBe('saved')})
  it('checks fresh source content before dispatch and preserves a changed message',async()=>{const {workspace,calls,folders}=await fixture();folders.set('Sent',[message(1,'External replacement')]);await workspace.move('Trash');expect(workspace.state.reason).toBe('message_changed');expect(workspace.state.message?.body).toBe('Plain text\r\nnext line');expect(calls.filter(c=>c.method==='POST')).toHaveLength(0)})
  it('verifies destination UID and source absence, then undoes using the remapped UID',async()=>{const {workspace,calls}=await fixture();await workspace.move('Trash');expect(workspace.state.status).toBe('saved');expect(workspace.state.undo?.uid).toBe(101);expect(workspace.state.undo?.uidValidity).toBe(900);expect(workspace.state.selectedUid).toBeNull();await workspace.undo();expect(workspace.state.status).toBe('saved');expect(workspace.state.selectedUid).toBe(102);expect(workspace.state.message?.body).toBe('Plain text\r\nnext line');expect(calls.filter(c=>c.method==='POST').map(c=>[c.path,c.body])).toEqual([['/api/webmail/inbox/1/move',{from:'Sent',folder:'Trash',uidValidity:800}],['/api/webmail/inbox/101/move',{from:'Trash',folder:'Sent',uidValidity:900}]])})
  it('restores Trash to Inbox using only the reversible move API',async()=>{const {workspace,calls}=await fixture({folder:'Trash'});await workspace.restore();expect(workspace.state.status).toBe('saved');expect(calls.find(c=>c.method==='POST')?.body).toEqual({from:'Trash',folder:'INBOX',uidValidity:900});expect(calls.every(c=>c.method==='GET'||c.path.endsWith('/move'))).toBe(true)})
  it('keeps list/read usable when the backend does not support move',async()=>{const {workspace,calls}=await fixture({override:(method,path)=>method==='GET'&&!path.match(/inbox\/\d/)?list('Sent',[message()],{capabilities:{move:false}}):undefined});await workspace.move('Trash');expect(workspace.state.message).not.toBeNull();expect(calls.filter(c=>c.method==='POST')).toHaveLength(0)})
  it('locks an unmapped destination without Undo or source UID fallback',async()=>{const {workspace,calls}=await fixture({override:method=>method==='POST'?ack({uid:null,destinationUidKnown:false}):undefined});await workspace.move('Trash');expect(workspace.state.status).toBe('uncertain');expect(workspace.state.undo).toBeNull();const count=calls.length;await workspace.undo();await workspace.move('INBOX');expect(calls).toHaveLength(count);await workspace.refresh();expect(workspace.state.uncertain).toBe(true);await workspace.review();expect(workspace.state.uncertain).toBe(false);expect(workspace.state.status).toBe('read');expect(workspace.state.reason).toBe('reviewed');expect(calls.filter(c=>c.method==='POST')).toHaveLength(1)})
  it('does not unlock uncertainty when explicit review fails',async()=>{let fail=false;const {workspace}=await fixture({override:(method)=>method==='POST'?ack({uid:null,destinationUidKnown:false}):fail?Promise.reject(new Error('offline')):undefined});await workspace.move('Trash');fail=true;await workspace.review();expect(workspace.state.uncertain).toBe(true);expect(workspace.state.message?.uid).toBe(1)})
  it.each([{status:422},new Error('lost reply'),{details:{stateChanged:true}},{details:{stateChanged:false,verificationRequired:true}}])('treats post-dispatch failures as unknown %j',async error=>{const {workspace}=await fixture({override:method=>method==='POST'?Promise.reject(error):undefined});await workspace.move('Trash');expect(workspace.state.status).toBe('uncertain');expect(workspace.state.message?.uid).toBe(1)})
  it('allows correction after an explicit unchanged failure',async()=>{const {workspace}=await fixture({override:method=>method==='POST'?Promise.reject({status:412,details:{stateChanged:false}}):undefined});await workspace.move('Trash');expect(workspace.state.status).toBe('failed');expect(workspace.state.uncertain).toBe(false);expect(workspace.state.selectedUid).toBe(1)})
  it('requires exact destination content before offering Undo',async()=>{const {workspace}=await fixture({override:(method,path)=>method==='POST'?ack():method==='GET'&&path.includes('/101?')?read('Trash',message(101,'Foreign body',900)):undefined});await workspace.move('Trash');expect(workspace.state.uncertain).toBe(true);expect(workspace.state.undo).toBeNull()})
  it('requires the source UID to be absent before reporting saved',async()=>{const {workspace}=await fixture({override:(method,path)=>method==='POST'?ack():method==='GET'&&path.includes('/101?')?read('Trash',message(101,undefined,900)):undefined});await workspace.move('Trash');expect(workspace.state.status).toBe('uncertain')})
  it('keeps an acknowledged change uncertain even when a later read is explicitly denied unchanged',async()=>{const {workspace}=await fixture({override:(method,path)=>method==='POST'?ack():method==='GET'&&path.includes('/101?')?Promise.reject({details:{stateChanged:false}}):undefined});await workspace.move('Trash');expect(workspace.state.status).toBe('uncertain');expect(workspace.state.undo).toBeNull()})
  it('does not treat equal UIDs in separate folders as the same message identity',async()=>{const {workspace,folders}=await fixture();folders.set('Trash',[message(1,'Other folder message',900)]);await workspace.move('Trash');expect(workspace.state.undo?.uid).toBe(101);expect(folders.get('Trash')?.find(m=>m.uid===1)?.body).toBe('Other folder message')})
  it('does not dispatch a mutation while a selected body is being read',async()=>{const pending=deferred();let hold=false;const {workspace,calls}=await fixture({override:(method,path)=>hold&&method==='GET'&&path.includes('/2?')?pending.promise:undefined});hold=true;const reading=workspace.open(2);await workspace.move('Trash');expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);pending.resolve(read('Sent',message(2,'Second message')));await reading})
})

describe('observed namespace custody',()=>{
  it.each([undefined,null,0,-1,1.5,4294967296,'1'])('refuses an invalid UIDVALIDITY %j',value=>{expect(()=>mailFolderUidValidity(value)).toThrow()})
  it('never inherits an unobserved numeric default or metadata field',()=>{const parsed=readFolderMessage(read('Sent',{...message(),uidValidityObserved:undefined,uidValidity:1}),mailbox,'Sent',1);expect(parsed.uidValidityObserved).toBe(false);expect(parsed).not.toHaveProperty('uidValidity')})
  it('rejects claimed observation without a valid positive namespace and inconsistent list namespaces',()=>{expect(()=>readFolderMessage(read('Sent',{...message(),uidValidity:undefined}),mailbox,'Sent',1)).toThrow();expect(()=>readFolderList(list('Sent',[message(),message(2,'Different namespace',801)]),mailbox,'Sent')).toThrow()})
  it('keeps an unobserved message readable while refusing mutation before any write',async()=>{const {workspace,calls}=await fixture({override:(method,path)=>method==='GET'&&path.includes('/1?')?read('Sent',{...message(),uidValidityObserved:false,uidValidity:1}):undefined});expect(workspace.state.message?.body).toBe('Plain text\r\nnext line');await workspace.move('Trash');expect(workspace.state.reason).toBe('identity_unobserved');expect(calls.filter(call=>call.method==='POST')).toHaveLength(0)})
  it('rejects identical content in a changed namespace before dispatch',async()=>{let changed=false;const {workspace,calls}=await fixture({override:(method,path)=>changed&&method==='GET'&&path.includes('/1?')?read('Sent',message(1,undefined,801)):undefined});changed=true;await workspace.move('Trash');expect(workspace.state.reason).toBe('identity_changed');expect(workspace.state.message?.uidValidity).toBe(800);expect(calls.filter(call=>call.method==='POST')).toHaveLength(0)})
  it('does not offer Undo when the actual destination namespace disagrees with its mapped ACK',async()=>{const {workspace}=await fixture({override:(method,path)=>method==='GET'&&path.includes('/101?')?read('Trash',message(101,undefined,901)):undefined});await workspace.move('Trash');expect(workspace.state.uncertain).toBe(true);expect(workspace.state.undo).toBeNull()})
  it('refuses a reused Undo UID in a new namespace even when content is identical',async()=>{const {workspace,calls,folders}=await fixture();await workspace.move('Trash');expect(workspace.state.undo?.uidValidity).toBe(900);folders.set('Trash',folders.get('Trash')!.map(item=>({...item,uidValidity:901})));await workspace.undo();expect(workspace.state.reason).toBe('identity_changed');expect(workspace.state.undo).toBeNull();expect(calls.filter(call=>call.method==='POST')).toHaveLength(1)})
  it('distinguishes a new source namespace with the same numeric UID after a verified move',async()=>{let moved=false;const {workspace}=await fixture({override:(method,path)=>{if(method==='POST')moved=true;return moved&&method==='GET'&&path==='/api/webmail/inbox?folder=Sent'?list('Sent',[message(1,'New namespace message',801)]):undefined}});await workspace.move('Trash');expect(workspace.state.status).toBe('saved');expect(workspace.state.messages[0]?.uidValidity).toBe(801);expect(workspace.state.undo?.uidValidity).toBe(900)})
})


describe('reachable metadata datetime', () => {
  const settleMetadata = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
  const cases = (['INBOX', 'Sent', 'Drafts', 'Trash'] as const).flatMap(folder => (['en', 'ar'] as const).map(locale => [folder, locale] as const))
  it.each(cases)('renders readable %s reader dates in %s without changing source identity', async (folder, locale) => {
    const receivedAt = '2026-10-27T12:34:56.123456Z'
    const rawBody = 'Date: 2026-10-27T12:34:56.123456Z\r\nDTSTART:20261027T123456Z\r\nOriginal source <not-markup>'
    const source = { ...message(1, rawBody, namespace(folder)), from: 'sender@example.test', to: mailbox, fromName: 'Sender', subject: 'Original source 2026-10-27T12:34:56.123456Z', receivedAt }
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const request = async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return new URL(path, 'http://fixture.test').pathname.endsWith('/1') ? read(folder, source) : list(folder, [source]) }
    document.body.innerHTML = renderXmailInbox(xmailInboxFromProps({ locale, mailbox, activeFolder: folder, folderWorkspace: true, selectedUid: 1, messages: [{ ...source, folder, preview: 'Original source preview' }] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    try {
      new Function('return ' + MAIL_FOLDER_WORKSPACE_CLIENT_BINDING)()(async () => false, locale === 'ar')
      await settleMetadata()
      const row = document.querySelector<HTMLButtonElement>('[data-mail-open][data-mail-uid="1"]')!, clock = row.querySelector('time')!
      expect(row.getAttribute('aria-label')).toContain('2026-10-27 12:34 UTC')
      expect(clock.title).toBe('2026-10-27 12:34 UTC')
      expect(clock.textContent).toBe('12:34')
      expect(clock.getAttribute('datetime')).toBe(receivedAt)
      row.click()
      await settleMetadata()
      const date = document.querySelector<HTMLElement>('[data-mail-detail-date]')!
      expect(date.textContent).toBe('2026-10-27 12:34 UTC')
      expect(date.getAttribute('datetime')).toBe(receivedAt)
      expect(date.querySelector('bdi')?.dir).toBe('ltr')
      expect(date.querySelector('bdi')?.textContent).toBe(date.textContent)
      expect(document.querySelector('[data-mail-detail-body]')!.textContent).toBe(rawBody)
      expect(readFolderMessage(read(folder, source), mailbox, folder, 1).receivedAt).toBe(receivedAt)
      expect(source.subject).toBe('Original source 2026-10-27T12:34:56.123456Z')
      expect(calls.map(call => call.path)).toEqual(['/api/webmail/inbox?folder=' + folder, '/api/webmail/inbox/1?folder=' + folder])
      expect(calls.every(call => call.method === 'GET')).toBe(true)
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
  it.each(['en', 'ar'] as const)('keeps an unparsed external date in %s without inventing a timezone', async locale => {
    const receivedAt = 'Unparsed original date', source = { ...message(1, 'Original body', namespace('INBOX')), from: 'sender@example.test', to: mailbox, receivedAt }
    document.body.innerHTML = renderXmailInbox(xmailInboxFromProps({ locale, mailbox, activeFolder: 'INBOX', folderWorkspace: true, selectedUid: 1, messages: [{ ...source, folder: 'INBOX', preview: '' }] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async (_method: string, path: string) => new URL(path, 'http://fixture.test').pathname.endsWith('/1') ? read('INBOX', source) : list('INBOX', [source])
    try {
      new Function('return ' + MAIL_FOLDER_WORKSPACE_CLIENT_BINDING)()(async () => false, locale === 'ar')
      await settleMetadata()
      document.querySelector<HTMLButtonElement>('[data-mail-open][data-mail-uid="1"]')!.click()
      await settleMetadata()
      expect(document.querySelector('[data-mail-detail-date]')!.textContent).toBe(receivedAt)
      expect(document.querySelector('[data-mail-detail-date]')!.getAttribute('datetime')).toBe(receivedAt)
      expect(readFolderMessage(read('INBOX', source), mailbox, 'INBOX', 1).receivedAt).toBe(receivedAt)
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})

describe('reachable metadata datetime external sources', () => {
  it.each((['en', 'ar'] as const).flatMap(locale => ([['Tue, 27 Oct 2026 12:34:56 GMT', '2026-10-27 12:34 UTC'], ['2026-10-27T12:34Z', '2026-10-27 12:34 UTC']] as const).map(([receivedAt, expected]) => [locale, receivedAt, expected] as const)))('formats accepted external source dates in %s for %s without changing raw values', async (locale, receivedAt, expected) => {
    const source = { ...message(1, 'Original source', namespace('INBOX')), from: 'sender@example.test', to: mailbox, receivedAt }
    document.body.innerHTML = renderXmailInbox(xmailInboxFromProps({ locale, mailbox, activeFolder: 'INBOX', folderWorkspace: true, messages: [{ ...source, folder: 'INBOX', preview: '' }] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async (_method: string, path: string) => new URL(path, 'http://fixture.test').pathname.endsWith('/1') ? read('INBOX', source) : list('INBOX', [source])
    try {
      new Function('return ' + MAIL_FOLDER_WORKSPACE_CLIENT_BINDING)()(async () => false, locale === 'ar')
      for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
      document.querySelector<HTMLButtonElement>('[data-mail-open][data-mail-uid="1"]')!.click()
      for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
      const date = document.querySelector('[data-mail-detail-date]')!
      expect(date.textContent).toBe(expected)
      expect(date.getAttribute('datetime')).toBe(receivedAt)
      expect(readFolderMessage(read('INBOX', source), mailbox, 'INBOX', 1).receivedAt).toBe(receivedAt)
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})
