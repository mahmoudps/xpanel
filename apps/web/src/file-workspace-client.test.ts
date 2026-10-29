// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createFileWorkspace, FILE_WORKSPACE_CLIENT_BINDING, workspaceBinary, workspaceEntry, workspaceLeaf, workspaceListing, workspaceMode, workspacePath, workspaceText, workspaceTextBytes, workspaceTrash, workspaceTrashList, workspaceWriteUncertain, type WorkspaceText } from './file-workspace-client.ts'

const timestamp='2026-10-25T00:00:00.000Z'
const text=(path:string,content:string):WorkspaceText=>({path,content,sizeBytes:new TextEncoder().encode(content).length,mtime:timestamp})
const entry=(path:string,kind:'file'|'directory'|'symlink'='file',sizeBytes=5)=>({name:path.split('/').at(-1)!,path,kind,sizeBytes,mode:kind==='directory'?0o750:0o640,mtime:timestamp})
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function fixture(){
  const files=new Map([['alpha.txt',text('alpha.txt','alpha')],['beta.txt',text('beta.txt','beta')]]),calls:Record<string,unknown>[]=[]
  const send=async(body:Record<string,unknown>):Promise<unknown>=>{calls.push({...body});const path=body.path as string;if(body.op==='list')return{entries:[...files.values()].filter(file=>file.path.split('/').slice(0,-1).join('/')===path).map(file=>entry(file.path,'file',file.sizeBytes))};if(body.op==='read'){const file=files.get(path);if(!file)throw{status:404,stateChanged:false};return{...file}}if(body.op==='write'){const file=text(path,body.content as string);files.set(path,file);return entry(path,'file',file.sizeBytes)}throw new Error('unexpected_operation')}
  return{files,calls,send}
}

describe('file workspace bounded reply validation',()=>{
  it.each(['/etc/passwd','../alpha','a//b','a/./b','a/../b','a\\b','C:alpha','.trash/x','a\u2028b'])('rejects unsafe relative path %j',value=>{expect(()=>workspacePath(value)).toThrow()})
  it('preserves the actual Unicode target and allows root only for listing',()=>{const original='e\u0301/تقارير.txt';expect(workspacePath(original)).toBe(original);expect(workspacePath('userfolder/.trash/existing.txt')).toBe('userfolder/.trash/existing.txt');expect(workspacePath('',true)).toBe('');expect(()=>workspacePath('')).toThrow();expect(()=>workspaceLeaf('a/b')).toThrow()})
  it('bounds path bytes and text UTF8 bytes without changing text',()=>{expect(()=>workspacePath('é'.repeat(2049))).toThrow();expect(workspaceTextBytes('مرحبا')).toBe(10);expect(()=>workspaceTextBytes('😀'.repeat(262145))).toThrow();expect(()=>workspaceTextBytes('\ud800')).toThrow()})
  it('requires exact nonmissing text and byte count',()=>{expect(workspaceText(text('alpha.txt',''),'alpha.txt').content).toBe('');expect(()=>workspaceText({path:'alpha.txt',sizeBytes:0,mtime:timestamp},'alpha.txt')).toThrow();expect(()=>workspaceText(text('beta.txt','beta'),'alpha.txt')).toThrow();expect(()=>workspaceText({...text('alpha.txt','مرحبا'),sizeBytes:5},'alpha.txt')).toThrow()})
  it('binds immediate-child list membership and duplicate paths',()=>{expect(()=>workspaceListing({entries:[entry('docs/a.txt')]},'')).toThrow();expect(()=>workspaceListing({entries:[entry('a'),entry('a')]},'')).toThrow();expect(workspaceListing({entries:[entry('link','symlink')]},'')[0]!.kind).toBe('symlink')})
  it('keeps listing mode metadata separate from changed-write ceilings',()=>{expect(workspaceEntry({...entry('alpha.txt'),mode:0o7777}).mode).toBe(0o7777);expect(()=>workspaceEntry({...entry('alpha.txt'),mtime:'2026-02-31T00:00:00Z'})).toThrow()})
  it('checks binary target, byte count and canonical padding bits',()=>{expect([...workspaceBinary({path:'a',contentBase64:'AA==',sizeBytes:1,mtime:timestamp},'a')]).toEqual([0]);expect(()=>workspaceBinary({path:'a',contentBase64:'AB==',sizeBytes:1,mtime:timestamp},'a')).toThrow();expect(()=>workspaceBinary({path:'b',contentBase64:'AA==',sizeBytes:1,mtime:timestamp},'a')).toThrow()})
  it.each([{status:400},{status:403},{status:409},{status:422},{status:500},{stateChanged:false,unknownOutcome:true},{details:{stateChanged:false,verificationRequired:true}}])('keeps a dispatched failure uncertain without explicit no-change proof %j',failure=>{expect(workspaceWriteUncertain(failure)).toBe(true)})
  it.each([{stateChanged:false},{details:{stateChanged:false}}])('accepts explicit no-change evidence %j',failure=>{expect(workspaceWriteUncertain(failure)).toBe(false)})
  it('serializes the actual standalone browser binding without module dependencies',()=>{expect(()=>new Function(FILE_WORKSPACE_CLIENT_BINDING)).not.toThrow()})
})

