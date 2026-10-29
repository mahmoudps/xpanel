// Actual File Manager renderer/client, with explicitly mocked session and file RPC.
// No native filesystem, isolation, quota, kernel or production qualification claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium }=await import('@playwright/test')
const output=resolve(process.env.XPANEL_FILE_WORKSPACE_OUTPUT || 'test-results/completion-file-workspace')
const paths=['apps/web/src/file-workspace-client.ts','apps/web/src/ws-client.ts','apps/web/src/surfaces/xpanel.ts','apps/web/src/board-port/approved-xpanel-workspaces.ts','apps/web/src/board-port/approved-xpanel-pages.ts','tests/browser/visual-fixture.mjs','tests/browser/completion-file-workspace.mjs']
const snapshot=()=>paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))
const clone=value=>JSON.parse(JSON.stringify(value))
const leaf=path=>path.split('/').at(-1)
const parent=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):''
const initialTime='2026-10-25T00:00:00.000Z'
const capturedCodeDraft='  const label = "تجربة";\n    console.log(label);\n'

class MockFiles {
  constructor(){
    this.records=new Map([
      ['alpha.txt',{kind:'file',content:'Alpha original\n',mtime:initialTime}],
      ['beta.txt',{kind:'file',content:'Beta original\n',mtime:initialTime}],
      ['تقرير.txt',{kind:'file',content:'Synthetic report\n',mtime:initialTime}],
      ['docs',{kind:'directory',mtime:initialTime}],
      ['docs/note.txt',{kind:'file',content:'Nested note\n',mtime:initialTime}],
      ['assets',{kind:'directory',mtime:initialTime}],
      ['assets/style.css',{kind:'file',content:'body {}\n',mtime:initialTime}],
      ['link',{kind:'symlink',mtime:initialTime}],
    ])
    this.calls=[];this.errors=[];this.trash=[];this.serial=0;this.gates=[];this.mode=null
  }
  entry(path){const row=this.records.get(path);assert.ok(row);return {name:leaf(path),path,kind:row.kind,sizeBytes:row.bytes?row.bytes.length:row.kind==='file'?Buffer.byteLength(row.content,'utf8'):0,mode:row.kind==='directory'?0o750:row.kind==='symlink'?0o777:0o640,mtime:row.mtime}}
  text(path){const row=this.records.get(path);assert.equal(row?.kind,'file');assert.equal(typeof row.content,'string');return {path,content:row.content,sizeBytes:Buffer.byteLength(row.content,'utf8'),mtime:row.mtime}}
  hold(op,path){let release,entered;const promise=new Promise(resolve=>{release=resolve}),startedPromise=new Promise(resolve=>{entered=resolve});const gate={op,path,promise,release,started:false,entered,startedPromise};this.gates.push(gate);return gate}
  write(path,content,bytes){const mtime=new Date(Date.parse(initialTime)+ ++this.serial).toISOString();this.records.set(path,{kind:'file',...(bytes?{bytes:Buffer.from(bytes)}:{content}),mtime});return this.entry(path)}
  async route(route){
    const request=route.request();assert.equal(request.method(),'POST');assert.equal(new URL(request.url()).pathname,'/api/accounts/preview/files')
    const body=request.postDataJSON();assert.equal(Object.hasOwn(body,'accountId'),false)
    if(Object.hasOwn(body,'path')){assert.equal(typeof body.path,'string');assert.ok(body.path.isWellFormed());assert.ok(Buffer.byteLength(body.path,'utf8')<=4096);assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/.test(body.path),false);assert.equal(body.path.startsWith('/'),false);if(body.path!=='')assert.equal(body.path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.trash'),false)}
    this.calls.push(clone(body))
    const gate=this.gates.find(item=>!item.started&&item.op===body.op&&item.path===body.path)
    let result,status=200
    if(body.op==='list'){
      result={entries:[...this.records.keys()].filter(path=>parent(path)===body.path).map(path=>this.entry(path))}
      if(this.mode==='wrong-list')result.entries.push({...this.entry('alpha.txt'),name:'foreign.txt',path:'docs/deep/foreign.txt'})
    }else if(body.op==='read'){
      if(!this.records.has(body.path)){status=404;result={error:'not_found',stateChanged:false}}
      else {result=this.text(body.path);if(this.mode==='wrong-read')result={...result,path:body.path==='alpha.txt'?'beta.txt':'alpha.txt'};if(this.mode==='missing-read')delete result.content}
    }else if(body.op==='write'||body.op==='put-bytes'){
      if(this.mode==='refused'){status=403;result={error:'refused',stateChanged:false}}
      else if(this.mode==='unknown-403'){status=403;result={error:'dispatched_write_failed'}}
      else if(this.mode==='network'){return route.abort('failed')}
      else if(body.overwrite===false&&this.records.has(body.path)){status=409;result={error:'already_exists',stateChanged:false}}
      else {
        result=body.op==='write'?this.write(body.path,body.content):this.write(body.path,undefined,Buffer.from(body.contentBase64,'base64'))
        if(this.mode==='wrong-ack')result={...result,name:'wrong.txt',path:'wrong.txt'}
        if(this.mode==='readback-mismatch'){this.records.get(body.path).content='Different content after dispatch\n';this.mode=null}
      }
    }else if(body.op==='mkdir'){
      this.records.set(body.path,{kind:'directory',mtime:initialTime});result=this.entry(body.path)
    }else if(body.op==='get-bytes'){
      const row=this.records.get(body.path);assert.equal(row?.kind,'file');const bytes=row.bytes??Buffer.from(row.content,'utf8')
      result={path:body.path,contentBase64:bytes.toString('base64'),sizeBytes:bytes.length,mtime:row.mtime}
      if(this.mode==='bad-base64')result.contentBase64='-_invalid'
    }else if(body.op==='trash'){
      const entry=this.entry(body.path);result={id:`00000000-0000-4000-8000-${String(++this.serial).padStart(12,'0')}`,originalPath:body.path,name:entry.name,sizeBytes:entry.sizeBytes,deletedAt:initialTime};this.trash.push({...result,record:this.records.get(body.path)});this.records.delete(body.path)
    }else if(body.op==='list-trash')result={items:this.trash.map(({record,...item})=>item)}
    else if(body.op==='empty-trash'){result={removed:this.trash.length};this.trash=[]}
    else if(body.op==='restore'){const item=this.trash.find(item=>item.id===body.trashId);assert.ok(item);this.records.set(item.originalPath,item.record);this.trash=this.trash.filter(row=>row!==item);result=this.entry(item.originalPath)}
    else if(body.op==='chmod')result={...this.entry(body.path),mode:body.mode}
    else throw new Error('Unexpected mock file operation')
    if(gate){gate.started=true;gate.entered();await gate.promise;if(gate.failure){status=503;result={error:'stale_read_failure',stateChanged:false}}}
    await route.fulfill({status,json:result})
  }
}

async function mockSession(page,model){
  await page.addInitScript(()=>{
    const transport=async(method,path,body)=>{const response=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'mock_file_error'),{status:response.status,details:result});return result}
    Object.defineProperty(window,'xpanelSessionRequest',{get:()=>transport,set:()=>{},configurable:false})
    const read=Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer=function(){if(this instanceof File&&window.__holdFileRead)return new Promise((resolve,reject)=>{window.__resumeFileRead=()=>read.call(this).then(resolve,reject)});return read.call(this)}
  })
  await page.route('**/api/accounts/*/files',async route=>{try{await model.route(route)}catch(error){model.errors.push(String(error));await route.fulfill({status:500,json:{error:'mock_contract_failure',unknownOutcome:true,verificationRequired:true}})}})
}

