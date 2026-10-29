/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

export const WORKSPACE_EDIT_BYTES=1024*1024
export const WORKSPACE_BINARY_BYTES=2*1024*1024
export interface WorkspaceEntry { name:string;path:string;kind:'file'|'directory'|'symlink';sizeBytes:number;mode:number;mtime:string }
export interface WorkspaceText { path:string;content:string;sizeBytes:number;mtime:string }
type WorkspaceRequest=Record<string,unknown>
type WorkspaceSend=(body:WorkspaceRequest)=>Promise<unknown>
type WorkspaceConfirm=(options:Record<string,unknown>)=>Promise<string|boolean|null>
function workspaceObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function workspacePath(value:unknown,root=false):string{
  if(typeof value!=='string'||!value.isWellFormed()||new TextEncoder().encode(value).length>4096||/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/.test(value)||value.startsWith('/')||/^[a-z]:/i.test(value))throw new Error('invalid_account_path')
  if(value===''&&root)return value
  if(value==='.trash'||value.startsWith('.trash/'))throw new Error('invalid_account_path')
  if(value.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('invalid_account_path')
  return value
}
export function workspaceLeaf(value:unknown):string{const path=workspacePath(value);if(path.includes('/'))throw new Error('name_must_be_one_leaf');return path}
/** Parses an operator-entered octal mode and enforces the approved ceiling (0640 file / 0750 folder). */
export function workspaceMode(value:unknown,ceiling:number):number{
  if(typeof value!=='string'||!/^0?[0-7]{3}$/.test(value.trim()))throw new Error('invalid_file_mode')
  if(!Number.isSafeInteger(ceiling)||ceiling<=0||ceiling>0o7777)throw new Error('invalid_file_mode_ceiling')
  const mode=Number.parseInt(value.trim(),8)
  if(mode<=0||(mode&~ceiling)!==0)throw new Error('file_mode_exceeds_ceiling')
  return mode
}
export function workspaceTextBytes(value:unknown):number{if(typeof value!=='string'||!value.isWellFormed())throw new Error('invalid_unicode_text');const bytes=new TextEncoder().encode(value).length;if(bytes>WORKSPACE_EDIT_BYTES)throw new Error('editor_limit_exceeded');return bytes}
function workspaceTime(value:unknown):value is string{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))return false;const date=new Date(value);if(!Number.isFinite(date.getTime()))return false;const normalized=value.includes('.')?value.replace(/\.(\d{1,3})Z$/,(_,digits:string)=>'.'+digits.padEnd(3,'0')+'Z'):value.replace(/Z$/,'.000Z');return date.toISOString()===normalized}
export function workspaceEntry(value:unknown,path?:string):WorkspaceEntry{
  if(!workspaceObject(value)||typeof value.name!=='string'||typeof value.path!=='string'||!['file','directory','symlink'].includes(String(value.kind))||typeof value.sizeBytes!=='number'||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<0||typeof value.mode!=='number'||!Number.isSafeInteger(value.mode)||value.mode<0||value.mode>0o7777||!workspaceTime(value.mtime))throw new Error('invalid_file_entry')
  const actual=workspacePath(value.path);if((path!==undefined&&actual!==path)||value.name!==actual.split('/').at(-1))throw new Error('wrong_file_target')
  return value as unknown as WorkspaceEntry
}
export function workspaceListing(value:unknown,directory:string):WorkspaceEntry[]{
  workspacePath(directory,true)
  if(!workspaceObject(value)||!Array.isArray(value.entries)||value.entries.length>10000)throw new Error('invalid_directory_listing')
  const paths=new Set<string>();return value.entries.map(raw=>{const row=workspaceEntry(raw);if(row.path.split('/').slice(0,-1).join('/')!==directory||paths.has(row.path))throw new Error('wrong_directory_entry');paths.add(row.path);return row})
}
export function workspaceText(value:unknown,path:string):WorkspaceText{
  if(!workspaceObject(value)||value.path!==workspacePath(path)||typeof value.content!=='string'||typeof value.sizeBytes!=='number'||workspaceTextBytes(value.content)!==value.sizeBytes||!workspaceTime(value.mtime))throw new Error('invalid_file_text')
  return value as unknown as WorkspaceText
}
export function workspaceBinary(value:unknown,path:string):Uint8Array{
  if(!workspaceObject(value)||value.path!==workspacePath(path)||typeof value.contentBase64!=='string'||value.contentBase64.length>Math.ceil(WORKSPACE_BINARY_BYTES/3)*4||!Number.isSafeInteger(value.sizeBytes)||!workspaceTime(value.mtime)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64))throw new Error('invalid_binary_file')
  let binary:string;try{binary=atob(value.contentBase64)}catch{throw new Error('invalid_binary_file')}
  if(binary.length!==value.sizeBytes||binary.length>WORKSPACE_BINARY_BYTES||btoa(binary)!==value.contentBase64)throw new Error('invalid_binary_file')
  return Uint8Array.from(binary,character=>character.charCodeAt(0))
}
export function workspaceWriteUncertain(error:unknown):boolean{const failure=workspaceObject(error)?error:{},details=workspaceObject(failure.details)?failure.details:{};if(['unknownOutcome','verificationRequired','stateChanged','needsAttention'].some(key=>failure[key]===true||details[key]===true))return true;return !(failure.stateChanged===false||details.stateChanged===false)}

