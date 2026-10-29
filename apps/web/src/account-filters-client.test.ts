import { describe, expect, it } from 'vitest'
import { ACCOUNT_FILTERS_CLIENT_BINDING, filterDraftMatches, filterHasForbiddenControl, filterWriteUncertain, readFilterState, type FilterRecord } from './account-filters-client.ts'
const context={accountId:'account-a',scope:'global' as const,mailbox:null}
const record:FilterRecord={id:'r1',accountId:'account-a',scope:'global',mailbox:null,name:'Invoices',priority:1,enabled:true,matchAll:true,conditions:[{field:'subject',comparator:'contains',value:'invoice'}],action:{type:'fileinto',target:'Invoices'},createdAt:'2026-10-25T00:00:00Z'}
const envelope=()=>({context,filters:[record],revision:'a'.repeat(64),application:{status:'configuration_only',nativeApplied:false},compilation:{status:'ready'},compiledSieve:'keep;\n'})
describe('filter selected-scope receipt and retry boundary',()=>{
  it('accepts a selected observed empty collection without creating records',()=>{expect(readFilterState({...envelope(),filters:[]},context).filters).toEqual([])})
  it.each([{accountId:'foreign'},{accountId:'account-a',scope:'mailbox',mailbox:'a@tenant.test'}])('refuses a record outside the exact returned context %j',change=>{expect(()=>readFilterState({...envelope(),filters:[{...record,...change}]},context)).toThrow()})
  it('refuses a stale selection reply even when it is otherwise valid',()=>{expect(()=>readFilterState(envelope(),{accountId:'account-a',scope:'mailbox',mailbox:'a@tenant.test'})).toThrow()})
  it('refuses a wrong-account first response even when every row matches that wrong account',()=>{const wrong={...envelope(),context:{...context,accountId:'foreign'},filters:[{...record,accountId:'foreign'}]};expect(()=>readFilterState(wrong,context)).toThrow()})
  it('refuses native-success or missing configuration receipts',()=>{expect(()=>readFilterState({...envelope(),application:{status:'applied',nativeApplied:true}},context)).toThrow()})
  it('refuses malformed or duplicate IDs and missing revisions',()=>{
    expect(()=>readFilterState({...envelope(),revision:''},context)).toThrow()
    expect(()=>readFilterState({...envelope(),filters:[record,record]},context)).toThrow()
    expect(()=>readFilterState({...envelope(),filters:[{...record,conditions:null}]},context)).toThrow()
  })
  it('retains blocked legacy metadata only with a blocked preview',()=>{
    const value={...envelope(),filters:[{...record,name:null,conditions:null}],compilation:{status:'blocked',reason:'legacy_invalid'},compiledSieve:null}
    expect(readFilterState(value,context).filters).toHaveLength(1)
    expect(()=>readFilterState({...value,compiledSieve:'unsafe legacy script'},context)).toThrow()
  })
  it('matches condition semantics independently of JSON key order',()=>{
    const draft={name:record.name,enabled:true,matchAll:true,conditions:[{value:'invoice',field:'subject',comparator:'contains'}],action:{type:'fileinto',target:'Invoices'}}
    expect(filterDraftMatches(record,draft)).toBe(true)
    expect(filterDraftMatches(record,{...draft,action:{type:'discard'}})).toBe(false)
  })
  it.each([{status:409,unknownOutcome:true},{status:422,details:{stateChanged:true}},{status:403,details:{verificationRequired:true}},{status:408},new Error('connection_lost')])('does not auto-retry uncertain outcomes %j',failure=>{expect(filterWriteUncertain(failure)).toBe(true)})
  it.each([{status:412},{status:409},{status:422}])('permits a corrected request after definite refusal %j',failure=>{expect(filterWriteUncertain(failure)).toBe(false)})
  it.each(['name\u2028','a\u0000b','\tinvoice','a\u0085b'])('detects forbidden raw characters before canonicalization %j',value=>{expect(filterHasForbiddenControl(value)).toBe(true)})
  it('preserves printable Arabic and meaningful spaces',()=>{expect(filterHasForbiddenControl('  مرحبًا / folder  ')).toBe(false)})
  it('emits a syntactically valid standalone binding',()=>{expect(()=>new Function(ACCOUNT_FILTERS_CLIENT_BINDING)).not.toThrow()})
})
