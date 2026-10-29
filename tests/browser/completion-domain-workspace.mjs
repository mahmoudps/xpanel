// Real Domains renderer/client/dialogs with explicit mock session and HTTP.
// No real domain provisioning, DNS/TLS/runtime, recovery or authentication proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { domainToASCII } from 'node:url'
import { createVisualFixture } from './visual-fixture.mjs'
import { translator } from '../../apps/web/src/i18n.ts'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium }=await import('@playwright/test')
const output=resolve(process.env.XPANEL_DOMAIN_WORKSPACE_OUTPUT||'test-results/completion-domain-workspace')
const scope=process.env.XPANEL_DOMAIN_WORKSPACE_SCOPE||'all'
assert.ok(['all','domains','reverse-proxy'].includes(scope),'Known domain browser scope')
const selectedTuple=process.env.XPANEL_DOMAIN_WORKSPACE_TUPLE||''
assert.ok(!selectedTuple||scope==='reverse-proxy'&&/^(en|ar):(390|1440):(light|dark)$/.test(selectedTuple),'A focused tuple requires the reverse-proxy scope')
const includesTuple=(lang,width,theme)=>!selectedTuple||selectedTuple===lang+':'+width+':'+theme
const sourcePaths=['apps/web/src/domain-workspace-client.ts','apps/web/src/account-reverse-proxy-client.ts','apps/web/src/board-port/account-reverse-proxy-workspace.ts','apps/web/src/board-port/account-ssh-workspace.ts','apps/web/src/board-port/extensions/account-domains.ts','apps/web/src/surfaces/xpanel.ts','apps/web/src/board-port/approved-xpanel-workspaces.ts','apps/web/src/board-port/approved-xpanel-pages.ts','apps/web/src/app.ts','apps/web/src/tokens.ts','apps/web/src/i18n.ts','apps/web/src/locales/ar.po','apps/web/src/ws-client.ts','apps/web/src/login-client.ts','apps/web/src/board-port/extensions/shared.ts','tests/browser/visual-fixture.mjs','tests/browser/completion-domain-workspace.mjs']
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
const proxyAccountId='11111111-1111-4111-8111-111111111111'
const proxyRoot='[data-reverse-proxy]'
const proxyDefaultOptions={websocket:true,hostHeader:'client',headers:[]}
class MockReverseProxy extends MockDomains{
  constructor(){
    super()
    const primary=record(primaryId,primaryName,'primary',null,home+'/public_html')
    const parent=record('proxy-parent','shop.example.test','addon')
    const alias=record('proxy-alias','mirror.example.test','alias',parent.id,parent.docRoot)
    this.records=new Map([primary,parent,alias,{...record('proxy-node','node.example.test','addon'),siteType:'node',upstream:'http://127.0.0.1:3001'},
      {...record('proxy-redirect','moved.example.test','addon'),redirect:{to:'https://example.test/',code:301}}].map(row=>[row.id,{...row,accountId:proxyAccountId}]))
    this.applied=false;this.readVersion=0
  }
  get revision(){return createHash('sha256').update(JSON.stringify({context:{accountId:proxyAccountId,home},rows:[...this.records.values()],version:this.readVersion})).digest('hex')}
  view(){return {context:{accountId:proxyAccountId,home},domains:copy([...this.records.values()]),revision:this.revision,limits:copy(this.limits),removals:this.removals(),application:{status:'unverified',targetVerified:false}}}
  async route(route){
    const request=route.request(),method=request.method(),url=new URL(request.url()),body=method==='GET'?undefined:request.postDataJSON()
    assert.equal(url.search,'');assert.ok(method==='GET'&&url.pathname===api||method==='PUT'&&url.pathname===api+'/'+primaryId+'/reverse-proxy','Only the selected proxy endpoint is mocked')
    this.calls.push({method,path:url.pathname,...(body===undefined?{}:{body:copy(body)})})
    const gate=this.gates.find(gate=>gate.method===method&&!gate.started),observed=this.view()
    if(gate){gate.started=true;gate.entered();await gate.promise}
    let status=200,result
    if(method==='GET'){
      if(this.mode==='read-failed'){status=503;result={code:'domain_read_failed',details:{stateChanged:false}}}
      else result=observed
    }else{
      const proxy=body.siteType==='proxy'
      assert.deepEqual(Object.keys(body).sort(),(proxy?['expectedRevision','proxy','siteType','upstream']:['expectedRevision','siteType']).sort())
      assert.match(body.expectedRevision,/^[0-9a-f]{64}$/);assert.ok(['proxy','php','static'].includes(body.siteType))
      if(proxy){assert.equal(typeof body.upstream,'string');assert.deepEqual(Object.keys(body.proxy).sort(),['headers','hostHeader','websocket']);assert.equal(typeof body.proxy.websocket,'boolean');assert.ok(['client','upstream'].includes(body.proxy.hostHeader));assert.ok(Array.isArray(body.proxy.headers)&&body.proxy.headers.length<=8)}
      if(body.expectedRevision!==this.revision){status=409;result={code:'stale_revision',details:{stateChanged:false}}}
      else if(this.mode==='refused'){status=422;result={code:'invalid_proxy',details:{stateChanged:false,fields:[{field:'upstream',code:'reserved_port'}]}}}
      else if(this.mode==='uncertain'){status=503;result={code:'proxy_outcome_unknown',details:{stateChanged:true,verificationRequired:true,unknownOutcome:true}}}
      else{
        const previous=this.records.get(primaryId),changed={...previous,siteType:body.siteType,upstream:proxy?body.upstream:null}
        delete changed.proxy
        if(proxy&&JSON.stringify(body.proxy)!==JSON.stringify(proxyDefaultOptions))changed.proxy=copy(body.proxy)
        this.records.set(primaryId,changed)
        result={...this.view(),domain:copy(changed),stateChanged:true,application:{status:this.applied?'global_configuration_applied':'not_requested',targetVerified:false},
          reconcile:this.applied?{status:'applied',generation:{id:7,status:'active',checksum:'c'.repeat(64)},filesCount:2,durationMs:1}:null}
      }
    }
    if(status>=400)result={type:'about:blank',title:'Synthetic proxy request refused',status,detail:'Synthetic reverse proxy request failure',instance:url.pathname,...result}
    await route.fulfill({status,json:result})
  }
}
function proxyFixtureState({state},active=true){
  state.accountId=proxyAccountId
  state.visibility={...state.visibility,principal:{...state.visibility.principal,accountId:proxyAccountId}}
  state.panel={...state.panel,account:{...state.panel.account,id:proxyAccountId,status:active?'active':'suspended'},domains:new MockReverseProxy().view().domains}
  return state
}
async function mockSession(page,model,{reverseProxy=false}={}){
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
  if(reverseProxy)await page.route('**/api/domains/*/reverse-proxy',handle)
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

async function proxyGeometry(page){
  await page.evaluate(()=>document.fonts.ready)
  return page.locator(proxyRoot).evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const visible=node=>node.checkVisibility()&&rect(node).width>0&&rect(node).height>0
    const children=node=>[...node.children].filter(child=>child.tagName!=='STYLE'&&visible(child))
    const rtl=getComputedStyle(root).direction==='rtl',edge=r=>rtl?r.right:r.left
    const textRects=node=>{const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),boxes=[];let text;while((text=walker.nextNode())){if(!text.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(text);for(const r of range.getClientRects())if(r.width>0&&r.height>0)boxes.push({left:r.left,right:r.right,top:r.top,bottom:r.bottom})}return boxes}
    const lineEdges=boxes=>{const lines=[];for(const box of boxes){let line=lines.find(line=>box.top<line.bottom-0.5&&box.bottom>line.top+0.5);if(!line){line={...box};lines.push(line)}else{line.left=Math.min(line.left,box.left);line.right=Math.max(line.right,box.right);line.top=Math.min(line.top,box.top);line.bottom=Math.max(line.bottom,box.bottom)}}return lines.map(edge)}
    const siblings=nodes=>nodes.slice(1).map((node,index)=>{const a=rect(nodes[index]),b=rect(node),sameRow=Math.abs(a.top-b.top)<=1;return {axis:sameRow?'horizontal':'vertical',gap:sameRow?Math.max(a.left,b.left)-Math.min(a.right,b.right):b.top-a.bottom}})
    const words=node=>{const output=[],walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode())){if(!visible(text.parentElement))continue;for(const match of text.textContent.matchAll(/\S+/gu)){const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);const tops=[...range.getClientRects()].map(r=>r.top).sort((a,b)=>a-b),lineHeight=parseFloat(getComputedStyle(text.parentElement).lineHeight)||22;let lines=0,last=-Infinity;for(const top of tops)if(top-last>Math.max(8,lineHeight/2)){lines++;last=top}output.push({text:match[0],lines})}}return output}
    const fields=[...root.querySelectorAll('label[for]')].filter(visible).map(label=>{
      const control=document.getElementById(label.htmlFor);if(!control||!visible(control))return null
      const labels=textRects(label),box=rect(control),style=getComputedStyle(control),anchor=style.textAlign==='start'?(style.direction==='rtl'?'right':'left'):style.textAlign==='end'?(style.direction==='rtl'?'left':'right'):style.textAlign
      const labelEdge=rtl?Math.max(...labels.map(r=>r.right)):Math.min(...labels.map(r=>r.left)),valueEdge=anchor==='right'?box.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth):box.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth)
      return {label:label.textContent.trim(),gap:box.top-Math.max(...labels.map(r=>r.bottom)),alignment:Math.abs(labelEdge-valueEdge),height:box.height,direction:style.direction,textAlign:style.textAlign}
    }).filter(Boolean)
    const cards=[...root.querySelectorAll(':scope > .xp-acct-tool__card')].filter(visible).map(card=>{
      const nodes=children(card),bounds=rect(card),style=getComputedStyle(card),heading=textRects(nodes[0]),headingEdge=rtl?Math.max(...heading.map(r=>r.right)):Math.min(...heading.map(r=>r.left))
      const clipped=(box,node)=>{const viewport=node.closest('.xp-acct-tool__table');if(!viewport)return box;const clip=rect(viewport);return {...box,left:Math.max(box.left,clip.left),right:Math.min(box.right,clip.right)}}
      const paint=[...card.querySelectorAll('h2,p,li,dt,dd,label,span,bdi')].filter(visible).flatMap(node=>textRects(node).map(box=>clipped(box,node))).concat([...card.querySelectorAll('input,select,button')].filter(visible).map(node=>clipped(rect(node),node))).filter(box=>box.right>box.left)
      const paintLeft=Math.min(...paint.map(box=>box.left)),paintRight=Math.max(...paint.map(box=>box.right))
      const contentEnds=[...card.querySelectorAll('.xp-acct-tool__table,input:not([type=checkbox]),select,[data-rp-warning]')].filter(node=>visible(node)&&!node.closest('.xp-acct-tool__table input')).map(node=>({kind:node.tagName,edge:rtl?rect(node).left:rect(node).right})),furthestEnd=contentEnds.length?(rtl?Math.min(...contentEnds.map(item=>item.edge)):Math.max(...contentEnds.map(item=>item.edge))):null
      return {heading:nodes[0].textContent.trim(),top:rect(nodes[0]).top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-rect(nodes.at(-1)).bottom-parseFloat(style.borderBottomWidth),inlineStart:rtl?bounds.right-parseFloat(style.borderRightWidth)-headingEdge:headingEdge-bounds.left-parseFloat(style.borderLeftWidth),paintInsets:{left:paintLeft-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-parseFloat(style.borderRightWidth)-paintRight},inlineEnd:furthestEnd===null?null:rtl?furthestEnd-bounds.left-parseFloat(style.borderLeftWidth):bounds.right-parseFloat(style.borderRightWidth)-furthestEnd,contentEndKinds:contentEnds.map(item=>item.kind),computedPadding:[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft].map(parseFloat),groups:siblings(nodes)}
    })
    const facts=[...root.querySelectorAll('.xp-acct-tool__facts > div')].map(field=>{
      const label=field.querySelector('dt'),value=field.querySelector('dd'),labels=textRects(label),values=textRects(value),labelEdge=rtl?Math.max(...labels.map(r=>r.right)):Math.min(...labels.map(r=>r.left))
      return {label:label.textContent.trim(),value:value.textContent.trim(),gap:rect(value).top-rect(label).bottom,glyphEdges:lineEdges(values).map(valueEdge=>Math.abs(labelEdge-valueEdge)),isolates:[...value.querySelectorAll('bdi')].map(node=>({direction:getComputedStyle(node).direction,isolation:getComputedStyle(node).unicodeBidi}))}
    })
    const tables=[...root.querySelectorAll('.xp-acct-tool__table')].filter(visible).map(wrap=>({box:rect(wrap),table:rect(wrap.querySelector('table')),role:wrap.getAttribute('role'),tabIndex:wrap.tabIndex,label:wrap.getAttribute('aria-label')||wrap.getAttribute('aria-labelledby'),headers:wrap.querySelectorAll('thead th').length,
      technical:[...wrap.querySelectorAll('tbody bdi')].filter(visible).map(node=>({text:node.textContent,className:node.className,direction:getComputedStyle(node).direction,isolation:getComputedStyle(node).unicodeBidi,whiteSpace:getComputedStyle(node).whiteSpace,overflowWrap:getComputedStyle(node).overflowWrap,words:words(node),lines:new Set(textRects(node).map(r=>Math.round(r.top))).size})),human:[...wrap.querySelectorAll('tbody td')].flatMap(cell=>[...cell.children].filter(node=>node.tagName!=='BDI').flatMap(words))}))
    const choices=[...root.querySelectorAll('input[type=checkbox]')].filter(visible).map(control=>{const label=control.closest('label'),texts=textRects(label),box=rect(control);return {box,label:rect(label),gap:rtl?box.left-Math.max(...texts.map(r=>r.right)):Math.min(...texts.map(r=>r.left))-box.right,words:words(label)}})
    const targets=[...root.querySelectorAll('button,input:not([type=checkbox]),select')].filter(visible).map(node=>({box:rect(node),words:node.tagName==='BUTTON'?words(node):[]}))
    const wrapper=root.closest('[data-approved-xpanel-workspace]'),header=wrapper.querySelector(':scope > header'),heading=header.querySelector('h1'),lede=header.querySelector('p'),dialog=document.querySelector('[data-xp-prompt][open]')
    const prompt=dialog?{box:rect(dialog),groups:siblings(children(dialog.querySelector('form'))),headerGap:rect(dialog.querySelector('[data-xp-prompt-body]')).top-rect(dialog.querySelector('[data-xp-prompt-title]')).bottom,buttons:[...dialog.querySelectorAll('button')].filter(visible).map(node=>({box:rect(node),words:words(node)})),footer:siblings(children(dialog.querySelector('.xp-dialog__footer')))}:null
    return {direction:getComputedStyle(root).direction,scrollWidth:document.documentElement.scrollWidth,headingGap:rect(lede).top-rect(heading).bottom,majorGap:rect(root).top-rect(header).bottom,sections:siblings(children(root)),fields,cards,facts,tables,choices,targets,prompt,
      fieldSiblings:[...root.querySelectorAll('.xp-acct-tool__fields,[data-rp-options],.xp-acct-tool__facts')].filter(visible).flatMap(group=>siblings(children(group))),asciiDigits:!/[\u0660-\u0669\u06f0-\u06f9]/u.test(wrapper.innerText),state:root.querySelector('[data-rp-status]').dataset.state,text:wrapper.innerText}
  })
}
function assertProxyGeometry(g,lang,width){
  const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1,label+': '+actual)
  assert.equal(g.direction,lang==='ar'?'rtl':'ltr');assert.ok(g.scrollWidth<=width+1,'Proxy document stays contained');assert.equal(g.asciiDigits,true)
  near(g.headingGap,8,'Proxy heading/lede');near(g.majorGap,32,'Proxy header/body');assert.equal(g.cards.length,4)
  for(const section of g.sections)near(section.gap,32,'Proxy major section')
  for(const card of g.cards){const expected=width<=600?16:24;for(const padding of [card.top,card.bottom,card.inlineStart,...card.computedPadding])near(padding,expected,'Proxy card padding '+card.heading);for(const [edge,inset]of Object.entries(card.paintInsets))assert.ok(inset>=expected-1,'Proxy painted '+edge+' content inset '+card.heading+': '+inset);if(card.inlineEnd!==null)near(card.inlineEnd,expected,'Proxy actual control/table/callout inline-end '+card.heading);for(const group of card.groups)near(group.gap,24,'Proxy card group '+card.heading)}
  for(const field of g.fields){near(field.gap,8,'Proxy label gap '+field.label);assert.ok(field.alignment<=1,'Proxy field content edge '+field.label+': '+field.alignment);assert.ok(field.height>=43.5)}
  for(const sibling of g.fieldSiblings)near(sibling.gap,16,'Proxy sibling field '+sibling.axis)
  assert.equal(g.facts.length,3);for(const fact of g.facts){near(fact.gap,8,'Proxy fact gap '+fact.label);for(const edge of fact.glyphEdges)assert.ok(edge<=1,'Proxy fact glyph edge '+fact.label+': '+edge);for(const bdi of fact.isolates){assert.equal(bdi.direction,'ltr');assert.ok(bdi.isolation.includes('isolate'))}}
  for(const table of g.tables){assert.equal(table.role,'region');assert.ok(table.tabIndex>=0&&table.label);assert.ok(table.box.left>=-0.5&&table.box.right<=width+0.5,'Proxy table viewport stays contained');for(const token of table.technical){assert.equal(token.direction,'ltr');assert.ok(token.isolation.includes('isolate'));assert.ok(token.lines<=1,'Proxy technical value stays intact: '+token.text)}for(const word of table.human)assert.ok(word.lines<=1,'Proxy table word stays intact: '+word.text)}
  for(const target of g.targets){assert.ok(target.box.width>=43.5&&target.box.height>=43.5,'Proxy real control target');for(const word of target.words)assert.ok(word.lines<=1,'Proxy action word stays intact: '+word.text)}
  for(const choice of g.choices){assert.ok(choice.label.width>=43.5&&choice.label.height>=43.5,'Proxy associated checkbox label target');near(choice.gap,8,'Proxy checkbox/text separation');for(const word of choice.words)assert.ok(word.lines<=1,'Proxy checkbox word stays intact: '+word.text)}
  if(g.prompt){assert.ok(g.prompt.box.left>=-0.5&&g.prompt.box.right<=width+0.5,'Proxy confirmation contained');near(g.prompt.headerGap,8,'Proxy confirmation heading/body');for(const group of g.prompt.groups)near(group.gap,24,'Proxy confirmation groups');for(const sibling of g.prompt.footer)near(sibling.gap,16,'Proxy confirmation actions');for(const target of g.prompt.buttons){assert.ok(target.box.width>=43.5&&target.box.height>=43.5);for(const word of target.words)assert.ok(word.lines<=1,'Proxy confirmation word stays intact: '+word.text)}}
}
async function proxyState(page,wanted){await page.waitForFunction(wanted=>document.querySelector('[data-rp-status]')?.dataset.state===wanted,wanted)}
async function proxyFailureDiagnostic(page){return page.evaluate(()=>{const root=document.querySelector('[data-reverse-proxy]'),wrapper=root?.closest('[data-approved-xpanel-workspace]');return {url:location.href,readyState:document.readyState,surface:document.documentElement.dataset.surface,workspaceMode:wrapper?.dataset.workspaceMode,wiring:wrapper?.dataset.wiring,account:root?.dataset.rpAccount,home:root?.dataset.rpHome,manage:root?.dataset.rpManage,bound:root?.dataset.rpBound,status:root?.querySelector('[data-rp-status]')?.textContent,state:root?.querySelector('[data-rp-status]')?.dataset.state,transport:typeof window.xpanelSessionRequest,scripts:[...document.scripts].map(script=>({id:script.id,src:script.getAttribute('src')})),text:wrapper?.innerText}}).catch(error=>({url:page.url(),diagnosticError:String(error)}))}
async function runReverseProxyAcceptance(browser,cases){
  const host=await createVisualFixture({qualifiedCatalog:true,transformState:proxyFixtureState}),screens=output+'/reverse-proxy'
  mkdirSync(screens,{recursive:true})
  try{
    for(const lang of ['en','ar'])for(const width of [1440,390])for(const theme of ['light','dark']){
      if(!includesTuple(lang,width,theme))continue
      const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockReverseProxy(),pageErrors=[],frames=[]
      let checkpoint='reading'
      page.on('pageerror',error=>pageErrors.push(error.name+': '+error.message))
      const control=key=>page.locator('[data-rp-'+key+']')
      const capture=async name=>{checkpoint=name;const measured=await proxyGeometry(page);frames.push({state:name,geometry:measured});await page.screenshot({path:screens+'/'+lang+'-'+width+'-'+theme+'-'+name+'.jpg',type:'jpeg',quality:70,fullPage:true});assertProxyGeometry(measured,lang,width);return measured}
      const configureProxy=async()=>{await control('mode').selectOption('proxy');await control('upstream').fill('http://127.0.0.1:3000/app')}
      const approve=async wanted=>{const checking=model.hold('GET');await control('save').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await confirmation(page,true);await entered(checking);await proxyState(page,'saving');await releaseReply(page,checking);await proxyState(page,wanted)}
      try{
        await mockSession(page,model,{reverseProxy:true});const pending=model.hold('GET')
        const response=await page.goto(host.baseUrl+'/domains/reverse-proxy?lang='+lang+'&theme='+theme,{waitUntil:'load'});assert.equal(response.status(),200)
        await entered(pending);await proxyState(page,'reading');await capture('reading');pending.release();await proxyState(page,'read')
        assert.equal(await page.locator('[data-approved-xpanel-workspace="/domains/reverse-proxy"]').getAttribute('data-workspace-mode'),'connected')
        assert.equal(await page.locator(proxyRoot).getAttribute('data-rp-account'),proxyAccountId);assert.equal(await page.locator(proxyRoot).getAttribute('data-rp-manage'),'true')
        assert.equal(await control('rows').locator('tr').count(),5);assert.deepEqual(await control('rows').locator('button').evaluateAll(nodes=>nodes.map(node=>node.disabled)),[false,true,true,true,true]);await capture('loaded')
        await control('rows').locator('tr').first().locator('button').click();assert.equal((await control('selected').textContent()).trim(),primaryName)
        assert.equal(await control('upstream-field').isVisible(),false);await capture('php-selected');await configureProxy()
        await control('websocket').uncheck();await control('host').selectOption('upstream');await control('add-header').click()
        await page.locator('[data-rp-header-field="name"]').fill('X-Tenant');await page.locator('[data-rp-header-field="value"]').fill('shop-1');await capture('proxy-editor')
        const noDispatch=model.calls.length;await control('upstream').fill('http://127.0.0.1:80');await control('save').click();await proxyState(page,'fields')
        assert.equal(model.calls.length,noDispatch);assert.equal(await control('upstream').getAttribute('aria-invalid'),'true');await capture('upstream-error')
        await configureProxy();await page.locator('[data-rp-header-field="name"]').fill('Connection');await control('save').click();await proxyState(page,'fields')
        assert.equal(model.calls.length,noDispatch);assert.equal(await control('headers-error').isVisible(),true);assert.equal((await control('headers-error').textContent()).trim(),translator(lang)('This header is set by the server and cannot be replaced.'));await capture('header-error');await page.locator('[data-rp-header-field="name"]').fill('X-Tenant')
        await control('save').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});assert.equal(writes(model).length,0)
        assert.equal(await control('headers-error').isVisible(),false,'Valid confirmation clears obsolete header validation feedback');assert.equal((await control('headers-error').textContent()).trim(),'')
        assert.equal(await control('status').getAttribute('data-state'),'read');assert.equal(await control('status').getAttribute('role'),'status');assert.equal((await control('status').textContent()).trim(),translator(lang)('Saved domain configuration read.'))
        const review=await capture('confirmation');assert.ok(review.prompt,'Real confirmation is open');await confirmation(page,false);assert.equal(writes(model).length,0)
        assert.equal(await control('upstream').inputValue(),'http://127.0.0.1:3000/app');assert.equal(await page.locator('[data-rp-header-field="name"]').inputValue(),'X-Tenant');assert.equal(await page.locator('[data-rp-header-field="value"]').inputValue(),'shop-1');assert.equal(await control('websocket').isChecked(),false);assert.equal(await control('host').inputValue(),'upstream');await approve('saved')
        assert.deepEqual(writes(model).at(-1).body,{expectedRevision:writes(model).at(-1).body.expectedRevision,siteType:'proxy',upstream:'http://127.0.0.1:3000/app',proxy:{websocket:false,hostHeader:'upstream',headers:[{name:'X-Tenant',value:'shop-1'}]}})
        assert.equal((await control('application').textContent()).trim(),translator(lang)('The server configuration was not applied by this request; the site keeps its previous serving until it is applied.'));await capture('saved-not-applied')
        assert.equal(await control('websocket').isChecked(),false);assert.equal(await control('host').inputValue(),'upstream');assert.equal(await page.locator('[data-rp-header-field="value"]').inputValue(),'shop-1')
        await control('mode').selectOption('php');assert.equal(await control('options').isVisible(),false);const beforePhp=writes(model).length;model.applied=true;await approve('saved')
        assert.equal(writes(model).length,beforePhp+1);assert.deepEqual(writes(model).at(-1).body,{expectedRevision:writes(model).at(-1).body.expectedRevision,siteType:'php'})
        assert.equal((await control('application').textContent()).trim(),translator(lang)('The server configuration was applied as generation {generation}. Whether the site answers through its upstream has not been checked.',{generation:7}));await capture('saved-applied')
        await configureProxy();model.readVersion++;const staleWrites=writes(model).length;await approve('stale');assert.equal(writes(model).length,staleWrites);assert.equal(await control('save').isDisabled(),true);await capture('stale-review')
        await control('refresh').click();await proxyState(page,'read');await configureProxy();model.mode='refused';await approve('fields');await capture('server-refusal')
        model.mode=null;await control('refresh').click();await proxyState(page,'read');await configureProxy();model.mode='uncertain';await approve('uncertain')
        assert.equal(await control('save').isDisabled(),true);const uncertainWrites=writes(model).length;await page.waitForFunction(()=>document.querySelector('[data-reverse-proxy]')?.getAttribute('aria-busy')==='false');assert.equal(writes(model).length,uncertainWrites);await capture('uncertain-review')
        model.mode='read-failed';await control('refresh').click();await proxyState(page,'failed');assert.equal(writes(model).length,uncertainWrites);await capture('read-failed')
        assert.deepEqual(model.errors,[]);assert.deepEqual(pageErrors,[])
        cases.push({scope:'reverse-proxy',lang,width,theme,status:'passed',frames,calls:model.calls,pageErrors,checks:['UUID owner fixture','native connected workspace','loaded and blocked rows','proxy/host/WebSocket/header editor','real confirmation and cancel','saved versus applied readback','local/server error','stale and unknown review','actual spacing, edges, targets, RTL and ASCII']})
      }catch(error){const diagnostic=await proxyFailureDiagnostic(page),screenshotError=await page.screenshot({path:screens+'/'+lang+'-'+width+'-'+theme+'-failure.jpg',type:'jpeg',quality:70,fullPage:true}).then(()=>null,error=>String(error));cases.push({scope:'reverse-proxy',lang,width,theme,status:'failed',checkpoint,error:String(error),diagnostic,screenshotError,frames,calls:model.calls,mockErrors:model.errors,pageErrors});throw error}
      finally{for(const gate of model.gates)gate.release();await context.close()}
    }
  }finally{await host.close()}
  for(const boundary of ['unqualified','inactive-owner']){
    const inert=await createVisualFixture({qualifiedCatalog:boundary!=='unqualified',transformState:args=>proxyFixtureState(args,boundary!=='inactive-owner')})
    try{
      for(const lang of ['en','ar'])for(const width of [1440,390])for(const theme of ['light','dark']){
        if(!includesTuple(lang,width,theme))continue
        const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockReverseProxy(),pageErrors=[]
        page.on('pageerror',error=>pageErrors.push(error.name+': '+error.message))
        try{
          await mockSession(page,model,{reverseProxy:true});const response=await page.goto(inert.baseUrl+'/domains/reverse-proxy?lang='+lang+'&theme='+theme,{waitUntil:'load'});assert.equal(response.status(),200)
          await proxyState(page,'unavailable');assert.equal(await page.locator(proxyRoot).getAttribute('data-rp-account'),'');assert.equal(await page.locator(proxyRoot).getAttribute('data-rp-manage'),'false')
          assert.ok(await page.locator(proxyRoot+' button').count()>0);assert.equal(await page.locator(proxyRoot+' :is(button,input,select)').evaluateAll(nodes=>nodes.every(node=>node.disabled)),true)
          const measured=await proxyGeometry(page);await page.screenshot({path:screens+'/'+lang+'-'+width+'-'+theme+'-'+boundary+'.jpg',type:'jpeg',quality:70,fullPage:true});assertProxyGeometry(measured,lang,width)
          assert.equal(await page.locator(proxyRoot+' form').count(),0);assert.deepEqual(model.calls,[]);assert.deepEqual(pageErrors,[])
          cases.push({scope:'reverse-proxy',boundary,lang,width,theme,status:'passed',geometry:measured,calls:[],pageErrors})
        }catch(error){const diagnostic=await proxyFailureDiagnostic(page),screenshotError=await page.screenshot({path:screens+'/'+lang+'-'+width+'-'+theme+'-'+boundary+'-failure.jpg',type:'jpeg',quality:70,fullPage:true}).then(()=>null,error=>String(error));cases.push({scope:'reverse-proxy',boundary,lang,width,theme,status:'failed',error:String(error),diagnostic,screenshotError,calls:model.calls,pageErrors});throw error}
        finally{await context.close()}
      }
    }finally{await inert.close()}
  }
}

