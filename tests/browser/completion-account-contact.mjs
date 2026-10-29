// Actual preferences renderer/client/dialogs, with explicit mock session and HTTP.
// No native authentication, contact-index/audit transaction or mail-delivery proof.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const output = resolve(process.env.XPANEL_ACCOUNT_CONTACT_OUTPUT || 'test-results/completion-account-contact')
const sourcePaths = ['apps/web/src/account-contact-client.ts','apps/web/src/board-port/extensions/account-contact.ts','apps/web/src/board-port/extensions/account-pages.ts','apps/web/src/surfaces/xpanel.ts','apps/web/src/ws-client.ts','apps/web/src/login-client.ts','apps/web/src/board-port/extensions/shared.ts','tests/browser/visual-fixture.mjs','tests/browser/completion-account-contact.mjs']
const snapshot = () => sourcePaths.map(path => ({ path, sha256:createHash('sha256').update(readFileSync(path)).digest('hex') }))
const copy = value => JSON.parse(JSON.stringify(value))
const apiPath = '/api/account/preferences'
const rootSelector = '[data-account-contact]'
const input = page => page.locator(rootSelector + ' [name=contactEmail]')
const action = (page, name) => page.locator(rootSelector + ' [data-contact-' + name + ']')
const patchCount = model => model.calls.filter(call => call.method === 'PATCH').length

class MockPreferences {
  constructor() { this.contact='owner@preview.example.test';this.sequence=0;this.calls=[];this.errors=[];this.mode=null;this.gates=[];this.nextReadContact=null;this.race=false }
  get revision() { return createHash('sha256').update('synthetic-contact:' + this.sequence).digest('hex') }
  value() { return {context:{accountId:'visual-account'},preferences:{contactEmail:this.contact},revision:this.revision} }
  external(contact) { this.contact=contact;this.sequence++ }
  hold(method) {
    let entered,release
    const gate={method,started:false,enteredPromise:new Promise(resolve=>{entered=resolve}),promise:new Promise(resolve=>{release=resolve}),entered:()=>entered(),release:()=>release()}
    this.gates.push(gate);return gate
  }
  async route(route) {
    const request=route.request(),method=request.method(),url=new URL(request.url())
    assert.equal(url.pathname,apiPath);assert.equal(url.search,'');assert.ok(['GET','PATCH'].includes(method))
    const body=method==='PATCH'?request.postDataJSON():undefined
    this.calls.push({method,...(body===undefined?{}:{body:copy(body)})})
    const gate=this.gates.find(gate=>gate.method===method&&!gate.started),observed=this.value()
    if(gate){gate.started=true;gate.entered();await gate.promise}
    let status=200,result
    if(method==='GET'){
      result=observed
      if(this.mode==='foreign-read')result.context.accountId='foreign-account'
      if(this.mode==='invalid-revision')result.revision='A'.repeat(64)
      if(this.mode==='newline-revision')result.revision+='\n'
      if(this.mode==='noncanonical-contact')result.preferences.contactEmail='Valid.Local@EXAMPLE.TEST'
      if(this.mode==='empty-contact')result.preferences.contactEmail=''
      if(this.mode==='malformed-read')result.preferences.contactEmail=42
      if(this.nextReadContact!==null){result.preferences.contactEmail=this.nextReadContact;this.nextReadContact=null}
    }else{
      assert.deepEqual(Object.keys(body).sort(),['contactEmail','expectedRevision'])
      assert.equal(typeof body.contactEmail,'string');assert.equal(body.expectedRevision.length,64);assert.match(body.expectedRevision,/^[0-9a-f]{64}$/)
      if(this.race){this.race=false;this.external('racing-writer@example.test')}
      if(body.expectedRevision!==this.revision){status=409;result={error:'stale_revision',stateChanged:false}}
      else if(this.mode==='explicit-refusal'){status=403;result={error:'contact_update_refused',stateChanged:false}}
      else if(this.mode==='restored-index-error'){status=500;result={error:'contact_index_update_failed',stateChanged:false,verificationRequired:true}}
      else {
        const raw=body.contactEmail
        assert.ok(raw.length<=254&&!/[\s\u0000-\u001f\u007f-\u009f]/u.test(raw),'No trimming or control removal in mock')
        const at=raw.lastIndexOf('@');assert.ok(at>0&&at<raw.length-1)
        const canonical=raw.slice(0,at+1)+raw.slice(at+1).toLowerCase(),changed=canonical!==this.contact
        if(changed)this.external(canonical)
        result={...this.value(),ok:true,stateChanged:changed}
        if(this.mode==='unknown-index-error'){status=500;result={error:'contact_index_update_failed',stateChanged:true,verificationRequired:true,unknownOutcome:true}}
        if(this.mode==='unknown-403'){status=403;result={error:'permission_denied_after_dispatch'}}
        if(this.mode==='foreign-ack')result.context.accountId='foreign-account'
        if(this.mode==='wrong-contact-ack')result.preferences.contactEmail='different-ack@example.test'
        if(this.mode==='readback-mismatch')this.nextReadContact='different-readback@example.test'
      }
    }
    if(status>=400){
      const {error,...details}=result
      result={type:'about:blank',title:'Synthetic request refused',status,detail:'Synthetic contact request failure',code:error,instance:apiPath,details}
    }
    await route.fulfill({status,json:result})
  }
}

