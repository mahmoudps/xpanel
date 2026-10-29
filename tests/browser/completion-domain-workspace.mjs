// Real Domains renderer/client/dialogs with explicit mock session and HTTP.
// No real domain provisioning, DNS/TLS/runtime, recovery or authentication proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { domainToASCII } from 'node:url'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium }=await import('@playwright/test')
const output=resolve(process.env.XPANEL_DOMAIN_WORKSPACE_OUTPUT||'test-results/completion-domain-workspace')
const sourcePaths=['apps/web/src/domain-workspace-client.ts','apps/web/src/board-port/extensions/account-domains.ts','apps/web/src/surfaces/xpanel.ts','apps/web/src/board-port/approved-xpanel-workspaces.ts','apps/web/src/board-port/approved-xpanel-pages.ts','apps/web/src/ws-client.ts','apps/web/src/login-client.ts','apps/web/src/board-port/extensions/shared.ts','tests/browser/visual-fixture.mjs','tests/browser/completion-domain-workspace.mjs']
const snapshot=()=>sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))
const copy=value=>JSON.parse(JSON.stringify(value))
const accountId='visual-account',home='/home/preview',api='/api/domains'
const rootSelector='[data-domain-workspace]'
const createForm=page=>page.locator('[data-domain-create]')
const createField=(page,name)=>createForm(page).locator('[name="'+name+'"]')
const settingsForm=page=>page.locator('[data-domain-settings-form]')
const rootInput=page=>settingsForm(page).locator('[name=docRoot]')
const action=(page,name)=>page.locator(rootSelector+' [data-domain-'+name+']')
const settings=(page,id)=>page.locator('[data-domain-settings="'+id+'"]')
const remove=(page,id)=>page.locator('[data-domain-remove="'+id+'"]')
const writes=model=>model.calls.filter(call=>call.method!=='GET')
const primaryId='primary-domain',leafId='leaf-domain'
const primaryName='preview.example.test'
const php={version:'8.3',handler:'fpm',fpm:{mode:'ondemand',maxChildren:4,startServers:1,minSpareServers:1,maxSpareServers:2,maxRequests:500,processIdleTimeoutSec:10},ini:{}}
const record=(id,name,kind,parentId=null,docRoot=home+'/domains/'+name+'/public_html')=>({id,accountId,name,kind,parentId,docRoot,siteType:'php',upstream:null,redirect:null,php:copy(php),wildcard:false,certificateId:null,suspended:false,expiresAt:null,pathQuotaMb:'unlimited',ipv4:'192.0.2.42',ipv6:'2001:db8::42'})
const canonicalName=raw=>{
  assert.equal(typeof raw,'string');assert.ok(raw.length>0&&!/[\s\u0000-\u001f\u007f-\u009f/\\:@?#]/u.test(raw),'Raw name must not be trimmed or repaired')
  const result=domainToASCII(raw).toLowerCase();assert.ok(result);return result
}
// Existing validator canonicalizes accepted supplied roots; requests remain raw.
const canonicalRoot=raw=>{
  assert.equal(typeof raw,'string');assert.ok(raw.length>0&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/u.test(raw))
  assert.ok(!raw.split('/').some(part=>part==='..'||part==='.'))
  if(raw.startsWith('/')){assert.ok(raw===home||raw.startsWith(home+'/'));return raw}
  return home+'/'+raw
}

class MockDomains{
  constructor(){
    const primary=record(primaryId,primaryName,'primary',null,home+'/public_html')
    this.records=new Map([
      [primary.id,primary],
      ['addon-domain',record('addon-domain','shop.example.test','addon')],
      ['subdomain-domain',record('subdomain-domain','blog.'+primaryName,'subdomain',primary.id)],
      ['alias-domain',{...record('alias-domain','alias.example.test','alias',primary.id,primary.docRoot),php:copy(primary.php)}],
      [leafId,record(leafId,'leaf.example.test','addon')],
      ['mail-domain',record('mail-domain','mail.example.test','addon')],
    ])
    this.dependencies=new Map([['mail-domain',1]])
    this.limits={addonDomains:8,aliasDomains:5,subdomains:20}
    this.nextId=1;this.calls=[];this.errors=[];this.mode=null;this.gates=[];this.race=false;this.nextReadMismatch=false
  }
  removals(){
    return [...this.records.values()].map(domain=>{const childCount=[...this.records.values()].filter(row=>row.parentId===domain.id).length,serviceUserCount=this.dependencies.get(domain.id)||0;return {domainId:domain.id,childCount,serviceUserCount,canRemove:domain.kind!=='primary'&&childCount===0&&serviceUserCount===0}})
  }
  get revision(){return createHash('sha256').update(JSON.stringify({context:{accountId,home},limits:this.limits,domains:[...this.records.values()].sort((a,b)=>a.id.localeCompare(b.id)),removals:this.removals().sort((a,b)=>a.domainId.localeCompare(b.domainId))})).digest('hex')}
  view(){return {context:{accountId,home},domains:copy([...this.records.values()]),revision:this.revision,limits:copy(this.limits),removals:this.removals(),application:{status:'unverified',targetVerified:false}}}
  externalRoot(id,value){this.records.get(id).docRoot=value}
  hold(method){let entered,release;const gate={method,started:false,enteredPromise:new Promise(resolve=>{entered=resolve}),promise:new Promise(resolve=>{release=resolve}),entered:()=>entered(),release:()=>release()};this.gates.push(gate);return gate}
  async route(route){
    const request=route.request(),method=request.method(),url=new URL(request.url()),id=url.pathname.startsWith(api+'/')?decodeURIComponent(url.pathname.slice(api.length+1)):null
    assert.ok(url.pathname===api||id);assert.equal(url.search,'');assert.ok(['GET','POST','PATCH','DELETE'].includes(method))
    const body=method==='GET'?undefined:request.postDataJSON();this.calls.push({method,path:url.pathname,...(body===undefined?{}:{body:copy(body)})})
    const gate=this.gates.find(gate=>gate.method===method&&!gate.started),observed=this.view()
    if(gate){gate.started=true;gate.entered();await gate.promise}
    let status=200,result
    if(method==='GET'){
      assert.equal(id,null);result=observed
      if(this.mode==='foreign-context')result.context.accountId='foreign-account'
      if(this.mode==='foreign-home')result.context.home='/home/foreign'
      if(this.mode==='foreign-row')result.domains[0].accountId='foreign-account'
      if(this.mode==='newline-revision')result.revision+='\n'
      if(this.mode==='malformed-view')delete result.removals
      if(this.mode==='false-native-proof')result.application.targetVerified=true
      if(this.nextReadMismatch){this.nextReadMismatch=false;result.domains.find(row=>row.id===leafId).docRoot=home+'/different-readback'}
    }else{
      assert.equal(typeof body.expectedRevision,'string');assert.equal(body.expectedRevision.length,64);assert.match(body.expectedRevision,/^[0-9a-f]{64}$/)
      assert.equal(Object.hasOwn(body,'accountId'),false);assert.equal(Object.hasOwn(body,'home'),false)
      if(this.race){this.race=false;this.externalRoot(leafId,home+'/racing-writer')}
      if(body.expectedRevision!==this.revision){status=409;result={code:'stale_revision',details:{stateChanged:false}}}
      else if(this.mode==='explicit-refusal'){status=422;result={code:'domain_update_refused',details:{stateChanged:false}}}
      else if(this.mode==='restored-review'){status=500;result={code:'domain_projection_failed',details:{stateChanged:false,verificationRequired:true}}}
      else{
        let changed
        if(method==='POST'){
          assert.equal(id,null);assert.ok(['addon','subdomain','alias'].includes(body.kind))
          assert.ok(Object.keys(body).every(key=>['name','kind','parentId','docRoot','siteType','expectedRevision'].includes(key)))
          const name=canonicalName(body.name);assert.ok(![...this.records.values()].some(row=>row.name===name))
          const parent=body.parentId?this.records.get(body.parentId):null
          if(body.kind==='addon')assert.ok(body.parentId==null)
          else{assert.ok(parent&&parent.kind!=='alias');if(body.kind==='subdomain')assert.ok(name.endsWith('.'+parent.name))}
          if(body.kind==='alias'){assert.equal(Object.hasOwn(body,'docRoot'),false);assert.equal(Object.hasOwn(body,'siteType'),false)}
          const newId='created-domain-'+this.nextId++,docRoot=body.kind==='alias'?parent.docRoot:body.docRoot?canonicalRoot(body.docRoot):home+'/domains/'+name+'/public_html'
          changed=record(newId,name,body.kind,parent?.id||null,docRoot)
          if(body.kind==='alias'){changed.php=copy(parent.php);changed.siteType=parent.siteType;changed.upstream=parent.upstream;changed.redirect=parent.redirect}
          else if(body.siteType){assert.ok(['php','static'].includes(body.siteType));changed.siteType=body.siteType}
          this.records.set(changed.id,changed);status=201
        }else if(method==='PATCH'){
          assert.deepEqual(Object.keys(body).sort(),['docRoot','expectedRevision']);changed=this.records.get(id);assert.ok(changed&&changed.kind!=='alias')
          changed.docRoot=canonicalRoot(body.docRoot)
          for(const row of this.records.values())if(row.kind==='alias'&&row.parentId===changed.id){row.docRoot=changed.docRoot;row.php=copy(changed.php);row.siteType=changed.siteType;row.upstream=changed.upstream;row.redirect=changed.redirect}
        }else{
          assert.deepEqual(Object.keys(body).sort(),['confirmName','expectedRevision']);changed=this.records.get(id);assert.ok(changed)
          const removal=this.removals().find(row=>row.domainId===id)
          if(changed.kind==='primary'||!removal.canRemove){status=412;result={code:'domain_has_dependencies',details:{stateChanged:false}}}
          else{assert.equal(body.confirmName,changed.name);this.records.delete(id)}
        }
        if(!result){
          result={...this.view(),application:{status:'not_requested',targetVerified:false},stateChanged:true,...(method==='DELETE'?{ok:true,removed:{id:changed.id,name:changed.name}}:{domain:copy(changed)})}
          if(this.mode==='unknown-write'){status=500;result={code:'domain_outcome_unknown',details:{stateChanged:true,unknownOutcome:true,verificationRequired:true}}}
          if(this.mode==='unknown-403'){status=403;result={code:'permission_denied_after_dispatch',details:{}}}
          if(this.mode==='foreign-ack')result.context.accountId='foreign-account'
          if(this.mode==='wrong-domain-ack'&&method!=='DELETE')result.domain={...result.domain,id:'wrong-ack-id'}
          if(this.mode==='readback-mismatch')this.nextReadMismatch=true
        }
      }
    }
    if(status>=400)result={type:'about:blank',title:'Synthetic domain request refused',status,detail:'Synthetic domain request failure',instance:url.pathname,...result}
    await route.fulfill({status,json:result})
  }
}
async function mockSession(page,model){
  await page.addInitScript(()=>{
    const transport=async(method,path,body)=>{
      const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),data=await response.json().catch(()=>null)
      if(!data||typeof data!=='object')throw new Error('mock_unexpected_domain_response')
      // Exact login-client requestJson problem normalization; authentication is mocked.
      if(!response.ok){const problem=data.error||data;throw Object.assign(new Error(problem.message||problem.detail||'mock_domain_error'),{status:response.status,code:problem.code,details:problem.details||{}})}
      return data
    }
    Object.defineProperty(window,'xpanelSessionRequest',{get:()=>transport,set:()=>{},configurable:false})
  })
  await page.route('**/api/domains',handle);await page.route('**/api/domains/*',handle)
  async function handle(route){try{await model.route(route)}catch(error){model.errors.push(String(error));await route.fulfill({status:500,json:{type:'about:blank',title:'Synthetic mock failure',status:500,code:'mock_contract_failure',details:{unknownOutcome:true,verificationRequired:true}}})}}
}
async function state(page,wanted){
  await page.waitForFunction(wanted=>{const root=document.querySelector('[data-domain-workspace]');return root?.querySelector('[data-domain-status]')?.getAttribute('data-state')===wanted&&!root.querySelector('[data-domain-refresh]')?.disabled},wanted)
}
async function entered(gate){let timer;try{await Promise.race([gate.enteredPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected held domain request did not start')),10000)})])}finally{clearTimeout(timer)}}
async function releaseReply(page,gate){const response=page.waitForResponse(response=>new URL(response.url()).pathname.startsWith(api)&&response.request().method()===gate.method);gate.release();await(await response).finished();await page.evaluate(()=>new Promise(requestAnimationFrame))}
async function confirmation(page,accept){await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await page.locator(accept?'[data-xp-prompt-confirm]':'[data-xp-prompt-cancel]').click()}
async function reload(page){
  const response=page.waitForResponse(response=>new URL(response.url()).pathname===api&&response.request().method()==='GET')
  await action(page,'reload').click();await confirmation(page,true);await(await response).finished();await state(page,'read')
}
async function create(page,{name,kind='addon',parentId,docRoot='',siteType='php'}){
  await createField(page,'kind').selectOption(kind);await createField(page,'name').fill(name)
  if(kind!=='addon')await createField(page,'parentId').selectOption(parentId)
  if(kind!=='alias'){await createField(page,'docRoot').fill(docRoot);await createField(page,'siteType').selectOption(siteType)}
  await action(page,'create-submit').click()
}
async function selectSettings(page,id){
  const response=page.waitForResponse(response=>new URL(response.url()).pathname===api&&response.request().method()==='GET')
  await settings(page,id).click();await(await response).finished();await state(page,'read')
}
async function editRoot(page,id,value){await selectSettings(page,id);await rootInput(page).fill(value);await action(page,'save-root').click()}
async function openRemoval(page,id){
  const menu=page.locator('[data-domain-id="'+id+'"] details')
  if(!await menu.evaluate(node=>node.open))await menu.locator('summary').click()
  await remove(page,id).click()
}

async function geometry(page){
  await page.evaluate(()=>document.fonts.ready)
  return page.locator(rootSelector).evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const visible=node=>{const r=rect(node);return r.width>0&&r.height>0&&!node.closest('[hidden]')}
    const gap=nodes=>nodes.slice(1).map((node,index)=>rect(node).top-rect(nodes[index]).bottom)
    const fields=[...root.querySelectorAll('label[for]')].filter(visible).map(label=>{
      const control=document.getElementById(label.htmlFor);if(!control||!visible(control)||['checkbox','radio'].includes(control.type))return null
      const range=document.createRange();range.selectNodeContents(label);const text=range.getBoundingClientRect(),box=rect(control),style=getComputedStyle(control),rtl=getComputedStyle(root).direction==='rtl'
      const anchor=style.textAlign==='start'?(style.direction==='rtl'?'right':'left'):style.textAlign==='end'?(style.direction==='rtl'?'left':'right'):style.textAlign
      const edge=anchor==='right'?box.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth):box.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth)
      return {label:label.textContent.trim(),gap:box.top-text.bottom,alignment:Math.abs((rtl?text.right:text.left)-edge),height:box.height,direction:style.direction,textAlign:style.textAlign,resolvedAnchor:anchor}
    }).filter(Boolean)
    const cardDiagnostics=[]
    const cards=[...root.querySelectorAll('.xp-extension__card')].filter(visible).map((card,index)=>{
      const nodes=[...card.children].filter(node=>node.tagName!=='STYLE'&&visible(node)),first=rect(nodes[0]),last=rect(nodes.at(-1)),bounds=rect(card),style=getComputedStyle(card)
      const childStyle=getComputedStyle(nodes.at(-1)),steps=card.querySelector('ol.xp-domain-steps'),stepsStyle=steps?getComputedStyle(steps):null
      cardDiagnostics.push({index,heading:card.querySelector('h2')?.textContent,computedPadding:{top:style.paddingTop,right:style.paddingRight,bottom:style.paddingBottom,left:style.paddingLeft},lastChild:{tag:nodes.at(-1).tagName,className:nodes.at(-1).className,marginTop:childStyle.marginTop,marginBottom:childStyle.marginBottom},steps:stepsStyle?{marginTop:stepsStyle.marginTop,marginBottom:stepsStyle.marginBottom,paddingInlineStart:stepsStyle.paddingInlineStart,fontSize:stepsStyle.fontSize}:null})
      return {left:first.left-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-first.right-parseFloat(style.borderRightWidth),top:first.top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-last.bottom-parseFloat(style.borderBottomWidth)}
    })
    const groups=[...root.querySelectorAll('.xp-domain-form')].flatMap(group=>gap([...group.children].filter(visible)))
    const fieldSiblings=[...root.querySelectorAll('[data-domain-field-group]')].flatMap(group=>{
      const fields=[...group.children].filter(node=>node.classList.contains('xp-field')&&visible(node))
      return fields.slice(1).map((node,index)=>{const a=rect(fields[index]),b=rect(node),sameRow=Math.abs(a.top-b.top)<=1;return {axis:sameRow?'horizontal':'vertical',gap:sameRow?Math.max(a.left,b.left)-Math.min(a.right,b.right):b.top-a.bottom}})
    })
    const sections=gap([...root.children].filter(node=>node.tagName!=='STYLE'&&visible(node)))
    const table=root.querySelector('[data-domain-table]'),wrap=table.parentElement
    const technical=[...table.querySelectorAll('tbody bdi')].filter(visible).map(node=>{const range=document.createRange();range.selectNodeContents(node);const tops=[...range.getClientRects()].map(r=>r.top),style=getComputedStyle(node);return {text:node.textContent,lines:new Set(tops.map(top=>Math.round(top))).size,direction:style.direction,isolation:style.unicodeBidi,whiteSpace:style.whiteSpace,overflowWrap:style.overflowWrap,wordBreak:style.wordBreak}})
    const humanWords=[],humanWalker=document.createTreeWalker(table.tBodies[0],NodeFilter.SHOW_TEXT)
    let humanText
    while((humanText=humanWalker.nextNode())){
      const node=humanText.parentElement;if(!node||node.closest('bdi')||!visible(node))continue
      const closed=node.closest('details:not([open])');if(closed&&!closed.querySelector('summary')?.contains(node))continue
      for(const match of humanText.textContent.matchAll(/\S+/gu)){
        const range=document.createRange();range.setStart(humanText,match.index);range.setEnd(humanText,match.index+match[0].length)
        const tops=[...range.getClientRects()].map(r=>r.top).sort((a,b)=>a-b),threshold=Math.max(8,(parseFloat(getComputedStyle(node).lineHeight)||22)/2)
        let lines=0,last=-Infinity;for(const top of tops)if(top-last>threshold){lines++;last=top}
        humanWords.push({text:match[0],lines,rowId:node.closest('[data-domain-id]')?.getAttribute('data-domain-id'),cell:node.closest('td')?.cellIndex})
      }
    }
    const targets=[...root.querySelectorAll('button,summary,input:not([type=checkbox]):not([type=radio]),select')].filter(visible).map(node=>{
      const words=[]
      if(['BUTTON','SUMMARY'].includes(node.tagName)){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))for(const match of text.textContent.matchAll(/\S+/gu)){const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);const tops=[...range.getClientRects()].map(r=>r.top).sort((a,b)=>a-b),threshold=Math.max(8,(parseFloat(getComputedStyle(node).lineHeight)||22)/2);let lines=0,last=-Infinity;for(const top of tops)if(top-last>threshold){lines++;last=top}words.push({text:match[0],lines})}}
      return {box:rect(node),words}
    })
    const choices=[...root.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(visible).map(control=>{
      const label=control.closest('label')||[...root.querySelectorAll('label[for]')].find(label=>label.htmlFor===control.id)
      return {control:rect(control),label:label?rect(label):null}
    })
    const tableStyle=getComputedStyle(table)
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,direction:getComputedStyle(root).direction,fields,cards,cardDiagnostics,groups,fieldSiblings,sections,targets,choices,table:{width:rect(table).width,wrap:rect(wrap).width,scrollWidth:wrap.scrollWidth,computed:{minInlineSize:tableStyle.minInlineSize,minWidth:tableStyle.minWidth,width:tableStyle.width,tableLayout:tableStyle.tableLayout},technical,humanWords,role:wrap.getAttribute('role'),tabIndex:wrap.tabIndex,label:wrap.getAttribute('aria-label')||wrap.getAttribute('aria-labelledby'),headers:table.querySelectorAll('thead th').length},application:root.querySelector('[data-domain-application]')?.textContent,fonts:{status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,status:face.status}))}}
  })
}
function assertGeometry(g,lang,width){
  assert.equal(g.direction,lang==='ar'?'rtl':'ltr');assert.ok(g.scrollWidth<=width+1,'No page overflow');assert.ok(g.fields.length>=4,'Actual create/settings fields measured')
  for(const field of g.fields){assert.ok(Math.abs(field.gap-8)<=1,'Label text gap '+field.label+': '+field.gap);assert.ok(field.alignment<=1,'Field value anchor '+field.label+': '+field.alignment);assert.ok(field.height>=43.5)}
  assert.ok(g.cards.length>0,'Card content padding measured');for(const card of g.cards)for(const value of Object.values(card))assert.ok(Math.abs(value-(width<600?16:24))<=1,'Card padding '+value)
  assert.ok(g.groups.length>0,'Actual groups measured');for(const value of g.groups)assert.ok(Math.abs(value-24)<=1,'Group gap '+value)
  for(const value of g.fieldSiblings)assert.ok(Math.abs(value.gap-16)<=1,'Sibling field '+value.axis+' gap '+value.gap)
  assert.ok(g.sections.length>0,'Major sections measured');for(const value of g.sections)assert.ok(Math.abs(value-32)<=1,'Section gap '+value)
  for(const target of g.targets){assert.ok(target.box.width>=43.5&&target.box.height>=43.5,'Actual control target');for(const word of target.words)assert.ok(word.lines<=1,'Intact action word '+word.text)}
  assert.ok(g.choices.length>=2,'Preserved choice controls measured')
  for(const choice of g.choices){const realTarget=choice.label||choice.control;assert.ok(realTarget.width>=43.5&&realTarget.height>=43.5,'Real associated choice label/control target, never a union')}
  for(const token of g.table.technical){assert.equal(token.direction,'ltr');assert.ok(token.isolation.includes('isolate'));assert.ok(token.lines<=1,'Technical table values stay intact')}
  assert.ok(g.table.humanWords.length>0,'Human table labels measured')
  for(const word of g.table.humanWords)assert.ok(word.lines<=1,'Human table word stays intact: '+word.text+' (column '+word.cell+')')
  assert.ok(g.table.technical.length>0,'Technical values measured');assert.ok(g.table.headers>=8,'Preserved rich table columns')
  assert.equal(g.table.role,'region');assert.ok(g.table.tabIndex>=0&&g.table.label,'Labelled keyboard-reachable table scroll region');assert.ok(g.table.wrap<=width+1,'Contained table viewport')
}