export interface WorkspaceState{directory:string;hasListed:boolean;entries:WorkspaceEntry[];opened:WorkspaceText|null;draft:string;dirty:boolean;busy:boolean;loading:boolean;uncertain:boolean;notice:string;noticeKind:string}
export function createFileWorkspace(options:{send:WorkspaceSend;confirm?:WorkspaceConfirm;changed?:(state:WorkspaceState)=>void}){
  const copy=(message:string,values?:MessageValues)=>xpT(message,values)
  const state:WorkspaceState={directory:'',hasListed:false,entries:[],opened:null,draft:'',dirty:false,busy:false,loading:false,uncertain:false,notice:'',noticeKind:'idle'}
  let directoryGeneration=0,fileGeneration=0,reviewPending:(()=>Promise<void>)|null=null
  const emit=()=>options.changed?.({...state,entries:state.entries,opened:state.opened?{...state.opened}:null})
  const note=(text:string,kind='read')=>{state.notice=text;state.noticeKind=kind;emit()}
  const confirmDiscard=async()=>{
    if(!state.dirty)return true
    if(state.busy)return false
    state.busy=true;const token=fileGeneration;emit()
    try{return (await options.confirm?.({title:copy('Discard unsaved changes?'),body:copy('Your draft will be replaced only after the new file or directory is read successfully.'),confirm:copy('Discard draft'),danger:true}))===true&&token===fileGeneration}
    catch{note(copy('Confirmation failed. Your draft is kept.'),'failed');return false}
    finally{state.busy=false;emit()}
  }
  const listReply=async(path:string)=>workspaceListing(await options.send({op:'list',path}),path)
  const refresh=async()=>{
    if(state.busy)return false
    const path=state.directory,token=++directoryGeneration;state.loading=true;emit()
    try{const rows=await listReply(path);if(token!==directoryGeneration||path!==state.directory)return false;state.entries=rows;state.hasListed=true;note(copy('Directory read.'));return true}
    catch{if(token===directoryGeneration)note(copy('Directory could not be verified. Previous records are kept.'),'failed');return false}
    finally{if(token===directoryGeneration){state.loading=false;emit()}}
  }
  const navigate=async(value:string)=>{
    if(state.busy||!await confirmDiscard())return false
    let path:string;try{path=workspacePath(value,true)}catch{note(copy('Invalid account-relative directory.'),'failed');return false}
    const token=++directoryGeneration,editorToken=++fileGeneration;state.loading=true;emit()
    try{const rows=await listReply(path);if(token!==directoryGeneration||editorToken!==fileGeneration)return false;state.directory=path;state.entries=rows;state.hasListed=true;state.opened=null;state.draft='';state.dirty=false;note(copy('Directory read.'));return true}
    catch{if(token===directoryGeneration&&editorToken===fileGeneration)note(copy('Directory could not be verified. Your draft is kept.'),'failed');return false}
    finally{if(token===directoryGeneration){state.loading=false;emit()}}
  }
  const open=async(value:string)=>{
    if(state.busy||!await confirmDiscard())return false
    let path:string;try{path=workspacePath(value)}catch{note(copy('Invalid file path.'),'failed');return false}
    const token=++fileGeneration;++directoryGeneration;state.loading=true;emit()
    try{const file=workspaceText(await options.send({op:'read',path}),path);if(token!==fileGeneration)return false;state.opened=file;state.draft=file.content;state.dirty=false;note(copy('File read.'));return true}
    catch{if(token===fileGeneration)note(copy('File could not be verified. Your draft is kept.'),'failed');return false}
    finally{if(token===fileGeneration){state.loading=false;emit()}}
  }
  const edit=(content:string)=>{if(state.busy)return;fileGeneration++;state.loading=false;state.draft=content;state.dirty=state.opened?content!==state.opened.content:content!=='';emit()}
  const perform=async(prepare:()=>Promise<WorkspaceRequest|null>,verify:(send:WorkspaceSend,request:WorkspaceRequest,reply:unknown)=>Promise<void>,review:(send:WorkspaceSend,request:WorkspaceRequest)=>Promise<void>,done?:(request:WorkspaceRequest)=>void)=>{
    if(state.busy||state.uncertain)return false
    state.busy=true;state.loading=false;++directoryGeneration;++fileGeneration;emit();let dispatched=false
    try{const body=await prepare();if(!body)return false;reviewPending=()=>review(options.send,body);dispatched=true;const reply=await options.send(body);await verify(options.send,body,reply);done?.(body);reviewPending=null
      try{state.entries=await listReply(state.directory);state.hasListed=true}catch{note(copy('Operation verified; directory refresh failed.'),'read');return true}
      note(copy('Operation acknowledged and current state verified.'),'saved');return true
    }catch(error){state.uncertain=dispatched&&workspaceWriteUncertain(error);note(state.uncertain?copy('The write outcome is uncertain. Your draft is kept. Use Refresh or Reload to review current state before another change.'):copy('The operation was refused. Your draft is kept.'),state.uncertain?'uncertain':'failed');if(!dispatched&&error instanceof Error&&error.message==='file_changed_before_save')note(copy('The file changed since it was opened. Your draft and original baseline are kept. Use Reload to explicitly reopen the current file.'),'conflict');if(!dispatched&&error instanceof Error&&error.message==='editor_limit_exceeded')note(copy('Text exceeds the 1 MiB UTF-8 editor limit. Your draft is kept.'),'failed');return false}
    finally{state.busy=false;emit()}
  }
  const save=async()=>{
    const baseline=state.opened?{...state.opened}:null,content=state.draft
    if(!baseline||!state.dirty){note(copy('Open and edit a file first.'),'failed');return false}
    return perform(async()=>{workspaceTextBytes(content);const current=workspaceText(await options.send({op:'read',path:baseline.path}),baseline.path);if(current.content!==baseline.content||current.mtime!==baseline.mtime)throw new Error('file_changed_before_save');return{op:'write',path:baseline.path,content,overwrite:true,mode:0o640}},async(send,body,reply)=>{const ack=workspaceEntry(reply,baseline.path);if(ack.kind!=='file'||ack.mode!==0o640||ack.sizeBytes!==workspaceTextBytes(content))throw new Error('invalid_write_ack');const observed=workspaceText(await send({op:'read',path:baseline.path}),baseline.path);if(observed.content!==content)throw new Error('write_readback_mismatch');state.opened=observed;state.draft=content;state.dirty=false},async(send)=>{workspaceText(await send({op:'read',path:baseline.path}),baseline.path)})
  }
  const review=async()=>{
    if(state.busy||!state.uncertain||!reviewPending)return false
    state.busy=true;emit()
    try{await reviewPending();state.uncertain=false;reviewPending=null;note(copy('Current state was read. The original write result is still unverified. Your draft and original baseline are kept; reopen explicitly to replace them.'),'reviewed');return true}
    catch{note(copy('Current state could not be verified. Further writes remain locked.'),'uncertain');return false}
    finally{state.busy=false;emit()}
  }
  const install=(file:WorkspaceText)=>{const verified=workspaceText(file,file.path);state.opened=verified;state.draft=verified.content;state.dirty=false;emit()}
  const readAction=async(work:(send:WorkspaceSend)=>Promise<void>)=>{if(state.busy)return false;const fileToken=fileGeneration,directoryToken=directoryGeneration;try{await work(options.send);return true}catch{if(fileToken===fileGeneration&&directoryToken===directoryGeneration)note(copy('The read operation could not be verified.'),'failed');return false}}
  return{state,refresh,navigate,open,edit,save,perform,review,confirmDiscard,install,readAction}
}

