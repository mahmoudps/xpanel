// Actual browser renderer/client with explicitly mocked session and configuration HTTP.
// This harness cannot prove authentication, native Sieve activation or mail delivery.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const output = resolve(process.env.XPANEL_FILTERS_OUTPUT || 'test-results/completion-email-filters')
const sourcePaths = ['apps/web/src/board-port/extensions/account-filters.ts', 'apps/web/src/account-filters-client.ts', 'apps/web/src/board-port/extensions/account-pages.ts', 'apps/web/src/surfaces/xpanel.ts', 'apps/web/src/ws-client.ts', 'tests/browser/visual-fixture.mjs', 'tests/browser/completion-email-filters.mjs']
const snapshot = () => sourcePaths.map(path => ({ path, sha256:createHash('sha256').update(readFileSync(path)).digest('hex') }))
const clone = value => JSON.parse(JSON.stringify(value))
const mailbox = 'info@preview.example.test'
// Host routing receipts as apps/api/src/mail/filter-routes.ts decorate() and routing-application.ts record() return them.
const generationId = 7
const applied = { state:'applied', reason:null }
const pending = { state:'pending', reason:'Saved. The host agent has not applied this change yet.' }
const previewMarker = '<img src=x onerror="window.__filterPreviewExecuted=true">'
const conditionFields = ['from','to','subject','header','body','size']
// Mirrors assertFolder in packages/render/src/services/mail.ts: the server refuses any other folder name.
const folderSegment = /^[\p{L}\p{N}_&-](?:[\p{L}\p{N} _&-]{0,62}[\p{L}\p{N}_&-])?$/u
const folderTarget = 'Invoices.تقارير 2026'
const seed = (scope, id, name) => ({ id, accountId:'visual-account', scope, mailbox:scope==='global'?null:mailbox, name, enabled:true, matchAll:true, priority:1, conditions:[{field:'subject',comparator:'contains',value:'Invoice'}], actions:[{type:'fileinto',target:'Invoices'},{type:'stop'}], compiledSieve:'', createdAt:'2026-10-25T00:00:00Z', application:{...applied} })
const legacyRow = row => row.conditions.some(item => !conditionFields.includes(item.field))
// Allowed request fields per write, from validateFilterDraft/validateFilterPatch and the removal and reorder handlers.
const writeKeys = { create:['name','priority','enabled','matchAll','conditions','actions','scope','mailbox','expectedRevision'], patch:['name','enabled','matchAll','conditions','actions','expectedRevision'], delete:['id','expectedRevision'], reorder:['scope','mailbox','orderedIds','expectedRevision'] }
function assertActions(actions) {
  assert.ok(Array.isArray(actions)&&actions.length>=1&&actions.length<=10,'A rule carries 1 to 10 actions')
  actions.forEach((item,index)=>{
    assert.deepEqual(Object.keys(item).filter(key=>!['type','target'].includes(key)),[],'An action carries only type and target')
    assert.ok(['fileinto','redirect','discard','reject','keep','mark-read','stop'].includes(item.type),`Known action ${item.type}`)
    if(['keep','discard','mark-read','stop'].includes(item.type))assert.equal(item.target,undefined,`${item.type} has no target`);else assert.equal(typeof item.target,'string')
    if(item.type==='fileinto')assert.ok(item.target.split('.').every(segment=>folderSegment.test(segment)),`Renderable folder ${item.target}`)
    if(item.type==='stop')assert.equal(index,actions.length-1,'stop is the last action')
  })
}