describe('file workspace target and draft state',()=>{
  it('does not describe an unread or rejected initial list as observed empty',async()=>{
    let valid=false;const controller=createFileWorkspace({send:async()=>valid?{entries:[]}:{entries:null}})
    expect(controller.state.hasListed).toBe(false);expect(await controller.refresh()).toBe(false);expect(controller.state.hasListed).toBe(false);expect(controller.state.noticeKind).toBe('failed');valid=true;expect(await controller.refresh()).toBe(true);expect(controller.state.hasListed).toBe(true);expect(controller.state.entries).toEqual([])
  })
  it('a pending read-only download does not block a later selection or overwrite its status',async()=>{
    const f=fixture(),pending=deferred<void>(),controller=createFileWorkspace({send:f.send});await controller.open('alpha.txt');const download=controller.readAction(async()=>{await pending.promise;throw new Error('late_download_error')});expect(controller.state.busy).toBe(false);expect(await controller.open('beta.txt')).toBe(true);const notice=controller.state.notice;pending.resolve();expect(await download).toBe(false);expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.notice).toBe(notice)
  })
  it('later file selection wins over a late earlier read',async()=>{
    const f=fixture(),pending=deferred<unknown>();let delayed=false
    const controller=createFileWorkspace({send:body=>body.op==='read'&&body.path==='alpha.txt'&&delayed?pending.promise:f.send(body)})
    await controller.open('beta.txt');delayed=true;const old=controller.open('alpha.txt');await Promise.resolve();await controller.open('beta.txt');const notice=controller.state.notice;pending.resolve(text('alpha.txt','alpha'));expect(await old).toBe(false);expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.draft).toBe('beta');expect(controller.state.notice).toBe(notice)
  })
  it('editing invalidates a pending file read without losing the current target',async()=>{
    const f=fixture(),pending=deferred<unknown>();let delayed=false
    const controller=createFileWorkspace({send:body=>body.op==='read'&&body.path==='alpha.txt'&&delayed?pending.promise:f.send(body)})
    await controller.open('beta.txt');delayed=true;const old=controller.open('alpha.txt');await Promise.resolve();controller.edit('beta draft');pending.resolve(text('alpha.txt','alpha'));await old;expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.draft).toBe('beta draft');expect(controller.state.dirty).toBe(true)
  })
  it('a pending directory navigation cannot erase a later edit',async()=>{
    const f=fixture(),pending=deferred<unknown>(),controller=createFileWorkspace({send:body=>body.op==='list'&&body.path==='docs'?pending.promise:f.send(body)})
    await controller.open('beta.txt');const navigation=controller.navigate('docs');await Promise.resolve();controller.edit('retained draft');pending.resolve({entries:[entry('docs/note.txt')]});expect(await navigation).toBe(false);expect(controller.state.directory).toBe('');expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.draft).toBe('retained draft');expect(controller.state.dirty).toBe(true)
  })
  it('later directory selection wins over a late earlier list',async()=>{
    const f=fixture(),pending=deferred<unknown>(),controller=createFileWorkspace({send:body=>body.op==='list'&&body.path==='docs'?pending.promise:body.op==='list'&&body.path==='assets'?Promise.resolve({entries:[entry('assets/style.css')]}):f.send(body)})
    const old=controller.navigate('docs');await Promise.resolve();await controller.navigate('assets');pending.resolve({entries:[entry('docs/note.txt')]});await old;expect(controller.state.directory).toBe('assets');expect(controller.state.entries[0]!.path).toBe('assets/style.css')
  })
  it('keeps draft and baseline when a dirty-discard dialog is cancelled',async()=>{
    const f=fixture(),confirm=deferred<boolean>(),controller=createFileWorkspace({send:f.send,confirm:()=>confirm.promise})
    await controller.open('beta.txt');controller.edit('unsaved');const opening=controller.open('alpha.txt');await Promise.resolve();expect(controller.state.busy).toBe(true);expect(await controller.navigate('docs')).toBe(false);controller.edit('not accepted during dialog');confirm.resolve(false);expect(await opening).toBe(false);expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.draft).toBe('unsaved');expect(controller.state.busy).toBe(false)
  })
  it('malformed content is never installed as an empty file',async()=>{
    const f=fixture(),controller=createFileWorkspace({send:body=>body.op==='read'&&body.path==='alpha.txt'?Promise.resolve({path:'alpha.txt',sizeBytes:0,mtime:timestamp}):f.send(body)})
    await controller.open('beta.txt');expect(await controller.open('alpha.txt')).toBe(false);expect(controller.state.opened!.path).toBe('beta.txt');expect(controller.state.draft).toBe('beta')
  })
  it('detects an existing external change before dispatch and keeps the original baseline',async()=>{
    const f=fixture(),controller=createFileWorkspace({send:f.send});await controller.open('alpha.txt');controller.edit('my draft');f.files.set('alpha.txt',text('alpha.txt','external'));expect(await controller.save()).toBe(false);expect(f.calls.filter(call=>call.op==='write')).toHaveLength(0);expect(controller.state.opened!.content).toBe('alpha');expect(controller.state.draft).toBe('my draft');expect(controller.state.uncertain).toBe(false);expect(controller.state.noticeKind).toBe('conflict')
  })
  it('saves the captured path/content and blocks edits or target changes while writing',async()=>{
    const f=fixture(),write=deferred<unknown>();let captured:Record<string,unknown>|null=null
    const controller=createFileWorkspace({send:async body=>{if(body.op==='write'){captured={...body};f.files.set(body.path as string,text(body.path as string,body.content as string));return write.promise}return f.send(body)}})
    await controller.open('alpha.txt');controller.edit('new alpha');const saving=controller.save();await Promise.resolve();await Promise.resolve();expect(controller.state.busy).toBe(true);expect(await controller.open('beta.txt')).toBe(false);controller.edit('other draft');write.resolve(entry('alpha.txt','file',9));expect(await saving).toBe(true);expect(captured).toMatchObject({op:'write',path:'alpha.txt',content:'new alpha'});expect(controller.state.opened!.path).toBe('alpha.txt');expect(controller.state.draft).toBe('new alpha');expect(controller.state.dirty).toBe(false)
  })
  it('locks unknown writes even for 4xx, reviews the same target without rebasing the draft',async()=>{
    const f=fixture();let writes=0
    const controller=createFileWorkspace({send:async body=>{if(body.op==='write'){writes++;f.files.set(body.path as string,text(body.path as string,body.content as string));throw{status:422}}return f.send(body)}})
    await controller.open('alpha.txt');controller.edit('desired');expect(await controller.save()).toBe(false);expect(controller.state.uncertain).toBe(true);expect(await controller.save()).toBe(false);expect(writes).toBe(1);expect(await controller.review()).toBe(true);expect(controller.state.draft).toBe('desired');expect(controller.state.opened!.content).toBe('alpha');expect(controller.state.noticeKind).toBe('reviewed');expect(await controller.save()).toBe(false);expect(writes).toBe(1)
  })
  it('keeps malformed acknowledgements uncertain after an actual write',async()=>{
    const f=fixture(),controller=createFileWorkspace({send:async body=>{if(body.op==='write'){f.files.set(body.path as string,text(body.path as string,body.content as string));return entry('beta.txt','file',3)}return f.send(body)}})
    await controller.open('alpha.txt');controller.edit('new');expect(await controller.save()).toBe(false);expect(controller.state.uncertain).toBe(true);expect(controller.state.draft).toBe('new');expect(controller.state.opened!.content).toBe('alpha')
  })
  it('rejects oversized UTF8 drafts before sending a write',async()=>{
    const f=fixture(),controller=createFileWorkspace({send:f.send});await controller.open('alpha.txt');controller.edit('😀'.repeat(262145));expect(await controller.save()).toBe(false);expect(f.calls.filter(call=>call.op==='write')).toHaveLength(0);expect(controller.state.dirty).toBe(true);expect(controller.state.uncertain).toBe(false)
  })
})