mkdirSync(output,{recursive:true})
const before=snapshot(),fixture=await createVisualFixture({qualifiedCatalog:true}),browser=await chromium.launch({headless:true})
const runtime={node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version}
const cases=[]
let checkpoint='start',activePage,activeModel,measured,settingsMeasured
try{
  if(scope!=='reverse-proxy'){
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
  }
  if(scope!=='domains'){checkpoint='reverse-proxy';await runReverseProxyAcceptance(browser,cases)}
}catch(error){
  const diagnostic=activePage&&!activePage.isClosed()?await activePage.evaluate(()=>({status:document.querySelector('[data-domain-status]')?.textContent,state:document.querySelector('[data-domain-status]')?.getAttribute('data-state'),createName:document.querySelector('[data-domain-create] [name=name]')?.value,root:document.querySelector('[data-domain-settings-form] [name=docRoot]')?.value,selected:document.querySelector('[data-domain-selected-name]')?.textContent,confirmationOpen:!!document.querySelector('[data-xp-prompt-confirm]')?.getClientRects().length})):undefined
  cases.push({status:'failed',checkpoint,error:String(error),diagnostic,geometry:measured,settingsGeometry:settingsMeasured,calls:activeModel?.calls,mockErrors:activeModel?.errors});process.exitCode=1
}finally{
  for(const gate of activeModel?.gates??[])gate.release();await browser.close();await fixture.close()
  const after=snapshot(),result={at:new Date().toISOString(),runtime,selectedScope:scope,selectedTuple:selectedTuple||null,scope:'Actual domain and reverse-proxy renderer/client/dialogs with explicit mock session/HTTP. No authenticated tenant, durable index/audit, native provisioning/DNS/TLS/runtime/serving/recovery or production proof. This harness does not establish complete design parity.',sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,cases}
  if(!result.sourceUnchanged)process.exitCode=1
  writeFileSync(output+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:process.exitCode?'failed':'passed',cases:cases.length,output}))
}
