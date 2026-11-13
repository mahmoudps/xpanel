// @vitest-environment jsdom
import {beforeAll,it,expect,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {URL as NodeURL} from 'node:url';
import {defaultFirewallRules,parsePo,catalogFromEntries,createTranslator} from '@xpanel/core';
import type {FirewallRule,ServerSettings} from '@xpanel/core';
import {createStateStore,firewallRevision} from '../../../packages/state/src/index.ts';
import type {TestStateStoreHandle} from '../../../packages/state/src/index.ts';
import {settings as serverSettingsFixture} from '../../../packages/render/src/edge/testkit.ts';
import type {AuthenticatedCaller} from '../../api/src/auth.ts';
import {handleFirewallWorkspaceRoute,exportFirewall} from '../../api/src/firewall-workspace.ts';
import type {FirewallWorkspaceHelpers} from '../../api/src/firewall-workspace.ts';
import {WHM_FIREWALL_CLIENT_BINDING} from './whm-firewall-client.ts';
import {renderWhmFirewallClientTemplates} from './board-port/whm-firewall-client-templates.ts';
const markup = `<div data-approved-whm-operations="/whm/security/firewall" data-operation-state="qualified"><section data-whm-ops-section="firewall-rule-categories"><h2>Rules</h2><p data-firewall-manage-status role="status"></p>
  <section data-whm-firewall-panel="port"><table><thead><tr><th>Position</th><th>Action</th><th>Protocol</th><th>Port</th><th>Source</th><th>Purpose</th><th>Origin</th><th>Note</th><th>Manage</th></tr></thead><tbody></tbody></table><div class="xp-whm-ops-actions" data-firewall-static-management><button disabled>Edit</button></div><p class="xp-whm-ops-status" data-firewall-static-management>not connected</p></section>
  <section data-whm-firewall-panel="prefix-list"><table><thead><tr><th>Name</th><th>Action</th><th>Entries</th><th>Ports</th><th>File</th><th>Updated</th></tr></thead><tbody></tbody></table><input name="firewall-prefix-name" disabled><input type="file" name="firewall-prefix-file" disabled><input name="firewall-prefix-ports" disabled><select name="firewall-prefix-action" disabled><option value="">Choose</option><option value="drop">Drop</option></select><button data-firewall-action="upload-list" disabled>Upload prefix list</button><button data-firewall-action="replace-list" disabled>Replace file</button></section>
  <section data-whm-firewall-panel="banned"><table><thead><tr><th>Address</th><th>Reason</th><th>Source</th><th>Banned at</th><th>Expires</th></tr></thead><tbody></tbody></table><input name="firewall-unban-address" disabled><button data-firewall-action="unban" disabled>Unban</button></section></section>
  <section data-whm-ops-section="firewall-import-export"><input type="file" name="firewall-import-file" disabled><textarea name="firewall-import-json" disabled></textarea><button data-firewall-action="import" disabled>Import JSON</button><button data-firewall-action="export" disabled>Export JSON</button></section>${renderWhmFirewallClientTemplates()}</div>`
type JsonObject = Record<string,unknown>;
type Call = {method:string;path:string;body:JsonObject|null;reply:JsonObject};
type Preview = {body:JsonObject;reply:JsonObject};
const isObject=(value:unknown):value is JsonObject=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function object(value:unknown):JsonObject {if(!isObject(value))throw new Error('Expected an object from the isolated API');return value}
function required<T extends Element>(selector:string,constructor:{new():T}):T {
  const node=document.querySelector(selector);if(!(node instanceof constructor))throw new Error('Missing expected DOM element: '+selector);return node;
}
function deferred<T>(){
  let resolve:(value:T)=>void=()=>{throw new Error('Deferred resolver not initialized')};
  const promise=new Promise<T>(resolver=>{resolve=resolver});return {promise,resolve};
}
async function settled<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Controlled test checkpoint was not reached')),5000)})])}
  finally{if(timer!==undefined)clearTimeout(timer)}
}
function recorded(calls:Call[],predicate:(call:Call)=>boolean):Call {const call=calls.find(predicate);if(!call)throw new Error('Expected API call was not recorded');return call}
function bodyOf(call:Call):JsonObject {if(!call.body)throw new Error('Expected request body');return call.body}
const FIREWALL_TMP = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
let firewallMarkupTemplate: HTMLTemplateElement;
let bindFirewallClient: (ask?: unknown) => void;
let arFirewallTranslator: ReturnType<typeof createTranslator>;
beforeAll(async()=>{
  firewallMarkupTemplate=document.createElement('template');
  firewallMarkupTemplate.innerHTML=markup;
  const bound:unknown=new Function('return '+WHM_FIREWALL_CLIENT_BINDING)();
  if(typeof bound!=='function')throw new Error('Expected the actual browser binding');
  bindFirewallClient=bound as (ask?:unknown)=>void;
  const parsedPo=parsePo(await readFile(new NodeURL('./locales/ar.po',import.meta.url),'utf8'));
  arFirewallTranslator=createTranslator('ar',catalogFromEntries(parsedPo.entries));
});
it('refuses a stale import confirmation and accepts the accurately reviewed fresh import',{tags:['feature'],timeout:15000},async()=>{
  const rootDir=await mkdtemp(join(FIREWALL_TMP,'xpanel-fw-rev-'));
  const h:TestStateStoreHandle={store:createStateStore(rootDir),rootDir,close:()=>rm(rootDir,{recursive:true,force:true})};
  const previewRelease=deferred<void>(),previewSeen=deferred<Preview>(),importQuestion=deferred<JsonObject>(),importConfirm=deferred<boolean>();
  const freshQuestionSeen=deferred<JsonObject>(),freshConfirm=deferred<boolean>();
  const inFlight=new Set<Promise<unknown>>(),calls:Call[]=[],audits:string[]=[];
  const clock=new Date();
  // Authentication and reconciliation are explicit fixture ports; this case tests revision integrity, not host authority.
  const caller={principal:{kind:'root',id:'root-id',username:'root'}} as AuthenticatedCaller;
  const settings:ServerSettings=serverSettingsFixture({panelPort:2087,sshPort:22,backendPort:8080,backendTlsPort:8443,hostname:'srv.example.test',nameservers:[],adminEmail:'root@example.test',engine:'apache',apacheMpm:'itk'});
  const office:FirewallRule={id:'office-mysql',kind:'port',action:'accept',protocol:'tcp',port:'3306',source:'203.0.113.0/28',forwardTo:null,list:null,comment:'office',enabled:true};
  const other:FirewallRule={...office,id:'other-app',port:'9443',comment:'original other'};
  const reconcile=vi.fn(async()=>({ok:true,status:200,body:{generation:143,fixtureOnly:true}}));
  const helpers:FirewallWorkspaceHelpers={
    requireCaller:async()=>caller,assertRoot:async()=>{},
    store:{
      getFirewallState:()=>h.store.getFirewallState(),
      getFirewallPending:()=>h.store.getFirewallPending(),
      replaceFirewall:(next,guard,options)=>h.store.replaceFirewall(next,guard,options),
      confirmFirewallChange:id=>h.store.confirmFirewallChange(id),
      revertFirewallChange:id=>h.store.revertFirewallChange(id),
      getServerSettings:async()=>settings
    },
    clientIp:()=> '203.0.113.7',reconcile,
    bans:async()=>Response.json({state:'read',bans:[]}),
    audit:async(_caller,action)=>{audits.push(action)},
    schedule:()=>{},now:()=>clock
  };
  const call=async(method:string,p:string,body?:unknown):Promise<JsonObject>=>{
    const url=new URL('https://panel.test'+p);
    const response=await handleFirewallWorkspaceRoute(new Request(url.toString(),{method,...(body===undefined?{}:{body:JSON.stringify(body),headers:{'content-type':'application/json'}})}),url,method,helpers);
    if(!response)throw new Error('Expected the real firewall route to handle the request');
    expect(response.status).toBeLessThan(400);
    const value:unknown=await response.json();return object(value);
  };
  const send=(method:string,p:string,body?:unknown):Promise<unknown>=>{
    const requestBody=body===undefined?null:object(body);
    const work=(async()=>{
      const reply=await call(method,p,body);
      calls.push({method,path:p,body:requestBody?structuredClone(requestBody):null,reply:structuredClone(reply)});
      if(p==='/api/firewall/import'&&requestBody?.dryRun===true){
        previewSeen.resolve({body:structuredClone(requestBody),reply:structuredClone(reply)});
        await previewRelease.promise;
      }
      return reply;
    })();inFlight.add(work);work.then(()=>inFlight.delete(work),()=>inFlight.delete(work));return work;
  };
  try{
    await h.store.replaceFirewall({rules:[...defaultFirewallRules(settings),office,other],prefixLists:[]},{lockout:null});
    const before=await h.store.getFirewallState(),revisionA=firewallRevision(before);
    const exported:unknown=JSON.parse(exportFirewall(before,clock));
    const documentData={...object(exported),rules:before.rules.map(rule=>rule.id==='other-app'?{...rule,comment:'reviewed import'}:rule)};
    document.documentElement.lang='en';document.body.replaceChildren(firewallMarkupTemplate.content.cloneNode(true));
    Object.assign(window,{xpanelSessionRequest:send});
    let importQuestions=0;
    const ask=vi.fn(async(options:JsonObject)=>{
      if(options.title==='Import these rules?'){
        importQuestions++;
        if(importQuestions===1){importQuestion.resolve(options);return await importConfirm.promise}
        freshQuestionSeen.resolve(options);return await freshConfirm.promise;
      }
      return true;
    });
    bindFirewallClient(ask);
    await expect.poll(()=>document.querySelector('[data-firewall-rule-id="office-mysql"]'),{timeout:5000,interval:5}).not.toBeNull();
    required('[name="firewall-import-json"]',HTMLTextAreaElement).value=JSON.stringify(documentData);
    const importButton=required('[data-firewall-action="import"]',HTMLButtonElement);
    expect(importButton.disabled).toBe(false);importButton.click();
    const preview=await settled(previewSeen.promise);
    expect(preview.body.expectedRevision).toBe(revisionA);
    expect(preview.reply.diff).toMatchObject({added:[],removed:[],changed:['other-app']});
    expect(ask).not.toHaveBeenCalled();
    const officeRow=required('[data-firewall-rule-id="office-mysql"]',HTMLTableRowElement);
    const deleteButton=[...officeRow.querySelectorAll('button')].find(button=>button.textContent==='Delete');
    if(!deleteButton)throw new Error('Expected the real row delete action');
    expect(deleteButton.disabled).toBe(false);deleteButton.click();
    await expect.poll(()=>calls.filter(call=>call.path==='/api/firewall/confirm').length,{timeout:5000,interval:5}).toBe(1);
    await expect.poll(()=>document.querySelector('[data-firewall-rule-id="office-mysql"]'),{timeout:5000,interval:5}).toBeNull();
    const revisionB=firewallRevision(await h.store.getFirewallState());
    expect(revisionB).not.toBe(revisionA);
    expect(bodyOf(recorded(calls,call=>call.method==='DELETE')).expectedRevision).toBe(revisionA);
    await expect(call('POST','/api/firewall/import',{document:documentData,expectedRevision:revisionA})).rejects.toMatchObject({code:'CONFLICT'});
    previewRelease.resolve();
    const question=await settled(importQuestion.promise);
    expect(question.body).toContain('0 added, 0 removed, 1 changed');
    importConfirm.resolve(true);
    await expect.poll(()=>required('[data-firewall-manage-status]',HTMLParagraphElement).textContent,{timeout:5000,interval:5}).toBe('The firewall rules changed after the preview. Preview the import again; this import was not applied.');
    expect(calls.filter(call=>call.path==='/api/firewall/import'&&call.body?.dryRun!==true)).toHaveLength(0);
    const afterStale=await h.store.getFirewallState();
    expect(firewallRevision(afterStale)).toBe(revisionB);
    expect(afterStale.rules.some(rule=>rule.id==='office-mysql')).toBe(false);
    expect(afterStale.rules.find(rule=>rule.id==='other-app')?.comment).toBe('original other');
    expect(reconcile).toHaveBeenCalledTimes(1);
    importButton.click();
    const freshQuestion=await settled(freshQuestionSeen.promise);
    expect(freshQuestion.body).toContain('1 added, 0 removed, 1 changed');
    const previews=calls.filter(call=>call.path==='/api/firewall/import'&&call.body?.dryRun===true);
    const freshPreview=previews.at(-1);
    if(!freshPreview)throw new Error('Expected a second dry run');
    expect(bodyOf(freshPreview).expectedRevision).toBe(revisionB);
    expect(freshPreview.reply.diff).toMatchObject({added:['office-mysql'],removed:[],changed:['other-app']});
    freshConfirm.resolve(true);
    await expect.poll(()=>calls.filter(call=>call.path==='/api/firewall/confirm').length,{timeout:5000,interval:5}).toBe(2);
    await expect.poll(()=>document.querySelector('[data-firewall-rule-id="office-mysql"]'),{timeout:5000,interval:5}).not.toBeNull();
    const imported=recorded(calls,call=>call.path==='/api/firewall/import'&&call.body?.dryRun!==true);
    expect(bodyOf(imported).expectedRevision).toBe(revisionB);
    expect(imported.reply.diff).toMatchObject({added:['office-mysql'],removed:[],changed:['other-app']});
    const after=await h.store.getFirewallState();
    expect(after.rules.find(rule=>rule.id==='office-mysql')).toBeDefined();
    expect(after.rules.find(rule=>rule.id==='other-app')?.comment).toBe('reviewed import');
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(arFirewallTranslator('The firewall rules changed after the preview. Preview the import again; this import was not applied.')).toBe('تغيّرت قواعد جدار الحماية بعد المعاينة. أعد معاينة الاستيراد؛ لم يُطبَّق هذا الاستيراد.');
    const proofPath=process.env.XPANEL_FIREWALL_PROOF;
    if(proofPath)await writeFile(proofPath,JSON.stringify({
      status:'STALE_CONFIRMATION_REFUSED_FRESH_REPREVIEW_ACCEPTED',revisionA,revisionB,
      previewDiff:preview.reply.diff,staleDialog:question,staleImportRequests:0,
      officeAbsentAfterStale:true,otherCommentAfterStale:'original other',
      freshPreviewDiff:freshPreview.reply.diff,freshDialog:freshQuestion,
      acceptedRevision:bodyOf(imported).expectedRevision,appliedDiff:imported.reply.diff,finalRuleIds:after.rules.map(rule=>rule.id),
      realApiHandler:true,realIsolatedStateStore:true,realClientBinding:true,authenticationFixture:true,
      hostReconcile:'synthetic fixture only; no native command or service was called',auditActions:audits
    },null,2));
  }finally{
    previewRelease.resolve();importConfirm.resolve(false);freshConfirm.resolve(false);
    while(inFlight.size)await Promise.allSettled([...inFlight]);
    Reflect.deleteProperty(window,'xpanelSessionRequest');document.body.innerHTML='';await h.close();
  }
});
