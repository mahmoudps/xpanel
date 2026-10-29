import { describe,expect,it } from 'vitest'
import { ACCOUNT_CONTACT_CLIENT_BINDING,canonicalContactEmail,contactWriteUncertain,createAccountContactWorkspace,readContactSnapshot,requestContactPreferences } from './account-contact-client.ts'

const receipt=(contactEmail='Old.Local@tenant.test',revision='a'.repeat(64),extra:Record<string,unknown>={})=>({context:{accountId:'account-a'},preferences:{contactEmail},revision,...extra})
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r});return {promise,resolve}}
const ready=async(request?:(method:'GET'|'PATCH',body?:unknown)=>Promise<unknown>)=>{
  const calls:{method:string;body:unknown}[]=[]
  const workspace=createAccountContactWorkspace({accountId:'account-a',request:async(method,body)=>{calls.push({method,body});return request?request(method,body):receipt()}})
  await workspace.refresh();return {workspace,calls}
}

describe('owner contact email receipt and raw intent',()=>{
  it('pins the first response to the rendered account',()=>{expect(()=>readContactSnapshot({...receipt(),context:{accountId:'foreign'}},'account-a')).toThrow()})
  it.each([{revision:'A'.repeat(64)},{revision:'a'.repeat(63)},{revision:'a'.repeat(64)+'\n'},{preferences:{contactEmail:42}},{preferences:{contactEmail:'a\u2028@tenant.test'}},{preferences:{contactEmail:'Mixed.Local@EXAMPLE.TEST'}},{preferences:{contactEmail:'a..b@tenant.test'}}])('rejects malformed snapshots %j',change=>{expect(()=>readContactSnapshot({...receipt(),...change},'account-a')).toThrow()})
  it('rejects an empty saved email rather than treating it as an accepted receipt',()=>{expect(()=>readContactSnapshot(receipt(''),'account-a')).toThrow()})
  it('requires the complete write acknowledgement',()=>{expect(()=>readContactSnapshot(receipt(),'account-a',true)).toThrow();expect(readContactSnapshot(receipt('Old.Local@tenant.test',undefined,{ok:true,stateChanged:false}),'account-a',true)).toBeDefined()})
  it('compares canonical domains while preserving local-part case',()=>{expect(canonicalContactEmail('Mixed.Local@EXAMPLE.TEST.')).toBe('Mixed.Local@example.test');expect(canonicalContactEmail('Info@bücher.example')).toBe('Info@xn--bcher-kva.example')})
  it.each([' Mixed.Local@example.test','Mixed.Local@example.test ','A\u2028@example.test','a..b@example.test','.a@example.test','a@example.test/path','a@x@example.test',''])('does not silently sanitize invalid raw input %j',raw=>{expect(()=>canonicalContactEmail(raw)).toThrow()})
  it.each([{status:409},{status:422},{details:{stateChanged:false,unknownOutcome:true}},{details:{stateChanged:false},verificationRequired:true},new Error('offline')])('retains uncertainty without an explicit unchanged-state receipt %j',error=>{expect(contactWriteUncertain(error)).toBe(true)})
  it('allows a correction only after an explicit unchanged-state receipt',()=>{expect(contactWriteUncertain({status:422,details:{stateChanged:false}})).toBe(false)})
  it('serializes a standalone binding with no module closure',()=>{expect(()=>new Function('return '+ACCOUNT_CONTACT_CLIENT_BINDING)).not.toThrow()})
})