const rootSelector='[data-file-manager="browse"]'
const editorSelector='#jailed-code-editor'
const rowAction=(page,kind,path)=>page.locator(`[data-file-workspace-action="${kind}"][data-path="${path}"]`)
const toolbar=(page,action)=>page.locator(`${rootSelector} [data-action="${action}"]`)
const editor=page=>page.locator(editorSelector)
const settle=page=>page.waitForFunction(()=>{const root=document.querySelector('[data-file-manager="browse"]');return root?.getAttribute('aria-busy')==='false'&&root?.getAttribute('data-file-loading')==='false'})
const state=async(page,wanted)=>{await settle(page);await page.waitForFunction(wanted=>document.querySelector('[data-file-status]')?.getAttribute('data-state')===wanted,wanted)}
const selected=page=>page.locator('[data-file-selected-path]').textContent()
const current=page=>page.locator('[data-file-current-path]').textContent()
async function entered(gate){let timer;try{await Promise.race([gate.startedPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected held RPC did not start')),10000)})])}finally{clearTimeout(timer)}}
async function releaseReply(page,gate){const response=page.waitForResponse(response=>{if(!response.url().endsWith('/files'))return false;try{const body=response.request().postDataJSON();return body.op===gate.op&&body.path===gate.path}catch{return false}});gate.release();const result=await response;await result.finished();await page.evaluate(()=>new Promise(requestAnimationFrame))}
async function confirmation(page,accept){await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await page.locator(accept?'[data-xp-prompt-confirm]':'[data-xp-prompt-cancel]').click()}
async function reload(page){await toolbar(page,'reload-file').click();if(await page.locator('[data-xp-prompt-confirm]').isVisible())await confirmation(page,true);await state(page,'read')}

async function geometry(page){
  await page.evaluate(()=>document.fonts.ready)
  return page.locator(rootSelector).evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const visible=node=>{const r=rect(node);return r.width>0&&r.height>0&&!node.closest('[hidden]')&&!node.classList.contains('xp-sr-only')}
    const fields=[...root.querySelectorAll('label[for]')].filter(visible).map(label=>{
      const control=document.getElementById(label.htmlFor);if(!control||!visible(control)||['checkbox','radio'].includes(control.type))return null
      const range=document.createRange();range.selectNodeContents(label);const text=range.getBoundingClientRect(),box=rect(control),style=getComputedStyle(control),rtl=getComputedStyle(root).direction==='rtl'
      const anchor=style.textAlign==='start'?(style.direction==='rtl'?'right':'left'):style.textAlign==='end'?(style.direction==='rtl'?'left':'right'):style.textAlign
      const edge=anchor==='right'?box.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth):anchor==='left'?box.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth):(box.left+box.right)/2
      return {label:label.textContent.trim(),code:control.id==='jailed-code-editor',gap:box.top-text.bottom,alignment:Math.abs((rtl?text.right:text.left)-edge),height:box.height,direction:style.direction,textAlign:style.textAlign,resolvedAnchor:anchor,whiteSpace:style.whiteSpace,wrap:control.getAttribute('wrap')}
    }).filter(Boolean)
    const cards=[root,...root.querySelectorAll('.xp-card')].filter(visible).map(card=>{
      const nodes=[...card.children].filter(node=>node.tagName!=='STYLE'&&visible(node)),first=rect(nodes[0]),last=rect(nodes.at(-1)),bounds=rect(card),style=getComputedStyle(card)
      return {left:first.left-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-first.right-parseFloat(style.borderRightWidth),top:first.top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-last.bottom-parseFloat(style.borderBottomWidth)}
    })
    const gap=nodes=>nodes.slice(1).map((node,index)=>rect(node).top-rect(nodes[index]).bottom)
    const editorGroups=gap([...root.querySelector('.xp-file-editor-body').children].filter(visible))
    const fieldSiblings=[...root.querySelectorAll('.xp-form-group')].flatMap(group=>gap([...group.children].filter(node=>node.classList.contains('xp-field')&&visible(node))))
    const main=root.closest('.xp-panel-detail__main'),sections=main?gap([...main.children].filter(visible)):[]
    const table=root.querySelector('[data-file-manager-table]'),wrap=table.parentElement
    const technical=[...table.querySelectorAll('tbody bdi')].filter(visible).map(node=>{const range=document.createRange();range.selectNodeContents(node);return {lines:new Set([...range.getClientRects()].map(r=>Math.round(r.y))).size,direction:getComputedStyle(node).direction,isolation:getComputedStyle(node).unicodeBidi}})
    const targets=[...root.querySelectorAll('button,input:not([type=file]),textarea')].filter(visible).map(node=>{
      const words=[]
      if(node.tagName==='BUTTON'){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))for(const match of text.textContent.matchAll(/\S+/gu)){const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);const tops=[...range.getClientRects()].map(r=>r.top).sort((a,b)=>a-b),threshold=Math.max(8,(parseFloat(getComputedStyle(node).lineHeight)||22)/2);let lines=0,last=-Infinity;for(const top of tops)if(top-last>threshold){lines++;last=top}words.push({text:match[0],lines})}}
      return {type:node.type,box:rect(node),words}
    })
    const paths=[...root.querySelectorAll('[data-file-current-path],[data-file-selected-path]')].map(node=>({direction:getComputedStyle(node).direction,isolation:getComputedStyle(node).unicodeBidi}))
    const prefix=[...root.querySelectorAll('.xp-breadcrumb bdi')].find(node=>node.textContent===root.dataset.accountHome),relative=root.querySelector('[data-file-current-path]')
    const breadcrumb=prefix&&relative?{prefix:rect(prefix),current:rect(relative)}:null
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,direction:getComputedStyle(root).direction,fields,cards,editorGroups,fieldSiblings,sections,table:{width:rect(table).width,wrap:rect(wrap).width,scrollWidth:wrap.scrollWidth,technical},targets,paths,breadcrumb,fonts:{status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,status:face.status}))}}
  })
}
function assertGeometry(value,lang,width){
  assert.equal(value.direction,lang==='ar'?'rtl':'ltr');assert.ok(value.scrollWidth<=width+1,'No page overflow')
  assert.ok(value.fields.length>=2,'Editor and permission labels measured')
  for(const field of value.fields){assert.ok(Math.abs(field.gap-8)<=1,`Actual label gap ${field.label}: ${field.gap}`);if(field.code){assert.equal(field.direction,'ltr','Code direction');assert.equal(field.resolvedAnchor,'left','Code starts at the left to preserve indentation')}else assert.ok(field.alignment<=1,`Actual content alignment ${field.label}: ${field.alignment}`);assert.ok(field.height>=43.5)}
  for(const card of value.cards)for(const padding of Object.values(card))assert.ok(Math.abs(padding-(width<600?16:24))<=1,`Card padding ${padding}`)
  for(const distance of value.editorGroups)assert.ok(Math.abs(distance-24)<=1,`Editor group gap ${distance}`)
  for(const distance of value.fieldSiblings)assert.ok(Math.abs(distance-16)<=1,`Sibling field gap ${distance}`)
  for(const distance of value.sections)assert.ok(Math.abs(distance-32)<=1,`Major section gap ${distance}`)
  for(const target of value.targets){assert.ok(target.box.width>=43.5&&target.box.height>=43.5,'Actual control target');for(const word of target.words)assert.ok(word.lines<=1,`Button word is not broken across lines: ${word.text}`)}
  assert.ok(value.breadcrumb,'Compound path components measured');assert.ok(Math.abs(value.breadcrumb.prefix.top-value.breadcrumb.current.top)<=1,'Compound path stays on one line');assert.ok(value.breadcrumb.prefix.right<=value.breadcrumb.current.left+1,'Compound path preserves LTR component order')
  for(const token of [...value.paths,...value.table.technical]){assert.equal(token.direction,'ltr');assert.ok(token.isolation.includes('isolate'))}
  for(const token of value.table.technical)assert.ok(token.lines<=1,'Technical table values stay readable on one line')
  assert.ok(value.table.wrap<=width+1,'Table overflow stays in its wrapper')
}