async function mockSession(page,model) {
  await page.addInitScript(()=>{
    const transport=async(method,path,body)=>{
      const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
      const result=await response.json().catch(()=>null)
      if(!result||typeof result!=='object')throw new Error('mock_unexpected_contact_response')
      // Same error normalization as login-client requestJson; session/auth itself is mocked.
      if(!response.ok){const problem=result.error||result;throw Object.assign(new Error(problem.message||problem.detail||'mock_contact_error'),{status:response.status,code:problem.code,details:problem.details||{}})}
      return result
    }
    Object.defineProperty(window,'xpanelSessionRequest',{get:()=>transport,set:()=>{},configurable:false})
  })
  await page.route('**/api/account/preferences',async route=>{
    try{await model.route(route)}catch(error){model.errors.push(String(error));await route.fulfill({status:500,json:{type:'about:blank',title:'Synthetic failure',status:500,code:'mock_contract_failure',details:{unknownOutcome:true,verificationRequired:true}}})}
  })
}
async function state(page,wanted) {
  await page.waitForFunction(wanted=>{
    const root=document.querySelector('[data-account-contact]')
    return root?.querySelector('[data-contact-status]')?.getAttribute('data-state')===wanted&&!root.querySelector('[data-contact-refresh]')?.disabled
  },wanted)
}
async function entered(gate) {
  let timer
  try{await Promise.race([gate.enteredPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected held contact request did not start')),10000)})])}finally{clearTimeout(timer)}
}
async function releaseReply(page,gate) {
  const response=page.waitForResponse(response=>new URL(response.url()).pathname===apiPath&&response.request().method()===gate.method)
  gate.release();await (await response).finished();await page.evaluate(()=>new Promise(requestAnimationFrame))
}
async function confirmation(page,accept) {
  await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'})
  await page.locator(accept?'[data-xp-prompt-confirm]':'[data-xp-prompt-cancel]').click()
}
async function reload(page) {
  // Every call here deliberately discards a dirty/uncertain draft. Await the new
  // response, since the previous public status may already be "read".
  const response=page.waitForResponse(response=>new URL(response.url()).pathname===apiPath&&response.request().method()==='GET')
  await action(page,'reload').click()
  await confirmation(page,true)
  await (await response).finished()
  await state(page,'read')
}
async function save(page,value) { await input(page).fill(value);await action(page,'save').click() }
async function geometry(page) {
  await page.evaluate(()=>document.fonts.ready)
  return page.locator(rootSelector).evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const visible=node=>{const r=rect(node);return r.width>0&&r.height>0&&!node.closest('[hidden]')}
    const gap=nodes=>nodes.slice(1).map((node,index)=>rect(node).top-rect(nodes[index]).bottom)
    const label=root.querySelector('label[for]'),control=root.querySelector('[name=contactEmail]'),range=document.createRange()
    range.selectNodeContents(label)
    const text=range.getBoundingClientRect(),bounds=rect(control),style=getComputedStyle(control),rtl=getComputedStyle(root).direction==='rtl'
    const anchor=style.textAlign==='start'?(style.direction==='rtl'?'right':'left'):style.textAlign==='end'?(style.direction==='rtl'?'left':'right'):style.textAlign
    const edge=anchor==='right'?bounds.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth):bounds.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth)
    const card=root.closest('.xp-extension__card'),cardNodes=[...card.children].filter(visible),first=rect(cardNodes[0]),last=rect(cardNodes.at(-1)),cardRect=rect(card),cardStyle=getComputedStyle(card)
    const padding={left:first.left-cardRect.left-parseFloat(cardStyle.borderLeftWidth),right:cardRect.right-first.right-parseFloat(cardStyle.borderRightWidth),top:first.top-cardRect.top-parseFloat(cardStyle.borderTopWidth),bottom:cardRect.bottom-last.bottom-parseFloat(cardStyle.borderBottomWidth)}
    const groups=gap([...root.children].filter(node=>node.tagName!=='STYLE'&&visible(node)))
    const formGroups=gap([...root.querySelector('[data-contact-form]').children].filter(visible))
    const frame=root.closest('.xp-extension'),sections=gap([...frame.children].filter(node=>node.tagName!=='STYLE'&&visible(node)))
    const targets=[...root.querySelectorAll('button,input')].filter(visible).map(node=>{
      const words=[]
      if(node.tagName==='BUTTON'){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode()))for(const match of text.textContent.matchAll(/\S+/gu)){const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);const tops=[...range.getClientRects()].map(r=>r.top).sort((a,b)=>a-b),threshold=Math.max(8,(parseFloat(getComputedStyle(node).lineHeight)||22)/2);let lines=0,last=-Infinity;for(const top of tops)if(top-last>threshold){lines++;last=top}words.push({text:match[0],lines})}}
      return {box:rect(node),words}
    })
    const saved=root.querySelector('[data-contact-saved]'),savedTechnical=saved?{direction:getComputedStyle(saved).direction,isolation:getComputedStyle(saved).unicodeBidi}:null
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,direction:getComputedStyle(root).direction,field:{gap:bounds.top-text.bottom,alignment:Math.abs((rtl?text.right:text.left)-edge),height:bounds.height,direction:style.direction,textAlign:style.textAlign,resolvedAnchor:anchor,fontFamily:style.fontFamily},padding,groups,formGroups,sections,fieldSiblings:[],targets,savedTechnical,fonts:{status:document.fonts.status,faces:[...document.fonts].map(face=>({family:face.family,status:face.status}))}}
  })
}
function assertGeometry(g,lang,width) {
  assert.equal(g.direction,lang==='ar'?'rtl':'ltr');assert.ok(g.scrollWidth<=width+1,'No document overflow')
  assert.ok(Math.abs(g.field.gap-8)<=1,'Actual contact label text gap: '+g.field.gap);assert.ok(g.field.alignment<=1,'Actual email anchor: '+g.field.alignment)
  assert.equal(g.field.direction,'ltr','Technical email bytes remain LTR');assert.equal(g.field.resolvedAnchor,lang==='ar'?'right':'left')
  for(const padding of Object.values(g.padding))assert.ok(Math.abs(padding-(width<600?16:24))<=1,'Card padding: '+padding)
  assert.ok(g.groups.length>0&&g.formGroups.length>0,'Real group boundaries measured')
  for(const distance of [...g.groups,...g.formGroups])assert.ok(Math.abs(distance-24)<=1,'Group gap: '+distance)
  assert.ok(g.sections.length>0,'Major section boundary measured')
  for(const distance of g.sections)assert.ok(Math.abs(distance-32)<=1,'Section gap: '+distance)
  for(const target of g.targets){assert.ok(target.box.width>=43.5&&target.box.height>=43.5,'Actual44 control target');for(const word of target.words)assert.ok(word.lines<=1,'Button word stays intact: '+word.text)}
  assert.ok(g.savedTechnical,'Saved address technical element measured');assert.equal(g.savedTechnical.direction,'ltr');assert.ok(g.savedTechnical.isolation.includes('isolate'))
}