describe('owner contact draft, revision and readback lifecycle',()=>{
  it('sends raw intent and its original revision, then verifies canonical readback',async()=>{
    let changed=false;const {workspace,calls}=await ready(async method=>method==='PATCH'?(changed=true,receipt('Mixed.Local@example.test','b'.repeat(64),{ok:true,stateChanged:true})):changed?receipt('Mixed.Local@example.test','b'.repeat(64)):receipt())
    workspace.edit('Mixed.Local@EXAMPLE.TEST');await workspace.save()
    expect(calls.find(x=>x.method==='PATCH')?.body).toEqual({contactEmail:'Mixed.Local@EXAMPLE.TEST',expectedRevision:'a'.repeat(64)})
    expect(workspace.state.status).toBe('saved');expect(workspace.state.draft).toBe('Mixed.Local@example.test');expect(workspace.state.dirty).toBe(false)
  })
  it('does not write invalid raw controls or surrounding spaces',async()=>{const {workspace,calls}=await ready();workspace.edit(' Old.Local@tenant.test');await workspace.save();expect(calls.filter(x=>x.method==='PATCH')).toHaveLength(0);expect(workspace.state.draft).toBe(' Old.Local@tenant.test');expect(workspace.state.status).toBe('failed')})
  it('preserves dirty draft and original revision when Refresh discovers an external change',async()=>{
    let external=false;const {workspace,calls}=await ready(async()=>external?receipt('Other@tenant.test','b'.repeat(64)):receipt())
    workspace.edit('Draft@tenant.test');external=true;await workspace.refresh();await workspace.save()
    expect(workspace.state.draft).toBe('Draft@tenant.test');expect(workspace.state.baseline?.revision).toBe('a'.repeat(64));expect(workspace.state.observed?.contactEmail).toBe('Other@tenant.test');expect(workspace.state.status).toBe('stale');expect(calls.filter(x=>x.method==='PATCH')).toHaveLength(0)
  })
  it('does not overwrite input edited during a clean Refresh',async()=>{
    const pending=deferred();let hold=false;const {workspace}=await ready(async()=>hold?pending.promise:receipt());hold=true
    const read=workspace.refresh();workspace.edit('During.Read@tenant.test');pending.resolve(receipt('Other@tenant.test','b'.repeat(64)));await read
    expect(workspace.state.draft).toBe('During.Read@tenant.test');expect(workspace.state.baseline?.contactEmail).toBe('Old.Local@tenant.test');expect(workspace.state.status).toBe('stale')
  })
  it('ignores an older overlapping Refresh response',async()=>{
    const older=deferred(),newer=deferred();let count=0;const {workspace}=await ready(async()=>++count===1?receipt():count===2?older.promise:newer.promise)
    const one=workspace.refresh(),two=workspace.refresh();newer.resolve(receipt('New@tenant.test','c'.repeat(64)));await two;older.resolve(receipt('Old@tenant.test','b'.repeat(64)));await one
    expect(workspace.state.draft).toBe('New@tenant.test');expect(workspace.state.observed?.revision).toBe('c'.repeat(64))
  })
  it('rejects a foreign read without exposing it or replacing the existing draft',async()=>{
    let foreign=false;const {workspace}=await ready(async()=>foreign?{...receipt('Foreign@tenant.test'),context:{accountId:'foreign'}}:receipt());workspace.edit('Draft@tenant.test');foreign=true;await workspace.refresh()
    expect(workspace.state.observed?.contactEmail).toBe('Old.Local@tenant.test');expect(workspace.state.draft).toBe('Draft@tenant.test');expect(workspace.state.status).toBe('failed')
  })
  it('keeps unknown saves locked through Refresh and cancel; explicit verified reload unlocks',async()=>{
    let server=receipt();const {workspace,calls}=await ready(async method=>{if(method==='PATCH'){server=receipt('Draft@tenant.test','b'.repeat(64));throw {status:500}}return server})
    workspace.edit('Draft@tenant.test');await workspace.save();expect(workspace.state.uncertain).toBe(true)
    await workspace.refresh();await workspace.save();await workspace.reload(async()=>false)
    expect(workspace.state.uncertain).toBe(true);expect(workspace.state.baseline?.revision).toBe('a'.repeat(64));expect(calls.filter(x=>x.method==='PATCH')).toHaveLength(1)
    await workspace.reload(async()=>true);expect(workspace.state.uncertain).toBe(false);expect(workspace.state.status).toBe('read');expect(workspace.state.baseline?.revision).toBe('b'.repeat(64));expect(calls.filter(x=>x.method==='PATCH')).toHaveLength(1)
  })
  it('retains a correctable draft after explicit unchanged-state refusal',async()=>{const {workspace}=await ready(async method=>{if(method==='PATCH')throw {status:422,details:{stateChanged:false}};return receipt()});workspace.edit('Draft@tenant.test');await workspace.save();expect(workspace.state.uncertain).toBe(false);expect(workspace.state.dirty).toBe(true);expect(workspace.state.status).toBe('failed')})
  it.each(['ack','readback'])('does not call a mismatched %s Saved',async mismatch=>{
    let written=false;const {workspace}=await ready(async method=>{if(method==='PATCH'){written=true;return receipt(mismatch==='ack'?'Wrong@tenant.test':'Draft@tenant.test','b'.repeat(64),{ok:true,stateChanged:true})}return written?receipt('Wrong@tenant.test','c'.repeat(64)):receipt()})
    workspace.edit('Draft@tenant.test');await workspace.save();expect(workspace.state.status).toBe('uncertain');expect(workspace.state.draft).toBe('Draft@tenant.test');expect(workspace.state.baseline?.revision).toBe('a'.repeat(64))
  })
  it('locks editing and other operations while a discard confirmation is pending',async()=>{
    const dialog=deferred();const {workspace,calls}=await ready();workspace.edit('Draft@tenant.test');const reload=workspace.reload(()=>dialog.promise)
    workspace.edit('Lost@tenant.test');await workspace.refresh();await workspace.save();expect(calls).toHaveLength(1);expect(workspace.state.busy).toBe(true);dialog.resolve(false);await reload
    expect(workspace.state.busy).toBe(false);expect(workspace.state.draft).toBe('Draft@tenant.test')
  })
  it('preserves a dirty draft when confirmation is unavailable',async()=>{const {workspace}=await ready();workspace.edit('Draft@tenant.test');await workspace.reload(async()=>{throw new Error('dialog unavailable')});expect(workspace.state.draft).toBe('Draft@tenant.test');expect(workspace.state.busy).toBe(false)})
  it('rechecks qualification after the awaited pre-read and refuses PATCH before transport',async()=>{
    const preRead=deferred();let admitted=true,reads=0,patches=0
    const transport=async(method:string)=>{if(method==='PATCH'){patches++;return receipt('Draft@tenant.test','b'.repeat(64),{ok:true,stateChanged:true})}return ++reads===1?receipt():preRead.promise}
    const workspace=createAccountContactWorkspace({accountId:'account-a',request:(method,body)=>requestContactPreferences(transport,()=>admitted,method,body)})
    await workspace.refresh();workspace.edit('Draft@tenant.test');const save=workspace.save();admitted=false;preRead.resolve(receipt());await save
    expect(patches).toBe(0);expect(workspace.state.uncertain).toBe(false);expect(workspace.state.status).toBe('failed');expect(workspace.state.draft).toBe('Draft@tenant.test')
  })
})