describe('file workspace trash and permission wire',()=>{
  it('accepts only octal modes at or below the kind ceiling',()=>{
    expect(workspaceMode('0640',0o640)).toBe(0o640);expect(workspaceMode('640',0o640)).toBe(0o640);expect(workspaceMode('0750',0o750)).toBe(0o750);expect(workspaceMode(' 0600 ',0o640)).toBe(0o600)
    for(const value of ['0666','0777','0641','0o640','-640','648','','   ','0','0000',640,null,undefined,0o640])expect(()=>workspaceMode(value as never,0o640)).toThrow()
    expect(()=>workspaceMode('0750',0o640)).toThrow();expect(workspaceMode('0640',0o750)).toBe(0o640)
    for(const ceiling of [0,-1,1.5,0o17777])expect(()=>workspaceMode('0640',ceiling as never)).toThrow()
  })
  it('validates trash metadata and unique ids',()=>{
    const item={id:'00000000-0000-4000-8000-000000000001',originalPath:'docs/report.pdf',name:'report.pdf',sizeBytes:10,deletedAt:timestamp}
    expect(workspaceTrash(item).originalPath).toBe('docs/report.pdf');expect(workspaceTrash(item,'docs/report.pdf').id).toBe(item.id)
    for(const bad of [{...item,id:'bad'},{...item,originalPath:'.trash/report.pdf'},{...item,originalPath:'docs/other.pdf'},{...item,deletedAt:'2026-02-31T00:00:00Z'},{...item,name:'wrong.pdf'}])expect(()=>workspaceTrash(bad,'docs/report.pdf')).toThrow()
    expect(workspaceTrashList({items:[item]})).toHaveLength(1)
    for(const bad of [{items:[item,item]},{items:'x'},{items:[{...item,id:'x'}]},[]])expect(()=>workspaceTrashList(bad)).toThrow()
  })
  it('serializes trash, chmod and restore wire without dead xpanel endpoints',()=>{
    expect(()=>new Function(FILE_WORKSPACE_CLIENT_BINDING)).not.toThrow()
    for(const marker of ['list-trash','restore','chmod','workspaceMode','trashId','empty-trash'])expect(FILE_WORKSPACE_CLIENT_BINDING).toContain(marker)
    expect(FILE_WORKSPACE_CLIENT_BINDING).toContain('data-file-manager=')
    expect(FILE_WORKSPACE_CLIENT_BINDING).toContain('trash')
    expect(FILE_WORKSPACE_CLIENT_BINDING).not.toContain('/api/xpanel/');expect(FILE_WORKSPACE_CLIENT_BINDING).not.toContain('fetch(')
  })
})