mkdirSync(output,{recursive:true})
const before=snapshot(),fixture=await createVisualFixture({qualifiedCatalog:true}),browser=await chromium.launch({headless:true})
const runtime={node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version}
const cases=[]
let checkpoint='start',activePage,activeModel,measured
try{
 for(const lang of ['en','ar'])for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockFiles(),pageErrors=[]
  page.on('pageerror',error=>pageErrors.push(`${error.name}: ${error.message}`));activePage=page;activeModel=model;measured=null
  await mockSession(page,model);checkpoint=`${lang}-${width}:initial-unread-list`;model.mode='wrong-list'
  await page.goto(`${fixture.baseUrl}/files/manager?lang=${lang}&theme=light`,{waitUntil:'load'});await state(page,'failed')
  assert.equal(await page.locator(rootSelector).getAttribute('data-file-read'),'false')
  const unreadText=await page.locator('[data-file-manager-table] tbody').textContent();assert.equal(/empty|فارغ/i.test(unreadText),false,'Unverified initial listing is not presented as empty');assert.equal(await page.locator('[data-file-path="docs/deep/foreign.txt"]').count(),0)
  model.mode=null;await toolbar(page,'refresh-files').click();await state(page,'read')
  assert.equal(await page.locator(rootSelector).getAttribute('data-file-read'),'true')
  assert.equal(await page.locator('[data-file-path="link"] button').count(),0,'Symlinks have no edit/open/write actions')
  assert.equal(await page.locator('[data-file-path="تقرير.txt"]').count(),1)
  checkpoint=`${lang}-${width}:late-directory`
  const oldDirectory=model.hold('list','docs');await rowAction(page,'directory','docs').click();await entered(oldDirectory)
  await rowAction(page,'directory','assets').click();await state(page,'read');assert.equal(await current(page),'assets')
  await releaseReply(page,oldDirectory);await settle(page);assert.equal(await current(page),'assets');assert.equal(await page.locator('[data-file-path="docs/note.txt"]').count(),0)
  await toolbar(page,'parent-directory').click();await state(page,'read')
  checkpoint=`${lang}-${width}:late-file`
  const oldRead=model.hold('read','alpha.txt');oldRead.failure=true;await rowAction(page,'open','alpha.txt').click();await entered(oldRead)
  await rowAction(page,'open','beta.txt').click();await state(page,'read');await releaseReply(page,oldRead);await state(page,'read')
  assert.equal(await selected(page),'beta.txt');assert.equal(await editor(page).inputValue(),'Beta original\n')
  checkpoint=`${lang}-${width}:edit-during-read`
  const pendingRead=model.hold('read','alpha.txt');await rowAction(page,'open','alpha.txt').click();await entered(pendingRead)
  await editor(page).fill(capturedCodeDraft);await releaseReply(page,pendingRead);await settle(page)
  assert.equal(await selected(page),'beta.txt');assert.equal(await editor(page).inputValue(),capturedCodeDraft)
  checkpoint=`${lang}-${width}:dirty-dialog-cancel`
  const callsBeforeDialog=model.calls.length;await rowAction(page,'directory','docs').click();await page.locator('[data-xp-prompt-cancel]').waitFor({state:'visible'})
  assert.equal(await page.locator(rootSelector).getAttribute('aria-busy'),'true');assert.equal(await editor(page).getAttribute('readonly')!==null,true)
  assert.equal(await toolbar(page,'save-file').isDisabled(),true)
  await toolbar(page,'parent-directory').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  await confirmation(page,false);await settle(page);assert.equal(model.calls.length,callsBeforeDialog);assert.equal(await editor(page).inputValue(),capturedCodeDraft)
  checkpoint=`${lang}-${width}:geometry`
  measured=await geometry(page);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${output}/${lang}-${width}.png`,fullPage:true});assertGeometry(measured,lang,width)
  checkpoint=`${lang}-${width}:captured-save`
  await editor(page).evaluate(node=>{node.dataset.editorPath='alpha.txt'})
  const pendingWrite=model.hold('write','beta.txt');await toolbar(page,'save-file').click();await entered(pendingWrite)
  assert.equal(await editor(page).getAttribute('readonly')!==null,true);assert.equal(await toolbar(page,'save-file').isDisabled(),true)
  await editor(page).evaluate(node=>{node.value='DOM edit during dispatch';node.dispatchEvent(new Event('input',{bubbles:true}))})
  await releaseReply(page,pendingWrite);await state(page,'saved');assert.equal(model.records.get('beta.txt').content,capturedCodeDraft);assert.equal(model.records.get('alpha.txt').content,'Alpha original\n');assert.equal(await editor(page).inputValue(),capturedCodeDraft)
  checkpoint=`${lang}-${width}:pending-directory-edit`
  const pendingDirectory=model.hold('list','docs');await rowAction(page,'directory','docs').click();await entered(pendingDirectory)
  await editor(page).fill('Beta draft while directory is pending\n');await releaseReply(page,pendingDirectory);await settle(page)
  assert.equal(await current(page),'.');assert.equal(await selected(page),'beta.txt');assert.equal(await editor(page).inputValue(),'Beta draft while directory is pending\n')
  await toolbar(page,'save-file').click();await state(page,'saved')
  checkpoint=`${lang}-${width}:pre-read-conflict`
  await editor(page).fill('Local conflicting draft\n');model.write('beta.txt','External synthetic change\n')
  const writesBeforeConflict=model.calls.filter(body=>body.op==='write').length
  await toolbar(page,'save-file').click();await state(page,'conflict');assert.equal(model.calls.filter(body=>body.op==='write').length,writesBeforeConflict);assert.equal(await editor(page).inputValue(),'Local conflicting draft\n')
  await toolbar(page,'reload-file').click();await confirmation(page,false);await settle(page);assert.equal(await editor(page).inputValue(),'Local conflicting draft\n')
  await reload(page);assert.equal(await editor(page).inputValue(),'External synthetic change\n')
  checkpoint=`${lang}-${width}:unknown-and-review`
  await editor(page).fill('Uncertain beta draft\n');model.mode='unknown-403';await toolbar(page,'save-file').click();await state(page,'uncertain')
  assert.equal(await toolbar(page,'save-file').isDisabled(),true);assert.equal(await editor(page).inputValue(),'Uncertain beta draft\n')
  model.mode=null;await toolbar(page,'refresh-files').click();await state(page,'reviewed');assert.equal(await editor(page).inputValue(),'Uncertain beta draft\n')
  assert.equal((await page.locator('[data-file-status]').textContent()).includes('Operation acknowledged'),false)
  await reload(page)
  checkpoint=`${lang}-${width}:malformed-write-ack`
  await editor(page).fill('Written but malformed ack\n');model.mode='wrong-ack';await toolbar(page,'save-file').click();await state(page,'uncertain');assert.equal(await editor(page).inputValue(),'Written but malformed ack\n')
  model.mode=null;await toolbar(page,'refresh-files').click();await state(page,'reviewed');await reload(page)
  checkpoint=`${lang}-${width}:mismatched-readback`
  await editor(page).fill('Expected readback text\n');model.mode='readback-mismatch';await toolbar(page,'save-file').click();await state(page,'uncertain');assert.equal(await editor(page).inputValue(),'Expected readback text\n')
  await toolbar(page,'refresh-files').click();await state(page,'reviewed');await reload(page)
  checkpoint=`${lang}-${width}:refused-write`
  await editor(page).fill('Refused beta draft\n');model.mode='refused';await toolbar(page,'save-file').click();await state(page,'failed');assert.equal(await page.locator(rootSelector).getAttribute('data-file-uncertain'),'false');assert.equal(await editor(page).inputValue(),'Refused beta draft\n');model.mode=null
  checkpoint=`${lang}-${width}:utf8-refusal`
  let callCount=model.calls.length
  await editor(page).evaluate(node=>{node.value='é'.repeat(524289);node.dispatchEvent(new Event('input',{bubbles:true}))});await toolbar(page,'save-file').click();await state(page,'failed');assert.equal(model.calls.length,callCount)
  await editor(page).evaluate(node=>{node.value=String.fromCharCode(0xd800);node.dispatchEvent(new Event('input',{bubbles:true}))});await toolbar(page,'save-file').click();await state(page,'failed');assert.equal(model.calls.length,callCount)
  await editor(page).fill('Draft after invalid text\n');await reload(page)
  checkpoint=`${lang}-${width}:malformed-read-and-list`
  const priorContent=await editor(page).inputValue();model.mode='wrong-read';await rowAction(page,'open','alpha.txt').click();await state(page,'failed');assert.equal(await editor(page).inputValue(),priorContent);assert.equal(await selected(page),'beta.txt')
  model.mode='missing-read';await rowAction(page,'open','alpha.txt').click();await state(page,'failed');assert.equal(await editor(page).inputValue(),priorContent);assert.equal(await selected(page),'beta.txt')
  model.mode='wrong-list';await toolbar(page,'refresh-files').click();await state(page,'failed');assert.equal(await page.locator('[data-file-path="docs/deep/foreign.txt"]').count(),0);model.mode=null;await toolbar(page,'refresh-files').click();await state(page,'read')
  checkpoint=`${lang}-${width}:captured-row-path`
  await rowAction(page,'open','alpha.txt').evaluate(button=>{button.dataset.path='../escape.txt';button.click()});await state(page,'read');assert.equal(await selected(page),'alpha.txt');assert.equal(model.calls.at(-1).path,'alpha.txt')
  await page.locator('[data-file-path="alpha.txt"] [data-file-workspace-action="open"]').evaluate(button=>{button.dataset.path='alpha.txt'})
  checkpoint=`${lang}-${width}:create-context-and-leaf`
  await rowAction(page,'directory','docs').click();await state(page,'read')
  await toolbar(page,'new-file').click();await page.locator('[data-xp-prompt-input]').fill('../escape.txt');callCount=model.calls.length;await confirmation(page,true);await state(page,'failed');assert.equal(model.calls.length,callCount)
  await toolbar(page,'new-file').click();await page.locator('[data-xp-prompt-input]').fill('\u2028unsafe.txt');callCount=model.calls.length;await confirmation(page,true);await state(page,'failed');assert.equal(model.calls.length,callCount,'Raw leaf control is refused without transport')
  await toolbar(page,'new-file').click();await page.locator('[data-xp-prompt-input]').fill('new-note.txt');assert.equal(await page.locator(rootSelector).getAttribute('aria-busy'),'true');await toolbar(page,'parent-directory').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));await confirmation(page,true);await state(page,'saved')
  const createCall=model.calls.find(body=>body.op==='write'&&body.path==='docs/new-note.txt');assert.equal(createCall?.overwrite,false)
  await toolbar(page,'new-folder').click();await page.locator('[data-xp-prompt-input]').fill('new-folder');await confirmation(page,true);await state(page,'saved');assert.equal(model.records.get('docs/new-folder').kind,'directory')
  checkpoint=`${lang}-${width}:upload-context`
  await page.evaluate(()=>{window.__holdFileRead=true})
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),toolbar(page,'upload-file').click()])
  await chooser.setFiles({name:'upload.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0,1,255])})
  await page.waitForFunction(()=>typeof window.__resumeFileRead==='function')
  assert.equal(await page.locator(rootSelector).getAttribute('aria-busy'),'true');await toolbar(page,'parent-directory').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  await page.locator('[data-file-current-path]').evaluate(node=>{node.textContent='assets'})
  await page.evaluate(()=>{window.__holdFileRead=false;window.__resumeFileRead()});await state(page,'saved')
  const uploadCall=model.calls.find(body=>body.op==='put-bytes');assert.equal(uploadCall.path,'docs/upload.bin');assert.equal(uploadCall.overwrite,false);assert.deepEqual([...model.records.get('docs/upload.bin').bytes],[0,1,255])
  checkpoint=`${lang}-${width}:download`
  const [download]=await Promise.all([page.waitForEvent('download'),rowAction(page,'download','docs/upload.bin').click()]);assert.equal(download.suggestedFilename(),'upload.bin');const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.deepEqual([...Buffer.concat(chunks)],[0,1,255]);await settle(page)
  let downloads=0;page.on('download',()=>downloads++);model.mode='bad-base64';await rowAction(page,'download','docs/upload.bin').click();await state(page,'failed');assert.equal(downloads,0);model.mode=null
  checkpoint=`${lang}-${width}:late-download-error`
  const oldDownload=model.hold('get-bytes','docs/upload.bin');model.mode='bad-base64';await rowAction(page,'download','docs/upload.bin').click();await entered(oldDownload)
  await rowAction(page,'directory','docs/new-folder').click();await state(page,'read');model.mode=null;await releaseReply(page,oldDownload);await state(page,'read');assert.equal(await current(page),'docs/new-folder');assert.equal(downloads,0)
  await toolbar(page,'parent-directory').click();await state(page,'read')
  checkpoint=`${lang}-${width}:trash-and-empty`
  await rowAction(page,'trash','docs/upload.bin').click();await confirmation(page,false);await settle(page);assert.equal(model.records.has('docs/upload.bin'),true)
  await rowAction(page,'trash','docs/upload.bin').click();await confirmation(page,true);await state(page,'saved');assert.equal(model.records.has('docs/upload.bin'),false);assert.equal(model.trash.length,1)
  await toolbar(page,'empty-trash').click();await confirmation(page,true);await state(page,'saved');assert.equal(model.trash.length,0)
  await rowAction(page,'directory','docs/new-folder').click();await state(page,'read');assert.equal(await page.locator('[data-file-manager-table] tbody [data-file-path]').count(),0);assert.equal(await page.locator(rootSelector).getAttribute('data-file-read'),'true')
  assert.deepEqual(model.errors,[]);assert.deepEqual(pageErrors,[])
  cases.push({lang,width,status:'passed',geometry:measured,calls:model.calls,pageErrors,checks:['late file and directory replies','editing invalidates pending reads','dirty confirmation cancellation and lock','captured immutable save path','fresh pre-read conflict','exact ack/readback and uncertainty review','UTF8 and malformed path/reply refusal','symlink read-only','create/upload overwrite false and initiating directory','validated binary download','trash and empty-trash preserved']})
  await context.close()
 }
 checkpoint='unqualified-and-non-browse'
 const unqualified=await createVisualFixture({qualifiedCatalog:false})
 try{const page=await browser.newPage();const ops=[];await page.route('**/api/accounts/*/files',route=>{ops.push(route.request().postDataJSON()?.op);return route.fulfill({status:503,json:{error:'unexpected_request'}})});await page.goto(`${unqualified.baseUrl}/files/manager?lang=en`,{waitUntil:'load'});assert.equal(ops.length,0);await page.goto(`${fixture.baseUrl}/files/trash?lang=en`,{waitUntil:'load'});await page.locator('[data-file-manager="trash"] [data-file-status]').waitFor({state:'visible'});assert.ok(ops.every(op=>op==='list-trash'));cases.push({status:'passed',scope:'unqualified and trash',checks:['unqualified browse sends no transport','trash sends only its own list-trash read, never a mutation']});await page.close()}finally{await unqualified.close()}
}catch(error){const diagnostic=activePage&&!activePage.isClosed()?await activePage.evaluate(()=>({bound:document.querySelector('[data-file-manager="browse"]')?.getAttribute('data-file-workspace-bound'),busy:document.querySelector('[data-file-manager="browse"]')?.getAttribute('aria-busy'),loading:document.querySelector('[data-file-manager="browse"]')?.getAttribute('data-file-loading'),status:document.querySelector('[data-file-status]')?.textContent,state:document.querySelector('[data-file-status]')?.getAttribute('data-state'),selected:document.querySelector('[data-file-selected-path]')?.textContent,current:document.querySelector('[data-file-current-path]')?.textContent})):undefined;cases.push({status:'failed',checkpoint,error:String(error),diagnostic,geometry:measured,mockErrors:activeModel?.errors});process.exitCode=1}
finally{for(const gate of activeModel?.gates??[])gate.release();await browser.close();await fixture.close();const after=snapshot(),result={at:new Date().toISOString(),runtime,scope:'Actual renderer/client/dialogs with mocked session/file RPC. No native filesystem identity, confinement, quota, kernel, hosting or production proof. Fresh pre-read is not atomic server CAS and cannot exclude an external writer between read and write. Full reference runtime/font parity is unverified.',sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,cases};if(!result.sourceUnchanged)process.exitCode=1;writeFileSync(`${output}/results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({status:process.exitCode?'failed':'passed',cases:cases.length,output}))}