export function workspaceTrash(value:unknown,path?:string):{id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string}{
  if(!workspaceObject(value)||typeof value.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)||typeof value.originalPath!=='string'||workspacePath(value.originalPath)!==value.originalPath||(path!==undefined&&value.originalPath!==path)||value.name!==value.originalPath.split('/').at(-1)||typeof value.sizeBytes!=='number'||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<0||!workspaceTime(value.deletedAt))throw new Error('invalid_trash_result')
  return value as unknown as {id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string}
}
export function workspaceTrashList(value:unknown):unknown[]{if(!workspaceObject(value)||!Array.isArray(value.items)||value.items.length>10000)throw new Error('invalid_trash_list');const ids=new Set<string>();for(const raw of value.items){const item=workspaceTrash(raw);if(ids.has(item.id))throw new Error('duplicate_trash_id');ids.add(item.id)}return value.items}
function bindFileWorkspace(askDialog?:WorkspaceConfirm):void{
  document.querySelectorAll<HTMLElement>('[data-file-manager="browse"]').forEach(root=>{
    if(root.dataset.fileWorkspaceBound==='true')return
    root.dataset.fileWorkspaceBound='true'
    const copy=(message: string, values?: MessageValues) => xpT(message, values)
    const denied='[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const username=root.dataset.accountUsername??'',editor=root.querySelector<HTMLTextAreaElement>('#jailed-code-editor'),tbody=root.querySelector<HTMLTableSectionElement>('[data-file-manager-table] tbody'),status=root.querySelector<HTMLElement>('[data-file-status]')
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body:unknown)=>Promise<unknown>}).xpanelSessionRequest
    if(!editor||!tbody||!status)return
    const current=root.querySelector<HTMLElement>('[data-file-current-path]'),selected=root.querySelector<HTMLElement>('[data-file-selected-path]')
    const eligible=()=>root.isConnected&&root.dataset.fileManager==='browse'&&!root.closest(denied)&&root.dataset.accountUsername===username&&/^[a-z][a-z0-9]{0,15}$/.test(username)
    if(!eligible()||typeof transport!=='function'){root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement>('button,input,textarea').forEach(node=>{node.disabled=true});status.hidden=false;status.dataset.state='unavailable';status.textContent=copy('File operations are unavailable.');return}
    const send:WorkspaceSend=body=>{if(!eligible())return Promise.reject(Object.assign(new Error('workspace_context_changed'),{stateChanged:false}));return transport('POST','/api/accounts/'+encodeURIComponent(username)+'/files',body)}
    let renderedEntries:WorkspaceEntry[]|null=null,renderedRead=false
    const setTechnical=(node:HTMLElement,value:string)=>{const bdi=document.createElement('bdi');bdi.dir='ltr';bdi.className='xp-mono xp-chart-technical-value';bdi.textContent=value;node.replaceChildren(bdi)}
    const size=(bytes:number)=>{const units=['B','KiB','MiB','GiB','TiB'];let amount=bytes,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++}return amount.toFixed(index===0?0:amount>=10?1:2)+' '+units[index]}
    const when=(value:string)=>formatDisplayDateTime(value)
    const actionButton=(parent:HTMLElement,label:string,kind:string,path:string,action:()=>void)=>{const button=document.createElement('button');button.type='button';button.className='xp-btn';button.dataset.fileWorkspaceAction=kind;button.dataset.path=path;button.textContent=label;button.addEventListener('click',event=>{event.stopPropagation();if(button.disabled||!eligible())return;action()});parent.appendChild(button);return button}
    const paint=(entries:WorkspaceEntry[],observed:boolean)=>{
      tbody.textContent=''
      for(const entry of entries){
        const row=document.createElement('tr');row.dataset.filePath=entry.path
        const cell=(text:string,technical=false)=>{const node=document.createElement('td');if(technical)setTechnical(node,text);else node.textContent=text;row.appendChild(node);return node}
        cell(entry.name,true);cell(entry.kind==='directory'?copy(msgctxt('file-workspace-client', 'Folder')):entry.kind==='symlink'?copy('Symbolic link'):copy(msgctxt('file-workspace-client', 'File')));cell(size(entry.sizeBytes),true);cell(entry.mode.toString(8).padStart(4,'0'),true);const modifiedCell=cell('',true),modifiedTime=document.createElement('time');modifiedTime.dateTime=entry.mtime;modifiedTime.textContent=when(entry.mtime);modifiedCell.querySelector('bdi')!.appendChild(modifiedTime)
        const actions=document.createElement('td');actions.className='xp-file-row-actions'
        if(entry.kind==='symlink'){actions.textContent=copy('Link actions are unavailable.')}
        else{
          actionButton(actions,entry.kind==='directory'?copy(msgctxt('file-workspace-client', 'Open')):copy(msgctxt('file-workspace-client', 'Edit')),entry.kind==='directory'?'directory':'open',entry.path,()=>{if(controller.state.uncertain){void controller.review();return}void(entry.kind==='directory'?controller.navigate(entry.path):controller.open(entry.path))})
          if(entry.kind==='file')actionButton(actions,copy('Download'),'download',entry.path,()=>{void controller.readAction(async request=>{const bytes=workspaceBinary(await request({op:'get-bytes',path:entry.path}),entry.path),url=URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));try{const link=document.createElement('a');link.href=url;link.download=entry.name;link.click()}finally{URL.revokeObjectURL(url)}})})
          actionButton(actions,copy('Permissions'),'chmod',entry.path,()=>{void (async()=>{
            if(controller.state.busy||controller.state.uncertain||!eligible())return
            const ceiling=entry.kind==='directory'?0o750:0o640
            const policy=root.querySelector<HTMLInputElement>('#chmod-octal-input')
            const suggestion=policy&&/^0[0-7]{3}$/.test(policy.value.trim())?policy.value.trim():entry.mode.toString(8).padStart(4,'0')
            const raw=await askDialog?.({title:copy('Change permissions'),body:entry.path+' — '+copy('Maximum 0640 for files and 0750 for folders; world-writable modes are refused.'),input:true,label:copy('Permissions (octal)'),value:suggestion,preserveWhitespace:true,confirm:copy('Apply permissions')})
            if(typeof raw!=='string')return
            let mode:number
            try{mode=workspaceMode(raw,ceiling)}catch{status.hidden=false;status.dataset.state='failed';status.setAttribute('role','alert');status.textContent=copy('Use an octal mode within the allowed ceiling (0640 file / 0750 folder); no change was made.');return}
            const parent=entry.path.split('/').slice(0,-1).join('/')
            await controller.perform(async()=>({op:'chmod',path:entry.path,mode}),async(request,body,ack)=>{const changed=workspaceEntry(ack,entry.path);if(changed.mode!==mode)throw new Error('invalid_chmod_ack');const rows=workspaceListing(await request({op:'list',path:parent}),parent);const observed=rows.find(row=>row.path===entry.path);if(!observed||observed.mode!==mode)throw new Error('chmod_not_observed')},async request=>{workspaceListing(await request({op:'list',path:parent}),parent)})
          })()})
          actionButton(actions,copy(msgctxt('file-workspace-client', 'Move to trash')),'trash',entry.path,()=>{void controller.perform(async()=>{const ok=await askDialog?.({title:copy(msgctxt('file-workspace-client', 'Move to trash')),body:entry.path,confirm:copy(msgctxt('file-workspace-client', 'Move to trash')),danger:true});return ok===true?{op:'trash',path:entry.path}:null},async(request,body,result)=>{workspaceTrash(result,entry.path);const rows=workspaceListing(await request({op:'list',path:entry.path.split('/').slice(0,-1).join('/')}),entry.path.split('/').slice(0,-1).join('/'));if(rows.some(item=>item.path===entry.path))throw new Error('trash_not_observed')},async request=>{workspaceListing(await request({op:'list',path:entry.path.split('/').slice(0,-1).join('/')}),entry.path.split('/').slice(0,-1).join('/'))})})
        }
        row.appendChild(actions);tbody.appendChild(row)
      }
      if(!entries.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=6;cell.textContent=observed?copy('This directory is empty.'):copy('Directory contents have not been read.');row.appendChild(cell);tbody.appendChild(row)}
    }
    const render=(state:WorkspaceState)=>{
      root.setAttribute('aria-busy',String(state.busy));root.dataset.fileLoading=String(state.loading);root.dataset.fileUncertain=String(state.uncertain);root.dataset.fileRead=String(state.hasListed)
      if(editor.value!==state.draft)editor.value=state.draft
      editor.readOnly=state.busy||!eligible();editor.dataset.editorPath=state.opened?.path??''
      if(current)current.textContent=state.directory||'.'
      if(selected)selected.textContent=state.opened?.path??copy('No file selected')
      if(renderedEntries!==state.entries||renderedRead!==state.hasListed){renderedEntries=state.entries;renderedRead=state.hasListed;paint(state.entries,state.hasListed)}
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button=>{const action=button.dataset.action||button.dataset.fileWorkspaceAction;const review=action==='refresh-files'||action==='reload-file';button.disabled=state.busy||!eligible()||(state.uncertain&&!review&&action!=='download')||(action==='save-file'&&(!state.opened||!state.dirty))||(action==='reload-file'&&!state.opened&&!state.uncertain)||(action==='parent-directory'&&state.directory==='')})
      status.hidden=!state.notice;status.dataset.state=state.noticeKind;status.setAttribute('role',state.noticeKind==='failed'||state.noticeKind==='uncertain'?'alert':'status');status.textContent=state.notice
    }
    const controller=createFileWorkspace({send,confirm:askDialog,changed:render})
    editor.addEventListener('input',()=>{if(eligible())controller.edit(editor.value)})
    root.querySelector<HTMLButtonElement>('[data-action="save-file"]')?.addEventListener('click',()=>{if(eligible())void controller.save()})
    root.querySelector<HTMLButtonElement>('[data-action="refresh-files"]')?.addEventListener('click',()=>{if(eligible())void(controller.state.uncertain?controller.review():controller.refresh())})
    root.querySelector<HTMLButtonElement>('[data-action="reload-file"]')?.addEventListener('click',()=>{if(!eligible())return;if(controller.state.uncertain){void controller.review();return}if(controller.state.opened)void controller.open(controller.state.opened.path)})
    root.querySelector<HTMLButtonElement>('[data-action="parent-directory"]')?.addEventListener('click',()=>{if(eligible())void controller.navigate(controller.state.directory.split('/').slice(0,-1).join('/'))})
    const create=async(kind:'file'|'directory')=>{
      if(!eligible()||controller.state.busy||controller.state.uncertain)return
      const directory=controller.state.directory
      if(kind==='file'&&!await controller.confirmDiscard())return
      let created:WorkspaceText|null=null
      await controller.perform(async()=>{const name=await askDialog?.({title:kind==='file'?copy('New file'):copy('New folder'),input:true,preserveWhitespace:true,label:copy('Name'),confirm:copy('Create')});if(typeof name!=='string')return null;const path=workspacePath((directory?directory+'/':'')+workspaceLeaf(name));return kind==='file'?{op:'write',path,content:'',overwrite:false,mode:0o640}:{op:'mkdir',path,mode:0o750}},async(request,body,result)=>{const path=body.path as string,entry=workspaceEntry(result,path);if(entry.kind!==kind||entry.mode!==(kind==='file'?0o640:0o750)||entry.sizeBytes!==0)throw new Error('invalid_create_ack');if(kind==='file'){created=workspaceText(await request({op:'read',path}),path);if(created.content!=='')throw new Error('new_file_readback_mismatch')}else{const rows=workspaceListing(await request({op:'list',path:directory}),directory);if(!rows.some(row=>row.path===path&&row.kind==='directory'))throw new Error('new_directory_not_observed')}},async(request,body)=>{const path=body.path as string;if(kind==='file')workspaceText(await request({op:'read',path}),path);else workspaceListing(await request({op:'list',path:directory}),directory)},()=>{if(created)controller.install(created)})
    }
    root.querySelector<HTMLButtonElement>('[data-action="new-file"]')?.addEventListener('click',event=>{event.stopPropagation();void create('file')})
    root.querySelector<HTMLButtonElement>('[data-action="new-folder"]')?.addEventListener('click',event=>{event.stopPropagation();void create('directory')})
    root.querySelector<HTMLButtonElement>('[data-action="empty-trash"]')?.addEventListener('click',event=>{event.stopPropagation();if(!eligible())return;void controller.perform(async()=>{const ok=await askDialog?.({title:copy('Empty trash'),body:copy('Trash items will be deleted permanently.'),confirm:copy('Delete permanently'),danger:true});return ok===true?{op:'empty-trash'}:null},async(request,body,result)=>{if(!workspaceObject(result)||typeof result.removed!=='number'||!Number.isSafeInteger(result.removed)||result.removed<0||result.removed>10000)throw new Error('invalid_empty_trash_ack');if(workspaceTrashList(await request({op:'list-trash'})).length)throw new Error('trash_not_empty')},async request=>{workspaceTrashList(await request({op:'list-trash'}))})})
    const picker=root.querySelector<HTMLInputElement>('[data-file-upload]');let uploadDirectory:string|null=null
    root.querySelector<HTMLButtonElement>('[data-action="upload-file"]')?.addEventListener('click',()=>{if(!eligible()||controller.state.busy||controller.state.uncertain||!picker)return;uploadDirectory=controller.state.directory;picker.click()})
    picker?.addEventListener('change',()=>{
      const file=picker.files?.[0],directory=uploadDirectory;picker.value='';uploadDirectory=null
      if(!file||directory===null||!eligible())return
      void controller.perform(async()=>{const path=workspacePath((directory?directory+'/':'')+workspaceLeaf(file.name));if(!Number.isSafeInteger(file.size)||file.size>WORKSPACE_BINARY_BYTES)throw new Error('binary_limit_exceeded');const buffer=await file.arrayBuffer();if(buffer.byteLength!==file.size)throw new Error('upload_size_changed');const bytes=new Uint8Array(buffer);let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return{op:'put-bytes',path,contentBase64:btoa(binary),overwrite:false,mode:0o640}},async(request,body,result)=>{const path=body.path as string,entry=workspaceEntry(result,path),bytes=workspaceBinary(await request({op:'get-bytes',path}),path);if(entry.kind!=='file'||entry.mode!==0o640||entry.sizeBytes!==file.size||bytes.length!==file.size)throw new Error('invalid_upload_ack');let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));if(btoa(binary)!==body.contentBase64)throw new Error('upload_readback_mismatch')},async(request,body)=>{workspaceBinary(await request({op:'get-bytes',path:body.path}),body.path as string)})
    })
    window.addEventListener('beforeunload',event=>{if(controller.state.dirty||controller.state.uncertain){event.preventDefault();event.returnValue=''}})
    render(controller.state);void controller.refresh()
  })
}

