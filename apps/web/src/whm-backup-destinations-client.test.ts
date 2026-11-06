// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindWhmBackupDestinations, readBackupDestinationsView, WHM_BACKUP_DESTINATIONS_CLIENT_BINDING } from './whm-backup-destinations-client.ts'
import { renderWhmBackupDestinationsWorkspace } from './board-port/whm-backup-destinations-workspace.ts'
import { renderV2BackupDestinationManager } from './themes/v2/pages/xwhm/lifecycle/destination-manager.ts'
import { renderV2BackupsPage } from './themes/v2/pages/xwhm/lifecycle/backups.ts'
const row={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic remote',kind:'sftp',endpoint:'sftp://backup.example.test',bucket:null,region:null,pathPrefix:'/tenant-backups',username:'backup',retentionDays:30,enabled:false,credentialRef:null,verification:null,state:'unavailable',effectiveActive:false,createdAt:'2026-10-27T00:00:00.000Z'}
const view=()=>({revision:'a'.repeat(64),destinations:[{...row}],capabilities:{canTest:false,profiles:[]},application:{nativeApplied:false,schedulerVerified:false}})
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0))}
const mount=(canManage=true,locale:'en'|'ar'='en')=>{document.documentElement.lang=locale;document.documentElement.dir=locale==='ar'?'rtl':'ltr';document.body.innerHTML=renderWhmBackupDestinationsWorkspace({locale,canManage})}
afterEach(()=>{document.documentElement.lang='en';document.documentElement.dir='ltr';document.body.replaceChildren();delete(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest})
describe('backup destinations client',()=>{
  it('renders bilingual fields and strict local spacing without credential value inputs',()=>{for(const locale of ['en','ar']as const){const html=renderWhmBackupDestinationsWorkspace({locale,canManage:true});expect(html).toContain('gap:32px');expect(html).toContain('gap:24px');expect(html).toContain('gap:16px');expect(html).toContain('gap:8px');expect(html).toContain('data-destination-field="credentialRef"');expect(html).not.toContain('type="password"');expect(html).not.toMatch(/[٠-٩۰-۹]/)}})
  it('preserves unavailable controls without rendering a form in either locale',()=>{for(const locale of ['en','ar']as const){const active=document.createElement('div'),unavailable=document.createElement('div');active.innerHTML=renderWhmBackupDestinationsWorkspace({locale,canManage:true});unavailable.innerHTML=renderWhmBackupDestinationsWorkspace({locale,canManage:false});expect(active.querySelector('[data-destination-form]')?.tagName).toBe('FORM');expect(unavailable.querySelector('form')).toBeNull();expect(unavailable.querySelector('[data-destination-form]')?.tagName).toBe('DIV');const fieldNames=(node:HTMLElement)=>[...node.querySelectorAll('[data-destination-field]')].map(field=>field.getAttribute('data-destination-field'));expect(fieldNames(unavailable)).toEqual(fieldNames(active));expect(fieldNames(unavailable)).toHaveLength(9);expect([...unavailable.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')].every(control=>control.disabled)).toBe(true);expect(active.querySelector('[data-destination-save]')?.getAttribute('type')).toBe('submit');expect(unavailable.querySelector('[data-destination-save]')).not.toBeNull()}})
  it('validates unavailable state and rejects fake activation, invalid counters or native success',()=>{expect(readBackupDestinationsView(view()).destinations[0]?.effectiveActive).toBe(false);expect(()=>readBackupDestinationsView({...view(),application:{nativeApplied:false,schedulerVerified:true}})).not.toThrow();for(const raw of [{...view(),application:{nativeApplied:true,schedulerVerified:false}},{...view(),application:{nativeApplied:false,schedulerVerified:'yes'}},{...view(),destinations:[{...row,effectiveActive:true,state:'active'}]},{...view(),destinations:[{...row,retentionDays:0}]}])expect(()=>readBackupDestinationsView(raw)).toThrow()})
  it('reads canonical lifecycle state and keeps remote test unavailable without a trusted profile',async()=>{mount();const send=vi.fn(async()=>view());(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;bindWhmBackupDestinations(undefined);await settle();expect(send).toHaveBeenCalledWith('GET','/api/backups/workspace/destination-lifecycle');expect(document.querySelector<HTMLButtonElement>('[data-destination-action="test"]')?.disabled).toBe(true);expect(document.body.textContent).toContain('Transport unavailable; configuration only');expect(document.querySelector('td bdi')?.getAttribute('dir')).toBe('ltr')})
  it('does not fetch or enable controls on an unqualified page',async()=>{mount(false);const send=vi.fn(async()=>view());(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;bindWhmBackupDestinations(undefined);await settle();expect(send).not.toHaveBeenCalled();expect(document.querySelector<HTMLButtonElement>('[data-destination-save]')?.disabled).toBe(true)})
  it('saves only canonical inactive configuration and requires readback',async()=>{mount();let current=view();const send=vi.fn(async(method:string,_path:string,body?:unknown)=>{if(method==='GET')return current;const fields=body as Record<string,unknown>;expect(fields.enabled).toBe(false);expect(fields.expectedRevision).toBe('a'.repeat(64));current={...current,revision:'b'.repeat(64),destinations:[{...row,...fields,id:row.id,enabled:false}]};return{revision:current.revision,destination:current.destinations[0]}});(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;bindWhmBackupDestinations(undefined);await settle();document.querySelector<HTMLButtonElement>('[data-destination-action="edit"]')!.click();document.querySelector<HTMLFormElement>('[data-destination-form]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(send).toHaveBeenCalledTimes(3);expect(document.querySelector('[data-destination-status]')?.getAttribute('data-state')).toBe('saved')})
  it('retains the draft and locks changes after an uncertain outcome',async()=>{mount();const send=vi.fn().mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error('transport unknown'));(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;bindWhmBackupDestinations(undefined);await settle();document.querySelector<HTMLButtonElement>('[data-destination-action="edit"]')!.click();const name=document.querySelector<HTMLInputElement>('[data-destination-field="name"]')!;name.value='Draft retained';document.querySelector<HTMLFormElement>('[data-destination-form]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(name.value).toBe('Draft retained');expect(document.querySelector<HTMLButtonElement>('[data-destination-save]')?.disabled).toBe(true);expect(document.querySelector('[data-destination-status]')?.getAttribute('data-state')).toBe('review')})
  it('serializes the browser dependencies and preserves Arabic with isolated technical values',async()=>{mount(true,'ar');(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=async()=>view();(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)()as(ask:unknown)=>void)(undefined);await settle();expect(document.body.textContent).toContain('وسيلة النقل غير متاحة');expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/);expect(WHM_BACKUP_DESTINATIONS_CLIENT_BINDING).not.toContain('innerHTML')})
  it('creates an SFTP key pair named after the destination, selects it and shows only the public key',async()=>{mount();const KEY='ssh-ed25519 '+'A'.repeat(68)+' xpanel-backup-sftp-offsite-vault';let current:Record<string,unknown>=view();const ask=vi.fn(async()=>true)
    const send=vi.fn(async(method:string,path:string,body?:unknown)=>{if(method==='GET')return current;expect(path).toBe('/api/backups/workspace/credentials');expect(body).toEqual({ref:'sftp-offsite-vault',label:'Offsite vault'});current={...view(),capabilities:{canTest:true,profiles:[{ref:'sftp-offsite-vault',label:'Offsite vault',kinds:['sftp'],revision:'b'.repeat(64)}]}};return{profile:{ref:'sftp-offsite-vault',label:'Offsite vault',kinds:['sftp'],revision:'b'.repeat(64),publicKey:KEY}}})
    ;(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;bindWhmBackupDestinations(ask);await settle()
    const name=document.querySelector<HTMLInputElement>('[data-destination-field="name"]')!;name.value='Offsite vault'
    document.querySelector<HTMLButtonElement>('[data-destination-create-key]')!.click();await settle();await settle()
    expect(document.querySelector<HTMLSelectElement>('[data-destination-field="credentialRef"]')!.value).toBe('sftp-offsite-vault')
    expect(document.querySelector('[data-destination-public-key]')!.textContent).toBe(KEY);expect(document.querySelector<HTMLElement>('[data-destination-public-key]')!.hidden).toBe(false)
    expect(document.body.textContent).not.toContain('PRIVATE')})
})


describe('actual destination controller inside the V2 backup page', () => {
  it.each(['en', 'ar'] as const)('uses one inline owner and retains unavailable transport in %s', async locale => {
    document.documentElement.lang = locale
    document.body.innerHTML = renderV2BackupsPage({ locale, canRead: true, canManage: true })
    const send = vi.fn(async () => view()); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bindWhmBackupDestinations(undefined); await settle()
    expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith('GET', '/api/backups/workspace/destination-lifecycle')
    expect(document.querySelectorAll('[data-whm-backup-destinations]')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('[data-destination-action="test"]')?.disabled).toBe(true)
    expect(document.querySelector('[data-destination-field="credentialRef"]')?.tagName).toBe('SELECT')
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })
  it.each(['en', 'ar'] as const)('verifies a saved inactive SFTP destination before separate activation in %s', async locale => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = renderV2BackupsPage({ locale, canRead: true, canManage: true })
    const profile = { ref: 'synthetic-sftp', label: 'Synthetic SFTP credential', kinds: ['sftp'], revision: 'd'.repeat(64) }
    const proof = { targetDigest: 'e'.repeat(64), credentialRef: profile.ref, credentialRevision: profile.revision, verifiedAt: '2026-10-30T00:00:00.000Z', probeDigest: 'f'.repeat(64), proofDigest: 'c'.repeat(64) }
    let current = { ...view(), destinations: [{ ...row, credentialRef: profile.ref, state: 'unverified', verification: null as Record<string, string> | null }], capabilities: { canTest: true, profiles: [profile] } }
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path.endsWith('/space')) return { space: { freeBytes: 1024 } }
      if (method === 'GET') { expect(path).toBe('/api/backups/workspace/destination-lifecycle'); return current }
      expect(method).toBe('POST'); expect(body).toEqual({ expectedRevision: current.revision })
      if (path === '/api/backups/workspace/destinations/' + row.id + '/test') current = { ...current, revision: 'b'.repeat(64), destinations: [{ ...current.destinations[0]!, state: 'verified', verification: proof }] }
      else if (path === '/api/backups/workspace/destinations/' + row.id + '/activate') current = { ...current, revision: 'c'.repeat(64), destinations: [{ ...current.destinations[0]!, state: 'active', enabled: true, effectiveActive: true }] }
      else throw new Error('unexpected_destination_request')
      return { revision: current.revision }
    })
    const ask = vi.fn(async () => true)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    ;(new Function('return ' + WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)() as (ask: unknown) => void)(ask); await settle()
    expect(document.querySelector<HTMLButtonElement>('[data-destination-action="activate"]')!.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-destination-action="test"]')!.click(); await settle(); await settle()
    expect(current.destinations[0]!.state).toBe('verified'); expect(current.destinations[0]!.enabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-destination-action="activate"]')!.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-destination-action="activate"]')!.click(); await settle(); await settle()
    expect(ask).toHaveBeenCalledTimes(2); expect(current.destinations[0]!.effectiveActive).toBe(true)
    expect(send.mock.calls.filter(call => call[0] === 'POST').map(call => [call[1], call[2]])).toEqual([
      ['/api/backups/workspace/destinations/' + row.id + '/test', { expectedRevision: 'a'.repeat(64) }],
      ['/api/backups/workspace/destinations/' + row.id + '/activate', { expectedRevision: 'b'.repeat(64) }],
    ])
    expect(document.querySelector('[data-destination-status]')!.getAttribute('data-state')).toBe('saved')
    expect(document.body.textContent).not.toContain('PRIVATE')
  })
  it.each(['duplicate', 'replacement'] as const)('sends no native request if inline ownership changes during confirmation: %s', async change => {
    document.body.innerHTML = renderV2BackupsPage({ locale: 'en', canRead: true, canManage: true })
    const profile = { ref: 'synthetic-sftp', label: 'Synthetic SFTP credential', kinds: ['sftp'], revision: 'd'.repeat(64) }
    const current = { ...view(), destinations: [{ ...row, credentialRef: profile.ref, state: 'unverified' }], capabilities: { canTest: true, profiles: [profile] } }
    const send = vi.fn(async (_method: string, _path: string, _body?: unknown) => current)
    let release: ((value: boolean) => void) | undefined
    const ask = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    ;(new Function('return ' + WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)() as (ask: unknown) => void)(ask); await settle()
    document.querySelector<HTMLButtonElement>('[data-destination-action="test"]')!.click(); await settle(); expect(ask).toHaveBeenCalledTimes(1)
    const manager = document.querySelector('[data-backup-inline-manager]')!
    if (change === 'duplicate') manager.after(manager.cloneNode(true)); else manager.replaceWith(manager.cloneNode(true))
    release!(true); await settle()
    expect(send.mock.calls).toEqual([['GET', '/api/backups/workspace/destination-lifecycle']])
    expect(document.querySelector<HTMLElement>('[data-approved-whm-backups]')!.dataset.backupManage).toBe('false')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-approved-whm-backups] input,[data-approved-whm-backups] select,[data-approved-whm-backups] button')].every(node => node.disabled)).toBe(true)
  })
  it('does not read or mutate an inline manager outside the authorized context', async () => {
    document.body.innerHTML = renderV2BackupsPage({ locale: 'en', canRead: false, canManage: false })
    const send = vi.fn(async () => view()); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bindWhmBackupDestinations(undefined); await settle()
    expect(send).not.toHaveBeenCalled(); expect(document.querySelector('[data-whm-backup-destinations] form')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-destination-save]')?.disabled).toBe(true)
  })
})

// Proposed affected tests: run against the actual serialized browser closure, not named helpers.
describe('V2 SFTP address fields on the serialized destination controller', () => {
  const input = (selector: string): HTMLInputElement => { const node = document.querySelector(selector); if (!(node instanceof HTMLInputElement)) throw new Error('missing input: ' + selector); return node }
  const start = async (endpoint = row.endpoint, standalone = false, locale: 'en' | 'ar' = 'en') => {
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = standalone ? renderV2BackupDestinationManager({locale,canRead:true,canManage:true}) : renderV2BackupsPage({locale,canRead:true,canManage:true})
    let current = {...view(),destinations:[{...row,endpoint}]}
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return current
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid test request')
      const fields = body as Record<string,unknown>
      current = {...current,revision:'b'.repeat(64),destinations:current.destinations.map(destination=>({...destination,...fields,endpoint:String(fields.endpoint),kind:String(fields.kind),enabled:false}))}
      return {revision:current.revision,destination:current.destinations[0]}
    })
    ;(window as Window & {xpanelSessionRequest?:unknown}).xpanelSessionRequest=send
    ;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)() as (ask:unknown)=>void)(undefined)
    await settle(); document.querySelector<HTMLButtonElement>('[data-destination-action="edit"]')!.click()
    return send
  }
  const submit = async () => { document.querySelector<HTMLFormElement>('[data-destination-form]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await settle() }
  it.each([false,true])('saves edited host and port through the single endpoint with strict readback (standalone=%s)',async standalone=>{
    const send=await start(row.endpoint,standalone),host=input('[data-destination-sftp-host]'),port=input('[data-destination-sftp-port]')
    expect(host.disabled).toBe(false);expect(port.disabled).toBe(false);expect(host.value).toBe('backup.example.test');expect(port.value).toBe('22')
    host.value='vault.example.test';host.dispatchEvent(new Event('input',{bubbles:true}));port.value='2222';port.dispatchEvent(new Event('input',{bubbles:true}));await submit()
    const mutation=send.mock.calls.find(call=>call[0]==='PATCH');expect(mutation?.[2]).toMatchObject({endpoint:'sftp://vault.example.test:2222',enabled:false,expectedRevision:'a'.repeat(64),credentialRef:null})
    expect(Object.keys(mutation?.[2] as object).sort()).toEqual(['name','kind','endpoint','bucket','region','pathPrefix','username','retentionDays','credentialRef','enabled','expectedRevision'].sort())
    expect(document.querySelector('[data-destination-status]')?.getAttribute('data-state')).toBe('saved');expect(host.value).toBe('vault.example.test');expect(port.value).toBe('2222')
    expect(document.querySelector('[data-destination-field="credentialRef"]')?.tagName).toBe('SELECT');expect(document.querySelector('input[type="password"]')).toBeNull()
  })
  it.each(['sftp://Legacy.Example.test:0022/kept%2Fpath','sftp://[2001:db8::1]:22/root/'])('preserves byte-identical saved endpoint when components are unchanged: %s',async endpoint=>{
    const send=await start(endpoint);await submit();expect(send.mock.calls.find(call=>call[0]==='PATCH')?.[2]).toMatchObject({endpoint})
  })
  it('uses URL IPv6 handling and retains an existing path when the port changes',async()=>{
    const send=await start('sftp://[2001:db8::1]/kept%2Fpath'),port=input('[data-destination-sftp-port]');port.value='2222';port.dispatchEvent(new Event('input',{bubbles:true}));await submit()
    expect(send.mock.calls.find(call=>call[0]==='PATCH')?.[2]).toMatchObject({endpoint:'sftp://[2001:db8::1]:2222/kept%2Fpath'})
  })
  it('projects direct endpoint edits rather than overwriting them with stale components',async()=>{
    const send=await start(),endpoint=input('[data-destination-field="endpoint"]');expect(endpoint.readOnly).toBe(false)
    endpoint.value='sftp://other.example.test:2223/retained';endpoint.dispatchEvent(new Event('input',{bubbles:true}));expect(input('[data-destination-sftp-host]').value).toBe('other.example.test');expect(input('[data-destination-sftp-port]').value).toBe('2223');await submit()
    expect(send.mock.calls.find(call=>call[0]==='PATCH')?.[2]).toMatchObject({endpoint:endpoint.value})
  })
  it.each([['port', '0', 'أدخل منفذًا من 1 إلى 65535.'], ['host', 'user@host', 'أدخل اسم مضيف SFTP صالحًا.']] as const)('reports translated Arabic SFTP validation for %s without an effect', async (part, value, message) => {
    const send = await start(row.endpoint, false, 'ar'), control = input(part === 'port' ? '[data-destination-sftp-port]' : '[data-destination-sftp-host]')
    control.value = value; await submit()
    expect(control.validationMessage).toBe(message); expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('[data-destination-status]')!.textContent).toBe('تحقّق من مضيف SFTP والمنفذ. لم تُجرَ أي تغييرات.')
    expect(send.mock.calls).toEqual([['GET', '/api/backups/workspace/destination-lifecycle']])
  })
  it.each(['0','65536','2.5','','1e3'])('rejects invalid port %s before any mutation and retains the draft',async value=>{
    const send=await start(),port=input('[data-destination-sftp-port]');port.value=value;await submit()
    expect(send.mock.calls).toEqual([['GET','/api/backups/workspace/destination-lifecycle']]);expect(port.value).toBe(value);expect(port.getAttribute('aria-invalid')).toBe('true');expect(document.querySelector('[data-destination-status]')?.getAttribute('data-state')).toBe('failed')
  })
  it.each(['user@host','host/remote','sftp://host'])('rejects a non-host address %s before any mutation',async value=>{
    const send=await start(),host=input('[data-destination-sftp-host]');host.value=value;await submit()
    expect(send.mock.calls).toEqual([['GET','/api/backups/workspace/destination-lifecycle']]);expect(host.value).toBe(value);expect(host.getAttribute('aria-invalid')).toBe('true')
  })
  it.each(['remove-port','non-input-port','duplicate-host'] as const)('fails closed for a partial or malformed projection: %s',async variant=>{
    document.body.innerHTML=renderV2BackupsPage({locale:'en',canRead:true,canManage:true});const port=input('[data-destination-sftp-port]');if(variant==='remove-port')port.remove();else if(variant==='duplicate-host')input('[data-destination-sftp-host]').after(input('[data-destination-sftp-host]').cloneNode(true));else {const replacement=document.createElement('select');replacement.setAttribute('data-destination-sftp-port','');port.replaceWith(replacement)}
    const send=vi.fn(async()=>view());(window as Window & {xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)() as (ask:unknown)=>void)(undefined);await settle()
    expect(send).not.toHaveBeenCalled();expect([...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('[data-whm-backup-destinations] input,[data-whm-backup-destinations] select,[data-whm-backup-destinations] button')].every(node=>node.disabled)).toBe(true)
  })
  it('keeps other protocols on the unchanged endpoint editor and disables hidden projections',async()=>{
    const send=await start(),kind=document.querySelector<HTMLSelectElement>('[data-destination-field="kind"]')!;kind.value='s3';kind.dispatchEvent(new Event('change',{bubbles:true}));const endpoint=input('[data-destination-field="endpoint"]');endpoint.value='https://objects.example.test'
    expect(document.querySelector<HTMLElement>('[data-destination-sftp-address]')?.hidden).toBe(true);expect(input('[data-destination-sftp-host]').disabled).toBe(true);expect(endpoint.readOnly).toBe(false);await submit()
    expect(send.mock.calls.find(call=>call[0]==='PATCH')?.[2]).toMatchObject({kind:'s3',endpoint:'https://objects.example.test'})
  })
  it('preserves the Classic editor without requiring optional projection markers',async()=>{
    mount();const send=vi.fn(async()=>view());(window as Window & {xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)() as (ask:unknown)=>void)(undefined);await settle()
    expect(document.querySelector('[data-destination-sftp-address]')).toBeNull();expect(input('[data-destination-field="endpoint"]').readOnly).toBe(false);expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('fresh optional SFTP field ownership in the serialized controller', () => {
  const mountV2 = () => { document.body.innerHTML=renderV2BackupsPage({locale:'en',canRead:true,canManage:true}) }
  const field = (selector:string):HTMLElement => { const node=document.querySelector(selector);if(!(node instanceof HTMLElement))throw new Error('missing field');return node }
  it.each(['group-outside-root','host-outside-group'] as const)('refuses wrongly owned projection before the initial GET: %s',async variant=>{
    mountV2();const manager=field('[data-whm-backup-destinations]'),group=field('[data-destination-sftp-address]')
    if(variant==='group-outside-root')document.body.append(group);else manager.append(field('[data-destination-sftp-host]'))
    const send=vi.fn(async()=>view());(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)()as(ask:unknown)=>void)(undefined);await settle()
    expect(send).not.toHaveBeenCalled();expect([...manager.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')].every(node=>node.disabled)).toBe(true)
  })
  it.each([['test','loss'],['test','replacement'],['key','loss'],['key','replacement']] as const)('rechecks the current pair after %s confirmation with %s',async(action,change)=>{
    mountV2();const profile={ref:'synthetic-sftp',label:'Synthetic SFTP',kinds:['sftp'],revision:'d'.repeat(64)},current={...view(),destinations:[{...row,credentialRef:profile.ref,state:'unverified'}],capabilities:{canTest:true,profiles:[profile]}}
    const send=vi.fn(async()=>current);let release:((value:boolean)=>void)|undefined;const ask=vi.fn(()=>new Promise<boolean>(resolve=>{release=resolve}));(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send
    ;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)()as(ask:unknown)=>void)(ask);await settle()
    const name=field('[data-destination-field="name"]');if(!(name instanceof HTMLInputElement))throw new Error('missing name');name.value='Synthetic vault'
    const button=document.querySelector<HTMLButtonElement>(action==='test'?'[data-destination-action="test"]':'[data-destination-create-key]');if(!button)throw new Error('missing action');button.click();await settle();expect(ask).toHaveBeenCalledTimes(1)
    const host=field('[data-destination-sftp-host]');if(change==='loss')host.remove();else host.replaceWith(host.cloneNode(true));if(!release)throw new Error('missing confirmation');release(true);await settle()
    expect(send.mock.calls).toEqual([['GET','/api/backups/workspace/destination-lifecycle']]);expect([...field('[data-whm-backup-destinations]').querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')].every(node=>node.disabled)).toBe(true)
  })
  it('refuses save when a previously admitted address field is removed',async()=>{
    mountV2();const send=vi.fn(async()=>view());(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)()as(ask:unknown)=>void)(undefined);await settle()
    field('[data-destination-sftp-port]').remove();field('[data-destination-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(send.mock.calls).toEqual([['GET','/api/backups/workspace/destination-lifecycle']])
  })
  it('keeps Classic no-pair mode marker-free on a subsequent read',async()=>{
    mount();const send=vi.fn(async()=>view());(window as Window&{xpanelSessionRequest?:unknown}).xpanelSessionRequest=send;(new Function('return '+WHM_BACKUP_DESTINATIONS_CLIENT_BINDING)()as(ask:unknown)=>void)(undefined);await settle()
    const injected=document.createElement('input');injected.setAttribute('data-destination-sftp-host','');field('[data-whm-backup-destinations]').append(injected)
    const read=document.querySelector<HTMLButtonElement>('[data-destination-read]');if(!read)throw new Error('missing read');read.click();await settle();expect(send.mock.calls).toEqual([['GET','/api/backups/workspace/destination-lifecycle']]);expect(injected.disabled).toBe(true)
  })
})