mkdirSync(output,{recursive:true})
const before=snapshot(),fixture=await createVisualFixture({qualifiedCatalog:true}),browser=await chromium.launch({headless:true})
const runtime={node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(resolve('node_modules/@playwright/test/package.json'),'utf8')).version}
const cases=[]
let checkpoint='start',activePage,activeModel,measured
try {
  for(const lang of ['en','ar'])for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),model=new MockPreferences(),pageErrors=[]
    activePage=page;activeModel=model;measured=null;page.on('pageerror',error=>pageErrors.push(error.name+': '+error.message))
    await mockSession(page,model);model.mode='foreign-read';checkpoint=lang+'-'+width+':first-account-pin'
    await page.goto(fixture.baseUrl+'/preferences?lang='+lang+'&theme=light',{waitUntil:'load'});await state(page,'failed')
    assert.equal(await input(page).inputValue(),'');assert.equal(patchCount(model),0);assert.equal(await action(page,'save').isDisabled(),true)
    model.mode=null;await action(page,'refresh').click();await state(page,'read');assert.equal(await input(page).inputValue(),model.contact)
    checkpoint=lang+'-'+width+':geometry'
    await input(page).fill('Mixed.Local@EXAMPLE.TEST');measured=await geometry(page);assertGeometry(measured,lang,width)
    await page.screenshot({path:output+'/'+lang+'-'+width+'.png',fullPage:true})
    checkpoint=lang+'-'+width+':canonical-success'
    const firstRevision=model.revision;await action(page,'save').click();await state(page,'saved')
    assert.equal(model.contact,'Mixed.Local@example.test');assert.equal(await input(page).inputValue(),model.contact)
    assert.equal(model.calls.find(call=>call.method==='PATCH').body.expectedRevision,firstRevision)
    assert.ok((await action(page,'saved').textContent()).includes(model.contact))
    checkpoint=lang+'-'+width+':raw-refusal'
    for(const value of [' leading@example.test','trailing@example.test ','control\u2028@example.test']){
      const count=model.calls.length;await input(page).fill(value);await action(page,'save').click();await state(page,'failed')
      assert.equal(await input(page).inputValue(),value);assert.equal(model.calls.length,count,'Raw invalid contact makes no request')
    }
    await reload(page)
    const blankCount=model.calls.length;await input(page).fill('');await action(page,'save').click()
    assert.equal(await input(page).evaluate(node=>node.validity.valueMissing),true);assert.equal(model.calls.length,blankCount,'Required empty input makes no request')
    assert.notEqual(await action(page,'status').getAttribute('data-state'),'saved');await reload(page)
    checkpoint=lang+'-'+width+':pending-refresh-draft'
    const pending=model.hold('GET');await action(page,'refresh').click();await entered(pending)
    assert.equal(await input(page).isEditable(),true);await input(page).fill('typed-during-refresh@example.test');await releaseReply(page,pending);await state(page,'read')
    assert.equal(await input(page).inputValue(),'typed-during-refresh@example.test')
    checkpoint=lang+'-'+width+':dirty-refresh-no-rebase'
    const patches=patchCount(model);model.external('external@example.test');await action(page,'refresh').click();await state(page,'stale')
    assert.equal(await input(page).inputValue(),'typed-during-refresh@example.test')
    await action(page,'save').click();await state(page,'stale');assert.equal(patchCount(model),patches,'Fresh conflict must not PATCH')
    const count=model.calls.length;await action(page,'reload').click();await page.locator('[data-xp-prompt-confirm]').waitFor({state:'visible'})
    assert.equal(await input(page).isEditable(),false);assert.equal(await action(page,'save').isDisabled(),true)
    await confirmation(page,false);assert.equal(await input(page).inputValue(),'typed-during-refresh@example.test');assert.equal(model.calls.length,count)
    await reload(page);assert.equal(await input(page).inputValue(),'external@example.test')
    checkpoint=lang+'-'+width+':dispatch-CAS-race'
    model.race=true;await save(page,'cas-draft@example.test');await state(page,'failed')
    assert.equal(await input(page).inputValue(),'cas-draft@example.test');assert.equal(model.contact,'racing-writer@example.test')
    await reload(page)
    checkpoint=lang+'-'+width+':explicit-refusal'
    model.mode='explicit-refusal';await save(page,'known-refusal@example.test');await state(page,'failed')
    assert.equal(await input(page).inputValue(),'known-refusal@example.test');assert.notEqual(model.contact,'known-refusal@example.test')
    model.mode=null;await reload(page)
    for(const mode of ['restored-index-error','unknown-index-error','unknown-403','foreign-ack','wrong-contact-ack','readback-mismatch']){
      checkpoint=lang+'-'+width+':'+mode;model.mode=mode;const draft=mode+'@example.test'
      await save(page,draft);await state(page,'uncertain');assert.equal(await input(page).inputValue(),draft);assert.equal(await action(page,'save').isDisabled(),true)
      model.mode=null;const count=patchCount(model);await action(page,'refresh').click();await state(page,'uncertain')
      assert.equal(await input(page).inputValue(),draft);assert.equal(await action(page,'save').isDisabled(),true);assert.equal(patchCount(model),count,'Review cannot replay PATCH')
      const calls=model.calls.length;await action(page,'reload').click();await confirmation(page,false)
      assert.equal(await input(page).inputValue(),draft);assert.equal(model.calls.length,calls)
      await reload(page);assert.equal(await input(page).inputValue(),model.contact)
    }
    checkpoint=lang+'-'+width+':later-malformed-response'
    for(const mode of ['foreign-read','invalid-revision','newline-revision','noncanonical-contact','empty-contact','malformed-read']){
      const old=await input(page).inputValue();model.mode=mode;await action(page,'refresh').click();await state(page,'failed');assert.equal(await input(page).inputValue(),old)
      model.mode=null;await action(page,'refresh').click();await state(page,'read')
    }
    checkpoint=lang+'-'+width+':midflight-qualification'
    const blockedCount=patchCount(model),blockedRead=model.hold('GET')
    await input(page).fill('qualification-draft@example.test');await action(page,'save').click();await entered(blockedRead)
    await page.locator(rootSelector).evaluate(node=>node.setAttribute('data-capability-unavailable','true'))
    await releaseReply(page,blockedRead)
    await page.waitForFunction(()=>!['saving','reading'].includes(document.querySelector('[data-contact-status]')?.getAttribute('data-state')))
    assert.equal(patchCount(model),blockedCount,'Qualification removed during fresh GET must prevent PATCH transport')
    assert.equal(await input(page).inputValue(),'qualification-draft@example.test')
    assert.equal(await action(page,'save').isDisabled(),true);assert.equal(await action(page,'refresh').isDisabled(),true)
    const midflightState=await action(page,'status').getAttribute('data-state');assert.equal(midflightState,'failed','Locally suppressed PATCH has a known unchanged-state refusal')
    assert.deepEqual(model.errors,[]);assert.deepEqual(pageErrors,[])
    cases.push({lang,width,status:'passed',geometry:measured,calls:model.calls,pageErrors,midflightState,checks:['first and later account pin','strict revision and canonical GET','canonical domain with local case','raw no-trim refusal','pending read draft preservation','dirty refresh no rebase','fresh conflict and dispatched CAS race','reload confirmation cancel and lock','explicit refusal and restored/unknown index failure','ack and readback mismatch uncertainty','no automatic replay','midflight qualification prevents PATCH transport']})
    await context.close()
  }
  checkpoint='unqualified'
  const unqualified=await createVisualFixture({qualifiedCatalog:false})
  try{const page=await browser.newPage();let calls=0;await page.route('**/api/account/preferences',route=>{calls++;return route.fulfill({status:503,json:{error:'unexpected_contact_request'}})});await page.goto(unqualified.baseUrl+'/preferences?lang=en',{waitUntil:'load'});assert.equal(calls,0);cases.push({status:'passed',scope:'unqualified',checks:['no contact read or mutation transport']});await page.close()}finally{await unqualified.close()}
}catch(error){
  const diagnostic=activePage&&!activePage.isClosed()?await activePage.evaluate(()=>({status:document.querySelector('[data-contact-status]')?.textContent,state:document.querySelector('[data-contact-status]')?.getAttribute('data-state'),input:document.querySelector('[name=contactEmail]')?.value,refreshDisabled:document.querySelector('[data-contact-refresh]')?.disabled,reloadDisabled:document.querySelector('[data-contact-reload]')?.disabled,confirmationOpen:!!document.querySelector('[data-xp-prompt-confirm]')?.getClientRects().length})):undefined
  cases.push({status:'failed',checkpoint,error:String(error),diagnostic,geometry:measured,mockErrors:activeModel?.errors,calls:activeModel?.calls});process.exitCode=1
}finally{
  for(const gate of activeModel?.gates??[])gate.release()
  await browser.close();await fixture.close()
  const after=snapshot(),result={at:new Date().toISOString(),runtime,scope:'Actual preferences renderer/client/dialogs with explicit mock session/HTTP. No real authentication, tenant isolation, index/audit persistence, notification, address ownership, SMTP, mailbox or production proof. Full reference runtime/font parity remains unverified.',sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,cases}
  if(!result.sourceUnchanged)process.exitCode=1
  writeFileSync(output+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:process.exitCode?'failed':'passed',cases:cases.length,output}))
}