mkdirSync(output,{recursive:true})
const before=snapshot(),fixture=await createVisualFixture({qualifiedCatalog:true}),browser=await chromium.launch({headless:true})
const runtime={node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version}
const cases=[]
let checkpoint='start',activePage,activeModel,measured,settingsMeasured
try{
  for(const lang of ['en','ar'])for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockDomains(),pageErrors=[]
    activePage=page;activeModel=model;measured=null;settingsMeasured=null;page.on('pageerror',error=>pageErrors.push(error.name+': '+error.message))
    await mockSession(page,model);model.mode='foreign-context';checkpoint=lang+'-'+width+':first-context-pin'
    await page.goto(fixture.baseUrl+'/domains?lang='+lang+'&theme=light',{waitUntil:'load'});await state(page,'failed');assert.equal(writes(model).length,0)
    model.mode=null;await action(page,'refresh').click();await state(page,'read')
    assert.equal(await page.locator('[data-domain-rows] [data-domain-id]').count(),model.records.size)
    assert.equal(await page.locator('[data-domain-primary-rename]').count(),1)
    assert.ok((await page.locator('[data-domain-advanced-unavailable]').textContent()).trim().length>0)
    assert.equal(await page.locator('[data-domain-primary-rename]').evaluate(card=>{const controls=[...card.querySelectorAll('input,select,button')];return controls.length>=3&&controls.every(control=>control.disabled||control.readOnly)}),true,'Primary rename components remain explicitly unavailable')
    assert.equal(await page.locator('[data-domain-native-options]').evaluate(card=>{const controls=[...card.querySelectorAll('input,select,button')];return controls.length>=2&&controls.every(control=>control.disabled||control.readOnly)}),true,'Advanced native options stay unavailable')
    assert.equal(await remove(page,primaryId).count()===0||await remove(page,primaryId).isDisabled(),true)
    assert.equal(await remove(page,'mail-domain').count()===0||await remove(page,'mail-domain').isDisabled(),true)
    checkpoint=lang+'-'+width+':geometry'
    await createField(page,'name').fill('Mixed.Addon.EXAMPLE.TEST')
    await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>new Promise(requestAnimationFrame))
    measured=await geometry(page)
    await page.screenshot({path:output+'/'+lang+'-'+width+'.png',fullPage:true})
    assertGeometry(measured,lang,width)
    checkpoint=lang+'-'+width+':create-addon'
    await action(page,'create-submit').click();await state(page,'saved')
    const addon=[...model.records.values()].find(row=>row.name==='mixed.addon.example.test');assert.ok(addon)
    const firstCreate=model.calls.find(call=>call.method==='POST');assert.equal(firstCreate.body.name,'Mixed.Addon.EXAMPLE.TEST');assert.equal(addon.docRoot,home+'/domains/mixed.addon.example.test/public_html')
    checkpoint=lang+'-'+width+':create-subdomain'
    await create(page,{name:'docs.'+primaryName,kind:'subdomain',parentId:primaryId,docRoot:'sites/docs',siteType:'static'});await state(page,'saved')
    const sub=[...model.records.values()].find(row=>row.name==='docs.'+primaryName);assert.equal(sub.parentId,primaryId);assert.equal(sub.docRoot,home+'/sites/docs');assert.equal(sub.siteType,'static')
    assert.equal((await page.locator('[data-domain-id="'+sub.id+'"] td').nth(5).textContent()).trim(),lang==='ar'?'غير مستخدم':'Not used');assert.deepEqual(sub.php,php,'Static mode retains dormant PHP configuration without claiming it is active')
    checkpoint=lang+'-'+width+':create-alias'
    await create(page,{name:'ALIAS.MIXED.EXAMPLE.TEST',kind:'alias',parentId:addon.id});await state(page,'saved')
    const alias=[...model.records.values()].find(row=>row.name==='alias.mixed.example.test');assert.equal(alias.parentId,addon.id);assert.equal(alias.docRoot,addon.docRoot);assert.deepEqual(alias.php,addon.php)
    checkpoint=lang+'-'+width+':root-alias-fanout'
    await editRoot(page,primaryId,'sites/new-primary-root');await state(page,'saved');assert.equal(model.records.get(primaryId).docRoot,home+'/sites/new-primary-root');assert.equal(model.records.get('alias-domain').docRoot,home+'/sites/new-primary-root')
    await editRoot(page,addon.id,home+'/sites/absolute-addon');await state(page,'saved');assert.equal(model.records.get(addon.id).docRoot,home+'/sites/absolute-addon');assert.equal(model.records.get(alias.id).docRoot,home+'/sites/absolute-addon')
    await selectSettings(page,'alias-domain');assert.equal(await rootInput(page).isEditable(),false)
    checkpoint=lang+'-'+width+':settings-geometry'
    await selectSettings(page,leafId)
    await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>new Promise(requestAnimationFrame))
    settingsMeasured=await geometry(page)
    await page.screenshot({path:output+'/'+lang+'-'+width+'-settings.png',fullPage:true})
    assertGeometry(settingsMeasured,lang,width)
    checkpoint=lang+'-'+width+':pending-read-draft'
    const pending=model.hold('GET');await action(page,'refresh').click();await entered(pending)
    await rootInput(page).fill('sites/typed-during-refresh');await releaseReply(page,pending);await state(page,'read');assert.equal(await rootInput(page).inputValue(),'sites/typed-during-refresh')
    checkpoint=lang+'-'+width+':dirty-refresh-CAS'
    model.externalRoot('addon-domain',home+'/external-root');const oldWrites=writes(model).length
    await action(page,'refresh').click();await state(page,'stale');assert.equal(await rootInput(page).inputValue(),'sites/typed-during-refresh')
    await action(page,'save-root').click();await state(page,'stale');assert.equal(writes(model).length,oldWrites)
    const selectionCalls=model.calls.length;await settings(page,'addon-domain').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'})
    assert.equal(await rootInput(page).isEditable(),false);await confirmation(page,false);await state(page,'stale')
    assert.equal(model.calls.length,selectionCalls,'Cancelled dirty selection makes no new read or mutation');assert.equal(await rootInput(page).inputValue(),'sites/typed-during-refresh')
    assert.equal((await page.locator('[data-domain-selected-name]').textContent()).trim(),model.records.get(leafId).name)
    const beforeCancel=model.calls.length;await action(page,'reload').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});assert.equal(await rootInput(page).isEditable(),false)
    await confirmation(page,false);assert.equal(model.calls.length,beforeCancel);assert.equal(await rootInput(page).inputValue(),'sites/typed-during-refresh')
    await reload(page)
    checkpoint=lang+'-'+width+':dispatched-CAS-race'
    model.race=true;await editRoot(page,leafId,'sites/CAS-draft');await state(page,'failed');assert.equal(await rootInput(page).inputValue(),'sites/CAS-draft');assert.equal(model.records.get(leafId).docRoot,home+'/racing-writer');await reload(page)
    checkpoint=lang+'-'+width+':raw-create-refusal'
    const rawCount=model.calls.length;await create(page,{name:' unsafe.example.test',kind:'addon'});await state(page,'failed');assert.equal(await createField(page,'name').inputValue(),' unsafe.example.test');assert.equal(model.calls.length,rawCount);await reload(page)
    checkpoint=lang+'-'+width+':explicit-refusal'
    model.mode='explicit-refusal';await editRoot(page,leafId,'sites/refused');await state(page,'failed');assert.equal(await rootInput(page).inputValue(),'sites/refused');model.mode=null;await reload(page)
    for(const mode of ['restored-review','unknown-write','unknown-403','foreign-ack','wrong-domain-ack','readback-mismatch']){
      checkpoint=lang+'-'+width+':'+mode;model.mode=mode;const draft='sites/'+mode
      await editRoot(page,leafId,draft);await state(page,'uncertain');assert.equal(await rootInput(page).inputValue(),draft);assert.equal(await action(page,'save-root').isDisabled(),true)
      model.mode=null;const count=writes(model).length;await action(page,'refresh').click();await state(page,'uncertain');assert.equal(writes(model).length,count);assert.equal(await rootInput(page).inputValue(),draft)
      const requests=model.calls.length;await action(page,'reload').click();await confirmation(page,false);assert.equal(model.calls.length,requests);assert.equal(await rootInput(page).inputValue(),draft)
      await reload(page)
    }
    checkpoint=lang+'-'+width+':typed-leaf-remove'
    const removeName=model.records.get(leafId).name,deleteCount=model.calls.filter(call=>call.method==='DELETE').length
    await openRemoval(page,leafId);await page.locator('[data-xp-prompt-input]').fill(removeName+' ');await confirmation(page,true);await state(page,'read');assert.equal(model.calls.filter(call=>call.method==='DELETE').length,deleteCount)
    await openRemoval(page,leafId);await confirmation(page,false);await state(page,'read');assert.equal(model.calls.filter(call=>call.method==='DELETE').length,deleteCount)
    await openRemoval(page,leafId);await page.locator('[data-xp-prompt-input]').waitFor({state:'visible'})
    await remove(page,leafId).evaluate(node=>node.setAttribute('data-domain-remove','addon-domain'))
    await settings(page,'addon-domain').dispatchEvent('click');assert.equal(await action(page,'refresh').isDisabled(),true)
    await page.locator('[data-xp-prompt-input]').fill(removeName);await confirmation(page,true);await state(page,'saved')
    assert.equal(model.records.has(leafId),false);assert.equal(model.records.has('addon-domain'),true)
    const deletion=model.calls.filter(call=>call.method==='DELETE').at(-1);assert.equal(deletion.path,api+'/'+leafId);assert.equal(deletion.body.confirmName,removeName)
    checkpoint=lang+'-'+width+':later-invalid-view'
    for(const mode of ['foreign-context','foreign-home','foreign-row','newline-revision','malformed-view','false-native-proof']){
      model.mode=mode;const count=writes(model).length;await action(page,'refresh').click();await state(page,'failed');assert.equal(writes(model).length,count)
      model.mode=null;await action(page,'refresh').click();await state(page,'read')
    }
    checkpoint=lang+'-'+width+':midflight-qualification'
    await selectSettings(page,'addon-domain');await rootInput(page).fill('sites/qualification-draft')
    const blocked=model.hold('GET'),count=writes(model).length;await action(page,'save-root').click();await entered(blocked)
    await page.locator(rootSelector).evaluate(node=>node.setAttribute('data-capability-unavailable','true'));await releaseReply(page,blocked)
    await page.waitForFunction(()=>!['saving','reading'].includes(document.querySelector('[data-domain-status]')?.getAttribute('data-state')))
    assert.equal(writes(model).length,count);assert.equal(await rootInput(page).inputValue(),'sites/qualification-draft');assert.equal(await action(page,'save-root').isDisabled(),true)
    const midflightState=await action(page,'status').getAttribute('data-state');assert.equal(midflightState,'failed')
    assert.deepEqual(model.errors,[]);assert.deepEqual(pageErrors,[])
    cases.push({lang,width,status:'passed',geometry:measured,settingsGeometry:settingsMeasured,calls:model.calls,pageErrors,midflightState,checks:['context/account/home/view pins','rich row and inline form components','raw addon server canonical/default root','owned subdomain and derived alias creation','root metadata and alias fanout','pending read and dirty baseline preservation','CAS and explicit reload/cancel','known refusal and verification-required/unknown review','exact ACK/readback','typed immutable leaf removal','unqualified dispatch suppression']})
    await context.close()
  }
  checkpoint='unqualified'
  const unqualified=await createVisualFixture({qualifiedCatalog:false})
  try{const page=await browser.newPage();let calls=0;await page.route('**/api/domains**',route=>{calls++;return route.fulfill({status:503,json:{type:'about:blank',status:503,code:'unexpected_domain_request'}})});await page.goto(unqualified.baseUrl+'/domains?lang=en',{waitUntil:'load'});assert.equal(calls,0);cases.push({status:'passed',scope:'unqualified',calls:0,checks:['no domain read or mutation transport']});await page.close()}finally{await unqualified.close()}
}catch(error){
  const diagnostic=activePage&&!activePage.isClosed()?await activePage.evaluate(()=>({status:document.querySelector('[data-domain-status]')?.textContent,state:document.querySelector('[data-domain-status]')?.getAttribute('data-state'),createName:document.querySelector('[data-domain-create] [name=name]')?.value,root:document.querySelector('[data-domain-settings-form] [name=docRoot]')?.value,selected:document.querySelector('[data-domain-selected-name]')?.textContent,confirmationOpen:!!document.querySelector('[data-xp-prompt-confirm]')?.getClientRects().length})):undefined
  cases.push({status:'failed',checkpoint,error:String(error),diagnostic,geometry:measured,settingsGeometry:settingsMeasured,calls:activeModel?.calls,mockErrors:activeModel?.errors});process.exitCode=1
}finally{
  for(const gate of activeModel?.gates??[])gate.release();await browser.close();await fixture.close()
  const after=snapshot(),result={at:new Date().toISOString(),runtime,scope:'Actual domain renderer/client/dialogs with explicit mock session/HTTP. No authenticated tenant, durable index/audit, native provisioning/DNS/TLS/runtime/serving/recovery or production proof. This harness does not establish complete design parity.',sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,cases}
  if(!result.sourceUnchanged)process.exitCode=1
  writeFileSync(output+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:process.exitCode?'failed':'passed',cases:cases.length,output}))
}