class MockConfiguration {
  constructor() {
    this.scopes = new Map([['global',[seed('global','seed-global','Saved global rule')]], [mailbox,[seed('mailbox','seed-mailbox','Saved mailbox rule')]]])
    this.calls=[]; this.errors=[]; this.serial=0; this.failure=null; this.wrongContext=false; this.wrongAccount=false; this.gate=null
  }
  key(url, body={}) { return (url.searchParams.get('scope') || body.scope) === 'mailbox' ? (url.searchParams.get('mailbox') || body.mailbox) : 'global' }
  context(key) { return {accountId:'visual-account',scope:key==='global'?'global':'mailbox',mailbox:key==='global'?null:key} }
  revision(key) { return createHash('sha256').update(JSON.stringify([this.context(key),this.scopes.get(key)])).digest('hex') }
  response(key) {
    const context=this.context(key), filters=clone(this.scopes.get(key) || []), blocked=filters.some(legacyRow)
    // an invalid stored rule is projected like filter-routes.ts project(): metadata only, no raw content
    const projected=filters.map(row=>legacyRow(row)?{...row,conditions:[],actions:[],compiledSieve:null,validation:{status:'invalid',reasonCode:'invalid_saved_filter'}}:row)
    return { filters:projected, context, revision:this.revision(key), application:{generationId}, compilation:blocked?{status:'blocked',reason:'invalid_saved_filter_or_preview_limit'}:{status:'ready'}, compiledSieve:blocked?null:`# selected ${key}\n# ${previewMarker}\n${filters.map(row=>`# ${row.name}`).join('\n')}\nkeep;\n` }
  }
  holdNextRead() { let release; const promise=new Promise(resolve=>{release=resolve}); this.gate={promise,release}; return release }
  async route(route) {
    const request=route.request(), url=new URL(request.url()), method=request.method(), body=request.postData()?request.postDataJSON():{}
    assert.equal(Object.hasOwn(body,'accountId'),false,'Owner requests never carry account IDs')
    const targetId=decodeURIComponent(url.pathname.split('/').at(-1))
    const key=['PATCH','DELETE'].includes(method)?([...this.scopes].find(([,rows])=>rows.some(row=>row.id===targetId))?.[0]??this.key(url,body)):this.key(url,body)
    this.calls.push({method,path:url.pathname,scope:key,body:clone(body)})
    if(method==='GET') {
      if(this.gate) { const gate=this.gate;this.gate=null;await gate.promise }
      const result=this.response(key)
      if(this.wrongContext) { result.context=this.context(key==='global'?mailbox:'global');result.filters=[seed('global','foreign-scope','ScopeLeak')];result.compiledSieve='ScopeLeak' }
      if(this.wrongAccount) { result.context.accountId='another-synthetic-account';result.filters=result.filters.map(row=>({...row,accountId:'another-synthetic-account',name:'AccountLeak'}));result.compiledSieve='AccountLeak' }
      return route.fulfill({json:result})
    }
    const kind=method==='POST'?(url.pathname.endsWith('/reorder')?'reorder':'create'):method.toLowerCase()
    assert.ok(Object.hasOwn(writeKeys,kind),'Unexpected mock method')
    assert.deepEqual(Object.keys(body).filter(field=>!writeKeys[kind].includes(field)),[],`${kind} body carries only current contract fields`)
    if(kind==='create'||Object.hasOwn(body,'actions'))assertActions(body.actions)
    if(this.failure) {
      if(this.failure===409&&this.scopes.get(key)?.[0])this.scopes.get(key)[0].name+=' (concurrent edit)'
      return route.fulfill({status:this.failure,json:this.failure===500?{error:'unknown_write',unknownOutcome:true,verificationRequired:true}:{error:this.failure===409?'stale_revision':'forbidden',stateChanged:false}})
    }
    const rows=this.scopes.get(key)
    assert.ok(Array.isArray(rows),'Selected mock scope is canonical')
    assert.equal(body.expectedRevision,this.revision(key),'Fresh selected revision is sent before every write')
    const previous=this.calls.at(-2)
    assert.equal(previous?.method,'GET','Each write follows a fresh selected read')
    assert.equal(previous?.scope,key)
    const id=decodeURIComponent(url.pathname.split('/').at(-1))
    let changed
    if(url.pathname.endsWith('/reorder')) {
      assert.equal(method,'POST');assert.deepEqual([...body.orderedIds].sort(),rows.map(row=>row.id).sort())
      this.scopes.set(key,body.orderedIds.map((id,index)=>({...rows.find(row=>row.id===id),priority:index+1})))
    } else if(method==='POST') {
      assert.equal(typeof body.name,'string');assert.ok(Array.isArray(body.conditions))
      changed={...seed(key==='global'?'global':'mailbox',`created-${++this.serial}`,body.name),conditions:clone(body.conditions),actions:clone(body.actions),matchAll:body.matchAll??true,enabled:body.enabled??true,priority:rows.length+1,application:{...pending}}
      changed.conditions=changed.conditions.map(condition=>{if(condition.field!=='size')return condition;const match=/^(\d+)([KMG])?$/i.exec(condition.value.trim());assert.ok(match);return {...condition,value:String(Number(match[1])*({K:1024,M:1048576,G:1073741824}[match[2]?.toUpperCase()]??1))}})
      rows.push(changed)
    } else if(method==='PATCH') {
      changed=rows.find(row=>row.id===id);assert.ok(changed)
      for(const field of ['name','enabled','matchAll','conditions','actions']) if(Object.hasOwn(body,field)) changed[field]=clone(body[field])
      changed.application={...pending}
    } else if(method==='DELETE') {
      assert.ok(rows.some(row=>row.id===id));this.scopes.set(key,rows.filter(row=>row.id!==id))
    } else throw new Error('Unexpected mock method')
    return route.fulfill({status:kind==='create'?201:200,json:{...this.response(key),...(kind==='create'?{}:{ok:true}),...(changed?{filter:clone(changed)}:{})}})
  }
}

async function installMockSession(page, model) {
  await page.addInitScript(()=>{
    const transport=async(method,path,body)=>{
      const response=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      const data=await response.json()
      if(!response.ok) throw Object.assign(new Error(data.error||'mock_request_failed'),{status:response.status,details:data})
      return data
    }
    Object.defineProperty(window,'xpanelSessionRequest',{get:()=>transport,set:()=>{},configurable:false})
  })
  await page.route('**/api/mail/filters**',async route=>{try{await model.route(route)}catch(error){model.errors.push(String(error));await route.fulfill({status:500,json:{error:'mock_contract_assertion',unknownOutcome:true}})}})
}

async function geometry(page) {
  await page.evaluate(()=>document.fonts.ready)
  return page.locator('[data-filter-workspace]').evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const visible=node=>{const r=rect(node);return r.width>0&&r.height>0&&!node.closest('[hidden]')}
    const fields=[...root.querySelectorAll('label[for]')].filter(visible).map(label=>{
      const control=document.getElementById(label.htmlFor);if(!control||!visible(control)||['checkbox','radio'].includes(control.type))return null
      const range=document.createRange();range.selectNodeContents(label);const text=range.getBoundingClientRect(),box=rect(control),style=getComputedStyle(control),rtl=getComputedStyle(root).direction==='rtl'
      const anchor=style.textAlign==='start'?(style.direction==='rtl'?'right':'left'):style.textAlign==='end'?(style.direction==='rtl'?'left':'right'):style.textAlign
      const actualEdge=anchor==='right'?box.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth):anchor==='left'?box.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth):(box.left+box.right)/2
      return {label:label.textContent.trim(),textGap:box.top-text.bottom,height:box.height,controlDirection:style.direction,textAlign:style.textAlign,resolvedAnchor:anchor,alignment:Math.abs((rtl?text.right:text.left)-actualEdge)}
    }).filter(Boolean)
    const gaps=(nodes)=>nodes.slice(1).map((node,index)=>rect(node).top-rect(nodes[index]).bottom)
    const form=root.querySelector('[data-filter-editor]')
    const siblings=[...form.querySelectorAll('.xp-form-group')].flatMap(group=>gaps([...group.children].filter(visible)))
    const conditionFields=[...form.querySelectorAll('[data-filter-condition],[data-filter-action-row]')].flatMap(group=>gaps([...group.children].filter(visible)))
    const groups=gaps([...form.children].filter(visible))
    const extension=root.closest('.xp-extension'),sections=gaps([...extension.children].filter(node=>node.tagName!=='STYLE'&&visible(node)))
    const cards=[...extension.querySelectorAll('.xp-extension__card')].filter(visible).map(card=>{
      const content=[...card.children].filter(node=>node.tagName!=='STYLE'&&visible(node)),first=rect(content[0]),last=rect(content.at(-1)),bounds=rect(card),style=getComputedStyle(card)
      return {left:first.left-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-first.right-parseFloat(style.borderRightWidth),top:first.top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-last.bottom-parseFloat(style.borderBottomWidth)}
    })
    const conditionPadding=[...root.querySelectorAll('[data-filter-condition],[data-filter-action-row]')].filter(visible).map(card=>{const content=[...card.children].filter(visible),first=rect(content[0]),last=rect(content.at(-1)),bounds=rect(card),style=getComputedStyle(card);return {left:first.left-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-first.right-parseFloat(style.borderRightWidth),top:first.top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-last.bottom-parseFloat(style.borderBottomWidth)}})
    const listPadding=[...root.querySelectorAll('[data-filter-list]>li')].filter(visible).map(card=>{const content=[...card.children].filter(visible),first=rect(content[0]),last=rect(content.at(-1)),bounds=rect(card),style=getComputedStyle(card);return {left:first.left-bounds.left-parseFloat(style.borderLeftWidth),right:bounds.right-first.right-parseFloat(style.borderRightWidth),top:first.top-bounds.top-parseFloat(style.borderTopWidth),bottom:bounds.bottom-last.bottom-parseFloat(style.borderBottomWidth)}})
    const targets=[...root.querySelectorAll('button,input[type=checkbox],input[type=radio]')].filter(visible).map(node=>{
      const native=rect(node),label=node.closest('label'),associated=label?rect(label):null
      return {type:node.type,native,associated,passes:native.width>=43.5&&native.height>=43.5||associated&&associated.width>=43.5&&associated.height>=43.5}
    })
    const preview=root.querySelector('[data-filter-preview]'),bounds=rect(preview)
    return {direction:getComputedStyle(root).direction,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,fields,siblings,conditionFields,groups,sections,cards,conditionPadding,listPadding,targets,preview:{...bounds,scrollWidth:preview.scrollWidth},fonts:{status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,status:face.status}))}}
  })
}
function assertGeometry(value,lang,width) {
  assert.equal(value.direction,lang==='ar'?'rtl':'ltr');assert.ok(value.scrollWidth<=width+1,'No horizontal page overflow')
  assert.ok(value.fields.length>=8,'Scope, editor and condition fields measured')
  for(const field of value.fields){assert.ok(Math.abs(field.textGap-8)<=1,`Actual label gap ${field.label}: ${field.textGap}`);assert.ok(field.alignment<=1,`Actual field text alignment ${field.label}: ${field.alignment}`);assert.ok(field.height>=43.5)}
  for(const gap of [...value.siblings,...value.conditionFields])assert.ok(Math.abs(gap-16)<=1,`Sibling field gap ${gap}`)
  for(const gap of value.groups)assert.ok(Math.abs(gap-24)<=1,`Form group gap ${gap}`)
  for(const gap of value.sections)assert.ok(Math.abs(gap-32)<=1,`Major section gap ${gap}`)
  for(const card of [...value.cards,...value.conditionPadding,...value.listPadding])for(const padding of Object.values(card))assert.ok(Math.abs(padding-(width<600?16:24))<=1,`Panel padding ${padding}`)
  for(const target of value.targets)assert.equal(Boolean(target.passes),true,'Actual native or associated-label target')
  assert.ok(value.preview.width<=width+1,'Compiled preview overflow is contained')
}