function bindTrashWorkspace(askDialog?:WorkspaceConfirm):void{
  document.querySelectorAll<HTMLElement>('[data-file-manager="trash"]').forEach(root=>{
    if(root.dataset.fileTrashBound==='true')return
    root.dataset.fileTrashBound='true'
    const copy=(message: string, values?: MessageValues) => xpT(message, values)
    const denied='[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const username=root.dataset.accountUsername??''
    const tbody=root.querySelector<HTMLTableSectionElement>('[data-file-manager-table] tbody'),status=root.querySelector<HTMLElement>('[data-file-status]')
    const transport=(window as Window&{xpanelSessionRequest?:(method:string,path:string,body:unknown)=>Promise<unknown>}).xpanelSessionRequest
    if(!tbody||!status)return
    const eligible=()=>root.isConnected&&root.dataset.fileManager==='trash'&&!root.closest(denied)&&root.dataset.accountUsername===username&&/^[a-z][a-z0-9]{0,15}$/.test(username)
    const disable=()=>root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement>('button,input,textarea').forEach(node=>{node.disabled=true})
    if(!eligible()||typeof transport!=='function'){disable();status.hidden=false;status.dataset.state='unavailable';status.textContent=copy('Trash operations are unavailable.');return}
    const send:WorkspaceSend=body=>{if(!eligible())return Promise.reject(Object.assign(new Error('workspace_context_changed'),{stateChanged:false}));return transport('POST','/api/accounts/'+encodeURIComponent(username)+'/files',body)}
    const size=(bytes:number)=>{const units=['B','KiB','MiB','GiB','TiB'];let amount=bytes,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++}return amount.toFixed(index===0?0:amount>=10?1:2)+' '+units[index]}
    const when=(value:string)=>formatDisplayDateTime(value)
    let busy=false,uncertain=false
    const setStatus=(text:string,kind:string)=>{status.hidden=!text;status.dataset.state=kind;status.setAttribute('role',kind==='failed'||kind==='uncertain'?'alert':'status');status.textContent=text}
    const sync=()=>{root.setAttribute('aria-busy',String(busy));root.dataset.fileUncertain=String(uncertain);root.querySelectorAll<HTMLButtonElement>('button').forEach(button=>{const review=button.dataset.action==='refresh-files';button.disabled=busy||!eligible()||(uncertain&&!review)})}
    const empty=root.querySelector<HTMLElement>('[data-trash-empty]'),table=tbody.closest<HTMLElement>('.xp-table-wrap')
    const paint=(items:{id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string}[])=>{
      tbody.textContent=''
      // An observed empty read swaps the table for the approved empty-state block.
      if(empty)empty.hidden=items.length>0
      if(table)table.hidden=!items.length
      for(const item of items){
        const row=document.createElement('tr');row.dataset.filePath=item.originalPath;row.dataset.trashId=item.id
        const cell=(value:string,technical=false)=>{const node=document.createElement('td');if(technical){const bdi=document.createElement('bdi');bdi.dir='ltr';bdi.className='xp-mono xp-chart-technical-value';bdi.textContent=value;node.replaceChildren(bdi)}else node.textContent=value;row.appendChild(node);return node}
        cell(item.originalPath,true);cell(copy('Trashed item'));cell(size(item.sizeBytes),true);cell(copy('Not recorded'));const deletedCell=cell('',true),deletedTime=document.createElement('time');deletedTime.dateTime=item.deletedAt;deletedTime.textContent=when(item.deletedAt);deletedCell.querySelector('bdi')!.appendChild(deletedTime)
        const actions=document.createElement('td')
        const restore=document.createElement('button');restore.type='button';restore.className='xp-btn';restore.dataset.fileWorkspaceAction='restore';restore.dataset.path=item.originalPath;restore.textContent=copy('Restore')
        restore.addEventListener('click',event=>{event.stopPropagation();if(restore.disabled||!eligible())return;void restoreItem(item)})
        const purge=document.createElement('button');purge.type='button';purge.className='xp-btn xp-btn--quiet';purge.dataset.fileWorkspaceAction='purge';purge.dataset.path=item.originalPath;purge.textContent=copy('Delete for good…');purge.setAttribute('aria-label',copy('Delete {path} for good',{path:item.originalPath}))
        purge.addEventListener('click',event=>{event.stopPropagation();if(purge.disabled||!eligible())return;void purgeItem(item)})
        actions.append(restore,purge);row.appendChild(actions);tbody.appendChild(row)
      }
    }
    const read=async()=>{paint(workspaceTrashList(await send({op:'list-trash'})) as {id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string}[])}
    const load=async()=>{
      if(busy)return
      busy=true;root.dataset.fileLoading='true';setStatus(copy('Reading trash items…'),'loading');sync()
      try{await read();setStatus(copy('Trash metadata read. Deletion is metadata only until the native helper confirms removal.'),'read')}
      catch{setStatus(copy('Trash metadata could not be read.'),'failed')}
      finally{busy=false;root.dataset.fileLoading='false';sync()}
    }
    const run=async(prepare:()=>Promise<WorkspaceRequest|null>,verify:(request:WorkspaceSend,reply:unknown)=>Promise<void>,review:(request:WorkspaceSend)=>Promise<void>)=>{
      if(busy||uncertain||!eligible())return false
      busy=true;sync();let dispatched=false
      try{
        const body=await prepare();if(!body)return false
        dispatched=true;const reply=await send(body);await verify(send,reply)
        await read().catch(()=>undefined)
        setStatus(copy('Operation acknowledged and current state verified.'),'saved')
        return true
      }catch(error){
        uncertain=dispatched&&workspaceWriteUncertain(error)
        setStatus(uncertain?copy('The outcome is uncertain. Your draft is kept; review the current state before another change.'):copy('The operation was refused. Nothing was retried.'),uncertain?'uncertain':'failed')
        return false
      }finally{busy=false;sync()}
    }
    const restoreItem=async(item:{id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string})=>{
      const confirmed=await askDialog?.({title:copy('Restore from trash'),body:item.originalPath,confirm:copy('Restore file')})
      if(confirmed!==true)return
      await run(async()=>({op:'restore',trashId:item.id,overwrite:false}),async(request,reply)=>{
        const entry=workspaceEntry(reply)
        const ceiling=entry.kind==='directory'?0o750:0o640
        if(entry.kind==='symlink'||entry.mode<=0||(entry.mode&~ceiling)!==0)throw new Error('invalid_restore_ack')
        const remaining=workspaceTrashList(await request({op:'list-trash'})) as {id:string}[]
        if(remaining.some(value=>value.id===item.id))throw new Error('restore_not_observed')
      },async request=>{workspaceTrashList(await request({op:'list-trash'}))})
    }
    const purgeItem=async(item:{id:string;originalPath:string;name:string;sizeBytes:number;deletedAt:string})=>{
      const confirmed=await askDialog?.({title:copy('Delete for good'),body:item.originalPath+' — '+copy('This item will be deleted permanently and cannot be restored.'),confirm:copy('Delete for good'),danger:true})
      if(confirmed!==true)return
      // originalPath and deletedAt pin the reviewed revision; a changed or missing item is refused unchanged.
      await run(async()=>({op:'purge-trash',trashId:item.id,originalPath:item.originalPath,deletedAt:item.deletedAt}),async(request,reply)=>{
        const removed=workspaceTrash(reply,item.originalPath)
        if(removed.id!==item.id||removed.deletedAt!==item.deletedAt)throw new Error('invalid_purge_ack')
        if((workspaceTrashList(await request({op:'list-trash'})) as {id:string}[]).some(value=>value.id===item.id))throw new Error('purge_not_observed')
      },async request=>{workspaceTrashList(await request({op:'list-trash'}))})
    }
    root.querySelector<HTMLButtonElement>('[data-action="refresh-files"]')?.addEventListener('click',()=>{if(eligible()&&!busy)void load()})
    root.querySelector<HTMLButtonElement>('[data-action="empty-trash"]')?.addEventListener('click',event=>{
      event.stopPropagation()
      if(!eligible()||busy||uncertain)return
      void (async()=>{
        const confirmed=await askDialog?.({title:copy('Empty trash'),body:copy('Trash items will be deleted permanently.'),confirm:copy('Delete permanently'),danger:true})
        if(confirmed!==true)return
        await run(async()=>({op:'empty-trash'}),async(request,reply)=>{
          if(!workspaceObject(reply)||typeof reply.removed!=='number'||!Number.isSafeInteger(reply.removed)||reply.removed<0||reply.removed>10000)throw new Error('invalid_empty_trash_ack')
          if((workspaceTrashList(await request({op:'list-trash'})) as {id:string}[]).length)throw new Error('trash_not_empty')
        },async request=>{workspaceTrashList(await request({op:'list-trash'}))})
      })()
    })
    sync();void load()
  })
}

export const FILE_WORKSPACE_CLIENT_BINDING = `(function(askDialog) { const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const WORKSPACE_EDIT_BYTES=${WORKSPACE_EDIT_BYTES};const WORKSPACE_BINARY_BYTES=${WORKSPACE_BINARY_BYTES};${workspaceObject.toString()};${workspacePath.toString()};${workspaceLeaf.toString()};${workspaceMode.toString()};${workspaceTextBytes.toString()};${workspaceTime.toString()};${workspaceEntry.toString()};${workspaceListing.toString()};${workspaceText.toString()};${workspaceBinary.toString()};${workspaceWriteUncertain.toString()};${createFileWorkspace.toString()};${workspaceTrash.toString()};${workspaceTrashList.toString()};(${bindFileWorkspace.toString()})(askDialog);(${bindTrashWorkspace.toString()})(askDialog); })`