mkdirSync(output,{recursive:true})
const before=snapshot(),fixture=await createVisualFixture({qualifiedCatalog:true}),browser=await chromium.launch({headless:true})
const runtime={node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version}
const cases=[]
let checkpoint='start',activePage,activeModel,activeGeometry
const idle=page=>page.waitForFunction(()=>document.querySelector('[data-filter-workspace]')?.getAttribute('aria-busy')==='false')
const status=async(page,wanted)=>{await idle(page);await page.waitForFunction(wanted=>document.querySelector('[data-filter-status]')?.getAttribute('data-state')===wanted,wanted)}
const action=(page,kind,id)=>page.locator(`[data-filter-action="${kind}"][data-filter-id="${id}"]`)
const form=page=>page.locator('[data-filter-editor]')
const fill=async(page,name)=>{await form(page).locator('[name=name]').fill(name);const row=form(page).locator('[data-filter-action-row]').first();await row.locator('[data-action-field=type]').selectOption('fileinto');await row.locator('[data-action-field=target]').fill(folderTarget)}
const draftActions=[{type:'fileinto',target:folderTarget},{type:'mark-read'},{type:'stop'}]
const routingStates=page=>page.locator('[data-filter-list] [data-routing-state]').evaluateAll(nodes=>nodes.map(node=>node.dataset.routingState))
try {
  for(const lang of ['en','ar'])for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockConfiguration(),pageErrors=[]
    page.on('pageerror',error=>pageErrors.push(`${error.name}: ${error.message}`))
    activePage=page;activeModel=model;activeGeometry=null;model.wrongAccount=true
    await installMockSession(page,model)
    checkpoint=`${lang}-${width}:first-account-pin`
    await page.goto(`${fixture.baseUrl}/email/filters?lang=${lang}&theme=light`,{waitUntil:'load'})
    await status(page,'failed')
    assert.equal(await page.locator('[data-filter-workspace]').getAttribute('data-filter-account'),'visual-account')
    assert.equal(await page.locator('[data-filter-list]').getByText('AccountLeak',{exact:false}).count(),0)
    assert.equal(await page.locator('[data-filter-new]').isDisabled(),true)
    model.wrongAccount=false;await page.locator('[data-filter-refresh]').click();await status(page,'read')
    assert.ok((await page.locator('[data-filter-preview]').textContent()).includes(previewMarker))
    assert.deepEqual(await routingStates(page),['applied'],'Each saved rule shows its host application state')
    assert.equal(await page.locator('[data-filter-workspace] img').count(),0);assert.equal(await page.evaluate(()=>window.__filterPreviewExecuted===true),false)
    assert.equal(await page.locator('[data-filter-workspace] [name=accountId]').count(),0)
    checkpoint=`${lang}-${width}:draft`
    await page.locator('[data-filter-new]').click();await form(page).waitFor({state:'visible'})
    assert.equal(await page.locator('[data-filter-unconditional]').isVisible(),true)
    await fill(page,'Invoice <b>literal</b>')
    assert.equal(await form(page).locator('[data-filter-action-row]').count(),1);assert.equal(await form(page).locator('[name=stop]').isChecked(),true)
    await page.locator('[data-filter-add-action]').click();await form(page).locator('[data-filter-action-row]').nth(1).locator('[data-action-field=type]').selectOption('mark-read')
    await page.locator('[data-filter-add-condition]').click()
    const condition=page.locator('[data-filter-condition]').first()
    await condition.locator('[data-condition-field=field]').selectOption('subject');await condition.locator('[data-condition-field=comparator]').selectOption('contains');await condition.locator('[data-condition-field=value]').fill('  فاتورة "Invoice" \\ <b>literal</b>  ')
    await page.locator('[data-filter-add-condition]').click()
    const header=page.locator('[data-filter-condition]').nth(1)
    await header.locator('[data-condition-field=field]').selectOption('header');await header.locator('[data-condition-field=headerName]').fill('X-Category');await header.locator('[data-condition-field=comparator]').selectOption('is');await header.locator('[data-condition-field=value]').fill('Finance')
    await page.locator('[data-filter-add-condition]').click()
    const size=page.locator('[data-filter-condition]').nth(2)
    await size.locator('[data-condition-field=field]').selectOption('size');await size.locator('[data-condition-field=comparator]').selectOption('over');await size.locator('[data-condition-field=value]').fill(' 1K ')
    checkpoint=`${lang}-${width}:scope-confirmation-cancel`
    const beforeScopeDialog=model.calls.length
    await page.locator('[data-filter-scope]').selectOption(`mailbox:${mailbox}`)
    await page.locator('[data-xp-prompt-cancel]').waitFor({state:'visible'})
    assert.equal(await page.locator('[data-filter-workspace]').getAttribute('aria-busy'),'true')
    assert.equal(await page.locator('[data-filter-workspace]').evaluate(root=>[...root.querySelectorAll('button,input,select')].every(control=>control.disabled)),true,'Workspace locks while scope confirmation is pending')
    await page.locator('[data-filter-scope]').evaluate((select,mailbox)=>{select.value='mailbox:'+mailbox;select.dispatchEvent(new Event('change',{bubbles:true}))},mailbox)
    await page.locator('[data-xp-prompt-cancel]').click();await idle(page)
    assert.equal(await page.locator('[data-filter-scope]').inputValue(),'global');assert.equal(await form(page).locator('[name=name]').inputValue(),'Invoice <b>literal</b>');assert.equal(model.calls.length,beforeScopeDialog,'Cancelled scope confirmation makes no transport request')
    activeGeometry=await geometry(page);checkpoint=`${lang}-${width}:geometry`
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${output}/${lang}-${width}.png`,fullPage:true});assertGeometry(activeGeometry,lang,width)
    checkpoint=`${lang}-${width}:create`
    await form(page).locator('button[type=submit]').click();await status(page,'saved')
    const created=model.scopes.get('global').find(row=>row.id.startsWith('created-'));assert.ok(created);assert.equal(created.conditions.length,3);assert.equal(created.conditions[2].value,'1024');assert.equal(created.conditions[0].value,'  فاتورة "Invoice" \\ <b>literal</b>  ');assert.deepEqual(created.actions,draftActions)
    assert.deepEqual(await routingStates(page),['applied','pending'],'A new rule reads back as saved, not yet applied')
    const originalDate=created.createdAt
    checkpoint=`${lang}-${width}:edit`
    await action(page,'edit',created.id).click();await form(page).locator('[name=name]').fill('Edited <b>literal</b>');await form(page).locator('button[type=submit]').click();await status(page,'saved')
    assert.equal(created.name,'Edited <b>literal</b>');assert.equal(created.createdAt,originalDate);assert.deepEqual(created.actions,draftActions,'Editing round-trips every action')
    await action(page,'toggle',created.id).click();await status(page,'saved');assert.equal(created.enabled,false)
    checkpoint=`${lang}-${width}:order`
    await action(page,'up',created.id).click();await status(page,'saved');assert.equal(model.scopes.get('global')[0].id,created.id)
    await action(page,'down',created.id).click();await status(page,'saved');assert.deepEqual(model.scopes.get('global').map(row=>row.id),['seed-global',created.id])
    checkpoint=`${lang}-${width}:delete`
    await action(page,'delete',created.id).click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await page.locator('[data-xp-prompt-confirm]').click();await status(page,'saved')
    assert.equal(model.scopes.get('global').some(row=>row.id===created.id),false)
    checkpoint=`${lang}-${width}:control-refusal`
    await page.locator('[data-filter-new]').click();await fill(page,'\u2028Invalid draft')
    const beforeInvalid=model.calls.length
    await form(page).locator('button[type=submit]').click();await status(page,'failed');assert.equal(model.calls.length,beforeInvalid,'Forbidden raw control is refused without transport');assert.equal(await form(page).locator('[name=name]').inputValue(),'\u2028Invalid draft')
    checkpoint=`${lang}-${width}:conflict-draft`
    await fill(page,'Conflict draft');model.failure=409
    await form(page).locator('button[type=submit]').click();await status(page,'failed');assert.equal(await form(page).locator('[name=name]').inputValue(),'Conflict draft')
    model.failure=null;await page.locator('[data-filter-refresh]').click();await status(page,'read');assert.equal(await form(page).locator('[name=name]').inputValue(),'Conflict draft');await page.locator('[data-filter-cancel]').click()
    await page.locator('[data-filter-new]').click();await fill(page,'Uncertain draft')
    checkpoint=`${lang}-${width}:uncertain-draft`
    model.failure=500;await form(page).locator('button[type=submit]').click();await status(page,'uncertain');assert.equal(await form(page).locator('[name=name]').inputValue(),'Uncertain draft');assert.equal(await form(page).locator('button[type=submit]').isDisabled(),true)
    model.failure=null;await page.locator('[data-filter-refresh]').click();await status(page,'read');assert.equal(await form(page).locator('[name=name]').inputValue(),'Uncertain draft');await page.locator('[data-filter-cancel]').click()
    checkpoint=`${lang}-${width}:scope-mismatch`
    model.wrongContext=true;await page.locator('[data-filter-scope]').selectOption(`mailbox:${mailbox}`);await status(page,'failed');assert.equal(await page.locator('[data-filter-list]').getByText('ScopeLeak',{exact:false}).count(),0);assert.equal((await page.locator('[data-filter-preview]').textContent()).includes('ScopeLeak'),false)
    model.wrongContext=false;await page.locator('[data-filter-refresh]').click();await status(page,'read')
    model.wrongAccount=true;await page.locator('[data-filter-refresh]').click();await status(page,'failed');assert.equal(await page.locator('[data-filter-list]').getByText('AccountLeak',{exact:false}).count(),0)
    model.wrongAccount=false;await page.locator('[data-filter-refresh]').click();await status(page,'read')
    checkpoint=`${lang}-${width}:mailbox-write`
    await page.locator('[data-filter-new]').click();await fill(page,'Mailbox-only draft');await form(page).locator('button[type=submit]').click();await status(page,'saved')
    const mailboxCreated=model.scopes.get(mailbox).find(row=>row.id.startsWith('created-'));assert.ok(mailboxCreated);assert.equal(mailboxCreated.scope,'mailbox');assert.equal(mailboxCreated.mailbox,mailbox)
    await action(page,'delete',mailboxCreated.id).click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await page.locator('[data-xp-prompt-confirm]').click();await status(page,'saved');assert.equal(model.scopes.get(mailbox).some(row=>row.id===mailboxCreated.id),false)
    checkpoint=`${lang}-${width}:scope-serialization`
    const release=model.holdNextRead();await page.locator('[data-filter-scope]').selectOption('global');await page.waitForFunction(()=>document.querySelector('[data-filter-workspace]')?.getAttribute('aria-busy')==='true')
    assert.equal(await page.locator('[data-filter-scope]').isDisabled(),true)
    await page.locator('[data-filter-scope]').evaluate((select,mailbox)=>{select.value='mailbox:'+mailbox;select.dispatchEvent(new Event('change',{bubbles:true}))},mailbox)
    release();await status(page,'read');assert.equal(await page.locator('[data-filter-scope]').inputValue(),'global');assert.equal((await page.locator('[data-filter-list]').textContent()).includes('Saved mailbox rule'),false)
    checkpoint=`${lang}-${width}:legacy-blocked`
    model.scopes.get('global').push({...seed('global','legacy-invalid','Recoverable legacy rule'),conditions:[{field:'unknown_legacy',operator:'raw',value:'unsafe'}]})
    await page.locator('[data-filter-refresh]').click();await status(page,'blocked');assert.equal(await page.locator('[data-filter-preview]').textContent(),'');assert.ok((await page.locator('[data-filter-list]').textContent()).includes('Recoverable legacy rule'));assert.equal((await page.locator('[data-filter-list]').textContent()).includes('unsafe'),false);assert.equal(await page.locator('[data-filter-new]').isDisabled(),true);assert.equal(await page.locator('[data-filter-action="edit"]').count(),0)
    checkpoint=`${lang}-${width}:legacy-recovery`
    await action(page,'delete','legacy-invalid').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'});await page.locator('[data-xp-prompt-confirm]').click();await status(page,'saved')
    assert.deepEqual(model.scopes.get('global').map(row=>row.id),['seed-global']);assert.equal(await page.locator('[data-filter-new]').isDisabled(),false);assert.ok((await page.locator('[data-filter-preview]').textContent()).includes('# Saved global rule'))
    model.scopes.set('global',[]);await page.locator('[data-filter-refresh]').click();await status(page,'read');assert.equal(await page.locator('[data-filter-list]>li').count(),0);assert.equal(await page.locator('[data-filter-empty]').isVisible(),true)
    assert.deepEqual(model.errors,[])
    assert.deepEqual(pageErrors,[],'No uncaught browser exceptions')
    cases.push({lang,width,status:'passed',geometry:activeGeometry,calls:model.calls,pageErrors,checks:['first and later trusted-account pin','escaped preview','per-rule host application state','multi-action create/edit/toggle/order/delete exact readback','current write contract fields only','409 and uncertain draft preservation','scope mismatch and busy selection serialization','blocked legacy metadata and delete recovery','empty observed scope']})
    await context.close()
  }
  checkpoint='unqualified'
  const unqualified=await createVisualFixture({qualifiedCatalog:false})
  try{const page=await browser.newPage();let calls=0;await page.route('**/api/mail/filters**',route=>{calls++;return route.fulfill({status:503,json:{error:'unexpected_request'}})});await page.goto(`${unqualified.baseUrl}/email/filters?lang=en`,{waitUntil:'load'});assert.equal(await page.locator('[data-filter-editor]').count(),0);assert.equal(calls,0);cases.push({status:'passed',scope:'unqualified',checks:['no editor','no filter API requests']});await page.close()}finally{await unqualified.close()}
}catch(error){const diagnostic=activePage&&!activePage.isClosed()?await activePage.evaluate(()=>({bound:document.querySelector('[data-filter-workspace]')?.getAttribute('data-filter-bound'),account:document.querySelector('[data-filter-workspace]')?.getAttribute('data-filter-account'),status:document.querySelector('[data-filter-status]')?.textContent,state:document.querySelector('[data-filter-status]')?.getAttribute('data-state'),selected:document.querySelector('[data-filter-scope]')?.value})):undefined;cases.push({status:'failed',checkpoint,error:String(error),diagnostic,geometry:activeGeometry,mockErrors:activeModel?.errors});process.exitCode=1}
finally{await browser.close();await fixture.close();const after=snapshot();const result={at:new Date().toISOString(),runtime,scope:'Real renderer/client and confirmation dialogs; mocked session transport and configuration HTTP only. No real authentication, tenant authorization, native Sieve activation or delivery proof. No whole-artboard or font-provenance parity claim.',sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,cases};if(!result.sourceUnchanged)process.exitCode=1;writeFileSync(`${output}/results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({status:process.exitCode?'failed':'passed',cases:cases.length,output}))}
